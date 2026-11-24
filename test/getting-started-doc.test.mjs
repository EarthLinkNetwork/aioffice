// 始め方の記事（英日）のコマンドの行が、正式の置き場 RUN.txt と同じかを確かめる（記事に手で写した行がずれないように）
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { runLine } from './e2e/run-line.mjs';
import { DICT } from '../packages/aioffice/launcher/lib/i18n.mjs';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const DOCS = { en: 'docs/getting-started.md', ja: 'docs/getting-started.ja.md' };
// 言語の指定に関係なく、全部のコードの塊を拾う（手書きのコマンドを足したら落ちる）
const blocks = text => [...text.matchAll(/```[^\n]*\n([\s\S]*?)\n```/g)].map(m => m[1].trim());
// 画面の段の並びは setup.js の STEPS から読む（試験に手で書かない）
const STEPS = JSON.parse(/const STEPS = (\[[^\]]*\])/.exec(readFileSync(path.join(ROOT, 'packages/aioffice/launcher/public/setup.js'), 'utf8'))[1].replaceAll("'", '"'));

for (const [lang, file] of Object.entries(DOCS)) {
  const text = readFileSync(path.join(ROOT, file), 'utf8');
  test(`${lang}: 記事のコマンドの行は RUN.txt の start・open・update・restore・start-lan・start-tunnel・reset-owner と同じ順で同じ`, () => {
    assert.deepEqual(blocks(text), ['start', 'open', 'update', 'restore', 'start-lan', 'start-tunnel', 'reset-owner'].map(s => runLine(s).trim()));
  });
  test(`${lang}: 最初の持ち主の code の見方は RUN.txt の first-owner-code と同じ`, () => {
    assert.ok(text.includes('`' + runLine('first-owner-code').trim() + '`'));
  });
  test(`${lang}: 地の文の URL も RUN.txt の open と同じ（localhost の別の書き方をしない）`, () => {
    const prose = text.replace(/```[^\n]*\n[\s\S]*?\n```/g, '');
    const urls = prose.match(/https?:\/\/(?:localhost|127\.0\.0\.1)[^\s)`]*/g) || [];
    assert.ok(urls.length >= 1, '地の文に開く先の URL が無い');
    for (const u of urls) assert.equal(u, runLine('open').trim());
  });
  test(`${lang}: 記事の wizard の段の名前は画面の文と同じ（画面を変えたら記事も直す）`, () => {
    const d = DICT[lang];
    const order = STEPS.map(k => `step_${k}`);
    assert.ok(order.every(k => d[k]), '画面の文に無い段がある');
    assert.match(text, lang === 'en' ? new RegExp(`has ${['zero','one','two','three','four','five','six','seven','eight','nine','ten'][STEPS.length]} short steps`) : new RegExp(`短い ${STEPS.length} つの段`));
    const named = [...text.matchAll(/^\d+\. \*\*(.+?)\*\*/gm)].map(m => m[1]);
    assert.deepEqual(named, order.map(k => d[k]));
  });
}

test('README から英日の記事へ入れる（記事の file が在る）', () => {
  const readme = readFileSync(path.join(ROOT, 'README.md'), 'utf8');
  for (const f of Object.values(DOCS)) { assert.ok(readme.includes(`](${f})`), f); readFileSync(path.join(ROOT, f)); }
});
