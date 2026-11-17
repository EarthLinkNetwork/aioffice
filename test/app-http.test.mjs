// アプリの本物の client（apps/mobile/src/notify/http.ts）。通知 API の口の呼び方・PKCE の受け渡し・端末登録・401 を確かめる。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createHttpClient } from '../apps/mobile/src/notify/http.ts';
import { pushEnv, tapTarget, registerForPush, BUNDLE_ID } from '../apps/mobile/src/notify/push-logic.ts';
import { base64url } from '../apps/mobile/src/notify/pkce.ts';

const BASE = 'https://notify.example.test';
const mem = (t = null) => ({ t, async get() { return this.t; }, async set(v) { this.t = v; }, async clear() { this.t = null; } });
// routes: 'METHOD /path' -> {status, body} か関数
function setup({ routes = {}, token = null, openAuth } = {}) {
  const calls = [];
  const fetch = async (url, init = {}) => {
    const u = new URL(url);
    const key = `${init.method} ${u.pathname}`;
    calls.push({ key, search: u.search, auth: init.headers?.authorization, body: init.body ? JSON.parse(init.body) : undefined });
    const r = routes[key] ?? { status: 404, body: {} };
    const res = typeof r === 'function' ? r() : r;
    return { status: res.status, json: async () => res.body };
  };
  const store = mem(token);
  const client = createHttpClient({ baseUrl: BASE + '/', store, fetch, openAuth: openAuth ?? (async () => null) });
  return { client, calls, store };
}
const card = (id, o = {}) => ({ v: 1, id, bindingId: 'b1', kind: 'approval', risk: 'internal', title: 't', summary: '', recommendation: '', options: [], deadline: null, sections: [], links: [], createdAt: null, actions: [{ id: 'approve', label: 'Approve' }], ...o });

test('サインイン: PKCE の challenge で開き、戻った code と verifier で token に替えて保存する', async () => {
  let opened;
  const { client, calls, store } = setup({
    openAuth: async (url, redirect) => { opened = { url, redirect }; return 'aioffice://auth?code=CODE123'; },
    routes: { 'POST /api/v1/app/auth/token': { status: 200, body: { token: 'TOK', expiresAt: 'x', me: { email: 'a@example.org', provider: 'P' } } } },
  });
  const me = await client.signIn();
  assert.deepEqual(me, { email: 'a@example.org', provider: 'P' });
  assert.equal(store.t, 'TOK');
  const u = new URL(opened.url);
  assert.equal(u.origin + u.pathname, BASE + '/api/v1/app/auth/start');
  assert.equal(opened.redirect, 'aioffice://auth');
  assert.equal(u.searchParams.get('redirect'), 'aioffice://auth');
  assert.equal(u.searchParams.get('code_challenge_method'), 'S256');
  const body = calls.find(c => c.key === 'POST /api/v1/app/auth/token').body;
  assert.equal(body.code, 'CODE123');
  assert.match(body.code_verifier, /^[A-Za-z0-9_-]{43,128}$/);
  assert.equal(u.searchParams.get('code_challenge'), createHash('sha256').update(body.code_verifier).digest('base64url'));
  assert.equal(calls.find(c => c.key === 'POST /api/v1/app/auth/token').auth, undefined);
});

test('サインインの verifier は 1 回ごとに変わる。閉じた・error の戻りでは token を作らない', async () => {
  const verifiers = [];
  const route = () => ({ status: 200, body: { token: 'T', me: { email: 'a', provider: 'P' } } });
  for (let i = 0; i < 2; i++) {
    const { client, calls } = setup({ openAuth: async () => 'aioffice://auth?code=C', routes: { 'POST /api/v1/app/auth/token': route } });
    await client.signIn(); verifiers.push(calls[0].body.code_verifier);
  }
  assert.notEqual(verifiers[0], verifiers[1]);
  for (const back of [null, 'aioffice://auth?error=access_denied']) {
    const { client, calls, store } = setup({ openAuth: async () => back });
    assert.equal(await client.signIn(), null);
    assert.equal(calls.length, 0); assert.equal(store.t, null);
  }
});

test('base64url は標準の実装と同じ', () => {
  for (const n of [1, 2, 3, 31, 32]) { const b = Uint8Array.from({ length: n }, (_, i) => (i * 37 + 11) & 255); assert.equal(base64url(b), Buffer.from(b).toString('base64url')); }
});

test('Bearer を付けて呼ぶ: me・bindings・cards・actions・seen の口', async () => {
  const { client, calls } = setup({ token: 'TOK', routes: {
    'GET /api/v1/app/me': { status: 200, body: { email: 'a@example.org', provider: 'P' } },
    'GET /api/v1/app/bindings': { status: 200, body: { bindings: [{ id: 'b1', company: 'X社', decisions: 'approved' }, { id: 'b2', company: 'Y社', decisions: 'pending' }] } },
    'GET /api/v1/app/cards': { status: 200, body: { cards: [card('c1'), card('c2'), card('c3', { bindingId: 'b2' })] } },
    'POST /api/v1/app/bindings/b1/cards/c1/actions': { status: 200, body: { ok: true } },
    'POST /api/v1/app/bindings/b1/cards/c1/seen': { status: 200, body: { ok: true } },
  } });
  assert.equal((await client.me()).email, 'a@example.org');
  const offices = await client.listOffices();
  assert.deepEqual(offices, [{ id: 'b1', name: 'X社', canView: true, pending: 2 }, { id: 'b2', name: 'Y社', canView: false, pending: 1 }]);
  assert.equal((await client.listCards('b1')).length, 2);
  assert.equal(calls.filter(c => c.key === 'GET /api/v1/app/cards').every(c => c.search === ''), true); // 絞り込みは手元
  assert.equal((await client.summary('b1')).pending, 2);
  assert.deepEqual(await client.act(card('c1'), 'approve', { note: 'n' }), { ok: true });
  assert.deepEqual(calls.find(c => c.key.endsWith('/actions')).body, { actionId: 'approve', values: { note: 'n' } });
  assert.deepEqual(await client.markSeen(card('c1')), { ok: true });
  assert.ok(calls.every(c => c.auth === 'Bearer TOK'));
});

test('act: サーバーの失敗は画面に出す文にする。bindingId の無い件は送らない', async () => {
  const { client, calls } = setup({ token: 'T', routes: { 'POST /api/v1/app/bindings/b1/cards/c1/actions': { status: 400, body: { code: 'note-required' } } } });
  assert.deepEqual(await client.act(card('c1'), 'reject'), { ok: false, message: '理由を書いてください' });
  const n = calls.length;
  assert.equal((await client.act(card('c9', { bindingId: undefined }), 'approve')).ok, false);
  assert.equal(calls.length, n);
});

test('端末の登録と解除: 生の device token・env・bundleId を送る', async () => {
  const { client, calls } = setup({ token: 'T', routes: { 'POST /api/v1/app/devices': { status: 200, body: { ok: true } }, 'DELETE /api/v1/app/devices': { status: 200, body: { ok: true } } } });
  assert.equal(await client.registerDevice('ab12cd34ab12cd34ab12', 'sandbox', BUNDLE_ID), true);
  assert.deepEqual(calls[0].body, { platform: 'ios', token: 'ab12cd34ab12cd34ab12', env: 'sandbox', bundleId: 'jp.ne.eln.aioffice' });
  await client.unregisterDevice('ab12cd34ab12cd34ab12');
  assert.deepEqual(calls[1], { key: 'DELETE /api/v1/app/devices', search: '', auth: 'Bearer T', body: { token: 'ab12cd34ab12cd34ab12' } });
});

test('401: token を消してサインイン画面へ戻す合図を出す', async () => {
  const { client, store } = setup({ token: 'OLD', routes: { 'GET /api/v1/app/cards': { status: 401, body: { code: 'unauthorized' } }, 'GET /api/v1/app/bindings': { status: 401, body: {} } } });
  let signedOut = 0; client.onUnauthorized(() => { signedOut++; });
  await assert.rejects(client.listCards('b1'));
  assert.equal(store.t, null); assert.equal(signedOut, 1);
  assert.equal(await client.me(), null); // token が無ければ呼ばずに null
});

test('me: 401 なら token を消して null、通信できない時は token を残す', async () => {
  const a = setup({ token: 'OLD', routes: { 'GET /api/v1/app/me': { status: 401, body: {} } } });
  assert.equal(await a.client.me(), null); assert.equal(a.store.t, null);
  const store = mem('KEEP');
  const client = createHttpClient({ baseUrl: BASE, store, openAuth: async () => null, fetch: async () => { throw new Error('offline'); } });
  assert.equal(await client.me(), null); assert.equal(store.t, 'KEEP');
});

test('サインアウト: サーバーに知らせ、失敗しても token は消す', async () => {
  const { client, calls, store } = setup({ token: 'T', routes: {} });
  await client.signOut();
  assert.equal(calls[0].key, 'POST /api/v1/app/auth/signout'); assert.equal(store.t, null);
});

test('provider の名前はサーバーから読む', async () => {
  const { client } = setup({ routes: { 'GET /api/v1/app/auth/provider': { status: 200, body: { name: 'サンプル ID' } } } });
  assert.equal(await client.authProvider(), 'サンプル ID');
});

test('push の env: profile の値を優先し、読めない時は __DEV__ で決める', () => {
  assert.equal(pushEnv('production', true), 'production');
  assert.equal(pushEnv('development', false), 'sandbox');
  assert.equal(pushEnv(null, true), 'sandbox');
  assert.equal(pushEnv(null, false), 'production');
});

test('通知を押した時の宛先: bindingId と cardId が揃う時だけ', () => {
  assert.deepEqual(tapTarget({ bindingId: 'b1', cardId: 'c1', extra: 1 }), { bindingId: 'b1', cardId: 'c1' });
  for (const d of [null, 'x', {}, { bindingId: 'b1' }, { cardId: 'c1' }, { bindingId: '', cardId: 'c1' }, { bindingId: 1, cardId: 'c1' }]) assert.equal(tapTarget(d), null);
});

test('push の登録: 許可が無ければ登録しない。あれば生の token を env・bundleId つきで登録する', async () => {
  const sent = [];
  const deps = (granted) => ({ requestPermission: async () => granted, getToken: async () => 'deadbeefdeadbeef', env: async () => 'production', register: async (...a) => { sent.push(a); return true; } });
  assert.equal(await registerForPush(deps(false)), null); assert.equal(sent.length, 0);
  assert.equal(await registerForPush(deps(true)), 'deadbeefdeadbeef');
  assert.deepEqual(sent, [['deadbeefdeadbeef', 'production', 'jp.ne.eln.aioffice']]);
});

test('サインアウト: 最後に登録した token を DELETE し、その後に届いた遅れた登録は送らない', async () => {
  const { client, calls, store } = setup({ token: 'T', routes: { 'POST /api/v1/app/devices': { status: 200, body: {} }, 'DELETE /api/v1/app/devices': { status: 200, body: {} }, 'POST /api/v1/app/auth/signout': { status: 200, body: {} } } });
  await client.registerDevice('aaaaaaaaaaaaaaaaaaaa', 'production', BUNDLE_ID);
  const late = client.signOut().then(() => client.registerDevice('bbbbbbbbbbbbbbbbbbbb', 'production', BUNDLE_ID));
  assert.equal(await late, false);
  assert.deepEqual(calls.map(c => c.key), ['POST /api/v1/app/devices', 'DELETE /api/v1/app/devices', 'POST /api/v1/app/auth/signout']);
  assert.deepEqual(calls[1].body, { token: 'aaaaaaaaaaaaaaaaaaaa' });
  assert.equal(store.t, null);
});

test('サインアウト中に始まった登録も、DELETE の後には送らない', async () => {
  const { client, calls } = setup({ token: 'T', routes: { 'POST /api/v1/app/devices': { status: 200, body: {} } } });
  const p = client.signOut(); // flag は同期に立つ
  assert.equal(await client.registerDevice('cccccccccccccccccccc', 'production', BUNDLE_ID), false);
  await p;
  assert.equal(calls.some(c => c.key === 'POST /api/v1/app/devices'), false);
});

test('401: 持っている端末 token の DELETE を試みてから token を消す', async () => {
  const { client, calls, store } = setup({ token: 'OLD', routes: { 'POST /api/v1/app/devices': { status: 200, body: {} }, 'GET /api/v1/app/prefs': { status: 401, body: {} }, 'DELETE /api/v1/app/devices': { status: 401, body: {} } } });
  await client.registerDevice('dddddddddddddddddddd', 'production', BUNDLE_ID);
  await assert.rejects(client.prefs());
  assert.deepEqual(calls.at(-1).body, { token: 'dddddddddddddddddddd' });
  assert.equal(store.t, null);
});

test('一度の読み込み: GET /cards は 1 回、絞り込みは手元', async () => {
  const { client, calls } = setup({ token: 'T', routes: {
    'GET /api/v1/app/bindings': { status: 200, body: { bindings: [{ id: 'b1', company: 'X社', decisions: 'approved' }] } },
    'GET /api/v1/app/cards': { status: 200, body: { cards: [card('c1'), card('c2', { bindingId: 'b2' })] } } } });
  const [list, sum, offs] = await Promise.all([client.listCards('b1'), client.summary('b1'), client.listOffices()]);
  assert.equal(list.length, 1); assert.equal(sum.pending, 1); assert.equal(offs[0].pending, 1);
  assert.equal(calls.filter(c => c.key === 'GET /api/v1/app/cards').length, 1);
});

test('A: 前の起動で登録済みで今回の登録が失敗 → サインアウトは取り直した token で DELETE する', async () => {
  const calls = [];
  const store = mem('T');
  const fetch = async (url, init = {}) => { const u = new URL(url); calls.push({ key: `${init.method} ${u.pathname}`, body: init.body ? JSON.parse(init.body) : undefined }); return { status: u.pathname.endsWith('/devices') && init.method === 'POST' ? 503 : 200, json: async () => ({}) }; };
  const client = createHttpClient({ baseUrl: BASE, store, fetch, openAuth: async () => null, deviceToken: async () => 'eeeeeeeeeeeeeeeeeeee' });
  assert.equal(await client.registerDevice('eeeeeeeeeeeeeeeeeeee', 'production', BUNDLE_ID), false); // 5xx
  await client.signOut();
  assert.deepEqual(calls.map(c => c.key), ['POST /api/v1/app/devices', 'DELETE /api/v1/app/devices', 'POST /api/v1/app/auth/signout']);
  assert.deepEqual(calls[1].body, { token: 'eeeeeeeeeeeeeeeeeeee' });
  assert.equal(await client.registerDevice('ffffffffffffffffffff', 'production', BUNDLE_ID), false); // その後の登録は出ない
  assert.equal(calls.length, 3);
});

test('A2: 取り直しも失敗したら諦めて signout へ進む', async () => {
  const calls = [];
  const client = createHttpClient({ baseUrl: BASE, store: mem('T'), openAuth: async () => null, deviceToken: async () => { throw new Error('no permission'); },
    fetch: async (url, init = {}) => { calls.push(`${init.method} ${new URL(url).pathname}`); return { status: 200, json: async () => ({}) }; } });
  await client.signOut();
  assert.deepEqual(calls, ['POST /api/v1/app/auth/signout']);
});

test('C: 電波が無く端末 token の取り直しも通信も返らない時も、サインアウトは期限で進み token を消す', async () => {
  const store = mem('T'); const never = new Promise(() => {});
  const client = createHttpClient({ baseUrl: BASE, store, openAuth: async () => null, deviceToken: () => never, signOutWaitMs: 20,
    fetch: () => never });
  await client.signOut();
  assert.equal(await store.get(), null);
});

test('B: 登録の応答待ちの間にサインアウト → 応答を待って、その token を DELETE する', async () => {
  const calls = []; let release;
  const gate = new Promise(res => { release = res; });
  const fetch = async (url, init = {}) => {
    const key = `${init.method} ${new URL(url).pathname}`; calls.push({ key, body: init.body ? JSON.parse(init.body) : undefined });
    if (key === 'POST /api/v1/app/devices') await gate;
    return { status: 200, json: async () => ({}) };
  };
  const client = createHttpClient({ baseUrl: BASE, store: mem('T'), fetch, openAuth: async () => null });
  const reg = client.registerDevice('gggggggggggggggggggg', 'production', BUNDLE_ID);
  await new Promise(res => setTimeout(res, 5)); // POST が送られ、応答待ち
  const out = client.signOut();
  await new Promise(res => setTimeout(res, 5));
  assert.equal(calls.some(c => c.key.startsWith('DELETE')), false); // まだ待っている
  release(); await reg; await out;
  assert.deepEqual(calls.map(c => c.key), ['POST /api/v1/app/devices', 'DELETE /api/v1/app/devices', 'POST /api/v1/app/auth/signout']);
  assert.deepEqual(calls[1].body, { token: 'gggggggggggggggggggg' });
});

test('401 の時 listOffices は token 消去と合図を 1 回だけ行う', async () => {
  const { client } = setup({ token: 'T', routes: { 'GET /api/v1/app/bindings': { status: 401, body: {} }, 'GET /api/v1/app/cards': { status: 401, body: {} } } });
  let n = 0; client.onUnauthorized(() => { n++; });
  await assert.rejects(client.listOffices());
  assert.equal(n, 1);
});

test('act: 通信が失敗しても例外にせず、画面に出す文を返す（押しても何も起きない、にしない）', async () => {
  const fetch = async () => { throw new TypeError('Network request failed'); };
  const client = createHttpClient({ baseUrl: BASE, store: mem('TOK'), fetch, openAuth: async () => null });
  const r = await client.act(card('c1'), 'approve');
  assert.equal(r.ok, false);
  assert.match(r.message, /通信できませんでした/);
});

test('act: 応答が返らない時は期限で止めて、画面に出す文を返す', async () => {
  const fetch = (_u, init) => new Promise((_, rej) => init.signal?.addEventListener('abort', () => rej(Object.assign(new Error('aborted'), { name: 'AbortError' }))));
  const client = createHttpClient({ baseUrl: BASE, store: mem('TOK'), fetch, openAuth: async () => null, actTimeoutMs: 30 });
  const r = await client.act(card('c1'), 'approve');
  assert.equal(r.ok, false);
  assert.match(r.message, /応答がありません/);
});

test('act: 送信済みの 409 は「送信済み」と出す', async () => {
  const { client } = setup({ token: 'TOK', routes: { 'POST /api/v1/app/bindings/b1/cards/c1/actions': { status: 409, body: { code: 'action-already-pending' } } } });
  const r = await client.act(card('c1'), 'approve');
  assert.equal(r.ok, false);
  assert.match(r.message, /送信済み/);
});

test('act: 401 は例外にせず「サインインし直して」と返し、token を消して合図を出す', async () => {
  const { client, store } = setup({ token: 'TOK', routes: { 'POST /api/v1/app/bindings/b1/cards/c1/actions': { status: 401, body: { code: 'unauthorized' } } } });
  let n = 0; client.onUnauthorized(() => { n++; });
  const r = await client.act(card('c1'), 'approve');
  assert.equal(r.ok, false);
  assert.match(r.message, /サインインし直して/);
  assert.equal(store.t, null);
  assert.equal(n, 1);
});

test('一覧: サーバーが 500 の時は空の一覧にせず失敗にする（会社が 0 件に見えるのを防ぐ）', async () => {
  const { client } = setup({ token: 'TOK', routes: {
    'GET /api/v1/app/bindings': { status: 500, body: {} },
    'GET /api/v1/app/cards': { status: 200, body: { cards: [] } },
  } });
  await assert.rejects(() => client.listOffices());
  await assert.rejects(() => client.listBindings());
  const c2 = setup({ token: 'TOK', routes: { 'GET /api/v1/app/cards': { status: 500, body: {} } } }).client;
  await assert.rejects(() => c2.listCards('b1'));
});

test('prefs: 500 の時は既定値を作らず失敗にする（切り替えで設定を誤った値に上書きしない）', async () => {
  const { client } = setup({ token: 'TOK', routes: { 'GET /api/v1/app/prefs': { status: 500, body: {} } } });
  await assert.rejects(() => client.prefs());
});
