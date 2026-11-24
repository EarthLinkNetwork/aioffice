// 画面の文字は辞書から（範囲の保証 6）・AI の書いた文を HTML として出さない（保証 4）を、source を読んで確かめる
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const walk = d => readdirSync(d).flatMap(n => { const p = path.join(d, n); return statSync(p).isDirectory() ? walk(p) : [p]; });
const SRC = ['plugins/office/src', 'plugins/board/src', 'plugins/design/src', 'plugins/notify/src', 'plugins/library/src', 'packages/aioffice/launcher/public'].flatMap(d => walk(path.join(root, d))).filter(p => /\.(mjs|js)$/.test(p));
// 辞書の置き場（ここだけは表示の文字を書いてよい）
const DICTS = new Set(['plugins/office/src/i18n.mjs', 'plugins/design/src/request.mjs', 'plugins/notify/src/lib.mjs', 'plugins/library/src/lib.mjs'].map(p => path.join(root, p)));
const strip = s => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:'"`\\])\/\/.*$/gm, '$1'); // 注釈を除く
const rel = p => path.relative(root, p);


// h(…)・el(…) の呼び出しの引数を、括弧と文字列を数えて切り出す（props に入れ子の {} があっても切れる）。
// 限界: 正規表現の中の括弧・引用符も数える。引用符を含む文字列（"Don't"）や連結（'Hello ' + x）は見つけない。誤りが出たら道具を直す
function callArgs(src, at) {
  const args = []; let depth = 0, cur = '', i = at;
  for (; i < src.length; i++) {
    const c = src[i];
    if (c === "'" || c === '"' || c === '`') { // 文字列はそのまま写す（template の ${} の中の文字列は数えない）
      let j = i + 1; while (j < src.length && src[j] !== c) { if (src[j] === '\\') j++; j++; }
      cur += src.slice(i, j + 1); i = j; continue;
    }
    if ('([{'.includes(c)) depth++;
    if (')]}'.includes(c)) { if (depth === 0) { args.push(cur.trim()); return args; } depth--; }
    if (c === ',' && depth === 0) { args.push(cur.trim()); cur = ''; continue; }
    cur += c;
  }
  return args;
}
const literalChildren = src => [...src.matchAll(/\b(?:h|el)\(\s*'[a-z0-9]+'\s*,/g)].flatMap(m => callArgs(src, m.index + m[0].indexOf('(') + 1).slice(2))
  .filter(a => /^(['"`])[^'"`]*[A-Za-z]{3}[^'"`]*\1$/.test(a) && !/\$\{/.test(a));

test('innerHTML・dangerouslySetInnerHTML・outerHTML・insertAdjacentHTML・document.write を使わない', () => {
  assert.ok(SRC.length >= 5);
  for (const p of SRC) {
    const s = strip(readFileSync(p, 'utf8'));
    for (const bad of ['innerHTML', 'dangerouslySetInnerHTML', 'outerHTML', 'insertAdjacentHTML', 'document.write']) assert.ok(!s.includes(bad), `${rel(p)} に ${bad}`);
  }
});

test('辞書の外に表示の文字を書かない（日本語の文字・title/placeholder/aria-label の文字・fillText の文字・要素の子の文）', () => {
  const found = [];
  for (const p of SRC) {
    if (DICTS.has(p)) continue;
    const s = strip(readFileSync(p, 'utf8'));
    const lit = /(['"`])((?:\\.|(?!\1).)*)\1/g;
    for (const m of s.matchAll(lit)) if (/[぀-ヿ㐀-鿿]/.test(m[2])) found.push(`${rel(p)}: 日本語 ${m[0].slice(0, 40)}`);
    for (const m of s.matchAll(/['"]?(title|placeholder|aria-label|alt|label)['"]?\s*:\s*(['"`])([^'"`]*[A-Za-z]{2}[^'"`]*)\2/g)) if (!/^#[0-9a-f]{3,8}$/i.test(m[3])) found.push(`${rel(p)}: ${m[1]} ${m[3]}`);
    for (const m of s.matchAll(/fillText\(\s*(['"`])([^'"`]*[A-Za-z]{2}[^'"`]*)\1/g)) found.push(`${rel(p)}: fillText ${m[2]}`);
    for (const a of literalChildren(s)) found.push(`${rel(p)}: 子の文 ${a}`);
    for (const m of s.matchAll(/textContent\s*=\s*(['"`])([^'"`]*[A-Za-z]{2}[^'"`]*)\1/g)) found.push(`${rel(p)}: textContent ${m[2]}`);
  }
  assert.deepEqual(found, []);
});

test('lint の道具: 入れ子の props・el・2 つ目の子の文字列も見つける', () => {
  const src = "el('button', { a: 1, on: { click: () => f('x') } }, 'English'); h('p', { style: { b: 2 } }, 'Loading'); h('p', null, t('k'), 'Second child'); h('p', null, t('ok'), `${x}`)";
  assert.deepEqual(literalChildren(src), ["'English'", "'Loading'", "'Second child'"]);
});

// オフィスの a と button は全部 Link・Button（plugins/office/src/controls.mjs）を通す。生の h('a'・h('button' を置かない
// （範囲 docs/review/2026-11-18-office-ai-panel-ux-scope.md G2・G3・F6: hover・押した時・focus・処理中の見た目と、リンクの色・下線・↗ を 1 か所で持つ）
test('office の src に生の a・button を書かない（Link・Button だけ。部品の置き場 controls.mjs を除く）', () => {
  const office = walk(path.join(root, 'plugins/office/src')).filter(p => /\.(mjs|js)$/.test(p) && path.basename(p) !== 'controls.mjs');
  assert.ok(office.length >= 5);
  const found = [];
  for (const p of office) {
    const s = strip(readFileSync(p, 'utf8'));
    for (const m of s.matchAll(/\b(?:h|createElement)\(\s*(['"`])(a|button)\1/g)) found.push(`${rel(p)}: ${m[0]}`);
  }
  assert.deepEqual(found, []);
  const controls = readFileSync(path.join(root, 'plugins/office/src/controls.mjs'), 'utf8');
  assert.match(controls, /export function Link/); assert.match(controls, /export function Button/);
});

test('e2e: 要素 1 つを渡す $eval で、複数の要素（els）を受ける形を書かない（$$eval に。e2e wiz8 の ja で落ちた）', () => {
  const dir = new URL('./e2e/', import.meta.url);
  const bad = [];
  for (const f of readdirSync(dir).filter(n => n.endsWith('.mjs'))) {
    readFileSync(new URL(f, dir), 'utf8').split('\n').forEach((line, i) => {
      for (const m of line.matchAll(/(?<![$\w])\$eval\(.*?,\s*\(?els\b/g)) bad.push(`${f}:${i + 1}: ${m[0]}`);
    });
  }
  assert.deepEqual(bad, []);
});
