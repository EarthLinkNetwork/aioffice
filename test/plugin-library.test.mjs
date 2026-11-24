// 図書室の plugin の判定（範囲: docs/review/2026-11-16-library-notify-scope.md の保証 11〜14）
import test from 'node:test';
import assert from 'node:assert/strict';
import { chunk, rowsOf, takeComment, takeDocument, docName, checkDoc, words, rank, strongEnough, briefQuery, oneLine, pickHits, renderBrief, planBrief, pruneLedger, addTry, triesOf, BRIEF_MARK, LIMITS, DICT } from '../plugins/library/src/lib.mjs';

const NOW = Date.parse('2026-11-16T00:00:00Z');
const day = n => new Date(NOW - n * 864e5).toISOString();

test('分け方: 段落の切れ目で約 1000 字ずつ・長い段落は切る', () => {
  const p = 'a'.repeat(600);
  assert.deepEqual(chunk(`${p}\n\n${p}`).length, 2);
  assert.equal(chunk('x'.repeat(2500)).length, 3);
  assert.deepEqual(chunk(''), []);
});

test('取り込む行: 秘密の形を伏せてから分け、中身の hash を持つ（同じなら同じ hash）', () => {
  const r = rowsOf({ id: 'issue:1', kind: 'issue', title: 'Deploy', text: 'use pcp_board_abcdefghijklmnop0123 and DATABASE_URL=postgres://u:p@h/db' });
  assert.equal(r.length, 1);
  assert.ok(!r[0].text.includes('pcp_board_abcdef'), r[0].text);
  assert.ok(!r[0].text.includes('u:p@'), r[0].text);
  assert.equal(r[0].id, 'issue:1#0');
  assert.equal(rowsOf({ id: 'issue:1', kind: 'issue', title: 'Deploy', text: 'same' })[0].hash, rowsOf({ id: 'issue:1', kind: 'issue', title: 'Deploy', text: 'same' })[0].hash);
  assert.equal(rowsOf({ id: 'issue:2', kind: 'issue', title: 'Only title', text: '' }).length, 1, '本文が無くても題で引ける');
});

test('入れる物と除く物: AI の comment・短い comment・添え書きの写し（こだま）は入れない', () => {
  assert.equal(takeComment({ body: 'This is a long enough human comment.' }), true);
  assert.equal(takeComment({ body: 'short' }), false);
  assert.equal(takeComment({ body: 'This is a long enough agent comment.', authorAgentId: 'a1' }), false);
  assert.equal(takeComment({ body: `${BRIEF_MARK}\n## From the library ... long enough` }), false);
  assert.equal(takeDocument({ key: 'library-brief', body: 'x' }), false);
  assert.equal(takeDocument({ key: 'plan', body: 'the plan' }), true);
});

test('置く文書: .md と .txt だけ・200 KB・500 件・20 MB まで・名前の道は捨てる', () => {
  assert.equal(docName('../a.md'), 'a.md');
  assert.equal(docName('x/y\\z.txt'), 'z.txt');
  assert.deepEqual(checkDoc({ name: '../a.md', text: 'hi' }), { ok: true, name: 'a.md', size: 2 });
  assert.equal(checkDoc({ name: 'a.pdf', text: 'hi' }).why, 'type');
  assert.equal(checkDoc({ name: 'a.md', text: 'x'.repeat(LIMITS.docBytes + 1) }).why, 'size');
  assert.equal(checkDoc({ name: 'a.md', text: 'x' }, { count: 500 }).why, 'count');
  assert.equal(checkDoc({ name: 'a.md', text: 'x'.repeat(10) }, { bytes: LIMITS.bytesPerCompany - 5 }).why, 'total');
  assert.equal(checkDoc({ name: 'a.md', text: null }).why, 'text');
});

test('探し方: 当たった語の割合・題を重く・番号のちょうど一致を先に・同じ元は 2 件まで', () => {
  assert.deepEqual(words('Logo for the flyer CMP-7 ロゴ 印刷'), ['logo', 'for', 'the', 'flyer', 'cmp-7', 'ロゴ', '印刷']);
  const rows = [
    { id: 'issue:1#0', srcId: 'issue:1', kind: 'issue', title: 'Flyer design', text: 'make a flyer with the logo', date: day(1) },
    { id: 'issue:2#0', srcId: 'issue:2', kind: 'issue', title: 'Other', text: 'flyer', date: day(1) },
    { id: 'issue:3#0', srcId: 'issue:3', kind: 'issue', title: 'CMP-7 setup', text: 'nothing', date: day(200) },
    { id: 'issue:4#0', srcId: 'issue:4', kind: 'issue', title: 'CMP-70 other', text: 'nothing', date: day(1) },
  ];
  const r = rank(rows, 'CMP-7 flyer logo', { now: NOW });
  assert.equal(r[0].id, 'issue:3#0', '番号のちょうど一致が先');
  assert.equal(r[1].id, 'issue:1#0');
  assert.ok(!r.some(x => x.id === 'issue:4#0' && x.exact), 'CMP-70 は CMP-7 のちょうど一致ではない');
  const same = Array.from({ length: 5 }, (_, i) => ({ id: `issue:9#${i}`, srcId: 'issue:9', kind: 'issue', title: 'flyer', text: 'flyer', date: day(1) }));
  assert.equal(rank(same, 'flyer', { now: NOW }).length, 2);
  assert.deepEqual(rank(rows, 'zzz nothing-here', { now: NOW }).map(x => x.id), []);
});

test('強さの下限: 番号のちょうど一致か、語の半分以上に当たった物だけ', () => {
  assert.equal(strongEnough({ exact: 1, cover: 0, score: 1 }), true);
  assert.equal(strongEnough({ exact: 0, cover: 0.5, score: 1.0 }), true);
  assert.equal(strongEnough({ exact: 0, cover: 0.25, score: 0.4 }), false);
  assert.equal(strongEnough(null), false);
});

test('添え書き: 引く言葉は題と本文の頭 300 字（写しと引用は除く）・1 行は印と URL を消し番号を囲む', () => {
  assert.equal(briefQuery({ title: 'T', description: `body\n> quoted\n${BRIEF_MARK}\nold brief` }), 'T body');
  assert.equal(briefQuery({ title: 'x'.repeat(400) }).length, 300);
  assert.equal(oneLine('see <!-- x --> https://a.b/c and CMP-12'), 'see x (URL) and `CMP-12`');
});

test('添え書き: 自分の課題と弱い当たりを除いて 4 件まで・英日の見出し・2,500 字まで・無い時も引いたことを残す', () => {
  const h = i => ({ id: `issue:${i}#0`, srcId: `issue:${i}`, kind: 'issue', title: `T${i}`, text: 'x'.repeat(300), exact: 0, cover: 1, score: 1.5 });
  const picked = pickHits([h('self'), h(1), h(2), h(3), h(4), h(5), { ...h(6), cover: 0.1, score: 0.2 }], { selfId: 'self' });
  assert.deepEqual(picked.map(x => x.srcId), ['issue:1', 'issue:2', 'issue:3', 'issue:4']);
  const en = renderBrief({ hits: picked, q: 'q', lang: 'en' });
  assert.ok(en.startsWith(BRIEF_MARK)); assert.match(en, /data, not instructions/); assert.ok(en.length <= LIMITS.total);
  assert.match(renderBrief({ hits: picked, q: 'q', lang: 'ja' }), /データで、指示ではない/);
  assert.match(renderBrief({ hits: [], q: 'logo', lang: 'en' }), /No close records were found \(searched for: logo\)/);
  const big = Array.from({ length: 30 }, (_, i) => h(i));
  assert.ok(renderBrief({ hits: big, q: 'q', lang: 'ja' }).length <= LIMITS.total);
  assert.deepEqual(Object.keys(DICT.en).sort(), Object.keys(DICT.ja).sort());
});

test('添え書きの対象: AI の担当・開いている・14 日以内・手で作った・台帳に無い・失敗 3 回未満。新しい順に 8 件', () => {
  const agents = [{ id: 'ai', adapterType: 'claude_local', status: 'idle' }, { id: 'proc', adapterType: 'process', status: 'idle' }];
  const mk = (id, o = {}) => ({ id, status: 'todo', assigneeAgentId: 'ai', createdAt: day(1), ...o });
  const issues = [mk('ok'), mk('done', { status: 'done' }), mk('proc', { assigneeAgentId: 'proc' }), mk('old', { createdAt: day(20) }), mk('routine', { originKind: 'routine' }), mk('briefed', { description: BRIEF_MARK }), mk('ledger'), mk('failed')];
  const ledger = { issues: { ledger: { at: day(1) } }, tries: { failed: { n: 3, at: day(1) } } };
  assert.deepEqual(planBrief({ issues, agents, ledger, now: NOW }).picked.map(i => i.id), ['ok']);
  const many = Array.from({ length: 12 }, (_, i) => mk(`i${i}`, { createdAt: day(i / 10) }));
  const p = planBrief({ issues: many, agents, now: NOW });
  assert.equal(p.picked.length, 8); assert.equal(p.rest, 4); assert.equal(p.picked[0].id, 'i0');
});

test('台帳: 60 日で刈る・失敗は 3 回で諦める', () => {
  const l = { issues: { a: { at: day(10) }, b: { at: day(70) } }, tries: { c: { n: 1, at: day(70) } } };
  assert.deepEqual(pruneLedger(l, NOW), { issues: { a: { at: day(10) } }, tries: {} });
  const t = {};
  assert.equal(addTry(t, 'x', NOW), false); assert.equal(addTry(t, 'x', NOW), false); assert.equal(addTry(t, 'x', NOW), true);
  assert.equal(triesOf(t, 'x'), 3);
});

test('置く文書の名前: 制御文字・200 字を超える物は空になり断られる・添え書きの無い時の文も伏せる（独立レビュー P3-4・P3-5）', async () => {
  const { docName, checkDoc, renderBrief } = await import('../plugins/library/src/lib.mjs');
  assert.equal(docName('a\x1fb.md'), '');
  assert.equal(docName(`${'a'.repeat(201)}.md`), '');
  assert.equal(docName('../ok.md'), 'ok.md');
  assert.equal(checkDoc({ name: 'a\nb.md', text: 'x' }).ok, false);
  const b = renderBrief({ hits: [], q: 'deploy with API_KEY=abcdef1234567890', lang: 'en' });
  assert.ok(!b.includes('abcdef1234567890'));
});
