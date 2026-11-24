// 本体（@paperclipai/server）の不具合の直しを、image を作る時に当てる。版は runtime/package-lock.json で固定し、当てる所の文字列が
// ちょうど 1 か所で見つからなければ build を落とす（版が上がって形が変わったら、直しが要るかを見直す）。
// 使い方: node apply.mjs <node_modules の場所>
//
// 1. 担当を消した後に、その担当の予算（budget policy）が残ると、本体が起動しなくなる
//    - 本体の担当を消す処理（services/agents.js の remove）は、担当ごとの予算の行を消さない（無効にしても行は残る）
//    - 起動時の掃除（index.js の runRetentionSweep → attention.list → budgets.overview）が予算の一覧を作る時、
//      消えた担当を引いて「Agent not found」（404）を投げ、起動ごと落ちる。起こし直しても毎回同じ所で落ちる
//    - 2026-11-19 に公開用の CI の container の段（上限の e2e の後の作り直し）と、手元の再現で確かめた
//    - 直し: 一覧（overview）では、対象が無くなった予算（404）だけを外す。ほかの失敗は今までどおり投げる
//    - 前提: 担当の incident は、使った額（cost_events）がある時だけでき、cost_events の外部キーが担当を消させないので、消えた担当の
//      open な incident は残らない。版上げで cost_events の外部キーが cascade・set null に変わったら、incident の側（hydrateIncidentRows）も見直す
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const root = process.argv[2];
if (!root) { console.error('usage: node apply.mjs <node_modules>'); process.exit(2); }

export const FIXES = [
  {
    file: '@paperclipai/server/dist/services/budgets.js',
    from: 'const policies = await Promise.all(rows.map((row) => buildPolicySummary(row)));',
    to: 'const policies = (await Promise.all(rows.map((row) => buildPolicySummary(row).catch((err) => (err && err.status === 404 ? null : Promise.reject(err)))))).filter(Boolean); /* aioffice: 消えた担当の予算で起動が落ちない */',
  },
];

for (const f of FIXES) {
  const p = join(root, f.file);
  const s = readFileSync(p, 'utf8');
  const n = s.split(f.from).length - 1;
  if (n !== 1) { console.error(`aioffice fix: ${f.file} に当てる所が ${n} か所（1 か所のはず）`); process.exit(1); }
  writeFileSync(p, s.split(f.from).join(f.to)); // replace は置き換え先の $ を特別に読むので使わない
  console.log(`aioffice fix: ${f.file}`);
}
