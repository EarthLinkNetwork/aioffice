// 起動係のログインのある形（設計 docs/design/2026-11-23-public-office-multi-user.md 2.1〜2.4）: 段の判定・最初の持ち主の code・起動係の鍵・鍵の見張り・移し替えの間
import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createLauncher } from '../packages/aioffice/launcher/server.mjs';
import { createBoardKey } from '../packages/aioffice/launcher/lib/board-key.mjs';

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'aio-auth-'));
const listen = srv => new Promise(r => srv.listen(0, '127.0.0.1', () => r(srv.address().port)));

// 偽の本体: session の cookie "s=owner" は instance admin・"s=member" は会社の member。鍵 "pcp_ok" は admin
function fakeCore() {
  const st = { bootstrap: 'bootstrap_pending', keys: [], hits: [], revoked: new Set() };
  const srv = http.createServer((req, res) => {
    let body = ''; req.on('data', c => { body += c; }); req.on('end', () => {
      st.hits.push(`${req.method} ${req.url}`);
      const send = (c, j) => { res.writeHead(c, { 'content-type': 'application/json' }); res.end(JSON.stringify(j)); };
      const cookie = req.headers.cookie || '', auth = req.headers.authorization || '';
      if (req.url === '/api/health') return send(200, { status: 'ok', bootstrapStatus: st.bootstrap });
      if (req.url === '/api/cli-auth/me') {
        if (auth) { const t = auth.slice(7); return st.keys.includes(t) && !st.revoked.has(t) ? send(200, { isInstanceAdmin: true, source: 'board_key', companyIds: [] }) : send(401, { error: 'unauthorized' }); }
        if (/s=owner/.test(cookie)) return send(200, { isInstanceAdmin: true, source: 'session', userId: 'u1', companyIds: ['c1'] });
        if (/s=member/.test(cookie)) return send(200, { isInstanceAdmin: false, source: 'session', userId: 'u2', companyIds: ['c1'] });
        if (/s=joiner/.test(cookie)) return send(200, { isInstanceAdmin: false, source: 'session', userId: 'u3', companyIds: st.joined ? ['c1'] : [] });
        return send(401, { error: 'unauthorized' });
      }
      if (req.method === 'POST' && req.url === '/api/board-api-keys') {
        if (!/s=owner/.test(cookie)) return send(403, {});
        const token = `pcp_ok_${st.keys.length}`; st.keys.push(token); return send(201, { id: `k${st.keys.length}`, token });
      }
      if (req.method === 'DELETE' && req.url.startsWith('/api/board-api-keys/')) return send(200, { ok: true });
      if (req.method === 'POST' && /^\/api\/invites\/[^/]+\/accept$/.test(req.url)) { st.joined = true; return send(200, { ok: true }); }
      return send(200, { proxied: `${req.method} ${req.url}`, auth: auth || null });
    });
  });
  return { srv, st };
}
function req(port, method, p, { body, cookie } = {}) {
  return new Promise((resolve, reject) => {
    const headers = { host: `127.0.0.1:${port}`, origin: `http://127.0.0.1:${port}` }; if (cookie) headers.cookie = cookie;
    const data = body == null ? null : JSON.stringify(body); if (data) { headers['content-type'] = 'application/json'; headers['content-length'] = Buffer.byteLength(data); }
    const r = http.request({ host: '127.0.0.1', port, method, path: p, headers }, res => { let t = ''; res.on('data', c => { t += c; }); res.on('end', () => { let j = null; try { j = JSON.parse(t); } catch { /* 文字 */ } resolve({ status: res.statusCode, headers: res.headers, json: j }); }); });
    r.on('error', reject); if (data) r.write(data); r.end();
  });
}
async function setup({ state } = {}) {
  const dir = tmp(), core = fakeCore(), corePort = await listen(core.srv);
  const dataDir = path.join(dir, 'aioffice'); fs.mkdirSync(dataDir, { recursive: true });
  if (state) fs.writeFileSync(path.join(dataDir, 'state.json'), JSON.stringify(state));
  const boardKey = createBoardKey({ dataDir }); let restarts = 0;
  const L = createLauncher({ dataDir, paperclipUrl: `http://127.0.0.1:${corePort}`, codexHome: path.join(dir, 'codex'), boardKey, restartCore: () => { restarts += 1; }, spawnFn: () => { throw new Error('no spawn'); } });
  const port = await listen(L.server);
  return { L, port, core, boardKey, dataDir, restarts: () => restarts, close: () => { L.server.close(); core.srv.close(); } };
}

test('新しく入れた office: claim の前は code が無ければ本体の sign-up・claim・会社の読み出しを通さず、code の後に鍵ができると ready', async t => {
  const e = await setup(); t.after(e.close);
  assert.equal(e.L.store.get().v, 2, '新しく入れた office は v = 2');
  assert.equal((await req(e.port, 'GET', '/setup/api/state')).json.stage, 'preclaim');
  assert.equal((await req(e.port, 'POST', '/api/auth/sign-up/email', { body: {} })).status, 503);
  assert.equal((await req(e.port, 'POST', '/api/Bootstrap/Claim/', { body: {} })).status, 503);
  assert.equal((await req(e.port, 'GET', '/api/companies')).status, 503);
  assert.equal((await req(e.port, 'POST', '/setup/api/claim-code', { body: { code: 'WRONG' } })).status, 401);
  const code = fs.readFileSync(path.join(e.dataDir, 'claim-code'), 'utf8').trim();
  assert.equal(fs.statSync(path.join(e.dataDir, 'claim-code')).mode & 0o777, 0o600);
  const ok = await req(e.port, 'POST', '/setup/api/claim-code', { body: { code } });
  assert.equal(ok.status, 200);
  const claim = ok.headers['set-cookie'][0].split(';')[0];
  assert.equal((await req(e.port, 'POST', '/api/auth/sign-up/email', { body: {}, cookie: claim })).status, 200);
  assert.equal((await req(e.port, 'POST', '/api/bootstrap/claim', { body: {}, cookie: claim })).status, 200);
  assert.equal((await req(e.port, 'POST', '/setup/api/launcher-key', { cookie: 's=member' })).status, 403, 'member は鍵を作れない');
  e.core.st.bootstrap = 'ready';
  const k = await req(e.port, 'POST', '/setup/api/launcher-key', { cookie: `${claim}; s=owner` });
  assert.equal(k.status, 200);
  assert.deepEqual(Object.keys(k.json), ['ok'], '鍵はブラウザに返さない');
  assert.equal(e.boardKey.has(), true);
  assert.equal(fs.existsSync(path.join(e.dataDir, 'claim-code')), false, 'code は使い終えたら消す');
  assert.equal(e.restarts(), 1);
  const s = (await req(e.port, 'GET', '/setup/api/state', { cookie: 's=owner' })).json;
  assert.equal(s.stage, 'ready'); assert.equal(s.authed, true);
  assert.equal((await req(e.port, 'GET', '/setup/api/state', { cookie: 's=member' })).json.authed, false, 'member は持ち主でない');
  const p = await req(e.port, 'GET', '/api/companies', { cookie: 's=member' });
  assert.equal(p.json.auth, null, '中継はブラウザの session のまま（起動係の鍵を付けない）');
});

test('鍵の見張り: 本体で取り消された・file が消えたら、担当を止める印を付けて起こし直す', async t => {
  const e = await setup(); t.after(e.close);
  e.core.st.bootstrap = 'ready'; // 持ち主がいる office
  e.core.st.keys.push('pcp_ok_x'); e.boardKey.write({ token: 'pcp_ok_x', id: 'kx' });
  assert.equal(await e.L.checkKey(), false); assert.equal(e.L.keyless(), false);
  e.core.st.revoked.add('pcp_ok_x');
  assert.equal(await e.L.checkKey(), true); assert.equal(e.L.keyless(), true);
  assert.equal((await req(e.port, 'GET', '/setup/api/state')).json.stage, 'keyless');
  assert.equal((await req(e.port, 'PATCH', '/api/issues/i1', { body: {}, cookie: 's=owner' })).status, 503, '鍵が無い間は人の操作も本体に届けない');

  const f = await setup(); t.after(f.close);
  f.core.st.keys.push('pcp_ok_y'); f.boardKey.write({ token: 'pcp_ok_y', id: 'ky' });
  assert.equal(await f.L.checkKey(), false);
  f.boardKey.clear();
  assert.equal(await f.L.checkKey(), true, '動いている間に file が消えたのも断られたのと同じ');
  assert.equal(f.L.keyless(), true);
});

test('移し替え（前の版の office）: 鍵があっても担当は止めたまま・合言葉の cookie が無ければ board-claim も通さない', async t => {
  const e = await setup({ state: { v: 1, owner: { hash: 'x' }, companyId: 'c1', generation: 0 } }); t.after(e.close);
  assert.equal(e.L.store.get().v, 1, '前の版の v は上げない');
  assert.equal((await req(e.port, 'GET', '/setup/api/state')).json.stage, 'migrating');
  assert.equal((await req(e.port, 'GET', '/api/board-claim/t')).status, 503);
  e.core.st.keys.push('pcp_ok_m'); e.boardKey.write({ token: 'pcp_ok_m', id: 'km' });
  assert.equal(e.L.keyless(), true, '移し替えが済むまでは鍵があっても scheduler を止める');
  assert.equal((await req(e.port, 'PATCH', '/api/issues/i1', { body: {}, cookie: 's=owner' })).status, 503);
  assert.equal((await req(e.port, 'POST', '/setup/api/owner', { body: { password: 'abcdefgh' } })).status, 409, '前の版の合言葉は作り直さない');
});

test('前の版で wizard の前に止めた office（v: 1・跡なし）は v = 2 に上げる', async t => {
  const e = await setup({ state: { v: 1, generation: 0 } }); t.after(e.close);
  assert.equal(e.L.store.get().v, 2);
  assert.equal((await req(e.port, 'GET', '/setup/api/state')).json.stage, 'preclaim');
});

test('招待の accept の直後に、accept の前の本体の答え（会社 0 件）を使わない（招かれた人がすぐ会社の人として扱われる）', async t => {
  const e = await setup(); t.after(e.close);
  e.boardKey.write({ id: 'k1', token: 'pcp_ok_x' }); e.core.st.keys.push('pcp_ok_x'); e.core.st.bootstrap = 'ready';
  assert.equal((await req(e.port, 'GET', '/setup/api/people', { cookie: 's=joiner' })).status, 401, 'accept の前は会社の人でない');
  assert.equal((await req(e.port, 'POST', '/api/invites/tok/accept', { cookie: 's=joiner', body: { requestType: 'human' } })).status, 200);
  assert.equal((await req(e.port, 'GET', '/setup/api/people', { cookie: 's=joiner' })).status, 403, 'accept の直後から会社の人（持ち主の口は owner_only）');
});

test('state の出し分け: preclaim の段で sign-in していない人には基本の欄だけ・会社の人には会社の名前まで・持ち主には全部（独立レビュー 7）', async t => {
  const e = await setup({ state: { v: 2, companyId: 'c1', companyName: '見本の会社', companyPrefix: 'MIH', mail: { c1: { addr: 'o@gmail.com', savedAt: 'x' } } } }); t.after(e.close);
  const pre = (await req(e.port, 'GET', '/setup/api/state')).json;
  assert.equal(pre.stage, 'preclaim');
  assert.equal(pre.company, undefined); assert.equal(pre.mail, undefined); assert.equal(pre.templates, undefined);
  e.boardKey.write({ id: 'k1', token: 'pcp_ok_y' }); e.core.st.keys.push('pcp_ok_y'); e.core.st.bootstrap = 'ready';
  const mem = (await req(e.port, 'GET', '/setup/api/state', { cookie: 's=member' })).json;
  assert.equal(mem.member, true); assert.equal(mem.company.name, '見本の会社'); assert.equal(mem.mail, undefined); assert.equal(mem.templates, undefined);
  const own = (await req(e.port, 'GET', '/setup/api/state', { cookie: 's=owner' })).json;
  assert.equal(own.authed, true); assert.ok(own.mail && own.templates, '持ち主には全部');
});

test('session の無い WebSocket は本体へつながず 401・会社の人の WebSocket は本体へ通す（独立レビュー: 照らしていない守り）', async t => {
  const e = await setup(); t.after(e.close);
  e.boardKey.write({ id: 'k1', token: 'pcp_ok_w' }); e.core.st.keys.push('pcp_ok_w'); e.core.st.bootstrap = 'ready';
  const ws = cookie => new Promise((resolve, reject) => {
    const headers = { host: `127.0.0.1:${e.port}`, origin: `http://127.0.0.1:${e.port}`, connection: 'Upgrade', upgrade: 'websocket', 'sec-websocket-version': '13', 'sec-websocket-key': 'dGhlIHNhbXBsZSBub25jZQ==' };
    if (cookie) headers.cookie = cookie;
    const r = http.request({ host: '127.0.0.1', port: e.port, path: '/api/companies/c1/events/ws', headers });
    r.on('response', res => { res.resume(); resolve(res.statusCode); });
    r.on('upgrade', (_res, sock) => { sock.destroy(); resolve(101); });
    r.on('error', reject); r.end();
  });
  assert.equal(await ws(null), 401);
  const before = e.core.st.hits.filter(h => h.includes('/events/ws')).length;
  assert.equal(before, 0, 'session の無い WebSocket は本体に届かない');
  await ws('s=member');
  assert.ok(e.core.st.hits.some(h => h.includes('/events/ws')), '会社の人の WebSocket は本体へ届く');
});

test('claim の cookie は出した回に結び付く: reset-owner の招待が出ると前の code の cookie は効かず、招待の間は bootstrap の claim を閉じる（codex の最終確認 P1）', async t => {
  const { createHash } = await import('node:crypto');
  const e = await setup(); t.after(e.close);
  const code = fs.readFileSync(path.join(e.dataDir, 'claim-code'), 'utf8').trim();
  const old = (await req(e.port, 'POST', '/setup/api/claim-code', { body: { code } })).headers['set-cookie'][0].split(';')[0];
  assert.equal((await req(e.port, 'POST', '/api/auth/sign-up/email', { body: {}, cookie: old })).status, 200, 'reset の前は code の cookie が効く');
  // reset-owner が招待を出した（token の hash と期限だけを置く）
  const token = 'resetTok_12345678';
  fs.writeFileSync(path.join(e.dataDir, 'reset-invite'), JSON.stringify({ hash: createHash('sha256').update(token).digest('hex'), exp: Date.now() + 3600_000 }), { mode: 0o600 });
  assert.equal((await req(e.port, 'POST', '/api/bootstrap/claim', { body: {}, cookie: `${old}; s=owner` })).status, 503, '前の回の cookie では bootstrap の claim を通さない');
  assert.equal((await req(e.port, 'POST', '/api/auth/sign-up/email', { body: {}, cookie: old })).status, 503, '前の回の cookie では sign-up も通さない');
  assert.equal((await req(e.port, 'POST', '/setup/api/claim-code', { body: { code } })).status, 409, '招待の間は最初の持ち主の code で入れない');
  assert.equal((await req(e.port, 'GET', '/invite/wrongTok_12345678')).headers['set-cookie'], undefined, '合わない招待では cookie を出さない');
  const opened = await req(e.port, 'GET', `/invite/${token}`);
  const fresh = opened.headers['set-cookie'][0].split(';')[0];
  assert.equal((await req(e.port, 'POST', '/api/auth/sign-up/email', { body: {}, cookie: fresh })).status, 200, '今回の招待を開いた人は sign-up できる');
  assert.equal((await req(e.port, 'POST', `/api/invites/${token}/accept`, { body: { requestType: 'human' }, cookie: fresh })).status, 200, '今回の招待の accept は通る');
  assert.equal((await req(e.port, 'POST', '/api/bootstrap/claim', { body: {}, cookie: `${fresh}; s=owner` })).status, 503, '招待の間は今回の cookie でも bootstrap の claim は閉じる');
  // 次の reset（新しい招待）が出ると、今回の cookie も効かない
  fs.writeFileSync(path.join(e.dataDir, 'reset-invite'), JSON.stringify({ hash: createHash('sha256').update('nextTok_12345678').digest('hex'), exp: Date.now() + 3600_000 }), { mode: 0o600 });
  assert.equal((await req(e.port, 'POST', '/api/auth/sign-up/email', { body: {}, cookie: fresh })).status, 503, '次の回の招待が出ると前の招待の cookie は効かない');
  assert.equal((await req(e.port, 'GET', '/setup/api/state')).json.resetPending, true, 'wizard に作り直しの途中を知らせる（11 回目のレビュー P3-1）');
});

test('持ち主が鍵を作り直したら reset-owner の招待の印を消す（期限まで code と bootstrap の claim が閉じたままにしない・11 回目のレビュー P3-2）', async t => {
  const { createHash } = await import('node:crypto');
  const e = await setup(); t.after(e.close);
  fs.writeFileSync(path.join(e.dataDir, 'reset-invite'), JSON.stringify({ hash: createHash('sha256').update('tok_abcdefgh').digest('hex'), exp: Date.now() + 3600_000 }), { mode: 0o600 });
  const c = (await req(e.port, 'GET', '/invite/tok_abcdefgh')).headers['set-cookie'][0].split(';')[0];
  e.core.st.bootstrap = 'ready';
  assert.equal((await req(e.port, 'POST', '/setup/api/launcher-key', { cookie: `${c}; s=owner` })).status, 200);
  assert.equal(fs.existsSync(path.join(e.dataDir, 'reset-invite')), false);
  assert.equal((await req(e.port, 'GET', '/setup/api/state')).json.resetPending, false);
});

test('前の持ち主と別の人が鍵を作り直したら、reset-owner の招待の印を消す（13 回目のレビュー P3-D）', async t => {
  const { createHash } = await import('node:crypto');
  const e = await setup(); t.after(e.close);
  e.core.st.bootstrap = 'ready';
  e.L.store.update(x => { x.ownerUserId = 'u0'; });
  fs.writeFileSync(path.join(e.dataDir, 'reset-invite'), JSON.stringify({ hash: createHash('sha256').update('tok_abcdefgh').digest('hex'), exp: Date.now() + 3600_000 }), { mode: 0o600 });
  assert.equal((await req(e.port, 'POST', '/setup/api/launcher-key', { cookie: 's=owner' })).status, 200);
  assert.equal(fs.existsSync(path.join(e.dataDir, 'reset-invite')), false);
});

test('前の持ち主が reset-owner の途中に鍵を作り直しても、招待の印は消さない（12 回目のレビュー P3-A）', async t => {
  const { createHash } = await import('node:crypto');
  const e = await setup(); t.after(e.close);
  e.core.st.bootstrap = 'ready';
  assert.equal((await req(e.port, 'POST', '/setup/api/launcher-key', { cookie: 's=owner' })).status, 200);
  fs.writeFileSync(path.join(e.dataDir, 'reset-invite'), JSON.stringify({ hash: createHash('sha256').update('tok_abcdefgh').digest('hex'), exp: Date.now() + 3600_000 }), { mode: 0o600 });
  assert.equal((await req(e.port, 'POST', '/setup/api/launcher-key', { cookie: 's=owner' })).status, 200);
  assert.equal(fs.existsSync(path.join(e.dataDir, 'reset-invite')), true);
});
