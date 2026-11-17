// 解いた秘密を覚えておく部品（plugins/mobile/src/secret-cache.mjs）。本体の 1 分 30 回の上限に当たらないため。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createSecretCache } from '../plugins/mobile/src/secret-cache.mjs';

const ref = id => ({ type: 'secret_ref', secretId: id });

test('同じ秘密を 25 件の card で使っても、5 分の間は 1 回しか解かない', async () => {
  let n = 0, t = 0;
  const c = createSecretCache({ resolve: async () => { n++; return 'v'; }, now: () => t });
  for (let i = 0; i < 25; i++) assert.equal(await c.get(ref('a'), 'co'), 'v');
  assert.equal(n, 1);
  t = 5 * 60_000; await c.get(ref('a'), 'co'); assert.equal(n, 2);
});

test('同時に来た分は 1 回の解きを共有し、会社・秘密・版ごとに分ける', async () => {
  let n = 0;
  const c = createSecretCache({ resolve: async (r, { companyId }) => { n++; return `${companyId}:${r.secretId}:${r.version ?? 'latest'}`; } });
  const [x, y] = await Promise.all([c.get(ref('a'), 'co'), c.get(ref('a'), 'co')]);
  assert.equal(x, y); assert.equal(n, 1);
  assert.equal(await c.get(ref('a'), 'co2'), 'co2:a:latest');
  assert.equal(await c.get({ ...ref('a'), version: 2 }, 'co'), 'co:a:2');
  assert.equal(n, 3);
});

test('失敗は覚えず次で解き直す・forget でその秘密だけ解き直す', async () => {
  let n = 0;
  const c = createSecretCache({ resolve: async () => { n++; if (n === 1) throw new Error('rate'); return 'v'; } });
  await assert.rejects(c.get(ref('a'), 'co'));
  assert.equal(await c.get(ref('a'), 'co'), 'v');
  c.forget(ref('a'), 'co'); await c.get(ref('a'), 'co'); assert.equal(n, 3);
});

test('解いている途中で捨てたら、古い値を覚えない・空の値は覚えない', async () => {
  let n = 0, release;
  const c = createSecretCache({ resolve: () => { n++; return n === 1 ? new Promise(r => { release = r; }) : Promise.resolve(n === 2 ? '' : 'new'); } });
  const p = c.get(ref('a'), 'co');
  await new Promise(r => setImmediate(r)); // 解きが始まるのを待つ
  c.forget(ref('a'), 'co');
  release('old'); assert.equal(await p, 'old');
  assert.equal(await c.get(ref('a'), 'co'), '');   // 捨てた後は解き直す（2 回目は空）
  assert.equal(await c.get(ref('a'), 'co'), 'new'); // 空は覚えないので 3 回目も解く
  assert.equal(n, 3);
});
