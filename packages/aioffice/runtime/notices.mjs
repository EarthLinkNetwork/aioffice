// image に入れる部品の許諾の一覧（THIRD_PARTY_NOTICES.txt）を作る。各部品の LICENSE の本文も写す
// 使い方: node notices.mjs <node_modules の場所> <書き出し先>
import fs from 'node:fs';
import path from 'node:path';

const [NM, OUT] = [path.resolve(process.argv[2]), path.resolve(process.argv[3])];
const rows = [];
const walk = d => { for (const n of fs.readdirSync(d)) { const p = path.join(d, n); if (n.startsWith('@')) { walk(p); continue; } const f = path.join(p, 'package.json'); if (!fs.existsSync(f)) continue;
  const j = JSON.parse(fs.readFileSync(f, 'utf8')); const lic = j.license || (j.licenses || []).map(x => x.type).join(' OR ') || 'UNKNOWN';
  const file = fs.readdirSync(p).find(x => /^(licen[cs]e|copying|notice)/i.test(x));
  rows.push({ name: j.name, version: j.version, lic, repo: typeof j.repository === 'string' ? j.repository : j.repository?.url || '', text: file ? fs.readFileSync(path.join(p, file), 'utf8') : '' });
  if (fs.existsSync(path.join(p, 'node_modules'))) walk(path.join(p, 'node_modules')); } };
walk(NM);
rows.sort((a, b) => a.name.localeCompare(b.name) || String(a.version).localeCompare(String(b.version)));
const seen = new Set(); const uniq = rows.filter(r => { const k = `${r.name}@${r.version}`; if (seen.has(k)) return false; seen.add(k); return true; });
const head = ['AI Office — third-party software in this image', '',
  'Not included: @cursor/sdk and @anthropic-ai/claude-agent-sdk (proprietary licenses). Placeholders are installed instead; the Cursor and Claude employees do not work in this image.',
  'LGPL components (for example @img/sharp-libvips-*) are dynamically linked. Their source is available from the repository listed for each component.', '',
  ...uniq.map(r => `${r.name}@${r.version}  ${r.lic}  ${r.repo}`), '', '='.repeat(72), ''];
fs.writeFileSync(OUT, head.join('\n') + uniq.filter(r => r.text).map(r => `----- ${r.name}@${r.version} (${r.lic}) -----\n${r.text.trim()}\n`).join('\n'));
console.log(`notices: ${uniq.length} components → ${OUT}`);
