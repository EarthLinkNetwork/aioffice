// e2e の道具が container の中から本体（127.0.0.1:3101・localhost:3101）に直に聞く時は、鍵を付ける
// なぜ: 本体をログインのある形にした後も、docker stop → start の段と入れ直しの確かめが鍵なしで聞き、CI で黙って落ちた（2026-11-24・run 45345114723）。
// 段の後ろの方は CI で 1 時間以上かかって初めて着くので、ここで先に止める。/api/health だけは鍵が要らない
// 鍵: 起動係の鍵（/data/aioffice/board-key.json）を読み、同じ行で authorization に付ける。担当の鍵を使う所は下の AGENT_KEY に file と理由を書く
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const DIR = path.join(import.meta.dirname, 'e2e');
const CORE = /(127\.0\.0\.1|localhost):3101/;
const HEALTH_ONLY = l => !/(127\.0\.0\.1|localhost):3101(?!\/api\/health['"`])/.test(l);
// 担当の鍵（本体が担当に渡す PAPERCLIP_API_KEY・担当の API key）で聞く所。起動係の鍵ではないが鍵は付ける
const AGENT_KEY = {
  'multi-user-chain.e2e.mjs': /ak\.token/, // 担当として回覧を回す（担当の鍵）
  'stubs/secretary-stub.mjs': /PAPERCLIP_API_KEY/, // 本体が担当の process に渡す鍵
};
const files = (d, pre = '') => fs.readdirSync(d, { withFileTypes: true }).flatMap(e => e.isDirectory() ? files(path.join(d, e.name), `${pre}${e.name}/`) : /\.(mjs|js|sh)$/.test(e.name) ? [`${pre}${e.name}`] : []);

test('e2e の本体への直の問い合わせは、どれも鍵を付ける（/api/health を除く）', () => {
  const bad = [];
  let seen = 0;
  for (const f of files(DIR)) {
    const src = fs.readFileSync(path.join(DIR, f), 'utf8');
    src.split('\n').forEach((line, i) => {
      if (!CORE.test(line) || HEALTH_ONLY(line) || /^\s*(\/\/|#|\*)/.test(line)) return; // コメントの行は数えない
      seen++;
      if (line.includes('board-key.json') && /authorization|Bearer/i.test(line)) return; // 同じ行で起動係の鍵を読んで付ける
      if (/--api-base/.test(line) && /PAPERCLIP_API_KEY/.test(line)) return; // CLI に鍵を env で渡す
      if (AGENT_KEY[f] && AGENT_KEY[f].test(src)) return;
      // 住所を定数に置き、別の所で起動係の鍵を付ける形（office-prep.mjs の PC と BOARD）: 鍵の読みと authorization への付けが file にある
      if (/^const \w+ = ['"`]http:\/\/127\.0\.0\.1:3101\/api['"`];/.test(line.trim()) && /board-key\.json/.test(src) && /authorization: BOARD|Authorization: BOARD|authorization:\s*BOARD/.test(src)) return;
      bad.push(`${f}:${i + 1}`);
    });
  }
  assert.ok(seen >= 10, `直の問い合わせを見つけられていない（${seen}）`);
  assert.deepEqual(bad, [], `鍵なしで本体に聞いている（または鍵の付け方を確かめられない）: ${bad.join(' ')}`);
});
