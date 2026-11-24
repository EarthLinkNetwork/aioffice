// 起動係（packages/aioffice/launcher）の試験: 守り・cookie・Codex のログインの状態機械・偽の本体での wizard の通し・日英の辞書・雛形
import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import net from 'node:net';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { fileURLToPath } from 'node:url';
import { hostAllowed, originAllowed, schemeOf, baseOf, issueCookie, readCookie, cookieValid, hashPassword, checkPassword, passwordProblem, COOKIE } from '../packages/aioffice/launcher/lib/guard.mjs';
import { parseDeviceOutput, createCodexLogin } from '../packages/aioffice/launcher/lib/codex-login.mjs';
import { DICT } from '../packages/aioffice/launcher/lib/i18n.mjs';
import { TEMPLATES, templateText } from '../packages/aioffice/launcher/lib/templates.mjs';
import { upsertCase, caseText, CASE_MARK } from '../packages/aioffice/launcher/lib/case-format.mjs';
import { BRIEF_MARK } from '../plugins/library/src/lib.mjs';
import { openStore, volumeMounted } from '../packages/aioffice/launcher/lib/state.mjs';
import { createLauncher } from '../packages/aioffice/launcher/server.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'aio-launcher-'));

test('Host は localhost・127.0.0.1・[::1] だけを通す（DNS rebinding）', () => {
  for (const h of ['localhost', 'localhost:3100', '127.0.0.1:3100', '[::1]:3100', 'LOCALHOST:3100']) assert.equal(hostAllowed(h), true, h);
  for (const h of ['evil.example:3100', '127.0.0.1.evil.example', '0.0.0.0:3100', '192.168.1.5:3100', '', undefined, 'localhost:abc']) assert.equal(hostAllowed(h), false, String(h));
});

test('状態を変える要求と WebSocket は Origin が scheme・host・port まで一致する時だけ通す（CSRF）', () => {
  const host = '127.0.0.1:3100';
  assert.equal(originAllowed({ method: 'GET', host, origin: 'http://evil.example' }), true); // 読むだけは通す
  assert.equal(originAllowed({ method: 'POST', host, origin: 'http://127.0.0.1:3100' }), true);
  assert.equal(originAllowed({ method: 'POST', host, origin: undefined }), true); // ブラウザでない手元の道具
  for (const origin of ['http://evil.example', 'http://127.0.0.1:3101', 'https://127.0.0.1:3100', 'http://localhost:3100', 'null']) assert.equal(originAllowed({ method: 'POST', host, origin }), false, origin);
  assert.equal(originAllowed({ method: 'GET', host, origin: 'http://evil.example', upgrade: true }), false);
});

test('https の前段の住所: その Host だけを通し、Origin は https だけ・招待の URL も https', () => {
  const extra = ['https://office.example.com', 'office.lan:3100'];
  assert.equal(hostAllowed('office.example.com', extra), true);
  assert.equal(hostAllowed('Office.Example.com', extra), true);
  assert.equal(hostAllowed('office.example.com:443', extra), true, ':443 を明示した Host も同じ住所');
  for (const h of ['office.example.com:3100', 'evil.example', 'office.example.com.evil.example']) assert.equal(hostAllowed(h, extra), false, h);
  assert.equal(hostAllowed('office.example.com', ['office.lan:3100']), false, 'https:// で書いていなければ通さない');
  assert.equal(originAllowed({ method: 'POST', host: 'office.example.com', origin: 'https://office.example.com', extra }), true);
  for (const origin of ['http://office.example.com', 'https://evil.example', 'null']) assert.equal(originAllowed({ method: 'POST', host: 'office.example.com', origin, extra }), false, origin);
  assert.equal(originAllowed({ method: 'POST', host: 'office.lan:3100', origin: 'http://office.lan:3100', extra }), true, 'LAN の http はそのまま');
  assert.equal(schemeOf('office.example.com', extra), 'https');
  assert.equal(schemeOf('office.example.com:443', extra), 'https');
  assert.equal(originAllowed({ method: 'POST', host: 'office.example.com:443', origin: 'https://office.example.com', extra }), true, ':443 を付けた Host でも Origin は既定の port の形');
  assert.equal(baseOf('office.example.com:443', extra), 'https://office.example.com', 'URL も :443 を外した形');
  assert.equal(baseOf('office.lan:3100', extra), 'http://office.lan:3100');
  assert.equal(schemeOf('office.lan:3100', extra), 'http');
  assert.equal(schemeOf('localhost:3100', extra), 'http');
});

test('合言葉は scrypt で持ち、長さを確かめる', () => {
  const o = hashPassword('correct horse');
  assert.equal(checkPassword('correct horse', o), true);
  assert.equal(checkPassword('wrong horse!', o), false);
  assert.equal(checkPassword('x', null), false);
  assert.equal(passwordProblem('short'), 'password_short');
  assert.equal(passwordProblem('x'.repeat(201)), 'password_long');
  assert.equal(passwordProblem(undefined), 'password_required');
  assert.equal(passwordProblem('long enough'), null);
});

test('cookie は署名・世代・30 日で確かめる', () => {
  const now = 1_800_000_000_000, sec = 'a'.repeat(64);
  const v = readCookie(issueCookie(sec, 3, now).split(';')[0]);
  assert.match(issueCookie(sec, 3, now), /HttpOnly; SameSite=Strict; Path=\//);
  assert.equal(cookieValid(sec, 3, v, now), true);
  assert.equal(cookieValid(sec, 4, v, now), false, '持ち主を登録し直すと古い cookie は通らない');
  assert.equal(cookieValid('b'.repeat(64), 3, v, now), false, '別の秘密で署名した cookie は通らない');
  assert.equal(cookieValid(sec, 3, v, now + 31 * 86400_000), false, '30 日を過ぎると通らない');
  assert.equal(cookieValid(sec, 3, v.replace(/.$/, c => (c === '0' ? '1' : '0')), now), false, '署名を変えると通らない');
  assert.equal(cookieValid(sec, 3, `${now}.3.zz`, now), false);
  assert.equal(readCookie(`a=1; ${COOKIE}=xyz; b=2`), 'xyz');
});

// 偽の codex: spawn の代わりに出力と終わり方を外から決める
function fakeSpawn({ hang = false } = {}) {
  const procs = [];
  // kill されたら少し後で exit する（hang の時は exit しない・終わりの遅い process の代わり）
  const fn = (bin, args, opts) => { const p = new EventEmitter(); p.stdout = new PassThrough(); p.stderr = new PassThrough(); p.killed = false; p.exited = false; p.on('exit', () => { p.exited = true; }); p.signals = []; p.kill = sig => { p.signals.push(sig); p.killed = true; if (!hang) setTimeout(() => { if (!p.exited) p.emit('exit', null, 'SIGTERM'); }, 5); }; p.args = args; p.env = opts.env; procs.push(p); return p; };
  return { fn, procs };
}
const tick = (ms = 0) => new Promise(r => setTimeout(r, ms));

test('device login の出力から URL と code だけを取る（色の制御文字つき）', () => {
  const out = '\x1b[1mWelcome\x1b[0m\nOpen \x1b[94mhttps://auth.openai.com/codex/device\x1b[0m\nEnter code \x1b[94mAB12-CD345\x1b[0m\n';
  assert.deepEqual(parseDeviceOutput(out), { url: 'https://auth.openai.com/codex/device', code: 'AB12-CD345' });
  assert.deepEqual(parseDeviceOutput('nothing'), { url: null, code: null });
});

test('Codex のログインは 1 本だけ: 二度押しは同じ code・やり直しは前の終わりを待つ・期限・成功・未導入', async () => {
  const home = tmp(); let t = 0; const sp = fakeSpawn();
  const c = createCodexLogin({ codexBin: 'codex', codexHome: home, ttlMs: 400, now: () => t, spawnFn: sp.fn }); // 期限は本物のタイマー。負荷の高い時に 60ms では途中で expired になった（2026-11-24）
  assert.equal(c.view().state, 'idle');
  assert.equal(c.start().state, 'starting'); await tick();
  assert.deepEqual(sp.procs[0].args, ['login', '--device-auth']);
  assert.equal(sp.procs[0].env.CODEX_HOME, home);
  sp.procs[0].stdout.write('https://auth.openai.com/codex/device\nAB12-CD345\n'); await tick();
  const w = c.view(); assert.equal(w.state, 'waiting'); assert.equal(w.code, 'AB12-CD345'); assert.equal(w.remainingMs, 400);
  assert.equal(c.start().code, 'AB12-CD345'); await tick(); assert.equal(sp.procs.length, 1, '二度押しで 2 本目を起こさない');
  c.restart(); assert.equal(sp.procs[0].killed, true); assert.equal(sp.procs.length, 1, '前の process が終わる前は 2 本目を起こさない');
  await tick(20); assert.equal(sp.procs.length, 2, '前が終わってから起こす'); assert.equal(c.view().state, 'starting', '止めた古い process の終わりは今の状態を変えない');
  await tick(600);
  assert.equal(c.view().state, 'expired'); assert.equal(sp.procs[1].killed, true);
  c.restart(); await tick(20); fs.writeFileSync(path.join(home, 'auth.json'), '{"x":1}'); sp.procs[2].emit('exit', 0);
  assert.equal(c.view().state, 'done');
  assert.equal(c.cancel().state, 'done', 'つながった後の取り消しは何もしない');
  c.stop();
  const c2 = createCodexLogin({ codexHome: tmp(), spawnFn: sp.fn }); c2.start(); await tick(); sp.procs.at(-1).emit('error', Object.assign(new Error('x'), { code: 'ENOENT' }));
  assert.deepEqual([c2.view().state, c2.view().error], ['failed', 'codex_missing']); c2.stop();
  const c4 = createCodexLogin({ codexHome: tmp(), ttlMs: 20, spawnFn: sp.fn }); c4.start(); await tick(); sp.procs.at(-1).emit('error', Object.assign(new Error('x'), { code: 'ENOENT' }));
  await tick(50); assert.equal(c4.view().error, 'codex_missing', '未導入の失敗を期限切れで上書きしない'); assert.equal(c4.view().state, 'failed');
  const c3 = createCodexLogin({ codexHome: tmp(), spawnFn: sp.fn }); c3.start(); await tick(); sp.procs.at(-1).emit('exit', 1);
  assert.deepEqual([c3.view().state, c3.view().error], ['failed', 'login_failed']); c3.stop();
  assert.equal(createCodexLogin({ codexHome: home, spawnFn: sp.fn }).view().state, 'done', 'auth.json があれば最初から done');
});

test('終わりの遅い process: やり直しを何度押しても、前が終わるまで 2 本目を起こさない', async () => {
  const sp = fakeSpawn({ hang: true });
  const c = createCodexLogin({ codexHome: tmp(), spawnFn: sp.fn });
  c.start(); await tick(); assert.equal(sp.procs.length, 1);
  c.restart(); c.restart(); c.restart(); await tick(30);
  assert.equal(sp.procs.length, 1, '前の process が終わっていないので起こさない');
  sp.procs[0].emit('exit', null, 'SIGTERM'); await tick(10);
  assert.equal(sp.procs.length, 2, '前が終わったら最後の 1 回分だけ起こす');
  assert.equal(sp.procs.filter(p => !p.exited).length, 1, '動いている process は 1 本');
  c.stop(); sp.procs[1].emit('exit', null, 'SIGTERM');
});

test('日英の辞書は key が同じで、英語の欄に日本語が無く、画面が使う key が全部ある', () => {
  assert.deepEqual(Object.keys(DICT.ja).sort(), Object.keys(DICT.en).sort());
  const ja = /[぀-ヿ㐀-鿿！-｠　-〿]/;
  // 言語の名前（lang_ja）はその言語で書くので、英語の欄でも日本語でよい
  for (const [k, v] of Object.entries(DICT.en)) if (k !== 'lang_ja') assert.equal(ja.test(v), false, `en.${k}`);
  for (const [k, v] of Object.entries(DICT.ja)) assert.ok(v.trim(), `ja.${k}`);
  const js = fs.readFileSync(path.join(root, 'packages/aioffice/launcher/public/setup.js'), 'utf8');
  const used = new Set([...js.matchAll(/\bt\('([a-z_]+)'\)/g)].map(m => m[1]));
  for (const s of ['lang', 'owner', 'company', 'secretary', 'codex', 'agents', 'folder', 'done']) used.add(`step_${s}`);
  for (const k of used) assert.ok(k in DICT.en, `辞書に無い key: ${k}`);
  const srv = fs.readFileSync(path.join(root, 'packages/aioffice/launcher/server.mjs'), 'utf8');
  for (const m of srv.matchAll(/error: '([a-z_]+)'/g)) if (!['not_found', 'internal', 'login_required', 'owner_exists', 'too_many', 'name_required', 'company_first', 'secretary_first', 'not_ready', 'setup_not_done'].includes(m[1])) assert.ok(m[1] in DICT.en, `画面に出る error の文言が無い: ${m[1]}`);
});

test('雛形は全部日英があり、秘書は必ず入る', () => {
  assert.equal(TEMPLATES.secretary.required, true);
  for (const id of Object.keys(TEMPLATES)) for (const l of ['en', 'ja']) {
    const txt = templateText(id, l); assert.ok(txt.length > 100, `${id}.${l}`);
    assert.ok(TEMPLATES[id].name[l] && TEMPLATES[id].title[l]);
    if (l === 'en') assert.equal(/[぀-ヿ㐀-鿿]/.test(txt), false, `${id}.en に日本語`);
    // 図書室の添え書きの読み方（データで指示ではない・消さない）が全部の雛形にある（範囲の文書の保証 14）
    assert.ok(txt.includes(BRIEF_MARK), `${id}.${l} に添え書きの印`);
    assert.equal(txt.split(l === 'en' ? '\n## Library\n' : '\n## 図書室\n').length, 2, `${id}.${l} に図書室の節がちょうど 1 つ`);
  }
  assert.throws(() => templateText('nope', 'en'));
});

test('持ち主の登録を消すと世代が上がり、前の cookie が通らなくなる', () => {
  const st = openStore(tmp());
  st.update(s => { s.owner = hashPassword('long enough'); s.generation = 1; });
  const v = readCookie(issueCookie(st.secret, 1).split(';')[0]);
  assert.equal(cookieValid(st.secret, st.get().generation, v), true);
  st.resetOwner();
  assert.equal(st.get().owner, null); assert.equal(cookieValid(st.secret, st.get().generation, v), false);
});

test('別の process（aioffice-reset-owner）が持ち主を消すと、動いている起動係もそれを読む', () => {
  const dir = tmp(), running = openStore(dir);
  running.update(s => { s.owner = hashPassword('long enough'); s.generation = 1; s.companyId = 'c1'; });
  assert.ok(running.get().owner);
  openStore(dir).resetOwner(); // docker exec で動く別の process
  assert.equal(running.get().owner, null); assert.equal(running.get().generation, 2); assert.equal(running.get().companyId, 'c1', '会社は残る');
});

// 偽の本体（Paperclip）: 会社と担当を覚え、指示書の置き場を返す
function fakePaperclip(dir, { delayMs = 0 } = {}) {
  const calls = [], companies = [], agents = [], sse = new Set(), holds = [];
  const srv = http.createServer((req, res) => {
    let b = ''; req.on('data', c => { b += c; }); req.on('end', () => {
      calls.push({ method: req.method, url: req.url, host: req.headers.host, body: b ? JSON.parse(b) : null });
      const json = (s, o) => { res.writeHead(s, { 'content-type': 'application/json' }); res.end(JSON.stringify(o)); };
      if (req.url === '/sse') { res.writeHead(200, { 'content-type': 'text/event-stream' }); res.write('data: hi\n\n'); sse.add(res); res.on('close', () => sse.delete(res)); return; }
      if (req.method === 'POST' && req.url === '/api/companies') { const c = { id: `c${companies.length + 1}`, name: JSON.parse(b).name, issuePrefix: 'ACM' }; companies.push(c); return setTimeout(() => json(201, c), delayMs); }
      const m = req.url.match(/^\/api\/companies\/([^/]+)\/agents$/);
      if (req.method === 'POST' && m) { const a = { id: `a${agents.length + 1}`, ...JSON.parse(b), adapterConfig: { ...JSON.parse(b).adapterConfig, instructionsFilePath: path.join(dir, `a${agents.length + 1}`, 'AGENTS.md') } }; agents.push(a); return setTimeout(() => json(201, a), delayMs); }
      // 判断の書き方を揃える口（launcher/lib/case-format.mjs）: 会社と担当の一覧・指示書の読み書き（置き場は instructionsFilePath と同じファイル）
      if (req.method === 'GET' && req.url === '/api/companies') return json(200, companies);
      if (req.method === 'GET' && m) return json(200, agents.filter(a => !m[1] || companies.some(c => c.id === m[1])));
      const f = req.url.match(/^\/api\/agents\/([^/]+)\/instructions-bundle\/file(\?path=AGENTS\.md)?$/), fa = f && agents.find(a => a.id === f[1]);
      if (f && fa && req.method === 'GET') { try { return json(200, { content: fs.readFileSync(fa.adapterConfig.instructionsFilePath, 'utf8') }); } catch { return json(404, { error: 'nf' }); } }
      if (f && fa && req.method === 'PUT') { fs.writeFileSync(fa.adapterConfig.instructionsFilePath, JSON.parse(b).content); return json(200, {}); }
      if (req.url === '/hello') return json(200, { from: 'paperclip' });
      if (req.url === '/hold') return holds.push(() => json(200, { held: true })); // 書き込みの関所の試験: 放すまで返さない
      // 本体が版上げで CORS の header を返し始めた時の形（範囲の保証 8 の否定の試験）
      if (req.url === '/cors') { res.writeHead(200, { 'content-type': 'application/json', 'access-control-allow-origin': '*', 'Access-Control-Allow-Credentials': 'true', 'access-control-expose-headers': 'x-a' }); return res.end('{}'); }
      return json(404, { error: 'nope' });
    });
  });
  srv.on('upgrade', (req, socket) => { socket.end('HTTP/1.1 101 Switching Protocols\r\nupgrade: websocket\r\nconnection: Upgrade\r\n\r\n'); });
  return { srv, calls, companies, agents, sse, holds };
}

const listen = srv => new Promise(r => srv.listen(0, '127.0.0.1', () => r(srv.address().port)));
function req(port, method, p, { body, cookie, host = `127.0.0.1:${port}`, origin } = {}) {
  return new Promise((resolve, reject) => {
    const headers = { host }; if (cookie) headers.cookie = cookie; if (origin) headers.origin = origin;
    const data = body == null ? null : JSON.stringify(body); if (data) { headers['content-type'] = 'application/json'; headers['content-length'] = Buffer.byteLength(data); }
    const r = http.request({ host: '127.0.0.1', port, method, path: p, headers }, res => { let t = ''; res.on('data', c => { t += c; }); res.on('end', () => { let j = null; try { j = JSON.parse(t); } catch { /* 文字 */ } resolve({ status: res.statusCode, headers: res.headers, json: j, text: t }); }); });
    r.on('error', reject); if (data) r.write(data); r.end();
  });
}
function upgrade(port, { cookie, origin } = {}) {
  return new Promise(resolve => {
    const s = net.connect(port, '127.0.0.1', () => s.write(`GET /ws HTTP/1.1\r\nhost: 127.0.0.1:${port}\r\nupgrade: websocket\r\nconnection: Upgrade\r\nsec-websocket-version: 13\r\nsec-websocket-key: dGhlIHNhbXBsZSBub25jZQ==\r\n${origin ? `origin: ${origin}\r\n` : ''}${cookie ? `cookie: ${cookie}\r\n` : ''}\r\n`));
    let t = ''; s.on('data', d => { t += d; if (t.includes('\r\n\r\n')) { s.destroy(); resolve(t.split('\r\n')[0]); } }); s.on('error', () => resolve(t.split('\r\n')[0]));
  });
}

test('wizard の通し（偽の本体）: 守り → 言語 → 持ち主 → 会社 → 秘書 → 担当 → 完了 → 本体へ中継', async () => {
  const dir = tmp(), pc = fakePaperclip(dir), pcPort = await listen(pc.srv), sp = fakeSpawn();
  const { server, store } = createLauncher({ dataDir: path.join(dir, 'aioffice'), paperclipUrl: `http://127.0.0.1:${pcPort}`, codexHome: path.join(dir, 'codex-home'), spawnFn: sp.fn });
  const port = await listen(server), me = `http://127.0.0.1:${port}`;
  try {
    assert.equal((await req(port, 'GET', '/setup/api/state', { host: 'evil.example:3100' })).status, 403, '外の Host は断る');
    assert.equal((await req(port, 'POST', '/setup/api/owner', { body: { password: 'long enough' }, origin: 'http://evil.example' })).status, 403, '外の Origin の POST は断る');
    assert.equal((await req(port, 'GET', '/')).headers.location, '/setup/', '準備の前は wizard へ');
    const html = await req(port, 'GET', '/setup/'); assert.equal(html.status, 200); assert.match(html.text, /setup\.js/); assert.equal(html.headers['x-frame-options'], 'DENY');

    let s = (await req(port, 'GET', '/setup/api/state')).json;
    assert.deepEqual([s.lang, s.langSet, s.hasOwner, s.authed], ['en', false, false, false], '既定は英語・まだ選んでいない');
    s = (await req(port, 'POST', '/setup/api/lang', { body: { lang: 'ja' }, origin: me })).json; assert.deepEqual([s.lang, s.langSet], ['ja', true]);
    assert.equal((await req(port, 'POST', '/setup/api/company', { body: { name: 'X' }, origin: me })).status, 401, '持ち主の前は会社を作れない');
    assert.equal((await req(port, 'POST', '/setup/api/owner', { body: { password: 'short' }, origin: me })).json.error, 'password_short');
    const own = await req(port, 'POST', '/setup/api/owner', { body: { password: 'long enough' }, origin: me });
    assert.equal(own.status, 200); const cookie = own.headers['set-cookie'][0].split(';')[0];
    assert.equal((await req(port, 'POST', '/setup/api/owner', { body: { password: 'someone else' } })).status, 409, '持ち主の登録は 1 回だけ');
    assert.equal((await req(port, 'POST', '/setup/api/lang', { body: { lang: 'en' } })).status, 401, '登録の後は cookie なしで言語を変えられない');
    assert.equal((await req(port, 'GET', '/setup/api/state')).json.company, undefined, 'cookie なしには中身を見せない');
    assert.equal((await req(port, 'POST', '/setup/api/login', { body: { password: 'wrong one!' } })).status, 401);
    const login = await req(port, 'POST', '/setup/api/login', { body: { password: 'long enough' } }); assert.equal(login.status, 200);

    assert.equal((await req(port, 'POST', '/setup/api/secretary', { body: {}, cookie })).status, 409, '会社が先');
    assert.equal((await req(port, 'POST', '/setup/api/company', { body: { name: '  ' }, cookie })).json.error, 'name_required');
    s = (await req(port, 'POST', '/setup/api/company', { body: { name: 'Acme\u0007 Co' }, cookie })).json;
    assert.deepEqual(s.company, { id: 'c1', name: 'Acme Co', prefix: 'ACM' });
    await req(port, 'POST', '/setup/api/company', { body: { name: 'Again' }, cookie }); assert.equal(pc.companies.length, 1, 'あれば使う（2 社目を作らない）');
    s = (await req(port, 'POST', '/setup/api/secretary', { body: { name: '' }, cookie })).json;
    assert.equal(s.secretaryId, 'a1'); assert.equal(pc.agents[0].name, '秘書'); assert.equal(pc.agents[0].adapterType, 'codex_local'); assert.equal(pc.agents[0].adapterConfig.engine, 'cli', '担当は CLI の経路');
    assert.equal(fs.readFileSync(pc.agents[0].adapterConfig.instructionsFilePath, 'utf8'), upsertCase(templateText('secretary', 'ja'), caseText('ja')), '秘書の指示書（日本語）を書き、判断の書き方の節を足す');
    assert.deepEqual(s.templates.map(x => x.id), ['design', 'research']);
    assert.deepEqual(s.noInstructions, [], '指示書は書けた');
    assert.equal(pc.calls.every(c => c.host === `127.0.0.1:${pcPort}`), true, '本体へは loopback の Host で呼ぶ');

    assert.equal((await req(port, 'POST', '/setup/api/codex/start', { cookie })).json.state, 'starting');
    sp.procs[0].stdout.write('https://auth.openai.com/codex/device AB12-CD345\n'); await new Promise(r => setImmediate(r));
    assert.equal((await req(port, 'GET', '/setup/api/state', { cookie })).json.codex.code, 'AB12-CD345');
    assert.equal((await req(port, 'POST', '/setup/api/codex/start')).status, 401, 'ログインの口は持ち主だけ');

    s = (await req(port, 'POST', '/setup/api/agents', { body: { ids: ['design', 'secretary', 'nope', '__proto__'] }, cookie })).json;
    assert.deepEqual(Object.keys(s.agents), ['design']); assert.equal(pc.agents.length, 2); assert.equal(pc.agents[1].name, 'デザイン課');
    await req(port, 'POST', '/setup/api/agents', { body: { ids: ['design'] }, cookie }); assert.equal(pc.agents.length, 2, '同じ担当を 2 人作らない');
    for (const a of pc.agents) assert.equal(fs.readFileSync(a.adapterConfig.instructionsFilePath, 'utf8').split(CASE_MARK.begin).length - 1, 1, `${a.name}: 担当を足す道を 2 回たどっても、判断の書き方の節は 1 回だけ`);

    assert.equal((await req(port, 'GET', '/hello', { cookie })).status, 302, '完了の前は本体へ通さない');
    assert.equal((await upgrade(port, { cookie })).includes('401'), true, '完了の前は WebSocket も通さない');
    assert.equal((await req(port, 'POST', '/setup/api/finish', { cookie })).json.done, true);
    assert.deepEqual((await req(port, 'GET', '/hello', { cookie })).json, { from: 'paperclip' }, '完了の後は本体へ中継');
    const cors = await req(port, 'GET', '/cors', { cookie, origin: 'http://127.0.0.1:9999' });
    assert.equal(cors.status, 200);
    assert.deepEqual(Object.keys(cors.headers).filter(k => k.startsWith('access-control-')), [], '本体の access-control-* は中継で落とす');
    assert.equal((await req(port, 'GET', '/hello')).status, 302, 'cookie なしは本体へ通さない');
    assert.equal((await req(port, 'POST', '/hello', { body: {} })).status, 401);
    assert.equal((await req(port, 'POST', '/hello', { body: {}, cookie, origin: 'http://evil.example' })).status, 403, '本体への POST も Origin を確かめる');
    assert.match(await upgrade(port, { cookie, origin: me }), /101/, 'WebSocket は持ち主で同じ Origin なら本体へ');
    assert.match(await upgrade(port, { cookie, origin: 'http://evil.example' }), /403/, '外の Origin の WebSocket は断る');
    assert.match(await upgrade(port, { origin: me }), /401/, 'cookie なしの WebSocket は断る');

    store.resetOwner();
    assert.equal((await req(port, 'GET', '/hello', { cookie })).status, 302, '持ち主を消すと前の cookie は通らない');
    assert.equal(fs.statSync(path.join(dir, 'aioffice', 'secret')).mode & 0o777, 0o600);
  } finally { server.close(); pc.srv.close(); }
});

test('合言葉の失敗は 10 分で 10 回まで', async () => {
  const dir = tmp(), pc = fakePaperclip(dir), pcPort = await listen(pc.srv);
  const { server } = createLauncher({ dataDir: path.join(dir, 'aioffice'), paperclipUrl: `http://127.0.0.1:${pcPort}`, codexHome: path.join(dir, 'codex-home'), spawnFn: fakeSpawn().fn });
  const port = await listen(server);
  try {
    await req(port, 'POST', '/setup/api/owner', { body: { password: 'long enough' } });
    for (let i = 0; i < 10; i++) assert.equal((await req(port, 'POST', '/setup/api/login', { body: { password: `bad ${i}` } })).status, 401);
    assert.equal((await req(port, 'POST', '/setup/api/login', { body: { password: 'long enough' } })).status, 429, '11 回目は正しくても断る');
  } finally { server.close(); pc.srv.close(); }
});

test('/data の volume: 名前つきだけを「つながっている」とし、名前なし・無しは警告に回す', () => {
  const f = path.join(tmp(), 'mountinfo'), line = (root, at) => `1021 1012 0:36 ${root} ${at} rw,noatime master:66 - btrfs /dev/vdb1 rw`;
  fs.writeFileSync(f, [line('/', '/'), line('/docker/volumes/aioffice/_data', '/data')].join('\n')); assert.equal(volumeMounted('/data', f), true);
  fs.writeFileSync(f, [line('/', '/'), line(`/docker/volumes/${'ab12'.repeat(16)}/_data`, '/data')].join('\n')); assert.equal(volumeMounted('/data', f), false, '名前なしの volume');
  fs.writeFileSync(f, line('/', '/')); assert.equal(volumeMounted('/data', f), false, 'volume が無い');
  assert.equal(volumeMounted('/data', path.join(tmp(), 'none')), null, 'Linux でない');
});

// 準備を済ませた起動係を作る（cookie つき）
async function readyLauncher(opts = {}) {
  const dir = tmp(), pc = fakePaperclip(dir, opts), pcPort = await listen(pc.srv);
  const { server, store } = createLauncher({ dataDir: path.join(dir, 'aioffice'), paperclipUrl: `http://127.0.0.1:${pcPort}`, codexHome: path.join(dir, 'codex-home'), spawnFn: fakeSpawn().fn, ...(opts.gate ? { gate: opts.gate } : {}) });
  const port = await listen(server);
  const own = await req(port, 'POST', '/setup/api/owner', { body: { password: 'long enough' } });
  return { dir, pc, server, store, port, cookie: own.headers['set-cookie'][0].split(';')[0], close: () => { server.close(); pc.srv.close(); } };
}

test('壊れた住所（GET //[）・中身が null の POST でも落ちずに 400 を返す', { timeout: 5000 }, async () => {
  const L = await readyLauncher();
  try {
    assert.equal((await req(L.port, 'GET', '//[')).status, 400);
    assert.equal((await req(L.port, 'GET', '/setup/api/state')).status, 200, '起動係は生きている');
    for (const raw of ['null', '[]', '3', '"x"', '{bad']) {
      const r = await new Promise(resolve => { const q = http.request({ host: '127.0.0.1', port: L.port, method: 'POST', path: '/setup/api/company', headers: { host: `127.0.0.1:${L.port}`, cookie: L.cookie, 'content-type': 'application/json' } }, x => { x.resume(); x.on('end', () => resolve(x.statusCode)); }); q.end(raw); });
      assert.equal(r, 400, raw);
    }
  } finally { L.close(); L.server.closeAllConnections?.(); }
});

test('作る途中の二度呼びで会社・秘書・担当を 2 つ作らない', { timeout: 5000 }, async () => {
  const L = await readyLauncher({ delayMs: 80 }); const { port, cookie, pc } = L;
  try {
    await Promise.all([1, 2, 3].map(() => req(port, 'POST', '/setup/api/company', { body: { name: 'A' }, cookie })));
    assert.equal(pc.companies.length, 1);
    await Promise.all([1, 2, 3].map(() => req(port, 'POST', '/setup/api/secretary', { body: {}, cookie })));
    assert.equal(pc.agents.length, 1);
    await Promise.all([1, 2].map(() => req(port, 'POST', '/setup/api/agents', { body: { ids: ['design'] }, cookie })));
    assert.equal(pc.agents.length, 2);
  } finally { L.close(); L.server.closeAllConnections?.(); }
});

test('中継: ブラウザが切ると本体への接続も切る（SSE が溜まらない）', { timeout: 5000 }, async () => {
  const L = await readyLauncher(); const { port, cookie, pc } = L;
  try {
    await req(port, 'POST', '/setup/api/company', { body: { name: 'A' }, cookie });
    await req(port, 'POST', '/setup/api/secretary', { body: {}, cookie });
    await req(port, 'POST', '/setup/api/finish', { cookie });
    for (let i = 0; i < 5; i++) await new Promise(resolve => {
      const q = http.request({ host: '127.0.0.1', port, path: '/sse', headers: { host: `127.0.0.1:${port}`, cookie } }, x => x.once('data', () => { q.destroy(); resolve(); }));
      q.end();
    });
    await new Promise(r => setTimeout(r, 100));
    assert.equal(pc.sse.size, 0, '本体側の SSE の接続が残っていない');
  } finally { L.close(); L.server.closeAllConnections?.(); }
});

test('指示書を書けなかった担当は、作ったまま覚え、完了の画面で知らせる', { timeout: 5000 }, async () => {
  const L = await readyLauncher(); const { port, cookie, pc } = L;
  try {
    await req(port, 'POST', '/setup/api/company', { body: { name: 'A' }, cookie });
    fs.writeFileSync(path.join(L.dir, 'a1'), 'not a directory'); // 置き場の親がファイルなので書けない
    const s = (await req(port, 'POST', '/setup/api/secretary', { body: {}, cookie })).json;
    assert.equal(s.secretaryId, 'a1'); assert.deepEqual(s.noInstructions, ['secretary']);
    await req(port, 'POST', '/setup/api/secretary', { body: {}, cookie }); assert.equal(pc.agents.length, 1, 'やり直しで 2 人目を作らない');
  } finally { L.close(); L.server.closeAllConnections?.(); }
});

// 断った直後に相手が RST で切る（EPIPE）。upgrade の socket は http server の error の受け手から外れるので、受け手が無いと process ごと落ちる
test('WebSocket の upgrade を断った直後に切られても落ちない（403・401 の両方）', { timeout: 20000 }, async () => {
  const dir = tmp();
  const { server } = createLauncher({ dataDir: path.join(dir, 'aioffice'), paperclipUrl: 'http://127.0.0.1:1', codexHome: path.join(dir, 'ch'), spawnFn: fakeSpawn().fn });
  const crashes = []; const onCrash = e => crashes.push(e.code || e.message); process.on('uncaughtException', onCrash);
  const port = await listen(server);
  try {
    for (const host of ['evil.example', `127.0.0.1:${port}`]) // 403（Host）と 401（cookie が無い）
      for (let i = 0; i < 500; i++) await new Promise(r => { const s = net.connect(port, '127.0.0.1', () => { s.write(`GET /x HTTP/1.1\r\nHost: ${host}\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n\r\n`); s.resetAndDestroy(); r(); }); s.on('error', () => r()); });
    await new Promise(r => setTimeout(r, 300));
    assert.deepEqual(crashes, []);
    assert.equal((await req(port, 'GET', '/setup/api/state')).status, 200, '起動係は生きている');
  } finally { process.off('uncaughtException', onCrash); server.close(); server.closeAllConnections?.(); }
});

test('spawn がその場で投げても（E2BIG など）process を落とさず failed にする', async () => {
  const c = createCodexLogin({ codexHome: tmp(), spawnFn: () => { throw Object.assign(new Error('x'), { code: 'E2BIG' }); } });
  assert.equal(c.start().state, 'starting'); await tick(10);
  assert.deepEqual([c.view().state, c.view().error, c.view().running], ['failed', 'spawn_failed', false]);
});

test('SIGKILL の後も終わりの知らせが来なければ、2 本目を起こさず失敗にする（codex の指摘）', async () => {
  const sp = fakeSpawn({ hang: true });
  const c = createCodexLogin({ codexHome: tmp(), spawnFn: sp.fn, killWaitMs: 10, giveUpMs: 60 });
  c.start(); await tick();
  c.restart(); await tick(120);
  assert.deepEqual(sp.procs[0].signals, ['SIGTERM', 'SIGKILL'], 'SIGTERM の後に SIGKILL を送った');
  assert.equal(sp.procs.length, 1, '終わりを確かめていないので 2 本目を起こさない');
  assert.deepEqual([c.view().state, c.view().error], ['failed', 'stop_timeout']);
  c.restart(); await tick(20); assert.equal(sp.procs.length, 1, '押し直しても、前の終わりを待つ');
  sp.procs[0].emit('exit', null, 'SIGKILL'); await tick(10);
  assert.equal(sp.procs.length, 2, '終わりの知らせが来たら起こす'); assert.equal(c.view().state, 'starting');
  c.stop(); sp.procs[1].emit('exit', null, 'SIGTERM');
});

test('失敗にした後で遅れて終わりの知らせが来ても、押し直すまでは起こさない（独立レビュー r5 P3-1）', async () => {
  const sp = fakeSpawn({ hang: true });
  const c = createCodexLogin({ codexHome: tmp(), spawnFn: sp.fn, killWaitMs: 10, giveUpMs: 60 });
  c.start(); await tick();
  c.restart(); await tick(120);
  assert.deepEqual([c.view().state, c.view().error], ['failed', 'stop_timeout']);
  sp.procs[0].emit('exit', null, 'SIGKILL'); await tick(20);
  assert.equal(sp.procs.length, 1, '失敗を見せたまま裏で起こさない');
  assert.deepEqual([c.view().state, c.view().running], ['failed', false]);
});

test('中継の書き込みは関所を通る: 同時 2 本の関所で 3 本目は本体に届かず、1 本終わると届く・読みは絞らない', { timeout: 5000 }, async () => {
  const { createGate } = await import('../packages/aioffice/launcher/lib/gate.mjs');
  const L = await readyLauncher({ gate: createGate({ max: 2 }) }); const { port, cookie, pc } = L;
  try {
    await req(port, 'POST', '/setup/api/company', { body: { name: 'A' }, cookie });
    await req(port, 'POST', '/setup/api/secretary', { body: {}, cookie });
    await req(port, 'POST', '/setup/api/finish', { cookie });
    const origin = `http://127.0.0.1:${port}`;
    const ps = [1, 2, 3].map(() => req(port, 'POST', '/hold', { body: {}, cookie, origin }));
    const until = async f => { for (let i = 0; i < 100 && !f(); i++) await new Promise(r => setTimeout(r, 10)); };
    await until(() => pc.holds.length === 2); await new Promise(r => setTimeout(r, 50));
    assert.equal(pc.holds.length, 2, '3 本目は関所で待っている');
    assert.equal((await req(port, 'GET', '/hello', { cookie })).status, 200, '読みは待たない');
    pc.holds[0](); await until(() => pc.holds.length === 3);
    assert.equal(pc.holds.length, 3, '1 本終わると 3 本目が届く');
    pc.holds[1](); pc.holds[2]();
    assert.deepEqual((await Promise.all(ps)).map(r => r.status), [200, 200, 200]);
  } finally { L.close(); L.server.closeAllConnections?.(); }
});

test('関所で待っている間にブラウザが切っても枠を漏らさない（独立レビュー P1-1）', { timeout: 8000 }, async () => {
  const { createGate } = await import('../packages/aioffice/launcher/lib/gate.mjs');
  const gate = createGate({ max: 1 });
  const L = await readyLauncher({ gate }); const { port, cookie, pc } = L;
  try {
    await req(port, 'POST', '/setup/api/company', { body: { name: 'A' }, cookie });
    await req(port, 'POST', '/setup/api/secretary', { body: {}, cookie });
    await req(port, 'POST', '/setup/api/finish', { cookie });
    const origin = `http://127.0.0.1:${port}`;
    const until = async f => { for (let i = 0; i < 200 && !f(); i++) await new Promise(r => setTimeout(r, 10)); };
    const a = req(port, 'POST', '/hold', { body: {}, cookie, origin });
    await until(() => pc.holds.length === 1);
    // B: 列で待たせてから切る
    const data = '{}';
    const b = http.request({ host: '127.0.0.1', port, method: 'POST', path: '/hold', headers: { host: `127.0.0.1:${port}`, cookie, origin, 'content-type': 'application/json', 'content-length': 2 } });
    b.on('error', () => {}); b.write(data); b.end();
    await until(() => gate.waiting === 1);
    assert.equal(gate.waiting, 1, 'B は列で待っている');
    b.destroy();
    await until(() => gate.waiting === 0);
    assert.equal(gate.waiting, 0, '切った B は列から抜ける');
    pc.holds[0](); assert.equal((await a).status, 200);
    await until(() => gate.active === 0);
    assert.equal(gate.active, 0, '枠は 0 に戻る');
    assert.equal(pc.holds.length, 1, '切った B は本体に届かない');
    const c = req(port, 'POST', '/hold', { body: {}, cookie, origin });
    await until(() => pc.holds.length === 2); pc.holds[1]();
    assert.equal((await c).status, 200, '次の書き込みは通る');
  } finally { L.close(); L.server.closeAllConnections?.(); }
});

test('言語を選ぶ時にブラウザの時刻帯を state に残す・読めない値は残さない', { timeout: 5000 }, async () => {
  const L = await readyLauncher(); const { port, cookie } = L;
  try {
    await req(port, 'POST', '/setup/api/lang', { body: { lang: 'ja', timeZone: 'Mars/Base' }, cookie });
    assert.equal(L.store.get().timeZone, null);
    const r = await req(port, 'POST', '/setup/api/lang', { body: { lang: 'ja', timeZone: 'Asia/Tokyo' }, cookie });
    assert.equal(L.store.get().timeZone, 'Asia/Tokyo'); assert.equal(r.json.timeZone, 'Asia/Tokyo');
  } finally { L.close(); L.server.closeAllConnections?.(); }
});

// ログイン後に / を開いたらオフィスへ（範囲 docs/review/2026-11-18-office-ai-panel-ux-scope.md G4・F3）。条件の全部を 1 つずつ外して確かめる
test('/ はオフィスへ: GET・path がちょうど /・query 無し・accept に text/html・ログイン済み・wizard 済み・office の plugin が ready・prefix あり の全部の時だけ', { timeout: 8000 }, async () => {
  const dir = tmp(), pc = fakePaperclip(dir), pcPort = await listen(pc.srv);
  let office = { status: 'ready' };
  const { server, store } = createLauncher({ dataDir: path.join(dir, 'aioffice'), paperclipUrl: `http://127.0.0.1:${pcPort}`, codexHome: path.join(dir, 'codex-home'), spawnFn: fakeSpawn().fn, pluginStatus: () => (office ? { 'aioffice.office': office } : {}) });
  const port = await listen(server), me = `http://127.0.0.1:${port}`;
  const html = 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8';
  const get = (p, { cookie, accept = html, method = 'GET' } = {}) => new Promise((resolve, reject) => {
    const headers = { host: `127.0.0.1:${port}`, origin: me }; if (cookie) headers.cookie = cookie; if (accept) headers.accept = accept;
    const r = http.request({ host: '127.0.0.1', port, method, path: p, headers }, res => { res.resume(); res.on('end', () => resolve({ status: res.statusCode, location: res.headers.location })); });
    r.on('error', reject); r.end();
  });
  const proxied = r => r.status === 404 && r.location === undefined; // 偽の本体は知らない path に 404（＝中継された）
  try {
    const own = await req(port, 'POST', '/setup/api/owner', { body: { password: 'long enough' }, origin: me });
    const cookie = own.headers['set-cookie'][0].split(';')[0];
    await req(port, 'POST', '/setup/api/company', { body: { name: 'Acme' }, cookie });
    assert.equal((await get('/', { cookie })).location, '/setup/', 'wizard の前は今どおり wizard へ');
    await req(port, 'POST', '/setup/api/secretary', { body: {}, cookie });
    await req(port, 'POST', '/setup/api/finish', { cookie });

    assert.deepEqual(await get('/', { cookie }), { status: 302, location: '/ACM/office' }, '全部そろうとオフィスへ');
    assert.equal((await get('/')).location, '/setup/', 'ログインの前は今どおり（wizard のログイン）');
    assert.ok(proxied(await get('/?x=1', { cookie })), 'query があれば本体へ');
    assert.ok(proxied(await get('/', { cookie, accept: 'application/json' })), 'accept に text/html が無ければ本体へ');
    assert.ok(proxied(await get('/', { cookie, accept: null })), 'accept が無ければ本体へ');
    assert.ok(proxied(await get('/dashboard', { cookie })), 'path がちょうど / でなければ本体へ');
    assert.notEqual((await get('//', { cookie })).location, '/ACM/office', '// は / ではない');
    assert.ok(proxied(await get('/', { cookie, method: 'HEAD' })), 'GET の時だけ');
    assert.ok(proxied(await get('/', { cookie, method: 'POST' })), 'POST は本体へ');
    office = { status: 'pending' };
    assert.ok(proxied(await get('/', { cookie })), 'office の plugin が ready でなければ本体へ（Dashboard）');
    office = null;
    assert.ok(proxied(await get('/', { cookie })), 'office の plugin が無ければ本体へ');
    office = { status: 'ready' };
    store.update(s => { s.companyPrefix = null; });
    assert.ok(proxied(await get('/', { cookie })), 'prefix が無ければ本体へ');
    store.update(s => { s.companyPrefix = 'A B'; });
    assert.equal((await get('/', { cookie })).location, '/A%20B/office', 'prefix は符号化する');
  } finally { server.close(); pc.srv.close(); }
});
