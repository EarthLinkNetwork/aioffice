// パスワードを忘れた時の戻し方（設計 docs/design/2026-11-23-public-office-multi-user.md 2.8・6 の e2e 8・独立レビュー 5）
// 使い方: node test/e2e/reset-owner.e2e.mjs <container の名前> <起動係の URL>（container は image をまっさらな volume で起こした直後）
// 1. 最初の持ち主を作る（code → sign-up → claim → 起動係の鍵）・会社を作る
// 2. 普段の段で aioffice-reset-owner → 出た招待で新しい持ち主を作る → instance admin・起動係の持ち主の口が使える・会社は残る
// 3. 起動係の鍵を消して鍵の無い段にする → reset-owner → 招待を開いた人だけ sign-up と accept が通る → 鍵を作り直して普段の段に戻る
import assert from 'node:assert/strict';
import { dockerSync } from './docker.mjs';

const NAME = process.argv[2] || 'aioffice', B = process.argv[3] || 'http://127.0.0.1:3100';
const sleep = ms => new Promise(r => setTimeout(r, ms));
const dexec = (...a) => String(dockerSync(['exec', NAME, ...a], { encoding: 'utf8' }));
function who() {
  const jar = {};
  return async (m, p, b) => {
    const h = { origin: B, 'content-type': 'application/json' };
    if (Object.keys(jar).length) h.cookie = Object.entries(jar).map(([k, v]) => `${k}=${v}`).join('; ');
    const r = await fetch(B + p, { method: m, headers: h, body: b ? JSON.stringify(b) : undefined, redirect: 'manual' });
    for (const c of r.headers.getSetCookie()) { const [kv] = c.split(';'); const i = kv.indexOf('='); jar[kv.slice(0, i)] = kv.slice(i + 1); }
    const t = await r.text(); let j = null; try { j = JSON.parse(t); } catch { j = t.slice(0, 300); }
    return { status: r.status, body: j };
  };
}
const step = (n, s) => console.log(`段 ${n}: ${s}`);
const state = async () => (await fetch(`${B}/setup/api/state`).then(r => r.json()));
async function until(fn, what, ms = 240_000) { const t0 = Date.now(); while (Date.now() - t0 < ms) { try { const v = await fn(); if (v) return v; } catch { /* 起動中 */ } await sleep(3000); } throw new Error(`待ちきれない: ${what}`); }
const resetUrl = () => { const out = dexec('aioffice-reset-owner'); const m = out.match(/http:\/\/localhost:3100\/invite\/([A-Za-z0-9_-]+)/); assert.ok(m, '招待の URL が出る'); assert.ok(!/invite\/[A-Za-z0-9_-]+/.test(dexec('sh', '-c', 'cat /data/aioffice/reset-invite')), 'token そのものは file に置かない'); return m[1]; };
async function newOwner(p, token, email) {
  assert.equal((await p('GET', `/invite/${token}`)).status, 200, '招待の画面が開く');
  assert.equal((await p('POST', '/api/auth/sign-up/email', { name: '新しい持ち主', email, password: 'New-owner-pass-123' })).status, 200);
  const acc = await p('POST', `/api/invites/${token}/accept`, { requestType: 'human' });
  assert.ok([200, 201, 202].includes(acc.status), JSON.stringify(acc.body));
  await until(async () => (await p('GET', '/setup/api/state')).body?.authed === true, '新しい持ち主が持ち主として扱われる', 60_000);
}

await until(async () => (await state()).stage === 'preclaim', 'claim の前');
step(1, '最初の持ち主と会社');
const own = who();
const code = dexec('cat', '/data/aioffice/claim-code').trim();
assert.equal((await own('POST', '/setup/api/claim-code', { code })).status, 200);
assert.equal((await own('POST', '/api/auth/sign-up/email', { name: '持ち主', email: 'own@example.test', password: 'Owner-pass-12345' })).status, 200);
assert.equal((await own('POST', '/api/bootstrap/claim', {})).status < 300, true);
assert.equal((await own('POST', '/setup/api/launcher-key')).status, 200);
await until(async () => (await state()).stage === 'ready', '普段の段');
assert.equal((await own('POST', '/setup/api/lang', { lang: 'ja', timeZone: 'Asia/Tokyo' })).status, 200);
assert.equal((await own('POST', '/setup/api/company', { name: '戻し方の会社' })).status, 200);

step(2, '普段の段で reset-owner → 前の admin が外れて担当が止まる → 招待を開いた人だけが通る → 新しい持ち主が鍵を作り直す');
// reset の前から sign-in している人（招いた人・LAN の誰か）が、admin が 0 人になった瞬間に bootstrap の claim を叩いても取れない（2 回目のレビュー 高 1）
const early = who();
assert.equal((await early('POST', '/api/auth/sign-up/email', { name: 'e', email: 'early@example.test', password: 'Early-pass-12345' })).status, 200);
const t1 = resetUrl();
for (let i = 0; i < 5; i++) assert.ok((await early('POST', '/api/bootstrap/claim', {})).status >= 400, 'reset の直後の bootstrap の claim は断られる');
// admin が 1 人もいないので、本体は最初の持ち主を待つ状態（起動係の段は preclaim）。担当は止まる
await until(async () => ['preclaim', 'keyless'].includes((await state()).stage), '前の持ち主の鍵が使えなくなり担当が止まる段', 180_000);
const outsider = who();
assert.equal((await outsider('POST', '/api/auth/sign-up/email', { name: 'y', email: 'y@example.test', password: 'Yyyy-pass-12345' })).status, 503, '招待を開いていない人の sign-up は本体に届かない');
assert.equal((await outsider('POST', `/api/invites/${t1}/accept`, { requestType: 'human' })).status, 503, '招待の画面を通っていない accept は本体に届かない');
const n1 = who();
await newOwner(n1, t1, 'new1@example.test');
assert.equal((await n1('POST', '/setup/api/launcher-key')).status, 200, '新しい持ち主が鍵を作り直せる');
await until(async () => (await state()).stage === 'ready', '普段の段に戻る', 180_000);
for (let i = 0; i < 60; i++) { if ((await n1('GET', '/api/companies')).status === 200) break; await sleep(3000); }
assert.equal((await n1('GET', '/setup/api/people')).status, 200, '新しい持ち主は人の欄を読める');
assert.ok(((await n1('GET', '/api/companies')).body || []).some(c => c.name === '戻し方の会社'), '会社は残る');
assert.notEqual((await own('GET', '/setup/api/people')).status, 200, '前の持ち主はもう持ち主の口を使えない');
const coId = ((await n1('GET', '/api/companies')).body || []).find(c => c.name === '戻し方の会社').id;
await until(async () => (await n1('GET', `/api/companies/${coId}/attention`)).status === 200, '新しい持ち主が会社の人になり、会社の口を使える（起動係が毎分入れる）', 180_000);
const roleOf = async email => { const r = await n1('GET', `/api/companies/${coId}/members`); const l = Array.isArray(r.body) ? r.body : r.body?.members || []; return l.find(m => m.user?.email === email)?.membershipRole; };
await until(async () => (await roleOf('own@example.test')) === 'operator', '前の持ち主は会社の owner の役から operator に下がる（2 回目のレビュー 中 5）', 180_000);
assert.equal(await roleOf('new1@example.test'), 'owner', '新しい持ち主は会社の owner');
const stranger = who();
assert.equal((await stranger('POST', '/api/auth/sign-up/email', { name: 'x', email: 'x@example.test', password: 'Xxxx-pass-12345' })).status, 200);
assert.notEqual((await stranger('GET', '/setup/api/people')).status, 200, '招待を使っていない人は持ち主にならない');

step(3, '鍵の file が消えた段で reset-owner → 新しい持ち主 → 鍵を作り直す');
dexec('rm', '-f', '/data/aioffice/board-key.json');
await until(async () => (await state()).stage === 'keyless', '鍵の無い段', 180_000);
const n2 = who();
await newOwner(n2, resetUrl(), 'new2@example.test');
assert.equal((await n2('POST', '/setup/api/launcher-key')).status, 200, '新しい持ち主が鍵を作り直せる');
await until(async () => (await state()).stage === 'ready', '普段の段に戻る', 180_000);
await until(async () => (await n2('GET', `/api/companies/${coId}/attention`)).status === 200, '鍵を作り直した持ち主も会社の口を使える', 180_000);
console.log('ok: reset-owner で、普段の段でも鍵の無い段でも持ち主を作り直せた（会社は残る・招待を開いていない人は通らない）');
