// Codex・Claude 以外の AI のつなぎ（lib/device-login.mjs）の試験。範囲: docs/review/2026-11-17-wizard-ai-choice-scope.md の作り方 4（all-ai-v1 m04）
// 出力の見本は 2026-11-20 に arm64 のまっさらな container で実測した物（code は使い捨て）
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { parseLogin, loginArgs, createDeviceLogin } from '../packages/aioffice/launcher/lib/device-login.mjs';
import { AI_CATALOG } from '../packages/aioffice/launcher/lib/ai-catalog.mjs';

const SAMPLES = {
  grok_local: ['To sign in, open this URL in your browser:\r\n  https://accounts.x.ai/oauth2/device?user_code=TEXA-9YKN\r\n  (Could not open browser automatically — open the URL above manually.)\r\nConfirm this code in your browser:\r\n  TEXA-9YKN\r\nWaiting for authorization...\r\n', 'https://accounts.x.ai/oauth2/device?user_code=TEXA-9YKN', 'TEXA-9YKN'],
  kimi_local: ['Opening browser for Kimi device login: https://www.kimi.com/code/authorize_device?user_code=E9AZ-0HG9\r\nIf the browser did not open, paste the URL above and enter code: E9AZ-0HG9\r\nCode expires in 1800s.\r\n', 'https://www.kimi.com/code/authorize_device?user_code=E9AZ-0HG9', 'E9AZ-0HG9'],
  pi_local: ['Select OpenAI Codex login method: Device code login (headless)\r\nOpen https://auth.openai.com/codex/device and enter code: T26D-X2N7R\r\nWaiting for authentication...\r\n', 'https://auth.openai.com/codex/device', 'T26D-X2N7R'],
  opencode_local: ['\x1b[90m┌\x1b[39m  Add credential\r\n│\r\n●  Go to: https://auth.openai.com/codex/device\r\n│\r\n●  Enter code: T25Y-E4D4D\r\n│\r\n◒  Waiting for authorization', 'https://auth.openai.com/codex/device', 'T25Y-E4D4D'],
  cursor: [`Starting login process...\r\nWaiting for browser authentication...\r\nOpen a browser and navigate to this link: https://cursor.com/loginDeepControl?challenge=${'v'.repeat(43)}&uuid=0fc79aad-6669-4bb2-b90c-fc7bd015aaf6&mode=login&redirectTarget=cli&supportsSelected=1\r\n`, `https://cursor.com/loginDeepControl?challenge=${'v'.repeat(43)}&uuid=0fc79aad-6669-4bb2-b90c-fc7bd015aaf6&mode=login&redirectTarget=cli&supportsSelected=1`, null],
};

test('表の device・browser の AI は全部、実測の見本があり、そこから URL と（device なら）code を拾える', () => {
  const rows = AI_CATALOG.filter(e => e.include && e.connect);
  assert.deepEqual(rows.map(e => e.type).sort(), Object.keys(SAMPLES).sort());
  for (const e of rows) {
    const [out, url, code] = SAMPLES[e.type];
    assert.ok(['device', 'browser'].includes(e.login), e.type);
    assert.ok(e.connect.url.startsWith('https://'), e.type);
    assert.deepEqual(parseLogin(out, { url: e.connect.url, code: e.login === 'device' }), { url, code: e.login === 'device' ? code : null }, e.type);
  }
});

test('鍵だけの AI（Gemini）は connect を持たず keyEnv を持つ。契約でつなげない理由は実測（非対話では断られる）', () => {
  const g = AI_CATALOG.find(e => e.type === 'gemini_local');
  assert.equal(g.login, 'api_key');
  assert.equal(g.connect, undefined);
  assert.equal(g.keyEnv, 'GEMINI_API_KEY');
});

test('途中で切れた出力の URL は拾わない（後ろに空白が来るまで待つ）・URL の中の code の形の物を code と取り違えない', () => {
  assert.equal(parseLogin('Go to: https://auth.openai.com/codex/dev', { url: 'https://auth.openai.com/', code: true }).url, null);
  assert.equal(parseLogin('Go to: https://auth.openai.com/codex/device?x=ABCD-1234 \r\n', { url: 'https://auth.openai.com/', code: true }).code, null);
  assert.equal(parseLogin('https://evil.example/https://accounts.x.ai/ \r\n', { url: 'https://accounts.x.ai/', code: false }).url, null, '表の URL で始まる物だけ');
});

test('PTY の命令: script -qefc で幅を広げ、引数を 1 つずつ引用し、記録の file は /dev/null', () => {
  const a = loginArgs('/data/aitools/opencode_local/node_modules/.bin/opencode', ['auth', 'login', '-p', 'openai', '-m', "ChatGPT Pro/Plus (headless)"]);
  assert.deepEqual([a[0], a[2]], ['-qefc', '/dev/null']);
  assert.equal(a[1], "stty cols 1000 rows 50 2>/dev/null; exec '/data/aitools/opencode_local/node_modules/.bin/opencode' 'auth' 'login' '-p' 'openai' '-m' 'ChatGPT Pro/Plus (headless)'");
  assert.match(loginArgs('/x', ["it's"])[1], /'it'\\''s'$/);
});

function fakeSpawn() {
  const procs = [];
  const fn = (cmd, args, opts) => {
    const c = new EventEmitter(); c.stdout = new EventEmitter(); c.stderr = new EventEmitter(); c.stdin = { write() {} };
    c.kill = () => setImmediate(() => c.emit('exit', null));
    procs.push({ cmd, args, opts, c }); return c;
  };
  return { fn, procs };
}
const tick = () => new Promise(r => setImmediate(r));
const mk = (sp, extra = {}) => createDeviceLogin({ type: 'grok_local', bin: '/b/grok', args: ['login', '--device-auth'], url: 'https://accounts.x.ai/', wantCode: true, home: '/h/grok', homeEnv: 'GROK_HOME', spawnFn: sp.fn, mkdir: () => {}, ...extra });

test('状態: starting → waiting（URL と code）→ 0 で終われば done で onDone を 1 回呼ぶ', async () => {
  const sp = fakeSpawn(); const done = [];
  const l = mk(sp, { onDone: t => done.push(t) });
  assert.equal(l.view().state, 'idle');
  assert.equal(l.start().state, 'starting');
  await tick();
  assert.equal(sp.procs.length, 1);
  sp.procs[0].c.stdout.emit('data', Buffer.from(SAMPLES.grok_local[0]));
  assert.deepEqual([l.view().state, l.view().url, l.view().code], ['waiting', SAMPLES.grok_local[1], 'TEXA-9YKN']);
  assert.ok(l.view().remainingMs > 0);
  l.start(); await tick();
  assert.equal(sp.procs.length, 1, '二度押しで 2 本目を起こさない');
  sp.procs[0].c.emit('exit', 0);
  assert.deepEqual([l.view().state, l.view().url, l.view().code], ['done', null, null]);
  assert.deepEqual(done, ['grok_local']);
});

test('URL を出す前に 0 で終わったら done にしない（命令の形が変わった時に「つないだ」と出さない）・0 以外は failed', async () => {
  const sp = fakeSpawn(); const done = [];
  const l = mk(sp, { onDone: t => done.push(t) });
  l.start(); await tick();
  sp.procs[0].c.emit('exit', 0);
  assert.deepEqual([l.view().state, l.view().error], ['failed', 'no_url']);
  l.start(); await tick();
  sp.procs[1].c.stdout.emit('data', Buffer.from(SAMPLES.grok_local[0]));
  sp.procs[1].c.emit('exit', 2);
  assert.deepEqual([l.view().state, l.view().error], ['failed', 'login_failed']);
  assert.deepEqual(done, []);
});

test('取り消し: process を止め、後から来た終わりの知らせで done にしない・期限切れ: expired にして止める', async () => {
  const sp = fakeSpawn(); const done = [];
  const l = mk(sp, { onDone: t => done.push(t) });
  l.start(); await tick();
  sp.procs[0].c.stdout.emit('data', Buffer.from(SAMPLES.grok_local[0]));
  assert.equal(l.cancel().state, 'cancelled');
  sp.procs[0].c.emit('exit', 0);
  assert.equal(l.view().state, 'cancelled');
  assert.deepEqual(done, []);
  let t = 0; const sp2 = fakeSpawn();
  const l2 = mk(sp2, { ttlMs: 50, now: () => t });
  l2.start(); await tick();
  await new Promise(r => setTimeout(r, 80));
  assert.equal(l2.view().state, 'expired');
});

test('やり直しは前の process が終わってから次を起こす（同じ置き場で 2 本動かさない）', async () => {
  const sp = fakeSpawn();
  const l = mk(sp);
  l.start(); await tick();
  sp.procs[0].c.kill = () => {}; // 終わりの知らせが来ない
  l.cancel(); l.start(); await tick(); await tick();
  assert.equal(sp.procs.length, 1, '前が終わるまで起こさない');
  sp.procs[0].c.emit('exit', null); await tick(); await tick();
  assert.equal(sp.procs.length, 2);
});

test('子 process の env: 資格の置き場を HOME と表の env に向け、ブラウザを開かせず、launcher の env を全部は渡さない', async () => {
  process.env.AIO_TEST_SECRET_X = 'should-not-pass';
  try {
    const sp = fakeSpawn();
    mk(sp).start(); await tick();
    const { env, cwd } = sp.procs[0].opts;
    assert.equal(sp.procs[0].cmd, 'script');
    assert.deepEqual([env.HOME, env.GROK_HOME, cwd, env.BROWSER, env.NO_OPEN_BROWSER], ['/h/grok', '/h/grok', '/h/grok', 'none', '1']);
    assert.equal(env.AIO_TEST_SECRET_X, undefined);
  } finally { delete process.env.AIO_TEST_SECRET_X; }
});

test('つないである印があれば最初から done（container を作り直しても状態の file から読む）', () => {
  assert.equal(mk(fakeSpawn(), { isConnected: () => true }).view().state, 'done');
});

test('code が途中で分かれて届いても、切れた code を出さない（後ろに空白が来るまで待つ・独立レビュー）', async () => {
  const sp = fakeSpawn();
  const l = mk(sp, { url: 'https://auth.openai.com/', args: [] });
  l.start(); await tick();
  sp.procs[0].c.stdout.emit('data', Buffer.from('Go to: https://auth.openai.com/codex/device\r\nEnter code: T25Y-E4D4'));
  assert.equal(l.view().state, 'starting');
  sp.procs[0].c.stdout.emit('data', Buffer.from('D\r\n'));
  assert.deepEqual([l.view().state, l.view().code], ['waiting', 'T25Y-E4D4D']);
  l.cancel();
});
