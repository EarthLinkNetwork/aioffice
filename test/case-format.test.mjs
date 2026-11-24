// 判断の書き方（packages/aioffice/templates/case-format.{ja,en}.md）と、launcher がそれを全部の AI の担当に揃える処理（launcher/lib/case-format.mjs）の試験
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DICT } from '../plugins/office/src/i18n.mjs';
import { caseText, syncCaseFormat, CASE_MARK } from '../packages/aioffice/launcher/lib/case-format.mjs';
import { WORDS, ANY_CASE } from './company-words.mjs';

// 本文が使う 7 つの見出し（サブタスクの案 case_h_split は本文に無い・範囲の文書 やる事 6）
const HEADS = ['case_h_summary', 'case_h_ask', 'case_h_rec', 'case_h_why', 'case_h_evidence', 'case_h_did', 'case_h_notdid'];

for (const lang of ['ja', 'en']) {
  test(`${lang}: 見出しの語が画面（i18n の case_h_*）と同じで、目印で始まり終わる`, () => {
    const t = caseText(lang);
    assert.ok(t.startsWith(CASE_MARK.begin) && t.endsWith(CASE_MARK.end));
    for (const k of HEADS) assert.ok(t.includes(`\`## ${DICT[lang][k]}\``), `${k} = ${DICT[lang][k]}`);
    assert.ok(t.includes(DICT[lang].case_go_comment), '「推奨で進める」のコメントの文が画面と同じ');
  });
  test(`${lang}: 本文に特定の会社の語が無い`, () => {
    const t = caseText(lang);
    for (const w of WORDS) assert.ok(ANY_CASE.has(w) ? !t.toLowerCase().includes(w.toLowerCase()) : !t.includes(w), w);
  });
}
test('ja: 本文に名詞の「件」が無い', () => {
  assert.ok(!caseText('ja').replace(/件名|件数|条件|要件/g, '').includes('件'));
});

// 本体の口のまね: 会社 → 担当 → 指示書。書いた回数を数える
const fakePc = (agents, files) => {
  const writes = [];
  return {
    writes, files,
    companies: async () => [{ id: 'c1' }],
    agents: async () => agents,
    instructionsFile: async id => { if (files[id] === undefined) throw Object.assign(new Error('nf'), { status: 404 }); if (files[id] === 'ERR') throw Object.assign(new Error('boom'), { status: 500 }); return { content: files[id] }; },
    putInstructionsFile: async (id, content) => { writes.push(id); files[id] = content; },
  };
};
const count = (t, m) => t.split(m).length - 1;

test('揃える: 目印の無い指示書には 1 回だけ入り、2 回目は書かない', async () => {
  const pc = fakePc([{ id: 'a', adapterType: 'codex_local' }], { a: '# Desk\n本文\n' });
  const r1 = await syncCaseFormat(pc, { lang: 'ja' });
  assert.equal(r1.insert, 1); assert.equal(count(pc.files.a, CASE_MARK.begin), 1); assert.ok(pc.files.a.startsWith('# Desk\n本文'));
  const r2 = await syncCaseFormat(pc, { lang: 'ja' });
  assert.equal(r2.same, 1); assert.equal(pc.writes.length, 1); assert.equal(count(pc.files.a, CASE_MARK.begin), 1);
});

test('揃える: 古い本文は差し替わり、目印の外は変わらない', async () => {
  const pc = fakePc([{ id: 'a', adapterType: 'claude_local' }], { a: `前\n\n${CASE_MARK.begin}\n古い\n${CASE_MARK.end}\n\n後\n` });
  const r = await syncCaseFormat(pc, { lang: 'en' });
  assert.equal(r.replace, 1); assert.ok(!pc.files.a.includes('古い')); assert.ok(pc.files.a.startsWith('前\n\n') && pc.files.a.endsWith('\n\n後\n'));
  assert.ok(pc.files.a.includes(caseText('en')));
});

test('揃える: process の担当・やめた担当・指示書の無い担当・目印の壊れた指示書には書かない。読めない担当はほかを止めない', async () => {
  const agents = [{ id: 'p', adapterType: 'process' }, { id: 't', adapterType: 'codex_local', status: 'terminated' }, { id: 'n', adapterType: 'codex_local' }, { id: 'b', adapterType: 'codex_local' }, { id: 'e', adapterType: 'codex_local' }, { id: 'ok', adapterType: 'codex_local' }];
  const pc = fakePc(agents, { p: 'x', t: 'x', b: `${CASE_MARK.begin}\nだけ\n`, e: 'ERR', ok: 'y' });
  const r = await syncCaseFormat(pc, { lang: 'ja' });
  assert.deepEqual(pc.writes, ['ok']);
  assert.equal(r['no-agents-md'], 1); assert.equal(r['broken-marks'], 1); assert.equal(r.failed, 1); assert.equal(r.insert, 1);
  assert.equal(pc.files.p, 'x'); assert.equal(pc.files.n, undefined);
});
