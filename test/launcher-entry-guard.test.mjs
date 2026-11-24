// 入口の守り（独立レビュー 5 回目 低 3・低 4）: 絶対形の request-target は断る・移し替えが済むまでは LAN の名前を受けない
import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createLauncher } from '../packages/aioffice/launcher/server.mjs';
import { createBoardKey } from '../packages/aioffice/launcher/lib/board-key.mjs';

const listen = srv => new Promise(r => srv.listen(0, '127.0.0.1', () => r(srv.address().port)));
async function setup(state) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aio-entry-'));
  const hits = [];
  const core = http.createServer((req, res) => { hits.push(req.url); res.writeHead(200, { 'content-type': 'application/json' }); res.end('{}'); });
  const corePort = await listen(core);
  const dataDir = path.join(dir, 'aioffice'); fs.mkdirSync(dataDir, { recursive: true });
  fs.writeFileSync(path.join(dataDir, 'state.json'), JSON.stringify(state));
  const L = createLauncher({ dataDir, hosts: 'office.lan:3100', paperclipUrl: `http://127.0.0.1:${corePort}`, codexHome: path.join(dir, 'codex'), boardKey: createBoardKey({ dataDir }), spawnFn: () => { throw new Error('no spawn'); } });
  const port = await listen(L.server);
  return { port, hits, close: () => { L.server.close(); core.close(); } };
}
const rawBody = (port, method, target, host) => new Promise((resolve, reject) => {
  const r = http.request({ host: '127.0.0.1', port, method, path: target, headers: { host } }, x => { let t = ''; x.on('data', c => { t += c; }); x.on('end', () => resolve({ status: x.statusCode, text: t })); });
  r.on('error', reject); r.end();
});
const raw = (port, method, target, host) => new Promise((resolve, reject) => {
  const r = http.request({ host: '127.0.0.1', port, method, path: target, headers: { host } }, x => { x.resume(); x.on('end', () => resolve(x.statusCode)); });
  r.on('error', reject); r.end();
});

test('絶対形の request-target（POST http://localhost:3100/api/bootstrap/claim）は 400 で、本体に届かない', async t => {
  const e = await setup({ v: 2, lang: 'en' }); t.after(e.close);
  assert.equal(await raw(e.port, 'POST', 'http://localhost:3100/api/bootstrap/claim', 'localhost:3100'), 400);
  assert.equal(await raw(e.port, 'GET', 'http://localhost:3100/setup/api/state', 'localhost:3100'), 400);
  assert.deepEqual(e.hits.filter(u => /claim/.test(u)), []);
});

test('移し替えが済むまでは LAN の名前を断り、手元の名前だけを受ける・済んだ後は LAN の名前を受ける', async t => {
  const m = await setup({ v: 1, owner: { hash: 'x' }, companyId: 'c1', lang: 'en' }); t.after(m.close);
  assert.equal(await raw(m.port, 'GET', '/setup/api/state', 'office.lan:3100'), 403);
  assert.equal(await raw(m.port, 'GET', '/setup/api/state', 'localhost:3100'), 200);
  const lan = await rawBody(m.port, 'GET', '/', 'office.lan:3100');
  assert.match(lan.text, /localhost:3100/, '許した住所から来た人には、オフィスの PC で済ませる案内を出す');
  assert.equal((await rawBody(m.port, 'GET', '/', 'evil.example:3100')).text, 'forbidden host', '許していない名前には案内を出さない');
  const v2 = await setup({ v: 2, lang: 'en' }); t.after(v2.close);
  assert.equal(await raw(v2.port, 'GET', '/setup/api/state', 'office.lan:3100'), 200);
});
