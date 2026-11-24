// https の前段の住所（AIOFFICE_HOSTS の https://名前）から来た要求を本体へ渡す時の header（独立レビュー 9 回目 P3）
// 本体へは :443 を外した名前と https を渡す。ブラウザが付けた x-forwarded-* は捨てる
import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createLauncher } from '../packages/aioffice/launcher/server.mjs';
import { createBoardKey } from '../packages/aioffice/launcher/lib/board-key.mjs';

const listen = srv => new Promise(r => srv.listen(0, '127.0.0.1', () => r(srv.address().port)));

test('前段の住所から来た要求は、本体へ :443 を外した x-forwarded-host と https で渡す・LAN は http のまま', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aio-front-'));
  const seen = [];
  const core = http.createServer((req, res) => { seen.push({ url: req.url, h: req.headers }); res.writeHead(200, { 'content-type': 'application/json' }); res.end('{"status":"ok"}'); });
  const corePort = await listen(core);
  const dataDir = path.join(dir, 'aioffice'); fs.mkdirSync(dataDir, { recursive: true });
  fs.writeFileSync(path.join(dataDir, 'state.json'), JSON.stringify({ v: 2, lang: 'en' }));
  const L = createLauncher({ dataDir, hosts: 'https://office.example.com,office.lan:3100', paperclipUrl: `http://127.0.0.1:${corePort}`, codexHome: path.join(dir, 'codex'), boardKey: createBoardKey({ dataDir }), spawnFn: () => { throw new Error('no spawn'); } });
  const port = await listen(L.server);
  t.after(() => { L.server.close(); core.close(); });
  const get = (p, host, extra = {}) => new Promise((resolve, reject) => {
    const r = http.request({ host: '127.0.0.1', port, method: 'GET', path: p, headers: { host, ...extra } }, x => { x.resume(); x.on('end', () => resolve(x.statusCode)); });
    r.on('error', reject); r.end();
  });
  const fwd = async (host, extra) => {
    for (const p of ['/api/health', '/api/auth/get-session']) {
      const n = seen.length; await get(p, host, extra);
      if (seen.length > n) return seen[seen.length - 1].h;
    }
    return null;
  };
  const a = await fwd('office.example.com:443', { 'x-forwarded-proto': 'http', 'x-forwarded-host': 'evil.example' });
  assert.ok(a, '前段の住所の要求が本体に届く');
  assert.equal(a['x-forwarded-host'], 'office.example.com', ':443 を外した名前');
  assert.equal(a['x-forwarded-proto'], 'https');
  const b = await fwd('office.lan:3100');
  assert.equal(b['x-forwarded-host'], 'office.lan:3100');
  assert.equal(b['x-forwarded-proto'], 'http');
});

test('使っていない接続は前段（cloudflared の 90 秒）より長く保つ', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aio-ka-'));
  const dataDir = path.join(dir, 'aioffice'); fs.mkdirSync(dataDir, { recursive: true });
  const L = createLauncher({ dataDir, paperclipUrl: 'http://127.0.0.1:9', codexHome: path.join(dir, 'codex'), spawnFn: () => { throw new Error('no spawn'); } });
  assert.ok(L.server.keepAliveTimeout > 90_000);
  assert.ok(L.server.headersTimeout > L.server.keepAliveTimeout);
});
