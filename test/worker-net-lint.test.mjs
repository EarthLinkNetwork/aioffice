// 保証 2: worker から外へ送らない。worker の網は囲われていない（実測 6）ので、守りはこの lint だけ。
// 自前の src（worker から届く file）は例外なし。束ねた worker（SDK 入り）は、SDK の既知の箇所だけを SDK の版つきで除く。
import test from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
// node: の付かない名前（'http'・'net'・'tls'・'dgram'・'child_process'）の import・require も拾う（独立レビュー P2-9）
const MODS = '(?:node:)?(?:http|https|http2|net|tls|dgram|child_process|worker_threads)';
const PAT = new RegExp(`fetch\\(|http\\.request|https\\.|undici|WebSocket|globalThis\\[|from\\s*['"]${MODS}['"]|require\\(\\s*['"]${MODS}['"]\\s*\\)|import\\(\\s*['"]${MODS}['"]\\s*\\)`, 'g');
const SDK = JSON.parse(readFileSync(path.join(root, 'node_modules/@paperclipai/plugin-sdk/package.json'), 'utf8')).version;
// SDK の中の既知の箇所（説明の文・設定の欄の名前・本体を通す ctx.http の口）。SDK の版が変わったら中身を見直して書き直す
const SDK_KNOWN = { '2026.1001.0': ['WebSocket receiving works', 'runnerWebSocketIngress', 'http: { async fetch(url2, init)'] };
// 外へ送ると manifest で宣言した plugin（http.outbound・例: mobile の push）はこの lint の外。宣言の無い plugin だけにかける
const ALL = readdirSync(path.join(root, 'plugins')).filter(n => existsSync(path.join(root, 'plugins', n, 'src', 'worker.mjs')));
const manifestOf = async n => (await import(path.join(root, 'plugins', n, 'src', 'manifest.mjs'))).default;
const PLUGINS = [];
for (const n of ALL) if (!(await manifestOf(n)).capabilities.includes('http.outbound')) PLUGINS.push(n);
const flat = s => s.replace(/\s+/g, ' ');

test('office・design・library は外へ送る宣言を持たず、この lint にかかる', async () => {
  for (const n of ['office', 'design', 'library']) { assert.ok(PLUGINS.includes(n), n); const m = await manifestOf(n); for (const c of ['http.outbound', 'secrets.read-ref']) assert.ok(!m.capabilities.includes(c), `${n} に ${c}`); }
});
// notify は 0.2.0 で Slack への届けのために外へ送る宣言を持つ（docs/review/2026-11-18-slack-notify-scope.md）。
// この lint の外になる代わりに、送る所が 1 か所だけなことを test/plugin-notify-slack.test.mjs の lint で確かめる
test('notify は外へ送る宣言を持ち、この lint の外（Slack の lint にかかる）', async () => {
  assert.ok(!PLUGINS.includes('notify'));
  const m = await manifestOf('notify'); for (const c of ['http.outbound', 'secrets.read-ref']) assert.ok(m.capabilities.includes(c), c);
  assert.ok(existsSync(path.join(root, 'test', 'plugin-notify-slack.test.mjs')));
});

for (const name of PLUGINS) {
  test(`${name}: worker から届く自前の src と束ねた worker に、外へ送る口が無い`, async () => {
    const r = await build({ entryPoints: [path.join(root, 'plugins', name, 'src', 'worker.mjs')], bundle: true, platform: 'node', format: 'esm', target: 'node22', write: false, metafile: true, logLevel: 'silent', legalComments: 'none' });
    const own = Object.keys(r.metafile.inputs).filter(p => !p.includes('node_modules'));
    assert.ok(own.length >= 1);
    for (const p of own) {
      const s = readFileSync(path.resolve(process.cwd(), p), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:'"`\\])\/\/.*$/gm, '$1');
      assert.deepEqual([...s.matchAll(PAT)].map(m => m[0]), [], `${p} に外へ送る口`);
    }
    const known = SDK_KNOWN[SDK];
    assert.ok(known, `SDK ${SDK} の既知の箇所が未登録（中身を見て SDK_KNOWN に足す）`);
    // 配る物は plugins/build.mjs と同じ設定で束ねた worker。dist があればそれも同じ決まりで見る
    const dist = path.join(root, 'plugins', name, 'dist', 'worker.js');
    const out = flat(r.outputFiles[0].text + (existsSync(dist) ? '\n' + readFileSync(dist, 'utf8') : ''));
    const bad = [...out.matchAll(PAT)].map(m => out.slice(Math.max(0, m.index - 60), m.index + 40)).filter(ctx => !known.some(k => ctx.includes(k)));
    assert.deepEqual(bad, []);
  });
}

test('lint の道具: node: の付かない import・require・動的 import も拾う', () => {
  for (const src of ["import http from 'http'", 'import { request } from "https"', "const n = require('net')", "await import('child_process')", "import x from 'node:tls'"]) { PAT.lastIndex = 0; assert.ok(PAT.test(src), src); }
  PAT.lastIndex = 0; assert.ok(!PAT.test("import { x } from './lib.mjs'"));
});
