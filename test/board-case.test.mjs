// 件のページの計算（設計 docs/design/2026-11-24-secretary-conversation-kanban.md §4.1）
import test from 'node:test';
import assert from 'node:assert/strict';
import { SECTIONS, headingTable, parseCase, pickCase, chatItems, checkSay, caseIdFrom, caseHref, deskSplit, laterAfter, LATER_HOURS, excerptOf, EXCERPT_MAX, parseProposalList, proposalsOf, hideJson, doComment } from '../plugins/board/src/case-lib.mjs';
import { createApi } from '../plugins/office/src/api.mjs';
import { DICT } from '../plugins/office/src/i18n.mjs';
import { parseProposals } from '../plugins/secretary/src/lib.mjs';

const T = headingTable(DICT);

test('見出しの表: 7 つの節に英語と日本語の語がある', () => {
  for (const k of SECTIONS) assert.equal(T[k].length, 2, k);
  assert.deepEqual(T.ask, [DICT.en.case_h_ask.toLowerCase(), DICT.ja.case_h_ask]);
});

test('節を取り出す: 日本語の見出し（## の形）', () => {
  const p = parseCase(`前置きの文\n\n## 概要\nドメインが 12/1 に切れます。\n\n## 決めてほしい事\n更新しますか、手放しますか。\n\n## 私なら\n手放します。\n\n## なぜなら\n1 年以上使っていません。\n2 行目。\n\n## 根拠\nWHOIS`, T);
  assert.deepEqual(Object.keys(p), ['summary', 'ask', 'rec', 'why', 'evidence']);
  assert.equal(p.ask, '更新しますか、手放しますか。');
  assert.equal(p.why, '1 年以上使っていません。\n2 行目。');
});

test('節を取り出す: 英語・太字・同じ行に続く形・全角のコロン', () => {
  const p = parseCase('**Summary**: The grant was approved.\n**Decision needed**: Apply or not?\nMy recommendation: Apply.\nなぜなら：費用は払い済みです。', T);
  assert.deepEqual(p, { summary: 'The grant was approved.', ask: 'Apply or not?', rec: 'Apply.', why: '費用は払い済みです。' });
});

test('件の形でない文は null（決めてほしい事が無い・文の途中の語は見出しにしない）', () => {
  assert.equal(parseCase('## 概要\n知らせだけです。', T), null);
  assert.equal(parseCase('この件の概要 を後で書きます\n決めてほしい事 はありません', T), null);
  assert.equal(parseCase('', T), null);
  assert.equal(parseCase(null, T), null);
});

test('知らない見出しで節を閉じる', () => {
  const p = parseCase('## 決めてほしい事\nA か B か。\n## 雑記\nここは入れない。', T);
  assert.equal(p.ask, 'A か B か。');
});

test('件の中身: 担当の一番新しい件の形のコメント → 無ければ本文 → 無ければ null', () => {
  const issue = { id: 'i', description: '## 決めてほしい事\n本文の問い', updatedAt: '2026-11-20T00:00:00Z' };
  const cs = [
    { id: 'c1', authorAgentId: 'ag', body: '## 決めてほしい事\n古い問い', createdAt: '2026-11-21T00:00:00Z' },
    { id: 'c2', authorAgentId: 'ag', body: '## 決めてほしい事\n新しい問い\n## 私なら\nこうします', createdAt: '2026-11-22T00:00:00Z' },
    { id: 'c3', authorUserId: 'u', body: '## 決めてほしい事\n人の文は件にしない', createdAt: '2026-11-23T00:00:00Z' },
    { id: 'c4', authorAgentId: 'ag', body: '進めています。', createdAt: '2026-11-23T01:00:00Z' },
    { id: 'c5', authorAgentId: 'ag', body: '## 決めてほしい事\n消した問い', createdAt: '2026-11-24T00:00:00Z', deletedAt: '2026-11-24T00:01:00Z' },
  ];
  const k = pickCase(issue, cs, T);
  assert.deepEqual([k.from, k.commentId, k.ask, k.rec], ['comment', 'c2', '新しい問い', 'こうします']);
  assert.deepEqual([pickCase(issue, [], T).from, pickCase(issue, [], T).ask], ['description', '本文の問い']);
  assert.equal(pickCase({ id: 'i', description: 'ただの文' }, [cs[3]], T), null);
});

test('会話: 古い順・消した物と空を出さない・担当と人を分ける', () => {
  const items = chatItems([
    { id: 2, authorUserId: 'u', body: '更新しないで', createdAt: '2026-11-22T00:00:00Z' },
    { id: 1, authorAgentId: 'ag', body: '確かめました', createdAt: '2026-11-21T00:00:00Z' },
    { id: 3, authorAgentId: 'ag', body: '消した', createdAt: '2026-11-23T00:00:00Z', deletedAt: 'x' },
    { id: 4, authorAgentId: 'ag', body: '   ', createdAt: '2026-11-23T00:00:00Z' },
  ]);
  assert.deepEqual(items.map(i => [i.id, i.who]), [['1', 'agent'], ['2', 'person']]);
  const cs = [{ id: 1, authorUserId: 'u1', body: 'a', createdAt: '1' }, { id: 2, authorUserId: 'u2', body: 'b', createdAt: '2' }, { id: 3, body: 'c', createdAt: '3' }];
  assert.deepEqual(chatItems(cs, 'u1').map(i => i.who), ['me', 'person', 'person']);
  assert.deepEqual(chatItems(cs, '').map(i => i.who), ['person', 'person', 'person']);
});

test('送る文: 空は送らない・4,000 字まで', () => {
  assert.deepEqual(checkSay('  はい  '), { ok: true, body: 'はい' });
  assert.equal(checkSay('   ').why, 'empty');
  assert.equal(checkSay('a'.repeat(4001)).why, 'long');
});

test('件の id: URL の ?case= から読む・変な値は読まない', () => {
  assert.equal(caseIdFrom('?case=6f1a066b-2c65-4a1b-9d0e-000000000001'), '6f1a066b-2c65-4a1b-9d0e-000000000001');
  assert.equal(caseIdFrom('?x=1'), null);
  assert.equal(caseIdFrom('?case=../../etc'), null);
  assert.equal(caseIdFrom('?case=' + 'a'.repeat(81)), null);
  assert.equal(caseHref('/ACM/board', 'abc'), '/ACM/board?case=abc');
  assert.equal(caseHref('/ACM/board', null), '/ACM/board');
});

test('API: コメントを読む・書く口', async () => {
  const calls = [];
  const api = createApi(async (url, init) => { calls.push([init.method, url, init.body]); return { ok: true, status: 200, json: async () => [] }; });
  await api.comments('i/1'); await api.addComment('i/1', 'はい');
  assert.deepEqual(calls, [['GET', '/api/issues/i%2F1/comments', undefined], ['POST', '/api/issues/i%2F1/comments', '{"body":"はい"}']]);
});

test('節を取り出す: 同じ見出しは先の方・コード囲みの中は見出しにしない・番号つきの見出し', () => {
  const p = parseCase('## 概要\n本物の概要\n## 決めてほしい事\n本物の問い\n## 根拠\n引用です\n概要: 古い話\n決めてほしい事: 古い問い', T);
  assert.deepEqual([p.summary, p.ask, p.evidence], ['本物の概要', '本物の問い', '引用です']);
  const q = parseCase('## 決めてほしい事\nA か B か。\n```sh\n# 注釈\necho 1\n```\n後ろの文', T);
  assert.equal(q.ask, 'A か B か。\n```sh\n# 注釈\necho 1\n```\n後ろの文');
  const r = parseCase('1. **概要**: X です\n2. **決めてほしい事**: A にしますか', T);
  assert.deepEqual(r, { summary: 'X です', ask: 'A にしますか' });
});

test('秘書の画面: 確認待ちを新しい順に・後回しを除く・進行中は別に', () => {
  const r = (id, column, updatedAt) => ({ id, column, issue: { id, updatedAt } });
  const rows = [r('a', 'review', '2026-11-20'), r('b', 'review', '2026-11-22'), r('c', 'doing', '2026-11-21'), r('d', 'todo', '2026-11-23'), r('e', 'review', '2026-11-21')];
  const now = Date.parse('2026-11-24T00:00:00Z');
  const s = deskSplit(rows, { e: now + 1000, a: now - 1000 }, now);
  assert.deepEqual(s.decide.map(x => x.id), ['b', 'a']);
  assert.deepEqual(s.later.map(x => x.id), ['e']);
  assert.deepEqual(s.going.map(x => x.id), ['c']);
  assert.deepEqual(deskSplit(null).decide, []);
});

test('後で: 押した件を 20 時間隠す・過ぎた記録は捨てる', () => {
  const now = 1000000;
  const v = laterAfter({ old: now - 1, keep: now + 5 }, 'x', now);
  assert.deepEqual(v, { keep: now + 5, x: now + LATER_HOURS * 3600000 });
  assert.deepEqual(laterAfter({ old: now - 1 }, null, now), {});
});

test('形の無い件の文: 担当の一番新しいコメントの冒頭・無ければ本文・280 字まで', () => {
  const cs = [{ authorAgentId: 'a', body: '古い', createdAt: '1' }, { authorAgentId: 'a', body: '新しい\n\n\n\n続き', createdAt: '3' }, { authorUserId: 'u', body: '人の文', createdAt: '4' }, { authorAgentId: 'a', body: '消した', createdAt: '5', deletedAt: 'x' }];
  assert.equal(excerptOf({ description: '本文' }, cs), '新しい\n\n続き');
  assert.equal(excerptOf({ description: '本文' }, []), '本文');
  assert.equal(excerptOf({}, null), '');
  const long = excerptOf({ description: 'あ'.repeat(400) }, []);
  assert.equal(long.length, EXCERPT_MAX + 1);
  assert.ok(long.endsWith('…'));
});

test('秘書の提案: 秘書の plugin と同じ読み方（同じ入力で題・中身・根拠が同じ）', () => {
  const bodies = [
    '1. A を確かめます\n```json\n{"proposals":[{"title":"A を確かめる","detail":"なぜなら…  ","evidence":["ACM-1","", 3],"deep":true},{"title":"  ","detail":"題なし"},{"title":"B"}]}\n```',
    '```json\n[{"title":"配列の形"}]\n```',
    '```json\n{"proposals":[{"title":"件の形","detail":"起きた事","ask":" 決めてほしい事 ","recommend":"私なら","why":"事情","evidence":["x"]},{"title":"型違い","ask":3,"why":null}]}\n```',
    '```json\n{"x":1}\n```', '```json\nこわれた\n```', '囲みなし', '',
    '古い\n```json\n{"proposals":[{"title":"古い"}]}\n```\n新しい\n```json\n{"proposals":[{"title":"新しい"}]}\n```',
  ];
  for (const b of bodies) {
    const theirs = parseProposals(b), mine = parseProposalList(b);
    assert.deepEqual(mine, theirs ? theirs.map(({ title, detail, ask, recommend, why, evidence }) => ({ title, detail, ask, recommend, why, evidence })) : null, b.slice(0, 30));
  }
});

test('秘書の提案: 見回りの課題の秘書本人のコメントだけ・新しい回が空なら古い提案を出さない', () => {
  const round = { originKind: 'plugin:aioffice.secretary:round', assigneeAgentId: 'sec' };
  const j = t => '```json\n{"proposals":[' + (t ? `{"title":"${t}","detail":"d"}` : '') + ']}\n```';
  const cs = [{ authorAgentId: 'sec', body: j('古い'), createdAt: '1' }, { authorAgentId: 'sec', body: j('新しい'), createdAt: '2' }, { authorAgentId: 'sec', body: '進めます', createdAt: '3' },
    { authorAgentId: 'other', body: j('他の担当'), createdAt: '4' }, { authorUserId: 'u', body: j('人の文'), createdAt: '5' }];
  assert.deepEqual(proposalsOf(round, cs), [{ title: '新しい', detail: 'd', ask: '', recommend: '', why: '', evidence: [] }]);
  assert.equal(proposalsOf({ originKind: 'manual', assigneeAgentId: 'sec' }, cs), null);
  assert.equal(proposalsOf({ originKind: round.originKind }, cs), null);
  assert.equal(proposalsOf(round, [...cs, { authorAgentId: 'sec', body: j(''), createdAt: '6' }]), null);
  assert.equal(proposalsOf(round, [cs[2]]), null);
});

test('json の囲み: 提案の囲みだけを人に見せない・他の json は残す・進める一言', () => {
  assert.equal(hideJson('1. 提案です\n\n```json\n{"proposals":[]}\n```\n'), '1. 提案です');
  assert.equal(hideJson('設定の例:\n```json\n{"a":1}\n```'), '設定の例:\n```json\n{"a":1}\n```');
  assert.equal(hideJson('例\n```json\n{"a":1}\n```\n提案\n```json\n{"proposals":[{"title":"t"}]}\n```'), '例\n```json\n{"a":1}\n```\n提案');
  assert.equal(excerptOf({ description: '本文' }, [{ authorAgentId: 'a', body: '```json\n{"proposals":[]}\n```', createdAt: '1' }]), '本文');
  assert.equal(excerptOf({}, [{ authorAgentId: 'a', body: '文\n```json\n{"proposals":[]}\n```', createdAt: '1' }]), '文');
  assert.equal(doComment(DICT.ja.desk_do_comment, 2, '題'), '提案 2「題」を進めてください。');
  assert.equal(doComment('{n}: {title}', 1, 'x$&y {title} {n}'), '1: x$&y {title} {n}');
  for (const lang of ['en', 'ja']) assert.match(DICT[lang].desk_do_comment, /\{n\}.*\{title\}/);
});

test('独立レビュー 2026-11-24: 提案でない json は消さない・件の欄に提案の json を入れない・長い空白の行で固まらない', async () => {
  const lib = await import('../plugins/board/src/case-lib.mjs');
  const { DICT } = await import('../plugins/office/src/i18n.mjs');
  const table = lib.headingTable(DICT);
  assert.match(lib.hideJson('対象の id です:\n```json\n["ACM-1","ACM-2"]\n```'), /ACM-1/);
  assert.match(lib.hideJson('設定:\n```json\n[{"name":"x","port":1}]\n```'), /port/);
  assert.match(lib.hideJson('結果:\n```json\n{"proposals":[],"total":0}\n```'), /total/);
  assert.equal(lib.hideJson('なし\n```json\n{"proposals":[]}\n```'), 'なし');
  assert.equal(lib.hideJson('1. x\n```json\n{"proposals":[{"title":"x"}]}\n```'), '1. x');
  const c = lib.pickCase({}, [{ id: 'c1', authorAgentId: 'a', createdAt: '2026-11-24T00:00:00Z', body: '概要: s\n決めてほしい事: q\nなぜなら: 使っていません\n\n```json\n{"proposals":[{"title":"x"}]}\n```' }], table);
  assert.equal(c.why, '使っていません');
  const t0 = Date.now();
  assert.equal(lib.parseCase(`x${' '.repeat(20000)}y\n概要${'\t'.repeat(20000)}x\n決めてほしい事: q`, table).ask, 'q');
  assert.ok(Date.now() - t0 < 500, `長い空白の行: ${Date.now() - t0}ms`);
});

test('独立レビュー 2 回目: 長い 1 行の欄を読む・字下げの行は見出しにしない・提案として読める json は外す', async () => {
  const lib = await import('../plugins/board/src/case-lib.mjs');
  const { DICT } = await import('../plugins/office/src/i18n.mjs');
  const table = lib.headingTable(DICT), long = 'あ'.repeat(420);
  const a = lib.parseCase(`概要: s\n決めてほしい事: ${long}\n私なら: A`, table);
  assert.deepEqual([a.summary, a.ask.length, a.rec], ['s', 420, 'A']);
  const b = lib.parseCase(`**概要**: ${long}\n**決めてほしい事**: A か B\n**私なら**: A\n**なぜなら:** ${long}`, table);
  assert.deepEqual([b.summary.length, b.ask, b.rec, b.why.length], [420, 'A か B', 'A', 420]);
  const c = lib.parseCase('決めてほしい事: A    か    B\n私なら: A にします\n    - 概要: 入れ子の行\n    ## なぜなら\nコード', table);
  assert.equal(c.ask, 'A    か    B'); assert.equal(c.summary, undefined); assert.match(c.rec, /入れ子の行[\s\S]*コード/);
  assert.equal(lib.parseCase('## 概要\ns\n\n## 決めてほしい事\nq', table).ask, 'q');
  const fence = '```';
  for (const j of ['{"proposals":[{"title":"a","ask":"q"}],"note":"x"}', '{"proposals":[{"title":"a"},{"detail":"題なし"}]}', '[{"title":"a"},"x"]']) assert.equal(lib.hideJson(`文\n${fence}json\n${j}\n${fence}`), '文', j);
});

test('秘書の画面: 「止まっている」の件は、担当つきの新しい物を候補にする（後回しの件・担当なしは外す・件数を絞る）', async () => {
  const lib = await import('../plugins/board/src/case-lib.mjs');
  const row = (id, column, agentId, at) => ({ id, column, agentId, issue: { updatedAt: at } });
  const rows = [row('b1', 'blocked', 'a', '2026-11-24T01:00:00Z'), row('b2', 'blocked', null, '2026-11-24T02:00:00Z'), row('b3', 'blocked', 'a', '2026-11-24T03:00:00Z'), row('r1', 'review', 'a', '2026-11-24T00:00:00Z'),
    ...Array.from({ length: 20 }, (_, i) => row(`old${i}`, 'blocked', 'a', `2026-11-01T00:00:${String(i).padStart(2, '0')}Z`))];
  const s = lib.deskSplit(rows, { b3: Date.parse('2026-11-25T00:00:00Z') }, Date.parse('2026-11-24T04:00:00Z'));
  assert.deepEqual(s.decide.map(r => r.id), ['r1']);
  assert.equal(s.held.length, lib.HELD_MAX);
  assert.equal(s.held[0].id, 'b1'); assert.ok(!s.held.some(r => r.id === 'b2' || r.id === 'b3'));
});

test('「止まっている」の件を出す条件: 件の形のコメントが一番新しい時だけ・後回しにした件は「また出す」に数える', async () => {
  const lib = await import('../plugins/board/src/case-lib.mjs');
  const ask = { id: 'c1', authorAgentId: 'a', createdAt: '2026-11-24T00:00:00Z', body: '## 決めてほしい事\nq\n## 私なら\nr' };
  const k = { from: 'comment', commentId: 'c1' };
  assert.equal(lib.isOpenAsk(k, [ask]), true);
  assert.equal(lib.isOpenAsk(k, [ask, { id: 'c2', authorUserId: 'u', createdAt: '2026-11-24T01:00:00Z', body: '推奨のとおりに進めてください。' }]), false, '持ち主が答えた後');
  assert.equal(lib.isOpenAsk(k, [ask, { id: 'c3', authorAgentId: 'a', createdAt: '2026-11-24T02:00:00Z', body: '別の課題の完了待ちで止めます' }]), false, '担当が別の理由で止めた後');
  assert.equal(lib.isOpenAsk(k, [ask, { id: 'c4', authorUserId: 'u', createdAt: '2026-11-24T03:00:00Z', body: 'x', deletedAt: '2026-11-24T03:01:00Z' }]), true, '消されたコメントは数えない');
  assert.equal(lib.isOpenAsk({ from: 'description', commentId: null }, []), false, '本文だけが件の形の件は出さない');
  assert.equal(lib.isOpenAsk(null, [ask]), false);
  const row = (id, column, at) => ({ id, column, agentId: 'a', issue: { updatedAt: at } });
  const s = lib.deskSplit([row('b1', 'blocked', '2026-11-24T01:00:00Z'), row('b2', 'blocked', '2026-11-24T02:00:00Z'), row('r1', 'review', '2026-11-24T00:00:00Z'), row('d1', 'doing', '2026-11-24T00:00:00Z')], { b1: Date.parse('2026-11-25T00:00:00Z') }, Date.parse('2026-11-24T04:00:00Z'));
  assert.deepEqual([s.held.map(r => r.id), s.later.map(r => r.id), s.decide.map(r => r.id), s.going.map(r => r.id)], [['b2'], ['b1'], ['r1'], ['d1']]);
});

test('取り下げる: 確認待ちの件だけに出す・取り消しと一言を 1 回の更新で送る・返事で取り消しを確かめる', async () => {
  const { canDrop, dropPatch, dropDone } = await import('../plugins/board/src/case-lib.mjs');
  assert.equal(canDrop({ id: 'a', column: 'review' }, { kase: null }), true);
  assert.equal(canDrop({ id: 'a', column: 'review' }, { props: [{ title: 'x' }] }), true, '提案 1 つのカード');
  assert.equal(canDrop({ id: 'a', column: 'review' }, { props: [{ title: 'x' }, { title: 'y' }] }), false, '提案がまとまった古い形');
  assert.equal(canDrop({ id: 'a', column: 'blocked' }, { kase: {} }), false, '止まっている件');
  assert.equal(canDrop({ id: 'a', column: 'review' }, undefined), false, '読み終わる前');
  assert.equal(canDrop({ id: 'a', column: 'review' }, { props: null, failed: true }), false, 'コメントを読めなかった時');
  assert.deepEqual(dropPatch('取り下げます'), { status: 'cancelled', comment: '取り下げます' });
  assert.equal(dropDone({ id: 'a', status: 'cancelled' }), true);
  assert.equal(dropDone({ issue: { status: 'cancelled' } }), true);
  assert.equal(dropDone({ id: 'a', status: 'todo' }), false, '本体が未着手に戻した時');
  assert.equal(dropDone(null), false);
});

// 2026-11-24 の誤りの再発防止: 取り消した（閉じた）件に別でコメントを書くと、本体が件を未着手に戻して担当を起こす。
// 閉じる更新と一言は 1 回の PATCH（dropPatch）で送る。画面のコードで、閉じる状態を dropPatch を通さずに送らない・drop の中でコメントを別に書かない
test('閉じる更新は一言と 1 回で送る（閉じた後に別でコメントを書かない）', async () => {
  const fs = await import('node:fs');
  const dir = new URL('../plugins/board/src/', import.meta.url);
  const desk = fs.readFileSync(new URL('desk.mjs', dir), 'utf8');
  const body = desk.slice(desk.indexOf('async function drop('), desk.indexOf('const row = '));
  assert.ok(body.includes('dropPatch(') && body.includes('dropDone('), 'drop は dropPatch と dropDone を使う');
  assert.ok(!body.includes('addComment'), 'drop の中でコメントを別に書かない');
  for (const f of fs.readdirSync(dir).filter(f => f.endsWith('.mjs') && f !== 'case-lib.mjs')) {
    const src = fs.readFileSync(new URL(f, dir), 'utf8');
    assert.ok(!/patchIssue\([^)]*status:\s*'(cancelled|done)'/.test(src), `${f}: 閉じる状態を直に送っている（dropPatch を通す）`);
  }
});

// 「進める」も 1 回の更新（goPatch）で送る。別々に送ると本体が担当を 2 回起こす（実物で確かめた・docs/ops/agent-runtime.md）
test('推奨で進める: 未着手に戻す更新と一言は 1 回で送り、go の中でコメントを別に書かない', async () => {
  const fs = await import('node:fs');
  const { goPatch, goDone } = await import('../plugins/board/src/case-lib.mjs');
  assert.deepEqual(goPatch('進めてください'), { status: 'todo', comment: '進めてください' });
  assert.equal(goDone({ status: 'todo' }), true);
  assert.equal(goDone({ issue: { status: 'in_progress' } }), true, '担当がすぐ拾った時');
  assert.equal(goDone({ status: 'in_review' }), false);
  assert.equal(goDone(null), false);
  for (const f of ['desk.mjs', 'case.mjs']) {
    const src = fs.readFileSync(new URL(`../plugins/board/src/${f}`, import.meta.url), 'utf8');
    const at = src.indexOf('async function go('); assert.ok(at > 0, f);
    const body = src.slice(at, src.indexOf('finally', at));
    assert.ok(body.includes('goPatch(') && body.includes('goDone('), `${f}: go は goPatch と goDone を使う`);
    assert.ok(!body.includes('addComment'), `${f}: go の中でコメントを別に書かない`);
    assert.equal(body.split('patchIssue(').length - 1, 1, `${f}: go の中の更新は 1 回`);
    assert.ok(!/patchIssue\([^)]*status['"]?:\s*['"]todo['"]/.test(src), `${f}: 未着手に戻す更新を直に送っている（goPatch を通す）`);
  }
});
