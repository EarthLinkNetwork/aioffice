// 選んだ AI の CLI を /data/aitools に入れる仕組みの試験。範囲: docs/review/2026-11-17-wizard-ai-choice-scope.md の作り方 2・3
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { installCommand, createAiInstaller, verifiedPath } from '../packages/aioffice/launcher/lib/ai-install.mjs';
import { AI_CATALOG } from '../packages/aioffice/launcher/lib/ai-catalog.mjs';

function fakeSpawn(calls, { code = 0 } = {}) {
  return (cmd, args, opts) => {
    const c = new EventEmitter();
    c.stdout = new EventEmitter(); c.stderr = new EventEmitter();
    calls.push({ cmd, args, opts, child: c, finish: (n = code) => c.emit('close', n) });
    return c;
  };
}

test('npm の AI は版を固定した package を /data/aitools/<type> に入れ、HOME も volume に向ける', () => {
  const c = installCommand('claude_local');
  assert.equal(c.cmd, 'npm');
  assert.deepEqual(c.args.slice(0, 3), ['install', '--prefix', '/data/aitools/claude_local']);
  assert.equal(c.args.at(-1), '@anthropic-ai/claude-code@2.1.326');
  assert.equal(c.env.HOME, '/data/aitools/claude_local/home');
});

test('script の AI（Cursor）は公式の URL を、HOME を volume に向けて流す', () => {
  const c = installCommand('cursor');
  assert.equal(c.env.AI_INSTALL_URL, 'https://cursor.com/install');
  assert.equal(c.env.HOME, '/data/aitools/cursor/home');
});

test('image に入っている AI（Codex）は入れない・選べない AI は断る', () => {
  assert.equal(installCommand('codex_local'), null);
  assert.throws(() => installCommand('process'));
});

test('選べる AI は全部、入れる命令が作れる', () => {
  for (const e of AI_CATALOG.filter(e => e.include)) assert.doesNotThrow(() => installCommand(e.type), e.type);
});

// 偽の子 process の列: 入れる命令と --version を順に返す。marks に印の書き込みを残す
function rig({ binThere = true } = {}) {
  const calls = [], marks = new Map();
  const ins = createAiInstaller({ spawnFn: fakeSpawn(calls), exists: p => (p.endsWith('/VERIFIED') ? marks.has(p) : binThere), mkdir: () => {}, mark: (p, v) => marks.set(p, v) });
  return { calls, marks, ins };
}

test('入れ終わったら --version で動かして確かめ、通った時だけ印を書いて done。同時の 2 回目は起こさない', () => {
  const { calls, marks, ins } = rig();
  assert.equal(ins.start('grok_local').status, 'running');
  assert.equal(ins.start('grok_local').status, 'running');
  assert.equal(calls.length, 1);
  calls[0].finish(0);
  assert.equal(calls[1].cmd, '/data/aitools/grok_local/node_modules/.bin/grok');
  assert.deepEqual(calls[1].args, ['--version']);
  calls[1].child.stdout.emit('data', 'grok 1.0.88\n'); calls[1].finish(0);
  assert.equal(ins.view('grok_local').status, 'done');
  assert.equal(marks.get(verifiedPath('grok_local')), 'grok 1.0.88');
  assert.equal(ins.start('grok_local').status, 'done');
  assert.equal(calls.length, 2);
});

test('入ったのに動かない（platform の本体の取り損ね）時は 1 回だけ入れ直し、それでも動かなければ verify_failed', () => {
  const { calls, marks, ins } = rig();
  ins.start('claude_local');
  calls[0].finish(0); calls[1].finish(1);
  assert.equal(calls[2].cmd, 'npm', '入れ直す');
  calls[2].finish(0); calls[3].finish(0);
  assert.equal(ins.view('claude_local').status, 'done', '2 回目で動けば done');
  const r = rig();
  r.ins.start('claude_local');
  r.calls[0].finish(0); r.calls[1].finish(1); r.calls[2].finish(0); r.calls[3].finish(1);
  assert.deepEqual(r.ins.view('claude_local'), { type: 'claude_local', status: 'failed', error: 'verify_failed' });
  assert.equal(r.marks.size, 0, '動かない物に印を書かない');
  assert.equal(marks.size, 1);
});

test('失敗は failed と理由を返し、もう一度入れ直せる', () => {
  const { calls, ins } = rig({ binThere: false });
  ins.start('gemini_local'); calls[0].finish(1);
  assert.deepEqual(ins.view('gemini_local'), { type: 'gemini_local', status: 'failed', error: 'exit_1' });
  ins.start('gemini_local'); calls[1].finish(0);
  assert.equal(ins.view('gemini_local').error, 'bin_missing');
  assert.equal(calls.length, 2);
});

test('作り直した container でも、volume に確かめ済みの印があれば done（入れ直さない）。CLI の file があるだけでは done にしない', () => {
  const calls = [];
  const ins = createAiInstaller({ spawnFn: fakeSpawn(calls), exists: p => p === '/data/aitools/kimi_local/VERIFIED', mkdir: () => {} });
  assert.equal(ins.view('kimi_local').status, 'done');
  assert.equal(ins.start('kimi_local').status, 'done');
  assert.equal(calls.length, 0);
  const ins2 = createAiInstaller({ spawnFn: fakeSpawn(calls), exists: p => p === '/data/aitools/kimi_local/node_modules/.bin/kimi', mkdir: () => {} });
  assert.equal(ins2.view('kimi_local').status, 'pending');
});
