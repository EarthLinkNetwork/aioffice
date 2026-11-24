// 知らせの plugin の AI の使用量の上限の、止める・知らせる・戻す処理の試験（範囲: docs/review/2026-11-18-ai-usage-limit-scope.md（開発元の記録）の 8 節の unit のうち第 2 段の物）
// 本体は偽物（作りは plugin-notify.test.mjs の fakeDeps に合わせる）
import test from 'node:test';
import assert from 'node:assert/strict';
import manifest from '../plugins/notify/src/manifest.mjs';
import { eventRow, singleFlight, noticeKey, betterUntil, providerGroup, liveWindows, pauseNotice, keepOnly } from '../plugins/notify/src/lib.mjs';

const { handleTick, handleRoute, handleRunFailed, dbStore, LIMCFG } = await import('../plugins/notify/src/worker.mjs');

const T0 = Date.parse('2026-11-17T22:21:00Z');
const M3_TEXT = "Claude run failed: subtype=success: You've hit your weekly limit · resets Nov 19, 9am (UTC)";
const RESET_M4 = 1795078800; // 2026-11-19T09:00:00Z（実測 4）
const GROUPS = [
  { contract: 'anthropic:ref-1', provider: 'anthropic', agentIds: ['a1', 'a2', 'a3'] },
  { contract: 'anthropic:ref-2', provider: 'anthropic', agentIds: ['b1'] },
  { contract: 'openai', provider: 'openai', agentIds: ['o1', 'o2'] },
];
const agent = (id, o = {}) => ({ id, name: `N-${id}`, status: 'idle', pausedAt: null, adapterType: id.startsWith('o') ? 'codex_local' : 'claude_local', ...o });

function fakeDeps({ agents = [], issues = [], events = [], now = T0, state: st = {} } = {}) {
  const notices = new Map(), state = new Map(Object.entries(st)), ev = events.map((e, i) => ({ id: i + 1, done: false, ...e }));
  const pauses = []; const calls = { pause: [], resume: [], sleep: [] };
  const byId = new Map(agents.map(a => [a.id, a]));
  let clock = now, pid = 0;
  const deps = {
    now: () => clock,
    flight: singleFlight(),
    sleep: async ms => { calls.sleep.push(ms); if (deps.onSleep) await deps.onSleep(); },
    state: { set: async (k, v) => state.set(JSON.stringify(k), v), get: async k => state.get(JSON.stringify(k)) ?? null },
    approvals: { list: async () => [] },
    issues: { list: async () => issues, listInteractions: async () => [] },
    agents: {
      list: async () => [...byId.values()].map(a => ({ ...a })),
      get: async (id) => { if (deps.onGet) await deps.onGet(id); const a = byId.get(id); return a ? { ...a } : null; },
      pause: async (id) => { const a = byId.get(id); if (!a || a.status === 'terminated') throw new Error('not found'); calls.pause.push(id); a.status = 'paused'; a.pausedAt = new Date(clock + calls.pause.length).toISOString(); return { ...a }; },
      resume: async (id) => { const a = byId.get(id); calls.resume.push(id); a.status = 'idle'; a.pausedAt = null; return { ...a }; },
    },
    config: { get: async () => ({}) },
    store: {
      listNotices: async (c, { kinds } = {}) => [...notices.values()].filter(n => n.c === c && (!kinds || [].concat(kinds).includes(n.kind))),
      addNotice: async (c, n) => { if (!notices.has(c + n.key)) notices.set(c + n.key, { ...n, c, readAt: null }); },
      removeNotice: async (c, k) => notices.delete(c + k),
      markRead: async (c, k) => { const n = notices.get(c + k); if (n) n.readAt = 'now'; },
      openEvents: async c => ev.filter(e => (e.companyId || 'c1') === c && !e.done),
      doneEvents: async (c, ids) => { for (const e of ev) if (ids.includes(e.id)) e.done = true; },
      openPauses: async c => pauses.filter(p => p.c === c && !p.resumedAt).map(p => ({ ...p })),
      pausesBySource: async (c, s) => pauses.filter(p => p.c === c && p.sourceRunId === s).map(p => ({ agentId: p.agentId })),
      addPause: async (c, r) => { const cur = pauses.find(p => p.c === c && p.agentId === r.agentId && !p.resumedAt); if (cur) { if (deps.conflictUpdates !== false) cur.agentPausedAt = r.agentPausedAt ?? null; return; } pauses.push({ id: String(++pid), c, ...r, resumedAt: null, closeReason: null }); },
      setPauseUntil: async (c, id, u) => { pauses.find(p => p.id === id).untilAt = u; },
      setPauseAgentAt: async (c, id, at) => { pauses.find(p => p.id === id).agentPausedAt = at; },
      setPauseIssues: async (c, id, s) => { pauses.find(p => p.id === id).issueIds = s; },
      closePause: async (c, id, reason) => { const p = pauses.find(x => x.id === id); if (!p.resumedAt) { p.resumedAt = 'now'; p.closeReason = reason; } },
    },
  };
  return { deps, notices, state, ev, pauses, calls, byId, setNow: v => { clock = v; } };
}
const cfgState = (v) => ({ [JSON.stringify(LIMCFG('c1'))]: v });
const failedRow = (o = {}) => eventRow({ eventType: 'agent.run.failed', companyId: 'c1', entityId: 'run1', occurredAt: '2026-11-17T22:21:00Z', payload: { agentId: 'a1', errorCode: 'provider_quota', error: M3_TEXT, ...o } });
const kindsOf = f => [...f.notices.values()].map(n => n.kind);
const open = f => f.pauses.filter(p => !p.resumedAt);

test('manifest: 止める・戻す capability と /limit/resume の口がある（起こす capability は無いまま）', () => {
  for (const c of ['agents.pause', 'agents.resume']) assert.ok(manifest.capabilities.includes(c), c);
  assert.ok(!manifest.capabilities.includes('agents.invoke'));
  const r = manifest.apiRoutes.find(x => x.routeKey === 'limit-resume');
  assert.deepEqual([r.method, r.path, r.auth], ['POST', '/limit/resume', 'board']);
});

test('G5 event: 上限の失敗で同じ契約の担当をまとめて止め、別の token・API キーの担当は止めない・期限は文から仮に置く', async () => {
  const f = fakeDeps({ agents: [agent('a1'), agent('a2'), agent('a3'), agent('b1'), agent('k1')], state: cfgState({ contractGroups: GROUPS }) });
  const r = await handleRunFailed(f.deps, failedRow(), { issueId: 'i1' });
  assert.deepEqual(r.paused, ['a1', 'a2', 'a3']);
  assert.deepEqual(f.calls.pause, ['a1', 'a2', 'a3']);
  assert.equal(f.byId.get('b1').status, 'idle'); assert.equal(f.byId.get('k1').status, 'idle');
  assert.deepEqual(open(f).map(p => [p.agentId, p.reason, p.contract, p.sourceRunId, p.sourceAgentId]), [['a1', 'provider_quota', 'anthropic:ref-1', 'run1', 'a1'], ['a2', 'provider_quota', 'anthropic:ref-1', 'run1', 'a1'], ['a3', 'provider_quota', 'anthropic:ref-1', 'run1', 'a1']]);
  assert.equal(open(f)[0].untilAt, '2026-11-19T09:00:00.000Z');
  assert.equal(open(f)[0].issueIds, 'i1'); assert.equal(open(f)[1].issueIds, null);
  // 止めた後の pausedAt を記録に書く（G3）
  assert.equal(open(f)[0].agentPausedAt, f.byId.get('a1').pausedAt);
  assert.deepEqual(f.calls.sleep, [5000], '返す前に 5 秒おいて読み直す');
});

test('G3: まとめて止める中に既に paused の担当（人が止めた）がいれば、その担当だけ止めず記録もしない', async () => {
  const f = fakeDeps({ agents: [agent('a1'), agent('a2', { status: 'paused', pausedAt: '2026-11-17T00:00:00.000Z' }), agent('a3')], state: cfgState({ contractGroups: GROUPS }) });
  const r = await handleRunFailed(f.deps, failedRow());
  assert.deepEqual(r.paused, ['a1', 'a3']); assert.deepEqual(r.skipped, ['a2']);
  assert.deepEqual(open(f).map(p => p.agentId), ['a1', 'a3']);
  assert.ok(!f.calls.pause.includes('a2'));
});

test('G5 競り合い: 5 秒後の読み直しで paused でなければ止め直し、記録の pausedAt を新しくする', async () => {
  const f = fakeDeps({ agents: [agent('a1'), agent('a2')], state: cfgState({ contractGroups: GROUPS }) });
  // 走り終わりの処理が止めた後に idle へ戻した形（pausedAt は残る・範囲 2.5）
  f.deps.onSleep = async () => { f.byId.get('a2').status = 'idle'; };
  const r = await handleRunFailed(f.deps, failedRow());
  assert.deepEqual(r.repaused, ['a2']);
  assert.equal(f.byId.get('a2').status, 'paused');
  assert.equal(open(f).find(p => p.agentId === 'a2').agentPausedAt, f.byId.get('a2').pausedAt);
});

test('G5 event: 上限でない失敗・flag OFF では止めない・flag の値が無い時（最初の /tick の前）は ON で、その担当だけを止める', async () => {
  const f = fakeDeps({ agents: [agent('a1'), agent('a2')] });
  assert.deepEqual((await handleRunFailed(f.deps, failedRow({ errorCode: 'adapter_failed', error: 'npm ERR! boom' }))).paused, []);
  const off = fakeDeps({ agents: [agent('a1')], state: cfgState({ aiLimits: { guard: false }, contractGroups: GROUPS }) });
  const r = await handleRunFailed(off.deps, failedRow());
  assert.equal(r.guard, false); assert.deepEqual(off.calls.pause, []);
  // state が無い: ON・組を知らないのでその担当だけ
  assert.deepEqual((await handleRunFailed(f.deps, failedRow())).paused, ['a1']);
});

test('補いの経路: event が無く quotaRuns だけ・claudeLimits の rejected だけでも止める・同じ runId では 1 回だけ', async () => {
  const f = fakeDeps({ agents: [agent('a1'), agent('a2'), agent('b1'), agent('o1')] });
  const body = { contractGroups: GROUPS, quotaRuns: { runs: [{ runId: 'run9', agentId: 'o1', status: 'failed', errorCode: 'provider_quota', error: 'usage limit reached', retryNotBefore: '2026-11-18T23:24:14Z' }], complete: true } };
  const r = await handleTick(f.deps, 'c1', body);
  assert.deepEqual(r.body.limits.paused, ['o1']);
  assert.equal(open(f)[0].untilAt, '2026-11-18T23:24:14.000Z');
  // 同じ run がもう一度来ても、人が再開した後でも止めない
  await f.deps.agents.resume('o1');
  await handleTick(f.deps, 'c1', body);
  assert.equal(f.calls.pause.filter(x => x === 'o1').length, 1);
  assert.deepEqual(f.pauses.map(p => p.closeReason), ['close_resumed']);
  // event と quotaRuns が同じ runId を持つ時は 1 回だけ
  const g = fakeDeps({ agents: [agent('a1'), agent('a2')], state: cfgState({ contractGroups: GROUPS }) });
  await handleRunFailed(g.deps, failedRow());
  await handleTick(g.deps, 'c1', { quotaRuns: [{ runId: 'run1', agentId: 'a1', status: 'failed', errorCode: 'provider_quota', logStatus: 'rejected', logResetsAt: RESET_M4 }] });
  assert.equal(g.calls.pause.length, 2);
  // claudeLimits の rejected だけ: 同じ token の組を止め、期限はログの resetsAt
  const h = fakeDeps({ agents: [agent('a1'), agent('a2'), agent('b1')], now: T0 });
  await handleTick(h.deps, 'c1', { contractGroups: GROUPS, claudeLimits: { observedAt: '2026-11-17T22:20:00Z', runId: 'run5', contract: 'anthropic:ref-1', status: 'rejected', resetsAt: RESET_M4, rateLimitType: 'seven_day', overageStatus: 'rejected', unifiedWindows: { seven_day: { utilization: 1, resetsAt: RESET_M4, status: 'rejected' } } } });
  assert.deepEqual(open(h).map(p => [p.agentId, p.untilAt]), [['a1', '2026-11-19T09:00:00.000Z'], ['a2', '2026-11-19T09:00:00.000Z']]);
});

test('期限の上書き: event で文から置いた期限を、/tick のログの resetsAt が正として上書きする・ログが無い時は遅い方', async () => {
  const f = fakeDeps({ agents: [agent('a1')], state: cfgState({ contractGroups: GROUPS }) });
  await handleRunFailed(f.deps, failedRow({ error: "You've hit your weekly limit · resets 11pm (UTC)" }));
  assert.equal(open(f)[0].untilAt, '2026-11-17T23:00:00.000Z');
  await handleTick(f.deps, 'c1', { quotaRuns: [{ runId: 'run1', agentId: 'a1', status: 'failed', errorCode: 'provider_quota', logResetsAt: RESET_M4 }] });
  assert.equal(open(f)[0].untilAt, '2026-11-19T09:00:00.000Z');
  // ログが無い: 今の期限・文・retryNotBefore の遅い方（P1: retryNotBefore は週の上限でも 1 時間後のことがある）
  assert.equal(betterUntil('2026-11-19T09:00:00.000Z', { retryNotBefore: '2026-11-17T23:24:14Z', nowMs: T0 }), '2026-11-19T09:00:00.000Z');
  assert.equal(betterUntil(null, { retryNotBefore: '2026-11-17T23:24:14Z', text: M3_TEXT, nowMs: T0 }), '2026-11-19T09:00:00.000Z');
  assert.equal(betterUntil('2026-11-19T09:00:00.000Z', { logResetsAt: 1795000000, nowMs: T0 }), new Date(1795000000e3).toISOString());
  assert.equal(betterUntil(null, { nowMs: T0 }), null);
});

test('戻す・止め直す・閉じる（7 の 6）: 競り合いは止め直し、人の再開・人の止め直しは閉じる・期限を過ぎたら自動で戻して知らせる', async () => {
  const f = fakeDeps({ agents: [agent('a1'), agent('a2'), agent('a3')], issues: [{ id: 'i1', identifier: 'TES-1', title: 'Write post', status: 'blocked', assigneeAgentId: 'a1' }], state: cfgState({ contractGroups: GROUPS }) });
  await handleRunFailed(f.deps, failedRow());
  // a1: 競り合いで idle（pausedAt は記録と同じ）・a2: 人が再開・a3: 人が止め直した
  f.byId.get('a1').status = 'idle';
  Object.assign(f.byId.get('a2'), { status: 'idle', pausedAt: null });
  f.byId.get('a3').pausedAt = '2026-11-18T01:00:00.000Z';
  const r = await handleTick(f.deps, 'c1', { lang: 'ja' });
  assert.deepEqual(r.body.limits.repaused, ['a1']); assert.equal(f.byId.get('a1').status, 'paused');
  assert.deepEqual(f.pauses.filter(p => p.resumedAt).map(p => [p.agentId, p.closeReason]), [['a2', 'close_resumed'], ['a3', 'close_repaused']]);
  // 期限（2026-11-19T09:00Z）を過ぎた: 自動で戻し、課題へのつながりつきで知らせる。人が止め直した a3 は戻さない
  f.setNow(Date.parse('2026-11-19T09:05:00Z'));
  const r2 = await handleTick(f.deps, 'c1', { lang: 'ja' });
  assert.deepEqual(r2.body.limits.resumed.map(x => x.agentId), ['a1']);
  assert.deepEqual(f.calls.resume, ['a1']); assert.equal(f.byId.get('a3').status, 'paused');
  const resumed = [...f.notices.values()].find(n => n.kind === 'agent_resumed_limit');
  assert.match(resumed.title, /^AI の上限から再開しました: N-a1/); assert.match(resumed.body, /TES-1 Write post/);
  assert.equal(open(f).length, 0);
  assert.ok(!kindsOf(f).includes('agent_paused_limit'), '戻したら止めた知らせは消える');
});

test('自動で戻さない: 追加料金で止めた記録・ChatGPT の % で窓がまだ止める % 以上・使用率を読めない時', async () => {
  const f = fakeDeps({ agents: [agent('o1'), agent('o2')], now: T0 });
  const q = (pct, resetsAt = '2026-11-18T00:00:00Z', valueLabel = '$250.80 remaining') => ({ provider: 'openai', ok: true, source: 'codex-wham', windows: [{ label: 'Weekly limit', usedPercent: pct, resetsAt }, { label: 'Credits', usedPercent: null, valueLabel }] });
  await handleTick(f.deps, 'c1', { contractGroups: GROUPS, quota: q(96) });
  assert.deepEqual(open(f).map(p => [p.agentId, p.reason, p.windowKind, p.untilAt]), [['o1', 'pct', 'week', '2026-11-18T00:00:00.000Z'], ['o2', 'pct', 'week', '2026-11-18T00:00:00.000Z']]);
  // resetsAt を過ぎたが、新しい窓でもまだ 96%（止める % 以上）なら戻さない
  f.setNow(Date.parse('2026-11-18T00:05:00Z'));
  await handleTick(f.deps, 'c1', { quota: q(96, '2026-11-25T00:00:00Z') });
  assert.deepEqual(f.calls.resume, []);
  // 読めない回も戻さない
  await handleTick(f.deps, 'c1', { quota: { provider: 'openai', ok: false, windows: [] } });
  assert.deepEqual(f.calls.resume, []);
  // 止める % 未満になったら戻す
  await handleTick(f.deps, 'c1', { quota: q(10, '2026-11-25T00:00:00Z') });
  assert.deepEqual(f.calls.resume, ['o1', 'o2']);
  // 追加料金で止めた記録は期限が無く、自動では戻さない
  const g = fakeDeps({ agents: [agent('o1')], now: T0 });
  await handleTick(g.deps, 'c1', { contractGroups: GROUPS, quota: q(10) });
  await handleTick(g.deps, 'c1', { quota: q(10, '2026-11-18T00:00:00Z', '$249.10 remaining') });
  assert.deepEqual(open(g).map(p => p.reason), ['credits']);
  g.setNow(Date.parse('2026-12-30T00:00:00Z'));
  await handleTick(g.deps, 'c1', { quota: q(10, '2027-01-01T00:00:00Z', '$249.10 remaining') });
  assert.deepEqual(g.calls.resume, []);
});

test('flag OFF: 新しく止めない・止め直さない・自動で戻さない・新しい知らせを出さない。人の再開と止め直しでは記録を閉じる', async () => {
  const f = fakeDeps({ agents: [agent('a1'), agent('a2'), agent('o1')], state: cfgState({ contractGroups: GROUPS }) });
  await handleRunFailed(f.deps, failedRow());
  f.byId.get('a1').status = 'idle'; // 競り合いの形
  Object.assign(f.byId.get('a2'), { status: 'idle', pausedAt: null }); // 人が再開
  f.setNow(Date.parse('2026-11-20T00:00:00Z'));
  const off = { aiLimits: { guard: false }, quota: { provider: 'openai', ok: true, source: 'w', windows: [{ label: 'Weekly limit', usedPercent: 99, resetsAt: '2026-11-25T00:00:00Z' }] }, quotaRuns: [{ runId: 'r7', agentId: 'o1', status: 'failed', errorCode: 'provider_quota' }] };
  const r = await handleTick(f.deps, 'c1', off);
  assert.equal(r.body.limits.guard, false);
  assert.deepEqual(r.body.limits.repaused, []); assert.deepEqual(r.body.limits.paused, []); assert.deepEqual(f.calls.resume, []);
  assert.deepEqual(f.pauses.filter(p => p.resumedAt).map(p => [p.agentId, p.closeReason]), [['a2', 'close_resumed']]);
  assert.ok(!kindsOf(f).includes('ai_limit_near'), '新しい「近い」は出さない');
  // OFF の値は plugin.state に写り、event の経路も止めない
  assert.equal(f.state.get(JSON.stringify(LIMCFG('c1'))).aiLimits.guard, false);
  assert.equal((await handleRunFailed(f.deps, eventRow({ eventType: 'agent.run.failed', companyId: 'c1', entityId: 'run2', payload: { agentId: 'o1', errorCode: 'provider_quota' } }))).guard, false);
  // 止めている担当の知らせは OFF でも出し続ける（a1 は止めたまま）
  assert.ok(kindsOf(f).includes('agent_paused_limit'));
});

test('% で止める・近い（G2・G3）: ChatGPT は週 96% で止め 81% は知らせだけ・追加料金の扱いが stop なら 5 時間は止めない・Claude も同じ・resetsAt を過ぎた古い値では止めない', async () => {
  const f = fakeDeps({ agents: [agent('o1'), agent('a1'), agent('a2')], now: T0 });
  await handleTick(f.deps, 'c1', { lang: 'en', contractGroups: GROUPS, aiLimits: { spend: 'stop' }, quota: { provider: 'openai', ok: true, source: 'w', windows: [{ label: '5h limit', usedPercent: 99, resetsAt: '2026-11-18T02:00:00Z' }, { label: 'Weekly limit', usedPercent: 81, resetsAt: '2026-11-20T00:00:00Z' }, { label: 'Credits', valueLabel: '$5.00 remaining' }] } });
  assert.deepEqual(open(f), [], '5 時間の 99% と週の 81% では止めない');
  const near = [...f.notices.values()].filter(n => n.kind === 'ai_limit_near').map(n => n.title).sort();
  assert.deepEqual(near, ['Close to the AI usage limit: ChatGPT 5-hour 99%', 'Close to the AI usage limit: ChatGPT weekly 81%']);
  // 画面の値（/settings の limits）に ChatGPT の直近の使用率と読んだ時刻（第 4 段の「AI の契約」の欄）
  const v1 = (await handleRoute(f.deps, { routeKey: 'settings', companyId: 'c1' })).body.limits.openai;
  assert.deepEqual([v1.observedAt, v1.unreadable, v1.windows.map(w => [w.kind, w.usedPercent])], [new Date(T0).toISOString(), false, [['h5', 99], ['week', 81]]]);
  // Claude の週 96%: 同じ token の組を止め、期限は resetsAt
  const cl = u => ({ observedAt: '2026-11-17T22:00:00Z', runId: 'cr1', contract: 'anthropic:ref-1', status: 'allowed', rateLimitType: 'seven_day', overageStatus: 'rejected', unifiedWindows: { seven_day: { utilization: u, resetsAt: RESET_M4, status: 'allowed' } } });
  await handleTick(f.deps, 'c1', { claudeLimits: cl(0.96) });
  assert.deepEqual(open(f).map(p => [p.agentId, p.reason, p.untilAt]), [['a1', 'pct', '2026-11-19T09:00:00.000Z'], ['a2', 'pct', '2026-11-19T09:00:00.000Z']]);
  assert.ok([...f.notices.values()].some(n => n.kind === 'ai_limit_near' && /Claude weekly 96%/.test(n.title)));
  assert.deepEqual((await handleRoute(f.deps, { routeKey: 'settings', companyId: 'c1' })).body.limits.openai, v1, 'ChatGPT の値が来なかった回は前の値を残す');
  // ChatGPT の値が来なかった回は、出ている ChatGPT の「近い」を残す
  assert.equal([...f.notices.values()].filter(n => n.kind === 'ai_limit_near' && n.originId.startsWith('openai:')).length, 2);
  // resetsAt を過ぎて自動で戻った後、最後に読めた古い値（同じ claudeLimits）では止め直さない
  f.setNow(Date.parse('2026-11-19T09:10:00Z'));
  await handleTick(f.deps, 'c1', { claudeLimits: cl(0.96) });
  assert.deepEqual(f.calls.resume.sort(), ['a1', 'a2']);
  assert.equal(open(f).length, 0);
  assert.deepEqual(liveWindows([{ resetsAt: '2026-11-19T09:00:00Z' }, { resetsAt: null }], Date.parse('2026-11-19T09:10:00Z')).length, 1);
});

test('追加料金（G9a・G9b）: Credits が同じ source で減ったら知らせて止める・source の入れ替わりでは止めない・Claude の isUsingOverage で知らせて止める', async () => {
  // 起動係は、codex の run を取り消した後の回にだけ、その id を載せる（notify が読み終えるまで）
  const q = (source, valueLabel, ids = []) => ({ provider: 'openai', ok: true, source, windows: [{ label: 'Weekly limit', usedPercent: 10, resetsAt: '2026-11-25T00:00:00Z' }, { label: 'Credits', valueLabel }], cancelledRunIds: ids });
  const f = fakeDeps({ agents: [agent('o1'), agent('o2')] });
  await handleTick(f.deps, 'c1', { lang: 'ja', contractGroups: GROUPS, quota: q('codex-wham', '$250.80 remaining') });
  await handleTick(f.deps, 'c1', { lang: 'ja', quota: q('codex-rpc', '$25080.00 remaining') });
  assert.deepEqual(open(f), [], 'wham → RPC の入れ替わりでは比べない');
  await handleTick(f.deps, 'c1', { lang: 'ja', quota: q('codex-rpc', '$25079.00 remaining', ['run-x']) });
  assert.deepEqual(open(f).map(p => [p.agentId, p.reason]), [['o1', 'credits'], ['o2', 'credits']]);
  const n = [...f.notices.values()].find(x => x.kind === 'ai_credits_spent');
  assert.equal(n.title, '追加料金を使い始めました ($25080.00 → $25079.00)'); assert.match(n.body, /run-x/);
  // 読んでも、止めている間は消えない
  n.readAt = 'now';
  await handleTick(f.deps, 'c1', { lang: 'ja', quota: q('codex-rpc', '$25079.00 remaining') });
  assert.ok(kindsOf(f).includes('ai_credits_spent'));
  // 減りを見た回より後の回に、起動係の取り消しが届いた: 同じ知らせに足して出し直す（2026-11-25 arm64 の e2e の 12・Claude の側と同じ形）
  const lc = fakeDeps({ agents: [agent('o1'), agent('o2')] });
  await handleTick(lc.deps, 'c1', { lang: 'ja', contractGroups: GROUPS, quota: q('codex-rpc', '$25080.00 remaining') });
  await handleTick(lc.deps, 'c1', { lang: 'ja', quota: q('codex-rpc', '$25079.00 remaining') });
  assert.equal([...lc.notices.values()].find(x => x.kind === 'ai_credits_spent').body, null, '減った回はまだ取り消していない');
  await handleTick(lc.deps, 'c1', { lang: 'ja', quota: q('codex-rpc', '$25079.00 remaining', ['run-late']) });
  const lcs = [...lc.notices.values()].filter(x => x.kind === 'ai_credits_spent' && !x.dismissedAt && !x.closedAt);
  assert.ok(lcs.some(x => /run-late/.test(x.body || '')), '後の回の取り消しが知らせに載る');
  assert.equal(lcs.filter(x => /run-late/.test(x.body || '')).length, 1);
  // 同じ id がまた届いても、もう一度出し直さない
  const before = lc.notices.size;
  await handleTick(lc.deps, 'c1', { lang: 'ja', quota: q('codex-rpc', '$25079.00 remaining', ['run-late']) });
  assert.equal(lc.notices.size, before, '同じ id では出し直さない');
  // notify が減りを見ないうちに取り消しが届いた（基準のずれ）: 今の残りで知らせを作り、取り消した run を載せて止める
  const nc = fakeDeps({ agents: [agent('o1'), agent('o2')] });
  await handleTick(nc.deps, 'c1', { lang: 'ja', contractGroups: GROUPS, quota: q('codex-rpc', '$25079.00 remaining') });
  await handleTick(nc.deps, 'c1', { lang: 'ja', quota: q('codex-rpc', '$25079.00 remaining', ['run-y']) });
  const ncn = [...nc.notices.values()].find(x => x.kind === 'ai_credits_spent');
  assert.ok(ncn && /run-y/.test(ncn.body || ''), '減りを見ていなくても、取り消した run を知らせる');
  assert.deepEqual(open(nc).map(p => [p.agentId, p.reason]), [['o1', 'credits'], ['o2', 'credits']]);
  // 片付けた知らせの id が、起動係の返事の取りこぼしで載せ直されても、新しい取り消しとして止め直さない（独立レビュー 31 回目 P3-2）
  const cl2 = fakeDeps({ agents: [agent('o1'), agent('o2')] });
  await handleTick(cl2.deps, 'c1', { lang: 'ja', contractGroups: GROUPS, quota: q('codex-rpc', '$25080.00 remaining') });
  await handleTick(cl2.deps, 'c1', { lang: 'ja', quota: q('codex-rpc', '$25079.00 remaining', ['run-z']) });
  for (const p of open(cl2)) p.resumedAt = 'now'; // 持ち主が担当を戻した
  for (const x of cl2.notices.values()) if (x.kind === 'ai_credits_spent') x.readAt = 'now';
  await handleTick(cl2.deps, 'c1', { lang: 'ja', quota: q('codex-rpc', '$25079.00 remaining') }); // 片付く
  const nBefore = [...cl2.notices.values()].filter(x => x.kind === 'ai_credits_spent').length;
  await handleTick(cl2.deps, 'c1', { lang: 'ja', quota: q('codex-rpc', '$25079.00 remaining', ['run-z']) });
  assert.equal([...cl2.notices.values()].filter(x => x.kind === 'ai_credits_spent').length, nBefore, '片付けた id では新しい知らせを作らない');
  assert.deepEqual(open(cl2), [], '片付けた id では止め直さない');
  // Claude
  const g = fakeDeps({ agents: [agent('a1'), agent('a2'), agent('b1')] });
  await handleTick(g.deps, 'c1', { contractGroups: GROUPS, claudeLimits: { observedAt: '2026-11-17T22:00:00Z', runId: 'cr9', contract: 'anthropic:ref-1', status: 'allowed', isUsingOverage: true, overageStatus: 'allowed', rateLimitType: 'seven_day', unifiedWindows: { seven_day: { utilization: 0.5, resetsAt: RESET_M4, status: 'allowed' } }, cancelledRunIds: ['cr9'] } });
  assert.deepEqual(open(g).map(p => [p.agentId, p.reason]), [['a1', 'overage'], ['a2', 'overage']]);
  assert.ok(kindsOf(g).includes('ai_overage_started'));
  // 取り消しと止めるの間に同じ担当の次の run が始まり、次の回でそれも取り消した: 知らせは新しい run に替わるが、前に取り消した run も残す
  await handleTick(g.deps, 'c1', { contractGroups: GROUPS, claudeLimits: { observedAt: '2026-11-17T22:01:00Z', runId: 'cr10', contract: 'anthropic:ref-1', status: 'allowed', isUsingOverage: true, overageStatus: 'allowed', rateLimitType: 'seven_day', unifiedWindows: { seven_day: { utilization: 0.5, resetsAt: RESET_M4, status: 'allowed' } }, cancelledRunIds: ['cr10'] } });
  const ovs = [...g.notices.values()].filter(x => x.kind === 'ai_overage_started');
  assert.equal(ovs.length, 1, '追加料金の知らせは 1 件');
  assert.equal(ovs[0].originId, 'cr10'); assert.match(ovs[0].body, /cr9/); assert.match(ovs[0].body, /cr10/);
  // 同じ run の追加料金の続きで、後の回に取り消しが起きた（前の回は取り消していない）: 同じ知らせに取り消した run を足す（独立レビュー 19 回目 P3-1）
  const k = fakeDeps({ agents: [agent('a1'), agent('a2'), agent('b1')] });
  const ovTick = ids => handleTick(k.deps, 'c1', { contractGroups: GROUPS, claudeLimits: { observedAt: '2026-11-17T22:00:00Z', runId: 'cr20', contract: 'anthropic:ref-1', status: 'allowed', isUsingOverage: true, overageStatus: 'allowed', rateLimitType: 'seven_day', unifiedWindows: { seven_day: { utilization: 0.5, resetsAt: RESET_M4, status: 'allowed' } }, cancelledRunIds: ids } });
  await ovTick([]);
  assert.equal([...k.notices.values()].find(x => x.kind === 'ai_overage_started').body, null);
  await ovTick(['cr20']);
  const kov = [...k.notices.values()].filter(x => x.kind === 'ai_overage_started');
  assert.equal(kov.length, 1); assert.equal(kov[0].originId, 'cr20'); assert.match(kov[0].body, /cr20/);
  assert.deepEqual(open(k).map(p => [p.agentId, p.reason]), [['a1', 'overage'], ['a2', 'overage']], '止めは重ならない');
  // allow の間に始まった追加料金の run を、never に替えた後の回で取り消した: その回に同じ契約の担当を止める（独立レビュー 20 回目 P3-C）
  const m = fakeDeps({ agents: [agent('a1'), agent('a2'), agent('b1')] });
  const mTick = (ids, spend) => handleTick(m.deps, 'c1', { contractGroups: GROUPS, aiLimits: { spend }, claudeLimits: { observedAt: '2026-11-17T22:00:00Z', runId: 'cr30', contract: 'anthropic:ref-1', status: 'allowed', isUsingOverage: true, overageStatus: 'allowed', rateLimitType: 'seven_day', unifiedWindows: { seven_day: { utilization: 0.5, resetsAt: RESET_M4, status: 'allowed' } }, cancelledRunIds: ids } });
  await mTick([], 'allow'); assert.deepEqual(open(m), [], 'allow の間は止めない');
  await mTick(['cr30'], 'never'); assert.deepEqual(open(m).map(p => p.agentId), ['a1', 'a2']);
  // 取り消した id は 50 件まで知らせに載る（起動係の上限とそろえる・P3-B）
  const many = Array.from({ length: 30 }, (_, i) => `x${i}`);
  await mTick(many, 'never');
  assert.equal(String([...m.notices.values()].find(x => x.kind === 'ai_overage_started').body).split(', ').length, 31);
  // 上限の後は追加料金で続く設定（窓は allowed）: 止めず、画面の値に出す
  const h = fakeDeps({ agents: [agent('a1')] });
  await handleTick(h.deps, 'c1', { contractGroups: GROUPS, claudeLimits: { observedAt: '2026-11-17T22:00:00Z', runId: 'cr3', contract: 'anthropic:ref-1', status: 'allowed', overageStatus: 'allowed', rateLimitType: 'seven_day', unifiedWindows: { seven_day: { utilization: 0.2, resetsAt: RESET_M4, status: 'allowed' } } } });
  assert.deepEqual(open(h), []);
  assert.equal((await handleRoute(h.deps, { routeKey: 'settings', companyId: 'c1' })).body.limits.overageEnabled, true);
});

test('追加料金の扱い（Q4）: 既定（never）は 5 時間の窓の 95% で止める・stop は止めない・allow は追加料金で知らせるだけで止めない', async () => {
  const q5 = (pct, valueLabel = '$250.80 remaining') => ({ provider: 'openai', ok: true, source: 'w', windows: [{ label: '5h limit', usedPercent: pct, resetsAt: '2026-11-18T02:00:00Z' }, { label: 'Weekly limit', usedPercent: 10, resetsAt: '2026-11-25T00:00:00Z' }, { label: 'Credits', valueLabel }] });
  // 設定の値がまだ無い（最初の /tick の前・値が無い回）は既定の never: 94% は知らせだけ、95% で同じ契約をまとめて止める
  const f = fakeDeps({ agents: [agent('o1'), agent('o2')], now: T0 });
  await handleTick(f.deps, 'c1', { lang: 'en', contractGroups: GROUPS, quota: q5(94) });
  assert.deepEqual(open(f), []);
  await handleTick(f.deps, 'c1', { lang: 'en', quota: q5(95) });
  assert.deepEqual(open(f).map(p => [p.agentId, p.reason, p.windowKind]), [['o1', 'pct', 'h5'], ['o2', 'pct', 'h5']]);
  // stop: 5 時間の 99% でも止めない（知らせだけ）
  const g = fakeDeps({ agents: [agent('o1'), agent('o2')], now: T0 });
  await handleTick(g.deps, 'c1', { lang: 'en', contractGroups: GROUPS, aiLimits: { spend: 'stop' }, quota: q5(99) });
  assert.deepEqual(open(g), []); assert.ok(kindsOf(g).includes('ai_limit_near'));
  // stop: Credits が減ったら止める
  await handleTick(g.deps, 'c1', { lang: 'en', quota: q5(10, '$249.00 remaining') });
  assert.deepEqual(open(g).map(p => [p.agentId, p.reason]), [['o1', 'credits'], ['o2', 'credits']]);
  // allow: 5 時間の 99% でも Credits が減っても止めない。追加料金の知らせは出す
  const h = fakeDeps({ agents: [agent('o1'), agent('o2'), agent('a1')], now: T0 });
  await handleTick(h.deps, 'c1', { lang: 'en', contractGroups: GROUPS, aiLimits: { spend: 'allow' }, quota: q5(99) });
  await handleTick(h.deps, 'c1', { lang: 'en', quota: q5(99, '$249.00 remaining'), claudeLimits: { observedAt: '2026-11-17T22:00:00Z', runId: 'cr9', contract: 'anthropic:ref-1', status: 'allowed', isUsingOverage: true, overageStatus: 'allowed', rateLimitType: 'seven_day', unifiedWindows: { seven_day: { utilization: 0.5, resetsAt: RESET_M4, status: 'allowed' } }, cancelledRunIds: [] } });
  assert.deepEqual(open(h), []); assert.deepEqual(h.calls.pause, []);
  assert.ok(kindsOf(h).includes('ai_credits_spent')); assert.ok(kindsOf(h).includes('ai_overage_started'));
  // 設定を allow から never に替えた次の回は、同じ値で止める（設定が振る舞いを替える）
  await handleTick(h.deps, 'c1', { lang: 'en', aiLimits: { spend: 'never' }, quota: q5(99, '$249.00 remaining') });
  assert.deepEqual(open(h).map(p => [p.agentId, p.reason, p.windowKind]), [['o1', 'pct', 'h5'], ['o2', 'pct', 'h5']]);
});
test('追加料金の扱い（Q4）: never で 5 時間の窓の 95% で止めた担当は、窓のリセット後も実効の 95% 以上なら止めたまま・下がったら自動で戻す（起動係が毎回の /tick で値を送る形）', async () => {
  const q5 = (pct, resetsAt) => ({ provider: 'openai', ok: true, source: 'w', windows: [{ label: '5h limit', usedPercent: pct, resetsAt }, { label: 'Weekly limit', usedPercent: 10, resetsAt: '2026-11-25T00:00:00Z' }, { label: 'Credits', valueLabel: '$250.80 remaining' }] });
  const f = fakeDeps({ agents: [agent('o1'), agent('o2')], now: T0 });
  await handleTick(f.deps, 'c1', { lang: 'en', contractGroups: GROUPS, aiLimits: { spend: 'never' }, quota: q5(95, '2026-11-18T02:00:00Z') });
  assert.deepEqual(open(f).map(p => [p.agentId, p.reason, p.windowKind, p.untilAt]), [['o1', 'pct', 'h5', '2026-11-18T02:00:00.000Z'], ['o2', 'pct', 'h5', '2026-11-18T02:00:00.000Z']]);
  // 期限（窓の resetsAt）を過ぎたが、新しい窓でも 96%: 設定の 5 時間の「止める %」は空でも、never の実効は 95% なので戻さない
  f.setNow(Date.parse('2026-11-18T02:05:00Z'));
  await handleTick(f.deps, 'c1', { lang: 'en', aiLimits: { spend: 'never' }, quota: q5(96, '2026-11-18T07:00:00Z') });
  assert.deepEqual(f.calls.resume, []); assert.equal(open(f).length, 2);
  // 50% に下がったら自動で戻す
  await handleTick(f.deps, 'c1', { lang: 'en', aiLimits: { spend: 'never' }, quota: q5(50, '2026-11-18T07:00:00Z') });
  assert.deepEqual(f.calls.resume, ['o1', 'o2']); assert.equal(open(f).length, 0);
});

test('追加料金の扱い（Q4）: 2 回目以降の /tick に設定の値が無い回も、既定の never に倒れて止めたまま・下がったら自動で戻す', async () => {
  const q5 = (pct, resetsAt) => ({ provider: 'openai', ok: true, source: 'w', windows: [{ label: '5h limit', usedPercent: pct, resetsAt }, { label: 'Weekly limit', usedPercent: 10, resetsAt: '2026-11-25T00:00:00Z' }, { label: 'Credits', valueLabel: '$250.80 remaining' }] });
  const f = fakeDeps({ agents: [agent('o1'), agent('o2')], now: T0 });
  await handleTick(f.deps, 'c1', { lang: 'en', contractGroups: GROUPS, aiLimits: { spend: 'never' }, quota: q5(95, '2026-11-18T02:00:00Z') });
  assert.deepEqual(open(f).map(p => [p.agentId, p.reason, p.windowKind, p.untilAt]), [['o1', 'pct', 'h5', '2026-11-18T02:00:00.000Z'], ['o2', 'pct', 'h5', '2026-11-18T02:00:00.000Z']]);
  // 期限（窓の resetsAt）を過ぎたが、新しい窓でも 96%: 設定の 5 時間の「止める %」は空でも、never の実効は 95% なので戻さない
  f.setNow(Date.parse('2026-11-18T02:05:00Z'));
  await handleTick(f.deps, 'c1', { lang: 'en', quota: q5(96, '2026-11-18T07:00:00Z') });
  assert.deepEqual(f.calls.resume, []); assert.equal(open(f).length, 2);
  // 50% に下がったら自動で戻す
  await handleTick(f.deps, 'c1', { lang: 'en', quota: q5(50, '2026-11-18T07:00:00Z') });
  assert.deepEqual(f.calls.resume, ['o1', 'o2']); assert.equal(open(f).length, 0);
});

test('reconcile: 止めている間は読んでも消えない・再開で消える・paused の担当の止まった課題は止めた知らせの本文に移る', async () => {
  const old = new Date(T0 - 3 * 3600000).toISOString();
  const issues = [{ id: 'i1', identifier: 'TES-1', title: 'Write post', status: 'in_progress', assigneeAgentId: 'a1', executionRunId: null, updatedAt: old }];
  const f = fakeDeps({ agents: [agent('a1')], issues, state: cfgState({ contractGroups: GROUPS }) });
  await handleTick(f.deps, 'c1', { lang: 'ja' });
  assert.ok(kindsOf(f).includes('stuck'));
  await handleRunFailed(f.deps, failedRow());
  await handleTick(f.deps, 'c1', { lang: 'ja' });
  assert.ok(!kindsOf(f).includes('stuck'), 'paused の担当の課題は止まった課題から外れる');
  const p = [...f.notices.values()].find(n => n.kind === 'agent_paused_limit');
  assert.equal(p.title, 'AI の上限で止めています: N-a1'); assert.equal(p.originId, 'a1');
  assert.match(p.body, /^契約の上限に当たりました · 2026-11-19 09:00 UTC まで\n- TES-1 Write post$/);
  p.readAt = 'now';
  await handleTick(f.deps, 'c1', { lang: 'ja' });
  assert.ok(kindsOf(f).includes('agent_paused_limit'), '読んでも消えない');
  // 画面から再開 → /limit/resume で記録を閉じ、知らせが消える
  assert.equal((await handleRoute(f.deps, { routeKey: 'limit-resume', companyId: 'c1', body: { agentIds: ['a1'] } })).body.stillPaused[0], 'a1', '本体の resume の前は閉じない');
  await f.deps.agents.resume('a1');
  const r = await handleRoute(f.deps, { routeKey: 'limit-resume', companyId: 'c1', body: { agentIds: ['a1', '../x'] } });
  assert.deepEqual(r.body.closed, ['a1']);
  assert.ok(!kindsOf(f).includes('agent_paused_limit'));
  assert.equal(f.pauses[0].closeReason, 'manual_resume');
  assert.equal((await handleRoute(f.deps, { routeKey: 'limit-resume', companyId: 'c1', body: {} })).status, 400);
});

test('まとめ: 既読の agent_paused_limit も毎回入り、題に止めている担当の数が出る（英日）', async () => {
  for (const [lang, head, line] of [['ja', /^朝のまとめ: 止めている担当 1/, /- AI の上限で止めています: N-a1/], ['en', /^Morning summary: 1 paused agents/, /- Paused at the AI usage limit: N-a1/]]) {
    const f = fakeDeps({ agents: [agent('a1')], state: cfgState({ contractGroups: GROUPS }), now: Date.parse('2026-11-17T23:30:00Z') });
    await handleRunFailed(f.deps, failedRow());
    await handleTick(f.deps, 'c1', { lang, timeZone: 'Asia/Tokyo' }); // 日本時間 8:30 の回
    for (const n of f.notices.values()) n.readAt = 'now';
    f.state.delete(JSON.stringify({ scopeKind: 'company', scopeId: 'c1', stateKey: 'digest' }));
    await handleTick(f.deps, 'c1', { lang, timeZone: 'Asia/Tokyo' });
    const d = [...f.notices.values()].filter(n => n.kind === 'digest').at(-1);
    assert.match(d.title, head); assert.match(d.body, line);
  }
});

test('予算（G7・G7b）: 起動係の hard の incident で止めた知らせ・event だけで知った incident も出す・予算の無い API キーの担当で budget_unset', async () => {
  const f = fakeDeps({ agents: [agent('k1')], events: [{ kind: 'budget_opened', entityId: 'inc-e' }] });
  await handleTick(f.deps, 'c1', { lang: 'en' });
  assert.ok([...f.notices.values()].some(n => n.kind === 'agent_paused_limit' && n.key === noticeKey('agent_paused_limit', 'budget:inc-e')));
  await handleTick(f.deps, 'c1', { lang: 'en', budgetIncidents: [{ id: 'inc1', scopeType: 'agent', scopeId: 'k1', scopeName: 'Writer', thresholdType: 'hard', amountLimit: 5000, amountObserved: 5100 }, { id: 'inc2', scopeType: 'agent', scopeId: 'k1', thresholdType: 'soft' }], budgetGaps: [{ agentId: 'k1', kind: 'anthropic_api_key' }] });
  const paused = [...f.notices.values()].filter(n => n.kind === 'agent_paused_limit');
  assert.deepEqual(paused.map(n => n.title), ['Stopped by the budget: Writer ($51.00 / $50.00)'], '一覧が来たら一覧が正・soft は出さない');
  assert.equal([...f.notices.values()].find(n => n.kind === 'budget_unset').title, 'No budget set for API key agents: 1');
  // 一覧の来ない回は残す・空の一覧で消える
  await handleTick(f.deps, 'c1', { lang: 'en' });
  assert.ok(kindsOf(f).includes('budget_unset'));
  await handleTick(f.deps, 'c1', { lang: 'en', budgetGaps: [], budgetIncidents: [] });
  assert.ok(!kindsOf(f).includes('budget_unset')); assert.ok(!kindsOf(f).includes('agent_paused_limit'));
});

test('読めない（G2a・7 の 2）: ChatGPT の ok:false・Credits の窓が無い・Claude の担当がいて読めない・run の一覧を読み切れない。読めたら消え、run が無いだけでは出ない', async () => {
  const f = fakeDeps({ agents: [agent('a1'), agent('o1')] });
  await handleTick(f.deps, 'c1', { lang: 'en', contractGroups: GROUPS, quota: { provider: 'openai', ok: false, windows: [] }, claudeLimits: { observedAt: '2026-11-17T22:00:00Z', runId: 'x', readError: 'truncated' }, quotaRuns: { runs: [], complete: false } });
  const un = () => [...f.notices.values()].filter(n => n.kind === 'ai_quota_unreadable').map(n => n.originId).sort();
  assert.deepEqual(un(), ['anthropic', 'openai', 'runs']);
  await handleTick(f.deps, 'c1', { lang: 'en', quota: { provider: 'openai', ok: true, source: 'w', windows: [{ label: 'Weekly limit', usedPercent: 1, resetsAt: '2026-11-25T00:00:00Z' }] }, claudeLimits: { observedAt: '2026-11-17T22:00:00Z', runId: 'y', status: 'allowed', rateLimitType: 'seven_day', unifiedWindows: { seven_day: { utilization: 0.1, resetsAt: RESET_M4, status: 'allowed' } } }, quotaRuns: { runs: [], complete: true } });
  assert.deepEqual(un(), ['openai_credits']);
  // Claude の値が来ない回（run が無い）は「読めない」にしない
  const g = fakeDeps({ agents: [agent('a1')] });
  await handleTick(g.deps, 'c1', { contractGroups: GROUPS });
  assert.ok(!kindsOf(g).includes('ai_quota_unreadable'));
});

test('部品: providerGroup は組が無い時に adapter で選ぶ・keepOnly は既にある物だけ・pauseNotice は期限が無いと人の再開まで', () => {
  assert.deepEqual(providerGroup(GROUPS, { provider: 'anthropic', contract: 'anthropic:ref-2' }), { contract: 'anthropic:ref-2', agentIds: ['b1'] });
  assert.deepEqual(providerGroup([], { provider: 'openai', agents: [agent('o1'), agent('a1')] }), { contract: 'openai', agentIds: ['o1'] });
  assert.deepEqual(keepOnly([{ key: 'a' }, { key: 'b' }], [{ key: 'b' }]), [{ key: 'b' }]);
  assert.match(pauseNotice({ id: '1', agentId: 'a1', reason: 'overage', untilAt: null }, { lang: 'en', agentName: 'W' }).body, /^Started using extra usage · resume by hand$/);
});

test('表への読み書き: limit_pauses は schema で修飾し、開いた記録・きっかけ・閉じる・期限を 1 本ずつの SQL で書く', async () => {
  const calls = [];
  const db = { namespace: 'plugin_notify_x', execute: async (sql, params) => { calls.push({ sql, params }); }, query: async (sql, params) => { calls.push({ sql, params }); return [{ id: '1', agentId: 'a1', untilAt: new Date('2026-11-19T09:00:00Z'), pausedAt: new Date(T0), agentPausedAt: new Date('2026-11-17T22:21:00.123Z') }]; } };
  const st = dbStore(db);
  const rows = await st.openPauses('c1');
  assert.match(calls[0].sql, /FROM plugin_notify_x\.limit_pauses WHERE company_id = \$1 AND resumed_at IS NULL/);
  assert.equal(rows[0].agentPausedAt, '2026-11-17T22:21:00.123Z', 'Date は ms を落とさず ISO にする');
  await st.addPause('c1', { agentId: 'a1', reason: 'pct', sourceRunId: 'pct:k' });
  assert.match(calls[1].sql, /INSERT INTO plugin_notify_x\.limit_pauses .* ON CONFLICT \(company_id, agent_id\) WHERE resumed_at IS NULL DO UPDATE SET agent_paused_at = EXCLUDED\.agent_paused_at$/);
  assert.equal(calls[1].params.length, 10); assert.ok(calls[1].params.every(v => v === null || typeof v === 'string'));
  await st.closePause('c1', '1', 'manual_resume');
  assert.match(calls[2].sql, /SET resumed_at = now\(\), close_reason = \$3 .* AND resumed_at IS NULL/);
  await st.pausesBySource('c1', 'run1');
  assert.match(calls[3].sql, /source_run_id = \$2/);
});

// ---- 実装レビュー r1 の指摘の試験 ----

test('H1 並んだ 2 本: 同じ契約の上限の失敗が 2 本同時に届いても、止めるのは 1 回ずつ・記録の pausedAt は本体と同じで、次の見回りで記録を閉じない', async () => {
  const f = fakeDeps({ agents: [agent('a1'), agent('a2'), agent('a3')], state: cfgState({ contractGroups: GROUPS }) });
  f.deps.conflictUpdates = false; // 表の衝突の上書きが無くても、鍵だけで成り立つことを見る
  const rowB = eventRow({ eventType: 'agent.run.failed', companyId: 'c1', entityId: 'run2', occurredAt: '2026-11-17T22:21:01Z', payload: { agentId: 'a2', errorCode: 'provider_quota', error: M3_TEXT } });
  const [ra, rb] = await Promise.all([handleRunFailed(f.deps, failedRow()), handleRunFailed(f.deps, rowB)]);
  assert.deepEqual([ra.paused, rb.paused], [['a1', 'a2', 'a3'], []], '2 本目は開いた記録を見て止めない');
  assert.equal(f.calls.pause.length, 3);
  for (const p of open(f)) assert.equal(p.agentPausedAt, f.byId.get(p.agentId).pausedAt, p.agentId);
  const r = await handleTick(f.deps, 'c1', {});
  assert.deepEqual(r.body.limits.closed, [], '記録は閉じない（close_repaused にならない）');
  assert.equal(open(f).length, 3);
  assert.ok(kindsOf(f).includes('agent_paused_limit'));
  // event と見回りの補いの経路（同じ runId）が重なった時も同じ
  const g = fakeDeps({ agents: [agent('a1'), agent('a2')], state: cfgState({ contractGroups: GROUPS }) });
  g.deps.conflictUpdates = false;
  await Promise.all([handleTick(g.deps, 'c1', { quotaRuns: { runs: [{ runId: 'run1', agentId: 'a1', status: 'failed', errorCode: 'provider_quota' }], complete: true } }), handleRunFailed(g.deps, failedRow())]);
  assert.equal(g.calls.pause.length, 2);
  const r2 = await handleTick(g.deps, 'c1', {});
  assert.deepEqual(r2.body.limits.closed, []);
  for (const p of open(g)) assert.equal(p.agentPausedAt, g.byId.get(p.agentId).pausedAt, p.agentId);
});

test('H1 表の衝突: 鍵の外で同じ担当を 2 回止めた時は、開いた記録の pausedAt を後の pause の返事にそろえる', async () => {
  const f = fakeDeps({ agents: [agent('a1')], state: cfgState({ contractGroups: [{ contract: 'x', provider: 'anthropic', agentIds: ['a1'] }] }) });
  await f.deps.store.addPause('c1', { agentId: 'a1', reason: 'provider_quota', agentPausedAt: '2026-11-17T22:21:00.001Z', sourceRunId: 'r1' });
  await f.deps.store.addPause('c1', { agentId: 'a1', reason: 'provider_quota', agentPausedAt: '2026-11-17T22:21:00.009Z', sourceRunId: 'r2' });
  assert.deepEqual(open(f).map(p => [p.sourceRunId, p.agentPausedAt]), [['r1', '2026-11-17T22:21:00.009Z']]);
});

test('M1 配線: plugin の setup に偽の ctx を渡し、agent.run.failed の処理が返る前に agents.pause が呼ばれる（上限でない失敗では呼ばない）', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const plugin = (await import('../plugins/notify/src/worker.mjs')).default;
  const handlers = {}, order = [];
  const st = new Map(), a1 = { id: 'a1', name: 'A', status: 'idle', pausedAt: null, adapterType: 'claude_local' };
  const ctx = {
    events: { on: (name, fn) => { handlers[name] = fn; } },
    db: { namespace: 'plugin_notify_x', execute: async () => {}, query: async () => [] },
    state: { get: async k => st.get(JSON.stringify(k)) ?? null, set: async (k, v) => st.set(JSON.stringify(k), v) },
    approvals: { list: async () => [] }, issues: { list: async () => [] }, config: { get: async () => ({}) },
    logger: { warn: () => {} },
    agents: {
      list: async () => [{ ...a1 }],
      get: async () => ({ ...a1 }),
      pause: async () => { order.push('pause'); Object.assign(a1, { status: 'paused', pausedAt: new Date().toISOString() }); return { ...a1 }; },
    },
  };
  await plugin.definition.setup(ctx);
  const fn = handlers['agent.run.failed'];
  assert.equal(typeof fn, 'function');
  await fn({ eventType: 'agent.run.failed', companyId: 'c1', entityId: 'r0', occurredAt: '2026-11-17T22:20:00Z', payload: { agentId: 'a1', errorCode: 'adapter_failed', error: 'npm ERR! boom' } });
  assert.deepEqual(order, [], '上限でない失敗では止めない');
  const p = fn({ eventType: 'agent.run.failed', companyId: 'c1', entityId: 'r1', occurredAt: '2026-11-17T22:21:00Z', payload: { agentId: 'a1', errorCode: 'provider_quota', error: M3_TEXT } }).then(() => order.push('returned'));
  for (let i = 0; i < 50 && !order.includes('pause'); i++) await new Promise(r => queueMicrotask(r));
  assert.deepEqual(order, ['pause'], '処理が返る前に止める（5 秒の読み直しの前）');
  // 5 秒の読み直しの timer が置かれるまで進めてから時計を進める
  for (let i = 0; i < 200 && !order.includes('returned'); i++) { t.mock.timers.tick(5000); await new Promise(r => queueMicrotask(r)); }
  await p;
  assert.deepEqual(order, ['pause', 'returned']);
});

test('M2: 上限の処理が投げても、見回りの後ろの処理（止まった課題・まとめ・片付け）と event の済みは続ける・予算の event は残す', async () => {
  const f = fakeDeps({ agents: [agent('a1')], events: [{ kind: 'run_failed', entityId: 'r1', agentId: 'a1' }, { kind: 'budget_opened', entityId: 'b1' }] });
  let pruned = 0;
  f.deps.store.prune = async () => { pruned++; };
  f.deps.store.openPauses = async () => { throw new Error('relation "limit_pauses" does not exist'); };
  const r = await handleTick(f.deps, 'c1', {});
  assert.equal(r.status, 200);
  assert.match(r.body.limitsError, /limit_pauses/);
  assert.ok(r.body.stuck && r.body.decision, '止まった課題と判断待ちまで進む');
  assert.equal(pruned, 1);
  assert.deepEqual(f.ev.map(e => [e.kind, e.done]), [['run_failed', true], ['budget_opened', false]]);
});

test('M4: ChatGPT の上限の失敗で止めた記録は、retryNotBefore を過ぎても quota-windows の 5 時間と週がどちらも 100% 未満と読めるまで戻さない', async () => {
  const f = fakeDeps({ agents: [agent('o1'), agent('o2')], now: T0 });
  const runs = { runs: [{ runId: 'run9', agentId: 'o1', status: 'failed', errorCode: 'provider_quota', error: 'usage limit reached', retryNotBefore: '2026-11-17T23:24:14Z' }], complete: true };
  await handleTick(f.deps, 'c1', { contractGroups: GROUPS, quotaRuns: runs });
  assert.deepEqual(open(f).map(p => [p.agentId, p.reason, p.untilAt]), [['o1', 'provider_quota', '2026-11-17T23:24:14.000Z'], ['o2', 'provider_quota', '2026-11-17T23:24:14.000Z']]);
  f.setNow(Date.parse('2026-11-17T23:30:00Z'));
  const q = (week, h5 = 10) => ({ provider: 'openai', ok: true, source: 'w', windows: [{ label: 'Weekly limit', usedPercent: week, resetsAt: '2026-11-20T00:00:00Z' }, { label: '5h limit', usedPercent: h5, resetsAt: '2026-11-18T01:00:00Z' }, { label: 'Credits', usedPercent: null, valueLabel: 'N/A' }] });
  await handleTick(f.deps, 'c1', {}); // 値が来ない回
  await handleTick(f.deps, 'c1', { quota: { provider: 'openai', ok: false, windows: [] } }); // 読めない回
  await handleTick(f.deps, 'c1', { quota: q(100) }); // 週がまだ 100%
  await handleTick(f.deps, 'c1', { quota: q(40, 100) }); // 5 時間がまだ 100%
  await handleTick(f.deps, 'c1', { quota: { provider: 'openai', ok: true, source: 'w', windows: [] } }); // 窓が無い
  assert.deepEqual(f.calls.resume, []);
  await handleTick(f.deps, 'c1', { quota: q(40) });
  assert.deepEqual(f.calls.resume, ['o1', 'o2']);
  // 組を知らない記録（event の経路で contract が無い）も adapter で ChatGPT と見分ける
  const g = fakeDeps({ agents: [agent('o1')], now: T0 });
  await handleRunFailed(g.deps, eventRow({ eventType: 'agent.run.failed', companyId: 'c1', entityId: 'r5', occurredAt: '2026-11-17T22:21:00Z', payload: { agentId: 'o1', errorCode: 'provider_quota', error: 'usage limit reached · try again at 11pm (UTC)' } }));
  g.setNow(Date.parse('2026-11-18T00:00:00Z'));
  await handleTick(g.deps, 'c1', { quota: q(100) });
  assert.deepEqual(g.calls.resume, []);
});

test('L1: 止める直前に読み直し、その間に予算や人が止めた担当は止めない（pauseReason を上書きしない）', async () => {
  const f = fakeDeps({ agents: [agent('a1'), agent('a2')], state: cfgState({ contractGroups: GROUPS }) });
  f.deps.onGet = async id => { if (id === 'a2') Object.assign(f.byId.get('a2'), { status: 'paused', pausedAt: '2026-11-17T22:20:59.000Z', pauseReason: 'budget' }); };
  const r = await handleRunFailed(f.deps, failedRow());
  assert.deepEqual([r.paused, r.skipped], [['a1'], ['a2']]);
  assert.equal(f.byId.get('a2').pauseReason, 'budget');
  assert.deepEqual(open(f).map(p => p.agentId), ['a1']);
});

test('L7: event の経路で止めた分は、次の見回りを待たずに画面の値（帯・再開の確かめの pausedAt）に出る', async () => {
  const f = fakeDeps({ agents: [agent('a1'), agent('a2')], state: cfgState({ contractGroups: GROUPS }) });
  await handleRunFailed(f.deps, failedRow());
  const s = await handleRoute(f.deps, { routeKey: 'settings', companyId: 'c1' });
  assert.deepEqual(s.body.limits.pauses.map(p => [p.agentId, p.agentPausedAt]), [['a1', f.byId.get('a1').pausedAt], ['a2', f.byId.get('a2').pausedAt]]);
});

// ---- 実装レビュー r2 の H1-r2: 止める・戻す・閉じるの判断は、鍵の中で読んだ担当の値だけで行う ----
// 見回りが鍵の外で担当の一覧を読んだ後、鍵を取るまでに event の経路が止めた（r2 の再現 1）
test('H1-r2 古い一覧 1: 見回りが一覧を読んだ後に event の経路が止めても、その記録を close_resumed で閉じない', async () => {
  const f = fakeDeps({ agents: [agent('a1'), agent('a2')], state: cfgState({ contractGroups: GROUPS }) });
  f.deps.sleep = async () => {};
  delete f.deps.agents.get; // 鍵の中の一覧の読み直しだけで守ることを見る（1 人ずつの get は別の試験）
  const orig = f.deps.agents.list; let first = true;
  f.deps.agents.list = async q => {
    const snap = await orig(q);
    if (first) { first = false; await handleRunFailed(f.deps, failedRow()); }
    return snap;
  };
  const r = await handleTick(f.deps, 'c1', {});
  assert.deepEqual(f.calls.pause, ['a1', 'a2']);
  assert.deepEqual(r.body.limits.closed, []);
  assert.equal(open(f).length, 2, '担当が paused の間は記録を開いたままにする');
  const s = await handleRoute(f.deps, { routeKey: 'settings', companyId: 'c1' });
  assert.equal(s.body.limits.pauses.length, 2, '帯の値も残る');
  assert.ok(kindsOf(f).includes('agent_paused_limit'));
});

// 見回りが一覧を読んだ後に人が止め直した（r2 の再現 2）
test('H1-r2 古い一覧 2: 見回りが一覧を読んだ後に人が止め直したら、期限を過ぎても戻さず記録を閉じる', async () => {
  const f = fakeDeps({ agents: [agent('a1')], state: cfgState({ contractGroups: GROUPS }) });
  f.deps.sleep = async () => {};
  await handleRunFailed(f.deps, failedRow());
  f.setNow(Date.parse('2026-11-19T10:00:00Z'));
  delete f.deps.agents.get; // 鍵の中の一覧の読み直しだけで守ることを見る
  const orig = f.deps.agents.list; let first = true;
  f.deps.agents.list = async q => {
    const snap = await orig(q);
    if (first) { first = false; Object.assign(f.byId.get('a1'), { pausedAt: '2026-11-19T09:59:59.000Z', pauseReason: 'manual' }); }
    return snap;
  };
  const r = await handleTick(f.deps, 'c1', {});
  assert.deepEqual(f.calls.resume, [], '人の停止を外さない');
  assert.deepEqual(r.body.limits.closed, ['a1']);
  assert.equal(f.pauses[0].closeReason, 'close_repaused');
});

// 鍵の中の一覧を読んだ後、その担当を処理する直前に人が止め直した（1 人ずつの読み直し）
test('H1-r2 直前の読み直し（戻す）: 戻す直前に get で読み直し、人が止め直していたら戻さない', async () => {
  const f = fakeDeps({ agents: [agent('a1')], state: cfgState({ contractGroups: GROUPS }) });
  f.deps.sleep = async () => {};
  await handleRunFailed(f.deps, failedRow());
  f.setNow(Date.parse('2026-11-19T10:00:00Z'));
  const orig = f.deps.agents.list, recAt = f.pauses[0].agentPausedAt;
  // 人が止め直した。一覧は常に古い値（記録と同じ pausedAt）を返し、get だけが今の値を返す
  Object.assign(f.byId.get('a1'), { pausedAt: '2026-11-19T09:59:59.000Z', pauseReason: 'manual' });
  f.deps.agents.list = async q => (await orig(q)).map(a => ({ ...a, pausedAt: recAt }));
  const r = await handleTick(f.deps, 'c1', {});
  assert.deepEqual(f.calls.resume, []);
  assert.deepEqual(r.body.limits.closed, ['a1']);
  assert.equal(f.pauses[0].closeReason, 'close_repaused');
});

test('H1-r2 直前の読み直し（閉じる）: 一覧では再開に見えても、閉じる直前の get で paused なら閉じない', async () => {
  const f = fakeDeps({ agents: [agent('a1')], state: cfgState({ contractGroups: GROUPS }) });
  f.deps.sleep = async () => {};
  await handleRunFailed(f.deps, failedRow());
  const orig = f.deps.agents.list;
  f.deps.agents.list = async q => (await orig(q)).map(a => ({ ...a, status: 'idle', pausedAt: null }));
  const r = await handleTick(f.deps, 'c1', {});
  assert.deepEqual(r.body.limits.closed, []);
  assert.deepEqual(r.body.limits.repaused, []);
  assert.equal(open(f).length, 1);
});

test('H1-r2 直前の読み直し（読み直しの失敗）: get が失敗した記録はその回は何もしない（閉じない・戻さない）', async () => {
  const f = fakeDeps({ agents: [agent('a1')], state: cfgState({ contractGroups: GROUPS }) });
  f.deps.sleep = async () => {};
  await handleRunFailed(f.deps, failedRow());
  f.setNow(Date.parse('2026-11-19T10:00:00Z'));
  f.deps.onGet = async () => { throw new Error('get failed'); };
  const r = await handleTick(f.deps, 'c1', {});
  assert.deepEqual([r.body.limits.closed, r.body.limits.resumed, f.calls.resume], [[], [], []]);
  assert.equal(open(f).length, 1);
});

test('H1-r2 兄弟（画面の再開の後に閉じる口）: 閉じる直前に get で読み直し、paused なら閉じず stillPaused で返す', async () => {
  const f = fakeDeps({ agents: [agent('a1')], state: cfgState({ contractGroups: GROUPS }) });
  f.deps.sleep = async () => {};
  await handleRunFailed(f.deps, failedRow());
  const orig = f.deps.agents.list;
  f.deps.agents.list = async q => (await orig(q)).map(a => ({ ...a, status: 'idle', pausedAt: null }));
  const r = await handleRoute(f.deps, { routeKey: 'limit-resume', companyId: 'c1', body: { agentIds: ['a1'] } });
  assert.deepEqual([r.body.closed, r.body.stillPaused], [[], ['a1']]);
  assert.equal(open(f).length, 1);
});

test('H1-r2 兄弟（event の 5 秒後の止め直し）: 止め直す直前に get で読み直し、人が再開していたら止め直さない', async () => {
  const f = fakeDeps({ agents: [agent('a1'), agent('a2')], state: cfgState({ contractGroups: GROUPS }) });
  const orig = f.deps.agents.list;
  // 鍵の中の一覧では競り合い（idle で pausedAt は記録と同じ）に見えるが、get の時には人が再開済み（pausedAt が null）
  f.deps.onSleep = async () => {
    f.deps.agents.list = async q => (await orig(q)).map(a => a.id === 'a2' ? { ...a, status: 'idle' } : a);
    Object.assign(f.byId.get('a2'), { status: 'idle', pausedAt: null });
  };
  const r = await handleRunFailed(f.deps, failedRow());
  assert.deepEqual(r.repaused, []);
  assert.equal(f.byId.get('a2').status, 'idle', '人の再開を止め直さない');
});

// 実装レビュー r2 の L-b: 止める直前の読み直しが失敗しても、止めることは飛ばさない
test('L-b: 止める直前の get が失敗した担当も、読み直しを飛ばして止めて記録する', async () => {
  const f = fakeDeps({ agents: [agent('a1'), agent('a2')], state: cfgState({ contractGroups: GROUPS }) });
  f.deps.sleep = async () => {};
  f.deps.onGet = async id => { if (id === 'a2') throw new Error('get failed'); };
  const r = await handleRunFailed(f.deps, failedRow());
  assert.deepEqual(r.paused, ['a1', 'a2']);
  assert.deepEqual(open(f).map(p => p.agentId), ['a1', 'a2']);
});

// 実装レビュー r3 の L-r3a: 画面の再開の後に閉じる口（/limit/resume）は鍵の中で一覧を読む。鍵を外すと、一覧を読んだ後に event の経路が
// 同じ担当を止めて作った記録を、古い一覧（paused でない）で閉じてしまう。1 人ずつの get は外し、鍵だけで守ることを見る
test('L-r3a 鍵（/limit/resume）: 一覧を読んだ後に event の経路が同じ担当を止めて記録を作っても、その記録を閉じない', async () => {
  const f = fakeDeps({ agents: [agent('a1')], state: cfgState({ contractGroups: GROUPS }) });
  f.deps.sleep = async () => {};
  delete f.deps.agents.get;
  const orig = f.deps.agents.list; let first = true, ev = null;
  f.deps.agents.list = async q => {
    const snap = await orig(q);
    if (first) {
      first = false;
      ev = handleRunFailed(f.deps, failedRow()); // 返事を待たない（鍵があれば鍵を待つ。無ければこの間に止めて記録を作る）
      for (let i = 0; i < 50; i++) await new Promise(r => setImmediate(r));
    }
    return snap; // a1 は paused でない古い一覧
  };
  const r = await handleRoute(f.deps, { routeKey: 'limit-resume', companyId: 'c1', body: { agentIds: ['a1'] } });
  await ev;
  assert.deepEqual(r.body.closed, [], '古い一覧で記録を閉じない');
  assert.equal(f.byId.get('a1').status, 'paused');
  assert.deepEqual(open(f).map(p => p.agentId), ['a1'], 'event の経路の記録は開いたまま');
});
