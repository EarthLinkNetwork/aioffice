// 人が読む文に名詞の「件」を使わない（持ち主の裁定 2026-11-25「件」という語をシステム全体で使わない）。
// 数え方（「3 件」「件数」）と、別の語（件名・人件費・条件・要件 など）は除く。コードの注（// と *）は見ない。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { DICT } from '../plugins/office/src/i18n.mjs';

const OTHER_WORDS = /件名|件数|人件費|条件|案件|要件|用件|物件|事件/g;
// 数え方: 数か数の差し込み（{n}・0・)）のすぐ後の「件」（空白をはさむ物も）と、数の後ろに付ける単位だけの値（' 件'・'件'・' 件 / 全 '）
// 空白で始まる値（' 件を見る'）は、画面が数のすぐ後ろに付ける単位
const COUNTER = /[0-9０-９}\)]\s*件|^['"`>]?\s+件|^['"`>]?件(\s*\/[^'"`<]*)?\s*['"`<]?$/g;
const nounKen = s => String(s).replace(OTHER_WORDS, '').replace(COUNTER, '').includes('件');

test('画面の日本語の文（辞書の ja）に名詞の「件」が無い', () => {
  const bad = Object.entries(DICT.ja).filter(([, v]) => typeof v === 'string' && nounKen(v));
  assert.deepEqual(bad, []);
});

const SCREENS = readdirSync(new URL('../apps/mobile/src/screens/', import.meta.url)).filter(f => /\.tsx$/.test(f)).map(f => `apps/mobile/src/screens/${f}`);
const FILES = [
  'plugins/mobile/src/cards.mjs', 'plugins/mobile/src/ui.mjs', 'plugins/secretary/src/lib.mjs',
  'apps/mobile/src/notify/http.ts', 'apps/mobile/src/chat/logic.ts', ...SCREENS,
];
test('知らせ・アプリ・秘書の文の文字列に名詞の「件」が無い（前の版の印 CARD_PREFIX_OLD は読むためだけに残す）', () => {
  const bad = [];
  for (const f of FILES) {
    readFileSync(new URL(`../${f}`, import.meta.url), 'utf8').split('\n').forEach((line, i) => {
      if (/^\s*(\/\/|\*|\/\*)/.test(line) || line.includes('CARD_PREFIX_OLD')) return;
      const code = line.replace(/\s\/\/[^'"`]*$/, ''); // 行の終わりの注
      const strs = code.match(/'[^']*'|`[^`]*`|"[^"]*"|>[^<>{}]+</g) || [];
      for (const s of strs) if (nounKen(s.replace(/\$\{[^}]*\}/g, '0'))) bad.push(`${f}:${i + 1} ${s.slice(0, 60)}`);
    });
  }
  assert.deepEqual(bad, []);
});

// 担当の指示書（kit・public の外）: 担当がそのまま書く決まった文と、節の名前に名詞の「件」を使わない。
// 数え方（「3 件」「n 件」）と、前の版のアプリの印「判断の件から:」（受けるために書いてある）は除く。
// kit は公開の package の外なので、ある時だけ見る（公開の写しでは飛ばす）
const KIT = new URL('../../kit/', import.meta.url);
let kitFiles = [];
try { kitFiles = ['case-format.md', ...readdirSync(new URL('agents/', KIT)).filter(f => f.endsWith('.md')).map(f => `agents/${f}`)]; } catch { /* 公開の写し */ }
test('担当の指示書（kit）に名詞の「件」が無い', { skip: kitFiles.length === 0 }, () => {
  const bad = [];
  for (const f of kitFiles) {
    readFileSync(new URL(f, KIT), 'utf8').split('\n').forEach((line, i) => { if (nounKen(line.replace(/[0-9０-９nN]+\s*件/g, '').replace(/「判断の件から:」/g, ''))) bad.push(`kit/${f}:${i + 1} ${line.slice(0, 60)}`); });
  }
  assert.deepEqual(bad, []);
});
