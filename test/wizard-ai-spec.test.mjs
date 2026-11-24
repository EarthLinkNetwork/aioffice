import fs from 'node:fs';
// 承認済みの仕様の固定（2026-11-17 承認: wizard の最初に使う AI を選んで、社員ごとに割り当てる）
// wizard が「つなぐ AI を 1 つに決めた形」に戻ったり、選べない形のまま記事や手順が書かれたりしたら、ここで落ちる。
// 画面の段の並びは setup.js の STEPS から読む（試験に手で書かない）
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DICT } from '../packages/aioffice/launcher/lib/i18n.mjs';
import { catalogEntry } from '../packages/aioffice/launcher/lib/ai-catalog.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const setup = readFileSync(path.join(ROOT, 'packages/aioffice/launcher/public/setup.js'), 'utf8');
const STEPS = JSON.parse(/const STEPS = (\[[^\]]*\])/.exec(setup)[1].replaceAll("'", '"'));

test('wizard に「使う AI を選ぶ」段があり、秘書とほかの担当の段より前にある', () => {
  assert.ok(STEPS.includes('ai'), `STEPS に ai が無い: ${STEPS.join(',')}`);
  assert.ok(STEPS.indexOf('ai') < STEPS.indexOf('secretary'), '秘書の段より前');
  assert.ok(STEPS.indexOf('ai') < STEPS.indexOf('agents'), 'ほかの担当の段より前');
  assert.ok(!STEPS.includes('codex'), 'Codex だけをつなぐ段は残さない（選ぶ段の中でつなぐ）');
});

test('選ぶ段で ChatGPT と Claude の両方を選べる（どちらか 1 つに決め打ちしない）', () => {
  // 画面の key の表に両方があり、AI の段は行ごとに data-ai を付けて出す
  const keys = /const AI_KEY = (\{[^}]*\})/.exec(setup)?.[1] || '';
  for (const [type, ai] of [['codex_local', 'chatgpt'], ['claude_local', 'claude']]) assert.match(keys, new RegExp(`${type}: '${ai}'`), `${ai} の選択肢が無い`);
  assert.match(setup, /'data-ai': key/, 'AI の行に data-ai が無い');
  for (const type of ['codex_local', 'claude_local']) assert.equal(catalogEntry(type)?.include, true, `${type} を選べない`);
});

test('ほかの担当の段で、担当ごとに使う AI を選べる', () => {
  assert.match(setup, /data-agent-ai/, '担当ごとの AI の選択が無い');
});

test('選ぶ段の文は英語と日本語の両方にある', () => {
  for (const lang of ['en', 'ja']) for (const k of ['step_ai', 'ai_chatgpt', 'ai_claude']) assert.ok(DICT[lang]?.[k], `${lang}.${k} が無い`);
});

test('ai_ の文言は全部、英語と日本語の両方にある', () => {
  const keys = Object.keys(DICT.en).filter(k => k.startsWith('ai_') || k === 'step_ai' || k === 'agent_ai');
  assert.ok(keys.length >= 20, `ai の文言が少ない: ${keys.length}`);
  for (const k of keys) assert.ok(DICT.ja[k], `ja.${k} が無い`);
});

test('完了した利用者は done のまま、AI を選んでいない途中の利用者は ai の段へ戻す（前の版の data）', () => {
  const src = /const firstOpen = (s => \([^;]*\));/.exec(setup)[1];
  const firstOpen = eval(src);
  const base = { langSet: true, hasOwner: true, authed: true, company: { id: 'c1' } };
  assert.equal(firstOpen({ ...base, secretaryId: 'a1', done: true }), 'done');
  assert.equal(firstOpen({ ...base, secretaryId: 'a1', ai: { chosen: false } }), 'ai');
  assert.equal(firstOpen({ ...base, ai: { chosen: true } }), 'secretary');
  assert.equal(firstOpen({ ...base, secretaryId: 'a1', ai: { chosen: true } }), 'agents');
});

test('AI の段: つなぐ途中の部品は 1 行目の横並びに入れず、下の段（ai-panel）に縦に並べる・code の欄は全部見える textarea で文字数を出す', () => {
  assert.match(setup, /class: 'ai-panel'/);
  assert.match(setup, /el\('textarea', \{ id: 'ai-code'/);
  assert.match(setup, /ai_code_count/);
  const css = fs.readFileSync(new URL('../packages/aioffice/launcher/public/setup.css', import.meta.url), 'utf8');
  assert.match(css, /main \{ max-width: (\d+)px/);
  assert.ok(Number(css.match(/main \{ max-width: (\d+)px/)[1]) >= 800, '画面を狭く使わない');
  assert.match(css, /\.ai-panel \{ display: flex; flex-direction: column/);
  assert.match(css, /@media \(max-width: 560px\) \{ section\.card > \.row \{ flex-direction: column; \}/, 'スマホの幅では段の下のボタンを縦に並べる');
  assert.match(css, /section\.card > \.row > span:empty \{ display: none; \}/, '縦に並べた時に空の置き場の隙間を出さない');
  assert.match(css, /section\.card > \.row > a\.btn \{ text-align: center; \}/, '全部の幅に広がったリンクのボタンも字を中央に置く（完了の段）');
});

test('断られた・答えが無い時の文言が英日にある', () => {
  for (const k of ['ai_code_rejected', 'ai_login_timeout', 'ai_retry', 'ai_code_count', 'ai_checking_note']) { assert.ok(DICT.en[k], k); assert.ok(DICT.ja[k], k); }
  assert.ok(DICT.en.ai_code_count.includes('{n}') && DICT.ja.ai_code_count.includes('{n}'));
});
