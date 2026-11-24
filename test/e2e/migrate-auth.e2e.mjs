// 前の版（合言葉・ログインなしの本体）の office を、新しい版（ログインのある形）に移し替える（設計 docs/design/2026-11-23-public-office-multi-user.md 2.4）
// 使い方: node test/e2e/migrate-auth.e2e.mjs <前の版の image> <新しい版の image> <port>
// 1. 前の版をまっさらな volume で起こし、合言葉・会社・持ち主（local-board）に割り当てた課題を作って止める
// 2. 同じ volume で新しい版を起こし、合言葉で入って backup → 持ち主のアカウント → 引き継ぎ → 起動係の鍵 → 付け替え → 片付け
import assert from 'node:assert/strict';
import { dockerSync } from './docker.mjs';

const [OLD, NEW, PORT = '3162'] = process.argv.slice(2);
if (!OLD || !NEW) { console.error('使い方: node test/e2e/migrate-auth.e2e.mjs <前の版の image> <新しい版の image> [port]'); process.exit(2); }
const NAME = 'aio-migrate-e2e', VOL = 'aio-migrate-e2e', B = `http://127.0.0.1:${PORT}`;
const sleep = ms => new Promise(r => setTimeout(r, ms));
const docker = (...a) => String(dockerSync(a, { encoding: 'utf8' }));
const dexec = (...a) => docker('exec', NAME, ...a);
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
const list = b => (Array.isArray(b) ? b : b?.items || []);
const step = (n, s) => console.log(`段 ${n}: ${s}`);
async function until(fn, what, ms = 240_000) { const t0 = Date.now(); while (Date.now() - t0 < ms) { try { const v = await fn(); if (v) return v; } catch { /* 起動中 */ } await sleep(3000); } throw new Error(`待ちきれない: ${what}`); }
const start = img => { try { docker('rm', '-f', NAME); } catch { /* 無い */ } docker('run', '-d', '--name', NAME, '-p', `127.0.0.1:${PORT}:3100`, '-v', `${VOL}:/data`, img); };

try { docker('rm', '-f', NAME); } catch { /* 無い */ }
try { docker('volume', 'rm', VOL); } catch { /* 無い */ }
const PW = 'Old-owner-pass-1234';

step(1, '前の版: 合言葉・会社・持ち主に割り当てた課題');
start(OLD);
const old = who();
await until(async () => (await old('GET', '/setup/api/state')).status === 200, '前の版の起動');
assert.equal((await old('POST', '/setup/api/lang', { lang: 'ja', timeZone: 'Asia/Tokyo' })).status, 200);
assert.equal((await old('POST', '/setup/api/owner', { password: PW })).status, 200);
await until(async () => (await old('POST', '/setup/api/company', { name: '前の版の会社' })).status === 200, '会社');
// 前の版の wizard を秘書・完了まで進める（前の版の起動係は完了まで本体へ中継しない）
const sec = await old('POST', '/setup/api/secretary', {}); assert.equal(sec.status, 200, JSON.stringify(sec.body));
const done = await old('POST', '/setup/api/finish', {}); assert.equal(done.status, 200, JSON.stringify(done.body));
const cid = list((await old('GET', '/api/companies')).body)[0]?.id;
assert.ok(cid, '会社の id');
const iss = await old('POST', `/api/companies/${cid}/issues`, { title: '[試験] 持ち主に割り当てた課題', status: 'todo', assigneeUserId: 'local-board' });
assert.ok(iss.body?.id, JSON.stringify(iss.body));
docker('stop', NAME);

step(2, '新しい版: 移し替えの段。合言葉が無ければ本体に届かない・backup が先');
start(NEW);
const own = who();
await until(async () => (await own('GET', '/setup/api/state')).body?.stage === 'migrating', '移し替えの段');
assert.equal((await own('GET', '/api/companies')).status, 503);
assert.equal((await own('POST', '/api/auth/sign-up/email', { name: 'x', email: 'x@example.test', password: 'Xxxx-pass-1234' })).status, 503, '合言葉の前は sign-up も通さない');
assert.equal((await own('POST', '/setup/api/login', { password: PW })).status, 200);
const st = await until(async () => { const s = (await own('GET', '/setup/api/state')).body; return s.migration?.step === 'claim' && s; }, 'backup と token');
assert.equal(st.migration.error, null);
const backups = dexec('sh', '-c', 'ls /data/paperclip/instances/default/data/backups 2>/dev/null; find /data/paperclip -name "aioffice-before-auth*" -type f').trim();
assert.match(backups, /aioffice-before-auth/, 'backup の file');
assert.ok(!/board-claim\/[A-Za-z0-9_-]{8,}|[?&]code=[A-Za-z0-9_-]{4,}/.test(docker('logs', NAME)), 'claim の URL も code もログに写さない（形を崩した写しも）');

step(3, '持ち主のアカウントを作って引き継ぐ・起動係の鍵');
assert.equal((await own('POST', '/api/auth/sign-up/email', { name: '持ち主', email: 'own@example.test', password: 'Owner-pass-12345' })).status, 200);
const cl = await own('POST', '/setup/api/migrate/claim');
assert.equal(cl.status, 200, JSON.stringify(cl.body));
assert.equal((await own('POST', '/setup/api/launcher-key')).status, 200);
const st2 = await until(async () => { const s = (await own('GET', '/setup/api/state')).body; return s.migration?.step === 'finish' && s; }, '最後の段');
assert.equal(st2.stage, 'migrating', '付け替えの前は移し替えの段のまま（担当は止めたまま）');
assert.match(dexec('sh', '-c', 'for p in /proc/[0-9]*; do tr "\\0" "\\n" < $p/environ 2>/dev/null | grep -q "^PAPERCLIP_DEPLOYMENT_MODE=" && tr "\\0" "\\n" < $p/environ | grep -c "^HEARTBEAT_SCHEDULER_ENABLED=false"; done | sort -u'), /^1$/m, '鍵があっても移し替えの間は scheduler を止める');

step(4, '付け替えと片付け');
const fin = await until(async () => { const r = await own('POST', '/setup/api/migrate/finish', { relink: true }); return r.status !== 503 && r; }, '本体が起き直すまで');
assert.equal(fin.status, 200, JSON.stringify(fin.body));
assert.equal(fin.body.moved, 1);
const state = JSON.parse(dexec('cat', '/data/aioffice/state.json'));
assert.equal(state.v, 2); assert.equal(state.owner, null);
await until(async () => (await fetch(`${B}/setup/api/state`).then(r => r.json())).stage === 'ready', '普段の段');
const me = who();
await until(async () => (await me('POST', '/api/auth/sign-in/email', { email: 'own@example.test', password: 'Owner-pass-12345' })).status === 200, 'sign-in');
const after = (await me('GET', `/api/issues/${iss.body.id}`)).body;
assert.equal(after.assigneeUserId, state.ownerUserId, '持ち主に付け替えた');
assert.equal((await me('GET', '/setup/api/state')).body.authed, true);
assert.equal((await own('POST', '/setup/api/login', { password: PW })).status, 409, '合言葉の口はもう使わない');
await until(() => !/HEARTBEAT_SCHEDULER_ENABLED=false/.test(dexec('sh', '-c', 'for p in /proc/[0-9]*; do tr "\\0" "\\n" < $p/environ 2>/dev/null | grep -q "^PAPERCLIP_DEPLOYMENT_MODE=" && tr "\\0" "\\n" < $p/environ | grep "^HEARTBEAT_SCHEDULER_ENABLED=" ; done; true')), 'scheduler を戻す', 120_000);
console.log('ok: 前の版の office を、合言葉で守ったままログインのある形に移し替え、課題を持ち主に付け替えた');

step(5, '戻し方: aioffice-restore で移し替えの前の backup に戻し、前の版の image で同じ volume を開く（設計 2.4・独立レビュー: 照らしていない守り）');
const listed = dexec('aioffice-restore');
const pre = listed.split('\n').find(l => /ログインの形に移す前/.test(l))?.trim().split(/\s+/)[0];
assert.ok(pre, `移し替えの前の backup が一覧に出る:\n${listed}`);
assert.match(dexec('aioffice-restore', pre), /Restored|戻しました/);
assert.ok(!dexec('ls', '/data/aioffice').includes('board-key.json'), '起動係の鍵を外す');
docker('stop', NAME);
start(OLD);
const back = who();
await until(async () => (await back('GET', '/setup/api/state')).status === 200, '前の版で起きる');
assert.equal((await back('POST', '/setup/api/login', { password: PW })).status, 200, '前の版の合言葉で入れる');
// 起動係が答えても、前の版の本体はまだ起きる途中のことがある（負荷が高いと会社の一覧が空で返る）。会社が見えるまで待つ
await until(async () => list((await back('GET', '/api/companies')).body).some(c => c.id === cid), '前の版の会社がある');
const backIss = list((await back('GET', `/api/companies/${cid}/issues`)).body).find(i => i.id === iss.body.id);
assert.equal(backIss?.assigneeUserId, 'local-board', '課題は移し替えの前の形（local-board の割り当て）に戻る');
console.log('ok: 移し替えの前の backup に戻し、前の版の image で同じ office を開けた');
docker('rm', '-f', NAME);
