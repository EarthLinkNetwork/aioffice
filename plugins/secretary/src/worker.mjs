// 秘書の気づきの plugin の worker。範囲: docs/review/2026-11-21-secretary-awareness-scope.md（開発元の記録）の「作り方」の部品 2〜10
// - event は表への 1 行の追記だけ（待ち行列で 1 本ずつ・処理はすぐ返す）
// - 会社の物は、見回りの口（/tick）の中だけで読み書きする。同時に 1 つ・20 秒の枠
// 見回りの順: 秘書を確かめる → これまでの見回りの片付け（取り込み・止まった回・起こし直し・古い in_review を閉じる）→ たまった出来事を読み直す → 見回りを作る → 古い行を片付ける
import { gateRoute, fromOwnerOrAssignee } from '../../owner-gate.mjs';
import { definePlugin, runWorker } from '@paperclipai/plugin-sdk';
import { makeBudget, singleFlight, serialQueue, validTimeZone } from '../../notify/src/lib.mjs';
import { EVENT_TYPES, ROUND, ROUND_ORIGIN, ANSWERED, OPEN_ROUND, LANGS, eventRow, eventLine, isRoundIssue, isReaction, isHumanComment, pickRound, fitLines, shouldStartRound, isStalled, roundBody, roundTitle, proposalsFrom, dayOf, PROPOSAL_ORIGIN, proposalBody, NOTICE_ORIGIN, shouldNotice, noticeText } from './lib.mjs';

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
    // 読み直しに失敗した行: 数えて pending に残す。累計が maxAttempts で落ち（一時の失敗でこだまにしない・独立レビュー P3-2）
    retry: (companyId, ids) => ids.length ? db.execute(`UPDATE ${t} SET state = CASE WHEN attempts + 1 >= ${ROUND.maxAttempts} THEN 'dropped' ELSE 'pending' END, attempts = attempts + 1, updated_at = now() WHERE company_id = $1 AND id = ANY(string_to_array($2, ',')::bigint[])`, [companyId, idList(ids)]) : null,
    send: (companyId, ids, roundIssueId) => ids.length ? db.execute(`UPDATE ${t} SET state = 'sent', round_issue_id = $2, updated_at = now() WHERE company_id = $1 AND id = ANY(string_to_array($3, ',')::bigint[])`, [companyId, roundIssueId, idList(ids)]) : null,
    finishRound: (companyId, roundIssueId) => db.execute(`UPDATE ${t} SET state = 'done', updated_at = now() WHERE company_id = $1 AND round_issue_id = $2 AND state = 'sent'`, [companyId, roundIssueId]),
    // 失敗した回の出来事を戻す。見回りの失敗（秘書が答えない）は出来事のせいではないので、数えず・落とさない（設計 2026-11-24 §3.4）
    failRound: (companyId, roundIssueId) => db.execute(`UPDATE ${t} SET state = 'pending', round_issue_id = NULL, updated_at = now() WHERE company_id = $1 AND round_issue_id = $2 AND state = 'sent'`, [companyId, roundIssueId]),
    // 落ちにした行を pending に戻す（前の版の決まりで落ちた出来事を、持ち主の指示で戻す時）。落ちの行は掃除まで表に残っている
    requeue: (companyId) => db.execute(`UPDATE ${t} SET state = 'pending', attempts = 0, round_issue_id = NULL, updated_at = now() WHERE company_id = $1 AND state = 'dropped'`, [companyId]),
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

const freshRounds = r => ({ day: null, roundsToday: 0, deepUsed: 0, lastRoundAt: null, imported: [], woke: [], closedReview: [], toReview: [], toChildren: {}, children: 0, toCancel: [], closeTries: {}, stalls: 0, stallStreak: 0, lastNoticeAt: null, noticeError: null, dropped: 0, violations: 0, lastViolations: 0, proposals: 0, errors: 0, lastError: null, ...(r || {}) });

// 見回りの run が作った課題を数える（保証 4）: その回の run（取り込みまでに始まった物）が作った課題と、見回りの子孫で秘書が作った課題を合わせる
async function countViolations(deps, companyId, round, secretaryId, importedAt) {
  const orch = await deps.issues.summaries.getOrchestration({ issueId: round.id, companyId }).catch(() => null);
  const runIds = (orch?.runs || []).filter(r => r && r.agentId === secretaryId && (!r.startedAt || ms(r.startedAt) <= ms(importedAt))).map(r => r.id);
  const byRun = await deps.store.issuesByRuns(companyId, runIds);
  const sub = await deps.issues.getSubtree(round.id, companyId, { includeRoot: false }).catch(() => null);
  const bySub = (sub?.issues || []).filter(i => i.originKind !== PROPOSAL_ORIGIN && i.createdByAgentId === secretaryId && ms(i.createdAt) <= ms(importedAt)).map(i => i.id);
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

// 提案 1 つ = 子の課題 1 つ（確認待ち・担当は秘書・親は見回りの課題）。本文は件の形の見出しで書くので、タスクボードの件カードにそのまま出る。
// 本体の create には冪等の鍵が無いので、originId で探してから作る。途中で失敗・時間切れになっても、次の見回りで続きから作れる
async function makeChildren(deps, companyId, round, proposals, lang, budget) {
  const r = { made: 0, found: 0, failed: 0, left: false, error: null };
  const findKid = async originId => ((await deps.issues.list({ companyId, originKind: PROPOSAL_ORIGIN, originId, limit: 5 })) || []).find(i => i && i.originKind === PROPOSAL_ORIGIN && i.originId === originId) || null;
  for (let n = 0; n < proposals.length; n++) {
    if (budget.over()) { r.left = true; break; }
    // 1 つの提案の失敗で、後ろの提案を止めない（失敗した分は次の見回りでもう一度）
    try {
      const p = proposals[n], originId = `${round.id}:${n + 1}`;
      const have = await findKid(originId);
      if (have) {
        r.found++;
        if (have.status === 'backlog') await deps.issues.update(have.id, { status: 'in_review' }, companyId);
        continue;
      }
      const base = { companyId, title: p.title, description: proposalBody(p, lang), priority: 'medium', assigneeAgentId: round.assigneeAgentId || undefined, parentId: round.id, originKind: PROPOSAL_ORIGIN, originId };
      // 確認待ちで直に作る。失敗した時は、本体では作れていた（返事だけが落ちた）場合があるので探し直し、
      // 無ければ担当を起こさない backlog で作ってから確認待ちに動かす（作れた時点で数える。動かすのが失敗しても、次の見回りが backlog の子を見つけて動かす）
      let kid = await deps.issues.create({ ...base, status: 'in_review' }).catch(() => null);
      if (!kid) {
        kid = await findKid(originId);
        if (kid) r.found++;
        else { kid = await deps.issues.create({ ...base, status: 'backlog' }); r.made++; }
        if (kid.status === 'backlog') await deps.issues.update(kid.id, { status: 'in_review' }, companyId);
      } else r.made++;
    } catch (e) { r.failed++; r.error = e; }
  }
  return r;
}

export async function handleTick(deps, companyId, body) {
  // その会社の plugin の設定（ownerUserIds）。1 回の tick で 1 度だけ読む。試験の deps に無ければ {}（前の版と同じに全部の人のコメントを数える）
  let cfgP = null; const cfgOf = () => (cfgP ||= deps.cfgOf ? deps.cfgOf(companyId) : Promise.resolve({}));
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
    // 前の回までに秘書の id が渡っていたか（secretaryOf が状態を書き直す前に読む）
    const hadSecretary = !!(await deps.state.get(SECRETARY(companyId)).catch(() => ({ id: 'unknown' })))?.id;
    const sec = await secretaryOf(deps, companyId, body);
    out.secretary = !!sec;
    const markImported = id => { st.imported = [...st.imported, id].slice(-500); };

    // 1. これまでの見回りを片付ける。1 つの回の失敗で見回り全体を止めない。印は副作用の前に付けて残す（二度数えない・独立レビュー P3-1）
    const cancelStalled = async round => {
      await deps.issues.createComment(round.id, lang === 'ja' ? 'この見回りは 2 時間たっても終わらなかったので、閉じて次の回に回します。' : 'This round did not finish in 2 hours, so it is closed and its events go to the next round.', companyId);
      await deps.issues.update(round.id, { status: 'cancelled' }, companyId);
    };
    const dropChildren = id => { const { [id]: _, ...rest } = st.toChildren; st.toChildren = rest; };
    const placeProposals = async (round, proposals) => {
      const r = await makeChildren(deps, companyId, round, proposals, lang, budget);
      st.children += r.made;
      if (r.error) { st.errors++; st.lastError = errText(r.error); }
      // その回で子が 1 つでもできた事は状態に残す（続きの見回りで検索が 1 回落ちただけで、前の形に戻して二重に見せない）
      const mark = { ...(st.toChildren[round.id] || {}), kids: !!st.toChildren[round.id]?.kids || r.made + r.found > 0 };
      if (r.error && !mark.kids) {
        // 子の課題を 1 つも作れない本体では、前の形（見回りの課題を確認待ちにして提案をまとめて見せる）に戻す
        dropChildren(round.id); st.toReview = [...st.toReview, round.id].slice(-100); await save();
        await deps.issues.update(round.id, { status: 'in_review' }, companyId);
        st.toReview = st.toReview.filter(x => x !== round.id); await save();
        return;
      }
      if (r.left) out.partial = true;
      if (!r.error && !r.left) dropChildren(round.id);
      else st.toChildren = { ...st.toChildren, [round.id]: mark };
      await save();
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
          markImported(round.id); out.imported++; st.stallStreak = 0;
          await save();
          await deps.store.finishRound(companyId, round.id);
          // 提案のある回は、提案 1 つずつを子の課題（確認待ち）にして持ち主に見せる。見回りの課題は done のまま
          if (res?.proposals.length && round.status === 'done') {
            st.toChildren = Object.fromEntries([...Object.entries(st.toChildren), [round.id, { c: res.commentId || '', kids: false }]].slice(-50)); await save();
            await placeProposals(round, res.proposals);
          }
          continue;
        }
        if (imported && round.id in st.toChildren) {
          // 子の課題を作り切れなかった回の続き。元にしたコメントが無くなった・2 日たった回はあきらめる
          const want = st.toChildren[round.id]?.c || '';
          const src = round.status === 'done' && now - ms(round.createdAt) < ROUND.closeReviewMs ? proposalsFrom(await deps.issues.listComments(round.id, companyId), round.assigneeAgentId) : null;
          if (src?.proposals.length && (!want || src.commentId === want)) await placeProposals(round, src.proposals);
          else { dropChildren(round.id); await save(); }
          continue;
        }
        // 出来事を先に戻す（failRound は sent の行だけに当たるので何度でも同じ）。戻せないまま印を付けて出来事を失わない（再レビュー P3-1）
        if (!imported && round.status === 'cancelled') { await deps.store.failRound(companyId, round.id); markImported(round.id); await save(); continue; }
        if (!imported && isStalled(round, now)) {
          // 2 時間たっても答えの無い回は失敗として閉じ、渡した出来事を戻す（B2・何回でも戻す）
          await deps.store.failRound(companyId, round.id);
          markImported(round.id); st.stalls++; st.stallStreak = (st.stallStreak || 0) + 1; out.stalled++;
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
    // 提案の課題は自動では閉じない。持ち主が決める（進める・取り下げる）まで確認待ちに残す
    // （前は 2 日で done にしていたが、知らせも無く「いま決めてほしい件」から消えて取りこぼしになる）

    // 落ちた出来事を戻す（呼び出しの body に requeueDropped: true がある回だけ。手で 1 回呼ぶ用で、起動係は送らない）
    if (body?.requeueDropped === true) {
      const n = (await deps.store.counts(companyId)).dropped || 0;
      if (n) await deps.store.requeue(companyId);
      out.requeued = n;
    }
    // 2. たまった出来事を読み直し、こだま・持ち主の返事を分ける
    const openRound = rounds.find(i => !st.imported.includes(i.id) && OPEN_ROUND.has(i.status)) || null;
    const pend = await deps.store.pending(companyId);
    // 秘書を置いていない会社（id が渡らない）は、渡す相手が居ないので、24 時間より古い出来事を落とす（表を増やし続けない）。
    // 秘書が居る会社（止めてある・確かめられない時も）は落とさない
    // 1 回だけ id が渡らなかった回（設定の一時の誤り・手での呼び出し）では落とさない: 前の回にも id が無かった時だけ
    const configured = hadSecretary || (typeof body?.secretaryAgentId === 'string' && ID.test(body.secretaryAgentId));
    let rest = pend;
    if (!configured) {
      const old = pend.filter(r => r.occurredAt && now - ms(r.occurredAt) > ROUND.unassignedMaxAgeMs);
      if (old.length) { await deps.store.setState(companyId, old.map(x => x.id), 'dropped'); st.dropped += old.length; rest = pend.filter(r => !old.includes(r)); }
    }
    const { take, more, oldestAt } = pickRound(rest);
    // 追いついていない時は、持ち主に知らせる課題を 1 つ作る（開いた知らせがある間・間隔の内は作らない）。失敗しても見回りは続ける
    // 落ちを戻した回は、古い出来事が戻っただけなので知らせない
    if (!out.requeued && shouldNotice({ now, pending: rest.length, stallStreak: st.stallStreak || 0, oldestAt, lastNoticeAt: st.lastNoticeAt || null })) {
      let moveErr = null; // backlog で作れたが確認待ちへ動かせなかった時（作れた物として扱うが、状態に出す）
      try {
        // 開いた知らせ（確認待ち。動かせずに backlog に残った物も）がある間は作らない
        const open = [...((await deps.issues.list({ companyId, originKind: NOTICE_ORIGIN, status: 'in_review', limit: 1 })) || []), ...((await deps.issues.list({ companyId, originKind: NOTICE_ORIGIN, status: 'backlog', limit: 1 })) || [])];
        if (!open.some(i => i && i.originKind === NOTICE_ORIGIN && i.companyId === companyId)) {
          moveErr = null;
          const why = !sec ? 'missing' : sec.status === 'paused' ? 'paused' : 'stalled';
          const base = { companyId, ...noticeText({ lang, why, pending: rest.length, stallStreak: st.stallStreak || 0, oldestAt, now }), priority: 'high', originKind: NOTICE_ORIGIN, originId: `notice:${now}` };
          // 確認待ちで作れない本体では、backlog で作ってから動かす（提案の課題と同じ逃げ道）
          const n = await deps.issues.create({ ...base, status: 'in_review' }).catch(async () => { const m = await deps.issues.create({ ...base, status: 'backlog' }); await deps.issues.update(m.id, { status: 'in_review' }, companyId).catch(e => { moveErr = `not moved to in_review: ${errText(e)}`; }); return m; });
          out.notice = n?.identifier ?? n?.id ?? true;
          st.noticeError = moveErr; // 作れた回にだけ書き直す（開いた知らせがある回で消さない）
        }
        st.lastNoticeAt = now; await save();
      } catch (e) {
        // 作れなかった時は 1 時間あけてもう一度（毎回の見回りで試し続けない）
        st.errors++; st.lastError = errText(e); st.noticeError = errText(e); st.lastNoticeAt = now - ROUND.noticeEveryMs + ROUND.noticeRetryMs; await save().catch(() => {});
      }
    }
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
          // 持ち主（ownerUserIds）か課題の宛先の人のコメントだけ（招いた人のコメントは持ち主の返事にしない・設計 2.7）
          if (isReaction(issue, ancestors)) { if (isHumanComment(comment) && fromOwnerOrAssignee(await cfgOf(), issue, comment)) await deps.store.setPref(companyId, row.id, String(comment.body).replace(/\s+/g, ' ').trim()); else echo.push(row.id); continue; }
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
  return { status: 200, body: { v: 1, secretary: !!sec?.id, pending: counts.pending || 0, sent: counts.sent || 0, done: counts.done || 0, echo: counts.echo || 0, dropped: counts.dropped || 0, prefs: counts.pref || 0, day: s.day, roundsToday: s.roundsToday, deepUsed: s.deepUsed, deepPerDay: ROUND.deepPerDay, lastRoundAt: s.lastRoundAt ? new Date(s.lastRoundAt).toISOString() : null, stalls: s.stalls, stallStreak: s.stallStreak || 0, lastNoticeAt: s.lastNoticeAt ? new Date(s.lastNoticeAt).toISOString() : null, noticeError: s.noticeError || null, violations: s.violations, proposals: s.proposals, errors: s.errors, lastError: s.lastError } };
}

export async function handleRoute(deps, input) {
  const companyId = input.companyId;
  if (input.routeKey === 'tick') return handleTick(deps, companyId, input.body);
  if (input.routeKey === 'status') return handleStatus(deps, companyId);
  return { status: 404, body: { error: 'unknown route' } };
}

let D = null, C = null;
const plugin = definePlugin({
  async setup(ctx) {
    C = ctx;
    const queue = serialQueue(e => ctx.logger.warn('secretary: event append failed', { error: errText(e) }));
    D = { store: dbStore(ctx.db), state: ctx.state, issues: ctx.issues, approvals: ctx.approvals, agents: ctx.agents, cfgOf: async c => (await ctx.config.get(c).catch(() => ({}))) || {}, now: () => Date.now(), flight: singleFlight(), queue, dropped: 0 };
    for (const name of EVENT_TYPES) {
      ctx.events.on(name, async ev => {
        const row = eventRow(ev);
        if (!row) { D.dropped++; return; }
        queue.push(() => D.store.addEvent(row));
      });
    }
  },
  async onApiRequest(input) {
    if (!C) return { status: 503, body: { error: 'not ready' } };
    const g = await gateRoute('aioffice.secretary', input, c => C.config.get(c)); if (g.deny) return g.deny;
    try { return await handleRoute(D, input); }
    catch (e) { return { status: 502, body: { error: 'secretary_failed', detail: errText(e) } }; }
  },
  async onHealth() { return { status: 'ok' }; },
});
export default plugin;
runWorker(plugin, import.meta.url);
