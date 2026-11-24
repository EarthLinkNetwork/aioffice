// e2e が呼ぶ plugin の口の道が、manifest の apiRoutes の path にある（本体は道で振り分ける。routeKey の名前で呼ぶと 404）
// 図書室の e2e の L8 が /put・/remove（routeKey）を呼び、図書室が container で入るまで表に出なかった（2026-11-17・独立レビュー）
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const e2eDir = path.join(root, 'test/e2e');

test('e2e が呼ぶ plugin の口の道は、その plugin の manifest にある', async () => {
  const paths = {};
  for (const d of fs.readdirSync(path.join(root, 'plugins'))) {
    const f = path.join(root, 'plugins', d, 'src', 'manifest.mjs');
    if (!fs.existsSync(f)) continue;
    const m = (await import(pathToFileURL(f).href)).default;
    paths[m.id] = new Set((m.apiRoutes || []).map(r => r.path));
  }
  const seen = [];
  for (const f of fs.readdirSync(e2eDir).filter(x => x.endsWith('.mjs'))) {
    const src = fs.readFileSync(path.join(e2eDir, f), 'utf8');
    // 変数に入れた口の頭（例 const LB = `${BASE}/api/plugins/aioffice.library/api`）も読む
    const heads = Object.fromEntries([...src.matchAll(/const (\w+) = `\$\{BASE\}\/api\/plugins\/([\w.-]+)\/api`/g)].map(m => [m[1], m[2]]));
    // 本体の /api を頭に持つ helper に渡す書き方（/plugins/<id>/api/...）も拾う（独立レビュー P3-6）
    // 道の引数は manifest と同じ書き方（:issueId）で書き、呼ぶ時に replace で埋める
    for (const m of src.matchAll(/(?:\/api)?\/plugins\/([a-z][\w.-]+)\/api(\/[\w/:-]+)/g)) seen.push([f, m[1], m[2]]);
    for (const [v, id] of Object.entries(heads)) for (const m of src.matchAll(new RegExp(`\\$\\{${v}\\}(\\/[\\w/-]+)`, 'g'))) seen.push([f, id, m[1]]);
  }
  assert.ok(seen.length > 0, 'e2e の中に plugin の口の呼び出しが見つかる');
  const bad = seen.filter(([, id, p]) => !paths[id]?.has(p));
  assert.deepEqual(bad, [], 'manifest に無い道');
  // 道の頭の plugin の id を変数で書く所（/plugins/${key}/api/tick）は、その変数に入る plugin の manifest に道があるかを別に見る
  for (const f of fs.readdirSync(e2eDir).filter(x => x.endsWith('.mjs'))) {
    const src = fs.readFileSync(path.join(e2eDir, f), 'utf8');
    for (const m of src.matchAll(/\/plugins\/\$\{\w+\}\/api(\/[\w/-]+)/g)) {
      const owners = Object.entries(paths).filter(([, set]) => set.has(m[1])).map(([id]) => id);
      assert.ok(owners.length > 0, `${f}: どの plugin の manifest にも無い道 ${m[1]}`);
    }
  }
});
