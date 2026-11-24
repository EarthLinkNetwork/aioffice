// Claude の setup-token のつなぎの試験。範囲: docs/review/2026-11-17-wizard-ai-choice-scope.md の作り方 4・保証 4
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createClaudeLogin, parseUrl, parseToken, setupTokenArgs } from '../packages/aioffice/launcher/lib/claude-login.mjs';

const URL = 'https://claude.com/cai/oauth/authorize?code=true&client_id=00000000-0000-0000-0000-000000000000&response_type=code&scope=user%3Ainference&state=abc';
const TOKEN = 'sk-ant-oat01-' + 'A'.repeat(40) + '_test';

function fake() {
  const calls = [];
  const spawnFn = (cmd, args, opts) => {
    const c = new EventEmitter();
    c.stdout = new EventEmitter(); c.stderr = new EventEmitter();
    c.written = [];
    c.stdin = { write: d => c.written.push(d) };
    c.kill = () => c.emit('exit', null);
    calls.push({ cmd, args, opts, c });
    return c;
  };
  return { calls, spawnFn };
}
const tick = () => new Promise(r => setImmediate(r));
const tmpRoot = () => fs.mkdtempSync(path.join(os.tmpdir(), 'cl-test-'));

test('script の記録の file は /dev/null で、幅を広げてから setup-token を起こす', () => {
  const a = setupTokenArgs('/data/aitools/claude_local/node_modules/.bin/claude');
  assert.equal(a.at(-1), '/dev/null');
  assert.match(a[1], /stty cols 1000/);
  assert.match(a[1], /exec '\/data\/aitools\/claude_local\/node_modules\/\.bin\/claude' setup-token$/);
});

test('URL は色や OSC 8 のリンクの印を外して取り、token の形も取れる', () => {
  assert.equal(parseUrl(`\x1b[1mBrowser didn't open?\x1b[0m \x1b]8;;${URL}\x07${URL}\x1b]8;;\x07\r\nPaste code here`), URL);
  assert.equal(parseToken(`\x1b[32m${TOKEN}\x1b[0m\r\n`), TOKEN);
  assert.equal(parseToken(`${TOKEN}\x1b[22mStore this token\r\n`), TOKEN, '色の印の後の文字を混ぜない');
});

test('URL を出し、貼った code を渡し、token を秘密に入れて done。token は応答に出ない', async () => {
  const { calls, spawnFn } = fake(); const saved = []; const root = tmpRoot();
  const l = createClaudeLogin({ claudeBin: 'claude', saveToken: t => { saved.push(t); }, spawnFn, tmpRoot: root, enterDelayMs: 5 });
  assert.equal(l.start().state, 'starting');
  const { c, opts } = calls[0];
  assert.equal(opts.cwd, opts.env.HOME, 'cwd と HOME は同じ使い捨ての dir');
  assert.ok(opts.cwd.startsWith(root));
  c.stdout.emit('data', Buffer.from(`Use the URL below to sign in\r\n${URL}\r\nPaste code here if prompted > `));
  assert.deepEqual([l.view().state, l.view().url], ['waiting', URL]);
  assert.equal(l.submit('bad code with spaces').error, 'bad_code');
  assert.equal(l.submit('abcDEF123456#state-xyz').state, 'submitting');
  // code と Enter は分けて送る（まとめると claude が貼り付けと受け取り、Enter が送信として効かない）
  assert.deepEqual(c.written, ['abcDEF123456#state-xyz']);
  await new Promise(r => setTimeout(r, 30));
  assert.deepEqual(c.written, ['abcDEF123456#state-xyz', '\r']);
  c.stdout.emit('data', Buffer.from(`Your OAuth token (valid for 1 year):\r\n\r\n${TOKEN}\r\n`));
  await tick(); await tick();
  assert.deepEqual(saved, [TOKEN]);
  const v = l.view();
  assert.equal(v.state, 'done');
  assert.doesNotMatch(JSON.stringify(v), /sk-ant/);
  assert.equal(fs.existsSync(opts.cwd), false, '使い捨ての dir は消す');
  assert.deepEqual(fs.readdirSync(root), []);
});

test('秘密に入れられなければ failed（token は残さない）', async () => {
  const { calls, spawnFn } = fake();
  const l = createClaudeLogin({ claudeBin: 'claude', saveToken: () => { throw new Error('x'); }, spawnFn, tmpRoot: tmpRoot() });
  l.start(); calls[0].c.stdout.emit('data', URL + '\n'); l.submit('abcdefgh12');
  calls[0].c.stdout.emit('data', TOKEN + '\n');
  await tick(); await tick();
  assert.deepEqual([l.view().state, l.view().error], ['failed', 'save_failed']);
  assert.doesNotMatch(JSON.stringify(l.view()), /sk-ant/);
});

test('code を渡した後に token が出ずに終われば login_failed、URL が出ずに終われば no_url（exit だけで close が来なくても猶予の後に決める）', async () => {
  let f = fake();
  let l = createClaudeLogin({ claudeBin: 'claude', saveToken: () => {}, spawnFn: f.spawnFn, tmpRoot: tmpRoot(), log: () => {}, exitGraceMs: 5 });
  l.start(); f.calls[0].c.stdout.emit('data', URL + '\n'); l.submit('abcdefgh12'); f.calls[0].c.emit('exit', 1);
  await new Promise(r => setTimeout(r, 30));
  assert.equal(l.view().error, 'login_failed');
  f = fake();
  l = createClaudeLogin({ claudeBin: 'claude', saveToken: () => {}, spawnFn: f.spawnFn, tmpRoot: tmpRoot(), log: () => {} });
  l.start(); f.calls[0].c.emit('close', 1);
  assert.equal(l.view().error, 'no_url');
});

test('二度押しは同じ process のまま・取り消すと止めて dir を消す・期限で expired', () => {
  const { calls, spawnFn } = fake(); let t = 0;
  const l = createClaudeLogin({ claudeBin: 'claude', saveToken: () => {}, spawnFn, tmpRoot: tmpRoot(), ttlMs: 50, now: () => t });
  l.start(); l.start();
  assert.equal(calls.length, 1);
  const dir = calls[0].opts.cwd;
  assert.equal(l.cancel().state, 'cancelled');
  assert.equal(fs.existsSync(dir), false);
  assert.equal(l.submit('abcdefgh12').error, 'not_waiting');
});

test('すでに token があれば最初から done', () => {
  const l = createClaudeLogin({ claudeBin: 'claude', saveToken: () => {}, hasToken: () => true, tmpRoot: tmpRoot() });
  assert.equal(l.view().state, 'done');
});

test('URL と token が途中で分かれて届いても、切れた物を拾わず、続きが来てから一致する（独立レビュー P1-1）', async () => {
  const { calls, spawnFn } = fake(); const saved = [];
  const l = createClaudeLogin({ claudeBin: 'claude', saveToken: t => { saved.push(t); }, spawnFn, tmpRoot: tmpRoot() });
  l.start(); const { c } = calls[0];
  c.stdout.emit('data', Buffer.from(URL.slice(0, 60)));
  assert.equal(l.view().state, 'starting', '切れた URL では waiting にしない');
  c.stdout.emit('data', Buffer.from(URL.slice(60) + '\r\n'));
  assert.equal(l.view().url, URL);
  l.submit('abcdefgh12');
  c.stdout.emit('data', Buffer.from(TOKEN.slice(0, 30)));
  await tick(); await tick();
  assert.deepEqual(saved, [], '切れた token は渡さない');
  c.stdout.emit('data', Buffer.from(TOKEN.slice(30) + '\r\n'));
  await tick(); await tick();
  assert.deepEqual(saved, [TOKEN]);
});

test('秘密に入れている途中は、やり直しも取り消しも受けない（独立レビュー P1-3）', async () => {
  const { calls, spawnFn } = fake(); let release;
  const l = createClaudeLogin({ claudeBin: 'claude', saveToken: () => new Promise(r => { release = r; }), spawnFn, tmpRoot: tmpRoot() });
  l.start(); calls[0].c.stdout.emit('data', URL + '\n'); l.submit('abcdefgh12');
  calls[0].c.stdout.emit('data', TOKEN + '\n');
  await tick();
  assert.equal(l.start().state, 'submitting');
  assert.equal(l.cancel().state, 'submitting');
  assert.equal(calls.length, 1, '2 本目を起こさない');
  release(); await tick(); await tick();
  assert.equal(l.view().state, 'done');
});

test('前に落ちた launcher が残した使い捨ての dir は、起動の時に消す', () => {
  const root = tmpRoot(); fs.mkdirSync(path.join(root, 'claude-login-old')); fs.mkdirSync(path.join(root, 'other'));
  createClaudeLogin({ claudeBin: 'claude', saveToken: () => {}, tmpRoot: root });
  assert.deepEqual(fs.readdirSync(root), ['other']);
});

// 2026-11-18 の実害: claude が code を断ると「OAuth error … Press Enter to retry.」を出して入力待ちに戻り、wizard が「確かめています」のまま止まった
const REJECT = '\x1b(B\x0f\r✢ Finishing sign-i…\r\r\nOAuth error: That code\x1b[1Cwasn\'t\x1b[1Caccepted.\x1b[1CIt\x1b[1Cmay\x1b[1Cbe\x1b[1Cincomplete.\r\r\nPress\x1b[1CEnter\x1b[1Cto\x1b[1Cretry.\r\r\n';

test('code が断られたら code_rejected で止め、子 process を終わらせる（確かめていますのまま待たない）', () => {
  const { calls, spawnFn } = fake(); const saved = [];
  const l = createClaudeLogin({ claudeBin: 'claude', saveToken: t => saved.push(t), spawnFn, tmpRoot: tmpRoot() });
  l.start(); const { c } = calls[0];
  c.stdout.emit('data', Buffer.from(URL + '\r\n'));
  assert.equal(l.submit('abcdefgh12').state, 'submitting');
  c.stdout.emit('data', Buffer.from(REJECT));
  assert.deepEqual({ state: l.view().state, error: l.view().error }, { state: 'failed', error: 'code_rejected' });
  assert.deepEqual(saved, []);
  assert.equal(l.start().state, 'starting', 'もう一度つなげる');
  l.cancel(); // 期限の timer を残さない
});

test('code を送る前の画面の文では断りと見なさない', () => {
  const { calls, spawnFn } = fake();
  const l = createClaudeLogin({ claudeBin: 'claude', saveToken: () => {}, spawnFn, tmpRoot: tmpRoot() });
  l.start(); calls[0].c.stdout.emit('data', Buffer.from(REJECT + URL + '\r\n'));
  assert.equal(l.view().state, 'waiting');
  assert.equal(l.submit('abcdefgh12').state, 'submitting');
  l.cancel(); // 期限の timer を残さない
});

test('code を送ってから答えが無ければ login_timeout で止める', async () => {
  const { calls, spawnFn } = fake();
  const l = createClaudeLogin({ claudeBin: 'claude', saveToken: () => {}, spawnFn, tmpRoot: tmpRoot(), submitWaitMs: 20 });
  l.start(); calls[0].c.stdout.emit('data', Buffer.from(URL + '\r\n'));
  l.submit('abcdefgh12');
  await new Promise(r => setTimeout(r, 60));
  assert.deepEqual({ state: l.view().state, error: l.view().error }, { state: 'failed', error: 'login_timeout' });
});

test('claude が token を出してすぐ終わり、exit の知らせが最後の出力より先に来ても、token を取り逃さない', async () => {
  const { calls, spawnFn } = fake(); const saved = [];
  const l = createClaudeLogin({ claudeBin: 'claude', saveToken: t => { saved.push(t); }, spawnFn, tmpRoot: tmpRoot(), log: () => {} });
  l.start(); const { c } = calls[0];
  c.stdout.emit('data', Buffer.from(URL + '\r\n'));
  l.submit('abcdefgh12');
  c.emit('exit', 0);
  c.stdout.emit('data', Buffer.from(`Your OAuth token (valid for 1 year):\r\n\r\n${TOKEN}`)); // 後ろに改行が来ないまま終わる
  c.emit('close', 0);
  await tick(); await tick();
  assert.deepEqual(saved, [TOKEN]);
  assert.equal(l.view().state, 'done');
});

test('止まった時は理由と、伏せた出力の末尾を記録に出す（token・URL は出さない）', () => {
  const { calls, spawnFn } = fake(); const logs = [];
  const l = createClaudeLogin({ claudeBin: 'claude', saveToken: () => {}, spawnFn, tmpRoot: tmpRoot(), log: m => logs.push(m) });
  l.start(); const { c } = calls[0];
  c.stdout.emit('data', Buffer.from(URL + '\r\n'));
  l.submit('abcdefgh12');
  c.stdout.emit('data', Buffer.from('Something unexpected sk-ant-xyz-SECRETSECRETSECRETSECRET\r\n'));
  c.emit('close', 1);
  assert.equal(l.view().error, 'login_failed');
  assert.match(logs.join('\n'), /failed: login_failed .*Something unexpected/);
  assert.doesNotMatch(logs.join('\n'), /SECRET|claude\.com/);
});
