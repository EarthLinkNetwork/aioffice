// e2e の assert に Playwright の要素（ElementHandle・Locator）をそのまま渡さない
// なぜ: assert.equal(await page.$(x), null, msg) が失敗すると、node は違いの文を作るために要素を util.inspect で丸ごと文字にする。
// 要素はブラウザとの接続の全体を辿るので、同期のまま数 GB を作り、container の上限 12GB で kernel に止められた
// （2026-11-21 amd64・2026-11-22 arm64 の Slack の e2e の 6 番。event loop が止まるのでメモリの見張りの行も出なかった）。
// 比べる時は `(await page.$(x)) === null` のような真偽値にする（assert.ok(要素, msg) は文を作らないのでよい）
import test from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';

const DIR = new URL('./e2e/', import.meta.url);
const COMPARE = /assert\.(?:equal|strictEqual|notEqual|notStrictEqual|deepEqual|deepStrictEqual|notDeepEqual|notDeepStrictEqual)\(\s*(?:await\s+)?(?:page|frame|root|el|ctx)\.(?:\$\$?|locator|getBy[A-Za-z]+)\((?:[^()]|\([^()]*\))*\)\s*[,)]/; // 呼び出しが閉じた直後に引数が終わる形だけ（.count()・.textContent() の比べは拾わない）
// 拾わない形（網羅ではない）: 行をまたぐ assert・一度変数に入れた要素・page・frame・root・el・ctx 以外の receiver

export function findBad(text) {
  return text.split('\n').map((l, i) => [i + 1, l]).filter(([, l]) => COMPARE.test(l)).map(([n]) => n);
}

test('e2e の比べる assert に要素をそのまま渡さない', () => {
  const bad = [];
  for (const f of readdirSync(DIR).filter(n => n.endsWith('.mjs'))) for (const n of findBad(readFileSync(new URL(f, DIR), 'utf8'))) bad.push(`test/e2e/${f}:${n}`);
  assert.deepEqual(bad, []);
});

test('見つける形: 要素を比べる形は拾い、真偽値・数・文字・assert.ok は拾わない', () => {
  assert.deepEqual(findBad("assert.equal(await page.$('[x]'), null, 'm');"), [1]);
  assert.deepEqual(findBad("assert.deepEqual(await page.$$('li'), []);"), [1]);
  assert.deepEqual(findBad("assert.notEqual(page.locator('a'), null);"), [1]);
  assert.deepEqual(findBad("assert.equal(await page.$(`[data-x=\"${k}\"]`), null);"), [1]);
  assert.deepEqual(findBad([
    "assert.equal((await page.$('[x]')) === null, true, 'm');",
    "assert.equal(await page.$$eval('li', els => els.length), 2);",
    "assert.equal(await page.getAttribute('[x]', 'data-x'), 'on');",
    "assert.ok(await page.$('[x]'), 'm');",
    "assert.equal(await page.locator('[x]').count(), 0);",
    "assert.equal(await page.getByRole('button').textContent(), 'OK');",
  ].join('\n')), []);
});
