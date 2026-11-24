// アプリの文字の欄がキーボードに隠れない（2026-11-16 実機で却下の理由が書けなかった）
// 下から出る小窓（Sheet）はキーボードの分だけ押し上げ、文字の欄のある画面の ScrollView はキーボードの分だけ巻き上げる
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

const APP = new URL('../apps/mobile/src/', import.meta.url).pathname;

test('下から出る小窓はキーボードを避ける（Modal の中を KeyboardAvoidingView で包む）', () => {
  const ui = readFileSync(join(APP, 'ui.tsx'), 'utf8');
  const sheet = ui.slice(ui.indexOf('export function Sheet'), ui.indexOf('export function Toast'));
  assert.ok(sheet.length > 0);
  assert.match(sheet, /<Modal[\s\S]*<KeyboardAvoidingView behavior=\{Platform\.OS === 'ios' \? 'padding'[\s\S]*\{children\}[\s\S]*<\/KeyboardAvoidingView>[\s\S]*<\/Modal>/);
});

test('文字の欄のある画面は、どの ScrollView もキーボードを避ける（KeyboardAvoidingView の中か、巻き上げの指定がある）', () => {
  const dir = join(APP, 'screens');
  for (const f of readdirSync(dir).filter(x => x.endsWith('.tsx'))) {
    const src = readFileSync(join(dir, f), 'utf8');
    if (!/<TextInput\b/.test(src)) continue;
    if (/<KeyboardAvoidingView\b/.test(src)) continue; // 話す画面のように画面ごと避けている
    const views = src.match(/<ScrollView\b[^]*?>/g) || [];
    assert.ok(views.length > 0, f);
    for (const v of views) assert.match(v, /automaticallyAdjustKeyboardInsets/, `${f}: ${v.slice(0, 60)}`);
  }
});

test('小窓の理由の欄は高さに上限があり、長く書いても小窓の題が画面の上に切れない（独立レビュー P3-1）', () => {
  const src = readFileSync(join(APP, 'screens', 'Detail.tsx'), 'utf8');
  const inputs = src.match(/<TextInput value=\{why\}[^]*?\/>/g) || [];
  assert.equal(inputs.length, 2);
  for (const i of inputs) assert.match(i, /maxHeight: 160/);
});
