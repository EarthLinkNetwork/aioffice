// mobile plugin の「アプリの話（チャット）」（plugins/mobile/src/chat.mjs）。
// 仕様: docs/review/2026-11-14-app-chat-spec.md の保証 1〜8・12・15・16。
// 試験用の通知 API（この test の中で立てる node の http server）と、本体の代わりの ctx を相手に確かめる。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { createHash } from 'node:crypto';
import { createNotifyClient, NOTIFY_API } from '../plugins/mobile/src/notify-client.mjs';
import { createChat, CHAT_ORIGIN_KIND, WAKE_AFTER_MS, FAILED_TEXT, OTHER_DEPARTMENT } from '../plugins/mobile/src/chat.mjs';
import manifest from '../plugins/mobile/src/manifest.mjs';

const KEY = 'project-key-for-chat-test-0123456789';
const CO = 'co1';
const T0 = Date.parse('2026-11-14T00:00:00Z');

// ---- 試験用の通知 API（plugin の口だけ） ----
function startNotify() {
  const s = { pending: [], sent: [], replies: [], statuses: [], agents: [], requests: [], failSent: 0, replyIds: new Set() };
  const server = http.createServer(async (req, res) => {
    let body = '';
    for await (const c of req) body += c;
    const json = body ? JSON.parse(body) : null;
    const p = new URL(req.url, 'http://x').pathname;
    s.requests.push(`${req.method} ${p}`);
    const send = (code, obj) => { res.writeHead(code, { 'content-type': 'application/json' }); res.end(JSON.stringify(obj ?? {})); };
    if ((req.headers.authorization || '') !== `Bearer ${KEY}`) return send(401, {});
    let m;
    if (req.method === 'GET' && p === '/api/v1/plugin/chat/pending') return send(200, { messages: s.pending.filter(x => !s.sent.some(y => y.id === x.id)) });
    if (req.method === 'POST' && (m = p.match(/^\/api\/v1\/plugin\/chat\/messages\/([^/]+)\/sent$/))) {
      if (s.failSent > 0) { s.failSent--; return send(500, { code: 'boom' }); }
      s.sent.push({ id: decodeURIComponent(m[1]), ...json }); return send(200, { ok: true });
    }
    if (req.method === 'PUT' && (m = p.match(/^\/api\/v1\/plugin\/bindings\/([^/]+)\/threads\/([^/]+)\/status$/))) { s.statuses.push({ b: m[1], t: m[2], ...json }); return send(200, { ok: true }); }
    if (req.method === 'POST' && (m = p.match(/^\/api\/v1\/plugin\/bindings\/([^/]+)\/threads\/([^/]+)\/replies$/))) {
      const fresh = !s.replyIds.has(json.commentId); s.replyIds.add(json.commentId);
      s.replies.push({ b: m[1], t: m[2], ...json }); return send(200, { ok: true, saved: fresh });
    }
    if (req.method === 'PUT' && (m = p.match(/^\/api\/v1\/plugin\/bindings\/([^/]+)\/agents$/))) { s.agents.push({ b: m[1], ...json }); return send(200, { ok: true }); }
    send(404, {});
  });
  return new Promise(r => server.listen(0, '127.0.0.1', () => r({ s, server, url: `http://127.0.0.1:${server.address().port}` })));
}

// ---- 本体の代わり（SDK の ctx の必要な所だけ） ----
function fakeHost(clock) {
  const state = new Map();
  const k = x => `${x.scopeKind}|${x.scopeId}|${x.namespace}|${x.stateKey}`;
  const h = { issues: new Map(), comments: new Map(), runs: new Map(), wakes: [], calls: [], agents: [], next: 1, failStateSetOnce: null, failCreate: 0, failComment: 0, logs: [] };
  const iso = () => new Date(clock.t).toISOString();
  const ctx = {
    state: {
      get: async x => structuredClone(state.get(k(x))),
      set: async (x, v) => { if (h.failStateSetOnce && h.failStateSetOnce(x, v)) { h.failStateSetOnce = null; throw new Error('state write failed'); } state.set(k(x), structuredClone(v)); },
    },
    logger: { warn: (m, meta) => h.logs.push(JSON.stringify([m, meta])), info: () => {} },
    issues: {
      create: async input => {
        if (h.failCreate > 0) { h.failCreate--; throw new Error('create failed'); }
        const id = `is${h.next++}`;
        const issue = { id, companyId: input.companyId, title: input.title, description: input.description, status: input.status, assigneeAgentId: input.assigneeAgentId, parentId: input.parentId || null, originKind: input.originKind, originId: input.originId, createdAt: iso() };
        h.issues.set(id, issue); h.calls.push(['create', id]); return structuredClone(issue);
      },
      get: async (id, co) => { const i = h.issues.get(id); return i && i.companyId === co ? structuredClone(i) : null; },
      list: async ({ companyId, originKind, originId }) => [...h.issues.values()].filter(i => i.companyId === companyId && (!originKind || i.originKind === originKind) && (!originId || i.originId === originId)).map(x => structuredClone(x)),
      update: async (id, patch, co) => { const i = h.issues.get(id); assert.equal(i.companyId, co); Object.assign(i, patch); h.calls.push(['update', id, patch]); return structuredClone(i); },
      createComment: async (issueId, body, co, opts = {}) => {
        if (h.failComment > 0) { h.failComment--; throw new Error('comment failed'); }
        const c = { id: `c${h.next++}`, companyId: co, issueId, authorType: 'user', authorAgentId: null, authorUserId: opts.actorUserId || null, body, createdAt: iso() };
        h.comments.set(issueId, [...(h.comments.get(issueId) || []), c]); h.calls.push(['comment', issueId, opts]); return structuredClone(c);
      },
      listComments: async issueId => { h.calls.push(['listComments', issueId]); return structuredClone(h.comments.get(issueId) || []); },
      requestWakeup: async (issueId, co, opts) => { h.wakes.push({ issueId, ...opts }); return { queued: true, runId: null }; },
      getSubtree: async (issueId, co, opts) => {
        const issues = [...h.issues.values()].filter(i => i.id === issueId || i.parentId === issueId);
        const assignees = Object.fromEntries(h.agents.map(a => [a.id, { id: a.id, name: a.name, role: a.role, title: a.title, status: a.status }]));
        return { rootIssueId: issueId, companyId: co, issueIds: issues.map(i => i.id), issues: structuredClone(issues), ...(opts?.includeAssignees ? { assignees } : {}) };
      },
      summaries: { getOrchestration: async ({ issueId }) => ({ issueId, companyId: CO, subtreeIssueIds: [issueId], runs: structuredClone(h.runs.get(issueId) || []), approvals: [], relations: {}, costs: {}, openBudgetIncidents: [], invocationBlocks: [] }) },
    },
    agents: { list: async () => structuredClone(h.agents), get: async id => structuredClone(h.agents.find(a => a.id === id) || null) },
  };
  // 担当・system の comment を本体の側で足す（出来事は試験から handler を呼ぶ）
  h.agentComment = (issueId, agentId, body, authorType = 'agent') => {
    const c = { id: `c${h.next++}`, companyId: CO, issueId, authorType, authorAgentId: authorType === 'agent' ? agentId : null, authorUserId: null, body, createdAt: iso() };
    h.comments.set(issueId, [...(h.comments.get(issueId) || []), c]); return c;
  };
  h.setState = (key, v) => state.set(`company|${CO}|mobile|${key}`, structuredClone(v));
  h.getState = key => structuredClone(state.get(`company|${CO}|mobile|${key}`));
  return { ctx, h };
}

async function setup(t, { config = {} } = {}) {
  const srv = await startNotify();
  t.after(() => srv.server.close());
  const clock = { t: T0 };
  const { ctx, h } = fakeHost(clock);
  h.agents = [
    { id: 'ag1', companyId: CO, name: '経理', role: 'general', title: '経理の担当', capabilities: '請求書と支払い', status: 'idle' },
    { id: 'ag2', companyId: CO, name: '営業', role: 'general', title: null, capabilities: null, status: 'idle' },
    { id: 'sec', companyId: CO, name: '秘書', role: 'general', title: '秘書', capabilities: '何でも受ける', status: 'idle' },
  ];
  h.setState('bindings', { b1: { userId: 'u1', status: 'active' }, bOld: { userId: 'u2', status: 'revoked' } });
  const notify = createNotifyClient({ baseUrl: srv.url, getKey: async () => KEY });
  const chat = createChat({ ctx, notifyFor: async () => notify, configFor: async () => config, now: () => clock.t });
  return { srv, s: srv.s, clock, ctx, h, chat };
}
const msg = (id, extra = {}) => ({ id, bindingId: 'b1', threadId: 't1', agentId: 'ag1', text: `発言 ${id}`, ...extra });

test('口の形: 通知 API の chat の口は契約の path と一字一句同じ', () => {
  assert.deepEqual(NOTIFY_API.putAgents('b 1'), ['PUT', '/api/v1/plugin/bindings/b%201/agents']);
  assert.deepEqual(NOTIFY_API.chatPending(), ['GET', '/api/v1/plugin/chat/pending']);
  assert.deepEqual(NOTIFY_API.chatSent('m1'), ['POST', '/api/v1/plugin/chat/messages/m1/sent']);
  assert.deepEqual(NOTIFY_API.putThreadStatus('b1', 't1'), ['PUT', '/api/v1/plugin/bindings/b1/threads/t1/status']);
  assert.deepEqual(NOTIFY_API.postReply('b1', 't1'), ['POST', '/api/v1/plugin/bindings/b1/threads/t1/replies']);
});

test('manifest: 仕様の前提の権限を持ち、版は 0.8.0', () => {
  for (const c of ['issues.read', 'issues.create', 'issues.update', 'issues.wakeup', 'issue.comments.read', 'issue.comments.create', 'issue.comments.create_human_attributed', 'issue.subtree.read', 'issues.orchestration.read', 'agents.read', 'events.subscribe']) {
    assert.ok(manifest.capabilities.includes(c), c);
  }
  assert.equal(manifest.version, '0.8.0');
  assert.ok(manifest.instanceConfigSchema.properties.departments);
  assert.ok(manifest.instanceConfigSchema.properties.secretaryId);
});

test('poll: 新しい話は、担当つき todo の課題（本文 = 最初の発言・題 = 先頭 40 字）を作り、comment は書かず、課題の id を添えて「送った」にする', async t => {
  const { s, h, chat } = await setup(t);
  const text = 'あ'.repeat(50) + '\n続き';
  s.pending.push(msg('m1', { text }));
  // 判断の件（card）が 1 件も無くても取りに行く
  const r = await chat.poll(CO);
  assert.equal(r.created, 1);
  const issue = [...h.issues.values()][0];
  assert.equal(issue.title, 'あ'.repeat(40));
  assert.equal(issue.description, text);
  assert.equal(issue.status, 'todo');
  assert.equal(issue.assigneeAgentId, 'ag1');
  assert.equal(issue.originKind, CHAT_ORIGIN_KIND);
  assert.equal(issue.originId, 'm1');
  assert.equal(h.calls.filter(c => c[0] === 'comment').length, 0);
  assert.deepEqual(s.sent, [{ id: 'm1', issueId: issue.id }]);
  assert.equal(h.wakes.length, 0);
  // 話の索引に入る
  const idx = h.getState('chatIssues');
  assert.equal(idx[issue.id].threadId, 't1');
  assert.equal(idx[issue.id].bindingId, 'b1');
});

test('poll: 続きの発言は結びつけの持ち主の名前の comment にし、requestWakeup は呼ばない', async t => {
  const { s, h, chat, clock } = await setup(t);
  s.pending.push(msg('m1'));
  await chat.poll(CO);
  const issueId = s.sent[0].issueId;
  h.issues.get(issueId).status = 'in_progress';
  clock.t += 60_000;
  s.pending.push(msg('m2', { threadIssueId: issueId, text: '追加の質問' }));
  const r = await chat.poll(CO);
  assert.equal(r.commented, 1);
  const cs = h.comments.get(issueId);
  assert.equal(cs.length, 1);
  assert.equal(cs[0].body, '追加の質問');
  assert.equal(cs[0].authorUserId, 'u1');
  assert.equal(h.calls.filter(c => c[0] === 'update').length, 0);
  assert.equal(h.wakes.length, 0);
  assert.deepEqual(s.sent[1], { id: 'm2', issueId, commentId: cs[0].id });
  // threadIssueId が無くても、話の索引から課題を引く
  s.pending.push(msg('m3', { text: '三つ目' }));
  await chat.poll(CO);
  assert.equal(h.comments.get(issueId).length, 2);
  assert.equal(h.issues.size, 1);
});

test('poll: 閉じた課題（done・cancelled）は todo に戻してから comment を書く', async t => {
  for (const closed of ['done', 'cancelled']) {
    const { s, h, chat } = await setup(t);
    s.pending.push(msg('m1'));
    await chat.poll(CO);
    const issueId = s.sent[0].issueId;
    h.issues.get(issueId).status = closed;
    s.pending.push(msg('m2', { threadIssueId: issueId }));
    await chat.poll(CO);
    const order = h.calls.filter(c => c[0] === 'update' || c[0] === 'comment').map(c => c[0]);
    assert.deepEqual(order, ['update', 'comment'], closed);
    assert.deepEqual(h.calls.find(c => c[0] === 'update')[2], { status: 'todo' });
    assert.equal(h.issues.get(issueId).status, 'todo');
  }
});

test('poll: やり直しても二重に作らない（「送った」が失敗・state の書き込みが途中で失敗）', async t => {
  const { s, h, chat } = await setup(t);
  s.pending.push(msg('m1'));
  s.failSent = 1;
  await chat.poll(CO); // 課題は作れたが「送った」が通らない
  assert.equal(h.issues.size, 1);
  assert.equal(s.sent.length, 0);
  await chat.poll(CO);
  assert.equal(h.issues.size, 1);
  assert.equal(s.sent.length, 1);
  const issueId = s.sent[0].issueId;
  // 続き: comment を書いた後の state の書き込みが落ちても、やり直しで 2 つ目を書かない
  s.pending.push(msg('m2', { threadIssueId: issueId }));
  h.failStateSetOnce = (x, v) => x.stateKey === 'chatMessages' && v.m2?.commentId;
  await chat.poll(CO).catch(() => {});
  await chat.poll(CO);
  assert.equal(h.comments.get(issueId).length, 1);
  assert.equal(s.sent.filter(x => x.id === 'm2').length, 1);
  assert.equal(s.sent.find(x => x.id === 'm2').commentId, h.comments.get(issueId)[0].id);
  // 新しい話: 課題を作った後の state の書き込みが落ちても、やり直しで 2 つ目の課題を作らない（originId で見つける）
  s.pending.push(msg('m9', { threadId: 't9' }));
  h.failStateSetOnce = (x, v) => x.stateKey === 'chatMessages' && v.m9?.issueId;
  await chat.poll(CO).catch(() => {});
  await chat.poll(CO);
  assert.equal([...h.issues.values()].filter(i => i.originId === 'm9').length, 1);
  const m9 = [...h.issues.values()].find(i => i.originId === 'm9');
  assert.equal((h.comments.get(m9.id) || []).length, 0); // 最初の発言を comment にしない
  assert.equal(s.sent.find(x => x.id === 'm9').issueId, m9.id);
  assert.equal(s.sent.filter(x => x.id === 'm9').length, 1);
});

test('poll: 新しい話の課題を作るのが一時的に失敗したら、同じ話の後の発言はその回は書かず、次の回に順に 1 つの課題へ書く', async t => {
  const { s, h, chat } = await setup(t);
  s.pending.push(msg('m1'), msg('m2'));
  h.failCreate = 1;
  const r = await chat.poll(CO);
  assert.equal(r.failed, 1);
  assert.equal(h.issues.size, 0); // m2 で別の課題を作らない
  assert.equal(s.sent.length, 0);
  await chat.poll(CO);
  assert.equal(h.issues.size, 1);
  const [issue] = [...h.issues.values()];
  assert.equal(issue.originId, 'm1');
  assert.equal(issue.description, '発言 m1');
  assert.deepEqual((h.comments.get(issue.id) || []).map(c => c.body), ['発言 m2']); // 発言の順を保つ
  assert.deepEqual(s.sent.map(x => [x.id, x.issueId]), [['m1', issue.id], ['m2', issue.id]]);
  assert.equal(Object.keys(h.getState('chatIssues')).length, 1);
});

test('poll: 新しい話のやり直しで発言の課題が無く、話に別の課題がある時は、新しい課題を作らずその課題への comment にする', async t => {
  const { s, h, chat } = await setup(t);
  // 前の回: m1 を新しい話として記録した後に落ち、同じ話の m2 が先に課題を作った（前の版の動き）
  s.pending.push(msg('m2'));
  await chat.poll(CO);
  const issueId = s.sent[0].issueId;
  const msgs = h.getState('chatMessages');
  msgs.m1 = { kind: 'created', threadId: 't1', bindingId: 'b1', at: new Date(T0).toISOString() };
  h.setState('chatMessages', msgs);
  s.pending.push(msg('m1'));
  await chat.poll(CO);
  assert.equal(h.issues.size, 1);
  assert.deepEqual((h.comments.get(issueId) || []).map(c => c.body), ['発言 m1']);
  assert.deepEqual(s.sent.find(x => x.id === 'm1'), { id: 'm1', issueId, commentId: h.comments.get(issueId)[0].id });
  assert.equal(Object.keys(h.getState('chatIssues')).length, 1);
});

test('poll: 同じ本文の発言が続いても、やり直しで前の発言の comment と取り違えない', async t => {
  const { s, h, clock, chat } = await setup(t);
  s.pending.push(msg('m1'));
  await chat.poll(CO);
  const issueId = s.sent[0].issueId;
  s.pending.push(msg('m2', { text: 'はい' }));
  await chat.poll(CO);
  const c2 = h.comments.get(issueId)[0].id;
  // comment が書けなかった: やり直しで m2 の comment を m3 の物にしない
  clock.t += 10_000;
  s.pending.push(msg('m3', { text: 'はい' }));
  h.failComment = 1;
  await chat.poll(CO);
  assert.equal(s.sent.filter(x => x.id === 'm3').length, 0);
  clock.t += 1_000;
  await chat.poll(CO);
  const comments = h.comments.get(issueId);
  assert.deepEqual(comments.map(c => c.body), ['はい', 'はい']);
  assert.equal(s.sent.find(x => x.id === 'm3').commentId, comments[1].id);
  assert.notEqual(comments[1].id, c2);
  // comment は書けたが記録の書き込みで落ちた: やり直しで自分の comment を見つけ、前の発言の comment を返さない
  clock.t += 10_000;
  s.pending.push(msg('m4', { text: 'はい' }));
  h.failStateSetOnce = (x, v) => x.stateKey === 'chatMessages' && v.m4?.commentId;
  await chat.poll(CO).catch(() => {});
  clock.t += 1_000;
  await chat.poll(CO);
  const after = h.comments.get(issueId);
  assert.equal(after.length, 3);
  assert.equal(s.sent.find(x => x.id === 'm4').commentId, after[2].id);
  assert.equal(new Set(s.sent.filter(x => x.commentId).map(x => x.commentId)).size, 3);
});

test('poll: この会社の active な結びつけでない発言・会社に居ない担当・ほかの結びつけの話の課題は扱わない', async t => {
  const { s, h, chat } = await setup(t);
  s.pending.push(msg('mx', { bindingId: 'bOther' }), msg('my', { bindingId: 'bOld' }), msg('mz', { agentId: 'ghost', threadId: 't2' }));
  const r = await chat.poll(CO);
  assert.equal(h.issues.size, 0);
  assert.equal(s.sent.length, 0);
  assert.equal(r.skipped, 3);
  // 話の課題を別の結びつけの発言から書かせない
  s.pending.push(msg('m1'));
  await chat.poll(CO);
  const issueId = s.sent[0].issueId;
  h.setState('bindings', { b1: { userId: 'u1', status: 'active' }, b2: { userId: 'u2', status: 'active' } });
  s.pending.push(msg('m2', { bindingId: 'b2', threadId: 'tz', threadIssueId: issueId }));
  await chat.poll(CO);
  assert.equal((h.comments.get(issueId) || []).length, 0);
  assert.equal(s.sent.filter(x => x.id === 'm2').length, 0);
});

test('返事: 話の課題の担当の comment だけを返事として渡し、自分の comment・system・ほかの担当・ほかの課題は返さない。同じ comment は 1 回', async t => {
  const { s, h, chat } = await setup(t);
  s.pending.push(msg('m1'));
  await chat.poll(CO);
  const issueId = s.sent[0].issueId;
  const ev = c => ({ eventId: `e-${c.id}`, eventType: 'issue.comment.created', companyId: CO, entityId: c.issueId, entityType: 'issue', payload: { commentId: c.id, issueId: c.issueId } });
  // 子の課題（秘書が回した先など）の comment
  const child = await (async () => { const id = 'child1'; h.issues.set(id, { id, companyId: CO, status: 'todo', assigneeAgentId: 'ag2', parentId: issueId }); return id; })();
  const cChild = h.agentComment(child, 'ag2', '子の課題の返事');
  await chat.onCommentCreated(ev(cChild));
  const cSys = h.agentComment(issueId, null, 'system の記録', 'system');
  await chat.onCommentCreated(ev(cSys));
  const cOther = h.agentComment(issueId, 'ag2', 'ほかの担当の comment');
  await chat.onCommentCreated(ev(cOther));
  await chat.poll(CO); // 自分（人の名前）の comment は無い。続きを書いて確かめる
  s.pending.push(msg('m2', { threadIssueId: issueId, text: '人の発言' }));
  await chat.poll(CO);
  const mine = h.comments.get(issueId).find(c => c.authorType === 'user');
  await chat.onCommentCreated(ev(mine));
  assert.equal(s.replies.length, 0);
  const cAgent = h.agentComment(issueId, 'ag1', '担当の返事です');
  await chat.onCommentCreated(ev(cAgent));
  assert.deepEqual(s.replies, [{ b: 'b1', t: 't1', commentId: cAgent.id, text: '担当の返事です', role: 'agent' }]);
  await chat.onCommentCreated(ev(cAgent));
  assert.equal(s.replies.length, 1);
  // 索引に無い課題の出来事は、本体を読みに行かない
  const before = h.calls.filter(c => c[0] === 'listComments').length;
  await chat.onCommentCreated({ eventType: 'issue.comment.created', companyId: CO, entityId: 'unrelated', entityType: 'issue', payload: { commentId: 'cz' } });
  assert.equal(h.calls.filter(c => c[0] === 'listComments').length, before);
});

test('sync: 出来事を取りこぼした返事を読み直して渡す。読み直すのは直近 24 時間に発言のあった話だけ・最大 20 件', async t => {
  const { s, h, chat, clock } = await setup(t);
  for (let i = 0; i < 25; i++) { s.pending.push(msg(`n${i}`, { threadId: `t${i}` })); clock.t += 1000; await chat.poll(CO); }
  const idx = h.getState('chatIssues');
  const ids = Object.keys(idx);
  assert.equal(ids.length, 25);
  // 1 件は 25 時間前の発言にする
  const oldId = s.sent.find(x => x.id === 'n24').issueId;
  idx[oldId].lastMessageAt = new Date(clock.t - 25 * 3600_000).toISOString();
  h.setState('chatIssues', idx);
  const newest = s.sent.find(x => x.id === 'n23').issueId;
  const c = h.agentComment(newest, 'ag1', '取りこぼした返事');
  h.calls.length = 0;
  await chat.sync(CO);
  const read = new Set(h.calls.filter(x => x[0] === 'listComments').map(x => x[1]));
  assert.equal(read.size, 20);
  assert.ok(!read.has(oldId));
  assert.ok(read.has(newest));
  assert.equal(s.replies.filter(r => r.commentId === c.id).length, 1);
  await chat.sync(CO);
  assert.equal(s.replies.filter(r => r.commentId === c.id).length, 1);
});

test('sync: 発言から 3 分たって返事も実行も無い時だけ、発言の id で 1 回だけ起こす', async t => {
  const { s, h, chat, clock } = await setup(t);
  s.pending.push(msg('m1'));
  await chat.poll(CO);
  const issueId = s.sent[0].issueId;
  clock.t += WAKE_AFTER_MS - 1000;
  await chat.sync(CO);
  assert.equal(h.wakes.length, 0);
  clock.t += 2000;
  await chat.sync(CO);
  assert.equal(h.wakes.length, 1);
  assert.equal(h.wakes[0].issueId, issueId);
  assert.equal(h.wakes[0].idempotencyKey, 'm1');
  await chat.sync(CO);
  assert.equal(h.wakes.length, 1);
  // 続きの発言: 実行が始まっていれば起こさない
  s.pending.push(msg('m2', { threadIssueId: issueId }));
  await chat.poll(CO);
  h.runs.set(issueId, [{ id: 'r1', issueId, agentId: 'ag1', status: 'running', createdAt: new Date(clock.t + 1000).toISOString() }]);
  clock.t += WAKE_AFTER_MS + 5000;
  await chat.sync(CO);
  assert.equal(h.wakes.length, 1);
  // 続きの発言: 返事があれば起こさない
  s.pending.push(msg('m3', { threadIssueId: issueId }));
  await chat.poll(CO);
  h.agentComment(issueId, 'ag1', '返事');
  clock.t += WAKE_AFTER_MS + 5000;
  await chat.sync(CO);
  assert.equal(h.wakes.length, 1);
});

test('sync: 発言の後の最後の実行が失敗なら「返事できませんでした」の system の返事と failed を 1 回だけ出す', async t => {
  const { s, h, chat, clock } = await setup(t);
  s.pending.push(msg('m1'));
  await chat.poll(CO);
  const issueId = s.sent[0].issueId;
  h.issues.get(issueId).status = 'in_progress';
  clock.t += 30_000;
  h.runs.set(issueId, [
    { id: 'r1', issueId, agentId: 'ag1', status: 'succeeded', createdAt: new Date(clock.t - 20_000).toISOString() },
    { id: 'r2', issueId, agentId: 'ag1', status: 'failed', createdAt: new Date(clock.t - 10_000).toISOString() },
  ]);
  await chat.sync(CO);
  const sys = s.replies.filter(r => r.role === 'system');
  assert.equal(sys.length, 1);
  assert.equal(sys[0].text, FAILED_TEXT);
  assert.equal(FAILED_TEXT, '返事できませんでした');
  assert.equal(s.statuses.at(-1).status, 'failed');
  await chat.sync(CO);
  assert.equal(s.replies.filter(r => r.role === 'system').length, 1);
  assert.equal(s.statuses.filter(x => x.status === 'failed').length, 1);
  // 発言の前の失敗は今の話の失敗にしない
  s.pending.push(msg('m2', { threadIssueId: issueId }));
  clock.t += 1000;
  await chat.poll(CO);
  await chat.sync(CO);
  assert.equal(s.statuses.at(-1).status, 'waiting');
});

test('sync: 話の状態を課題の状態と子の課題から作り、変わった時だけ送る', async t => {
  const { s, h, chat } = await setup(t);
  h.agents.push({ id: 'ag3', companyId: CO, name: '法務', role: 'general', title: null, status: 'idle' });
  s.pending.push(msg('m1', { agentId: 'sec' }));
  await chat.poll(CO);
  const issueId = s.sent[0].issueId;
  await chat.sync(CO);
  assert.deepEqual(s.statuses, [{ b: 'b1', t: 't1', status: 'waiting' }]);
  await chat.sync(CO);
  assert.equal(s.statuses.length, 1);
  h.issues.get(issueId).status = 'in_progress';
  h.issues.set('ch1', { id: 'ch1', companyId: CO, status: 'todo', assigneeAgentId: 'ag3', parentId: issueId, createdAt: new Date(T0).toISOString() });
  await chat.sync(CO);
  assert.deepEqual(s.statuses.at(-1), { b: 'b1', t: 't1', status: 'waiting', handedTo: '法務' });
  h.issues.get('ch1').status = 'done';
  h.issues.get(issueId).status = 'done';
  await chat.sync(CO);
  assert.deepEqual(s.statuses.at(-1), { b: 'b1', t: 't1', status: 'done' });
  assert.equal(s.statuses.length, 3);
});

test('sync: 担当の一覧を設定の部署で分け、設定に無い担当は「その他」。中身が変わった時だけ送る', async t => {
  const config = { departments: { [CO]: [{ key: 'back', name: '管理', agentIds: ['ag1', 'sec'] }], other: [{ key: 'x', name: 'x', agentIds: ['ag2'] }] }, secretaryId: { [CO]: 'sec' } };
  const { s, h, chat } = await setup(t, { config });
  h.agents.push({ id: 'gone', companyId: CO, name: '退職', role: 'general', title: null, status: 'terminated' });
  await chat.sync(CO);
  assert.equal(s.agents.length, 1);
  assert.deepEqual(s.agents[0], {
    b: 'b1',
    secretaryId: 'sec',
    companyId: CO,
    departments: [
      { key: 'back', name: '管理', agents: [{ id: 'ag1', name: '経理', role: '経理の担当', blurb: '請求書と支払い' }, { id: 'sec', name: '秘書', role: '秘書', blurb: '何でも受ける' }] },
      { key: OTHER_DEPARTMENT.key, name: 'その他', agents: [{ id: 'ag2', name: '営業', role: 'general', blurb: '' }] },
    ],
  });
  await chat.sync(CO);
  assert.equal(s.agents.length, 1);
  h.agents[1].name = '営業部';
  await chat.sync(CO);
  assert.equal(s.agents.length, 2);
  assert.equal(s.agents[1].departments[1].agents[0].name, '営業部');
  // 結びつけが増えたら、その結びつけには送る
  h.setState('bindings', { b1: { userId: 'u1', status: 'active' }, b2: { userId: 'u2', status: 'active' } });
  await chat.sync(CO);
  assert.deepEqual(s.agents.slice(2).map(x => x.b), ['b2']);
  assert.equal(s.agents[2].companyId, CO);
});

test('sync: companyId の無い形で送り済みの結びつけにも、companyId を足した形を 1 回だけ送り直す', async t => {
  const config = { departments: { [CO]: [{ key: 'back', name: '管理', agentIds: ['ag1', 'sec'] }] }, secretaryId: { [CO]: 'sec' } };
  const { s, h, chat } = await setup(t, { config });
  // 0.5.0 の初版は { departments, secretaryId } の hash を記録していた
  const departments = [
    { key: 'back', name: '管理', agents: [{ id: 'ag1', name: '経理', role: '経理の担当', blurb: '請求書と支払い' }, { id: 'sec', name: '秘書', role: '秘書', blurb: '何でも受ける' }] },
    { key: OTHER_DEPARTMENT.key, name: 'その他', agents: [{ id: 'ag2', name: '営業', role: 'general', blurb: '' }] },
  ];
  const oldHash = createHash('sha256').update(JSON.stringify({ departments, secretaryId: 'sec' })).digest('hex').slice(0, 32);
  h.setState('chatAgents', { b1: oldHash });
  await chat.sync(CO);
  assert.equal(s.agents.length, 1);
  assert.equal(s.agents[0].companyId, CO);
  assert.deepEqual(s.agents[0].departments, departments);
  await chat.sync(CO);
  assert.equal(s.agents.length, 1);
});

test('notify-client: putAgents は companyId を body に入れる', async t => {
  const srv = await startNotify();
  t.after(() => srv.server.close());
  const notify = createNotifyClient({ baseUrl: srv.url, getKey: async () => KEY });
  await notify.putAgents('b1', { departments: [], secretaryId: undefined, companyId: CO });
  assert.deepEqual(srv.s.agents, [{ b: 'b1', departments: [], secretaryId: null, companyId: CO }]);
});

test('worker: 口 /v1/tick の poll は判断の件が無くても未送の発言を取り、出来事 issue.comment.created で返事を渡す', async t => {
  const { default: plugin } = await import('../plugins/mobile/src/worker.mjs');
  const srv = await startNotify();
  t.after(() => srv.server.close());
  const clock = { t: T0 };
  const { ctx, h } = fakeHost(clock);
  h.agents = [{ id: 'ag1', companyId: CO, name: '経理', role: 'general', status: 'idle' }];
  h.setState('bindings', { b1: { userId: 'u1', status: 'active' } });
  const handlers = {};
  Object.assign(ctx, {
    config: { get: async () => ({ notifyUrl: srv.url, notifyKey: { type: 'secret_ref', secretId: 's1' } }) },
    secrets: { resolve: async () => KEY },
    http: { fetch: (u, i) => fetch(u, i) },
    companies: { list: async () => [{ id: CO }], get: async () => ({ id: CO }) },
    events: { on: (ev, fn) => { handlers[ev] = fn; } },
    actions: { register: () => {} },
    access: { members: { list: async () => [{ principalType: 'user', principalId: 'u1', status: 'active', membershipRole: 'owner' }] } },
    approvals: { list: async () => [], get: async () => null },
  });
  ctx.issues.list = async q => (q.status ? [] : [...h.issues.values()].filter(i => i.originId === q.originId));
  ctx.issues.listInteractions = async () => [];
  await plugin.definition.setup(ctx);
  srv.s.pending.push(msg('m1'));
  const r = await plugin.definition.onApiRequest({ routeKey: 'tick', companyId: CO, query: { what: 'poll' }, params: {}, body: null, actor: {} });
  assert.equal(r.status, 200);
  assert.equal(r.body.chat.created, 1);
  const issueId = srv.s.sent[0].issueId;
  const c = h.agentComment(issueId, 'ag1', '返事');
  await handlers['issue.comment.created']({ eventType: 'issue.comment.created', companyId: CO, entityId: issueId, entityType: 'issue', payload: { commentId: c.id } });
  assert.deepEqual(srv.s.replies.map(x => x.commentId), [c.id]);
  const s2 = await plugin.definition.onApiRequest({ routeKey: 'tick', companyId: CO, query: { what: 'sync' }, params: {}, body: null, actor: {} });
  assert.equal(s2.body.chat.synced, true);
  assert.equal(srv.s.agents.length, 1);
});

test('poll: 判断の件から始めた話は、card と話をその人ごとに結び付ける（docs/design/2026-11-22-app-card-ux.md 2.2）', async t => {
  const { s, h, chat } = await setup(t);
  s.pending.push(msg('m1', { text: '判断の件から: 会議の日程', cardId: 'decision:co1:d1' }));
  await chat.poll(CO);
  const issue = [...h.issues.values()][0];
  const links = h.getState('cardThreads');
  assert.deepEqual(Object.keys(links), ['decision:co1:d1']);
  assert.equal(links['decision:co1:d1'].b1.issueId, issue.id);
  assert.equal(links['decision:co1:d1'].b1.threadId, 't1');
  assert.equal(links['decision:co1:d1'].b1.agentId, 'ag1');
  // card の無い話は結び付けない
  s.pending.push(msg('m2', { threadId: 't2', text: 'ふつうの話' }));
  await chat.poll(CO);
  assert.deepEqual(Object.keys(h.getState('cardThreads')), ['decision:co1:d1']);
});
