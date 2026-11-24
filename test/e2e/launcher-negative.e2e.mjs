// wizard を済ませた container に、断られるべき要求を送る（仕様「CI」の 3 の否定の試験）
// 使い方: AIO_BASE=http://localhost:3100 AIO_CONTAINER=aioffice AIO_PASS=e2e-owner-password node test/e2e/launcher-negative.e2e.mjs
//   AIO_CODEX=1 の時だけ、本物の device login を二度押しして process が 1 本のままかを確かめる（OpenAI へつなぐ）
import assert from 'node:assert/strict';
import http from 'node:http';
import net from 'node:net';
import { execFileSync } from 'node:child_process';
import { dockerSync } from './docker.mjs';

const BASE = new URL(process.env.AIO_BASE || 'http://localhost:3100');
const PORT = Number(BASE.port || 80);
const HOST = `localhost:${PORT}`, ME = `http://${HOST}`;
const PASS = process.env.AIO_PASS || 'e2e-owner-password', EMAIL = process.env.AIO_OWNER_EMAIL || 'owner@example.test';
const CONTAINER = process.env.AIO_CONTAINER || 'aioffice';

function req(method, p, { body, cookie, host = HOST, origin } = {}) {
  return new Promise((resolve, reject) => {
    const headers = { host }; if (cookie) headers.cookie = cookie; if (origin) headers.origin = origin;
    const data = body == null ? null : JSON.stringify(body); if (data) { headers['content-type'] = 'application/json'; headers['content-length'] = Buffer.byteLength(data); }
    const r = http.request({ host: '127.0.0.1', port: PORT, method, path: p, headers }, res => { let t = ''; res.on('data', c => { t += c; }); res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, text: t })); });
    r.on('error', reject); if (data) r.write(data); r.end();
  });
}
function upgrade({ cookie, origin }) {
  return new Promise(resolve => {
    const s = net.connect(PORT, '127.0.0.1', () => s.write(`GET /api/ws HTTP/1.1\r\nhost: ${HOST}\r\nupgrade: websocket\r\nconnection: Upgrade\r\nsec-websocket-version: 13\r\nsec-websocket-key: dGhlIHNhbXBsZSBub25jZQ==\r\n${origin ? `origin: ${origin}\r\n` : ''}${cookie ? `cookie: ${cookie}\r\n` : ''}\r\n`));
    let t = ''; s.on('data', d => { t += d; if (t.includes('\r\n')) { s.destroy(); resolve(t.split('\r\n')[0]); } }); s.on('error', () => resolve(t.split('\r\n')[0]));
    setTimeout(() => { s.destroy(); resolve(t.split('\r\n')[0] || 'timeout'); }, 5000);
  });
}

// 持ち主は本体のアカウントで sign-in する（設計 docs/design/2026-11-23-public-office-multi-user.md 2.2）
const login = await req('POST', '/api/auth/sign-in/email', { body: { email: EMAIL, password: PASS }, origin: ME });
assert.equal(login.status, 200, '持ち主のアカウントで入れる');
const cookie = login.headers['set-cookie'].map(c => c.split(';')[0]).join('; ');

const checks = [
  ['外の Host は断る', async () => assert.equal((await req('GET', '/', { host: 'evil.example:3100', cookie })).status, 403)],
  ['DNS rebinding の形の Host（127.0.0.1.evil）も断る', async () => assert.equal((await req('GET', '/api/companies', { host: '127.0.0.1.evil.example', cookie })).status, 403)],
  ['session の無い要求は本体が断る', async () => { const r = await req('GET', '/api/companies'); assert.ok([302, 401, 403].includes(r.status), String(r.status)); }],
  ['session があれば本体へ中継する', async () => { const r = await req('GET', '/api/companies', { cookie }); assert.equal(r.status, 200); assert.ok(Array.isArray(JSON.parse(r.text))); }],
  ['同じ Origin の POST は本体まで通る（本体は起動係の Origin を断らない）', async () => {
    const id = JSON.parse((await req('GET', '/api/companies', { cookie })).text)[0].id;
    const r = await req('POST', `/api/companies/${id}/issues`, { body: { title: 'origin check' }, cookie, origin: ME });
    assert.ok(r.status >= 200 && r.status < 300, `本体が受け付けた: ${r.status}`); // 本体は 201 と 200 のどちらも返す（CI では 200 だった）
    assert.equal(JSON.parse(r.text).title, 'origin check', '本体の API の返事（作った件）が返る');
  }],
  ['別の Origin（別のサイト）からの POST を断る', async () => assert.equal((await req('POST', '/api/companies', { body: { name: 'x' }, cookie, origin: 'http://evil.example' })).status, 403)],
  ['別の port の Origin からの POST を断る', async () => assert.equal((await req('POST', '/api/companies', { body: { name: 'x' }, cookie, origin: `http://localhost:${PORT + 1}` })).status, 403)],
  ['別の Origin の WebSocket を断る', async () => assert.match(await upgrade({ cookie, origin: 'http://evil.example' }), / 403 /)],
  ['session の無い WebSocket を断る', async () => assert.match(await upgrade({ origin: ME }), / 40[13] /)],
  ['持ち主の再登録を断る', async () => assert.equal((await req('POST', '/setup/api/owner', { body: { password: 'another password' }, origin: ME })).status, 409)],
  ['違うパスワードでは入れない', async () => assert.equal((await req('POST', '/api/auth/sign-in/email', { body: { email: EMAIL, password: 'not the password' }, origin: ME })).status, 401)],
  ['合言葉の口はもう使わない', async () => assert.equal((await req('POST', '/setup/api/login', { body: { password: PASS }, origin: ME })).status, 409)],
  ['持ち主がいれば最初の持ち主の code の口を断る', async () => assert.equal((await req('POST', '/setup/api/claim-code', { body: { code: 'AAAAAAAA' }, origin: ME })).status, 409)],
  ['起動係の鍵の作り直しは持ち主の session だけ', async () => assert.equal((await req('POST', '/setup/api/launcher-key', { origin: ME })).status, 403)],
  ['壊れた住所でも落ちない', async () => {
    const line = await new Promise(resolve => { const s = net.connect(PORT, '127.0.0.1', () => s.write(`GET //[ HTTP/1.1\r\nhost: ${HOST}\r\nconnection: close\r\n\r\n`)); let t = ''; s.on('data', d => { t += d; }); s.on('end', () => resolve(t.split('\r\n')[0])); });
    assert.match(line, / 400 /); assert.equal((await req('GET', '/setup/api/state')).status, 200);
  }],
];
if (process.env.AIO_CODEX === '1') checks.push(['ログインの二度押しで codex の process は 1 本のまま', async () => {
  await Promise.all([0, 1, 2].map(() => req('POST', '/setup/api/codex/start', { cookie, origin: ME }))); // 同時に 3 回押す
  await new Promise(r => setTimeout(r, 3000));
  const count = () => dockerSync(['exec', CONTAINER, 'sh', '-c', 'for p in /proc/[0-9]*; do tr "\\0" " " < $p/cmdline 2>/dev/null; echo; done'], { encoding: 'utf8' })
    .split('\n').filter(l => /login --device-auth/.test(l) && !/\bsh -c\b/.test(l)).length;
  const n = count();
  await req('POST', '/setup/api/codex/cancel', { cookie, origin: ME });
  await new Promise(r => setTimeout(r, 1500));
  assert.equal(n, 1, `3 回押した後の device login の process: ${n}`);
  assert.equal(count(), 0, '取り消すと process が残らない');
  const after = (await req('GET', '/setup/api/state', { cookie })).text;
  assert.match(after, /"state":"(cancelled|done)"/);
}]);

let failed = 0;
for (const [name, fn] of checks) { try { await fn(); console.log(`ok   ${name}`); } catch (e) { failed++; console.log(`FAIL ${name}: ${e.message}`); } }
if (failed) { console.log(`${failed} failed`); process.exit(1); }
console.log(`ok negative: ${checks.length} checks`);
