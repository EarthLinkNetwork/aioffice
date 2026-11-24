// 秘書の気づきの見回り（/tick）の試験。偽の本体（課題・コメント・担当・承認）と、表を真似た記憶の中の store で回す
// 範囲 docs/review/2026-11-21-secretary-awareness-scope.md の作り方の部品 3〜10・保証 4〜6
import test from 'node:test';
import assert from 'node:assert/strict';
import { handleTick, handleStatus } from '../plugins/secretary/src/worker.mjs';
import { singleFlight } from '../plugins/notify/src/lib.mjs';
import { ROUND, ROUND_ORIGIN, PROPOSAL_ORIGIN, NOTICE_ORIGIN, OPEN_ROUND } from '../plugins/secretary/src/lib.mjs';

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
    failRound: async (c, rid) => { for (const r of rows) if (r.companyId === c && r.roundIssueId === rid && r.state === 'sent') { r.state = 'pending'; r.roundIssueId = null; } },
    setPref: async (c, id, note) => { for (const r of rows) if (r.companyId === c && r.id === String(id)) Object.assign(r, { state: 'pref', note }); },
    prefs: async c => rows.filter(r => r.companyId === c && r.state === 'pref').reverse().slice(0, ROUND.prefN).map(r => ({ note: r.note, at: r.occurredAt })),
    requeue: async c => { for (const r of rows) if (r.companyId === c && r.state === 'dropped') Object.assign(r, { state: 'pending', attempts: 0, roundIssueId: null }); },
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
      list: async ({ companyId, originKind, originId, status, offset = 0, limit = 1000 }) => [...issues.values()].filter(i => i.companyId === companyId && (!originKind || i.originKind === originKind) && (!originId || i.originId === originId) && (!status || (i.status || 'todo') === status)).slice(offset, offset + limit),
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
const kidsOf = (h, round) => [...h.issues.values()].filter(i => i.originKind === PROPOSAL_ORIGIN && i.parentId === round.id);
// 子の課題を作れない本体のまね（前の形 = 見回りの課題を確認待ちにする、に戻る事を確かめる）
const noChildren = h => { const create = h.deps.issues.create; h.deps.issues.create = async x => { if (x.originKind === PROPOSAL_ORIGIN) throw new Error('no children'); return create(x); }; };

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
  assert.equal(round.status, 'done', '見回りの課題は done のまま');
  const kids = kidsOf(h, round);
  assert.equal(kids.length, 1, '提案 1 つ = 子の課題 1 つ');
  assert.deepEqual([kids[0].title, kids[0].status, kids[0].assigneeAgentId, kids[0].originId], ['支払い期限の確認', 'in_review', 'sec-a', `${round.id}:1`]);
  assert.match(kids[0].description, /^## 概要\n11\/30\n\n## 決めてほしい事\n/);
  assert.ok(r2.created, '提案を出した回は次を止めない（N-B1）');
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

test('止まった時: 起こし直しは 1 回・2 時間で閉じて出来事を戻す・何回止まっても落とさない・2 回つづいたら持ち主に知らせる（1 つだけ）', async () => {
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
  const notices = () => [...h.issues.values()].filter(x => x.originKind === NOTICE_ORIGIN);
  assert.equal(notices().length, 0, '1 回止まっただけでは知らせない');
  for (let n = 0; n < 4; n++) { h.advance(ROUND.staleMs + H); await tick(h, A, 'sec-a'); }
  const st = (await handleStatus(h.deps, A)).body;
  assert.equal(st.dropped, 0, '何回止まっても落とさない');
  assert.equal(st.pending + st.sent, 1, '出来事は残っている');
  assert.ok(st.stalls >= 4);
  assert.equal(notices().length, 1, '知らせは 1 つだけ');
  assert.equal(notices()[0].status, 'in_review');
  assert.match(notices()[0].description, /決めてほしい事/);
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

test('提案の課題は自動では閉じない（何日たっても確認待ちに残る）', async () => {
  const h = fakeHost(Date.parse('2026-11-21T00:00:00Z'));
  h.deps.store.add(A, { kind: 'issue', entityId: h.addIssue(A, { title: 'a' }).id, at: h.now });
  const r1 = await tick(h, A, 'sec-a');
  const round = h.issues.get(r1.created.id);
  h.addComment(round.id, { authorType: 'agent', authorAgentId: 'sec-a', body: '```json\n{"proposals":[{"title":"x"}]}\n```' });
  round.status = 'done';
  await tick(h, A, 'sec-a');
  const [kid] = kidsOf(h, round);
  assert.equal(kid.status, 'in_review');
  h.advance(ROUND.closeReviewMs * 5);
  await tick(h, A, 'sec-a');
  assert.equal(kid.status, 'in_review', '提案の課題は、持ち主が決めるまで何日たっても確認待ちに残る');
});

test('子の課題を作れない本体では、前の形（見回りの課題を in_review・2 日で done）に戻る', async () => {
  const h = fakeHost(Date.parse('2026-11-21T00:00:00Z'));
  noChildren(h);
  h.deps.store.add(A, { kind: 'issue', entityId: h.addIssue(A, { title: 'a' }).id, at: h.now });
  const r1 = await tick(h, A, 'sec-a');
  const round = roundDone(h, r1, '```json\n{"proposals":[{"title":"x"}]}\n```');
  await tick(h, A, 'sec-a');
  assert.equal(round.status, 'in_review');
  assert.equal(kidsOf(h, round).length, 0);
  h.advance(ROUND.closeReviewMs);
  await tick(h, A, 'sec-a');
  assert.equal(round.status, 'done');
});

test('提案の課題: 途中で失敗しても次の見回りで続きから作る・二度作らない・子は自動で閉じない', async () => {
  const h = fakeHost(Date.parse('2026-11-21T00:00:00Z'));
  h.deps.store.add(A, { kind: 'issue', entityId: h.addIssue(A, { title: 'a' }).id, at: h.now });
  const r1 = await tick(h, A, 'sec-a');
  const round = roundDone(h, r1, '```json\n{"proposals":[{"title":"p1","ask":"q1","recommend":"r1","why":"w1"},{"title":"p2"},{"title":"p3"}]}\n```');
  const create = h.deps.issues.create; let n = 0;
  h.deps.issues.create = async x => { if (x.originKind === PROPOSAL_ORIGIN && ++n >= 2) throw new Error('busy'); return create(x); };
  await tick(h, A, 'sec-a');
  assert.equal(kidsOf(h, round).length, 1, '1 つ目だけできた');
  assert.equal(round.status, 'done', '1 つでもできていれば前の形に戻さない');
  h.deps.issues.create = create;
  await tick(h, A, 'sec-a');
  await tick(h, A, 'sec-a');
  assert.deepEqual(kidsOf(h, round).map(k => k.title).sort(), ['p1', 'p2', 'p3'], '続きから作り、二度作らない');
  assert.equal((await handleStatus(h.deps, A)).body.proposals, 3);
  // 持ち主が進めた子（todo）も、触っていない子（確認待ち）も、2 日たっても閉じない
  const [k1] = kidsOf(h, round); k1.status = 'todo';
  h.advance(ROUND.closeReviewMs);
  await tick(h, A, 'sec-a');
  assert.equal(k1.status, 'todo');
  assert.equal(kidsOf(h, round).filter(k => k.status === 'in_review').length, 2);
  assert.equal(kidsOf(h, round).filter(k => k.status === 'done').length, 0);
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

test('P3-2: 読み直しの一時の失敗はこだまにせず残す（累計 20 回で落ち・後ろの出来事を止めない）', async () => {
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
  // 読めない行が先頭に 60 件居座っても、累計 20 回で落ちて、後ろの読める出来事が渡る
  const g = fakeHost(Date.parse('2026-11-21T00:00:00Z'));
  for (let n = 0; n < ROUND.maxEvents; n++) g.deps.store.add(A, { kind: 'issue', entityId: `bad-${n}`, at: g.now });
  g.deps.store.add(A, { kind: 'issue', entityId: g.addIssue(A, { title: '読める件' }).id, at: g.now });
  const get2 = g.deps.issues.get;
  g.deps.issues.get = async (id, c) => { if (String(id).startsWith('bad-')) throw new Error('broken row'); return get2(id, c); };
  let made = null;
  for (let n = 0; n < ROUND.maxAttempts + 2 && !made; n++) made = (await tick(g, A, 'sec-a')).created;
  assert.equal(made?.events, 1, '後ろの読める出来事が渡る');
  assert.equal((await handleStatus(g.deps, A)).body.dropped, ROUND.maxEvents);
});

test('落とさない: 30 時間前の出来事も渡す・秘書を置いていない会社だけは 24 時間で落とす（1 回だけ id が渡らない回では落とさない）・止めてある秘書の会社は落とさず、事情つきで知らせる', async () => {
  const t0 = Date.parse('2026-11-21T00:00:00Z');
  const h = fakeHost(t0);
  h.deps.store.add(A, { kind: 'issue', entityId: h.addIssue(A, { title: '古い件' }).id, at: t0 - 30 * H });
  const r = await tick(h, A, 'sec-a');
  assert.equal(r.created?.events, 1, '30 時間前の出来事を渡す');
  assert.equal((await handleStatus(h.deps, A)).body.dropped, 0);
  // 秘書の id が渡らない会社
  h.deps.store.add(B, { kind: 'issue', entityId: h.addIssue(B, { title: '古い' }).id, at: t0 - 30 * H });
  h.deps.store.add(B, { kind: 'issue', entityId: h.addIssue(B, { title: '新しい' }).id, at: t0 - H });
  await handleTick(h.deps, B, { lang: 'ja', timeZone: 'Asia/Tokyo' });
  const sb = (await handleStatus(h.deps, B)).body;
  assert.equal(sb.dropped, 1); assert.equal(sb.pending, 1);
  // 秘書を置いてある会社に、id の無い呼び出しが 1 回来ても落とさない（次も無ければ落とす）
  const C = 'co-c'; h.agents.set('sec-c', { id: 'sec-c', companyId: C, status: 'paused' });
  h.deps.store.add(C, { kind: 'issue', entityId: h.addIssue(C, { title: '止めてある会社の古い件' }).id, at: t0 - 30 * H });
  const rc = await tick(h, C, 'sec-c');
  assert.equal(rc.created, null, '止めてある秘書には渡さない');
  const nc = [...h.issues.values()].filter(x => x.companyId === C && x.originKind === NOTICE_ORIGIN);
  assert.equal(nc.length, 1, '24 時間より古い出来事がたまっているので知らせる');
  assert.match(nc[0].description, /秘書の担当は止めてあります/);
  await handleTick(h.deps, C, { lang: 'ja', timeZone: 'Asia/Tokyo' });
  assert.equal((await handleStatus(h.deps, C)).body.dropped, 0, 'id が 1 回渡らなかっただけでは落とさない');
  await handleTick(h.deps, C, { lang: 'ja', timeZone: 'Asia/Tokyo' });
  assert.equal((await handleStatus(h.deps, C)).body.dropped, 1, '続けて渡らなければ、秘書を置いていない会社として落とす');
});

test('知らせ: 開いた知らせがある間は作らない・閉じて 24 時間たてばまた作る・作れなくても見回りは作り、1 時間あけて試す・答えたら数を戻す', async () => {
  const h = fakeHost(Date.parse('2026-11-21T00:00:00Z'));
  const notices = () => [...h.issues.values()].filter(x => x.companyId === A && x.originKind === NOTICE_ORIGIN);
  h.deps.store.add(A, { kind: 'issue', entityId: h.addIssue(A, { title: '何か' }).id, at: h.now });
  await tick(h, A, 'sec-a');
  // 知らせを作れない本体: 2 回止まっても知らせは無いが、見回りは作り続ける
  const create = h.deps.issues.create; let tries = 0;
  h.deps.issues.create = async x => { if (x.originKind === NOTICE_ORIGIN) { tries++; throw new Error('no notice'); } return create(x); };
  h.advance(ROUND.staleMs + H); await tick(h, A, 'sec-a');
  h.advance(ROUND.staleMs + H); const r3 = await tick(h, A, 'sec-a');
  assert.ok(r3.created, '知らせを作れなくても見回りは作る');
  assert.equal(notices().length, 0); assert.equal(tries, 2, '確認待ちと backlog の両方を試した');
  assert.match((await handleStatus(h.deps, A)).body.noticeError, /no notice/);
  // 渡していない出来事がある回でも、1 時間の内は試さない・1 時間あけば試す
  h.deps.store.add(A, { kind: 'issue', entityId: h.addIssue(A, { title: '後から来た件' }).id, at: h.now });
  await tick(h, A, 'sec-a');
  assert.equal(tries, 2, '作れなかった後は、毎回は試さない');
  h.advance(ROUND.noticeRetryMs); await tick(h, A, 'sec-a');
  assert.equal(tries, 4, '1 時間あけてもう一度試す');
  // backlog では作れるが確認待ちへ動かせない本体: 1 つ作ったら「作れた」として、増やさない
  const update = h.deps.issues.update;
  h.deps.issues.create = async x => { if (x.originKind === NOTICE_ORIGIN && x.status === 'in_review') throw new Error('422'); return create(x); };
  h.deps.issues.update = async (id, patch, c) => { if (h.issues.get(id)?.originKind === NOTICE_ORIGIN) throw new Error('cannot move'); return update(id, patch, c); };
  h.advance(ROUND.noticeRetryMs); await tick(h, A, 'sec-a');
  for (let n = 0; n < 30; n++) { h.advance(ROUND.noticeRetryMs); await tick(h, A, 'sec-a'); }
  assert.equal(notices().length, 1, '動かせなくても 1 つだけ');
  assert.match((await handleStatus(h.deps, A)).body.noticeError, /not moved to in_review/, '動かせなかった事を状態に出す');
  notices()[0].status = 'done'; h.deps.issues.update = update;
  const before = notices().length;
  // 確認待ちでは作れないが backlog なら作れる本体
  h.deps.issues.create = async x => { if (x.originKind === NOTICE_ORIGIN && x.status === 'in_review') throw new Error('422'); return create(x); };
  // 次に試すのは、間隔（1 時間）があいた後で、渡していない出来事がある回（ここでは次に見回りが止まって出来事が戻った回）
  for (let n = 0; n < 12 && notices().length === before; n++) { h.advance(ROUND.staleMs + H); await tick(h, A, 'sec-a'); }
  assert.equal(notices().length, before + 1); assert.equal(notices().at(-1).status, 'in_review', 'backlog で作ってから確認待ちへ');
  assert.equal((await handleStatus(h.deps, A)).body.noticeError, null);
  h.deps.issues.create = create;
  // 開いた知らせがある間は、24 時間たっても 2 つ目を作らない
  for (let n = 0; n < 9; n++) { h.advance(ROUND.staleMs + H); await tick(h, A, 'sec-a'); }
  assert.equal(notices().length, before + 1);
  // 持ち主が閉じた後、まだ止まっていれば 24 時間あけてもう 1 つ
  notices().at(-1).status = 'done';
  for (let n = 0; n < 9; n++) { h.advance(ROUND.staleMs + H); await tick(h, A, 'sec-a'); }
  assert.equal(notices().length, before + 2);
  assert.ok((await handleStatus(h.deps, A)).body.stallStreak >= 2);
  // 秘書が答えたら、続けて止まった数は 0 に戻る
  const open = roundsOf(h, A).find(x => OPEN_ROUND.has(x.status || 'todo'));
  assert.ok(open, '開いた見回りがある');
  h.addComment(open.id, { authorType: 'agent', authorAgentId: 'sec-a', body: '```json\n{"proposals":[]}\n```' }); open.status = 'done';
  await tick(h, A, 'sec-a');
  const st = (await handleStatus(h.deps, A)).body;
  assert.equal(st.stallStreak, 0); assert.equal(st.dropped, 0);
});

test('表の SQL: 見回りの失敗は pending に戻すだけ（数えない・落とさない）・読み直しの失敗は累計 maxAttempts で落ち', async () => {
  const { dbStore } = await import('../plugins/secretary/src/worker.mjs');
  const seen = [];
  const store = dbStore({ namespace: 'ns', execute: async (q, p) => { seen.push(q); }, query: async () => [] });
  await store.failRound(A, 'r1');
  assert.match(seen[0], /SET state = 'pending', round_issue_id = NULL/);
  assert.ok(!/dropped|attempts/.test(seen[0]), '見回りの失敗では数えず、落とさない');
  await store.retry(A, ['1']);
  assert.ok(seen[1].includes(`attempts + 1 >= ${ROUND.maxAttempts} THEN 'dropped'`));
  assert.equal(ROUND.maxAttempts, 20);
  await store.prune(A, Date.now());
  assert.ok(!/'pending'/.test(seen[2]), '掃除は pending を消さない');
});

test('P3-1: 1 つの回の失敗で見回り全体を止めない・取り込みを二度数えない', async () => {
  const h = fakeHost(Date.parse('2026-11-21T00:00:00Z'));
  h.deps.store.add(A, { kind: 'issue', entityId: h.addIssue(A, { title: 'a' }).id, at: h.now });
  const r1 = await tick(h, A, 'sec-a');
  roundDone(h, r1, '```json\n{"proposals":[{"title":"x"}]}\n```');
  noChildren(h);
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
  assert.equal(st.errors, 2, '子の課題の失敗と、前の形への移しの失敗');
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
  noChildren(h);
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

test('設計 2.7: 招いた人（ownerUserIds でも課題の宛先でもない人）のコメントは持ち主の返事にしない', async () => {
  const h = fakeHost(Date.parse('2026-11-24T00:00:00Z'));
  h.deps.cfgOf = async () => ({ ownerUserIds: ['owner-1', 'local-board'] });
  h.deps.store.add(A, { kind: 'issue', entityId: h.addIssue(A, { title: 'a' }).id, at: h.now });
  const r1 = await tick(h, A, 'sec-a');
  const round1 = roundDone(h, r1);
  const mine = h.addComment(round1.id, { authorType: 'user', authorUserId: 'owner-1', body: 'OWNER-SAYS' });
  const theirs = h.addComment(round1.id, { authorType: 'user', authorUserId: 'member-9', body: 'MEMBER-SAYS' });
  h.deps.store.add(A, { kind: 'comment', entityId: mine.id, issueId: round1.id, at: h.now });
  h.deps.store.add(A, { kind: 'comment', entityId: theirs.id, issueId: round1.id, at: h.now });
  h.deps.store.add(A, { kind: 'issue', entityId: h.addIssue(A, { title: 'b' }).id, at: h.now });
  h.advance(H);
  const r2 = await tick(h, A, 'sec-a');
  const body = h.issues.get(r2.created.id).description;
  assert.match(body, /OWNER-SAYS/, '持ち主の返事は入る');
  assert.doesNotMatch(body, /MEMBER-SAYS/, '招いた人のコメントは持ち主の返事にしない');
  assert.equal((await handleStatus(h.deps, A)).body.prefs, 1);
});

test('独立レビュー 2026-11-24: 続きの検索が 1 回落ちても前の形に戻さない・後ろの提案を止めない・backlog の子を拾う・返事だけ落ちた作成で二度作らない・確認待ちの子は古くても閉じない', async () => {
  const setup = async json => {
    const h = fakeHost(Date.parse('2026-11-21T00:00:00Z'));
    h.deps.store.add(A, { kind: 'issue', entityId: h.addIssue(A, { title: 'a' }).id, at: h.now });
    const r1 = await tick(h, A, 'sec-a');
    return { h, round: roundDone(h, r1, '```json\n' + json + '\n```') };
  };
  const three = '{"proposals":[{"title":"p1"},{"title":"p2"},{"title":"p3"}]}';
  // 1. 2 番だけ失敗 → 1・3 はできる。次の見回りの最初の検索が落ちても、見回りの課題は done のまま。その次で 2 もできる
  { const { h, round } = await setup(three);
    const create = h.deps.issues.create, list = h.deps.issues.list; let fail = true;
    h.deps.issues.create = async x => { if (fail && x.title === 'p2') throw new Error('busy'); return create(x); };
    await tick(h, A, 'sec-a');
    assert.deepEqual(kidsOf(h, round).map(k => k.title).sort(), ['p1', 'p3'], '失敗した提案の後ろも作る');
    let once = true;
    h.deps.issues.list = async q => { if (q.originId && once) { once = false; throw new Error('list down'); } return list(q); };
    await tick(h, A, 'sec-a');
    assert.equal(round.status, 'done', '子がある回は前の形に戻さない');
    fail = false; h.deps.issues.list = list;
    await tick(h, A, 'sec-a');
    assert.deepEqual(kidsOf(h, round).map(k => k.title).sort(), ['p1', 'p2', 'p3']); }
  // 2. 確認待ちで作れない本体: backlog で作り、動かすのが失敗しても次の見回りで確認待ちになる（見回りの課題は done のまま）
  { const { h, round } = await setup('{"proposals":[{"title":"p1"}]}');
    const create = h.deps.issues.create, update = h.deps.issues.update;
    h.deps.issues.create = async x => { if (x.originKind === PROPOSAL_ORIGIN && x.status === 'in_review') throw new Error('422'); return create(x); };
    h.deps.issues.update = async () => { throw new Error('busy'); };
    await tick(h, A, 'sec-a');
    assert.deepEqual(kidsOf(h, round).map(k => k.status), ['backlog']); assert.equal(round.status, 'done');
    h.deps.issues.update = update;
    await tick(h, A, 'sec-a');
    assert.deepEqual(kidsOf(h, round).map(k => k.status), ['in_review']); }
  // 3. 本体では作れていたが返事だけ落ちた: 探し直して二度作らない
  { const { h, round } = await setup('{"proposals":[{"title":"p1"}]}');
    const create = h.deps.issues.create;
    h.deps.issues.create = async x => { const made = await create(x); if (x.originKind === PROPOSAL_ORIGIN) throw new Error('timeout'); return made; };
    await tick(h, A, 'sec-a');
    assert.equal(kidsOf(h, round).length, 1); }
  // 4. 確認待ちの子は、古くても数が多くても自動では閉じない
  { const h = fakeHost(Date.parse('2026-11-21T00:00:00Z'));
    for (let i = 0; i < 130; i++) h.addIssue(A, { title: `new${i}`, status: 'in_review', originKind: PROPOSAL_ORIGIN, createdAt: new Date(h.now).toISOString() });
    const old = Array.from({ length: 30 }, (_, i) => h.addIssue(A, { title: `old${i}`, status: 'in_review', originKind: PROPOSAL_ORIGIN, createdAt: new Date(h.now - ROUND.closeReviewMs - 1000).toISOString() }));
    await tick(h, A, 'sec-a');
    assert.equal(old.filter(k => k.status === 'in_review').length, 30);
    assert.equal([...h.issues.values()].filter(k => k.title.startsWith('new') && k.status === 'in_review').length, 130); }
});

test('落ちた出来事を戻す: requeueDropped の回だけ・その会社の落ちだけを pending に戻して渡す', async () => {
  const h = fakeHost(Date.parse('2026-11-21T00:00:00Z'));
  const a = h.addIssue(A, { title: '落ちていた件' }), b = h.addIssue(B, { title: 'B 社の落ち' });
  h.deps.store.add(A, { kind: 'issue', entityId: a.id, at: h.now }); h.deps.store.add(B, { kind: 'issue', entityId: b.id, at: h.now });
  for (const r of h.deps.store.rows) Object.assign(r, { state: 'dropped', attempts: 2 });
  assert.equal((await tick(h, A, 'sec-a')).created, null, '普通の回では戻さない');
  const r = await tick(h, A, 'sec-a', { requeueDropped: true });
  assert.equal(r.requeued, 1);
  assert.equal(r.created?.events, 1, '戻した出来事を渡す');
  assert.equal(h.deps.store.rows.find(x => x.companyId === B).state, 'dropped', '別の会社の落ちは触らない');
  assert.equal((await tick(h, A, 'sec-a', { requeueDropped: true })).requeued, 0);
  assert.equal(h.deps.store.rows.find(x => x.companyId === A).attempts, 0, '数え直し');
  // 24 時間より古い落ちを戻した回は、知らせを作らない
  const g = fakeHost(Date.parse('2026-11-21T00:00:00Z'));
  g.deps.store.add(A, { kind: 'issue', entityId: g.addIssue(A, { title: '3 日前の落ち' }).id, at: g.now - 72 * H });
  g.deps.store.rows[0].state = 'dropped';
  const rg = await tick(g, A, 'sec-a', { requeueDropped: true });
  assert.equal(rg.requeued, 1); assert.equal(rg.created?.events, 1); assert.equal(rg.notice, undefined);
  assert.equal([...g.issues.values()].filter(x => x.originKind === NOTICE_ORIGIN).length, 0);
  const { dbStore } = await import('../plugins/secretary/src/worker.mjs');
  const seen = []; const store = dbStore({ namespace: 'ns', execute: async (q, p) => { seen.push([q, p]); }, query: async () => [] });
  await store.requeue(A);
  assert.match(seen[0][0], /SET state = 'pending', attempts = 0, round_issue_id = NULL.*WHERE company_id = \$1 AND state = 'dropped'/);
  assert.deepEqual(seen[0][1], [A]);
});
