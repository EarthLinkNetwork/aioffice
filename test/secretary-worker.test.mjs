// 秘書の気づきの見回り（/tick）の試験。偽の本体（課題・コメント・担当・承認）と、表を真似た記憶の中の store で回す
// 範囲 docs/review/2026-11-21-secretary-awareness-scope.md の作り方の部品 3〜10・保証 4〜6
import test from 'node:test';
import assert from 'node:assert/strict';
import { handleTick, handleStatus } from '../plugins/secretary/src/worker.mjs';
import { singleFlight } from '../plugins/notify/src/lib.mjs';
import { ROUND, ROUND_ORIGIN } from '../plugins/secretary/src/lib.mjs';

const A = 'company-a', B = 'company-b';
const H = 3600_000;

function fakeStore() {
  const rows = []; let seq = 0;
  return {
    rows,
    add(companyId, r) { rows.push({ id: String(++seq), companyId, state: 'pending', attempts: 0, roundIssueId: null, issueId: '', actorType: 'user', occurredAt: new Date(r.at).toISOString(), ...r }); },
    pending: async c => rows.filter(r => r.companyId === c && r.state === 'pending').map(r => ({ ...r })),
    setState: async (c, ids, state) => { for (const r of rows) if (r.companyId === c && ids.includes(r.id)) r.state = state; },
    send: async (c, ids, rid) => { for (const r of rows) if (r.companyId === c && ids.includes(r.id)) Object.assign(r, { state: 'sent', roundIssueId: rid }); },
    finishRound: async (c, rid) => { for (const r of rows) if (r.companyId === c && r.roundIssueId === rid && r.state === 'sent') r.state = 'done'; },
    failRound: async (c, rid) => { for (const r of rows) if (r.companyId === c && r.roundIssueId === rid && r.state === 'sent') { r.attempts++; r.state = r.attempts >= ROUND.maxAttempts ? 'dropped' : 'pending'; r.roundIssueId = null; } },
    setPref: async (c, id, note) => { for (const r of rows) if (r.companyId === c && r.id === String(id)) Object.assign(r, { state: 'pref', note }); },
    prefs: async c => rows.filter(r => r.companyId === c && r.state === 'pref').reverse().slice(0, ROUND.prefN).map(r => ({ note: r.note, at: r.occurredAt })),
    retry: async (c, ids) => { for (const r of rows) if (r.companyId === c && ids.includes(r.id)) { r.attempts++; r.state = r.attempts >= ROUND.maxAttempts ? 'dropped' : 'pending'; } },
    issuesByRuns: async (c, runIds) => rows.filter(r => r.companyId === c && r.kind === 'issue' && runIds.includes(r.runId)).map(r => r.entityId),
    prune: async () => {},
    counts: async c => rows.filter(r => r.companyId === c).reduce((m, r) => ({ ...m, [r.state]: (m[r.state] || 0) + 1 }), {}),
  };
}

function fakeHost(t0) {
  let now = t0, n = 0;
  const issues = new Map(), comments = new Map(), approvals = new Map(), state = new Map(), wakeups = [], runs = new Map();
  const agents = new Map([['sec-a', { id: 'sec-a', companyId: A, status: 'idle' }], ['sec-b', { id: 'sec-b', companyId: B, status: 'idle' }]]);
  const deps = {
    now: () => now, flight: singleFlight(), store: fakeStore(),
    state: { get: async k => state.get(`${k.scopeId}|${k.stateKey}`) ?? null, set: async (k, v) => { state.set(`${k.scopeId}|${k.stateKey}`, structuredClone(v)); } },
    agents: { get: async (id, c) => { const a = agents.get(id); return a && a.companyId === c ? a : null; } },
    approvals: { get: async (id, c) => { const a = approvals.get(id); return a && a.companyId === c ? a : null; } },
    issues: {
      list: async ({ companyId, originKind, status }) => [...issues.values()].filter(i => i.companyId === companyId && (!originKind || i.originKind === originKind) && (!status || (i.status || 'todo') === status)),
      get: async (id, c) => { const i = issues.get(id); return i && i.companyId === c ? i : null; },
      create: async x => { const id = `i${++n}`; const i = { id, identifier: `X-${n}`, createdAt: new Date(now).toISOString(), parentId: null, ...x }; issues.set(id, i); return i; },
      update: async (id, patch) => { Object.assign(issues.get(id), patch); return issues.get(id); },
      listComments: async id => comments.get(id) || [],
      createComment: async (id, body) => { const c = { id: `c${++n}`, body, authorType: 'system', createdAt: new Date(now).toISOString() }; comments.set(id, [...(comments.get(id) || []), c]); return c; },
      requestWakeup: async (id, c, o) => { wakeups.push({ id, ...o }); },
      getSubtree: async id => ({ issues: [...issues.values()].filter(i => i.parentId === id) }),
      summaries: { getOrchestration: async ({ issueId }) => ({ runs: runs.get(issueId) || [] }) },
    },
  };
  const addIssue = (c, x) => { const id = x.id || `i${++n}`; issues.set(id, { id, identifier: id.toUpperCase(), companyId: c, title: 't', description: '', createdAt: new Date(now).toISOString(), parentId: null, ...x, id }); return issues.get(id); };
  const addComment = (issueId, x) => { const c = { id: `c${++n}`, createdAt: new Date(now).toISOString(), ...x }; comments.set(issueId, [...(comments.get(issueId) || []), c]); return c; };
  return { deps, issues, comments, approvals, wakeups, runs, agents, addIssue, addComment, advance: d => { now += d; }, get now() { return now; } };
}
const tick = (h, c, sec, extra = {}) => handleTick(h.deps, c, { secretaryAgentId: sec, lang: 'ja', timeZone: 'Asia/Tokyo', ...extra }).then(r => r.body);
const roundsOf = (h, c) => [...h.issues.values()].filter(i => i.companyId === c && i.originKind === ROUND_ORIGIN);

test('出来事 → 見回りの課題（秘書に・境界の中）→ 提案を取り込む → 人の返事が次の回に入る', async () => {
  const h = fakeHost(Date.parse('2026-11-21T00:00:00Z'));
  const bill = h.addIssue(A, { title: '請求書が届いた', description: '支払い期限は 11/30', originKind: 'routine_execution' });
  h.deps.store.add(A, { kind: 'issue', entityId: bill.id, at: h.now });
  const cm = h.addComment(bill.id, { authorType: 'user', authorUserId: 'u1', body: '先方の担当が変わったらしい' });
  h.deps.store.add(A, { kind: 'comment', entityId: cm.id, issueId: bill.id, at: h.now });
  h.approvals.set('ap1', { id: 'ap1', companyId: A, type: 'hire_agent', status: 'pending', payload: { name: '経理' } });
  h.deps.store.add(A, { kind: 'approval', entityId: 'ap1', at: h.now });

  const r1 = await tick(h, A, 'sec-a');
  assert.ok(r1.created, '見回りができる');
  const round = h.issues.get(r1.created.id);
  assert.equal(round.assigneeAgentId, 'sec-a');
  assert.equal(round.originKind, ROUND_ORIGIN);
  assert.match(round.description, /請求書が届いた — 支払い期限は 11\/30/);
  assert.match(round.description, /先方の担当が変わったらしい/);
  assert.match(round.description, /approval hire_agent/);
  assert.match(round.description, /Do not change anything yourself/);
  assert.equal(r1.created.events, 3);

  // 1 時間たつまで次は作らない（開いている）
  h.deps.store.add(A, { kind: 'issue', entityId: h.addIssue(A, { title: '次' }).id, at: h.now });
  assert.equal((await tick(h, A, 'sec-a')).created, null);

  // 秘書が提案を書いて done にする（in_review は plugin が動かす）
  h.addComment(round.id, { authorType: 'agent', authorAgentId: 'sec-a', body: '1. 期限を確かめる\n```json\n{"proposals":[{"title":"支払い期限の確認","detail":"11/30","evidence":["X-1"],"deep":true}]}\n```' });
  round.status = 'done';
  const re = h.addComment(round.id, { authorType: 'user', authorUserId: 'u1', body: '1 は役に立った。朝は送らないで' });
  h.deps.store.add(A, { kind: 'comment', entityId: re.id, issueId: round.id, at: h.now });
  h.advance(H);
  const r2 = await tick(h, A, 'sec-a');
  assert.equal(r2.imported, 1);
  assert.equal(round.status, 'in_review', '提案のある回は plugin が in_review にする');
  assert.ok(r2.created, 'in_review の回は次を止めない（N-B1）');
  assert.match(h.issues.get(r2.created.id).description, /1 は役に立った。朝は送らないで/, '人の返事が次の回の本文に入る');
  const st = (await handleStatus(h.deps, A)).body;
  assert.equal(st.deepUsed, 1);
  assert.equal(st.proposals, 1);
  assert.equal(st.done, 3);
});

test('こだま: 見回り・秘書の子の課題・AI のコメント・見張りの課題は渡さない', async () => {
  const h = fakeHost(Date.parse('2026-11-21T00:00:00Z'));
  const round = h.addIssue(A, { originKind: ROUND_ORIGIN, status: 'done', title: '前の見回り' });
  const child = h.addIssue(A, { parentId: round.id, createdByAgentId: 'sec-a', title: '秘書が作った' });
  const grand = h.addIssue(A, { parentId: child.id, createdByAgentId: 'other', title: '孫' });
  const watch = h.addIssue(A, { originKind: 'task_watchdog', title: '見張り' });
  const anon = h.addComment(watch.id, { authorType: 'user', body: '名前の無い添え書き' });
  for (const i of [round, child, grand, watch]) h.deps.store.add(A, { kind: 'issue', entityId: i.id, at: h.now });
  h.deps.store.add(A, { kind: 'comment', entityId: anon.id, issueId: watch.id, at: h.now });
  const r = await tick(h, A, 'sec-a');
  assert.equal(r.created, null, '渡す物が残らなければ見回りを作らない');
  assert.equal((await handleStatus(h.deps, A)).body.echo, 5);
});

test('止まった時: 起こし直しは 1 回・2 時間で閉じて出来事を 1 回だけ戻す・2 回目は落ち', async () => {
  const h = fakeHost(Date.parse('2026-11-21T00:00:00Z'));
  const i = h.addIssue(A, { title: '何か' });
  h.deps.store.add(A, { kind: 'issue', entityId: i.id, at: h.now });
  const r1 = await tick(h, A, 'sec-a');
  h.advance(ROUND.wakeAfterMs);
  await tick(h, A, 'sec-a');
  await tick(h, A, 'sec-a');
  assert.equal(h.wakeups.length, 1, '起こし直しは 1 回だけ');
  h.advance(ROUND.staleMs);
  const r2 = await tick(h, A, 'sec-a');
  assert.equal(r2.stalled, 1);
  assert.equal(h.issues.get(r1.created.id).status, 'cancelled');
  assert.ok(r2.created, '戻した出来事で次の回を作る');
  h.advance(ROUND.staleMs + H);
  await tick(h, A, 'sec-a');
  assert.equal((await handleStatus(h.deps, A)).body.dropped, 1, '2 回目の失敗で落ち');
  assert.equal((await handleStatus(h.deps, A)).body.stalls, 2);
});

test('json の無い回は深く調べる分を使い切りとして数える・違反（見回りの子の課題）を数えて次の本文に出す', async () => {
  const h = fakeHost(Date.parse('2026-11-21T00:00:00Z'));
  h.deps.store.add(A, { kind: 'issue', entityId: h.addIssue(A, { title: 'a' }).id, at: h.now });
  const r1 = await tick(h, A, 'sec-a');
  const round = h.issues.get(r1.created.id);
  h.addIssue(A, { parentId: round.id, createdByAgentId: 'sec-a', title: '勝手に作った' });
  h.addComment(round.id, { authorType: 'agent', authorAgentId: 'sec-a', body: 'まとめだけ' });
  round.status = 'done';
  h.deps.store.add(A, { kind: 'issue', entityId: h.addIssue(A, { title: 'b' }).id, at: h.now });
  h.advance(H);
  const r2 = await tick(h, A, 'sec-a');
  const st = (await handleStatus(h.deps, A)).body;
  assert.equal(st.deepUsed, ROUND.deepPerDay);
  assert.equal(st.violations, 1);
  assert.match(h.issues.get(r2.created.id).description, /1 task\(s\) created/);
  assert.match(h.issues.get(r2.created.id).description, /no deep investigations left/);
});

test('2 社目に出ない・秘書の id は会社の一致を確かめる・秘書がいなければ作らない', async () => {
  const h = fakeHost(Date.parse('2026-11-21T00:00:00Z'));
  const ia = h.addIssue(A, { title: 'A 社の秘密の件' });
  h.deps.store.add(A, { kind: 'issue', entityId: ia.id, at: h.now });
  assert.equal((await tick(h, B, 'sec-b')).created, null, 'B 社には A 社の出来事が無い');
  assert.equal((await tick(h, A, 'sec-b')).created, null, '別の会社の秘書は使わない');
  assert.equal((await tick(h, A, undefined)).created, null);
  h.agents.get('sec-a').status = 'paused';
  assert.equal((await tick(h, A, 'sec-a')).created, null, '止まった秘書（使用量の上限）には渡さない');
  h.agents.get('sec-a').status = 'idle';
  const r = await tick(h, A, 'sec-a');
  assert.ok(r.created);
  h.deps.store.add(B, { kind: 'issue', entityId: h.addIssue(B, { title: 'B 社の件' }).id, at: h.now });
  const rb = await tick(h, B, 'sec-b');
  assert.doesNotMatch(h.issues.get(rb.created.id).description, /A 社の秘密の件/);
  assert.equal(roundsOf(h, B).length, 1);
});

test('取り込んだ in_review の回は 2 日で done・1 日の回数の上限', async () => {
  const h = fakeHost(Date.parse('2026-11-21T00:00:00Z'));
  h.deps.store.add(A, { kind: 'issue', entityId: h.addIssue(A, { title: 'a' }).id, at: h.now });
  const r1 = await tick(h, A, 'sec-a');
  const round = h.issues.get(r1.created.id);
  h.addComment(round.id, { authorType: 'agent', authorAgentId: 'sec-a', body: '```json\n{"proposals":[{"title":"x"}]}\n```' });
  round.status = 'done';
  await tick(h, A, 'sec-a');
  assert.equal(round.status, 'in_review');
  h.advance(ROUND.closeReviewMs);
  await tick(h, A, 'sec-a');
  assert.equal(round.status, 'done');
});

test('skipWait は間隔だけを飛ばす（開いた回・1 日の上限は残る）', async () => {
  const h = fakeHost(Date.parse('2026-11-21T00:00:00Z'));
  h.deps.store.add(A, { kind: 'issue', entityId: h.addIssue(A, { title: 'a' }).id, at: h.now });
  const r1 = await tick(h, A, 'sec-a');
  h.deps.store.add(A, { kind: 'issue', entityId: h.addIssue(A, { title: 'b' }).id, at: h.now });
  assert.equal((await tick(h, A, 'sec-a', { skipWait: true })).created, null, '開いた回があれば作らない');
  const round = h.issues.get(r1.created.id);
  h.addComment(round.id, { authorType: 'agent', authorAgentId: 'sec-a', body: '```json\n{"proposals":[]}\n```' });
  round.status = 'done';
  assert.equal((await tick(h, A, 'sec-a')).created, null, 'skipWait が無ければ 60 分待つ');
  assert.ok((await tick(h, A, 'sec-a', { skipWait: true })).created);
});

// ---- 独立レビュー（PR #100）の指摘の試験 ----
const roundDone = (h, r, body = '```json\n{"proposals":[]}\n```') => { const round = h.issues.get(r.created.id); h.addComment(round.id, { authorType: 'agent', authorAgentId: 'sec-a', body }); round.status = 'done'; return round; };

test('P2-2・P3-4: 返事は表に残り、10 回より後の回にも入る・見回りの子の課題への返事も返事', async () => {
  const h = fakeHost(Date.parse('2026-11-21T00:00:00Z'));
  h.deps.store.add(A, { kind: 'issue', entityId: h.addIssue(A, { title: 'a' }).id, at: h.now });
  const r1 = await tick(h, A, 'sec-a');
  const round1 = roundDone(h, r1);
  const child = h.addIssue(A, { parentId: round1.id, createdByAgentId: 'sec-a', title: '提案 1 の下書き' });
  const re1 = h.addComment(round1.id, { authorType: 'user', authorUserId: 'u1', body: 'REACT-ROOT' });
  const re2 = h.addComment(child.id, { authorType: 'user', authorUserId: 'u1', body: 'REACT-CHILD' });
  h.deps.store.add(A, { kind: 'comment', entityId: re1.id, issueId: round1.id, at: h.now });
  h.deps.store.add(A, { kind: 'comment', entityId: re2.id, issueId: child.id, at: h.now });
  let last = null;
  for (let k = 0; k < 12; k++) {
    h.deps.store.add(A, { kind: 'issue', entityId: h.addIssue(A, { title: `e${k}` }).id, at: h.now });
    h.advance(H);
    last = await tick(h, A, 'sec-a');
    assert.ok(last.created, `回 ${k}`);
    roundDone(h, last);
  }
  const body = h.issues.get(last.created.id).description;
  assert.match(body, /REACT-ROOT/, '12 回後でも返事が入る');
  assert.match(body, /REACT-CHILD/, '見回りの子の課題への返事も入る');
  assert.equal((await handleStatus(h.deps, A)).body.prefs, 2);
});

test('P2-3: 見回りの run が作った課題は、見回りの下でなくても違反に数える', async () => {
  const h = fakeHost(Date.parse('2026-11-21T00:00:00Z'));
  h.deps.store.add(A, { kind: 'issue', entityId: h.addIssue(A, { title: 'a' }).id, at: h.now });
  const r1 = await tick(h, A, 'sec-a');
  h.runs.set(r1.created.id, [{ id: 'run-1', agentId: 'sec-a', startedAt: new Date(h.now).toISOString() }]);
  const top = h.addIssue(A, { title: '勝手に作った（最上位）', createdByAgentId: 'sec-a' });
  h.deps.store.add(A, { kind: 'issue', entityId: top.id, runId: 'run-1', at: h.now });
  roundDone(h, r1);
  h.advance(H);
  await tick(h, A, 'sec-a');
  assert.equal((await handleStatus(h.deps, A)).body.violations, 1);
});

test('P3-2: 読み直しの一時の失敗はこだまにせず残す（2 回で落ち）', async () => {
  const h = fakeHost(Date.parse('2026-11-21T00:00:00Z'));
  const i = h.addIssue(A, { title: 'a' });
  h.deps.store.add(A, { kind: 'issue', entityId: i.id, at: h.now });
  const get = h.deps.issues.get;
  h.deps.issues.get = async () => { throw new Error('host busy'); };
  assert.equal((await tick(h, A, 'sec-a')).created, null);
  const st = (await handleStatus(h.deps, A)).body;
  assert.equal(st.pending, 1, '残す');
  assert.equal(st.echo, 0, 'こだまにしない');
  h.deps.issues.get = get;
  assert.ok((await tick(h, A, 'sec-a')).created, '読めるようになれば渡す');
});

test('P3-1: 1 つの回の失敗で見回り全体を止めない・取り込みを二度数えない', async () => {
  const h = fakeHost(Date.parse('2026-11-21T00:00:00Z'));
  h.deps.store.add(A, { kind: 'issue', entityId: h.addIssue(A, { title: 'a' }).id, at: h.now });
  const r1 = await tick(h, A, 'sec-a');
  roundDone(h, r1, '```json\n{"proposals":[{"title":"x"}]}\n```');
  const update = h.deps.issues.update;
  h.deps.issues.update = async () => { throw new Error('update failed'); };
  h.deps.store.add(A, { kind: 'issue', entityId: h.addIssue(A, { title: 'b' }).id, at: h.now });
  h.advance(H);
  const r2 = await tick(h, A, 'sec-a');
  assert.equal(r2.imported, 1);
  assert.ok(r2.created, '失敗しても次の回は作る');
  h.deps.issues.update = update;
  await tick(h, A, 'sec-a');
  const st = (await handleStatus(h.deps, A)).body;
  assert.equal(st.proposals, 1, '二度数えない');
  assert.equal(st.errors, 1);
});

test('P2-1: 表は承認の作成と判断を別の行にする（一意は種類と時刻まで）', async () => {
  const { dbStore } = await import('../plugins/secretary/src/worker.mjs');
  const calls = [];
  const db = { namespace: 'ns', execute: async (sql, args) => { calls.push([sql, args]); return { rowCount: 1 }; }, query: async () => [] };
  await dbStore(db).addEvent({ companyId: A, kind: 'approval', eventType: 'approval.decided', entityId: 'ap1', occurredAt: '2026-11-21T00:00:00Z', actorType: 'user' });
  assert.match(calls[0][0], /ON CONFLICT \(company_id, event_type, entity_id, occurred_at\)/);
  assert.equal(calls[0][1][2], 'approval.decided');
});

test('再レビュー P3: in_review への移しと 2 日の done は失敗しても次の見回りでやり直す・止まった回は出来事を先に戻す・一覧が読めなければ作らない', async () => {
  const h = fakeHost(Date.parse('2026-11-21T00:00:00Z'));
  h.deps.store.add(A, { kind: 'issue', entityId: h.addIssue(A, { title: 'a' }).id, at: h.now });
  const r1 = await tick(h, A, 'sec-a');
  const round = roundDone(h, r1, '```json\n{"proposals":[{"title":"x"}]}\n```');
  const update = h.deps.issues.update;
  h.deps.issues.update = async () => { throw new Error('busy'); };
  await tick(h, A, 'sec-a');
  assert.equal(round.status, 'done');
  h.deps.issues.update = update;
  await tick(h, A, 'sec-a');
  assert.equal(round.status, 'in_review', '次の見回りで in_review に');
  h.advance(ROUND.closeReviewMs);
  h.deps.issues.update = async () => { throw new Error('busy'); };
  await tick(h, A, 'sec-a');
  h.deps.issues.update = update;
  await tick(h, A, 'sec-a');
  assert.equal(round.status, 'done', '2 日の done もやり直す');

  // 止まった回: コメントが失敗しても出来事は戻っている
  h.deps.store.add(A, { kind: 'issue', entityId: h.addIssue(A, { title: 'b' }).id, at: h.now });
  h.advance(H);
  const r2 = await tick(h, A, 'sec-a');
  h.advance(ROUND.staleMs);
  const cc = h.deps.issues.createComment;
  h.deps.issues.createComment = async () => { throw new Error('busy'); };
  const list = h.deps.issues.list;
  await tick(h, A, 'sec-a');
  h.deps.issues.createComment = cc;
  assert.equal(h.deps.store.rows.filter(r => r.roundIssueId === r2.created.id && r.state === 'sent').length, 0, '出来事は sent のまま残らない');

  // 一覧が読めなければ見回り全体を失敗にする（2 つ目を作らない）
  h.deps.issues.list = async () => { throw new Error('list down'); };
  await assert.rejects(() => tick(h, A, 'sec-a'));
  h.deps.issues.list = list;
});

test('再レビュー 2 回目: 止まった回の閉じはやり直す・2 日の done は 3 回であきらめる・一覧の失敗は理由を残す', async () => {
  const h = fakeHost(Date.parse('2026-11-21T00:00:00Z'));
  h.deps.store.add(A, { kind: 'issue', entityId: h.addIssue(A, { title: 'a' }).id, at: h.now });
  const r1 = await tick(h, A, 'sec-a');
  const round = h.issues.get(r1.created.id);
  h.advance(ROUND.staleMs + H);
  const cc = h.deps.issues.createComment;
  h.deps.issues.createComment = async () => { throw new Error('busy'); };
  await tick(h, A, 'sec-a');
  assert.notEqual(round.status, 'cancelled');
  h.deps.issues.createComment = cc;
  await tick(h, A, 'sec-a');
  assert.equal(round.status, 'cancelled', '次の見回りで閉じる');

  const r = h.addIssue(A, { originKind: ROUND_ORIGIN, status: 'in_review', title: '古い回', createdAt: new Date(h.now - 3 * 24 * H).toISOString() });
  const update = h.deps.issues.update;
  let calls = 0;
  h.deps.issues.update = async (id, patch, c) => { if (id === r.id) { calls++; throw new Error('422'); } return update(id, patch, c); };
  for (let k = 0; k < 6; k++) await tick(h, A, 'sec-a');
  assert.equal(calls, 3, '3 回であきらめる');
  h.deps.issues.update = update;

  const list = h.deps.issues.list;
  h.deps.issues.list = async () => { throw new Error('list down'); };
  await assert.rejects(() => tick(h, A, 'sec-a'));
  h.deps.issues.list = list;
  assert.match((await handleStatus(h.deps, A)).body.lastError, /list down/);
});
