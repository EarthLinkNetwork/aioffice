// 起動係の鍵の置き場と、本体への呼び出しに鍵を付ける fetch（設計 docs/design/2026-11-23-public-office-multi-user.md 2.3）
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createBoardKey, authedFetch, cliEnv } from '../packages/aioffice/launcher/lib/board-key.mjs';

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'aio-key-'));

test('鍵は 0600 で置き、読み直せ、消せる', () => {
  const d = tmp(); const k = createBoardKey({ dataDir: d });
  assert.equal(k.read(), null);
  k.write({ token: 'pcp_board_x', id: 'k1' });
  assert.equal(fs.statSync(k.file).mode & 0o777, 0o600);
  assert.deepEqual(k.read(), { token: 'pcp_board_x', id: 'k1' });
  assert.equal(fs.readdirSync(d).filter(f => f.endsWith('.tmp')).length, 0, '書きかけのファイルを残さない');
  k.write({ token: 'pcp_board_y', id: 'k2' });
  assert.equal(k.token(), 'pcp_board_y', '作り直した鍵をすぐ読む');
  k.clear();
  assert.equal(k.has(), false);
  assert.throws(() => k.write({ token: '' }));
});

test('壊れたファイルは鍵が無いのと同じ', () => {
  const d = tmp(); const k = createBoardKey({ dataDir: d });
  fs.writeFileSync(k.file, '{not json', { mode: 0o600 });
  assert.equal(k.read(), null);
});

test('本体への呼び出しに Bearer を付け、呼び手の authorization は上書きする。鍵が無ければ付けない', async () => {
  const d = tmp(); const k = createBoardKey({ dataDir: d });
  const seen = [];
  const f = authedFetch(async (url, init) => { seen.push(init.headers || {}); return { ok: true }; }, k);
  await f('http://127.0.0.1:3101/api/companies');
  assert.equal(seen[0].authorization, undefined);
  k.write({ token: 'pcp_board_x' });
  await f('http://127.0.0.1:3101/api/companies', { method: 'POST', headers: { 'content-type': 'application/json', Authorization: 'Bearer other' } });
  assert.equal(seen[1].authorization, 'Bearer pcp_board_x');
  assert.equal(seen[1]['content-type'], 'application/json');
});

test('plugin の CLI の env: 鍵があれば PAPERCLIP_API_KEY・無ければ外から来た値も消す', () => {
  const d = tmp(); const k = createBoardKey({ dataDir: d });
  assert.equal(cliEnv(k, { PATH: '/bin', PAPERCLIP_API_KEY: 'leak' }).PAPERCLIP_API_KEY, undefined);
  k.write({ token: 'pcp_board_x' });
  const e = cliEnv(k, { PATH: '/bin' });
  assert.equal(e.PAPERCLIP_API_KEY, 'pcp_board_x');
  assert.equal(e.PATH, '/bin');
});
