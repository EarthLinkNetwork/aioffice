// 会社の owner の役（設計 2.8・2026-11-24 e2e）: 本体の API は自分の役も同じ役の人の役も変えさせないので、起動係は DB の書き手（roleWriter）で直す。
// 新しい持ち主（instance admin）を owner に上げ、admin を外れた前の持ち主（formerOwners）だけを operator に下げる。持ち主が本体の画面で owner にした人は下げない
import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createLauncher } from '../packages/aioffice/launcher/server.mjs';
import { createBoardKey } from '../packages/aioffice/launcher/lib/board-key.mjs';

const listen = srv => new Promise(r => srv.listen(0, '127.0.0.1', () => r(srv.address().port)));
const mem = (id, principalId, membershipRole) => ({ id, principalType: 'user', principalId, status: 'active', membershipRole, user: { name: principalId, email: `${principalId}@x.test` } });

async function setup({ users, members, state, failOwner = false }) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aio-roles-'));
  const patches = [];
  const core = http.createServer((req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    if (req.url === '/api/admin/users') return res.end(JSON.stringify(users));
    if (req.url === '/api/companies') return res.end(JSON.stringify([{ id: 'c1', name: 'C' }]));
    if (req.url === '/api/companies/c1/members') return res.end(JSON.stringify({ members }));
    if (req.method === 'PATCH') { patches.push(req.url); res.writeHead(403); return res.end('{"error":"You can only remove users below your company role."}'); }
    if (req.url === '/api/cli-auth/me') return res.end(JSON.stringify({ isInstanceAdmin: true, source: 'board_key' }));
    return res.end('{}');
  });
  const corePort = await listen(core);
  const dataDir = path.join(dir, 'aioffice'); fs.mkdirSync(dataDir, { recursive: true });
  fs.writeFileSync(path.join(dataDir, 'state.json'), JSON.stringify({ v: 2, lang: 'en', ...state }));
  const boardKey = createBoardKey({ dataDir }); boardKey.write({ id: 'k1', token: 'pcp_ok' });
  const writes = [];
  const L = createLauncher({ dataDir, paperclipUrl: `http://127.0.0.1:${corePort}`, codexHome: path.join(dir, 'codex'), boardKey, spawnFn: () => { throw new Error('no spawn'); },
    pluginStatus: () => ({ 'aioffice.relay': { status: 'ready' } }), roleWriter: async (c, id, role) => { if (failOwner && role === 'owner') throw new Error('db down'); writes.push([c, id, role]); } });
  return { L, writes, patches, close: () => { L.server.close(); core.close(); } };
}

test('reset の後: 新しい持ち主を owner に上げ、admin を外れた前の持ち主を operator に下げる（本体の API の PATCH は使わない）', async t => {
  const e = await setup({
    users: [{ id: 'new', isInstanceAdmin: true }, { id: 'old', isInstanceAdmin: false }, { id: 'boss', isInstanceAdmin: false }],
    members: [mem('m-new', 'new', 'operator'), mem('m-old', 'old', 'owner'), mem('m-boss', 'boss', 'owner')],
    state: { ownerUserIds: ['old'], ownerUserId: 'old' },
  });
  t.after(e.close);
  await e.L.syncRelay({ force: true });
  assert.deepEqual(e.writes.sort(), [['c1', 'm-new', 'owner'], ['c1', 'm-old', 'operator']].sort());
  assert.deepEqual(e.patches, [], 'API の PATCH（同じ役・自分は断られる）は呼ばない');
  assert.deepEqual(e.L.store.get().formerOwners, ['old']);
  assert.deepEqual(e.L.store.get().ownerUserIds, ['new']);
});

test('持ち主が 1 人もいない間は誰も下げない・前の持ち主に覚えていない owner は下げない', async t => {
  const e = await setup({ users: [{ id: 'old', isInstanceAdmin: false }], members: [mem('m-old', 'old', 'owner')], state: { ownerUserIds: ['old'], ownerUserId: 'old' } });
  t.after(e.close);
  await e.L.syncRelay({ force: true });
  assert.deepEqual(e.writes, [], '持ち主が 0 人');
});

test('plugin の口の前: 後から入り終えた plugin にも持ち主を書く（入れ始めていない plugin を数えずに「書き終えた」と覚えない・2026-11-24 e2e の notify）', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aio-presync-'));
  const posts = [];
  const core = http.createServer((req, res) => {
    let b = ''; req.on('data', c => { b += c; }); req.on('end', () => {
      const send = (c, j) => { res.writeHead(c, { 'content-type': 'application/json' }); res.end(JSON.stringify(j)); };
      const cookie = req.headers.cookie || '', auth = req.headers.authorization || '';
      if (req.url === '/api/health') return send(200, { status: 'ok', bootstrapStatus: 'ready' });
      if (req.url === '/api/cli-auth/me') return auth ? send(200, { isInstanceAdmin: true, source: 'board_key', companyIds: [] }) : /s=owner/.test(cookie) ? send(200, { isInstanceAdmin: true, source: 'session', userId: 'u1', companyIds: ['c1'] }) : send(401, {});
      if (req.url === '/api/admin/users') return send(200, [{ id: 'u1', isInstanceAdmin: true }]);
      if (req.url === '/api/companies') return send(200, [{ id: 'c1', name: 'C' }]);
      if (req.url === '/api/companies/c1/members') return send(200, { members: [mem('m1', 'u1', 'owner')] });
      if (req.method === 'POST' && /\/config$/.test(req.url)) { posts.push(req.url.split('/')[3]); return send(200, {}); }
      if (/\/config\?/.test(req.url)) return send(404, {});
      return send(200, { proxied: req.url });
    });
  });
  const corePort = await listen(core);
  const dataDir = path.join(dir, 'aioffice'); fs.mkdirSync(dataDir, { recursive: true });
  fs.writeFileSync(path.join(dataDir, 'state.json'), JSON.stringify({ v: 2, lang: 'en', ownerUserIds: ['u1'], ownerUserId: 'u1', companyId: 'c1' }));
  const boardKey = createBoardKey({ dataDir }); boardKey.write({ id: 'k1', token: 'pcp_ok' });
  const status = { 'aioffice.design': { status: 'ready' }, 'aioffice.library': { status: 'ready' } }; // notify などは、まだ入れ始めていない
  const L = createLauncher({ dataDir, paperclipUrl: `http://127.0.0.1:${corePort}`, codexHome: path.join(dir, 'codex'), boardKey, spawnFn: () => { throw new Error('no spawn'); }, pluginStatus: () => status, roleWriter: async () => {} });
  const port = await listen(L.server);
  t.after(() => { L.server.close(); core.close(); });
  const call = () => new Promise((resolve, reject) => {
    const r = http.request({ host: '127.0.0.1', port, method: 'GET', path: '/api/plugins/aioffice.notify/api/settings?companyId=c1', headers: { host: `127.0.0.1:${port}`, origin: `http://127.0.0.1:${port}`, cookie: 's=owner' } }, x => { x.resume(); x.on('end', () => resolve(x.statusCode)); });
    r.on('error', reject); r.end();
  });
  await call();
  assert.deepEqual(posts.sort(), ['aioffice.design', 'aioffice.library']);
  status['aioffice.notify'] = { status: 'ready' };
  await call();
  assert.ok(posts.includes('aioffice.notify'), `後から入り終えた notify にも書く: ${posts}`);
});

test('新しい持ち主を owner に上げられなかった会社では、前の持ち主を下げない（owner の役の人が 0 人の間を作らない・4 回目のレビュー 低 1）', async t => {
  const e = await setup({
    users: [{ id: 'new', isInstanceAdmin: true }, { id: 'old', isInstanceAdmin: false }],
    members: [mem('m-new', 'new', 'operator'), mem('m-old', 'old', 'owner')],
    state: { ownerUserIds: ['old'], ownerUserId: 'old' }, failOwner: true,
  });
  t.after(e.close);
  await e.L.syncRelay({ force: true });
  assert.deepEqual(e.writes, []);
});

test('DB で owner に上げるのは本体の一覧で admin と確かめた人だけ（一覧が読めない時は上げない・4 回目のレビュー 低 2）', async t => {
  const e = await setup({ users: { error: 'boom' }, members: [mem('m-x', 'x', 'operator')], state: { ownerUserIds: ['x'], ownerUserId: 'x' } });
  t.after(e.close);
  await e.L.syncRelay({ force: true });
  assert.deepEqual(e.writes, []);
});
