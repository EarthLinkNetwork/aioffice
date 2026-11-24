// mobile plugin の「会社ごとの判断の key を出す・確かめる・入れ替える・失効させる」と「key の無い人へのお知らせ」（plugins/mobile/src/relay.mjs・host-auth-client.mjs）。
// 試験用の通知 API と本体（CLI のログイン・board API key・decisions の口）を、この test の中で立てる node の http server で真似る。
import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { createNotifyClient } from '../plugins/mobile/src/notify-client.mjs';
import { createDecisionsClient } from '../plugins/mobile/src/decisions-client.mjs';
import { createHostAuthClient, KEY_PATHS, CHALLENGE_PATHS, KEY_TTL_MS } from '../plugins/mobile/src/host-auth-client.mjs';
import { createRelay, RENEW_BEFORE_MS } from '../plugins/mobile/src/relay.mjs';

const KEY = 'project-key-for-keys-test-0123456';
const CO = 'co1';
const DAY = 24 * 60 * 60 * 1000;

function startServer(clockRef) {
  const s = { cards: new Map(), puts: [], deletes: [], actions: [], results: new Map(), bindings: new Map(), requests: [], bodies: [], decisions: [], decided: [],
    keys: new Map(), challenges: new Map(), nextBinding: 1, nextKey: 1, nextChallenge: 1, failCreateKey: false };
  const newKey = (userId, expiresAt) => { const n = s.nextKey++; const token = `pcp_board_secret_${n}_${'x'.repeat(24)}`; s.keys.set(token, { id: `k${n}`, userId, expiresAt, revoked: false }); return token; };
  s.newKey = newKey;
  const server = http.createServer(async (req, res) => {
    let body = '';
    for await (const c of req) body += c;
    const json = body ? JSON.parse(body) : null;
    const url = new URL(req.url, 'http://x');
    const p = url.pathname;
    s.requests.push(`${req.method} ${p}`);
    s.bodies.push(body);
    const send = (code, obj) => { res.writeHead(code, { 'content-type': 'application/json' }); res.end(obj === undefined ? '' : JSON.stringify(obj)); };
    const auth = (req.headers.authorization || '').replace(/^Bearer /, '');
    const keyOf = () => { const k = s.keys.get(auth); return k && !k.revoked && Date.parse(k.expiresAt) > clockRef.now ? k : null; };
    let m;
    // 本体: CLI のログインの依頼（認証なし）
    if (req.method === 'POST' && p === '/api/cli-auth/challenges') {
      const id = `ch${s.nextChallenge++}`;
      const c = { id, token: `pcp_cli_auth_secret_${id}_${'y'.repeat(20)}`, pendingKey: `pcp_board_pending_${id}_${'z'.repeat(20)}`, status: 'pending', body: json, expiresAt: clockRef.now + 600_000 };
      s.challenges.set(id, c);
      return send(201, { id, token: c.token, boardApiToken: c.pendingKey, approvalPath: `/cli-auth/${id}?token=${encodeURIComponent(c.token)}`, approvalUrl: `http://wrong-host/cli-auth/${id}`, expiresAt: new Date(clockRef.now + 600_000).toISOString() });
    }
    if (req.method === 'GET' && (m = p.match(/^\/api\/cli-auth\/challenges\/([^/]+)$/))) {
      const c = s.challenges.get(decodeURIComponent(m[1]));
      if (!c || c.token !== url.searchParams.get('token')) return send(404, {});
      // 本体と同じ: 取り消し → 期限切れ → 承認 の順に見る（承認された依頼も 10 分を過ぎると expired）
      return send(200, { id: c.id, status: c.status === 'cancelled' ? 'cancelled' : clockRef.now >= c.expiresAt ? 'expired' : c.status });
    }
    // 本体: board API key の口
    if (p === '/api/cli-auth/me' || p === '/api/board-api-keys' || p === '/api/cli-auth/revoke-current') {
      const k = keyOf();
      if (!k) return send(401, {});
      if (req.method === 'GET' && p === '/api/cli-auth/me') return send(200, { userId: k.userId, keyId: k.id, source: 'board_key' });
      if (req.method === 'GET' && p === '/api/board-api-keys') return send(200, [...s.keys.values()].filter(x => x.userId === k.userId && !x.revoked).map(x => ({ id: x.id, expiresAt: x.expiresAt })));
      if (req.method === 'POST' && p === '/api/board-api-keys') {
        if (s.failCreateKey) return send(500, {});
        if (!json.expiresAt) return send(400, { error: 'test: no expiresAt' });
        const token = newKey(k.userId, new Date(json.expiresAt).toISOString());
        const nk = s.keys.get(token);
        return send(201, { id: nk.id, name: json.name, token, expiresAt: nk.expiresAt });
      }
      if (req.method === 'POST' && p === '/api/cli-auth/revoke-current') { k.revoked = true; return send(200, { revoked: true }); }
    }
    // 本体: decisions の口
    if (p.startsWith('/api/companies/') || p.startsWith('/api/decisions/')) {
      const k = keyOf();
      if (!k) return send(401, {});
      if (req.method === 'GET' && /^\/api\/companies\/[^/]+\/decisions$/.test(p)) return send(200, s.decisions.filter(d => d.status === url.searchParams.get('status')));
      return send(404, {});
    }
    // 通知 API
    if (auth !== KEY) return send(401, {});
    if ((m = p.match(/^\/api\/v1\/plugin\/bindings\/([^/]+)\/cards\/([^/]+)$/))) {
      const [bid, cid] = [decodeURIComponent(m[1]), decodeURIComponent(m[2])];
      if (s.bindings.get(bid)?.state !== 'active') return send(404, {});
      if (req.method === 'PUT') { s.cards.set(`${bid}|${cid}`, json); s.puts.push({ bid, cid, push: json.push }); return send(200, { ok: true }); }
      if (req.method === 'DELETE') { s.cards.delete(`${bid}|${cid}`); s.deletes.push({ bid, cid }); return send(200, { ok: true }); }
    }
    if (req.method === 'GET' && p === '/api/v1/plugin/actions') return send(200, { actions: s.actions.filter(a => !s.results.has(a.id)) });
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

function fakeCtx() {
  const state = new Map();
  const k = x => `${x.scopeKind}|${x.scopeId}|${x.namespace}|${x.stateKey}`;
  const h = { members: [], logs: [] };
  const ctx = {
    state: { get: async x => structuredClone(state.get(k(x))), set: async (x, v) => { state.set(k(x), structuredClone(v)); } },
    logger: { warn: (m, meta) => h.logs.push(JSON.stringify([m, meta])), info: (m, meta) => h.logs.push(JSON.stringify([m, meta])) },
    access: { members: { list: async () => h.members } },
    companies: { get: async id => (id === CO ? { id: CO, name: 'Example Co', issuePrefix: 'EXA' } : null) },
    approvals: { list: async () => [], get: async () => null },
    issues: { list: async () => [], listInteractions: async () => [] },
  };
  return { ctx, h, state };
}

const member = (userId, role = 'operator') => ({ principalType: 'user', principalId: userId, status: 'active', membershipRole: role });
const clockRef = { now: 0 };
let srv, ctx, h, relay;

async function bind(userId) {
  const r = await relay.bindings.start(CO, userId);
  Object.assign(srv.s.bindings.get(r.bindingId), { state: 'claimed', email: `${userId}@example.com` });
  assert.equal((await relay.bindings.confirm(CO, userId, r.bindingId, true)).ok, true);
  return r.bindingId;
}
const keysOf = async () => (await ctx.state.get({ scopeKind: 'company', scopeId: CO, namespace: 'mobile', stateKey: 'decisionKeys' })) || {};
const noticeFor = (bid, userId) => srv.s.cards.get(`${bid}|interaction:${CO}:notice.${userId}`)?.card || null;
const approve = (chId, userId) => { const c = srv.s.challenges.get(chId); c.status = 'approved'; srv.s.keys.set(c.pendingKey, { id: `kp-${chId}`, userId, expiresAt: new Date(clockRef.now + KEY_TTL_MS).toISOString(), revoked: false }); return c; };

beforeEach(async () => {
  clockRef.now = Date.parse('2026-11-11T00:00:00Z');
  srv = await startServer(clockRef);
  ({ ctx, h } = fakeCtx());
  const notify = createNotifyClient({ baseUrl: srv.url, getKey: async () => KEY });
  const decisions = createDecisionsClient({ baseUrl: srv.url });
  const hostAuth = createHostAuthClient({ baseUrl: srv.url });
  relay = createRelay({ ctx, notifyFor: async () => notify, decisionsFor: async () => decisions, hostAuthFor: async () => hostAuth, pageUrlFor: async () => 'https://paperclip.example.com/EXA/ai-office', now: () => clockRef.now });
  h.members = [member('u1'), member('u2'), member('adm', 'owner')];
});
afterEach(() => srv.server.close());

test('key の依頼は結びつけが有効な本人だけが作れ、承認の URL は hostUrl から作る・依頼の名前にメールアドレスを入れる', async () => {
  assert.deepEqual(await relay.decisionKeys.request(CO, 'u1'), { ok: false, reason: 'not-linked' });
  await bind('u1');
  const r = await relay.decisionKeys.request(CO, 'u1');
  assert.equal(r.ok, true);
  const ch = srv.s.challenges.get('ch1');
  assert.equal(r.approvalUrl, `${srv.url}/cli-auth/ch1?token=${encodeURIComponent(ch.token)}`);
  assert.equal(ch.body.clientName, 'AI Office: u1@example.com との結びつけ');
  assert.equal(ch.body.requestedCompanyId, CO);
  assert.equal(ch.body.requestedAccess, 'board');
  assert.equal((await relay.decisionKeys.status(CO, 'u1')).state, 'pending');
  // ほかの人の状態には依頼の URL を出さない
  assert.equal((await relay.decisionKeys.status(CO, 'u2')).approvalUrl, undefined);
});

test('承認されたら持ち主を確かめて key を置き、お知らせを消し、その時点で open の判断を push せずに送る', async () => {
  const b1 = await bind('u1');
  srv.s.decisions.push({ id: 'd1', status: 'open', title: '方針', body: '', options: [{ id: 'go', label: '進める' }], createdAt: '2026-11-10T00:00:00Z' });
  await relay.syncCompany(CO);
  await relay.syncCompany(CO); // primed の後でも、key を承認した時点で open の判断は push しない
  const notice = noticeFor(b1, 'u1');
  assert.equal(notice.kind, 'notice');
  assert.deepEqual(notice.actions, []);
  assert.match(notice.summary, /Example Co/);
  assert.equal(notice.sections[0].url.href, 'https://paperclip.example.com/EXA/ai-office');
  assert.ok(srv.s.puts.filter(p => p.cid.includes(':notice.')).every(p => p.push === false));
  await relay.decisionKeys.request(CO, 'u1');
  approve('ch1', 'u1');
  await relay.syncCompany(CO);
  const keys = await keysOf();
  assert.equal(keys.u1.keyId, 'kp-ch1');
  assert.equal(keys.u1.expiresAt, new Date(clockRef.now + KEY_TTL_MS).toISOString());
  assert.equal((await relay.decisionKeys.status(CO, 'u1')).state, 'active');
  assert.equal(noticeFor(b1, 'u1'), null);
  assert.deepEqual(srv.s.puts.filter(p => p.cid === `decision:${CO}:d1`).map(p => [p.bid, p.push]), [[b1, false]]);
});

test('承認した人が依頼した本人と違えば、その key を失効させて使わない（結びつけは有効のまま）', async () => {
  const b1 = await bind('u1');
  await relay.decisionKeys.request(CO, 'u1');
  const c = approve('ch1', 'u2');
  await relay.syncCompany(CO);
  assert.equal(srv.s.keys.get(c.pendingKey).revoked, true);
  assert.equal((await keysOf()).u1?.key ?? null, null);
  const st = await relay.decisionKeys.status(CO, 'u1');
  assert.equal(st.state, 'none');
  assert.equal(st.reason, 'owner-mismatch');
  assert.equal(srv.s.bindings.get(b1).state, 'active');
  assert.ok(noticeFor(b1, 'u1'));
});

test('10 分で切れた・取り消された依頼は捨てる', async () => {
  await bind('u1');
  await relay.decisionKeys.request(CO, 'u1');
  srv.s.challenges.get('ch1').status = 'expired';
  await relay.syncCompany(CO);
  const st = await relay.decisionKeys.status(CO, 'u1');
  assert.equal(st.state, 'none');
  assert.equal(st.reason, 'request-expired');
  // 本体が答えなくても、10 分を過ぎた依頼は捨てる
  await relay.decisionKeys.request(CO, 'u1');
  clockRef.now += 11 * 60 * 1000;
  await relay.decisionKeys.maintain(CO);
  assert.equal((await relay.decisionKeys.status(CO, 'u1')).state, 'none');
});

test('期限の 7 日前に同じ人の名義の新しい key（期限 30 日）を作り、古い key を失効させる', async () => {
  await bind('u1');
  await relay.decisionKeys.request(CO, 'u1');
  const c = approve('ch1', 'u1');
  await relay.syncCompany(CO);
  clockRef.now += KEY_TTL_MS - RENEW_BEFORE_MS - DAY; // まだ 8 日ある → 入れ替えない
  await relay.syncCompany(CO);
  assert.equal((await keysOf()).u1.keyId, 'kp-ch1');
  clockRef.now += 2 * DAY; // あと 6 日 → 入れ替える
  await relay.syncCompany(CO);
  const keys = await keysOf();
  assert.notEqual(keys.u1.keyId, 'kp-ch1');
  assert.equal(srv.s.keys.get(c.pendingKey).revoked, true);
  const nk = srv.s.keys.get(keys.u1.key);
  assert.equal(nk.userId, 'u1');
  assert.equal(nk.expiresAt, new Date(clockRef.now + KEY_TTL_MS).toISOString());
  assert.equal(keys.u1.expiresAt, nk.expiresAt);
});

test('入れ替えに失敗したら「あと n 日」のお知らせを出し、切れた後は「承認し直して」に変え、判断の card を消す', async () => {
  const b1 = await bind('u1');
  srv.s.decisions.push({ id: 'd1', status: 'open', title: '方針', body: '', options: [{ id: 'go', label: '進める' }], createdAt: '2026-11-10T00:00:00Z' });
  await relay.decisionKeys.request(CO, 'u1');
  approve('ch1', 'u1');
  await relay.syncCompany(CO);
  assert.ok(srv.s.cards.has(`${b1}|decision:${CO}:d1`));
  srv.s.failCreateKey = true;
  clockRef.now += KEY_TTL_MS - 3 * DAY;
  await relay.syncCompany(CO);
  let n = noticeFor(b1, 'u1');
  assert.match(n.title, /あと 3 日/);
  assert.equal((await relay.decisionKeys.status(CO, 'u1')).state, 'expiring');
  assert.ok(srv.s.cards.has(`${b1}|decision:${CO}:d1`)); // まだ有効な間は判断も届く
  clockRef.now += 4 * DAY;
  await relay.syncCompany(CO);
  n = noticeFor(b1, 'u1');
  assert.match(n.title, /承認し直して/);
  assert.equal((await relay.decisionKeys.status(CO, 'u1')).state, 'lost');
  assert.ok(!srv.s.cards.has(`${b1}|decision:${CO}:d1`));
});

test('結びつけを外したら・メンバーから外れたら、key を本体で失効させてから消す', async () => {
  const b1 = await bind('u1');
  await bind('u2');
  await relay.decisionKeys.request(CO, 'u1');
  const c1 = approve('ch1', 'u1');
  await relay.decisionKeys.request(CO, 'u2');
  const c2 = approve('ch2', 'u2');
  await relay.syncCompany(CO);
  assert.equal((await relay.bindings.remove(CO, 'u1', b1)).ok, true);
  assert.equal(srv.s.keys.get(c1.pendingKey).revoked, true);
  assert.equal((await keysOf()).u1, undefined);
  h.members = [member('u1'), member('adm', 'owner')];
  await relay.syncCompany(CO);
  assert.equal(srv.s.keys.get(c2.pendingKey).revoked, true);
  assert.equal((await keysOf()).u2, undefined);
});

test('お知らせしか無い間は、押された操作を取りに行かない', async () => {
  await bind('u1');
  await relay.syncCompany(CO);
  await relay.syncCompany(CO);
  srv.s.requests.length = 0;
  await relay.pollActions(CO);
  await relay.pollActions(CO);
  assert.ok(!srv.s.requests.some(r => r.includes('/actions')));
});

test('会社ごとの判断を読む設定（hostUrl）が無い会社では、お知らせを出さない', async () => {
  const notify = createNotifyClient({ baseUrl: srv.url, getKey: async () => KEY });
  relay = createRelay({ ctx, notifyFor: async () => notify, decisionsFor: async () => null, hostAuthFor: async () => null, now: () => clockRef.now });
  await bind('u1');
  await relay.syncCompany(CO);
  assert.ok(!srv.s.puts.some(p => p.cid.includes(':notice.')));
  assert.deepEqual(await relay.decisionKeys.request(CO, 'u1'), { ok: false, reason: 'not-configured' });
});

test('key で呼ぶ本体の口は決まった 4 つだけ・依頼の秘密と key をログ・card・戻り値に出さない', async () => {
  assert.deepEqual(Object.keys(KEY_PATHS).sort(), ['createKey', 'listKeys', 'me', 'revokeCurrent']);
  assert.deepEqual(Object.keys(CHALLENGE_PATHS).sort(), ['challengeState', 'createChallenge']);
  const b1 = await bind('u1');
  await relay.decisionKeys.request(CO, 'u1');
  const c = approve('ch1', 'u1');
  await relay.syncCompany(CO);
  const st = JSON.stringify(await relay.decisionKeys.status(CO, 'u1'));
  const list = JSON.stringify(await relay.bindings.list(CO, 'u1'));
  const cards = JSON.stringify([...srv.s.cards.values()]);
  const logs = h.logs.join('\n');
  for (const secret of [c.pendingKey, c.token]) {
    for (const out of [st, list, cards, logs]) assert.ok(!out.includes(secret));
  }
  assert.ok(b1);
});

// ---- 独立レビュー r1（2026-11-11）で足した test ----

test('二重に押しても依頼は 1 つ（期限内の承認待ちの依頼をそのまま返す）', async () => {
  await bind('u1');
  const [a, b] = await Promise.all([relay.decisionKeys.request(CO, 'u1'), relay.decisionKeys.request(CO, 'u1')]);
  assert.equal(srv.s.challenges.size, 1);
  assert.equal(a.approvalUrl, b.approvalUrl);
});

test('捨てた依頼（外した後・期限で上書きした後）が後から承認されたら、その key を失効させる', async () => {
  const b1 = await bind('u1');
  await relay.decisionKeys.request(CO, 'u1');
  await relay.bindings.remove(CO, 'u1', b1);
  const c = approve('ch1', 'u1');
  await relay.decisionKeys.maintain(CO);
  assert.equal(srv.s.keys.get(c.pendingKey).revoked, true);
  // 期限の間際に押し直して上書きされた依頼も見張る
  await bind('u1');
  await relay.decisionKeys.request(CO, 'u1');
  clockRef.now += 9.5 * 60 * 1000;
  await relay.decisionKeys.request(CO, 'u1');
  assert.equal(srv.s.challenges.size, 3);
  const old = approve('ch2', 'u1');
  await relay.decisionKeys.maintain(CO);
  assert.equal(srv.s.keys.get(old.pendingKey).revoked, true);
  assert.equal((await relay.decisionKeys.status(CO, 'u1')).state, 'pending');
});

test('承認し直したら前の key を失効させる', async () => {
  await bind('u1');
  await relay.decisionKeys.request(CO, 'u1');
  const c1 = approve('ch1', 'u1');
  await relay.syncCompany(CO);
  clockRef.now += 11 * 60 * 1000;
  await relay.decisionKeys.request(CO, 'u1');
  const c2 = approve('ch2', 'u1');
  await relay.syncCompany(CO);
  assert.equal(srv.s.keys.get(c1.pendingKey).revoked, true);
  assert.equal((await keysOf()).u1.key, c2.pendingKey);
});

test('持ち主を読む時の一時的な失敗では key を失効させず、次の回にやり直す', async () => {
  await bind('u1');
  await relay.decisionKeys.request(CO, 'u1');
  const c = approve('ch1', 'u1');
  const real = srv.s.keys.get(c.pendingKey);
  srv.s.keys.delete(c.pendingKey); // 本体が key をまだ引けない（401 ではなく 500 を返す口に替える）
  const origEmit = srv.server.listeners('request')[0];
  srv.server.removeAllListeners('request');
  srv.server.on('request', (req, res) => (req.url === '/api/cli-auth/me' ? (res.writeHead(500), res.end()) : origEmit(req, res)));
  srv.s.keys.set(c.pendingKey, real);
  await relay.syncCompany(CO);
  assert.equal(real.revoked, false);
  assert.equal((await relay.decisionKeys.status(CO, 'u1')).state, 'pending');
  srv.server.removeAllListeners('request');
  srv.server.on('request', origEmit);
  await relay.syncCompany(CO);
  assert.equal((await keysOf()).u1.key, c.pendingKey);
});

test('入れ替えで本体が key を断ったら（401）切れた扱いにする', async () => {
  const b1 = await bind('u1');
  await relay.decisionKeys.request(CO, 'u1');
  const c = approve('ch1', 'u1');
  await relay.syncCompany(CO);
  srv.s.keys.get(c.pendingKey).revoked = true; // 本体の画面で失効させた
  clockRef.now += KEY_TTL_MS - 6 * DAY;
  await relay.syncCompany(CO);
  assert.equal((await relay.decisionKeys.status(CO, 'u1')).state, 'lost');
  assert.match(noticeFor(b1, 'u1').title, /承認し直して/);
});

test('失効に失敗した key は列に残し、次の回に失効させる', async () => {
  const b1 = await bind('u1');
  await relay.decisionKeys.request(CO, 'u1');
  const c = approve('ch1', 'u1');
  await relay.syncCompany(CO);
  const origEmit = srv.server.listeners('request')[0];
  srv.server.removeAllListeners('request');
  srv.server.on('request', (req, res) => (req.url === '/api/cli-auth/revoke-current' ? (res.writeHead(503), res.end()) : origEmit(req, res)));
  await relay.bindings.remove(CO, 'u1', b1);
  assert.equal(srv.s.keys.get(c.pendingKey).revoked, false);
  srv.server.removeAllListeners('request');
  srv.server.on('request', origEmit);
  await relay.decisionKeys.maintain(CO);
  assert.equal(srv.s.keys.get(c.pendingKey).revoked, true);
});

test('会社の管理者だけが全員の判断の key を失効させられる（plugin を外す前）', async () => {
  await bind('u1');
  await bind('u2');
  await relay.decisionKeys.request(CO, 'u1');
  const c1 = approve('ch1', 'u1');
  await relay.syncCompany(CO);
  await relay.decisionKeys.request(CO, 'u2');
  assert.deepEqual(await relay.decisionKeys.revokeAll(CO, 'u1'), { ok: false, reason: 'forbidden' });
  const r = await relay.decisionKeys.revokeAll(CO, 'adm');
  assert.deepEqual(r, { ok: true, revoked: 1, pending: 0 });
  assert.equal(srv.s.keys.get(c1.pendingKey).revoked, true);
  const c2 = approve('ch2', 'u2'); // 取り消しの後に承認された依頼も失効させる
  await relay.decisionKeys.maintain(CO);
  assert.equal(srv.s.keys.get(c2.pendingKey).revoked, true);
  assert.equal((await relay.bindings.role(CO, 'adm')).admin, true);
  assert.equal((await relay.bindings.role(CO, 'u1')).admin, false);
});

// ---- 独立レビュー r2（2026-11-11）で足した test ----

test('10 分の間に承認され、読みに行ったのが期限の後でも、本人の key として受ける（本体は承認済みでも expired と返す）', async () => {
  await bind('u1');
  await relay.decisionKeys.request(CO, 'u1');
  const c = approve('ch1', 'u1');
  clockRef.now += 11 * 60 * 1000;
  await relay.syncCompany(CO);
  assert.equal((await keysOf()).u1.key, c.pendingKey);
  assert.equal(srv.s.keys.get(c.pendingKey).revoked, false);
});

test('捨てた依頼が承認され、本体が期限の後に expired と返しても、その key を失効させる', async () => {
  const b1 = await bind('u1');
  await relay.decisionKeys.request(CO, 'u1');
  await relay.bindings.remove(CO, 'u1', b1);
  const c = approve('ch1', 'u1');
  clockRef.now += 11 * 60 * 1000;
  await relay.decisionKeys.maintain(CO);
  assert.equal(srv.s.keys.get(c.pendingKey).revoked, true);
});

test('全員の取り消しは、key を持ったことの無い人の記録を「切れた」に変えない', async () => {
  await bind('u1');
  await relay.decisionKeys.request(CO, 'u1');
  clockRef.now += 11 * 60 * 1000;
  await relay.decisionKeys.maintain(CO);
  await relay.decisionKeys.revokeAll(CO, 'adm');
  assert.equal((await relay.decisionKeys.status(CO, 'u1')).state, 'none');
});

// ---- 独立レビュー r3（2026-11-11・P3）で足した test ----

test('捨てた依頼は、本体が答えないままでも期限の 24 時間後に捨てる', async () => {
  const b1 = await bind('u1');
  await relay.decisionKeys.request(CO, 'u1');
  await relay.bindings.remove(CO, 'u1', b1);
  const origEmit = srv.server.listeners('request')[0];
  srv.server.removeAllListeners('request');
  srv.server.on('request', (req, res) => (req.url === '/api/cli-auth/me' ? (res.writeHead(503), res.end()) : origEmit(req, res)));
  const abandonedOf = async () => (await ctx.state.get({ scopeKind: 'company', scopeId: CO, namespace: 'mobile', stateKey: 'keyAbandoned' })) || [];
  clockRef.now += 2 * 60 * 60 * 1000;
  await relay.decisionKeys.maintain(CO);
  assert.equal((await abandonedOf()).length, 1);
  clockRef.now += 23 * 60 * 60 * 1000;
  await relay.decisionKeys.maintain(CO);
  assert.equal((await abandonedOf()).length, 0);
  srv.server.removeAllListeners('request');
  srv.server.on('request', origEmit);
});
