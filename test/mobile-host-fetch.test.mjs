// 本体を呼ぶ fetch に hostHeaders を足す部品（plugins/mobile/src/host-fetch.mjs）。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeHostFetch, allowedHostHeaderName } from '../plugins/mobile/src/host-fetch.mjs';

const capture = () => { const calls = []; return { calls, fetch: async (url, init) => { calls.push({ url, init }); return { status: 200 }; } }; };

test('設定の header を足し、元の authorization と content-type は上書きしない', async () => {
  const c = capture();
  const f = makeHostFetch({ fetch: c.fetch, getHeaders: async () => ({ 'X-Proxy-Id': 'id1', 'X-Proxy-Secret': 's1', authorization: 'Bearer evil', 'Content-Type': 'text/evil' }) });
  await f('https://host/api/x', { method: 'POST', headers: { authorization: 'Bearer key', 'content-type': 'application/json' } });
  const h = c.calls[0].init.headers;
  assert.equal(h['X-Proxy-Id'], 'id1'); assert.equal(h['X-Proxy-Secret'], 's1');
  assert.equal(h.authorization, 'Bearer key'); assert.equal(h['content-type'], 'application/json');
  assert.equal(h['Content-Type'], undefined);
});

test('認証や cookie に関わる名前・形の悪い名前・空の値は足さない', async () => {
  for (const n of ['authorization', 'Cookie', 'host', 'a b', 'x'.repeat(65), '']) assert.equal(allowedHostHeaderName(n), false, n);
  assert.equal(allowedHostHeaderName('CF-Access-Client-Id'), true);
  const c = capture();
  await makeHostFetch({ fetch: c.fetch, getHeaders: async () => ({ Cookie: 'x', 'X-Empty': '', 'X-Ok': 'v' }) })('https://host/', {});
  assert.deepEqual(c.calls[0].init.headers, { 'X-Ok': 'v' });
});

test('設定が無い時は元の header のまま呼ぶ', async () => {
  const c = capture();
  await makeHostFetch({ fetch: c.fetch, getHeaders: async () => null })('https://host/', { headers: { authorization: 'Bearer k' } });
  assert.deepEqual(c.calls[0].init.headers, { authorization: 'Bearer k' });
});

test('proxy に断られた形（302）なら、覚えた値を捨てて 1 回だけ呼び直す', async () => {
  let gen = 0, calls = 0;
  const f = makeHostFetch({ fetch: async (url, init) => { calls++; return { status: init.headers['X-P'] === 'v1' ? 200 : 302 }; },
    getHeaders: async () => ({ 'X-P': `v${gen}` }), refresh: () => { gen++; return true; } });
  assert.equal((await f('https://h/', {})).status, 200);
  assert.equal(calls, 2); assert.equal(gen, 1);
});

test('401・403（本体が判断の鍵を断った）では捨てず、呼び直さない', async () => {
  for (const status of [401, 403]) {
    let calls = 0, refreshed = 0;
    const f = makeHostFetch({ fetch: async () => { calls++; return { status }; }, getHeaders: async () => ({ 'X-P': 'v' }), refresh: () => { refreshed++; return true; } });
    for (let i = 0; i < 5; i++) assert.equal((await f('https://h/', {})).status, status);
    assert.equal(calls, 5); assert.equal(refreshed, 0);
  }
});

test('header を付けていない時・間隔の内（refresh が false）は呼び直さない', async () => {
  let calls = 0;
  const none = makeHostFetch({ fetch: async () => { calls++; return { status: 302 }; }, getHeaders: async () => ({}), refresh: () => true });
  assert.equal((await none('https://h/', {})).status, 302); assert.equal(calls, 1);
  calls = 0;
  const held = makeHostFetch({ fetch: async () => { calls++; return { status: 302 }; }, getHeaders: async () => ({ 'X-P': 'v' }), refresh: () => false });
  assert.equal((await held('https://h/', {})).status, 302); assert.equal(calls, 1);
});
