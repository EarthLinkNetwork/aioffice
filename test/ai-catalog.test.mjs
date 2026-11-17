// wizard で選べる AI の表の試験。範囲: docs/review/2026-11-17-wizard-ai-choice-scope.md の保証 1・3・5・7
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { unknownTypes } from '../packages/aioffice/launcher/lib/check-adapters.mjs';
import { AI_CATALOG, NON_ADAPTER_PACKAGES, aiChoices, agentAdapterConfig, catalogEntry } from '../packages/aioffice/launcher/lib/ai-catalog.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const lock = JSON.parse(readFileSync(path.join(ROOT, 'packages/aioffice/runtime/package-lock.json'), 'utf8'));
const dockerfile = readFileSync(path.join(ROOT, 'packages/aioffice/Dockerfile'), 'utf8');

test('lock にある adapter の package は全部、表のどれかの行が持つ（Paperclip の更新で増えたら落ちる）', () => {
  const pkgs = Object.keys(lock.packages)
    .filter(k => k.split('node_modules/').length === 2)
    .map(k => k.replace('node_modules/', ''))
    .filter(n => /^@paperclipai\/adapter-/.test(n) && !NON_ADAPTER_PACKAGES.includes(n));
  assert.ok(pkgs.length >= 9, `lock の adapter が少なすぎる: ${pkgs.join(',')}`);
  const known = new Set(AI_CATALOG.map(e => e.pkg).filter(Boolean));
  const missing = pkgs.filter(p => !known.has(p));
  assert.deepEqual(missing, [], `表に無い adapter の package: ${missing.join(',')}（lib/ai-catalog.mjs に載せるか外す理由を書く）`);
});

test('表の型は重複せず、外す行には理由がある', () => {
  const types = AI_CATALOG.map(e => e.type);
  assert.equal(new Set(types).size, types.length);
  for (const e of AI_CATALOG.filter(e => !e.include)) assert.ok(e.reason, `${e.type} に外す理由が無い`);
  for (const e of AI_CATALOG.filter(e => e.include)) {
    assert.ok(e.install && e.bin && e.login, `${e.type} の入れ方・CLI・つなぎ方が無い`);
    assert.ok(e.name.en && e.name.ja, `${e.type} の名前が英日に無い`);
  }
});

test('依頼で名指しされた AI（Claude Code・Codex・Grok・Kimi・Gemini・Cursor）は選べる', () => {
  for (const t of ['claude_local', 'codex_local', 'grok_local', 'kimi_local', 'gemini_local', 'cursor']) assert.equal(catalogEntry(t)?.include, true, t);
});

test('表に無い型は wizard に「出るが選べない」で出し、外す型は出さない', () => {
  const c = aiChoices([{ type: 'codex_local' }, { type: 'muse_local', label: 'Muse' }, { type: 'process' }, { type: 'gemini_local', disabled: true }]);
  assert.deepEqual(c.map(x => [x.type, x.selectable]), [['codex_local', true], ['muse_local', false]]);
});

test('claude の担当は engine cli で、CLI は /data/aitools の絶対パス', () => {
  const cfg = agentAdapterConfig('claude_local');
  assert.equal(cfg.engine, 'cli');
  assert.equal(cfg.command, '/data/aitools/claude_local/node_modules/.bin/claude');
  assert.equal(agentAdapterConfig('cursor').command, '/data/aitools/cursor/home/.local/bin/agent');
});

test('資格の置き場は volume（/data/aitools）に向く', () => {
  assert.deepEqual(agentAdapterConfig('grok_local').env, { GROK_HOME: '/data/aitools/grok_local/home' });
  assert.deepEqual(agentAdapterConfig('cursor').env, { HOME: '/data/aitools/cursor/home' });
});

test('image に Claude Code・Cursor の CLI を入れない', () => {
  assert.doesNotMatch(dockerfile, /@anthropic-ai\/claude-code|cursor\.com\/install/);
});

test('build の照合: 表に無い型（Muse など）があれば名前を返し、image の build で落とす', () => {
  assert.deepEqual(unknownTypes(new Set(['codex_local', 'muse_local', 'process'])), ['muse_local']);
  assert.deepEqual(unknownTypes(new Set(AI_CATALOG.map(e => e.type))), []);
  assert.match(dockerfile, /RUN node \/opt\/aioffice\/launcher\/lib\/check-adapters\.mjs/);
});
