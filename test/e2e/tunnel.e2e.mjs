// 外から自分だけで使う形（Cloudflare Tunnel・記事「外から自分だけで使う」）の e2e。外の Cloudflare につなぐので CI では回さず、手で回す
// 使い方: node test/e2e/tunnel.e2e.mjs <image> [手元の port]（cloudflared が PATH に要る。アカウントの要らない一時の tunnel（trycloudflare）を使う）
// 1. 一時の tunnel を http://localhost:<port> に向けて起こし、https の住所を得る
// 2. office を -p 127.0.0.1:<port>:3100 と AIOFFICE_HOSTS=https://<住所> で起こす
// 3. https の住所から claim・sign-up・起動係の鍵・会社・招待を通し、招待の URL が https で、招いた人がその URL で入れることを確かめる
// 4. 同じ名前でも http の Origin は断られ、AIOFFICE_HOSTS に無い名前も断られる
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import http from 'node:http';
import { dockerSync } from './docker.mjs';

const IMAGE = process.argv[2] || 'aioffice:dev', PORT = Number(process.argv[3] || 3163);
const NAME = 'aio-cf-e2e', VOL = 'aio-cf-e2e';
const sh = (...a) => String(dockerSync(a, { encoding: 'utf8' }));
const quiet = (...a) => { try { sh(...a); } catch { /* 無い */ } };
const sleep = ms => new Promise(r => setTimeout(r, ms));
const step = (n, s) => console.log(`段 ${n}: ${s}`);

function who(B) {
  const jar = {};
  return async (m, p, b, origin = B) => {
    const h = { origin, 'content-type': 'application/json' };
    if (Object.keys(jar).length) h.cookie = Object.entries(jar).map(([k, v]) => `${k}=${v}`).join('; ');
    const r = await fetch(B + p, { method: m, headers: h, body: b ? JSON.stringify(b) : undefined, redirect: 'manual' });
    for (const c of r.headers.getSetCookie()) { const [kv] = c.split(';'); const i = kv.indexOf('='); jar[kv.slice(0, i)] = kv.slice(i + 1); }
    const t = await r.text(); let j = null; try { j = JSON.parse(t); } catch { j = t.slice(0, 300); }
    return { status: r.status, body: j };
  };
}
async function until(fn, what, ms = 300_000) { const t0 = Date.now(); while (Date.now() - t0 < ms) { try { const v = await fn(); if (v) return v; } catch { /* 起動中・DNS の待ち */ } await sleep(3000); } throw new Error(`待ちきれない: ${what}`); }

quiet('rm', '-f', NAME); quiet('volume', 'rm', VOL);
const cf = spawn('cloudflared', ['tunnel', '--no-autoupdate', '--url', `http://localhost:${PORT}`], { stdio: ['ignore', 'pipe', 'pipe'] });
let log = '';
cf.stdout.on('data', d => { log += d; }); cf.stderr.on('data', d => { log += d; });
try {
  step(1, '一時の tunnel を起こす');
  const host = await until(() => log.match(/https:\/\/([a-z0-9-]+\.trycloudflare\.com)/)?.[1], 'tunnel の住所', 60_000);
  const B = `https://${host}`;
  step(2, `office を ${B} で起こす（port は 127.0.0.1 だけ）`);
  sh('run', '-d', '--name', NAME, '--stop-timeout', '60', '-p', `127.0.0.1:${PORT}:3100`, '-e', `AIOFFICE_HOSTS=${B}`, '-v', `${VOL}:/data`, IMAGE);
  const own = who(B);
  await until(async () => (await own('GET', '/setup/api/state')).body?.stage === 'preclaim', 'https の住所から claim の前の段が見える');

  step(3, 'https の住所で最初の持ち主・会社・招待');
  const code = sh('exec', NAME, 'cat', '/data/aioffice/claim-code').trim();
  assert.equal((await own('POST', '/setup/api/claim-code', { code })).status, 200);
  assert.equal((await own('POST', '/api/auth/sign-up/email', { name: '持ち主', email: 'own@example.test', password: 'Owner-pass-12345' })).status, 200);
  assert.ok((await own('POST', '/api/bootstrap/claim', {})).status < 300);
  assert.equal((await own('POST', '/setup/api/launcher-key')).status, 200);
  await until(async () => (await own('GET', '/setup/api/state')).body?.stage === 'ready', '普段の段');
  assert.equal((await own('POST', '/setup/api/lang', { lang: 'ja', timeZone: 'Asia/Tokyo' })).status, 200);
  assert.equal((await own('POST', '/setup/api/company', { name: 'Tunnel の会社' })).status, 200);
  const cid = await until(async () => ((await own('GET', '/api/companies')).body || []).find(c => c.name === 'Tunnel の会社')?.id, '会社が見える', 120_000);
  const inv = await own('POST', '/setup/api/people/invite', { companyId: cid });
  assert.equal(inv.status, 200, JSON.stringify(inv.body));
  assert.ok(inv.body.inviteUrl.startsWith(`${B}/invite/`), `招待の URL は https の住所: ${inv.body.inviteUrl}`);
  const token = inv.body.inviteUrl.split('/invite/')[1];
  const mate = who(B);
  assert.equal((await mate('GET', `/invite/${token}`)).status, 200, '招待の画面が開く');
  assert.equal((await mate('POST', '/api/auth/sign-up/email', { name: '同僚', email: 'mate@example.test', password: 'Mate-pass-123456' })).status, 200);
  const acc = await mate('POST', `/api/invites/${token}/accept`, { requestType: 'human' });
  assert.ok([200, 201, 202].includes(acc.status), JSON.stringify(acc.body));

  step(4, 'http の Origin と、許していない名前は断る');
  assert.equal((await who(B)('POST', '/api/auth/sign-in/email', { email: 'own@example.test', password: 'Owner-pass-12345' }, `http://${host}`)).status, 403, '同じ名前でも http の Origin は断る');
  // fetch は Host を差し替えられないので http.request で送る
  const hostStatus = h => new Promise((resolve, reject) => { const q = http.request({ host: '127.0.0.1', port: PORT, path: '/setup/api/state', headers: { host: h } }, x => { x.resume(); x.on('end', () => resolve(x.statusCode)); }); q.on('error', reject); q.end(); });
  assert.equal(await hostStatus('other.example.com'), 403, '許していない名前は断る');
  assert.equal(await hostStatus(host), 200, '許した前段の住所は通る（同じ道具で、試験の道具が Host を送れていることも確かめる）');
  console.log(`ok: Cloudflare Tunnel の https の住所（${host}）で、claim・sign-up・会社・招待と、招いた人の sign-up・accept が通り、http の Origin と許していない名前は断られた`);
} finally {
  cf.kill('SIGTERM');
  quiet('rm', '-f', NAME); quiet('volume', 'rm', VOL);
}
