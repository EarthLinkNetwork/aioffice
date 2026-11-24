// image の build の中で動かす: 独自の許諾の部品を消して stub を置き、本体が import する名前が stub に全部あるかを確かめる
// 使い方: node apply.mjs <node_modules の場所>
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const NM = path.resolve(process.argv[2] || 'node_modules');
const HERE = path.dirname(fileURLToPath(import.meta.url));
const STUBS = { '@cursor/sdk': 'cursor-sdk', '@anthropic-ai/claude-agent-sdk': 'claude-agent-sdk' };

// 1. 本物（と arch ごとの binary の部品）を消す
for (const name of fs.readdirSync(NM, { withFileTypes: true }).filter(d => d.name.startsWith('@')).flatMap(d => fs.readdirSync(path.join(NM, d.name)).map(n => `${d.name}/${n}`))) {
  if (Object.keys(STUBS).some(s => name === s || name.startsWith(`${s}-`))) { fs.rmSync(path.join(NM, name), { recursive: true, force: true }); console.log(`removed ${name}`); }
}
// 2. stub を置く
for (const [name, dir] of Object.entries(STUBS)) fs.cpSync(path.join(HERE, dir), path.join(NM, name), { recursive: true });

// 3. 本体の js が import している名前が stub に全部あるか
const want = new Map(Object.keys(STUBS).map(n => [n, new Set()]));
const walk = d => { for (const e of fs.readdirSync(d, { withFileTypes: true })) { const p = path.join(d, e.name); if (e.isDirectory()) { if (!Object.keys(STUBS).some(s => p.endsWith(path.join('node_modules', s)))) walk(p); } else if (/\.(m?js|cjs)$/.test(e.name)) {
  const t = fs.readFileSync(p, 'utf8');
  for (const name of want.keys()) { if (!t.includes(name)) continue;
    for (const m of t.matchAll(new RegExp(`import\\s*\\{([^}]*)\\}\\s*from\\s*["']${name.replace('/', '\\/')}["']`, 'g'))) for (const part of m[1].split(',')) { const n = part.trim().split(/\s+as\s+/)[0].trim(); if (n) want.get(name).add(n); }
    if (new RegExp(`(require\\(|import\\()\\s*["']${name.replace('/', '\\/')}["']`).test(t)) want.get(name).add('*dynamic*');
  } } } };
walk(NM);
let bad = 0;
for (const [name, names] of want) {
  const mod = await import(path.join(NM, name, 'index.js'));
  for (const n of names) if (n !== '*dynamic*' && !(n in mod)) { console.error(`stub ${name} に ${n} が無い`); bad++; }
  console.log(`${name}: imports ${[...names].sort().join(', ') || '(none)'}`);
}
if (bad) process.exit(1);
