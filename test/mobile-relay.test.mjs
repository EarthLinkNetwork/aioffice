// mobile plugin の「通知 API へ送る・押された操作を反映する」（plugins/mobile/src/relay.mjs）。
// 試験用の通知 API（この test の中で立てる node の http server）を相手に確かめる。
import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { createNotifyClient, NOTIFY_API } from '../plugins/mobile/src/notify-client.mjs';
import { createDecisionsClient, DECISION_PATHS } from '../plugins/mobile/src/decisions-client.mjs';
import { createRelay, cardVersion, ACTION_TTL_MS, companyOfCardKey, cardKeyOf, kindOfCardKey, stoppedRows } from '../plugins/mobile/src/relay.mjs';

const KEY = 'project-key-for-test-0123456789';
const CO = 'co1';

// ---- 試験用の通知 API と本体の decisions の口 ----
function startServer() {
  const s = { cards: new Map(), puts: [], deletes: [], actions: [], results: new Map(), bindings: new Map(), requests: [], decisions: [], decided: [], dismissed: [], responded: [], moved: [], onMove: null, userKeys: new Map(), nextBinding: 1 };
  const server = http.createServer(async (req, res) => {
    let body = '';
    for await (const c of req) body += c;
    const json = body ? JSON.parse(body) : null;
    const url = new URL(req.url, 'http://x');
    const p = url.pathname;
    s.requests.push(`${req.method} ${p}`);
    const send = (code, obj) => { res.writeHead(code, { 'content-type': 'application/json' }); res.end(obj === undefined ? '' : JSON.stringify(obj)); };
    const auth = (req.headers.authorization || '').replace(/^Bearer /, '');
    // 本体の decisions の口（board API key の持ち主で答える）
    if (p.startsWith('/api/companies/') || p.startsWith('/api/decisions/') || p.startsWith('/api/issues/')) {
      const user = s.userKeys.get(auth);
      if (!user) return send(401, { error: 'unauthorized' });
      let m;
      if (req.method === 'GET' && (m = p.match(/^\/api\/companies\/([^/]+)\/decisions$/))) return send(200, s.decisions.filter(d => d.status === url.searchParams.get('status')));
      if (req.method === 'POST' && (m = p.match(/^\/api\/decisions\/([^/]+)\/decide$/))) {
        const d = s.decisions.find(x => x.id === decodeURIComponent(m[1]));
        if (!d || d.status !== 'open') return send(409, { error: 'not open' });
        d.status = 'decided'; s.decided.push({ id: d.id, user, ...json });
        return send(200, { ok: true });
      }
      if (req.method === 'PATCH' && (m = p.match(/^\/api\/issues\/([^/]+)$/))) {
        s.moved.push({ issueId: decodeURIComponent(m[1]), user, ...json });
        const st = s.onMove ? s.onMove(decodeURIComponent(m[1]), json) : 200;
        return send(st, st === 200 ? { id: decodeURIComponent(m[1]), status: json.status } : { error: 'refused' });
      }
      if (req.method === 'POST' && (m = p.match(/^\/api\/issues\/([^/]+)\/interactions\/([^/]+)\/respond$/))) {
        s.responded.push({ issueId: decodeURIComponent(m[1]), id: decodeURIComponent(m[2]), user, ...json });
        return send(200, { ok: true });
      }
      if (req.method === 'POST' && (m = p.match(/^\/api\/decisions\/([^/]+)\/dismiss$/))) {
        const d = s.decisions.find(x => x.id === decodeURIComponent(m[1]));
        if (!d || d.status !== 'open') return send(409, { error: 'not open' });
        d.status = 'decided'; s.dismissed.push({ id: d.id, user, ...json });
        return send(200, { ok: true });
      }
      return send(404, {});
    }
    if (auth !== KEY) return send(401, { error: 'unauthorized' });
    let m;
    if ((m = p.match(/^\/api\/v1\/plugin\/bindings\/([^/]+)\/cards\/([^/]+)$/))) {
      const [bid, cid] = [decodeURIComponent(m[1]), decodeURIComponent(m[2])];
      // 本物の通知 API と同じく、id の頭が 3 つの種類でなければ断る（ELN Platform の notify の parseMobileCardId）
      if (!/^(approval|interaction|decision):.+/.test(cid)) return send(400, { code: 'invalid-card-id' });
      if (s.bindings.get(bid)?.state !== 'active') return send(404, { code: 'binding-inactive' });
      if (req.method === 'PUT') { s.cards.set(`${bid}|${cid}`, json); s.puts.push({ bid, cid, push: json.push, version: json.version }); return send(200, { ok: true }); }
      if (req.method === 'DELETE') { s.cards.delete(`${bid}|${cid}`); s.deletes.push({ bid, cid }); return send(200, { ok: true }); }
    }
    if (req.method === 'GET' && p === '/api/v1/plugin/actions') return send(200, { actions: s.actions.filter(a => !s.results.has(a.id)) });
    if (req.method === 'POST' && (m = p.match(/^\/api\/v1\/plugin\/actions\/([^/]+)\/result$/))) { s.results.set(decodeURIComponent(m[1]), json); return send(200, { ok: true }); }
    if (req.method === 'POST' && p === '/api/v1/plugin/bindings') { const id = `b${s.nextBinding++}`; s.bindings.set(id, { state: 'waiting' }); return send(200, { bindingId: id, code: 'c'.repeat(32), expiresAt: null }); }
    if ((m = p.match(/^\/api\/v1\/plugin\/bindings\/([^/]+)(\/confirm)?$/))) {
      const b = s.bindings.get(decodeURIComponent(m[1]));
      if (!b) return send(404, {});
      if (req.method === 'GET') return send(200, b);
      if (req.method === 'POST' && m[2]) { b.state = json.accept ? 'active' : 'rejected'; return send(200, { state: b.state }); }
      if (req.method === 'DELETE') { b.state = 'revoked'; return send(200, { ok: true }); }
    }
    send(404, {});
  });
  return new Promise(r => server.listen(0, '127.0.0.1', () => r({ s, server, url: `http://127.0.0.1:${server.address().port}` })));
}

// ---- 本体の代わり（SDK の ctx の必要な所だけ） ----
function fakeCtx() {
  const state = new Map();
  const k = x => `${x.scopeKind}|${x.scopeId}|${x.namespace}|${x.stateKey}`;
  const h = { approvals: [], interactions: [], issues: [{ id: 'is1', status: 'in_progress' }], members: [], decideCalls: [], respondCalls: [], logs: [], decideThrows: false, comments: {}, written: [], wakes: [], agents: [{ id: 'g1', name: '事務担当' }], company: { id: CO, name: '見本の会社' } };
  const ctx = {
    // 本体と同じく、値に null・undefined は書けない（2026-11-25 実物で止まりの状態に null を書いて sync が落ちた）
    state: { get: async x => structuredClone(state.get(k(x))), set: async (x, v) => { if (v == null) throw new Error('state value must not be null'); state.set(k(x), structuredClone(v)); } },
    logger: { warn: (m, meta) => h.logs.push(JSON.stringify([m, meta])), info: (m, meta) => h.logs.push(JSON.stringify([m, meta])) },
    access: { members: { list: async () => h.members } },
    companies: { get: async () => h.company },
    agents: { list: async () => h.agents },
    approvals: {
      list: async () => h.approvals.filter(a => a.status === 'pending'),
      get: async id => h.approvals.find(a => a.id === id) || null,
      decide: async (id, input) => { if (h.decideThrows) throw new Error('forbidden'); h.decideCalls.push({ id, ...input }); const a = h.approvals.find(x => x.id === id); a.status = input.action === 'approve' ? 'approved' : 'rejected'; return { approval: a, applied: true }; },
    },
    issues: {
      list: async ({ status }) => h.issues.filter(i => i.status === status).map(i => (typeof i.description === 'string' && i.description.length > 1200 ? { ...i, description: i.description.slice(0, 1200) } : i)),
      get: async id => h.issues.find(i => i.id === id) || null,
      listInteractions: async issueId => h.interactions.filter(i => i.issueId === issueId),
      listComments: async issueId => h.comments[issueId] || [],
      createComment: async (issueId, body, _co, opts) => { h.written.push({ issueId, body, ...opts }); return { id: `c${h.written.length}` }; },
      requestWakeup: async (issueId, _co, opts) => { h.wakes.push({ issueId, ...opts }); return { queued: true }; },
      respondInteraction: async (issueId, id, input) => { h.respondCalls.push({ issueId, id, ...input }); const i = h.interactions.find(x => x.id === id); i.status = input.action === 'accept' ? 'accepted' : 'rejected'; return { interaction: i, applied: true }; },
    },
  };
  return { ctx, h };
}

const member = userId => ({ principalType: 'user', principalId: userId, status: 'active', membershipRole: 'operator' });
const approval = (id, title = '返信の承認', extra = {}) => ({ id, companyId: CO, type: 'request_board_approval', status: 'pending', payload: { title, summary: 's', replyBody: '本文' }, createdAt: '2026-11-10T00:00:00Z', requestedByAgentId: 'g1', ...extra });

let srv, ctx, h, relay, clock;
async function bind(userId) {
  const r = await relay.bindings.start(CO, userId);
  srv.s.bindings.get(r.bindingId).state = 'claimed';
  srv.s.bindings.get(r.bindingId).email = `${userId}@example.com`;
  const c = await relay.bindings.confirm(CO, userId, r.bindingId, true);
  assert.equal(c.ok, true);
  return r.bindingId;
}
const sentOf = async () => (await ctx.state.get({ scopeKind: 'company', scopeId: CO, namespace: 'mobile', stateKey: 'sent' })) || {};
const press = async (over = {}) => {
  const sent = await sentOf();
  const cardId = over.cardId ?? Object.keys(sent)[0];
  // アプリが返す版は、その人に送った版（送り先ごとに飾りが違う・docs/design/2026-11-22-app-card-ux.md 2.0）
  const r = sent[cardId]?.recipients;
  const version = r && !Array.isArray(r) && over.bindingId && Object.hasOwn(r, over.bindingId) ? r[over.bindingId] : sent[cardId]?.version;
  const a = { id: `act-${srv.s.actions.length + 1}`, cardId, bindingId: over.bindingId, actionId: 'approve', version, values: {}, pressedAt: new Date(clock).toISOString(), ...over };
  srv.s.actions.push(a);
  return a;
};

beforeEach(async () => {
  srv = await startServer();
  ({ ctx, h } = fakeCtx());
  clock = Date.parse('2026-11-11T00:00:00Z');
  const notify = createNotifyClient({ baseUrl: srv.url, getKey: async () => KEY });
  const decisions = createDecisionsClient({ baseUrl: srv.url });
  relay = createRelay({ ctx, notifyFor: async () => notify, decisionsFor: async () => decisions, now: () => clock });
  h.members = [member('u1'), member('u2')];
});
afterEach(() => srv.server.close());

test('初めて入れる回は今ある件を受信箱に入れるだけで push しない・その後に出た件は push する', async () => {
  const b1 = await bind('u1');
  h.approvals.push(approval('a1'));
  await relay.syncCompany(CO);
  assert.deepEqual(srv.s.puts.map(p => [p.bid, p.cid, p.push]), [[b1, 'approval:co1:a1', false]]);
  h.approvals.push(approval('a2', '別の返信'));
  await relay.syncCompany(CO);
  assert.deepEqual(srv.s.puts.slice(1).map(p => [p.cid, p.push]), [['approval:co1:a2', true]]);
  // 変わっていない件は送り直さない
  await relay.syncCompany(CO);
  assert.equal(srv.s.puts.length, 2);
  // 後から結びついた人には、今ある件を push しないで入れる
  const b2 = await bind('u2');
  await relay.syncCompany(CO);
  assert.deepEqual(srv.s.puts.slice(2).map(p => [p.bid, p.push]).sort(), [[b2, false], [b2, false]]);
});

test('card は結びつけが有効な人にだけ送る・中身が変わったら push せずに送り直す', async () => {
  h.approvals.push(approval('a1'));
  await relay.syncCompany(CO);
  assert.equal(srv.s.puts.length, 0); // 誰も結びついていない
  const b1 = await bind('u1');
  await relay.syncCompany(CO);
  h.approvals[0].payload.summary = '書き換えた';
  await relay.syncCompany(CO);
  assert.deepEqual(srv.s.puts.map(p => [p.bid, p.push]), [[b1, false], [b1, false]]);
  assert.notEqual(srv.s.puts[0].version, srv.s.puts[1].version);
});

test('片付いた card を消す（web で決まった・取り下げられた）', async () => {
  const b1 = await bind('u1');
  h.approvals.push(approval('a1'), approval('a2', 'two'));
  await relay.syncCompany(CO);
  h.approvals[0].status = 'approved';
  await relay.syncCompany(CO);
  assert.equal(srv.s.deletes.length, 0); // 1 回見えないだけでは消さない
  await relay.syncCompany(CO);
  assert.deepEqual(srv.s.deletes, [{ bid: b1, cid: 'approval:co1:a1' }]);
  assert.deepEqual(Object.keys(await sentOf()), ['approval:co1:a2']);
});

test('本体が読めなかった回は、その種類の card を消さない', async () => {
  await bind('u1');
  h.approvals.push(approval('a1'));
  await relay.syncCompany(CO);
  const list = ctx.approvals.list;
  ctx.approvals.list = async () => { throw new Error('down'); };
  await relay.syncCompany(CO);
  ctx.approvals.list = list;
  assert.equal(srv.s.deletes.length, 0);
});

test('片付いていない card が無い間は押された操作を取りに行かない', async () => {
  await bind('u1');
  const r = await relay.pollActions(CO);
  assert.equal(r.polled, false);
  assert.ok(!srv.s.requests.some(x => x.includes('/actions')));
  h.approvals.push(approval('a1'));
  await relay.syncCompany(CO);
  assert.equal((await relay.pollActions(CO)).polled, true);
});

test('許可の一覧を満たす操作は押した人の名義で 1 回だけ反映し、済みを返して card を消す', async () => {
  const b1 = await bind('u1');
  h.approvals.push(approval('a1'));
  await relay.syncCompany(CO);
  const a = await press({ bindingId: b1 });
  const r = await relay.pollActions(CO);
  assert.equal(r.applied, 1);
  assert.deepEqual(h.decideCalls, [{ id: 'a1', action: 'approve', actorUserId: 'u1', decisionNote: null }]);
  assert.deepEqual(srv.s.results.get(a.id), { ok: true });
  assert.deepEqual(srv.s.deletes, [{ bid: b1, cid: 'approval:co1:a1' }]);
  // 通知 API が同じ操作をもう一度返しても、二重に反映しない
  srv.s.results.delete(a.id);
  h.approvals[0].status = 'pending';
  await relay.syncCompany(CO);
  await relay.pollActions(CO);
  assert.equal(h.decideCalls.length, 1);
  assert.deepEqual(srv.s.results.get(a.id), { ok: false, reason: 'duplicate' });
});

test('許可の一覧のどれかを満たさない操作は反映せず、理由をつけて返す', async () => {
  const b1 = await bind('u1');
  const b2 = await bind('u2');
  h.approvals.push(approval('a1'));
  await relay.syncCompany(CO);
  const sent = await sentOf();
  const v = sent['approval:co1:a1'].version;
  const cases = [
    // 1: plugin が送っていない card
    [{ cardId: 'approval:co1:zzz', bindingId: b1, version: v }, 'unknown-card'],
    // 2: 結びつけが無い・有効でない
    [{ bindingId: 'b-unknown' }, 'binding-inactive'],
    // 3: 押した時の中身の版が今と違う
    [{ bindingId: b1, version: 'f'.repeat(32) }, 'stale'],
    // 4: card の actions[] に無い操作
    [{ bindingId: b1, actionId: 'delete-everything' }, 'unknown-action'],
    // 5: 押してから 24 時間を過ぎた
    [{ bindingId: b1, pressedAt: new Date(clock - ACTION_TTL_MS - 1000).toISOString() }, 'expired'],
    // 却下は理由が要る
    [{ bindingId: b1, actionId: 'reject' }, 'note-required'],
  ];
  const ids = [];
  for (const [over] of cases) ids.push((await press(over)).id);
  // 結びつけを外した人の操作
  await relay.bindings.remove(CO, 'u2', b2);
  ids.push((await press({ bindingId: b2 })).id);
  await relay.pollActions(CO);
  assert.equal(h.decideCalls.length, 0);
  assert.deepEqual(ids.map(id => srv.s.results.get(id)?.reason), [...cases.map(c => c[1]), 'binding-inactive']);
});

test('見た後で本文が変わった件は反映しない（3）・本体が断ったら反映しない（6）', async () => {
  const b1 = await bind('u1');
  h.approvals.push(approval('a1'));
  await relay.syncCompany(CO);
  const a = await press({ bindingId: b1 });
  h.approvals[0].payload.replyBody = '差し替えた本文';
  await relay.pollActions(CO);
  assert.equal(srv.s.results.get(a.id).reason, 'stale');
  await relay.syncCompany(CO); // 新しい版を送る
  h.decideThrows = true;
  const a2 = await press({ bindingId: b1 });
  await relay.pollActions(CO);
  assert.deepEqual(srv.s.results.get(a2.id), { ok: false, reason: 'host-refused' });
  assert.equal(h.decideCalls.length, 0);
});

test('会社のメンバーから外れた人は結びつけを失効させ、その人宛ての card を消し、操作も反映しない', async () => {
  const b1 = await bind('u1');
  h.approvals.push(approval('a1'));
  await relay.syncCompany(CO);
  const a = await press({ bindingId: b1 });
  h.members = [member('u2')];
  await relay.pollActions(CO);
  assert.equal(srv.s.results.get(a.id).reason, 'binding-inactive');
  await relay.syncCompany(CO);
  assert.equal(srv.s.bindings.get(b1).state, 'revoked');
  assert.deepEqual(srv.s.deletes, [{ bid: b1, cid: 'approval:co1:a1' }]);
});

test('課題ごとの判断カード（確認）を送り、押した人の名義で答える', async () => {
  const b1 = await bind('u1');
  h.interactions.push({ id: 'i1', issueId: 'is1', kind: 'request_confirmation', status: 'pending', title: '公開してよいか', payload: { version: 1, prompt: '公開してよいか', detailsMarkdown: '詳細', rejectRequiresReason: true }, createdAt: '2026-11-10T00:00:00Z' });
  h.interactions.push({ id: 'i2', issueId: 'is1', kind: 'ask_user_questions', status: 'pending', payload: {} });
  await relay.syncCompany(CO);
  assert.deepEqual(srv.s.puts.map(p => p.cid), ['interaction:co1:i1']);
  const card = srv.s.cards.get(`${b1}|interaction:co1:i1`).card;
  // 確認の 2 つに、共通の「どれでもない」「判断を最新にする」が足される（docs/design/2026-11-22-app-card-ux.md 2.1）
  assert.deepEqual(card.actions.map(x => x.id), ['accept', 'reject', 'aio:none']); // 確認の件に「最新にする」は付けない
  const a = await press({ bindingId: b1, actionId: 'reject', values: { note: '早い' } });
  await relay.pollActions(CO);
  assert.deepEqual(srv.s.results.get(a.id), { ok: true });
  assert.deepEqual(h.respondCalls, [{ issueId: 'is1', id: 'i1', action: 'reject', actorUserId: 'u1', reason: '早い' }]);
});

test('会社ごとの判断: key がある人の分だけ読んで送り、押した人の key で決める', async () => {
  const b1 = await bind('u1');
  const b2 = await bind('u2');
  srv.s.userKeys.set('key-u1', 'u1');
  srv.s.userKeys.set('key-u2', 'u2');
  srv.s.decisions.push({ id: 'd1', status: 'open', title: '方針', body: '本文', options: [{ id: 'go', label: '進める' }, { id: 'stop', label: '止める' }], inputs: [{ id: 'memo', label: 'メモ' }], createdAt: '2026-11-10T00:00:00Z' });
  // key が無い会社では判断を読まない・送らない
  await relay.syncCompany(CO);
  assert.equal(srv.s.puts.length, 0);
  assert.ok(!srv.s.requests.some(x => x.includes('/decisions')));
  // u1 だけ key を持つ → u1 にだけ送る（key を承認した時点で open の判断は push しない）
  await relay.decisionKeys.set(CO, 'u1', { key: 'key-u1', expiresAt: '2026-12-01T00:00:00Z', grantedAt: new Date(clock).toISOString() });
  await relay.syncCompany(CO);
  assert.deepEqual(srv.s.puts.map(p => [p.bid, p.cid, p.push]), [[b1, 'decision:co1:d1', false]]);
  // key の無い u2 の操作は宛先でないので反映しない
  const bad = await press({ bindingId: b2, actionId: 'go' });
  // u1 の操作は u1 の key で決める
  const ok = await press({ bindingId: b1, actionId: 'go', values: { inputs: { memo: 'よし', other: 'x' } } });
  await relay.pollActions(CO);
  assert.equal(srv.s.results.get(bad.id).reason, 'not-recipient');
  assert.deepEqual(srv.s.results.get(ok.id), { ok: true });
  assert.deepEqual(srv.s.decided, [{ id: 'd1', user: 'u1', optionId: 'go', inputValues: { memo: 'よし' }, idempotencyKey: ok.id }]);
});

test('会社ごとの判断: key が切れたら card を消し、消す前に押された操作は承認し直しを返す', async () => {
  const b1 = await bind('u1');
  srv.s.userKeys.set('key-u1', 'u1');
  srv.s.decisions.push({ id: 'd1', status: 'open', title: '方針', body: '', options: [{ id: 'go', label: '進める' }], createdAt: '2026-11-10T00:00:00Z' });
  await relay.decisionKeys.set(CO, 'u1', { key: 'key-u1', expiresAt: new Date(clock + 60_000).toISOString() });
  await relay.syncCompany(CO);
  const a = await press({ bindingId: b1, actionId: 'go' });
  clock += 120_000;
  await relay.pollActions(CO);
  assert.equal(srv.s.results.get(a.id).reason, 'key-required');
  assert.equal(srv.s.decided.length, 0);
  await relay.syncCompany(CO);
  assert.deepEqual(srv.s.deletes, [{ bid: b1, cid: 'decision:co1:d1' }]);
});

test('結びつけは code を出した本人だけが確認できる・名乗り出る前は確認できない', async () => {
  const r = await relay.bindings.start(CO, 'u1');
  assert.equal((await relay.bindings.confirm(CO, 'u1', r.bindingId, true)).reason, 'not-claimed:waiting');
  srv.s.bindings.get(r.bindingId).state = 'claimed';
  assert.equal((await relay.bindings.confirm(CO, 'u2', r.bindingId, true)).reason, 'not-issuer');
  assert.equal(srv.s.bindings.get(r.bindingId).state, 'claimed');
  assert.equal((await relay.bindings.confirm(CO, 'u1', r.bindingId, true)).ok, true);
});

test('通知 API のキー・判断の key をログと状態の外に出さない・キーが違えば通知 API は断る', async () => {
  const b1 = await bind('u1');
  h.approvals.push(approval('a1'));
  await relay.syncCompany(CO);
  const bad = createNotifyClient({ baseUrl: srv.url, getKey: async () => 'wrong' });
  await assert.rejects(bad.pendingActions(), e => e.status === 401 && !String(e.message).includes('wrong'));
  await press({ bindingId: b1, actionId: 'nope' });
  await relay.pollActions(CO);
  assert.ok(!h.logs.join('\n').includes(KEY));
  assert.ok(!JSON.stringify([...srv.s.cards.values()]).includes(KEY));
});

test('口の path は 1 か所の定数にまとめてある・判断の key で呼ぶ口は読む・決める・閉じる・質問に答える・件を進める／取り下げるの 5 つだけ', () => {
  assert.deepEqual(Object.keys(DECISION_PATHS).sort(), ['decide', 'dismiss', 'listOpen', 'moveIssue', 'respond']);
  assert.deepEqual(DECISION_PATHS.moveIssue('is 1'), ['PATCH', '/api/issues/is%201']);
  assert.deepEqual(DECISION_PATHS.respond('is 1', 'q/1'), ['POST', '/api/issues/is%201/interactions/q%2F1/respond']);
  assert.deepEqual(Object.keys(NOTIFY_API).sort(), ['bindingState', 'chatPending', 'chatSent', 'confirmBinding', 'createBindCode', 'deleteCard', 'pendingActions', 'postReply', 'putAgents', 'putCard', 'putThreadStatus', 'reportAction', 'revokeBinding']);
  assert.equal(cardVersion({ b: 1, a: [2] }), cardVersion({ a: [2], b: 1 }));
});

// ---- レビュー（2026-11-11・P3）で足した test ----

test('中身が変わった card の送り直しが 1 人に失敗したら、その人には次の回に送り直す（送り先ごとの版）', async () => {
  const b1 = await bind('u1');
  const b2 = await bind('u2');
  h.approvals.push(approval('a1'));
  await relay.syncCompany(CO);
  const v1 = (await sentOf())['approval:co1:a1'].recipients[b1];
  h.approvals[0].payload.summary = '書き換えた';
  // b2 への PUT だけ 1 回失敗させる（500）
  const orig = srv.server.listeners('request')[0];
  let failOnce = true;
  srv.server.removeAllListeners('request');
  srv.server.on('request', (req, res) => {
    if (failOnce && req.method === 'PUT' && req.url.includes(`/bindings/${b2}/cards/`)) { failOnce = false; res.writeHead(500); return res.end(); }
    return orig(req, res);
  });
  await relay.syncCompany(CO);
  const s1 = (await sentOf())['approval:co1:a1'];
  assert.notEqual(s1.recipients[b1], v1);
  assert.equal(s1.recipients[b2], v1); // b2 には古い版のまま
  // b2 が古い版で押した操作は反映しない
  const a = await press({ bindingId: b2, version: v1 });
  await relay.pollActions(CO);
  assert.equal(srv.s.results.get(a.id).reason, 'stale');
  // 次の回に b2 にだけ送り直す
  const before = srv.s.puts.length;
  await relay.syncCompany(CO);
  assert.deepEqual(srv.s.puts.slice(before).map(p => [p.bid, p.version]), [[b2, s1.recipients[b1]]]);
  assert.equal((await sentOf())['approval:co1:a1'].recipients[b2], s1.recipients[b1]);
});

test('前の形（recipients が配列）の状態も読める', async () => {
  const b1 = await bind('u1');
  h.approvals.push(approval('a1'));
  await relay.syncCompany(CO);
  const sent = await sentOf();
  const s = sent['approval:co1:a1'];
  // 前の形には送る版 → 元の版の対応（bases）も無い
  const { bases, ...old } = s;
  sent['approval:co1:a1'] = { ...old, recipients: [b1] };
  await ctx.state.set({ scopeKind: 'company', scopeId: CO, namespace: 'mobile', stateKey: 'sent' }, sent);
  const a = await press({ bindingId: b1 });
  await relay.pollActions(CO);
  assert.deepEqual(srv.s.results.get(a.id), { ok: true });
});

test('同じ通知 API のキーをほかの会社と使っても、ほかの会社の操作には結果を返さない', async () => {
  const b1 = await bind('u1');
  h.approvals.push(approval('a1'));
  await relay.syncCompany(CO);
  assert.equal(companyOfCardKey('approval:co1:a1'), 'co1');
  assert.equal(companyOfCardKey('approval:a1'), null);
  const other = await press({ cardId: 'approval:co2:a9', bindingId: 'b-of-co2', version: 'x' });
  const old = await press({ cardId: 'approval:a1', bindingId: b1 }); // 会社の id の無い形
  const mine = await press({ bindingId: b1 });
  const r = await relay.pollActions(CO);
  assert.equal(r.skipped, 2);
  assert.equal(srv.s.results.has(other.id), false);
  assert.equal(srv.s.results.has(old.id), false);
  assert.deepEqual(srv.s.results.get(mine.id), { ok: true });
});

test('課題を読む途中で並びが変わって 1 回見えなくても、card を消さず、次の回に push し直さない', async () => {
  const b1 = await bind('u1');
  await relay.syncCompany(CO); // 入れる回を済ませる
  h.interactions.push({ id: 'i1', issueId: 'is1', kind: 'request_confirmation', status: 'pending', title: '公開してよいか', payload: { version: 1, prompt: '公開してよいか' }, createdAt: '2026-11-10T00:00:00Z' });
  await relay.syncCompany(CO);
  assert.deepEqual(srv.s.puts.map(p => [p.cid, p.push]), [['interaction:co1:i1', true]]);
  // 1 回だけ取りこぼす
  const list = ctx.issues.list;
  ctx.issues.list = async () => [];
  await relay.syncCompany(CO);
  ctx.issues.list = list;
  assert.equal(srv.s.deletes.length, 0);
  assert.ok((await sentOf())['interaction:co1:i1']);
  await relay.syncCompany(CO);
  assert.equal(srv.s.puts.length, 1); // 新しい件として push し直さない
  assert.equal(srv.s.deletes.length, 0);
  // 2 回続けて見えなければ片付いたとみなす
  h.interactions[0].status = 'accepted';
  await relay.syncCompany(CO);
  assert.equal(srv.s.deletes.length, 0);
  await relay.syncCompany(CO);
  assert.deepEqual(srv.s.deletes, [{ bid: b1, cid: 'interaction:co1:i1' }]);
});

test('card がすべて片付いた後も 1 回は取りに行き、片付いた件には「もう決まっている」を返す', async () => {
  const b1 = await bind('u1');
  h.approvals.push(approval('a1'));
  await relay.syncCompany(CO);
  const a = await press({ bindingId: b1 });
  h.approvals[0].status = 'approved'; // web で決まった
  await relay.syncCompany(CO);
  await relay.syncCompany(CO);
  assert.equal(await relay.hasOpenCards(CO), false);
  const r1 = await relay.pollActions(CO);
  assert.equal(r1.polled, true);
  assert.deepEqual(srv.s.results.get(a.id), { ok: false, reason: 'already-resolved' });
  // その次からは取りに行かない
  assert.equal((await relay.pollActions(CO)).polled, false);
  // 携帯で決めて最後の card が片付いた後も、1 回は取りに行く（同じ card をもう一度押した分）
  h.approvals.push(approval('a2', 'two'));
  await relay.syncCompany(CO);
  const p1 = await press({ bindingId: b1, cardId: 'approval:co1:a2' });
  assert.equal((await relay.pollActions(CO)).applied, 1);
  assert.deepEqual(srv.s.results.get(p1.id), { ok: true });
  const p2 = await press({ bindingId: b1, cardId: 'approval:co1:a2', version: p1.version });
  assert.equal((await relay.pollActions(CO)).polled, true);
  assert.deepEqual(srv.s.results.get(p2.id), { ok: false, reason: 'already-resolved' });
  assert.equal((await relay.pollActions(CO)).polled, false);
});

test('メンバーから外れた人の判断の key を消す', async () => {
  await bind('u1');
  await relay.decisionKeys.set(CO, 'u1', { key: 'key-u1', expiresAt: '2026-12-01T00:00:00Z' });
  await relay.decisionKeys.set(CO, 'u2', { key: 'key-u2', expiresAt: '2026-12-01T00:00:00Z' });
  h.members = [member('u1')];
  await relay.syncCompany(CO);
  const keys = await ctx.state.get({ scopeKind: 'company', scopeId: CO, namespace: 'mobile', stateKey: 'decisionKeys' });
  assert.deepEqual(Object.keys(keys), ['u1']);
});

test('判断の key をログ・例外・戻り値・通知 API へ出さない', async () => {
  const b2 = await bind('u2'); // 断られる key の人を先に読む（ログが出る）
  const b1 = await bind('u1');
  srv.s.userKeys.set('key-u1', 'u1');
  srv.s.decisions.push({ id: 'd1', status: 'open', title: '方針', body: '本文', options: [{ id: 'go', label: '進める' }], createdAt: '2026-11-10T00:00:00Z' });
  // u2 の key は本体が断る（読めない key でログが出る）
  await relay.decisionKeys.set(CO, 'u2', { key: 'key-u2-bad', expiresAt: '2026-12-01T00:00:00Z' });
  await relay.decisionKeys.set(CO, 'u1', { key: 'key-u1', expiresAt: '2026-12-01T00:00:00Z' });
  const out = [];
  out.push(await relay.syncCompany(CO));
  out.push(await relay.decisionKeys.has(CO, 'u1'));
  out.push(await relay.bindings.list(CO, 'u1'));
  await press({ bindingId: b1, actionId: 'go', cardId: 'decision:co1:d1' });
  await press({ bindingId: b2, actionId: 'go', cardId: 'decision:co1:d1' });
  out.push(await relay.pollActions(CO));
  out.push(await relay.bindings.remove(CO, 'u2', b2));
  // 例外の文言に key が入らない
  const dc = createDecisionsClient({ baseUrl: srv.url });
  let err;
  await dc.listOpen(CO, 'key-u2-bad').catch(e => { err = e; });
  assert.ok(err && err.status === 401);
  const shown = [JSON.stringify(out), h.logs.join('\n'), String(err.message), JSON.stringify(err), JSON.stringify([...srv.s.cards.values()]), JSON.stringify([...srv.s.results.values()])].join('\n');
  assert.ok(h.logs.some(l => l.includes('decisions could not be read')));
  for (const k of ['key-u1', 'key-u2-bad', KEY]) assert.ok(!shown.includes(k), `${k} が外に出ている`);
  assert.equal(srv.s.decided.length, 1);
});

test('pending: 本人の waiting / claimed だけを新しい順に返す・切れたものは返さず記録も閉じる', async () => {
  const a = await relay.bindings.start(CO, 'u1');
  assert.deepEqual((await relay.bindings.pending(CO, 'u1')).map(p => [p.bindingId, p.state]), [[a.bindingId, 'waiting']]);
  assert.deepEqual(await relay.bindings.pending(CO, 'u2'), []); // 人は actor で決まる
  srv.s.bindings.get(a.bindingId).state = 'claimed'; srv.s.bindings.get(a.bindingId).email = 'x@example.com';
  const [p] = await relay.bindings.pending(CO, 'u1');
  assert.deepEqual([p.state, p.email], ['claimed', 'x@example.com']);
  // 10 分たつと返さない
  clock += 11 * 60_000;
  assert.deepEqual(await relay.bindings.pending(CO, 'u1'), []);
  const rec = (await ctx.state.get({ scopeKind: 'company', scopeId: CO, namespace: 'mobile', stateKey: 'bindings' }))[a.bindingId];
  assert.equal(rec.status, 'expired');
});

test('pending: 確認済み（active）・断った結びつけは返さない', async () => {
  await bind('u1');
  assert.deepEqual(await relay.bindings.pending(CO, 'u1'), []);
  const r = await relay.bindings.start(CO, 'u1');
  srv.s.bindings.get(r.bindingId).state = 'claimed';
  await relay.bindings.confirm(CO, 'u1', r.bindingId, false);
  assert.deepEqual(await relay.bindings.pending(CO, 'u1'), []);
});

test('code の出し直しで、古い waiting の結びつけを通知 API と記録の両方で捨てる（他の人の分と active は残す）', async () => {
  const mine = await bind('u1');
  const other = await relay.bindings.start(CO, 'u2');
  const old = await relay.bindings.start(CO, 'u1');
  const fresh = await relay.bindings.start(CO, 'u1');
  assert.ok(!srv.s.bindings.has(old.bindingId) || srv.s.bindings.get(old.bindingId).state === 'revoked');
  assert.ok(srv.s.bindings.has(fresh.bindingId) && srv.s.bindings.has(other.bindingId) && srv.s.bindings.has(mine));
  assert.deepEqual((await relay.bindings.pending(CO, 'u1')).map(p => p.bindingId), [fresh.bindingId]);
  const recs = await ctx.state.get({ scopeKind: 'company', scopeId: CO, namespace: 'mobile', stateKey: 'bindings' });
  assert.equal(recs[old.bindingId].status, 'revoked');
  assert.equal(recs[mine].status, 'active');
});

test('pending: 通知 API を読めなくても期限内なら unknown で返す（表示を保つ）・期限が切れたら返さない', async () => {
  const a = await relay.bindings.start(CO, 'u1');
  const real = srv.s.bindings.get(a.bindingId);
  srv.s.bindings.delete(a.bindingId); // 読めない（404）状態にする
  const [p] = await relay.bindings.pending(CO, 'u1');
  assert.deepEqual([p.bindingId, p.state], [a.bindingId, 'unknown']);
  srv.s.bindings.set(a.bindingId, real);
});

test('出し直しの時、相手が code を入れていたら捨てずに claimed を返す（新しい code は作らない）', async () => {
  const a = await relay.bindings.start(CO, 'u1');
  srv.s.bindings.get(a.bindingId).state = 'claimed'; srv.s.bindings.get(a.bindingId).email = 'x@example.com';
  const before = srv.s.bindings.size;
  const r = await relay.bindings.start(CO, 'u1');
  assert.deepEqual([r.claimed, r.bindingId, r.code], [true, a.bindingId, undefined]);
  assert.equal(srv.s.bindings.size, before);
  assert.equal(srv.s.bindings.get(a.bindingId).state, 'claimed');
});

// ---- 判断カードの使い勝手（docs/design/2026-11-22-app-card-ux.md） ----
const KEYS_STATE = { scopeKind: 'company', scopeId: CO, namespace: 'mobile', stateKey: 'decisionKeys' };
async function withDecisionKey(userId) {
  srv.s.userKeys.set(`key-${userId}`, userId);
  const keys = (await ctx.state.get(KEYS_STATE)) || {};
  keys[userId] = { key: `key-${userId}`, expiresAt: new Date(clock + 30 * 86400000).toISOString(), grantedAt: new Date(clock - 86400000).toISOString() };
  await ctx.state.set(KEYS_STATE, keys);
}
const decision = (id, extra = {}) => ({ id, companyId: CO, status: 'open', title: '会議の日程', body: '来週の定例をいつにするか決めてください。\n候補は 2 つです。', options: [{ id: 'a', label: '火曜' }, { id: 'b', label: '木曜' }], inputs: [], metadata: {}, originAgentId: 'g1', originIssueId: 'is1', createdAt: '2026-11-10T00:00:00Z', continuationPolicy: 'wake_origin_agent', ...extra });
const stateOf = async key => ctx.state.get({ scopeKind: 'company', scopeId: CO, namespace: 'mobile', stateKey: key });
const setState = (key, v) => ctx.state.set({ scopeKind: 'company', scopeId: CO, namespace: 'mobile', stateKey: key }, v);

test('送る card: 要約は「会社 · 担当」と中身の行。判断は本文の先頭を入れ、件数の文にならない・状態は未解決', async () => {
  const b1 = await bind('u1');
  await withDecisionKey('u1');
  srv.s.decisions.push(decision('d1'));
  await relay.syncCompany(CO);
  const card = srv.s.cards.get(`${b1}|decision:co1:d1`).card;
  assert.equal(card.from, '見本の会社 · 事務担当');
  assert.equal(card.summary, '見本の会社 · 事務担当\n来週の定例をいつにするか決めてください。 候補は 2 つです。');
  assert.equal(card.summaryDerived, true);
  assert.deepEqual(card.status, { state: 'open', text: '未解決' });
  assert.deepEqual(card.actions.map(a => a.id), ['a', 'b', 'aio:none', 'aio:resolve', 'aio:refresh']);
  assert.equal(card.actions.find(a => a.id === 'aio:none').needsNote, true);
});

test('送る card: お金・外への送信の件は本文を要約に入れない', async () => {
  const b1 = await bind('u1');
  h.approvals.push(approval('a1', '返信の承認', { payload: { title: '返信の承認', replyBody: '秘密の本文' } }));
  await relay.syncCompany(CO);
  const card = srv.s.cards.get(`${b1}|approval:co1:a1`).card;
  assert.equal(card.summary, '見本の会社 · 事務担当\n（外への送信に関わる判断です。開いて確かめてください）');
  assert.ok(!card.summary.includes('秘密の本文'));
  assert.deepEqual(card.actions.map(a => a.id), ['approve', 'reject']); // approval に共通の操作は付けない
});

test('名前が読めない回も、最後に読めた名前を使い、送る版を変えない', async () => {
  const b1 = await bind('u1');
  h.approvals.push(approval('a1'));
  await relay.syncCompany(CO);
  const v = (await sentOf())['approval:co1:a1'].recipients[b1];
  ctx.companies.get = async () => { throw new Error('down'); };
  ctx.agents.list = async () => { throw new Error('down'); };
  const before = srv.s.puts.length;
  await relay.syncCompany(CO);
  assert.equal(srv.s.puts.length, before);
  assert.equal((await sentOf())['approval:co1:a1'].recipients[b1], v);
});

test('飾りだけが変わった後に押した操作は断らない（元の版で照らす）・中身が変わったら断る', async () => {
  const b1 = await bind('u1');
  await withDecisionKey('u1');
  srv.s.decisions.push(decision('d1'));
  await relay.syncCompany(CO);
  const old = (await sentOf())['decision:co1:d1'].recipients[b1];
  // 話の結論が出て、状態の行（飾り）だけが変わる
  await setState('cardThreads', { 'decision:co1:d1': { [b1]: { issueId: 'chat1', threadId: 't1', agentId: 'g1', at: new Date(clock).toISOString() } } });
  h.comments.chat1 = [{ authorType: 'user', body: '判断の件から: 会議の日程' }, { authorType: 'agent', body: '結論: 火曜にします' }];
  await relay.syncCompany(CO);
  const card = srv.s.cards.get(`${b1}|decision:co1:d1`).card;
  assert.deepEqual(card.status, { state: 'talked', text: '話の結論: 火曜にします' });
  assert.deepEqual(card.thread, { id: 't1', agentId: 'g1' });
  assert.notEqual((await sentOf())['decision:co1:d1'].recipients[b1], old);
  const a = await press({ bindingId: b1, actionId: 'a', version: old });
  await relay.pollActions(CO);
  assert.deepEqual(srv.s.results.get(a.id), { ok: true });
  assert.equal(srv.s.decided.length, 1);
});

test('人が後から書いたら、前の結論は出さない', async () => {
  const { conclusionOf } = await import('../plugins/mobile/src/cards.mjs');
  assert.equal(conclusionOf([{ authorType: 'agent', body: '結論: A にする' }]), 'A にする');
  assert.equal(conclusionOf([{ authorType: 'agent', body: '前置き\n結論：B にする' }]), 'B にする');
  assert.equal(conclusionOf([{ authorType: 'agent', body: '結論: A にする' }, { authorType: 'user', body: 'やっぱり待って' }]), null);
  assert.equal(conclusionOf([{ authorType: 'agent', body: 'どうしますか' }]), null);
  // 本体は新しい順で返す。作った時刻で並べ直して見る
  const at = m => `2026-11-22T00:0${m}:00Z`;
  assert.equal(conclusionOf([{ authorType: 'agent', body: '結論: B', createdAt: at(3) }, { authorType: 'user', body: '続き', createdAt: at(2) }, { authorType: 'agent', body: '結論: A', createdAt: at(1) }]), 'B');
  assert.equal(conclusionOf([{ authorType: 'agent', body: '了解', createdAt: at(3) }, { authorType: 'user', body: '…', createdAt: at(2) }, { authorType: 'agent', body: '結論: X', createdAt: at(1) }]), null);
  assert.equal(conclusionOf([{ authorType: 'agent', body: '了解', createdAt: at(3) }, { authorType: 'agent', body: '結論: Y', createdAt: at(2) }, { authorType: 'user', body: '…', createdAt: at(1) }]), 'Y');
});

test('要約: 承認の項目（field）は要約に使わない・本文に金額の形があれば伏せる', async () => {
  const { decorate } = await import('../plugins/mobile/src/cards.mjs');
  const field = decorate({ kind: 'approval', risk: 'internal', summary: '', sections: [{ kind: 'field', label: 'details', text: '見積 300000' }], actions: [] }, { companyName: 'A' });
  assert.equal(field.summary, 'A');
  const money = decorate({ kind: 'decision', risk: 'internal', summary: '', sections: [{ kind: 'body', text: '見積は ¥300,000 です' }], actions: [] }, { companyName: 'A' });
  assert.equal(money.summary, 'A\n（お金に関わる判断です。開いて確かめてください）');
});

test('話のコメントが読めない回は前の回の結論を使い、送る版を変えない', async () => {
  const b1 = await bind('u1');
  await withDecisionKey('u1');
  srv.s.decisions.push(decision('d1'));
  await setState('cardThreads', { 'decision:co1:d1': { [b1]: { issueId: 'chat1', threadId: 't1', agentId: 'g1', at: new Date(clock).toISOString() } } });
  h.comments.chat1 = [{ authorType: 'agent', body: '結論: 火曜にします' }];
  await relay.syncCompany(CO);
  const v = (await sentOf())['decision:co1:d1'].recipients[b1];
  const before = srv.s.puts.length;
  ctx.issues.listComments = async () => { throw new Error('down'); };
  await relay.syncCompany(CO);
  assert.equal(srv.s.puts.length, before);
  assert.equal((await sentOf())['decision:co1:d1'].recipients[b1], v);
});

test('版の対応の刈り込み: 今配っている版は残す（別の人の版が何度変わっても押せる）・前の形から移る回も押せる', async () => {
  const b1 = await bind('u1');
  const b2 = await bind('u2');
  await withDecisionKey('u1'); await withDecisionKey('u2');
  srv.s.decisions.push(decision('d1'));
  await relay.syncCompany(CO);
  const v2 = (await sentOf())['decision:co1:d1'].recipients[b2];
  // u1 の飾りだけを 20 回変える（最新にしています の時刻）
  for (let i = 0; i < 20; i++) {
    clock += 60 * 1000;
    const r = (await stateOf('refreshing')) || {};
    r['decision:co1:d1'] = { [b1]: { at: clock, base: (await sentOf())['decision:co1:d1'].version } };
    await setState('refreshing', r);
    await relay.syncCompany(CO);
  }
  assert.ok(Object.hasOwn((await sentOf())['decision:co1:d1'].bases, v2));
  const a = await press({ bindingId: b2, actionId: 'a', version: v2 });
  await relay.pollActions(CO);
  assert.deepEqual(srv.s.results.get(a.id), { ok: true });
});

test('どれでもない: 判断は理由つきで dismiss し、課題にコメントする。本体が起こす判断では plugin は起こさない', async () => {
  const b1 = await bind('u1');
  await withDecisionKey('u1');
  srv.s.decisions.push(decision('d1'));
  await relay.syncCompany(CO);
  const a = await press({ bindingId: b1, actionId: 'aio:none', values: { note: '先方に確認してから' } });
  await relay.pollActions(CO);
  assert.deepEqual(srv.s.results.get(a.id), { ok: true });
  assert.deepEqual(srv.s.dismissed.map(x => [x.id, x.user, x.reason]), [['d1', 'u1', 'どれでもない: 先方に確認してから']]);
  assert.equal(h.written.length, 1);
  assert.equal(h.written[0].issueId, 'is1');
  // 本体が起こす判断では、人の名義にしない（人の名義のコメントも担当を起こすため・2 回起こさない）
  assert.equal(h.written[0].actorUserId, undefined);
  assert.deepEqual(h.wakes, []);
  assert.ok(srv.s.deletes.some(d => d.cid === 'decision:co1:d1'));
});

test('どれでもない は理由が要る・解決にするは話の結論を理由に使い、本体が起こさない判断では担当を起こす', async () => {
  const b1 = await bind('u1');
  await withDecisionKey('u1');
  srv.s.decisions.push(decision('d1', { continuationPolicy: 'none' }));
  await setState('cardThreads', { 'decision:co1:d1': { [b1]: { issueId: 'chat1', threadId: 't1', agentId: 'g1', at: new Date(clock).toISOString() } } });
  h.comments.chat1 = [{ authorType: 'agent', body: '結論: 火曜にします' }];
  await relay.syncCompany(CO);
  const n = await press({ bindingId: b1, actionId: 'aio:none' });
  await relay.pollActions(CO);
  assert.equal(srv.s.results.get(n.id).reason, 'note-required');
  const a = await press({ bindingId: b1, actionId: 'aio:resolve' });
  await relay.pollActions(CO);
  assert.deepEqual(srv.s.results.get(a.id), { ok: true });
  assert.equal(srv.s.dismissed[0].reason, '話で解決: 火曜にします');
  // 本体が起こさない判断では、人の名義のコメントで担当が 1 回起きる（明示の requestWakeup は重ねない）
  assert.equal(h.written[0].actorUserId, 'u1');
  assert.deepEqual(h.wakes, []);
});

test('判断を最新にする: 課題に頼みを書いて担当を起こし、card は残して「最新にしています」を出す', async () => {
  const b1 = await bind('u1');
  await withDecisionKey('u1');
  srv.s.decisions.push(decision('d1'));
  await relay.syncCompany(CO);
  const a = await press({ bindingId: b1, actionId: 'aio:refresh' });
  await relay.pollActions(CO);
  assert.deepEqual(srv.s.results.get(a.id), { ok: true });
  assert.deepEqual(h.wakes, []);
  assert.equal(h.written[0].issueId, 'is1');
  assert.equal(h.written[0].actorUserId, 'u1'); // 人の名義のコメントで担当が起きる
  assert.ok(!srv.s.deletes.some(d => d.cid === 'decision:co1:d1'));
  await relay.syncCompany(CO);
  assert.equal(srv.s.cards.get(`${b1}|decision:co1:d1`).card.status.state, 'refreshing');
  // 60 分たつと消える
  clock += 61 * 60 * 1000;
  await relay.syncCompany(CO);
  assert.equal(srv.s.cards.get(`${b1}|decision:co1:d1`).card.status.state, 'open');
});

const question = (over = {}) => ({ id: 'q1', issueId: 'is1', kind: 'ask_user_questions', status: 'pending', title: '[回覧] 来週の会議', addresseeUserId: 'u1',
  payload: { version: 1, questions: [{ id: 'when', prompt: '来週の会議はいつがよいですか', selectionMode: 'single', options: [{ id: 'tue', label: '火曜' }, { id: 'answer', label: '回答', freeText: true }] }] }, createdAt: '2026-11-22T00:00:00Z', ...over });

test('質問（問い 1 つ・1 つを選ぶ）を宛先の人にだけ送り、押した本人の key で本体の respond に答える', async () => {
  const b1 = await bind('u1');
  const b2 = await bind('u2');
  await withDecisionKey('u1'); await withDecisionKey('u2');
  h.interactions.push(question());
  await relay.syncCompany(CO);
  assert.deepEqual(srv.s.puts.map(p => [p.bid, p.cid]), [[b1, 'interaction:co1:q1']]); // 宛先の u1 だけ
  const card = srv.s.cards.get(`${b1}|interaction:co1:q1`).card;
  assert.deepEqual(card.actions.map(x => x.id), ['tue', 'answer', 'aio:none']);
  assert.deepEqual(card.inputs, [{ id: 'otherText', label: '回答', required: false, maxLength: 20000 }]);
  const a = await press({ bindingId: b1, actionId: 'answer', values: { inputs: { otherText: '水曜の午後' } } });
  await relay.pollActions(CO);
  assert.deepEqual(srv.s.results.get(a.id), { ok: true });
  assert.deepEqual(srv.s.responded, [{ issueId: 'is1', id: 'q1', user: 'u1', answers: [{ questionId: 'when', optionIds: ['answer'], otherText: '水曜の午後' }] }]);
  assert.deepEqual(h.respondCalls, []);
});

test('質問: 選択肢を選ぶ・自由に書く選択肢の文が空なら断る・「どれでもない」は理由をその文にする', async () => {
  const b1 = await bind('u1');
  await withDecisionKey('u1');
  h.interactions.push(question());
  await relay.syncCompany(CO);
  const empty = await press({ bindingId: b1, actionId: 'answer', values: { inputs: { otherText: '  ' } } });
  await relay.pollActions(CO);
  assert.equal(srv.s.results.get(empty.id).ok, false);
  const none = await press({ bindingId: b1, actionId: 'aio:none', values: { note: '会議は要らない' } });
  await relay.pollActions(CO);
  assert.deepEqual(srv.s.results.get(none.id), { ok: true });
  assert.deepEqual(srv.s.responded.at(-1).answers, [{ questionId: 'when', optionIds: ['answer'], otherText: 'どれでもない: 会議は要らない' }]);
});

test('質問: 選択肢を押すと otherText なしで答える・key が無い人には送らない・問いが 2 つの質問は送らない', async () => {
  const b1 = await bind('u1');
  await bind('u2');
  await withDecisionKey('u1');
  h.interactions.push(question({ addresseeUserId: null }));
  h.interactions.push(question({ id: 'q2', payload: { questions: [{ id: 'a', prompt: 'A', selectionMode: 'single', options: [{ id: 'x', label: 'X' }] }, { id: 'b', prompt: 'B', selectionMode: 'single', options: [{ id: 'y', label: 'Y' }] }] } }));
  await relay.syncCompany(CO);
  assert.deepEqual(srv.s.puts.map(p => [p.bid, p.cid]), [[b1, 'interaction:co1:q1']]);
  const a = await press({ bindingId: b1, actionId: 'tue' });
  await relay.pollActions(CO);
  assert.deepEqual(srv.s.results.get(a.id), { ok: true });
  assert.deepEqual(srv.s.responded[0].answers, [{ questionId: 'when', optionIds: ['tue'] }]);
});

test('質問: カードにできない形（自由に書く選択肢が 2 つ・aio: の id・空のラベル）は送らない・本体の口が無い会社には送らない', async () => {
  const { interactionToCard } = await import('../plugins/mobile/src/cards.mjs');
  const q = opts => interactionToCard(question({ payload: { questions: [{ id: 'w', prompt: 'P', selectionMode: 'single', options: opts }] } }));
  assert.equal(q([{ id: 'a', label: 'A', freeText: true }, { id: 'b', label: 'B', freeText: true }]), null);
  assert.equal(q([{ id: 'aio:none', label: 'A' }]), null);
  assert.equal(q([{ id: 'a', label: '  ' }]), null);
  assert.equal(q([{ id: 'x'.repeat(161), label: 'A' }]), null);
  assert.ok(q([{ id: 'a', label: 'A' }]));
});

test('質問: 本体の口が無い会社にはカードを送らず、押された操作は使った印を付けずにやり直す', async () => {
  const b1 = await bind('u1');
  await withDecisionKey('u1');
  h.interactions.push(question());
  await relay.syncCompany(CO);
  assert.equal(srv.s.puts.length, 1);
  const a = await press({ bindingId: b1, actionId: 'tue' });
  // 口が無い間は取りに行っても反映しない（やり直し）。口が戻ると同じ操作で答えられる
  const notify = createNotifyClient({ baseUrl: srv.url, getKey: async () => KEY });
  const noHost = createRelay({ ctx, notifyFor: async () => notify, decisionsFor: async () => null, now: () => clock });
  await noHost.pollActions(CO);
  assert.equal(srv.s.results.has(a.id), false);
  assert.equal(srv.s.responded.length, 0);
  await relay.pollActions(CO);
  assert.deepEqual(srv.s.results.get(a.id), { ok: true });
  assert.equal(srv.s.responded.length, 1);
  // 口が無い回は、答えられない質問のカードを受信箱から外す（送ったカードがある状態で確かめる）
  h.interactions.push(question({ id: 'q3' }));
  clock += 60 * 1000; await relay.syncCompany(CO);
  assert.ok(srv.s.cards.has(`${b1}|interaction:co1:q3`));
  for (let i = 0; i < 2; i++) { clock += 60 * 1000; await noHost.syncCompany(CO); }
  assert.equal(srv.s.cards.has(`${b1}|interaction:co1:q3`), false);
});

test('確認の件の「どれでもない」は理由つきの reject で返す', async () => {
  const b1 = await bind('u1');
  h.interactions.push({ id: 'i1', issueId: 'is1', kind: 'request_confirmation', status: 'pending', title: '公開してよいか', payload: { prompt: '公開してよいか' }, createdAt: '2026-11-10T00:00:00Z' });
  await relay.syncCompany(CO);
  const a = await press({ bindingId: b1, actionId: 'aio:none', values: { note: '日付を変えたい' } });
  await relay.pollActions(CO);
  assert.deepEqual(srv.s.results.get(a.id), { ok: true });
  assert.deepEqual(h.respondCalls, [{ issueId: 'is1', id: 'i1', action: 'reject', actorUserId: 'u1', reason: 'どれでもない: 日付を変えたい' }]);
});

// ---- 件カード（docs/design/2026-11-24-secretary-conversation-kanban.md 4.4） ----
const CASE_BODY = '## 概要\n名刺の発注先を変える件です。\n\n## 決めてほしい事\nA 社にするか、今のままにするか。\n\n## 私なら\nA 社にします。\n\n## なぜなら\n納期が 2 日早いからです。';
const caseIssue = (id, extra = {}) => ({ id, identifier: `T-${id}`, title: `件 ${id}`, status: 'in_review', assigneeAgentId: 'g1', updatedAt: '2026-11-10T00:00:00Z', ...extra });
const agentSays = (id, body, at = '2026-11-10T00:00:00Z') => ({ id, authorAgentId: 'g1', authorType: 'agent', body, createdAt: at });
async function caseSetup(users = ['u1']) {
  const out = [];
  for (const u of users) { out.push(await bind(u)); srv.s.userKeys.set(`key-${u}`, u); await relay.decisionKeys.set(CO, u, { key: `key-${u}`, expiresAt: '2026-12-01T00:00:00Z' }); }
  return out;
}
const caseCards = () => [...srv.s.cards.entries()].filter(([k]) => k.includes(':case.')).map(([k, v]) => [k, v.card]);

test('件カード: 件の形で書かれた確認待ちの課題を、key を持つ人にだけ判断カードの形で送る・初回は push しない・後から出た件は push する', async () => {
  const [b1] = await caseSetup(['u1']);
  const b2 = await bind('u2'); // key の無い人
  h.issues.push(caseIssue('c1'), caseIssue('c2'), caseIssue('c3', { status: 'blocked' }));
  h.comments.c1 = [agentSays('m1', CASE_BODY)];
  h.comments.c2 = [agentSays('m2', '進めています。')]; // 件の形でない
  h.comments.c3 = [agentSays('m3', CASE_BODY)]; // 止まっている件は出さない
  await relay.syncCompany(CO);
  const cards = caseCards();
  assert.deepEqual(cards.map(([k]) => k), [`${b1}|interaction:co1:case.c1`]);
  assert.ok(![...srv.s.cards.keys()].some(k => k.startsWith(`${b2}|`) && k.includes(':case.')), 'key の無い人には送らない');
  const card = cards[0][1];
  assert.equal(card.kind, 'interaction'); assert.equal(card.title, '件 c1'); assert.equal(card.risk, 'internal');
  assert.deepEqual(card.options.map(o => [o.id, o.style]), [['case:go', 'primary'], ['case:drop', 'destructive']]);
  assert.equal(card.options[0].note, 'A 社にします。');
  assert.deepEqual(card.sections.map(x => [x.kind, x.label]), [['field', '概要'], ['field', '決めてほしい事'], ['field', '私なら'], ['field', 'なぜなら']]);
  assert.deepEqual(card.actions.map(a => [a.id, !!a.needsNote]), [['case:go', false], ['case:drop', true], ['aio:none', true]]);
  assert.match(card.summary, /名刺の発注先/);
  assert.deepEqual(card.origin, { issueId: 'c1' }); assert.deepEqual(card.requestedBy, { agentId: 'g1' });
  assert.deepEqual(srv.s.puts.filter(p => p.cid.includes(':case.')).map(p => p.push), [false], '初回は push しない');
  h.issues.push(caseIssue('c4')); h.comments.c4 = [agentSays('m4', CASE_BODY)];
  await relay.syncCompany(CO);
  assert.deepEqual(srv.s.puts.filter(p => p.cid === 'interaction:co1:case.c4').map(p => p.push), [true], '後から出た件は push する');
});

test('件カード: お金の件は要約と推奨に中身を入れない・版に時刻を入れない', async () => {
  await caseSetup(['u1']);
  h.issues.push(caseIssue('c1'));
  h.comments.c1 = [agentSays('m1', '## 概要\n年額 12,000 円の契約の更新です。\n\n## 決めてほしい事\n更新するか。\n\n## 私なら\n更新します。')];
  await relay.syncCompany(CO);
  const card = caseCards()[0][1];
  assert.equal(card.risk, 'money'); assert.equal(card.recommendation, '');
  assert.ok(!card.summary.includes('12,000'), card.summary);
  assert.ok(card.sections.some(x => x.text.includes('12,000')), '中身は節で読める');
  const v = (await sentOf())['interaction:co1:case.c1'].version;
  // 課題の更新時刻だけが変わっても（中身は同じ）、版は変わらず送り直さない。コメントの時刻が Date でも同じ
  clock += 3600_000;
  h.issues.find(i => i.id === 'c1').updatedAt = new Date('2026-11-10T05:00:00Z');
  h.comments.c1 = h.comments.c1.map(c => ({ ...c, createdAt: new Date(c.createdAt) }));
  await relay.syncCompany(CO);
  assert.equal(srv.s.puts.filter(p => p.cid === 'interaction:co1:case.c1').length, 1, '中身が同じなら送り直さない');
  assert.equal((await sentOf())['interaction:co1:case.c1'].version, v);
});

test('件カード: 同じ課題に判断カード・判断・承認がある件は出さない・口の無い会社と key の無い会社には送らない', async () => {
  const [b1] = await caseSetup(['u1']);
  h.issues.push(caseIssue('c1'), caseIssue('c2'), caseIssue('c3'), caseIssue('c4'));
  for (const id of ['c1', 'c2', 'c3', 'c4']) h.comments[id] = [agentSays(`m-${id}`, CASE_BODY)];
  h.interactions.push({ id: 'i1', issueId: 'c1', kind: 'request_confirmation', status: 'pending', title: '確認', payload: { prompt: 'よいですか' } });
  srv.s.decisions.push({ id: 'd1', status: 'open', title: '判断', body: 'b', options: [{ id: 'o1', label: 'はい' }], originIssueId: 'c2', createdAt: '2026-11-10T00:00:00Z' });
  h.approvals.push(approval('a1', '返信の承認', { payload: { title: 't', summary: 's', issueId: 'c3' } }));
  await relay.syncCompany(CO);
  assert.deepEqual(caseCards().map(([k]) => k), [`${b1}|interaction:co1:case.c4`]);
  // key が切れたら、送った件カードを消す
  await relay.decisionKeys.set(CO, 'u1', { key: 'key-u1', expiresAt: new Date(clock - 1000).toISOString() });
  await relay.syncCompany(CO);
  assert.deepEqual(caseCards(), []);
});

test('件カード: 推奨で進める・取り下げる・どれでもない は、押した人の key で状態と一言を 1 回で送る', async () => {
  const [b1] = await caseSetup(['u1']);
  for (const id of ['c1', 'c2', 'c3']) { h.issues.push(caseIssue(id)); h.comments[id] = [agentSays(`m-${id}`, CASE_BODY)]; }
  await relay.syncCompany(CO);
  await press({ cardId: 'interaction:co1:case.c1', bindingId: b1, actionId: 'case:go' });
  await press({ cardId: 'interaction:co1:case.c2', bindingId: b1, actionId: 'case:drop', values: { note: '今期は見送ります' } });
  await press({ cardId: 'interaction:co1:case.c3', bindingId: b1, actionId: 'aio:none', values: { note: 'B 社も見てください' } });
  await relay.pollActions(CO);
  assert.deepEqual(srv.s.moved, [
    { issueId: 'c1', user: 'u1', status: 'todo', comment: '推奨のとおりに進めてください。' },
    { issueId: 'c2', user: 'u1', status: 'cancelled', comment: 'このタスクは取り下げます。進めないでください。\n理由: 今期は見送ります' },
    { issueId: 'c3', user: 'u1', status: 'todo', comment: 'どれでもない: B 社も見てください' },
  ]);
  assert.deepEqual([...srv.s.results.values()], [{ ok: true }, { ok: true }, { ok: true }]);
  assert.equal(h.written.length, 0, 'コメントを別に書かない');
  assert.deepEqual(caseCards(), [], '押した件の card は消える');
});

test('件カード: 理由の無い取り下げ・確認待ちでなくなった件・中身が変わった件・本体が断った時は反映しない', async () => {
  const [b1] = await caseSetup(['u1']);
  for (const id of ['c1', 'c2', 'c3', 'c4']) { h.issues.push(caseIssue(id)); h.comments[id] = [agentSays(`m-${id}`, CASE_BODY)]; }
  await relay.syncCompany(CO);
  await press({ cardId: 'interaction:co1:case.c1', bindingId: b1, actionId: 'case:drop' });
  h.issues.find(i => i.id === 'c2').status = 'todo';
  await press({ cardId: 'interaction:co1:case.c2', bindingId: b1, actionId: 'case:go' });
  h.comments.c3 = [agentSays('m-new', CASE_BODY.replace('A 社にします。', 'B 社にします。'), '2026-11-11T00:00:00Z'), ...h.comments.c3];
  await press({ cardId: 'interaction:co1:case.c3', bindingId: b1, actionId: 'case:go' });
  srv.s.onMove = () => 403;
  await press({ cardId: 'interaction:co1:case.c4', bindingId: b1, actionId: 'case:go' });
  await relay.pollActions(CO);
  assert.deepEqual([...srv.s.results.values()].map(r => r.reason), ['note-required', 'already-resolved', 'stale', 'host-refused']);
  assert.deepEqual(srv.s.moved.map(m => m.issueId), ['c4'], '本体に届いたのは断られた 1 回だけ');
});

test('件カード: コメントは課題の更新時刻が変わった時だけ読み直す・読み残しがあっても覚えている件は出し続ける・片付いた件は 2 回で消す', async () => {
  const [b1] = await caseSetup(['u1']);
  for (let n = 1; n <= 35; n++) { h.issues.push(caseIssue(`c${n}`)); h.comments[`c${n}`] = [agentSays(`m${n}`, CASE_BODY)]; }
  let reads = 0; const orig = ctx.issues.listComments; ctx.issues.listComments = async (...a) => { reads++; return orig(...a); };
  await relay.syncCompany(CO);
  assert.equal(reads, 30, '1 回に読むのは 30 課題まで');
  assert.equal(caseCards().length, 30);
  reads = 0; await relay.syncCompany(CO);
  assert.equal(reads, 5, '残りだけを読む'); assert.equal(caseCards().length, 35);
  assert.ok(srv.s.puts.filter(p => p.cid.includes(':case.')).every(p => p.push === false), '読み終えるまでの件は push しない');
  reads = 0; await relay.syncCompany(CO);
  assert.equal(reads, 0, '変わっていなければ読まない');
  // 31 件の更新時刻が一度に変わっても、読み残した件の card は消えない
  for (const i of h.issues.filter(x => x.id.startsWith('c')).slice(0, 31)) i.updatedAt = '2026-11-10T01:00:00Z';
  reads = 0; await relay.syncCompany(CO); await relay.syncCompany(CO); await relay.syncCompany(CO);
  assert.equal(reads, 31); assert.equal(caseCards().length, 35); assert.equal(srv.s.deletes.length, 0);
  // 確認待ちでなくなった件は 2 回で消える
  h.issues.find(i => i.id === 'c1').status = 'done';
  await relay.syncCompany(CO); assert.equal(caseCards().length, 35);
  await relay.syncCompany(CO); assert.equal(caseCards().length, 34);
  assert.deepEqual(srv.s.deletes, [{ bid: b1, cid: 'interaction:co1:case.c1' }]);
});

test('件カード: 承認・判断カード・判断を読めなかった回は、件カードを足さず消さない・コメントが読めない件は覚えている中身で出す', async () => {
  await caseSetup(['u1']);
  h.issues.push(caseIssue('c1')); h.comments.c1 = [agentSays('m1', CASE_BODY)];
  await relay.syncCompany(CO);
  assert.equal(caseCards().length, 1);
  const list = ctx.approvals.list; ctx.approvals.list = async () => { throw new Error('down'); };
  h.issues.push(caseIssue('c2')); h.comments.c2 = [agentSays('m2', CASE_BODY)];
  await relay.syncCompany(CO); await relay.syncCompany(CO); await relay.syncCompany(CO);
  assert.deepEqual(caseCards().map(([k]) => k.split('|')[1]), ['interaction:co1:case.c1'], '読めない間は足さず消さない');
  ctx.approvals.list = list;
  h.issues.find(i => i.id === 'c1').updatedAt = '2026-11-10T02:00:00Z';
  const orig = ctx.issues.listComments; ctx.issues.listComments = async id => { if (id === 'c1') throw new Error('down'); return orig(id); };
  await relay.syncCompany(CO); await relay.syncCompany(CO); await relay.syncCompany(CO);
  assert.deepEqual(caseCards().map(([k]) => k.split('|')[1]).sort(), ['interaction:co1:case.c1', 'interaction:co1:case.c2'], 'コメントが読めない件は覚えている中身で出し続け、読めた新しい件は送る');
  assert.equal(srv.s.deletes.length, 0);
  ctx.issues.listComments = orig;
});

test('件カード: 鍵で呼ぶ口は、未着手と取り下げだけを、一言つきで送る', async () => {
  const dc = createDecisionsClient({ baseUrl: srv.url });
  srv.s.userKeys.set('key-u1', 'u1');
  for (const bad of [{ status: 'done', comment: 'x' }, { status: 'in_progress', comment: 'x' }, { status: 'todo', comment: '  ' }, { status: 'todo' }]) await assert.rejects(dc.moveIssue('c1', bad, 'key-u1'));
  await dc.moveIssue('c1', { status: 'todo', comment: 'はい', title: '書き換え', assigneeAgentId: 'x' }, 'key-u1');
  assert.deepEqual(srv.s.moved, [{ issueId: 'c1', user: 'u1', status: 'todo', comment: 'はい' }]);
  assert.equal(companyOfCardKey('interaction:co1:case.c1'), 'co1');
});

test('件カード: 本文が件の形で長い課題（一覧では本文が切れる）も、全文で card を作り、押せる', async () => {
  const [b1] = await caseSetup(['u1']);
  const long = `## 概要\n${'あ'.repeat(1300)}\n\n## 決めてほしい事\n進めるかどうか。\n\n## 私なら\n進めます。`;
  h.issues.push(caseIssue('c1', { description: long }));
  await relay.syncCompany(CO);
  const card = caseCards()[0][1];
  assert.deepEqual(card.options.map(o => o.id), ['case:go', 'case:drop'], '切れた先の「私なら」も読めている');
  await press({ cardId: 'interaction:co1:case.c1', bindingId: b1, actionId: 'case:go' });
  await relay.pollActions(CO);
  assert.deepEqual([...srv.s.results.values()], [{ ok: true }]);
  assert.deepEqual(srv.s.moved.map(m => [m.issueId, m.status]), [['c1', 'todo']]);
});

test('件カード: key が切れて戻った時は、今ある件を push しない・話の課題は出さない・承認の番号は完全に一致した時だけ', async () => {
  await caseSetup(['u1']);
  h.issues.push(caseIssue('c1'), caseIssue('c10', { identifier: 'AB-7' }), caseIssue('c2', { conversationAgentId: 'g1' }), caseIssue('c3', { identifier: '!!' }));
  for (const id of ['c1', 'c10', 'c2', 'c3']) h.comments[id] = [agentSays(`m-${id}`, CASE_BODY)];
  h.approvals.push(approval('a1', 'T-c1 の件の承認'), approval('a2', 'AB-7x と AB-70 の件'));
  await relay.syncCompany(CO);
  assert.deepEqual(caseCards().map(([k]) => k.split('|')[1]).sort(), ['interaction:co1:case.c10', 'interaction:co1:case.c3'], '番号の後ろに英数字が続く別の番号（AB-7x・AB-70）は AB-7 を止めない・記号だけの番号は見ない');
  await relay.decisionKeys.set(CO, 'u1', { key: 'key-u1', expiresAt: new Date(clock - 1000).toISOString() });
  await relay.syncCompany(CO);
  assert.deepEqual(caseCards(), []);
  const before = srv.s.puts.length;
  await relay.decisionKeys.set(CO, 'u1', { key: 'key-u1', expiresAt: '2026-12-01T00:00:00Z' });
  await relay.syncCompany(CO);
  const again = srv.s.puts.slice(before).filter(p => p.cid.includes(':case.'));
  assert.equal(again.length, 2); assert.ok(again.every(p => p.push === false), 'key が戻った回は push しない');
  h.issues.push(caseIssue('c5')); h.comments.c5 = [agentSays('m5', CASE_BODY)];
  await relay.syncCompany(CO);
  assert.deepEqual(srv.s.puts.filter(p => p.cid === 'interaction:co1:case.c5').map(p => p.push), [true]);
});

test('件カード: 押した人の key で呼ぶ・押した時に key が切れていれば断る・本体が断った後は新しい操作で押し直せる・件カードの読みが落ちてもほかの card は送る', async () => {
  const [b1, b2] = await caseSetup(['u1', 'u2']);
  for (const id of ['c1', 'c2', 'c3']) { h.issues.push(caseIssue(id)); h.comments[id] = [agentSays(`m-${id}`, CASE_BODY)]; }
  await relay.syncCompany(CO);
  await press({ cardId: 'interaction:co1:case.c1', bindingId: b2, actionId: 'case:go' });
  await relay.pollActions(CO);
  assert.deepEqual(srv.s.moved.map(m => [m.issueId, m.user]), [['c1', 'u2']]);
  await relay.decisionKeys.set(CO, 'u1', { key: 'key-u1', expiresAt: new Date(clock - 1000).toISOString() });
  await press({ cardId: 'interaction:co1:case.c2', bindingId: b1, actionId: 'case:go' });
  await relay.pollActions(CO);
  assert.equal([...srv.s.results.values()].at(-1).reason, 'key-required');
  srv.s.onMove = () => 403;
  await press({ cardId: 'interaction:co1:case.c3', bindingId: b2, actionId: 'case:go' });
  await relay.pollActions(CO);
  assert.equal([...srv.s.results.values()].at(-1).reason, 'host-refused');
  srv.s.onMove = null;
  await press({ cardId: 'interaction:co1:case.c3', bindingId: b2, actionId: 'case:go' });
  await relay.pollActions(CO);
  assert.deepEqual([...srv.s.results.values()].at(-1), { ok: true });
  // 送った後で話の課題になった件は、押しても反映しない
  h.issues.push(caseIssue('c7')); h.comments.c7 = [agentSays('m7', CASE_BODY)];
  await relay.syncCompany(CO);
  h.issues.find(i => i.id === 'c7').conversationAgentId = 'g1';
  await press({ cardId: 'interaction:co1:case.c7', bindingId: b2, actionId: 'case:go' });
  await relay.pollActions(CO);
  assert.equal([...srv.s.results.values()].at(-1).reason, 'already-resolved');
  // 件カードの読みが例外で落ちても、承認の card は送る
  const get = ctx.state.get; ctx.state.get = async x => { if (x.stateKey === 'caseMemo') throw new Error('state down'); return get(x); };
  h.approvals.push(approval('a9', '別の承認'));
  await relay.syncCompany(CO);
  ctx.state.get = get;
  assert.ok(srv.s.puts.some(p => p.cid === 'approval:co1:a9'));
  assert.ok(caseCards().some(([k]) => k.endsWith('interaction:co1:case.c2')), '読めなかった回は件カードを消さない');
});

test('件カードの id は、通知 API が受け付ける頭（approval・interaction・decision）で始まり、plugin の中でだけ件カードと見分ける', () => {
  const key = cardKeyOf('case', 'co1', 'c1');
  assert.match(key, /^(approval|interaction|decision):/, '通知 API は、この 3 つの頭で始まらない id を 400 で断る');
  assert.equal(kindOfCardKey(key), 'case'); assert.equal(companyOfCardKey(key), 'co1');
  assert.equal(kindOfCardKey(cardKeyOf('interaction', 'co1', '0b6f1c0e-1111-4222-8333-444455556666')), 'interaction');
  assert.equal(kindOfCardKey(cardKeyOf('decision', 'co1', 'd1')), 'decision');
  assert.equal(companyOfCardKey('case:co1:c1'), null, '前の形の id は自分の会社の物として扱わない（1 回で片付ける）');
  for (const k of ['approval', 'interaction', 'decision', 'case']) assert.match(cardKeyOf(k, 'co1', 'x'), /^(approval|interaction|decision):/);
});

test('件カード: 判断カードは読めたが件カードの読みが落ちた回に、件カードを消さない（id の頭は同じでも種類は別に数える）', async () => {
  await caseSetup(['u1']);
  h.issues.push(caseIssue('c1')); h.comments.c1 = [agentSays('m1', CASE_BODY)];
  await relay.syncCompany(CO);
  assert.equal(caseCards().length, 1);
  const get = ctx.state.get; ctx.state.get = async x => { if (x.stateKey === 'caseMemo') throw new Error('state down'); return get(x); };
  await relay.syncCompany(CO); await relay.syncCompany(CO); await relay.syncCompany(CO);
  ctx.state.get = get;
  assert.equal(caseCards().length, 1); assert.equal(srv.s.deletes.length, 0);
});

test('件カード: 前の版の印（casePrimed）が残っていても、直しを入れた最初の回は今ある件を push しない', async () => {
  await caseSetup(['u1']);
  for (const k of ['casePrimed', 'primed']) await ctx.state.set({ scopeKind: 'company', scopeId: CO, namespace: 'mobile', stateKey: k }, true);
  h.issues.push(caseIssue('c1')); h.comments.c1 = [agentSays('m1', CASE_BODY)];
  await relay.syncCompany(CO);
  assert.deepEqual(srv.s.puts.filter(p => p.cid.includes(':case.')).map(p => p.push), [false]);
});

// ---- 担当が止まっているお知らせ（範囲 docs/review/2026-11-25-app-agent-stopped-notice-scope.md） ----
const STOP = 'interaction:co1:stopped.agents';
const guardErr = { status: 'error', errorReason: 'AI Office guard: ChatGPT plan の利用枠が上限に近いため Codex を起動しません (token=abc /home/x)' };

test('止まり: kindOfCardKey が stopped を見分け、cardKeyOf が interaction の頭で作る', () => {
  assert.equal(cardKeyOf('stopped', CO, 'agents'), STOP);
  assert.equal(kindOfCardKey(STOP), 'stopped');
  assert.equal(companyOfCardKey(STOP), CO);
});

test('止まり: error と 3 日以内の paused だけを数え、理由は決まった語・理由と名前の順に並べる', () => {
  const rows = stoppedRows([
    { name: '経理', ...guardErr },
    { name: 'Admin', status: 'error', errorReason: 'spawn E2BIG' },
    { name: '秘書', ...guardErr },
    { name: '昔の担当', status: 'paused', pausedAt: '2026-11-20T00:00:00Z' },
    { name: '総務', status: 'paused', pausedAt: '2026-11-24T00:00:00Z' },
    { name: '開発', status: 'idle' },
    { name: '辞めた', status: 'terminated' },
  ], Date.parse('2026-11-25T00:00:00Z'));
  assert.deepEqual(rows, [
    { name: '秘書', reason: 'AI の利用枠の守り' }, { name: '経理', reason: 'AI の利用枠の守り' },
    { name: 'Admin', reason: 'エラー' }, { name: '総務', reason: '止めています' },
  ]);
});

test('止まり: 出す・error の文は載せない・同じ日は push し直さない・翌日に 1 回催促・2 回続けて 0 人で消す', async () => {
  const b1 = await bind('u1'); const b2 = await bind('u2');
  await relay.syncCompany(CO); // 入れた最初の回（止まりなし）で専用の初回の印が立つ
  h.agents = [{ id: 'g1', name: '秘書', ...guardErr }, { id: 'g2', name: 'Mail', ...guardErr }];
  await relay.syncCompany(CO);
  let puts = srv.s.puts.filter(p => p.cid === STOP);
  assert.deepEqual(puts.map(p => [p.bid, p.push]).sort(), [[b1, true], [b2, true]], '止まりの始まりに全員へ 1 回 push');
  const card = srv.s.cards.get(`${b1}|${STOP}`).card;
  assert.equal(card.title, '担当 2 人が止まっています');
  assert.doesNotMatch(JSON.stringify(card), /token=abc|\/home\/x|AI Office guard/, 'error の文は載せない');
  assert.match(JSON.stringify(card), /Mail（AI の利用枠の守り）/);
  await relay.syncCompany(CO);
  assert.equal(srv.s.puts.filter(p => p.cid === STOP).length, 2, '中身が同じ回は送り直さない');
  h.agents.push({ id: 'g3', name: '経理', status: 'error', errorReason: 'x' });
  await relay.syncCompany(CO);
  puts = srv.s.puts.filter(p => p.cid === STOP);
  assert.deepEqual(puts.slice(2).map(p => p.push), [false, false], '同じ日に増えても push しない（中身だけ送り直す）');
  clock += 24 * 60 * 60 * 1000;
  await relay.syncCompany(CO); await relay.syncCompany(CO);
  puts = srv.s.puts.filter(p => p.cid === STOP);
  assert.deepEqual(puts.slice(4).map(p => p.push), [true, true], '翌日に全員へ 1 回だけ催促');
  h.agents = [{ id: 'g1', name: '秘書', status: 'idle' }];
  await relay.syncCompany(CO);
  assert.ok(srv.s.cards.has(`${b1}|${STOP}`), '1 回の 0 人では残る');
  h.agents = [{ id: 'g1', name: '秘書', ...guardErr }];
  await relay.syncCompany(CO);
  assert.equal(srv.s.puts.filter(p => p.cid === STOP && p.push).length, 4, '揺れで戻っても push し直さない');
  h.agents = [{ id: 'g1', name: '秘書', status: 'idle' }];
  await relay.syncCompany(CO); await relay.syncCompany(CO);
  assert.ok(!srv.s.cards.has(`${b1}|${STOP}`) && !srv.s.cards.has(`${b2}|${STOP}`), '2 回続けて 0 人で消える');
  h.agents = [{ id: 'g1', name: '秘書', ...guardErr }];
  await relay.syncCompany(CO);
  assert.deepEqual(srv.s.puts.filter(p => p.cid === STOP).slice(-2).map(p => p.push), [true, true], '次の止まりは新しい始まりとして push');
});

test('止まり: 入れた最初の回からもう止まっている時は push しない・担当の一覧が読めない回は消さない', async () => {
  const b1 = await bind('u1');
  h.agents = [{ id: 'g1', name: '秘書', ...guardErr }];
  await relay.syncCompany(CO);
  assert.deepEqual(srv.s.puts.filter(p => p.cid === STOP).map(p => p.push), [false]);
  const list = ctx.agents.list;
  ctx.agents.list = async () => { throw new Error('down'); };
  await relay.syncCompany(CO); await relay.syncCompany(CO); await relay.syncCompany(CO);
  assert.ok(srv.s.cards.has(`${b1}|${STOP}`), '読めない回は何回でも消さない');
  assert.equal(srv.s.deletes.filter(d => d.cid === STOP).length, 0);
  ctx.agents.list = list;
});
