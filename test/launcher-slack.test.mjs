// 起動係の Slack の口の試験（偽の本体と偽の知らせの plugin）。範囲: docs/review/2026-11-18-slack-notify-scope.md 作り方 3・S1・S3
import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createLauncher, isLoopback, SLACK_NONCE_MS } from '../packages/aioffice/launcher/server.mjs';
import { createRounds } from '../packages/aioffice/launcher/lib/rounds.mjs';
import { hashPassword, issueCookie } from '../packages/aioffice/launcher/lib/guard.mjs';
import { destFingerprint, MASKED_DEST } from '../packages/aioffice/launcher/lib/slack-url.mjs';

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'aio-slack-'));
const URL1 = 'https://hooks.slack.com/services/T0SLACKA1/B0SLACKB1/Zq9secretPart1xyz';
const URL2 = 'https://hooks.slack.com/services/T0SLACKA2/B0SLACKB2/Zq9secretPart2xyz';
const PARTS = u => u.replace('https://hooks.slack.com/services/', '').split('/');
const HASH = 'a'.repeat(32);

// 偽の本体: 会社・秘密・plugin の設定・知らせの plugin の Slack の口。confirm は本物の worker と同じく起動係の照合の口を呼ぶ
function fakeCore() {
  const calls = [], secrets = new Map(), configs = new Map([['c1', { stuckIdleMin: 5 }]]);
  let launcherPort = 0, beforeVerify = null, verifyResults = [], verifyTamper = null;
  const srv = http.createServer((req, res) => {
    let b = ''; req.on('data', c => { b += c; }); req.on('end', async () => {
      const u = new URL(req.url, 'http://x'), body = b ? JSON.parse(b) : null; calls.push({ method: req.method, path: u.pathname, query: Object.fromEntries(u.searchParams), body });
      const json = (s, o) => { res.writeHead(s, { 'content-type': 'application/json' }); res.end(JSON.stringify(o)); };
      const co = u.pathname.match(/^\/api\/companies\/([^/]+)$/);
      if (req.method === 'GET' && co) return co[1] === 'c1' ? json(200, { id: 'c1', issuePrefix: 'ACM' }) : co[1] === 'c2' ? json(200, { id: 'c2', issuePrefix: 'TWO' }) : co[1] === 'zz8' ? json(404, { error: 'Company not found' }) : json(403, { error: 'Forbidden' }); // ログインのある形の本体は、知らない会社に 403 を返す（2026-11-24 公開の CI の slack の 11）
      if (req.method === 'POST' && /^\/api\/companies\/c[12]\/secrets$/.test(u.pathname)) { const id = `00000000-0000-4000-8000-00000000000${secrets.size + 1}`; secrets.set(id, body.value); return json(201, { id, name: body.name }); }
      const rot = u.pathname.match(/^\/api\/secrets\/([^/]+)\/rotate$/);
      if (rot) { if (!secrets.has(rot[1])) return json(404, { error: 'Secret not found' }); secrets.set(rot[1], body.value); return json(200, { id: rot[1] }); }
      const del = u.pathname.match(/^\/api\/secrets\/([^/]+)$/);
      if (req.method === 'DELETE' && del) { secrets.delete(del[1]); return json(200, { ok: true }); }
      if (u.pathname === '/api/plugins/aioffice.notify/config') {
        if (req.method === 'GET') { const c = configs.get(u.searchParams.get('companyId')); return json(200, c ? { configJson: c } : null); }
        configs.set(body.companyId, body.configJson); return json(200, { configJson: body.configJson });
      }
      if (u.pathname === '/api/plugins/aioffice.notify/api/slack/preview') return json(200, { v: 1, hash: HASH, messages: [] });
      if (u.pathname === '/api/plugins/aioffice.notify/api/slack/off') return json(200, { v: 1, on: false });
      if (u.pathname === '/api/plugins/aioffice.notify/api/slack/confirm') {
        if (beforeVerify) beforeVerify();
        // verifyTamper: 照合の口に別の会社・別の hash で照らす（nonce を盗んだ担当が別の会社・別の見本に使う形）
        const v = await fetch(`http://127.0.0.1:${launcherPort}/setup/internal/slack-nonce`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ nonce: body.nonce, companyId: u.searchParams.get('companyId'), previewHash: body.previewHash, ...(verifyTamper || {}) }) });
        const vj = await v.json();
        // 使い済みの nonce が通らないことも、同じ要求の中で確かめる
        const again = await fetch(`http://127.0.0.1:${launcherPort}/setup/internal/slack-nonce`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ nonce: body.nonce, companyId: u.searchParams.get('companyId'), previewHash: body.previewHash }) });
        verifyResults.push({ status: v.status, body: vj, again: again.status });
        return v.ok ? json(200, { v: 1, on: true, onAt: 'now' }) : json(403, { error: 'slack_not_owner' });
      }
      return json(404, { error: 'nope' });
    });
  });
  return { srv, calls, secrets, configs, verifyResults, setLauncherPort: p => { launcherPort = p; }, setBeforeVerify: f => { beforeVerify = f; }, setVerifyTamper: o => { verifyTamper = o; } };
}
const listen = srv => new Promise(r => srv.listen(0, '127.0.0.1', () => r(srv.address().port)));
function req(port, method, p, { body, cookie } = {}) {
  return new Promise((resolve, reject) => {
    const headers = { host: `127.0.0.1:${port}`, origin: `http://127.0.0.1:${port}` }; if (cookie) headers.cookie = cookie;
    const data = body == null ? null : JSON.stringify(body); if (data != null) { headers['content-type'] = 'application/json'; headers['content-length'] = Buffer.byteLength(data); }
    const r = http.request({ host: '127.0.0.1', port, method, path: p, headers }, res => { let t = ''; res.on('data', c => { t += c; }); res.on('end', () => { let j = null; try { j = JSON.parse(t); } catch { /* 文字 */ } resolve({ status: res.statusCode, json: j, text: t }); }); });
    r.on('error', reject); if (data != null) r.write(data); r.end();
  });
}
async function launcher(opts = {}) {
  const dir = tmp(), core = fakeCore(), pcPort = await listen(core.srv);
  const { server, store } = createLauncher({ dataDir: path.join(dir, 'aioffice'), paperclipUrl: `http://127.0.0.1:${pcPort}`, codexHome: path.join(dir, 'codex-home'), ...opts });
  store.update(s => { s.owner = hashPassword('long enough'); s.generation = 1; s.lang = 'ja'; s.companyId = 'c1'; s.companyPrefix = 'ACM'; s.secretaryId = 'a1'; s.done = true; });
  const port = await listen(server); core.setLauncherPort(port);
  const cookie = issueCookie(store.secret, 1).split(';')[0];
  return { port, cookie, core, store, dir, stateFile: path.join(dir, 'aioffice', 'state.json'), close: () => { server.close(); core.srv.close(); } };
}
// 起動係の console.log を集める（URL がログに出ないことを見る）
function captureLog() { const lines = [], orig = console.log; console.log = (...a) => { lines.push(a.join(' ')); }; return { lines, restore: () => { console.log = orig; } }; }

test('保存: 形の合わない URL は 400 で本体に何も渡さない（http・別の名前・query・改行）', async () => {
  const L = await launcher();
  try {
    for (const url of [URL1.replace('https', 'http'), 'https://hooks.slack.com.evil.example/services/A/B/C', `${URL1}?x=1`, `${URL1}\n`, 'not a url']) {
      const r = await req(L.port, 'POST', '/setup/api/slack', { body: { companyId: 'c1', url }, cookie: L.cookie });
      assert.equal(r.status, 400); assert.equal(r.json.error, 'slack_url_bad');
      assert.ok(!r.text.includes(PARTS(URL1)[2]));
    }
    assert.equal(L.core.calls.length, 0, '本体を呼ばない');
    assert.equal((await req(L.port, 'POST', '/setup/api/slack', { body: { companyId: 'c1', url: URL1 } })).status, 401, 'cookie なし');
  } finally { L.close(); }
});

test('保存: 秘密に入れ、設定は slack.webhook だけを替えて stuckIdleMin を残し、指紋を state に覚え、URL はどこにも置かない', async () => {
  const L = await launcher(); const log = captureLog();
  try {
    const r = await req(L.port, 'POST', '/setup/api/slack', { body: { companyId: 'c1', url: URL1 }, cookie: L.cookie });
    assert.equal(r.status, 200); assert.equal(r.json.saved.masked, MASKED_DEST); assert.ok(r.json.saved.savedAt);
    for (const p of PARTS(URL1)) assert.ok(!r.text.includes(p), '返事に URL の段が無い');
    const sid = [...L.core.secrets.keys()][0];
    assert.equal(L.core.secrets.get(sid), URL1, '秘密の値');
    assert.deepEqual(L.core.configs.get('c1'), { stuckIdleMin: 5, slack: { webhook: { type: 'secret_ref', secretId: sid } } });
    // 本体の plugin の口の body に URL を一度も載せない
    for (const c of L.core.calls.filter(c => c.path.startsWith('/api/plugins/'))) assert.ok(!JSON.stringify(c).includes(PARTS(URL1)[2]), c.path);
    const raw = fs.readFileSync(L.stateFile, 'utf8');
    for (const p of PARTS(URL1)) assert.ok(!raw.includes(p), 'state.json に URL が無い');
    assert.equal(JSON.parse(raw).slack.c1.fp, destFingerprint(URL1));
    const st = await req(L.port, 'GET', '/setup/api/state', { cookie: L.cookie });
    assert.deepEqual(Object.keys(st.json.slack.c1), ['savedAt']);
    for (const p of PARTS(URL1)) assert.ok(!st.text.includes(p));
    // 入れ直しは同じ秘密の値を替え、指紋が替わる
    await req(L.port, 'POST', '/setup/api/slack', { body: { companyId: 'c1', url: URL2 }, cookie: L.cookie });
    assert.equal(L.core.secrets.size, 1); assert.equal(L.core.secrets.get(sid), URL2);
    assert.equal(JSON.parse(fs.readFileSync(L.stateFile, 'utf8')).slack.c1.fp, destFingerprint(URL2));
    // 知らない会社は秘密の口を呼ぶ前に断る（P8: 本体に 4xx を起こさない）
    const n = L.core.calls.length;
    assert.equal((await req(L.port, 'POST', '/setup/api/slack', { body: { companyId: 'zz9', url: URL1 }, cookie: L.cookie })).status, 404, '本体の 403（ログインのある形）');
    assert.equal((await req(L.port, 'POST', '/setup/api/slack', { body: { companyId: 'zz8', url: URL1 }, cookie: L.cookie })).status, 404, '本体の 404');
    assert.ok(!L.core.calls.slice(n).some(c => c.path.includes('/secrets')));
    for (const line of log.lines) for (const p of [...PARTS(URL1), ...PARTS(URL2)]) assert.ok(!line.includes(p), 'ログに URL が無い');
  } finally { log.restore(); L.close(); }
});

test('消す: worker を OFF にし、設定から参照を外して stuckIdleMin を残し、秘密と覚えた指紋を消す', async () => {
  const L = await launcher();
  try {
    await req(L.port, 'POST', '/setup/api/slack', { body: { companyId: 'c1', url: URL1 }, cookie: L.cookie });
    const r = await req(L.port, 'POST', '/setup/api/slack', { body: { companyId: 'c1', remove: true }, cookie: L.cookie });
    assert.equal(r.status, 200); assert.equal(r.json.saved, null);
    assert.ok(L.core.calls.some(c => c.path === '/api/plugins/aioffice.notify/api/slack/off' && c.query.companyId === 'c1'));
    assert.deepEqual(L.core.configs.get('c1'), { stuckIdleMin: 5 });
    assert.equal(L.core.secrets.size, 0);
    assert.equal(JSON.parse(fs.readFileSync(L.stateFile, 'utf8')).slack.c1, undefined);
  } finally { L.close(); }
});

test('見本: 言語と office の URL を起動係が足して知らせの plugin へ渡す・宛先の無い会社は 409', async () => {
  const L = await launcher();
  try {
    assert.equal((await req(L.port, 'GET', '/setup/api/slack/preview?companyId=c1&kinds=digest&form=titles', { cookie: L.cookie })).json.error, 'slack_no_dest');
    await req(L.port, 'POST', '/setup/api/slack', { body: { companyId: 'c1', url: URL1 }, cookie: L.cookie });
    const r = await req(L.port, 'GET', '/setup/api/slack/preview?companyId=c1&kinds=digest,approval&form=titles&lang=en&officeUrl=http://evil.example/', { cookie: L.cookie });
    assert.equal(r.status, 200); assert.equal(r.json.hash, HASH);
    const c = L.core.calls.find(x => x.path.endsWith('/slack/preview'));
    assert.deepEqual(c.query, { companyId: 'c1', kinds: 'digest,approval', form: 'titles', lang: 'ja', officeUrl: `http://127.0.0.1:${L.port}/ACM/office` }, '画面の lang・officeUrl は使わない');
    assert.equal((await req(L.port, 'GET', '/setup/api/slack/preview?companyId=c1&kinds=<x>&form=titles', { cookie: L.cookie })).status, 400);
    assert.equal((await req(L.port, 'GET', '/setup/api/slack/preview?companyId=c1&kinds=digest&form=titles')).status, 401);
  } finally { L.close(); }
});

test('confirm: cookie なしは 401・覚えた指紋の無い会社は断る・nonce は一度だけ通り、照合の口の答えに覚えた指紋が入り、confirm の body に指紋が無い', async () => {
  const L = await launcher();
  try {
    const body = { companyId: 'c1', kinds: ['digest'], form: 'titles', previewHash: HASH };
    assert.equal((await req(L.port, 'POST', '/setup/api/slack/confirm', { body })).status, 401);
    const r0 = await req(L.port, 'POST', '/setup/api/slack/confirm', { body, cookie: L.cookie });
    assert.equal(r0.status, 409); assert.equal(r0.json.error, 'slack_no_dest');
    assert.ok(!L.core.calls.some(c => c.path.endsWith('/slack/confirm')));
    await req(L.port, 'POST', '/setup/api/slack', { body: { companyId: 'c1', url: URL1 }, cookie: L.cookie });
    const r = await req(L.port, 'POST', '/setup/api/slack/confirm', { body, cookie: L.cookie });
    assert.equal(r.status, 200, JSON.stringify(r.json)); assert.equal(r.json.on, true);
    assert.equal(L.core.verifyResults[0].status, 200); assert.equal(L.core.verifyResults[0].body.fp, destFingerprint(URL1));
    assert.equal(L.core.verifyResults[0].again, 403, '一度だけ');
    const sent = L.core.calls.find(c => c.path.endsWith('/slack/confirm'));
    assert.match(sent.body.nonce, /^[0-9a-f]{64}$/);
    assert.equal(sent.body.lang, 'ja'); assert.equal(sent.body.officeUrl, `http://127.0.0.1:${L.port}/ACM/office`);
    assert.ok(!('fp' in sent.body) && !JSON.stringify(sent.body).includes(destFingerprint(URL1)), 'confirm の body に指紋を載せない');
    assert.ok(!r.text.includes(sent.body.nonce), '画面に nonce を返さない');
    // 別の会社・別の hash では通らない（その会社の覚えた指紋を返さない）
    const direct = await fetch(`http://127.0.0.1:${L.port}/setup/internal/slack-nonce`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ nonce: 'f'.repeat(64), companyId: 'c1', previewHash: HASH }) });
    assert.equal(direct.status, 403); assert.ok(!(await direct.text()).includes(destFingerprint(URL1)));
    assert.equal((await fetch(`http://127.0.0.1:${L.port}/setup/internal/slack-nonce`)).status, 403, 'GET は 403');
  } finally { L.close(); }
});

test('confirm: nonce は 2 分で切れる', async () => {
  const L = await launcher();
  const real = Date.now;
  try {
    await req(L.port, 'POST', '/setup/api/slack', { body: { companyId: 'c1', url: URL1 }, cookie: L.cookie });
    L.core.setBeforeVerify(() => { const base = real(); Date.now = () => base + SLACK_NONCE_MS + 1; });
    const r = await req(L.port, 'POST', '/setup/api/slack/confirm', { body: { companyId: 'c1', kinds: ['digest'], form: 'titles', previewHash: HASH }, cookie: L.cookie });
    Date.now = real;
    assert.equal(L.core.verifyResults[0].status, 403); assert.equal(r.status, 403); assert.equal(r.json.error, 'slack_not_owner');
    assert.equal(SLACK_NONCE_MS, 120_000);
  } finally { Date.now = real; L.close(); }
});

test('confirm: nonce は作った会社と見本の hash に結ぶ（別の会社・別の hash で照らすと 403 で、覚えた指紋を返さない）', async () => {
  const L = await launcher();
  try {
    await req(L.port, 'POST', '/setup/api/slack', { body: { companyId: 'c1', url: URL1 }, cookie: L.cookie });
    const body = { companyId: 'c1', kinds: ['digest'], form: 'titles', previewHash: HASH };
    L.core.setVerifyTamper({ companyId: 'c2' });
    assert.equal((await req(L.port, 'POST', '/setup/api/slack/confirm', { body, cookie: L.cookie })).status, 403);
    L.core.setVerifyTamper({ previewHash: 'b'.repeat(32) });
    assert.equal((await req(L.port, 'POST', '/setup/api/slack/confirm', { body, cookie: L.cookie })).status, 403);
    assert.deepEqual(L.core.verifyResults.map(v => v.status), [403, 403]);
    assert.ok(L.core.verifyResults.every(v => !JSON.stringify(v.body).includes(destFingerprint(URL1))));
    L.core.setVerifyTamper(null);
    assert.equal((await req(L.port, 'POST', '/setup/api/slack/confirm', { body, cookie: L.cookie })).status, 200, '合っていれば通る');
  } finally { L.close(); }
});

test('起動係が 3100 以外の port で動く時は、Slack の保存と ON（nonce の発行）を断る・消すのは通す・欄は slack_port を受ける', async () => {
  const L = await launcher({ port: 3200 });
  try {
    const s = await req(L.port, 'POST', '/setup/api/slack', { body: { companyId: 'c1', url: URL1 }, cookie: L.cookie });
    assert.deepEqual([s.status, s.json.error], [409, 'slack_port']);
    assert.equal(L.core.secrets.size, 0, '秘密を作らない');
    L.store.update(x => { x.slack = { c1: { fp: destFingerprint(URL1), secretId: null, savedAt: 'x' } }; }); // 前に 3100 で保存した宛先があっても
    const c = await req(L.port, 'POST', '/setup/api/slack/confirm', { body: { companyId: 'c1', kinds: ['digest'], form: 'titles', previewHash: HASH }, cookie: L.cookie });
    assert.deepEqual([c.status, c.json.error], [409, 'slack_port']);
    assert.ok(!L.core.calls.some(x => x.path.endsWith('/slack/confirm')), 'nonce を作らず worker の confirm も呼ばない');
    assert.equal(L.core.verifyResults.length, 0);
    const rm = await req(L.port, 'POST', '/setup/api/slack', { body: { companyId: 'c1', remove: true }, cookie: L.cookie });
    assert.equal(rm.status, 200, '消すのは送らない側なので通す');
  } finally { L.close(); }
  // 欄に出す英日の文は office の試験（office-slack.test.mjs の辞書）で見る
  // 本当に動く起動係は、listen する port を createLauncher に渡す
  const src = fs.readFileSync(new URL('../packages/aioffice/launcher/server.mjs', import.meta.url), 'utf8');
  assert.match(src, /const port = Number\(process\.env\.AIOFFICE_PORT \|\| 3100\);\n {2}const \{ server \} = createLauncher\(\{[\s\S]*?\n {4}port,/);
});

test('保存した宛先かを聞く口: 覚えた指紋と同じかの真偽だけを返し、指紋は返さない・GET と形の違う指紋は断る', async () => {
  const L = await launcher();
  try {
    const ask = body => fetch(`http://127.0.0.1:${L.port}/setup/internal/slack-saved`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
    assert.deepEqual(await (await ask({ companyId: 'c1', fp: destFingerprint(URL1) })).json(), { ok: true, same: false }, '保存の前は false');
    await req(L.port, 'POST', '/setup/api/slack', { body: { companyId: 'c1', url: URL1 }, cookie: L.cookie });
    const r1 = await ask({ companyId: 'c1', fp: destFingerprint(URL1) }); const t1 = await r1.text();
    assert.deepEqual(JSON.parse(t1), { ok: true, same: true });
    assert.deepEqual(await (await ask({ companyId: 'c1', fp: destFingerprint(URL2) })).json(), { ok: true, same: false });
    assert.deepEqual(await (await ask({ companyId: 'c2', fp: destFingerprint(URL1) })).json(), { ok: true, same: false }, '別の会社では false');
    const r2 = await ask({ companyId: 'c1', fp: 'zz' }); assert.equal(r2.status, 400);
    assert.ok(!(await r2.text()).includes(destFingerprint(URL1)), '覚えた指紋を返さない');
    assert.equal((await fetch(`http://127.0.0.1:${L.port}/setup/internal/slack-saved`)).status, 403, 'GET は 403');
  } finally { L.close(); }
});

test('照合の口は loopback の外から届かない', () => {
  for (const a of ['127.0.0.1', '::1', '::ffff:127.0.0.1', '127.0.0.2']) assert.equal(isLoopback(a), true, a);
  for (const a of ['172.17.0.1', '192.168.1.5', '::ffff:172.17.0.1', '10.0.0.1', '', undefined, '0.0.0.0', '1270.0.0.1']) assert.equal(isLoopback(a), false, String(a));
  const src = fs.readFileSync(new URL('../packages/aioffice/launcher/server.mjs', import.meta.url), 'utf8');
  assert.match(src, /if \(req\.method !== 'POST' \|\| !isLoopback\(req\.socket\?\.remoteAddress\)\) return send\(res, 403/);
  assert.equal([...src.matchAll(/if \(req\.method !== 'POST' \|\| !isLoopback\(req\.socket\?\.remoteAddress\)\) return send\(res, 403/g)].length, 2, '照合の口と保存した宛先かを聞く口の両方');
});

test('見回りの後に、会社ごとに送りの口を呼ぶ（見回りの口では送らない）・送りの失敗は見回りの遅れに数えない', async () => {
  const dir = tmp(), calls = [];
  const fetchFn = async (url, init = {}) => {
    const u = new URL(url); calls.push(`${init.method || 'GET'} ${u.pathname}?${u.searchParams.get('companyId') || ''}`);
    if (u.pathname === '/api/companies') return { ok: true, status: 200, json: async () => [{ id: 'c1' }, { id: 'c2' }] };
    if (u.pathname.endsWith('/tick')) return { ok: true, status: 200, json: async () => ({ v: 1 }) };
    if (u.pathname.endsWith('/deliver')) return u.searchParams.get('companyId') === 'c2' ? { ok: false, status: 502, json: async () => ({ error: 'notify_failed' }) } : { ok: true, status: 200, json: async () => ({ v: 1, sent: 1, waiting: 0, last: 'ok' }) };
    return { ok: false, status: 404, json: async () => ({}) };
  };
  const r = createRounds({ pcUrl: 'http://x', dataDir: dir, getState: () => ({ done: true, lang: 'en' }), installed: () => ['aioffice.notify'], fetchFn, now: () => Date.parse('2026-11-18T09:00:00Z') });
  const rec = await r.runOnce();
  assert.deepEqual(calls.filter(c => !c.startsWith('GET /api/companies')), ['POST /api/plugins/aioffice.notify/api/tick?c1', 'POST /api/plugins/aioffice.notify/api/tick?c2', 'POST /api/plugins/aioffice.notify/api/deliver?c1', 'POST /api/plugins/aioffice.notify/api/deliver?c2']);
  assert.equal(rec.slack.c1.sent, 1); assert.equal(rec.slack.c2.status, 502);
  assert.equal(r.status()['aioffice.notify'].lastError, null);
});

// 配る物に試験の設定が無い（範囲「確かめ方」の unit・r1 P3(5)）: e2e の偽の受け口のための --add-host と NODE_EXTRA_CA_CERTS は CI の Slack の段だけ
export const SHIPPED = ['packages/aioffice/Dockerfile', 'packages/aioffice/RUN.txt', 'README.md', 'docs/getting-started.md', 'docs/getting-started.ja.md'];
test('配る物（Dockerfile・RUN.txt・公開の README と起動の手引き）に --add-host と NODE_EXTRA_CA_CERTS が 1 つも無い・plugin の段は形の確かめの file を取り込む', () => {
  const root = new URL('../', import.meta.url);
  for (const f of SHIPPED) { const s = fs.readFileSync(new URL(f, root), 'utf8'); assert.equal((s.match(/--add-host|NODE_EXTRA_CA_CERTS/g) || []).length, 0, f); }
  const docker = fs.readFileSync(new URL('packages/aioffice/Dockerfile', root), 'utf8');
  assert.match(docker, /COPY packages\/aioffice\/launcher\/lib\/slack-url\.mjs \/src\/packages\/aioffice\/launcher\/lib\/slack-url\.mjs/);
});
