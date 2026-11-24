// ほかの PC から使う形（設計 docs/design/2026-11-23-public-office-multi-user.md 2.1・6 の e2e 3・独立レビュー: 照らしていない守り）
// 使い方: node test/e2e/lan.e2e.mjs <image>
// docker の network を作り、office を別名 office.lan と AIOFFICE_HOSTS=office.lan:3100 で起こす。同じ network の別の container から、
// その名前で claim・sign-up・会社の作成・招待までを通し、許していない名前（other.lan）と、許した名前でも port が違う形は断られることを確かめる
import assert from 'node:assert/strict';
import { dockerSync } from './docker.mjs';

const IMAGE = process.argv[2] || 'aioffice:dev';
const NET = 'aio-lan-e2e', NAME = 'aio-lan-e2e', VOL = 'aio-lan-e2e';
const sh = (...a) => String(dockerSync(a, { encoding: 'utf8' }));
const quiet = (...a) => { try { sh(...a); } catch { /* 無い */ } };
const sleep = ms => new Promise(r => setTimeout(r, ms));
const step = (n, s) => console.log(`段 ${n}: ${s}`);

// 同じ network の別の container の中で、Host と Origin をその名前にした要求の列を回す（cookie は列の中で持ち回る）
function client(calls, host = 'office.lan:3100') {
  const js = `
    const B = 'http://office.lan:3100', H = ${JSON.stringify(host)}, calls = ${JSON.stringify(calls)};
    const http = require('node:http'); const jar = {}; const out = [];
    const one = c => new Promise(res => {
      const headers = { host: H, origin: 'http://' + H, 'content-type': 'application/json' };
      if (Object.keys(jar).length) headers.cookie = Object.entries(jar).map(([k, v]) => k + '=' + v).join('; ');
      const data = c.body ? JSON.stringify(c.body) : null; if (data) headers['content-length'] = Buffer.byteLength(data);
      const r = http.request({ host: 'office.lan', port: 3100, method: c.m, path: c.p, headers }, x => {
        for (const sc of x.headers['set-cookie'] || []) { const kv = sc.split(';')[0]; const i = kv.indexOf('='); jar[kv.slice(0, i)] = kv.slice(i + 1); }
        let t = ''; x.on('data', d => { t += d; }); x.on('end', () => { let j = null; try { j = JSON.parse(t); } catch { j = t.slice(0, 200); } res({ status: x.statusCode, body: j }); });
      });
      r.on('error', e => res({ status: 0, body: String(e.message) })); if (data) r.write(data); r.end();
    });
    (async () => { for (const c of calls) out.push(await one(c)); console.log(JSON.stringify(out)); })();`;
  return JSON.parse(sh('run', '--rm', '--network', NET, '--entrypoint', 'node', IMAGE, '-e', js).trim().split('\n').pop());
}

quiet('rm', '-f', NAME); quiet('volume', 'rm', VOL); quiet('network', 'rm', NET);
sh('network', 'create', NET);
try {
  sh('run', '-d', '--name', NAME, '--network', NET, '--network-alias', 'office.lan', '-e', 'AIOFFICE_HOSTS=office.lan:3100', '-v', `${VOL}:/data`, IMAGE);
  step(1, '起きるのを待つ');
  let st = null;
  for (let i = 0; i < 80; i++) { [st] = client([{ m: 'GET', p: '/setup/api/state' }]); if (st.status === 200 && st.body?.stage === 'preclaim') break; await sleep(3000); }
  assert.equal(st.body?.stage, 'preclaim', JSON.stringify(st));

  step(2, '許していない名前と、port の違う形は断る');
  assert.equal(client([{ m: 'GET', p: '/setup/api/state' }], 'other.lan:3100')[0].status, 403, '許していない名前');
  assert.equal(client([{ m: 'GET', p: '/setup/api/state' }], 'office.lan:8080')[0].status, 403, '許した名前でも port が違う');

  step(3, 'office.lan の名前で、最初の持ち主を作り、会社を作り、人を招く');
  const code = sh('exec', NAME, 'cat', '/data/aioffice/claim-code').trim();
  const r = client([
    { m: 'POST', p: '/setup/api/claim-code', body: { code } },
    { m: 'POST', p: '/api/auth/sign-up/email', body: { name: '持ち主', email: 'own@example.test', password: 'Owner-pass-12345' } },
    { m: 'POST', p: '/api/bootstrap/claim', body: {} },
    { m: 'POST', p: '/setup/api/launcher-key' },
  ]);
  assert.deepEqual(r.map(x => x.status < 300), [true, true, true, true], JSON.stringify(r.map(x => [x.status, x.body])));
  for (let i = 0; i < 60; i++) { [st] = client([{ m: 'GET', p: '/setup/api/state' }]); if (st.body?.stage === 'ready') break; await sleep(3000); }
  assert.equal(st.body?.stage, 'ready');
  const r2 = client([
    { m: 'POST', p: '/api/auth/sign-in/email', body: { email: 'own@example.test', password: 'Owner-pass-12345' } },
    { m: 'POST', p: '/setup/api/lang', body: { lang: 'ja', timeZone: 'Asia/Tokyo' } },
    { m: 'POST', p: '/setup/api/company', body: { name: 'LAN の会社' } },
    { m: 'GET', p: '/api/companies' },
  ]);
  assert.deepEqual(r2.slice(0, 3).map(x => x.status), [200, 200, 200], JSON.stringify(r2.map(x => [x.status, x.body])));
  const cid = (r2[3].body || []).find(c => c.name === 'LAN の会社')?.id;
  assert.ok(cid, '会社ができた');
  const r3 = client([
    { m: 'POST', p: '/api/auth/sign-in/email', body: { email: 'own@example.test', password: 'Owner-pass-12345' } },
    { m: 'POST', p: '/setup/api/people/invite', body: { companyId: cid } },
  ]);
  assert.equal(r3[1].status, 200, JSON.stringify(r3[1].body));
  assert.match(r3[1].body.inviteUrl, /^http:\/\/office\.lan:3100\/invite\//, '招待の URL はその要求の住所');
  console.log('ok: ほかの PC の名前（AIOFFICE_HOSTS）で、claim・sign-up・会社・招待が通り、許していない名前と port は断られた');
} finally {
  quiet('rm', '-f', NAME); quiet('volume', 'rm', VOL); quiet('network', 'rm', NET);
}
