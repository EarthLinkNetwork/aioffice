// 知らせの plugin の worker。範囲: docs/review/2026-11-16-library-notify-scope.md（開発元の記録）の保証 7・9・17〜20
// - event は表への 1 行の追記だけ（待ち行列で 1 本ずつ・処理はすぐ返す）。
//   例外は上限の失敗の event だけ: その処理の中で同じ契約の担当を止め、返事を待ってから返す
//   （範囲: docs/review/2026-11-18-ai-usage-limit-scope.md（開発元の記録）の G5・7 の 5）
// - 会社の物は、起動係が呼ぶ見回りの口（/tick）の中だけで読む。同時に 1 つ・20 秒の枠
// 見回りの順: 設定 → 承認待ち → event（失敗）→ 失敗の続き → AI の上限（戻す・止める・知らせ）→ 止まった課題 → 判断待ち → 朝夕のまとめ。
// 枠を超えたら残りは次の回
import { definePlugin, runWorker } from '@paperclipai/plugin-sdk';
import { mailStore, mailRoute, MAIL_ROUTE_KEYS } from './mail-worker.mjs';
import { slackStore, slackStatus, slackPreview, slackConfirm, slackOff, slackTest, slackDeliver, createVerifyNonce, createSavedDest, nonceUrl, savedUrl } from './slack-worker.mjs';
import {
  checkTickBody, eventRow, makeBudget, singleFlight, serialQueue, mutex, reconcileApprovals, reconcileKind, selectStuck, decisionPage, unanswered, redactSecrets, safeTitle, RETENTION, failingAgents, stepStreaks, digestSlot, digestTitle, digestBody, noticeKey, t, EVENT_KINDS,
  LIMIT_KINDS, OPEN_STATUSES, defaultAiLimits, effectiveAiLimits, stopsOnSpend, limitGuardOn, openaiWindows, claudeWindows, limitState, creditsReading, creditsSpend, overageState, isQuotaFailure, limitResetAt,
  contractPeers, pauseTargets, pauseAction, toIso, providerGroup, liveWindows, betterUntil, pauseNotice, resumedNotice, budgetNotice, hardIncidents, keepOnly,
} from './lib.mjs';

const NS_TABLES = ns => ({ events: `${ns}.events`, notices: `${ns}.notices`, pauses: `${ns}.limit_pauses` });
const DIGEST = companyId => ({ scopeKind: 'company', scopeId: companyId, stateKey: 'digest' });
const DSCAN = companyId => ({ scopeKind: 'company', scopeId: companyId, stateKey: 'decision_scan' });
const STREAK = companyId => ({ scopeKind: 'company', scopeId: companyId, stateKey: 'fail_streak' }); // 担当ごとの続けての失敗の数
// 上限の設定（aiLimits・flag）と同じ契約の担当の一覧。event の処理も読むので、/tick で受けた物を写しておく（範囲 7 の 9）
export const LIMCFG = companyId => ({ scopeKind: 'company', scopeId: companyId, stateKey: 'ai_limits' });
// 上限の見回りの持ち越し（Credits の基準・追加料金の知らせ・予算の event・戻した知らせ・画面の値）
export const LIMSTATE = companyId => ({ scopeKind: 'company', scopeId: companyId, stateKey: 'ai_limit_state' });
const RESUMED_KEEP_MS = 7 * 86400000; // 戻した知らせは 7 日出す
const REREAD_MS = 5000; // event の中で止めた後に読み直すまで（G5 の競り合いの補い）

// limit_pauses の行の時刻を ISO の文字にそろえる（本体の DB の口は Date で返すことがある）
const pauseRow = r => ({ ...r, untilAt: toIso(r.untilAt), pausedAt: toIso(r.pausedAt), agentPausedAt: toIso(r.agentPausedAt) });
const PAUSE_COLS = `id, agent_id AS "agentId", contract, window_kind AS "windowKind", reason, until_at AS "untilAt", paused_at AS "pausedAt", agent_paused_at AS "agentPausedAt", issue_ids AS "issueIds", source_run_id AS "sourceRunId", source_agent_id AS "sourceAgentId"`;

// plugin の表への読み書き（SQL はここだけ）
export function dbStore(db) {
  const tb = NS_TABLES(db.namespace);
  return {
    // error_code・error_snippet は migration 005 で足した欄（上限の失敗の判定・範囲 7 の 5）
    addEvent: r => db.execute(`INSERT INTO ${tb.events} (company_id, kind, entity_id, agent_id, occurred_at, error_code, error_snippet) VALUES ($1, $2, $3, $4, $5, $6, $7)`, [r.companyId, r.kind, r.entityId, r.agentId ?? null, r.occurredAt, r.errorCode ?? null, r.errorSnippet ?? null]),
    openEvents: (companyId, limit = 500) => db.query(`SELECT id, kind, entity_id AS "entityId", agent_id AS "agentId", error_code AS "errorCode", error_snippet AS "errorSnippet" FROM ${tb.events} WHERE company_id = $1 AND done = false ORDER BY id LIMIT ${Number(limit)}`, [companyId]),
    // 本体の DB の口は配列の引数を ($2, $3, …) に広げるので、id は文字 1 つで渡して表の側で分ける（2026-11-16 実物で確かめた）
    doneEvents: (companyId, ids) => ids.length ? db.execute(`UPDATE ${tb.events} SET done = true WHERE company_id = $1 AND id = ANY(string_to_array($2, ',')::bigint[])`, [companyId, ids.map(Number).filter(Number.isFinite).join(',')]) : null,
    // kinds を渡すと、その種類だけを上限なしで読む（突き合わせ用）。渡さないと画面用に未読を先に 300 件
    listNotices: (companyId, { kinds } = {}) => kinds
      ? db.query(`SELECT key, kind, origin_id AS "originId", title, body, created_at AS "createdAt", read_at AS "readAt" FROM ${tb.notices} WHERE company_id = $1 AND kind = ANY(string_to_array($2, ','))`, [companyId, [].concat(kinds).join(',')])
      : db.query(`SELECT key, kind, origin_id AS "originId", title, body, created_at AS "createdAt", read_at AS "readAt" FROM ${tb.notices} WHERE company_id = $1 ORDER BY (read_at IS NOT NULL), created_at DESC LIMIT 300`, [companyId]),
    unreadCounts: async companyId => Object.fromEntries((await db.query(`SELECT kind, count(*)::int AS n FROM ${tb.notices} WHERE company_id = $1 AND read_at IS NULL GROUP BY kind`, [companyId])).map(r => [r.kind, r.n])),
    addNotice: (companyId, n) => db.execute(`INSERT INTO ${tb.notices} (company_id, key, kind, origin_id, title, body) VALUES ($1, $2, $3, $4, $5, $6) ON CONFLICT (company_id, key) DO NOTHING`, [companyId, n.key, n.kind, n.originId, redactSecrets(n.title), n.body == null ? null : redactSecrets(n.body)]),
    prune: async companyId => {
      await db.execute(`DELETE FROM ${tb.notices} WHERE company_id = $1 AND kind = ANY(string_to_array($2, ',')) AND read_at IS NOT NULL AND read_at < now() - make_interval(days => ${Number(RETENTION.readDays)})`, [companyId, RETENTION.noisyKinds.join(',')]);
      await db.execute(`DELETE FROM ${tb.notices} WHERE company_id = $1 AND kind = ANY(string_to_array($2, ',')) AND created_at < now() - make_interval(days => ${Number(RETENTION.noisyDays)})`, [companyId, RETENTION.noisyKinds.join(',')]);
      await db.execute(`DELETE FROM ${tb.events} WHERE company_id = $1 AND done = true AND occurred_at < now() - make_interval(days => ${Number(RETENTION.eventDays)})`, [companyId]);
    },
    removeNotice: (companyId, key) => db.execute(`DELETE FROM ${tb.notices} WHERE company_id = $1 AND key = $2`, [companyId, key]),
    markRead: (companyId, key) => db.execute(`UPDATE ${tb.notices} SET read_at = now() WHERE company_id = $1 AND key = $2 AND read_at IS NULL`, [companyId, key]),
    // ---- AI オフィスが止めた担当の記録（G3・migration 005 の limit_pauses）----
    openPauses: async companyId => (await db.query(`SELECT ${PAUSE_COLS} FROM ${tb.pauses} WHERE company_id = $1 AND resumed_at IS NULL ORDER BY id`, [companyId])).map(pauseRow),
    // 同じきっかけ（run の id・% の窓の key など）で止めた担当（閉じた記録も含む。同じきっかけで 2 回止めない）
    pausesBySource: (companyId, source) => db.query(`SELECT agent_id AS "agentId" FROM ${tb.pauses} WHERE company_id = $1 AND source_run_id = $2`, [companyId, source]),
    // 開いた記録は担当ごとに 1 つ。部分の一意の索引に当たったら（同じ担当を並んで止めた時）行は足さず、
    // 開いた記録の agent_paused_at を今の pause の返事の pausedAt にそろえる（本体の pause は毎回 pausedAt を書き換える・実装レビュー r1 の H1）
    addPause: (companyId, r) => db.execute(`INSERT INTO ${tb.pauses} (company_id, agent_id, contract, window_kind, reason, until_at, agent_paused_at, issue_ids, source_run_id, source_agent_id) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10) ON CONFLICT (company_id, agent_id) WHERE resumed_at IS NULL DO UPDATE SET agent_paused_at = EXCLUDED.agent_paused_at`,
      [companyId, r.agentId, r.contract ?? null, r.windowKind ?? null, r.reason, r.untilAt ?? null, r.agentPausedAt ?? null, r.issueIds ?? null, r.sourceRunId ?? null, r.sourceAgentId ?? null]),
    setPauseUntil: (companyId, id, untilAt) => db.execute(`UPDATE ${tb.pauses} SET until_at = $3 WHERE company_id = $1 AND id = $2`, [companyId, Number(id), untilAt]),
    setPauseAgentAt: (companyId, id, at) => db.execute(`UPDATE ${tb.pauses} SET agent_paused_at = $3 WHERE company_id = $1 AND id = $2`, [companyId, Number(id), at]),
    setPauseIssues: (companyId, id, issueIds) => db.execute(`UPDATE ${tb.pauses} SET issue_ids = $3 WHERE company_id = $1 AND id = $2`, [companyId, Number(id), issueIds]),
    closePause: (companyId, id, reason) => db.execute(`UPDATE ${tb.pauses} SET resumed_at = now(), close_reason = $3 WHERE company_id = $1 AND id = $2 AND resumed_at IS NULL`, [companyId, Number(id), reason]),
  };
}

const SETTINGS = companyId => ({ scopeKind: 'company', scopeId: companyId, stateKey: 'settings' });
const warn = (deps, msg, e) => deps.logger?.warn?.(`notify: ${msg}`, { error: String(e?.message || e).slice(0, 200) });
// 担当を止める処理の 1 本の鍵（event の処理と見回りの上限の処理を順番に流す・実装レビュー r1 の H1）。deps ごとに 1 つ
export const limitLock = deps => (deps.limitLock ??= mutex());
// 画面の値の止めた担当（office の帯・再開の確かめが読む）。agentPausedAt は画面が再開の前に本体の pausedAt と比べる（実装レビュー r1 の M3）
const viewPauses = recs => recs.map(r => ({ agentId: r.agentId, contract: r.contract, reason: r.reason, untilAt: r.untilAt, agentPausedAt: r.agentPausedAt ?? null, sourceAgentId: r.sourceAgentId }));

// 担当の組を止める（止めるのは常に ctx.agents.pause の 1 本・範囲 7 の 4）。呼び手は limitLock の中で呼ぶ。
// 既に paused の担当・開いた記録のある担当・同じきっかけで前に止めた担当は止めず記録もしない（G3）。
// 止める直前に担当を 1 人ずつ読み直し、その間に予算や人が止めた担当は止めない（本体の pause は pauseReason を manual に上書きする・実装レビュー r1 の L1）。
// 読み直しが失敗した時は読み直しを飛ばして止める（超えても止まらない担当を残さない・お金の上で安全な側・実装レビュー r2 の L-b）
// agents は呼び手が鍵の中で読んだ一覧（実装レビュー r2 の H1-r2）
// g = { agentIds, contract, windowKind, reason, untilAt, source, sourceAgentId, issueIds: {担当 id: 'id,id'} }
export async function pauseGroup(deps, companyId, g, agents) {
  const before = new Set((await deps.store.pausesBySource(companyId, g.source)).map(r => r.agentId));
  const open = new Set((await deps.store.openPauses(companyId)).map(r => r.agentId));
  const { pause, skipped } = pauseTargets(g.agentIds.filter(id => !before.has(id) && !open.has(id)), agents);
  const paused = [];
  for (const id of pause) {
    try {
      if (deps.agents.get) {
        let now, read = false;
        try { now = await deps.agents.get(id, companyId); read = true; } catch (e) { warn(deps, 'reread before pause failed', e); }
        if (read && (!now || now.status === 'terminated')) continue;
        if (read && now.status === 'paused') { skipped.push(id); continue; }
      }
      const a = await deps.agents.pause(id, companyId);
      await deps.store.addPause(companyId, { agentId: id, contract: g.contract, windowKind: g.windowKind ?? null, reason: g.reason, untilAt: g.untilAt ?? null, agentPausedAt: toIso(a?.pausedAt), issueIds: g.issueIds?.[id] ?? null, sourceRunId: g.source, sourceAgentId: g.sourceAgentId ?? null });
      paused.push(id);
    } catch (e) { warn(deps, 'pause failed', e); }
  }
  return { paused, skipped };
}

// 上限の失敗の event（G5 の主の経路・範囲 7 の 5）。同じ契約の担当を止め、5 秒おいて読み直し、paused でなければ止め直してから返す。
// 待ち行列には載せない（呼び手が返事を待つ）。flag の値がまだ無い時（最初の /tick の前）は ON とみなす
export async function handleRunFailed(deps, row, { issueId = null } = {}) {
  const out = { paused: [], skipped: [], repaused: [] };
  if (!row || row.kind !== 'run_failed' || !row.agentId || !isQuotaFailure(row)) return out;
  const companyId = row.companyId;
  const cfg = (await deps.state.get(LIMCFG(companyId))) || {};
  if (!limitGuardOn(cfg.aiLimits)) return { ...out, guard: false };
  const peers = contractPeers(cfg.contractGroups, row.agentId);
  const untilAt = limitResetAt({ text: row.errorSnippet, nowMs: deps.now() })?.at ?? null; // 文から仮に置く（/tick でログの resetsAt が来たら上書き）
  // 読んでから止めて記録するまでを鍵の中で流す（同じ契約の失敗が並んで届いても、記録の pausedAt が本体とずれない・H1）
  const r = await limitLock(deps).run(async () => {
    const agents = await deps.agents.list({ companyId });
    const res = await pauseGroup(deps, companyId, { agentIds: peers.agentIds, contract: peers.contract, reason: 'provider_quota', untilAt, source: row.entityId, sourceAgentId: row.agentId, issueIds: issueId ? { [row.agentId]: issueId } : {} }, agents);
    if (res.paused.length) await refreshViewPauses(deps, companyId);
    return res;
  });
  Object.assign(out, r);
  if (!r.paused.length) return out;
  // 走り終わりの処理との競り合い（範囲 2.5）: 読み直して paused でなければもう一度止める（5 秒待つ間は鍵を持たない）
  await deps.sleep(REREAD_MS);
  await limitLock(deps).run(async () => {
    const again = new Map((await deps.agents.list({ companyId })).map(a => [a.id, a]));
    const recs = await deps.store.openPauses(companyId);
    for (const id of r.paused) {
      const a = again.get(id), rec = recs.find(x => x.agentId === id);
      // 記録がもう閉じた担当（人が再開した・見回りが閉じた）は止め直さない
      if (!a || !rec || a.status === 'paused' || a.status === 'terminated') continue;
      // 止め直す直前に 1 人ずつ読み直し、競り合い（paused でなく pausedAt が記録と同じ）の時だけ止め直す。
      // 人の再開（pausedAt が null）・人の止め直しは止め直さず、閉じるのは見回りに任せる。読み直しが失敗したら見回りに任せる（H1-r2）
      if (deps.agents.get) {
        let now;
        try { now = await deps.agents.get(id, companyId); } catch (e) { warn(deps, 'reread before repause failed', e); continue; }
        if (pauseAction(rec, now && { ...now, pausedAt: toIso(now.pausedAt) }, { guard: true, nowMs: deps.now() }) !== 'repause') continue;
      }
      try {
        const p = await deps.agents.pause(id, companyId);
        await deps.store.setPauseAgentAt(companyId, rec.id, toIso(p?.pausedAt));
        out.repaused.push(id);
      } catch (e) { warn(deps, 'repause failed', e); }
    }
    if (out.repaused.length) await refreshViewPauses(deps, companyId);
  });
  return out;
}

// event の経路で止めた分を、次の見回りを待たずに画面の値（帯・再開の確かめ）へ写す（実装レビュー r1 の L7）。
// 知らせ（agent_paused_limit）は課題の一覧が要るので次の見回りで出す
async function refreshViewPauses(deps, companyId) {
  try {
    const ls = (await deps.state.get(LIMSTATE(companyId))) || {};
    ls.view = { ...(ls.view || {}), pauses: viewPauses(await deps.store.openPauses(companyId)) };
    await deps.state.set(LIMSTATE(companyId), ls);
  } catch (e) { warn(deps, 'limit view update failed', e); }
}

const PROVIDER_OF_ADAPTER = { claude_local: 'anthropic', codex_local: 'openai' };
const providerOfRec = (rec, groups) => (groups || []).find(g => g.contract === rec.contract)?.provider ?? (/^openai\b/.test(rec.contract || '') ? 'openai' : /^anthropic\b/.test(rec.contract || '') ? 'anthropic' : null);
const splitIds = s => (typeof s === 'string' && s ? s.split(',').filter(Boolean) : []);

// AI の上限の見回り（範囲 7 の 3・7 の 4・7 の 6・7 の 8・7 の 9）。呼び手は limitLock の中で呼ぶ。
// 決まり: 止める・戻す・閉じるの判断は、鍵の中で読んだ担当の値だけで行う（実装レビュー r2 の H1-r2・範囲 6 節）。
// 担当の一覧はここ（鍵の中）で読み直し、戻す・止め直す・閉じるの直前にも 1 人ずつ get で読み直して判定し直す。
// handleTick が鍵の外で読んだ一覧は使わない（鍵を待つ間に event の経路が止めた・人が止め直した担当を古い値で閉じる・戻すため）
// ctx = { settings, getIssues, lang, budgetEvents: [{ kind, entityId }], apply }
export async function limitsTick(deps, companyId, ctx) {
  const { settings, getIssues, lang, apply } = ctx;
  const agents = await deps.agents.list({ companyId });
  const nowMs = ctx.nowMs ?? deps.now(), nowIso = new Date(nowMs).toISOString();
  // 設定と同じ契約の一覧を plugin.state に写す。body に無い回は前の値を使う（flag の値が無ければ ON・G8）
  const prev = (await deps.state.get(LIMCFG(companyId))) || {};
  const cfg = { aiLimits: settings.aiLimits ?? prev.aiLimits ?? null, contractGroups: settings.contractGroups ?? prev.contractGroups ?? null };
  await deps.state.set(LIMCFG(companyId), cfg);
  const L = effectiveAiLimits(cfg.aiLimits || defaultAiLimits()), guard = limitGuardOn(cfg.aiLimits), groups = cfg.contractGroups || [];
  const ls = (await deps.state.get(LIMSTATE(companyId))) || {};
  const byId = new Map(agents.map(a => [a.id, a]));
  const out = { guard, paused: [], closed: [], repaused: [], resumed: [] };
  const quota = settings.quota ?? null, oa = openaiWindows(quota);
  const cl = settings.claudeLimits ?? null, cw = claudeWindows(cl);
  const runs = settings.quotaRuns?.runs || [];

  // 1. 開いた記録: 期限の上書き → 閉じる・止め直す・自動で戻す（閉じるは flag OFF でも行う）
  for (const rec of await deps.store.openPauses(companyId)) {
    if (rec.reason === 'provider_quota' && rec.sourceRunId) {
      const run = runs.find(r => r.runId === rec.sourceRunId);
      const logResetsAt = run?.logResetsAt ?? (cl && cl.runId === rec.sourceRunId && cl.status === 'rejected' ? cl.resetsAt : null);
      if (run || logResetsAt != null) {
        const u = betterUntil(rec.untilAt, { logResetsAt, retryNotBefore: run?.retryNotBefore, text: run?.error, nowMs });
        if (u && u !== rec.untilAt) { await deps.store.setPauseUntil(companyId, rec.id, u); rec.untilAt = u; }
      }
    }
    const decide = agent => {
      // ChatGPT の % で止めた時は、その窓が「止める %」未満と読めた時だけ戻す（読めない時は戻さない）
      let stillOver = false;
      const prov = providerOfRec(rec, groups) ?? PROVIDER_OF_ADAPTER[agent?.adapterType] ?? null;
      if (rec.reason === 'pct' && prov === 'openai') {
        const w = oa.windows.find(x => x.kind === rec.windowKind), stop = L.openai?.[rec.windowKind]?.stopPct;
        stillOver = !quota || oa.unreadable || !w || (stop != null && w.usedPercent >= stop);
      }
      // ChatGPT の上限の失敗で止めた時も、quota-windows の 5 時間と週の窓が読めて、どちらも 100% 未満の時だけ戻す
      // （失敗の文から時刻を読めないと retryNotBefore（週の上限でも約 1 時間後）で戻り、1 時間おきに失敗を繰り返す・実装レビュー r1 の M4）
      if (rec.reason === 'provider_quota' && prov === 'openai') {
        const ws = oa.windows.filter(x => x.kind === 'h5' || x.kind === 'week');
        stillOver = !quota || oa.unreadable || !ws.length || ws.some(x => x.usedPercent >= 100);
      }
      return pauseAction(rec, agent && { ...agent, pausedAt: toIso(agent.pausedAt) }, { guard, nowMs, stillOver });
    };
    let action = decide(byId.get(rec.agentId));
    if (action === 'keep') continue;
    // 戻す・止め直す・閉じるの直前に 1 人ずつ読み直して判定し直す（H1-r2）。読み直しが失敗した記録はこの回は何もしない
    if (deps.agents.get) {
      let now;
      try { now = await deps.agents.get(rec.agentId, companyId); } catch (e) { warn(deps, 'reread before limit action failed', e); continue; }
      action = decide(now ?? null);
      if (action === 'keep') continue;
    }
    try {
      if (action.startsWith('close_')) { await deps.store.closePause(companyId, rec.id, action); out.closed.push(rec.agentId); }
      else if (action === 'repause') {
        const p = await deps.agents.pause(rec.agentId, companyId);
        await deps.store.setPauseAgentAt(companyId, rec.id, toIso(p?.pausedAt));
        out.repaused.push(rec.agentId);
      } else if (action === 'resume') {
        await deps.agents.resume(rec.agentId, companyId);
        await deps.store.closePause(companyId, rec.id, 'auto_resumed');
        out.resumed.push({ recId: rec.id, agentId: rec.agentId, issueIds: splitIds(rec.issueIds) });
      }
    } catch (e) { warn(deps, `limit ${action} failed`, e); }
  }

  // 2. 新しく止める（flag ON の時だけ・G8）
  const stop = async g => { const r = await pauseGroup(deps, companyId, g, agents); out.paused.push(...r.paused); return r; };
  const issuesOf = async ids => {
    const iss = await getIssues();
    return Object.fromEntries(ids.map(id => [id, iss.filter(i => i.assigneeAgentId === id && OPEN_STATUSES.includes(i.status)).map(i => i.id).slice(0, 20).join(',') || null]));
  };
  if (guard) {
    // 補いの経路（G5）: event が落ちた時に、起動係が読んだ上限の失敗の run で止める。同じ run では 2 回止めない
    for (const run of runs) {
      if (!isQuotaFailure(run)) continue;
      const peers = contractPeers(groups, run.agentId);
      await stop({ ...peers, reason: 'provider_quota', untilAt: betterUntil(null, { logResetsAt: run.logResetsAt, retryNotBefore: run.retryNotBefore, text: run.error, nowMs }), source: run.runId, sourceAgentId: run.agentId, issueIds: await issuesOf(peers.agentIds) });
    }
    // Claude のログの status:"rejected"（期限を過ぎた古い値では止めない）
    const clReset = cl?.resetsAt != null ? cl.resetsAt * 1000 : null;
    if (cl?.runId && isQuotaFailure({ logStatus: cl.status, logOverageStatus: cl.overageStatus }) && (clReset == null || clReset > nowMs)) {
      const g = providerGroup(groups, { provider: 'anthropic', contract: cl.contract, agents });
      await stop({ ...g, reason: 'provider_quota', untilAt: toIso(clReset), source: cl.runId, issueIds: await issuesOf(g.agentIds) });
    }
    // % で止める（G3b・G3c）。止める % を持つ窓だけ。Claude で読めない形が混じる時は止めない（G2a）
    const overs = [
      ...(quota ? limitState(liveWindows(oa.windows, nowMs), L.openai, 'openai').over.map(o => ({ o, g: providerGroup(groups, { provider: 'openai', agents }) })) : []),
      ...(cl && !cw.unreadable ? limitState(liveWindows(cw.windows, nowMs), L.anthropic, 'anthropic').over.map(o => ({ o, g: providerGroup(groups, { provider: 'anthropic', contract: cl.contract, agents }) })) : []),
    ];
    for (const { o, g } of overs) await stop({ ...g, windowKind: o.kind, reason: 'pct', untilAt: o.resetsAt, source: `pct:${o.key}`, issueIds: await issuesOf(g.agentIds) });
  }
  // 追加料金の枠（G9a）: 同じ source で減ったら知らせ、追加料金の扱いが never・stop なら止める（allow は知らせだけ）。基準は flag OFF でも進める
  const cs = creditsSpend(ls.creditsBase, creditsReading(quota));
  if (quota) ls.creditsBase = cs.base;
  if (guard && cs.spent) {
    ls.creditsSpent = { at: nowIso, from: cs.from, to: cs.to, cancelled: quota.cancelledRunIds || [] };
    if (stopsOnSpend(L)) { const g = providerGroup(groups, { provider: 'openai', agents }); await stop({ ...g, reason: 'credits', source: `credits:${nowIso}`, issueIds: await issuesOf(g.agentIds) }); }
  }
  // Claude の追加料金（G9b）
  const ov = overageState(cl);
  if (guard && ov === 'using' && cl.runId && ls.overage?.runId !== cl.runId) {
    // 同じ追加料金の続きの間（前の知らせがまだ片付いていない間）は、前に取り消した run も知らせに残す。取り消しと担当を止める間に本体が
    // 同じ担当の次の run を始め、次の回でそれも取り消すと、知らせが新しい run に替わって最初に取り消した run が消えていた（e2e の段 12 で見つけた）
    const prevCancelled = Array.isArray(ls.overage?.cancelled) ? ls.overage.cancelled : [];
    ls.overage = { at: nowIso, runId: cl.runId, cancelled: [...new Set([...prevCancelled, ...(cl.cancelledRunIds || [])])].slice(-20) };
    if (stopsOnSpend(L)) { const g = providerGroup(groups, { provider: 'anthropic', contract: cl.contract, agents }); await stop({ ...g, reason: 'overage', source: `overage:${cl.runId}`, issueIds: await issuesOf(g.agentIds) }); }
  }

  // 3. 知らせ（reconcileKind で出し続ける）
  const recs = await deps.store.openPauses(companyId);
  const iss = await getIssues();
  const issueById = new Map(iss.map(i => [i.id, i]));
  // 課題の id がまだ無い記録（event の経路で止めた同じ契約の担当）は、今持っている開いた課題で埋める
  for (const rec of recs) {
    if (rec.issueIds) continue;
    const ids = iss.filter(i => i.assigneeAgentId === rec.agentId && OPEN_STATUSES.includes(i.status)).map(i => i.id).slice(0, 20).join(',');
    if (ids) { await deps.store.setPauseIssues(companyId, rec.id, ids); rec.issueIds = ids; }
  }
  const nameOf = id => byId.get(id)?.name || id;
  const issuesFor = s => splitIds(s).map(id => issueById.get(id) || { id, identifier: null, title: id });
  // 予算の incident: 起動係が渡した一覧が正。渡さない回は event で知った物を使う（G7・7 の 8）
  const bev = { ...(ls.budgetEvents || {}) };
  for (const e of ctx.budgetEvents || []) { if (e.kind === 'budget_opened') bev[e.entityId] = { id: e.entityId, thresholdType: null }; else delete bev[e.entityId]; }
  let incidents;
  if (settings.budgetIncidents) { incidents = hardIncidents(settings.budgetIncidents); ls.budgetEvents = {}; }
  else { incidents = Object.values(bev); ls.budgetEvents = bev; }
  const pausedWant = [...recs.map(rec => pauseNotice(rec, { lang, agentName: nameOf(rec.agentId), issues: issuesFor(rec.issueIds) })), ...incidents.map(i => budgetNotice(i, lang))];
  out.notices = { paused: await apply('agent_paused_limit', pausedWant) };

  // 近い（G2b・G2c）: その provider の値が来なかった回は、出ている知らせを残す
  const have = async kind => deps.store.listNotices(companyId, { kinds: [kind] });
  const W = { h5: t(lang, 'w_h5'), week: t(lang, 'w_week') }, P = { openai: 'ChatGPT', anthropic: 'Claude' };
  const nearOf = n => ({ key: noticeKey('ai_limit_near', n.key), kind: 'ai_limit_near', originId: n.key, title: `${t(lang, 'near_t')}: ${P[n.provider]} ${W[n.kind] || n.kind}${n.usedPercent != null ? ` ${n.usedPercent}%` : ''}` });
  const nearHave = await have('ai_limit_near');
  const keepProv = p => nearHave.filter(n => String(n.originId).startsWith(`${p}:`));
  let nearWant = [
    ...(quota ? limitState(liveWindows(oa.windows, nowMs), L.openai, 'openai').near.map(nearOf) : keepProv('openai')),
    ...(cl ? (cw.unreadable ? [] : limitState(liveWindows(cw.windows, nowMs), L.anthropic, 'anthropic').near.map(nearOf)) : keepProv('anthropic')),
  ];
  if (!guard) nearWant = keepOnly(nearWant, nearHave);
  out.notices.near = await apply('ai_limit_near', nearWant);

  // 読めない（G2a・G9a・7 の 2）
  const unHave = await have('ai_quota_unreadable');
  const un = (id, k) => ({ key: noticeKey('ai_quota_unreadable', id), kind: 'ai_quota_unreadable', originId: id, title: `${t(lang, 'unreadable_t')}: ${t(lang, k)}` });
  const keepUn = ids => unHave.filter(n => ids.includes(n.originId));
  const hasClaude = groups.some(g => g.provider === 'anthropic') || agents.some(a => a.adapterType === 'claude_local');
  let unWant = [
    ...(quota ? [...(!quota.ok ? [un('openai', 'openai_unreadable')] : []), ...(quota.ok && !creditsReading(quota) ? [un('openai_credits', 'credits_unreadable')] : [])] : keepUn(['openai', 'openai_credits'])),
    ...(cl ? (cw.unreadable && hasClaude ? [un('anthropic', 'claude_unreadable')] : []) : keepUn(['anthropic'])),
    ...(settings.quotaRuns ? (settings.quotaRuns.complete === false ? [un('runs', 'runs_unread')] : []) : keepUn(['runs'])),
  ];
  if (!guard) unWant = keepOnly(unWant, unHave);
  out.notices.unreadable = await apply('ai_quota_unreadable', unWant);

  // 追加料金の知らせ: 止めている間・まだ読んでいない間・使い続けている間は出し続ける
  const openReasons = new Set(recs.map(r => r.reason));
  const creditsHave = await have('ai_credits_spent');
  if (ls.creditsSpent && !cs.spent && !openReasons.has('credits') && creditsHave.length && creditsHave.every(n => n.readAt)) ls.creditsSpent = null;
  const usd = v => `$${Number(v).toFixed(2)}`;
  out.notices.credits = await apply('ai_credits_spent', ls.creditsSpent ? [{ key: noticeKey('ai_credits_spent', ls.creditsSpent.at), kind: 'ai_credits_spent', originId: ls.creditsSpent.at, title: `${t(lang, 'credits_t')} (${usd(ls.creditsSpent.from)} → ${usd(ls.creditsSpent.to)})`, body: ls.creditsSpent.cancelled.length ? `cancelled: ${ls.creditsSpent.cancelled.join(', ')}` : null }] : []);
  const ovHave = await have('ai_overage_started');
  if (ls.overage && ov !== 'using' && !openReasons.has('overage') && ovHave.length && ovHave.every(n => n.readAt)) ls.overage = null;
  out.notices.overage = await apply('ai_overage_started', ls.overage ? [{ key: noticeKey('ai_overage_started', ls.overage.runId), kind: 'ai_overage_started', originId: ls.overage.runId, title: t(lang, 'overage_t'), body: ls.overage.cancelled.length ? `cancelled: ${ls.overage.cancelled.join(', ')}` : null }] : []);

  // 予算が未設定（G7b）: 一覧が来なかった回は残す
  const gaps = settings.budgetGaps;
  const gapHave = await have('budget_unset');
  out.notices.budgetUnset = await apply('budget_unset', gaps ? (gaps.length ? [{ key: noticeKey('budget_unset', `gaps:${gaps.length}`), kind: 'budget_unset', originId: `gaps:${gaps.length}`, title: `${t(lang, 'budget_t')}: ${gaps.length}`, body: t(lang, 'budget_gaps') }] : []) : gapHave);

  // 戻した知らせ（G6）: 7 日出す
  ls.resumed = [...(ls.resumed || []).filter(r => nowMs - Date.parse(r.at) < RESUMED_KEEP_MS), ...out.resumed.map(r => ({ ...r, at: nowIso, name: nameOf(r.agentId), issues: issuesFor(r.issueIds.join(',')).map(i => ({ identifier: i.identifier ?? null, title: safeTitle(i.title || '', 120) })) }))];
  out.notices.resumed = await apply('agent_resumed_limit', ls.resumed.map(r => resumedNotice(r, lang)));

  // 画面の値（office の帯と「AI の契約」の欄が /settings で読む・範囲 7 の 7）
  ls.view = {
    at: nowIso, guard, overageEnabled: ov === 'enabled',
    claude: cl ? { observedAt: cw.observedAt, unreadable: cw.unreadable, windows: cw.windows } : ls.view?.claude ?? null,
    // ChatGPT の直近の使用率（「AI の契約」の欄に読んだ時刻つきで出す）。値の来なかった回は前の値を残す
    openai: quota ? { observedAt: nowIso, unreadable: oa.unreadable, windows: oa.windows } : ls.view?.openai ?? null,
    pauses: viewPauses(recs),
  };
  await deps.state.set(LIMSTATE(companyId), ls);
  return out;
}

// 見回りの口。deps = { store, state, approvals, now, flight }
export async function handleTick(deps, companyId, body) {
  const r = await deps.flight.run(async () => {
    const budget = makeBudget(deps.now);
    const checked = checkTickBody(body);
    // 会社の設定に残すのは言語と時刻帯だけ（上限の値は大きいので、上限の見回りの state に分けて持つ）
    const settings = { lang: checked.lang, timeZone: checked.timeZone };
    await deps.state.set(SETTINGS(companyId), settings);
    const pending = await deps.approvals.list({ companyId, status: 'pending' });
    const { add, remove } = reconcileApprovals(pending, await deps.store.listNotices(companyId, { kinds: ['approval'] }));
    // どの書き込みの列も 1 件ごとに 20 秒の枠を見る（溜まった分で本体の 30 秒を超えない・codex P2-3）。残りは次の回の突き合わせで足す
    const out = { v: 1, settings, approvals: { added: 0, removed: 0 }, partial: false };
    for (const n of add) { if (budget.over()) { out.partial = true; break; } await deps.store.addNotice(companyId, n); out.approvals.added++; }
    for (const k of remove) { if (budget.over()) { out.partial = true; break; } await deps.store.removeNotice(companyId, k); out.approvals.removed++; }
    const apply = async (kinds, want) => { const r = reconcileKind(kinds, want, await deps.store.listNotices(companyId, { kinds })); for (const n of r.add) await deps.store.addNotice(companyId, n); for (const k of r.remove) await deps.store.removeNotice(companyId, k); return { added: r.add.length, removed: r.remove.length }; };
    const lang = settings.lang;
    // event: 担当の実行の失敗を 1 件ずつ知らせにし、担当ごとの続けての失敗の数を進める（ほかの種類は済みにするだけ）。
    // 1 件ごとに枠を見て、処理した event だけを済みにする（残りは次の回・codex P2-3）
    const evs = await deps.store.openEvents(companyId);
    const done = [], budgetEvents = [];
    // 数がまだ無い時（初めての回・数を持たない前の版からの版上げ）は、出ている「失敗が続いています」の担当を 3 から始め、
    // その担当の成功の event が来るまで知らせを消さない（codex 2 回目 P2-2）
    let streaks = await deps.state.get(STREAK(companyId));
    if (!streaks) streaks = Object.fromEntries((await deps.store.listNotices(companyId, { kinds: ['run_failing'] })).map(n => [n.originId, 3]));
    for (const e of evs) {
      if (budget.over()) { out.partial = true; break; }
      if (e.kind === 'run_failed') await deps.store.addNotice(companyId, { key: noticeKey('run_failed', e.entityId), kind: 'run_failed', originId: e.entityId, title: t(lang, 'failed') });
      if (e.kind === 'budget_opened' || e.kind === 'budget_resolved') budgetEvents.push(e);
      streaks = stepStreaks(streaks, [e]);
      done.push(e.id);
    }
    await deps.state.set(STREAK(companyId), streaks);
    // 同じ担当が続けて 3 回失敗（数はその担当の成功でだけ戻る・消えた担当の分は出さない）。
    // この一覧は鍵の外で読むので、知らせ（run_failing・止まった課題）にだけ使い、止める・戻す・閉じるの判断には渡さない（H1-r2）
    const agents = await deps.agents.list({ companyId });
    const agentName = new Map(agents.map(a => [a.id, a.name])), agentStatus = new Map(agents.map(a => [a.id, a.status]));
    out.failing = await apply('run_failing', failingAgents(streaks).filter(id => agentName.has(id)).map(id => ({ key: noticeKey('run_failing', id), kind: 'run_failing', originId: id, title: `${t(lang, 'failing')}: ${safeTitle(agentName.get(id) || id, 80)}` })));
    let issuesMemo = null;
    const getIssues = async () => (issuesMemo ??= await deps.issues.list({ companyId, limit: 5000 }));
    // AI の上限（止める・戻す・知らせ）。止める処理は枠の残りが 5 秒を切っていなければ回す（event の済みは上限の処理の後に付ける）
    // limitsTick が投げても、後ろの処理（止まった課題・判断待ち・まとめ・片付け）と event の済みは続ける。
    // 予算の event だけは上限の処理が読み終えた回に済みにする（実装レビュー r1 の M2）
    let limitsDone = false;
    if (budget.left() > 5000) {
      try {
        out.limits = await limitLock(deps).run(() => limitsTick(deps, companyId, { settings: checked, getIssues, lang, budgetEvents, apply, nowMs: budget.start }));
        limitsDone = true;
      } catch (e) { out.limitsError = redactSecrets(String(e?.message || e)).slice(0, 200); warn(deps, 'limits tick failed', e); }
    } else out.partial = true;
    await deps.store.doneEvents(companyId, limitsDone ? done : done.filter(id => !budgetEvents.some(e => e.id === id)));
    // 枠を超えていたら止まった課題と判断待ちは次の回へ回し、朝夕のまとめまでは進む（まとめが飢えない・2 回目のレビュー P3）
    if (budget.over()) out.partial = true;
    else {
      // 止まった課題（今の状態は本体から読む・実測 18）。担当が paused の課題は外れ、AI オフィスが止めた担当の課題は止めた知らせの本文に出る
      const issues = await getIssues();
      const cfg = (await deps.config.get(companyId).catch(() => ({}))) || {};
      const idleMin = Math.max(1, Math.floor(Number(cfg.stuckIdleMin) || 60));
      out.stuck = await apply(['stuck', 'stale_routine'], selectStuck(issues, { nowMs: deps.now(), idleMin, agentStatus }).map(x => ({ key: noticeKey(x.kind, x.issueId), kind: x.kind, originId: x.issueId, title: `${t(lang, x.kind === 'stuck' ? 'stuck_t' : 'stale')}: ${x.identifier ? `${x.identifier} ` : ''}${x.title}`.slice(0, 200) })));
      // 判断待ち: 開いた課題を id の順に 1 回 50 件まで読み、続きの位置と見つけた知らせの key を会社の state に残す。
      // 見つけた知らせはその回に足す。消すのは全部を読み終えた周だけ（読んでいない課題の知らせを消さない・独立レビュー P1-3）
      const scan = (await deps.state.get(DSCAN(companyId))) || { cursor: null, keys: [] };
      const { page, last: pageLast } = decisionPage(issues, scan.cursor);
      let added = 0, finished = pageLast;
      for (const i of page) {
        if (budget.over()) { finished = false; out.partial = true; break; }
        for (const x of unanswered(await deps.issues.listInteractions(i.id, companyId))) {
          const n = { key: noticeKey('decision', x.id), kind: 'decision', originId: i.id, title: `${t(lang, 'decision_t')}: ${i.identifier ? `${i.identifier} ` : ''}${safeTitle(x.title || i.title || '', 160)}` };
          await deps.store.addNotice(companyId, n); scan.keys.push(n.key); added++;
        }
        scan.cursor = i.id;
      }
      let removed = 0;
      if (finished) {
        const keep = new Set(scan.keys);
        for (const n of (await deps.store.listNotices(companyId, { kinds: ['decision'] })).filter(n => n.kind === 'decision' && !keep.has(n.key))) { await deps.store.removeNotice(companyId, n.key); removed++; }
        await deps.state.set(DSCAN(companyId), { cursor: null, keys: [] });
      } else await deps.state.set(DSCAN(companyId), { cursor: scan.cursor, keys: [...new Set(scan.keys)] });
      out.decision = { found: added, removed, scanDone: finished };
    }
    // 朝夕のまとめ（その回を過ぎて最初の見回りで 1 通・同じ回は二度作らない）
    const slot = digestSlot(deps.now(), settings.timeZone);
    const last = await deps.state.get(DIGEST(companyId));
    if (slot && last !== slot.key) {
      // 止めている担当（agent_paused_limit）は既読でも毎回入れる（G4）
      const unread = (await deps.store.listNotices(companyId, { kinds: ['approval', 'decision', 'run_failed', 'run_failing', 'stuck', 'stale_routine', 'digest', ...LIMIT_KINDS] })).filter(n => !n.readAt || n.kind === 'agent_paused_limit');
      const count = k => unread.filter(n => [].concat(k).includes(n.kind)).length;
      const title = digestTitle({ slot: slot.slot, lang, utc: !settings.timeZone, counts: { paused: count('agent_paused_limit'), approval: count('approval'), decision: count('decision'), run_failed: count(['run_failed', 'run_failing']), stuck: count(['stuck', 'stale_routine']), unread: count(['digest', ...LIMIT_KINDS.filter(k => k !== 'agent_paused_limit')]) } });
      // 一覧（保証 19「件数と一覧」・codex P2-2）。前のまとめを読んでいない時は「未読の知らせ」に数える
      await deps.store.addNotice(companyId, { key: noticeKey('digest', slot.key), kind: 'digest', originId: slot.key, title, body: digestBody({ lang, unread }) });
      await deps.state.set(DIGEST(companyId), slot.key);
    }
    out.digestKey = slot && last !== slot.key ? slot.key : (last ?? null);
    // 片付け（読んだ物・古い失敗とまとめ・済んだ event）。形の合わない event の数を返す（保証 8: 黙って捨てない・帯に「本体の版と合いません」）
    if (deps.store.prune && !budget.over()) await deps.store.prune(companyId);
    out.dropped = deps.dropped || 0;
    out.budgetLeftMs = Math.max(0, budget.left());
    return out;
  });
  if (r.busy) return { status: 409, body: { error: 'notify_busy' } };
  return { status: 200, body: r.value };
}

// 画面の「再開」の後に記録を閉じる口（G6・範囲 7 の 7）。画面が本体の resume を呼んだ後に呼ぶ。
// 本当に paused でなくなった担当の記録だけを閉じる（まだ paused の担当は stillPaused で返す）。flag OFF でも行う
export async function handleLimitResume(deps, companyId, body) {
  const ids = Array.isArray(body?.agentIds) ? [...new Set(body.agentIds.filter(x => typeof x === 'string' && /^[A-Za-z0-9_.:-]{1,128}$/.test(x)))].slice(0, 500) : [];
  if (!ids.length) return { status: 400, body: { error: 'notify_bad_agents' } };
  // 鍵の中で読み、閉じる直前にも 1 人ずつ読み直す（鍵を待つ間・読んだ後に止め直した担当の記録を閉じない・実装レビュー r2 の H1-r2）
  const { closed, stillPaused } = await limitLock(deps).run(async () => {
    const agents = new Map((await deps.agents.list({ companyId })).map(a => [a.id, a]));
    const recs = (await deps.store.openPauses(companyId)).filter(r => ids.includes(r.agentId));
    const closed = [], stillPaused = [];
    for (const rec of recs) {
      let a = agents.get(rec.agentId);
      if (a && a.status === 'paused') { stillPaused.push(rec.agentId); continue; }
      if (deps.agents.get) {
        // 読み直しが失敗したら閉じない（まだ paused として返す・記録は次の見回りが閉じる）
        try { a = await deps.agents.get(rec.agentId, companyId); } catch (e) { warn(deps, 'reread before close failed', e); stillPaused.push(rec.agentId); continue; }
        if (a && a.status === 'paused') { stillPaused.push(rec.agentId); continue; }
      }
      await deps.store.closePause(companyId, rec.id, 'manual_resume');
      closed.push(rec.agentId);
    }
    return { closed, stillPaused };
  });
  // 閉じた担当の知らせは次の見回りを待たずに消す
  for (const n of await deps.store.listNotices(companyId, { kinds: ['agent_paused_limit'] })) if (closed.includes(n.originId)) await deps.store.removeNotice(companyId, n.key);
  return { status: 200, body: { v: 1, closed, stillPaused } };
}

export async function handleRoute(deps, input) {
  const companyId = input.companyId;
  if (input.routeKey === 'tick') return handleTick(deps, companyId, input.body);
  // Slack への届け（docs/review/2026-11-18-slack-notify-scope.md）。どの口も URL を body で受けない（S3）
  if (input.routeKey === 'slack') return { status: 200, body: await slackStatus(deps, companyId) };
  if (input.routeKey === 'slack-preview') return slackPreview(deps, companyId, input.query);
  if (input.routeKey === 'slack-confirm') return slackConfirm(deps, companyId, input.body);
  if (input.routeKey === 'slack-off') return slackOff(deps, companyId);
  if (input.routeKey === 'slack-test') return slackTest(deps, companyId);
  if (input.routeKey === 'deliver') return slackDeliver(deps, companyId);
  // メールで届ける: 文を作って待ちに積むだけ（送るのは起動係）。宛先・アプリ パスワードは受けない
  if (MAIL_ROUTE_KEYS.includes(input.routeKey)) return mailRoute(deps, input);
  if (input.routeKey === 'settings') {
    const ls = (await deps.state.get(LIMSTATE(companyId))) || {};
    return { status: 200, body: { v: 1, settings: (await deps.state.get(SETTINGS(companyId))) || { lang: 'en', timeZone: null }, limits: ls.view ?? null } };
  }
  if (input.routeKey === 'notices') return { status: 200, body: { v: 1, notices: await deps.store.listNotices(companyId) } };
  if (input.routeKey === 'read') {
    const key = typeof input.body?.key === 'string' ? input.body.key : '';
    if (!/^[0-9a-f]{32}$/.test(key)) return { status: 400, body: { error: 'notify_bad_key' } };
    await deps.store.markRead(companyId, key);
    return { status: 200, body: { v: 1 } };
  }
  if (input.routeKey === 'limit-resume') return handleLimitResume(deps, companyId, input.body);
  return { status: 404, body: { error: 'unknown route' } };
}

let D = null;
const plugin = definePlugin({
  async setup(ctx) {
    const queue = serialQueue(e => ctx.logger.warn('notify: event append failed', { error: String(e?.message || e).slice(0, 200) }));
    const store = dbStore(ctx.db);
    D = { store, state: ctx.state, approvals: ctx.approvals, issues: ctx.issues, agents: ctx.agents, config: ctx.config, logger: ctx.logger, now: () => Date.now(), flight: singleFlight(), limitLock: mutex(), queue, dropped: 0,
      // Slack への届け（S1〜S8）: 送りの記録の表・知らせの表・秘密・本体の外への口・起動係の照合の口
      slack: slackStore(ctx.db), notices: store, secrets: ctx.secrets, http: ctx.http, verifyNonce: createVerifyNonce(nonceUrl(process.env)), savedDest: createSavedDest(savedUrl(process.env)), sleep: ms => new Promise(r => setTimeout(r, ms)), slackFlight: singleFlight(),
      mail: mailStore(ctx.db), mailFlight: singleFlight() };
    for (const name of Object.keys(EVENT_KINDS)) {
      ctx.events.on(name, async ev => {
        const row = eventRow(ev);
        if (!row) { D.dropped++; return; }
        queue.push(() => D.store.addEvent(row)); // 返事を待たずに返す（表の書き込みは scope に縛られない・実測 22）
        // 上限の失敗だけは、この処理の中で止めて返事を待つ（待ち行列に載せない・G5）
        if (row.kind === 'run_failed' && isQuotaFailure(row)) {
          const issueId = typeof ev.payload?.issueId === 'string' && /^[A-Za-z0-9_.:-]{1,128}$/.test(ev.payload.issueId) ? ev.payload.issueId : null;
          try { await handleRunFailed(D, row, { issueId }); } catch (e) { warn(D, 'limit pause on event failed', e); }
        }
      });
    }
  },
  async onApiRequest(input) {
    try { return await handleRoute(D, input); }
    // Slack の口の error は文を外へ出さない（URL が起動係の状態に残らない・S3）
    catch (e) { return { status: 502, body: String(input?.routeKey || '').startsWith('slack') || input?.routeKey === 'deliver' ? { error: 'notify_failed' } : { error: 'notify_failed', detail: String(e?.message || e).slice(0, 200) } }; }
  },
  async onHealth() { return { status: 'ok' }; },
});
export default plugin;
runWorker(plugin, import.meta.url);
