// 秘書の気づきの plugin の worker。範囲: docs/review/2026-11-21-secretary-awareness-scope.md（開発元の記録）の「作り方」の部品 2〜10
// - event は表への 1 行の追記だけ（待ち行列で 1 本ずつ・処理はすぐ返す）
// - 会社の物は、見回りの口（/tick）の中だけで読み書きする。同時に 1 つ・20 秒の枠
// 見回りの順: 秘書を確かめる → これまでの見回りの片付け（取り込み・止まった回・起こし直し・古い in_review を閉じる）→ たまった出来事を読み直す → 見回りを作る → 古い行を片付ける
import { definePlugin, runWorker } from '@paperclipai/plugin-sdk';
import { makeBudget, singleFlight, serialQueue, validTimeZone } from '../../notify/src/lib.mjs';
import { EVENT_TYPES, ROUND, ROUND_ORIGIN, ANSWERED, OPEN_ROUND, LANGS, eventRow, eventLine, isRoundIssue, isReaction, isHumanComment, pickRound, fitLines, shouldStartRound, isStalled, roundBody, roundTitle, proposalsFrom, dayOf } from './lib.mjs';

const S = (companyId, stateKey) => ({ scopeKind: 'company', scopeId: companyId, stateKey });
const SECRETARY = c => S(c, 'secretary'), ROUNDS = c => S(c, 'rounds');
const ms = t => { const n = Date.parse(t || ''); return Number.isFinite(n) ? n : 0; };
const ID = /^[A-Za-z0-9-]{1,64}$/;
const DAY = 24 * 3600_000;
// 表の行を残す日数（終わった行・こだま・落ちは 14 日・持ち主の返事は 90 日・渡したまま取り込めなかった行は 7 日・独立レビュー P3-5）
const KEEP = { closedDays: 14, prefDays: 90, sentDays: 7 };
const ROUND_STATUSES = ['backlog', 'todo', 'in_progress', 'blocked', 'done', 'in_review', 'cancelled'];

// plugin の表への読み書き（SQL はここだけ・どれも会社の id で絞る）
export function dbStore(db) {
  const t = `${db.namespace}.events`;
  const idList = ids => ids.map(Number).filter(Number.isFinite).join(',');
  const textList = ids => ids.filter(x => ID.test(String(x))).join(',');
  return {
    addEvent: r => db.execute(`INSERT INTO ${t} (company_id, kind, event_type, entity_id, issue_id, run_id, actor_type, occurred_at) VALUES ($1, $2, $3, $4, $5, $6, $7, $8) ON CONFLICT (company_id, event_type, entity_id, occurred_at) DO NOTHING`, [r.companyId, r.kind, r.eventType, r.entityId, r.issueId || '', r.runId || '', r.actorType, r.occurredAt]),
    pending: (companyId, limit = 1000) => db.query(`SELECT id, kind, event_type AS "eventType", entity_id AS "entityId", issue_id AS "issueId", actor_type AS "actorType", occurred_at AS "occurredAt", attempts FROM ${t} WHERE company_id = $1 AND state = 'pending' ORDER BY id LIMIT ${Number(limit)}`, [companyId]),
    setState: (companyId, ids, state) => ids.length ? db.execute(`UPDATE ${t} SET state = $2, updated_at = now() WHERE company_id = $1 AND id = ANY(string_to_array($3, ',')::bigint[])`, [companyId, state, idList(ids)]) : null,
    // 持ち主の返事: 本文（400 字まで）を残し、次の回の本文の柵に入れる（独立レビュー P2-2）
    setPref: (companyId, id, note) => db.execute(`UPDATE ${t} SET state = 'pref', note = $3, updated_at = now() WHERE company_id = $1 AND id = $2`, [companyId, Number(id), String(note).slice(0, ROUND.lineChars)]),
    prefs: (companyId, n = ROUND.prefN) => db.query(`SELECT note, occurred_at AS "at" FROM ${t} WHERE company_id = $1 AND state = 'pref' ORDER BY occurred_at DESC, id DESC LIMIT ${Number(n)}`, [companyId]),
    // 読み直しに失敗した行: 数えて pending に残す。maxAttempts で落ち（一時の失敗でこだまにしない・独立レビュー P3-2）
    retry: (companyId, ids) => ids.length ? db.execute(`UPDATE ${t} SET state = CASE WHEN attempts + 1 >= ${ROUND.maxAttempts} THEN 'dropped' ELSE 'pending' END, attempts = attempts + 1, updated_at = now() WHERE company_id = $1 AND id = ANY(string_to_array($2, ',')::bigint[])`, [companyId, idList(ids)]) : null,
    send: (companyId, ids, roundIssueId) => ids.length ? db.execute(`UPDATE ${t} SET state = 'sent', round_issue_id = $2, updated_at = now() WHERE company_id = $1 AND id = ANY(string_to_array($3, ',')::bigint[])`, [companyId, roundIssueId, idList(ids)]) : null,
    finishRound: (companyId, roundIssueId) => db.execute(`UPDATE ${t} SET state = 'done', updated_at = now() WHERE company_id = $1 AND round_issue_id = $2 AND state = 'sent'`, [companyId, roundIssueId]),
    // 失敗した回の出来事を 1 回だけ戻す。maxAttempts に達した物は落ち（作り方 7）
    failRound: (companyId, roundIssueId) => db.execute(`UPDATE ${t} SET state = CASE WHEN attempts + 1 >= ${ROUND.maxAttempts} THEN 'dropped' ELSE 'pending' END, attempts = attempts + 1, round_issue_id = NULL, updated_at = now() WHERE company_id = $1 AND round_issue_id = $2 AND state = 'sent'`, [companyId, roundIssueId]),
    // その run たちが作った課題の id（違反を数える・独立レビュー P2-3）
    issuesByRuns: async (companyId, runIds) => {
      const list = textList(runIds);
      if (!list) return [];
      const rows = await db.query(`SELECT DISTINCT entity_id AS "id" FROM ${t} WHERE company_id = $1 AND kind = 'issue' AND run_id = ANY(string_to_array($2, ','))`, [companyId, list]);
      return (rows || []).map(r => r.id);
    },
    prune: (companyId, now) => db.execute(`DELETE FROM ${t} WHERE company_id = $1 AND ((state IN ('done', 'echo', 'dropped') AND updated_at < $2) OR (state = 'pref' AND occurred_at < $3) OR (state = 'sent' AND updated_at < $4))`, [companyId, new Date(now - KEEP.closedDays * DAY).toISOString(), new Date(now - KEEP.prefDays * DAY).toISOString(), new Date(now - KEEP.sentDays * DAY).toISOString()]),
    counts: async companyId => {
      const rows = await db.query(`SELECT state, count(*)::int AS n FROM ${t} WHERE company_id = $1 GROUP BY state`, [companyId]);
      return Object.fromEntries((rows || []).map(r => [r.state, Number(r.n)]));
    },
  };
}

// 秘書の id: 見回りの body から受け、会社の一致と状態を本体で確かめる（N-P3-4）
async function secretaryOf(deps, companyId, body) {
  const given = typeof body?.secretaryAgentId === 'string' && ID.test(body.secretaryAgentId) ? body.secretaryAgentId : null;
  const cur = await deps.state.get(SECRETARY(companyId));
  if ((cur?.id || null) !== given) await deps.state.set(SECRETARY(companyId), { id: given });
  if (!given) return null;
  const a = await deps.agents.get(given, companyId).catch(() => null);
  if (!a || a.companyId !== companyId || a.status === 'terminated') return null;
  return a;
}

const freshRounds = r => ({ day: null, roundsToday: 0, deepUsed: 0, lastRoundAt: null, imported: [], woke: [], closedReview: [], toReview: [], toCancel: [], closeTries: {}, stalls: 0, dropped: 0, violations: 0, lastViolations: 0, proposals: 0, errors: 0, lastError: null, ...(r || {}) });

// 見回りの run が作った課題を数える（保証 4）: その回の run（取り込みまでに始まった物）が作った課題と、見回りの子孫で秘書が作った課題を合わせる
async function countViolations(deps, companyId, round, secretaryId, importedAt) {
  const orch = await deps.issues.summaries.getOrchestration({ issueId: round.id, companyId }).catch(() => null);
  const runIds = (orch?.runs || []).filter(r => r && r.agentId === secretaryId && (!r.startedAt || ms(r.startedAt) <= ms(importedAt))).map(r => r.id);
  const byRun = await deps.store.issuesByRuns(companyId, runIds);
  const sub = await deps.issues.getSubtree(round.id, companyId, { includeRoot: false }).catch(() => null);
  const bySub = (sub?.issues || []).filter(i => i.createdByAgentId === secretaryId && ms(i.createdAt) <= ms(importedAt)).map(i => i.id);
  return new Set([...byRun, ...bySub].filter(id => id !== round.id)).size;
}

// 見回りの課題を状態ごとに読む（本体の一覧は優先度と最近の動きの順なので、1 つの一覧だと古い in_review や取り込み前の回が漏れる・独立レビュー P2-2）
async function listRounds(deps, companyId) {
  // 1 つでも読めなければ見回り全体を失敗にする（開いた回を見落として 2 つ目を作らない・再レビュー P3-2）
  const lists = await Promise.all(ROUND_STATUSES.map(status => deps.issues.list({ companyId, originKind: ROUND_ORIGIN, status, limit: status === 'in_review' ? 100 : 30 })));
  const byId = new Map();
  for (const i of lists.flat()) if (isRoundIssue(i) && i.companyId === companyId && ID.test(String(i.id))) byId.set(i.id, i);
  return [...byId.values()].sort((a, b) => ms(b.createdAt) - ms(a.createdAt));
}

const errText = e => String(e?.message || e).slice(0, 200);

export async function handleTick(deps, companyId, body) {
  const r = await deps.flight.run(async () => {
    const budget = makeBudget(deps.now);
    const now = deps.now();
    const lang = LANGS.includes(body?.lang) ? body.lang : 'en';
    const tz = validTimeZone(body?.timeZone) || 'UTC';
    const day = dayOf(now, tz);
    const st = freshRounds(await deps.state.get(ROUNDS(companyId)));
    if (st.day !== day) Object.assign(st, { day, roundsToday: 0, deepUsed: 0 });
    const save = () => deps.state.set(ROUNDS(companyId), st);
    const out = { v: 1, created: null, imported: 0, stalled: 0, partial: false, secretary: false };
    const sec = await secretaryOf(deps, companyId, body);
    out.secretary = !!sec;
    const markImported = id => { st.imported = [...st.imported, id].slice(-500); };

    // 1. これまでの見回りを片付ける。1 つの回の失敗で見回り全体を止めない。印は副作用の前に付けて残す（二度数えない・独立レビュー P3-1）
    const cancelStalled = async round => {
      await deps.issues.createComment(round.id, lang === 'ja' ? 'この見回りは 2 時間たっても終わらなかったので、閉じて次の回に回します。' : 'This round did not finish in 2 hours, so it is closed and its events go to the next round.', companyId);
      await deps.issues.update(round.id, { status: 'cancelled' }, companyId);
    };
    // 一覧が読めない時は理由を状態に残してから見回り全体を失敗にする（再レビュー 2 回目の観察）
    const rounds = await listRounds(deps, companyId).catch(async e => { st.errors++; st.lastError = errText(e); await save().catch(() => {}); throw e; });
    for (const round of rounds) {
      if (budget.over()) { out.partial = true; break; }
      const imported = st.imported.includes(round.id);
      try {
        if (!imported && ANSWERED.has(round.status)) {
          // 結果を取り込む（1 つの見回りで 1 回だけ・作り方 8）
          const comments = await deps.issues.listComments(round.id, companyId);
          const res = proposalsFrom(comments, round.assigneeAgentId);
          const v = round.assigneeAgentId ? await countViolations(deps, companyId, round, round.assigneeAgentId, res?.at || new Date(now).toISOString()) : 0;
          const deep = res ? res.proposals.filter(p => p.deep).length : ROUND.deepPerDay; // json が取れない回は使い切りとして数える（P2-4）
          st.deepUsed = Math.min(ROUND.deepPerDay, st.deepUsed + deep);
          st.proposals += res ? res.proposals.length : 0;
          st.lastViolations = v; st.violations += v;
          markImported(round.id); out.imported++;
          await save();
          await deps.store.finishRound(companyId, round.id);
          // 提案のある回は持ち主に見えるよう in_review に動かす（本体は担当が確認の道なしに in_review にするのを 422 で断る・plugin の更新は通る）
          if (res?.proposals.length && round.status === 'done') {
            st.toReview = [...st.toReview, round.id].slice(-100); await save();
            await deps.issues.update(round.id, { status: 'in_review' }, companyId);
            st.toReview = st.toReview.filter(x => x !== round.id); await save();
          }
          continue;
        }
        // 出来事を先に戻す（failRound は sent の行だけに当たるので何度でも同じ）。戻せないまま印を付けて出来事を失わない（再レビュー P3-1）
        if (!imported && round.status === 'cancelled') { await deps.store.failRound(companyId, round.id); markImported(round.id); await save(); continue; }
        if (!imported && isStalled(round, now)) {
          // 2 時間たっても答えの無い回は失敗として閉じ、渡した出来事を 1 回だけ戻す（B2）
          await deps.store.failRound(companyId, round.id);
          markImported(round.id); st.stalls++; out.stalled++;
          st.toCancel = [...st.toCancel, round.id].slice(-100);
          await save();
          await cancelStalled(round);
          st.toCancel = st.toCancel.filter(x => x !== round.id); await save();
          continue;
        }
        if (!imported && OPEN_ROUND.has(round.status) && now - ms(round.createdAt) >= ROUND.wakeAfterMs && !st.woke.includes(round.id)) {
          // 作ってから 2 分たっても run が無ければ 1 回だけ起こし直す（B2）
          st.woke = [...st.woke, round.id].slice(-100);
          await save();
          const runs = await deps.issues.summaries.getOrchestration({ issueId: round.id, companyId }).then(x => (Array.isArray(x?.runs) ? x.runs : []), () => null);
          if (runs && !runs.length) await deps.issues.requestWakeup(round.id, companyId, { idempotencyKey: `secretary-round:${round.id}`, reason: 'secretary round has no run' });
          continue;
        }
        if (imported && st.toReview.includes(round.id)) {
          // 提案のある回を in_review に動かす。失敗したら次の見回りでもう一度（再レビュー P3-3）
          if (round.status === 'done' && now - ms(round.createdAt) < ROUND.closeReviewMs) await deps.issues.update(round.id, { status: 'in_review' }, companyId);
          st.toReview = st.toReview.filter(x => x !== round.id); await save();
          continue;
        }
        if (imported && st.toCancel.includes(round.id)) {
          // 止まった回を閉じる。コメントか更新が失敗したら次の見回りでもう一度（再レビュー 2 回目 P3-3）
          if (OPEN_ROUND.has(round.status)) await cancelStalled(round);
          st.toCancel = st.toCancel.filter(x => x !== round.id); await save();
          continue;
        }
        if (round.status === 'in_review' && now - ms(round.createdAt) >= ROUND.closeReviewMs && !st.closedReview.includes(round.id)) {
          // in_review の回は 2 日で done（受信箱にたまらないように・N-B1）
          // 何度でも同じ更新なので、うまくいってから印を付ける（失敗したら次の見回りでもう一度・再レビュー P3-3）
          // 3 回失敗したらあきらめて印を付ける（毎回失敗する更新を見回りごとに繰り返さない・再レビュー 2 回目 P3-2）
          const tries = (st.closeTries[round.id] || 0) + 1;
          st.closeTries = { ...st.closeTries, [round.id]: tries };
          await save();
          if (tries <= 3) await deps.issues.update(round.id, { status: 'done' }, companyId);
          st.closedReview = [...st.closedReview, round.id].slice(-500);
          const { [round.id]: _, ...rest } = st.closeTries; st.closeTries = rest;
          await save();
        }
      } catch (e) { st.errors++; st.lastError = errText(e); await save().catch(() => {}); }
    }

    // 2. たまった出来事を読み直し、こだま・持ち主の返事・落ちを分ける
    const openRound = rounds.find(i => !st.imported.includes(i.id) && OPEN_ROUND.has(i.status)) || null;
    const pend = await deps.store.pending(companyId);
    const { take, dropped, more } = pickRound(pend, { now });
    if (dropped.length) { await deps.store.setState(companyId, dropped.map(x => x.id), 'dropped'); st.dropped += dropped.length; }
    let lines = [];
    // skipWait: 持ち主の権限（board）の呼び出しで間隔の待ちを飛ばす（e2e と手での見回し用・起動係は送らない）。1 日 48 回の上限・出来事がある時だけ・開いた回が無い時だけ、は残る
    // （本体は plugin の worker に env を渡さないので、env の試験の口は使えない）
    const skipWait = body?.skipWait === true;
    const startable = shouldStartRound({ now, lastRoundAt: skipWait ? null : st.lastRoundAt, openRound, pending: take.length, secretaryOk: !!sec && sec.status !== 'paused', roundsToday: st.roundsToday, more });
    if (startable) {
      const echo = [], failed = [];
      const issueCache = new Map(), commentCache = new Map();
      // 読めなかった時は undefined（一時の失敗）・無い/別の会社の時は null
      const getIssue = async id => {
        if (!id || !ID.test(id)) return null;
        if (!issueCache.has(id)) issueCache.set(id, await deps.issues.get(id, companyId).then(x => x ?? null, () => undefined));
        const i = issueCache.get(id);
        return i === undefined ? undefined : i && i.companyId === companyId ? i : null;
      };
      const getComments = async id => { if (!commentCache.has(id)) commentCache.set(id, await deps.issues.listComments(id, companyId).catch(() => undefined)); return commentCache.get(id); };
      for (const row of take) {
        if (budget.left() < 5000) { out.partial = true; break; }
        if (row.kind === 'approval') {
          const approval = await deps.approvals.get(row.entityId, companyId).then(x => x ?? null, () => undefined);
          if (approval === undefined) { failed.push(row.id); continue; }
          const line = approval && approval.companyId === companyId ? eventLine(row, { approval }) : null;
          if (line) lines.push({ id: row.id, line }); else echo.push(row.id);
          continue;
        }
        const issue = await getIssue(row.kind === 'issue' ? row.entityId : row.issueId);
        if (issue === undefined) { failed.push(row.id); continue; }
        if (!issue) { echo.push(row.id); continue; }
        const ancestors = [];
        let broken = false;
        for (let p = issue.parentId, d = 0; p && d < ROUND.parentDepth; d++) { const a = await getIssue(p); if (a === undefined) { broken = true; break; } ancestors.push(a); p = a?.parentId; }
        if (broken) { failed.push(row.id); continue; }
        let comment = null;
        if (row.kind === 'comment') {
          const list = await getComments(issue.id);
          if (list === undefined) { failed.push(row.id); continue; }
          comment = list.find(c => c.id === row.entityId) || null;
          // 見回りの課題（とその子孫）への人のコメントは、持ち主の返事として表に残す（保証 5・独立レビュー P2-2・P3-4）
          if (isReaction(issue, ancestors)) { if (isHumanComment(comment)) await deps.store.setPref(companyId, row.id, String(comment.body).replace(/\s+/g, ' ').trim()); else echo.push(row.id); continue; }
        }
        const line = eventLine(row, { issue, comment, ancestors, secretaryId: sec?.id || null });
        if (line) lines.push({ id: row.id, line }); else echo.push(row.id);
      }
      if (echo.length) await deps.store.setState(companyId, echo, 'echo');
      if (failed.length) await deps.store.retry(companyId, failed);
      lines = fitLines(lines);
    }

    // 3. 見回りを作る（読んだ結果、渡す物が残っている時だけ）
    if (startable && lines.length) {
      const prefs = await deps.store.prefs(companyId);
      const deepLeft = Math.max(0, ROUND.deepPerDay - st.deepUsed);
      const description = roundBody({ lines: lines.map(x => x.line), prefs, deepLeft, violations: st.lastViolations, lang });
      const issue = await deps.issues.create({ companyId, title: `${roundTitle(lang)} (${lines.length})`, description, status: 'todo', priority: 'medium', assigneeAgentId: sec.id, originKind: ROUND_ORIGIN, originId: `round:${day}:${st.roundsToday + 1}` });
      Object.assign(st, { lastRoundAt: now, roundsToday: st.roundsToday + 1, lastViolations: 0 });
      await save();
      await deps.store.send(companyId, lines.map(x => x.id), issue.id);
      out.created = { id: issue.id, identifier: issue.identifier ?? null, events: lines.length };
    }
    await deps.store.prune(companyId, now).catch(e => { st.lastError = errText(e); });
    await save();
    return out;
  });
  if (r.busy) return { status: 409, body: { error: 'secretary_busy' } };
  return { status: 200, body: r.value };
}

export async function handleStatus(deps, companyId) {
  const [st, counts, sec] = await Promise.all([deps.state.get(ROUNDS(companyId)), deps.store.counts(companyId), deps.state.get(SECRETARY(companyId))]);
  const s = freshRounds(st);
  return { status: 200, body: { v: 1, secretary: !!sec?.id, pending: counts.pending || 0, sent: counts.sent || 0, done: counts.done || 0, echo: counts.echo || 0, dropped: counts.dropped || 0, prefs: counts.pref || 0, day: s.day, roundsToday: s.roundsToday, deepUsed: s.deepUsed, deepPerDay: ROUND.deepPerDay, lastRoundAt: s.lastRoundAt ? new Date(s.lastRoundAt).toISOString() : null, stalls: s.stalls, violations: s.violations, proposals: s.proposals, errors: s.errors, lastError: s.lastError } };
}

export async function handleRoute(deps, input) {
  const companyId = input.companyId;
  if (input.routeKey === 'tick') return handleTick(deps, companyId, input.body);
  if (input.routeKey === 'status') return handleStatus(deps, companyId);
  return { status: 404, body: { error: 'unknown route' } };
}

let D = null;
const plugin = definePlugin({
  async setup(ctx) {
    const queue = serialQueue(e => ctx.logger.warn('secretary: event append failed', { error: errText(e) }));
    D = { store: dbStore(ctx.db), state: ctx.state, issues: ctx.issues, approvals: ctx.approvals, agents: ctx.agents, now: () => Date.now(), flight: singleFlight(), queue, dropped: 0 };
    for (const name of EVENT_TYPES) {
      ctx.events.on(name, async ev => {
        const row = eventRow(ev);
        if (!row) { D.dropped++; return; }
        queue.push(() => D.store.addEvent(row));
      });
    }
  },
  async onApiRequest(input) {
    try { return await handleRoute(D, input); }
    catch (e) { return { status: 502, body: { error: 'secretary_failed', detail: errText(e) } }; }
  },
  async onHealth() { return { status: 'ok' }; },
});
export default plugin;
runWorker(plugin, import.meta.url);
