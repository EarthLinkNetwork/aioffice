import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { createOllama, ollamaEnv } from '../packages/aioffice/launcher/lib/ollama.mjs';

function fakeSpawn() {
  const calls = [];
  const spawn = (cmd, args, opts) => { const c = new EventEmitter(); c.pid = calls.length + 1; c.kill = sig => { c.killed = sig; }; calls.push({ cmd, args, opts, c }); return c; };
  return { calls, spawn };
}

test('Ollama: loopback だけ・model を降ろさない・同時に 1 本・nice 10 で起こす', () => {
  const e = ollamaEnv({ PATH: '/bin' }, { modelsDir: '/m' });
  assert.equal(e.OLLAMA_HOST, '127.0.0.1:11434');
  assert.equal(e.OLLAMA_MODELS, '/m');
  assert.equal(e.OLLAMA_KEEP_ALIVE, '-1');
  assert.equal(e.OLLAMA_NUM_PARALLEL, '1');
  assert.equal(e.OLLAMA_NOPRUNE, '1');
  const f = fakeSpawn();
  const o = createOllama({ spawn: f.spawn, exists: () => true, env: {}, log: () => {} });
  o.start();
  assert.equal(f.calls[0].cmd, 'nice');
  assert.deepEqual(f.calls[0].args.slice(0, 2), ['-n', '10']);
  assert.equal(f.calls[0].args.at(-1), 'serve');
});

test('Ollama: 落ちたら間隔を延ばして起こし直し、止めた後は起こさない', () => {
  const f = fakeSpawn(), timers = [];
  let t = 0;
  const o = createOllama({ spawn: f.spawn, exists: () => true, env: {}, log: () => {}, now: () => t, setTimer: (fn, ms) => { timers.push(ms); return fn; }, clearTimer: () => {} });
  o.start(); f.calls[0].c.emit('exit', 1);
  assert.deepEqual(timers, [2000]);
  timers.length = 0; o.start(); f.calls[1].c.emit('exit', 1);
  assert.deepEqual(timers, [4000]);
  o.start(); o.stop();
  assert.equal(f.calls[2].c.killed, 'SIGTERM');
  f.calls[2].c.emit('exit', 0);
  assert.equal(f.calls.length, 3);
});

test('Ollama: 入っていない時・AIOFFICE_LIBRARY_SEMANTIC=off の時は起こさない', () => {
  for (const [exists, env] of [[false, {}], [true, { AIOFFICE_LIBRARY_SEMANTIC: 'off' }]]) {
    const f = fakeSpawn();
    const o = createOllama({ spawn: f.spawn, exists: () => exists, env, log: () => {} });
    o.start();
    assert.equal(f.calls.length, 0);
    assert.equal(o.enabled(), false);
  }
});
