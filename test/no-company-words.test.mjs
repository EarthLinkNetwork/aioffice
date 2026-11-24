// この repo は他社にも配る汎用の部分だけを置く。特定の会社の運用の語が入ったら落とす。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
import { WORDS, WORD_COUNT, ANY_CASE } from './company-words.mjs';
// 語の一覧は company-words.mjs にだけ書く（このファイルとその module は調べない）
const WORDS_FILE = fileURLToPath(new URL('./company-words.mjs', import.meta.url));
// 画像・font などの binary を除く全部の file を調べる（public/ の下は全部が公開の repo に写り、public にすると全部読まれる・2026-11-17）
// .eln の記録（レビューの記録）も写るので調べる
// package-lock.json は外の部品の名前の一覧（npm の commander など）なので調べない
const SKIP = new Set(['.git', 'node_modules', 'dist', 'ios', 'android', '.expo', 'package-lock.json']);
const BINARY = /\.(png|jpe?g|gif|webp|ico|icns|ttf|otf|woff2?|mp4|mov|pdf|zip|gz|tgz|wasm|car)$/i;
// 語ごとに、置いてよいファイルを 1 つずつ決める（ほかのファイルに入ったら落とす）
// 「Daily Times」はアプリの下のタブの名前（2026-11-14 承認の mock docs/mocks/app-chat-mock.html）。名前はこの 1 か所と、その試験だけに置く
const ALLOW = {
  'Daily Times': new Set(['apps/mobile/src/chat/labels.ts', 'test/app-chat.test.mjs', 'docs/mocks/app-chat-mock.html', 'docs/review/2026-11-14-app-chat-spec.md']),
  // 共有のスマホアプリ（配る側が 1 つを運用する）の知らせの中継の口。アプリの設定にだけ置く（image と plugin には入れない）
  'eln.ne.jp': new Set(['apps/mobile/app.json']),
  // 配った移行の file は書き換えない（hash を記録している）ので、注釈に残る開発元の repo の名前はこの 1 つだけ許す
  'aicompany': new Set(['plugins/library/migrations/002_embeddings.sql']),
};
const files = [];
const walk = d => { for (const n of readdirSync(d)) { if (SKIP.has(n)) continue; const p = path.join(d, n); if (statSync(p).isDirectory()) walk(p); else if (!BINARY.test(n) && p !== fileURLToPath(import.meta.url) && p !== WORDS_FILE) files.push(p); } };
walk(root);
// build した plugin（plugins/*/dist）は image に入る中身なので、有れば調べる（CI は image の build の中で作る）
const pluginsDir = path.join(root, 'plugins');
for (const n of readdirSync(pluginsDir)) { const d = path.join(pluginsDir, n, 'dist'); try { if (statSync(d).isDirectory()) { const w2 = x => { for (const m of readdirSync(x)) { const p = path.join(x, m); if (statSync(p).isDirectory()) w2(p); else if (/\.js$/.test(m)) files.push(p); } }; w2(d); } } catch { /* build していない */ } }

test('語の一覧が読めている（数が定数と同じ）・大文字と小文字を区別しない語は一覧の中にある', () => {
  assert.equal(WORDS.length, WORD_COUNT);
  for (const w of ANY_CASE) assert.ok(WORDS.includes(w), w);
});

test('コードと設定に特定の会社の語が入っていない', () => {
  const hits = [];
  for (const f of files) { const t = readFileSync(f, 'utf8'); const lt = t.toLowerCase(); for (const w of WORDS) if ((ANY_CASE.has(w) ? lt.includes(w.toLowerCase()) : t.includes(w)) && !ALLOW[w]?.has(path.relative(root, f))) hits.push(`${path.relative(root, f)}: ${w}`); }
  assert.deepEqual(hits, []);
});
