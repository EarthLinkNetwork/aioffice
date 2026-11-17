// 連携の有無を読む部品の試験（範囲 docs/review/2026-11-22-notify-via-ai-connectors-scope.md の作り方 1・10・PR のレビュー B-1〜B-6）
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { spawn } from 'node:child_process';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { parsePluginList, createConnectors } from '../packages/aioffice/launcher/lib/connectors.mjs';
import { createLauncher } from '../packages/aioffice/launcher/server.mjs';
import { hashPassword, issueCookie } from '../packages/aioffice/launcher/lib/guard.mjs';

const LIST = [
  'gmail@openai-curated-remote        installed, enabled  0.1.10  plugin_connector_1p_x',
  'slack@openai-curated-remote        not installed       0.1.8   plugin_asdk_app_y',
  'outlook-email@openai-curated-remote installed, enabled 0.1.8   plugin_connector_1p_z',
  'gmail@openai-curated               installed, disabled 0.1.9   z',
  'someone@example.com is not a plugin line', // 形の違う行（アドレスなど）は拾わない
].join('\n');

test('許し札の連携の状態だけを取り出す・同じ連携が 2 行あれば enabled が勝つ', () => {
  assert.deepEqual(parsePluginList(LIST), { gmail: 'enabled', slack: 'missing' });
  assert.deepEqual(parsePluginList('slack@x installed, disabled 1\n'), { gmail: 'missing', slack: 'disabled' });
});

test('サインインの前の空の一覧は「分からない」。ほかの連携だけが出ている時は「無い」（B-4）', () => {
  assert.deepEqual(parsePluginList('No marketplace plugins found.\n'), { gmail: 'unknown', slack: 'unknown' });
  assert.deepEqual(parsePluginList(''), { gmail: 'unknown', slack: 'unknown' });
  assert.deepEqual(parsePluginList('outlook-email@m installed, enabled 1\n'), { gmail: 'missing', slack: 'missing' });
});

function fakeSpawn(behave) {
  const calls = [], kills = [];
  const fn = (bin, args, opts) => {
    calls.push({ bin, args, home: opts.env.CODEX_HOME, stdio: opts.stdio });
    const c = new EventEmitter(); c.stdout = new EventEmitter(); c.kill = sig => { kills.push(sig); };
    setImmediate(() => behave(c));
    return c;
  };
  return { fn, calls, kills };
}
const okRun = c => { c.stdout.emit('data', Buffer.from(LIST)); c.emit('exit', 0); c.emit('close', 0); };

test('共有の CODEX_HOME で plugin list を回し、状態の語だけを返す（生の出力・stderr は持たない）', async () => {
  const s = fakeSpawn(okRun);
  const con = createConnectors({ codexBin: 'codex', codexHome: '/data/codex-home', spawnFn: s.fn });
  const r = await con.get();
  assert.equal(r.codex.state, 'ok');
  assert.deepEqual(r.codex.connectors, { gmail: 'enabled', slack: 'missing' });
  assert.equal(r.claude.state, 'unsupported');
  assert.deepEqual(s.calls[0].args, ['plugin', 'list']);
  assert.equal(s.calls[0].home, '/data/codex-home');
  assert.equal(s.calls[0].stdio[2], 'ignore', 'stderr は読まない');
  assert.ok(!JSON.stringify(r).includes('example.com') && !JSON.stringify(r).includes('plugin_connector'), '生の出力が答えに入らない');
});

test("'exit' の後に届いた最後の行も読む（'close' で終える・B-1）", async () => {
  const s = fakeSpawn(c => { c.emit('exit', 0); c.stdout.emit('data', Buffer.from(LIST)); c.emit('close', 0); });
  const r = await createConnectors({ codexHome: '/h', spawnFn: s.fn }).get();
  assert.equal(r.codex.connectors.gmail, 'enabled');
});

test('本物の子 process の 3000 行の出力の最後の行を取りこぼさない（B-1）', async () => {
  const script = "const l=[];for(let i=0;i<3000;i++)l.push('x'+i+'@m installed, enabled 1');l.push('gmail@m installed, enabled 1');process.stdout.write(l.join('\\n'))";
  const realSpawn = (bin, args, opts) => spawn(process.execPath, ['-e', script], opts);
  const r = await createConnectors({ codexHome: '/h', spawnFn: realSpawn }).get();
  assert.equal(r.codex.connectors.gmail, 'enabled');
});

test('同時の呼び出しは 1 本・成功は ttl の間覚える・fresh も前の実行から minGap の間は前の結果（B-5）', async () => {
  let t = 0;
  const s = fakeSpawn(okRun);
  const con = createConnectors({ codexHome: '/h', spawnFn: s.fn, now: () => t, ttlMs: 1000, minGapMs: 100 });
  await Promise.all([con.get(), con.get(), con.get()]);
  assert.equal(s.calls.length, 1);
  t = 50; await con.get({ fresh: true }); assert.equal(s.calls.length, 1, 'minGap の間の fresh は回さない');
  t = 500; await con.get(); assert.equal(s.calls.length, 1);
  t = 600; await con.get({ fresh: true }); assert.equal(s.calls.length, 2);
  t = 1700; await con.get(); assert.equal(s.calls.length, 3);
});

test('失敗は短い間だけ覚える（B-3）', async () => {
  let t = 0, n = 0;
  const s = fakeSpawn(c => { n++; if (n === 1) { c.emit('close', 1); } else okRun(c); });
  const con = createConnectors({ codexHome: '/h', spawnFn: s.fn, now: () => t, failTtlMs: 100 });
  assert.equal((await con.get()).codex.state, 'error');
  t = 50; assert.equal((await con.get()).codex.state, 'error'); assert.equal(s.calls.length, 1);
  t = 150; assert.equal((await con.get()).codex.state, 'ok'); assert.equal(s.calls.length, 2);
});

test('失敗は決まった印だけ: 同期と非同期の見つからない・時間切れ（SIGTERM の後に SIGKILL）・0 でない終わり（B-6）', async () => {
  const missing = createConnectors({ codexHome: '/h', spawnFn: () => { const e = new Error('x'); e.code = 'ENOENT'; throw e; } });
  assert.equal((await missing.get()).codex.error, 'codex_missing');
  const asyncMissing = fakeSpawn(c => { const e = new Error('x'); e.code = 'ENOENT'; c.emit('error', e); });
  assert.equal((await createConnectors({ codexHome: '/h', spawnFn: asyncMissing.fn }).get()).codex.error, 'codex_missing');
  const hang = fakeSpawn(() => {});
  assert.equal((await createConnectors({ codexHome: '/h', spawnFn: hang.fn, timeoutMs: 20, killWaitMs: 20 }).get()).codex.error, 'timeout');
  assert.deepEqual(hang.kills, ['SIGTERM']);
  await new Promise(r => setTimeout(r, 40));
  assert.deepEqual(hang.kills, ['SIGTERM', 'SIGKILL'], '猶予の後に SIGKILL');
  const bad = createConnectors({ codexHome: '/h', spawnFn: fakeSpawn(c => { c.stdout.emit('data', Buffer.from('secret-ish text')); c.emit('close', 1); }).fn });
  const r = await bad.get();
  assert.deepEqual(r.codex, { state: 'error', error: 'failed', connectors: null, checkedAt: r.codex.checkedAt });
});

test('サインインしていなければ回さず覚えた結果も捨てる・サインインの手続きの最中は回さない（B-2・B-3）', async () => {
  let signed = true, busy = false;
  const s = fakeSpawn(okRun);
  const con = createConnectors({ codexHome: '/h', spawnFn: s.fn, hasCodex: () => signed, loginBusy: () => busy });
  assert.equal((await con.get()).codex.state, 'ok');
  signed = false; assert.equal((await con.get()).codex.state, 'not_connected');
  signed = true; busy = true; assert.equal((await con.get()).codex.state, 'busy', '前のアカウントの結果を返さない');
  assert.equal(s.calls.length, 1);
});

// 起動係を通した口（B-6）
const listen = srv => new Promise(r => srv.listen(0, '127.0.0.1', () => r(srv.address().port)));
function get(port, p, cookie) {
  return new Promise((resolve, reject) => {
    const headers = { host: `127.0.0.1:${port}`, origin: `http://127.0.0.1:${port}` }; if (cookie) headers.cookie = cookie;
    http.get({ host: '127.0.0.1', port, path: p, headers }, res => { let t = ''; res.on('data', c => { t += c; }); res.on('end', () => resolve({ status: res.statusCode, text: t })); }).on('error', reject);
  });
}
test('GET /setup/api/connectors: cookie が要る・答えは状態の語だけ・auth.json が無いか空なら not_connected', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aio-con-')), home = path.join(dir, 'codex-home');
  fs.mkdirSync(home, { recursive: true });
  const core = http.createServer((q, s) => { s.writeHead(404); s.end('{}'); }); const pcPort = await listen(core);
  const s = fakeSpawn(okRun);
  const { server, store } = createLauncher({ dataDir: path.join(dir, 'aioffice'), paperclipUrl: `http://127.0.0.1:${pcPort}`, codexHome: home, spawnFn: s.fn });
  store.update(x => { x.owner = hashPassword('long enough'); x.generation = 1; x.lang = 'ja'; x.companyId = 'c1'; x.done = true; });
  const port = await listen(server), cookie = issueCookie(store.secret, 1).split(';')[0];
  try {
    assert.equal((await get(port, '/setup/api/connectors')).status, 401, 'cookie なし');
    let r = await get(port, '/setup/api/connectors', cookie);
    assert.equal(r.status, 200); assert.equal(JSON.parse(r.text).codex.state, 'not_connected', 'auth.json が無い');
    fs.writeFileSync(path.join(home, 'auth.json'), '');
    assert.equal(JSON.parse((await get(port, '/setup/api/connectors', cookie)).text).codex.state, 'not_connected', '空の auth.json');
    fs.writeFileSync(path.join(home, 'auth.json'), '{"x":1}');
    r = await get(port, '/setup/api/connectors', cookie);
    const j = JSON.parse(r.text);
    assert.deepEqual(j.codex.connectors, { gmail: 'enabled', slack: 'missing' });
    assert.ok(!r.text.includes('plugin_connector') && !r.text.includes('openai-curated'), '生の出力が答えに入らない');
  } finally { server.close(); core.close(); }
});

test('時間切れの後は、前の子が終わるまで次を起こさない（再レビュー P3-a）', async () => {
  let t = 0, first = null;
  const s = fakeSpawn(c => { if (!first) { first = c; return; } okRun(c); });
  const con = createConnectors({ codexHome: '/h', spawnFn: s.fn, now: () => t, timeoutMs: 10, killWaitMs: 1000, failTtlMs: 0, minGapMs: 0 });
  assert.equal((await con.get()).codex.error, 'timeout');
  t = 100; const p = con.get({ fresh: true });
  await new Promise(r => setTimeout(r, 30));
  assert.equal(s.calls.length, 1, '前の子が生きている間は起こさない');
  first.emit('close', null);
  assert.equal((await p).codex.state, 'ok');
  assert.equal(s.calls.length, 2);
});
