// サブタスクと会話の画面の計算（会話の画面の標準 docs/design/2026-11-25-chat-screen-standard.md・モック docs/mocks/case-subtasks.html）
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  headingTable, parseCase, FIRST_MESSAGES, firstShown, subtaskTree, enterSends, attachSplit, ATTACH_MAX_BYTES, ATTACH_MAX_FILES,
  withAttachNote, splitIdeas, SPLIT_MAX, checkResult, RESULT_MAX, childDonePatch, parentNote,
  mdBlocks, mdInline, hhmm, dayKey, dayLabel, firstUnread, startIndex, fitHeight, PAGE_MIN_H,
} from '../plugins/board/src/case-lib.mjs';
import { createApi } from '../plugins/office/src/api.mjs';
import { DICT } from '../plugins/office/src/i18n.mjs';

const T = headingTable(DICT);

test('3-1: 最初は新しい方の 20 個だけ出し、読み足すと 20 個ずつ増える', () => {
  assert.equal(FIRST_MESSAGES, 20);
  assert.equal(firstShown(25, 20), 5);
  assert.equal(firstShown(25, 40), 0);
  assert.equal(firstShown(3, 20), 0);
  assert.equal(firstShown(0, 20), 0);
});

test('サブタスクの木: すぐ下の子だけを並べ、その下の数と済みの数を数える（取り消しは数えない）', () => {
  const is = [
    { id: 'e', parentId: 'g', status: 'in_review', createdAt: '2' }, { id: 's', parentId: 'g', status: 'todo', createdAt: '1' },
    { id: 'e1', parentId: 'e', status: 'done' }, { id: 'e2', parentId: 'e', status: 'in_progress' }, { id: 'e2a', parentId: 'e2', status: 'todo' },
    { id: 'x', parentId: 'g', status: 'cancelled' }, { id: 'g', parentId: null, status: 'todo' },
  ];
  const tr = subtaskTree('g', is);
  assert.deepEqual(tr.kids.map(k => [k.issue.id, k.below, k.belowDone]), [['s', 0, 0], ['e', 3, 1]]);
  assert.equal(tr.done, 0);
  assert.equal(tr.all, 5);
  assert.deepEqual(subtaskTree('g', []), { kids: [], done: 0, all: 0 });
});

test('5-2・5-3: PC は Enter で送り、Shift+Enter・変換の確定・携帯の改行キーでは送らない', () => {
  assert.equal(enterSends({ key: 'Enter' }, false), true);
  assert.equal(enterSends({ key: 'Enter', shiftKey: true }, false), false);
  assert.equal(enterSends({ key: 'Enter', isComposing: true }, false), false);
  assert.equal(enterSends({ key: 'Enter', keyCode: 229 }, false), false);
  assert.equal(enterSends({ key: 'Enter' }, true), false);
  assert.equal(enterSends({ key: 'a' }, false), false);
});

test('5-4: 添付は 10MB まで・空は断る・1 回に 8 個まで', () => {
  const f = (name, size) => ({ name, size });
  const r = attachSplit([], [f('a.png', 10), f('big.pdf', ATTACH_MAX_BYTES + 1), f('empty.txt', 0)]);
  assert.deepEqual(r.ok.map(x => x.name), ['a.png']);
  assert.deepEqual(r.ng, [{ name: 'big.pdf', why: 'big' }, { name: 'empty.txt', why: 'empty' }]);
  const seven = Array.from({ length: ATTACH_MAX_FILES - 1 }, (_, i) => f(`${i}`, 1));
  const r2 = attachSplit(seven, [f('8', 1), f('9', 1)]);
  assert.deepEqual(r2.ok.map(x => x.name), ['8']);
  assert.deepEqual(r2.ng, [{ name: '9', why: 'many' }]);
});

test('添付の名前を発言に足す（文だけ・添付だけ・両方）', () => {
  assert.equal(withAttachNote('見てください', [], '添付:'), '見てください');
  assert.equal(withAttachNote('見てください', ['a.png', 'b.pdf'], '添付:'), '見てください\n\n添付: a.png、b.pdf');
  assert.equal(withAttachNote('', ['a.png'], '添付:'), '添付: a.png');
});

test('サブタスクの案: 担当の書いた「サブタスクの案」の節の箇条を取り出す', () => {
  const p = parseCase('## 決めてほしい事\nどれを出すか\n\n## サブタスクの案\n- 見積もりを取る\n- ブースの大きさを決める\n\n## なぜなら\n分けた方が速い', T);
  assert.deepEqual(splitIdeas(p.split), ['見積もりを取る', 'ブースの大きさを決める']);
  assert.equal(p.why, '分けた方が速い');
  const en = parseCase('**Decision needed**: which one\n**Suggested subtasks**:\n1. Get a quote\n2) Pick the booth size', T);
  assert.deepEqual(splitIdeas(en.split), ['Get a quote', 'Pick the booth size']);
  assert.equal(splitIdeas(Array.from({ length: 20 }, (_, i) => `- ${i}`).join('\n')).length, SPLIT_MAX);
  assert.deepEqual(splitIdeas(undefined), []);
});

test('完了にして親に返す: 決まった事の確かめ・子の更新・親に書く文', () => {
  assert.deepEqual(checkResult('  '), { ok: false, why: 'empty' });
  assert.deepEqual(checkResult('x'.repeat(RESULT_MAX + 1)), { ok: false, why: 'long' });
  assert.deepEqual(checkResult(' 3 月の展示会 '), { ok: true, body: '3 月の展示会' });
  assert.deepEqual(childDonePatch('決まった事:', '3 月の展示会'), { status: 'done', comment: '決まった事: 3 月の展示会' });
  assert.equal(parentNote(DICT.ja.case_parent_note, '展示会に出す', '3 月 $1 {title}'), 'サブタスク「展示会に出す」が完了: 3 月 $1 {title}');
});

test('API: 子孫を読む・子を作る・添付を multipart で送る', async () => {
  const calls = [];
  const fetchFn = async (url, o) => { calls.push({ url, method: o.method, body: o.body }); return { ok: true, json: async () => (url.includes('descendantOf') ? { items: [{ id: 'k' }] } : { id: 'n' }) }; };
  const api = createApi(fetchFn);
  assert.deepEqual(await api.subtasks('c1', 'g 1'), [{ id: 'k' }]);
  assert.equal(calls[0].url, '/api/companies/c1/issues?descendantOf=g%201&limit=500');
  await api.addChild('g', { title: '見積もり', assigneeAgentId: 'a1' });
  assert.equal(calls[1].url, '/api/issues/g/children');
  assert.deepEqual(JSON.parse(calls[1].body), { title: '見積もり', status: 'todo', assigneeAgentId: 'a1' });
  await api.addChild('g', { title: '担当なし' });
  assert.deepEqual(JSON.parse(calls[2].body), { title: '担当なし', status: 'todo' });
  await api.upload('c1', 'g', new File(['x'], '写真.png', { type: 'image/png' }));
  assert.equal(calls[3].url, '/api/companies/c1/issues/g/attachments');
  assert.ok(calls[3].body instanceof FormData);
  assert.equal(calls[3].body.get('file').name, '写真.png');
  const bad = createApi(async () => ({ ok: false, status: 422, json: async () => ({ error: 'Attachment is larger than the 10 MB limit' }) }));
  await assert.rejects(bad.upload('c1', 'g', new File(['x'], 'a')), e => e.status === 422);
});

test('画面の文: タスクのページの文に「件」を使わない（英語と日本語の鍵がそろう）', () => {
  const keys = Object.keys(DICT.ja).filter(k => k.startsWith('case_'));
  for (const k of keys) { assert.ok(k in DICT.en, k); assert.ok(!/(?<![0-9人])件/.test(DICT.ja[k]), `${k}: ${DICT.ja[k]}`); }
});

test('3-3: Markdown を塊に分ける（見出し・箇条・番号・引用・表・コード・段落）。HTML は文字のまま', () => {
  const b = mdBlocks('## 見出し\n- いち\n- に\n\n1. 一\n2) 二\n\n> 引用\n\n| a | b |\n|---|---|\n| 1 | 2 |\n\n```\n<b>x</b>\n```\n<script>alert(1)</script> の段落');
  assert.deepEqual(b.map(x => x.type), ['h', 'ul', 'ol', 'quote', 'table', 'code', 'p']);
  assert.deepEqual(b[1].items, ['いち', 'に']);
  assert.deepEqual(b[2].items, ['一', '二']);
  assert.deepEqual(b[4].rows, [['a', 'b'], ['1', '2']]);
  assert.equal(b[5].text, '<b>x</b>');
  assert.equal(b[6].text, '<script>alert(1)</script> の段落');
  assert.deepEqual(mdInline('**太字** と `code` と *ほか*'), [{ t: 'b', v: '太字' }, { t: 'text', v: ' と ' }, { t: 'code', v: 'code' }, { t: 'text', v: ' と *ほか*' }]);
  assert.deepEqual(mdBlocks(''), []);
});

test('3-4: 時刻と日付の区切り（今日・昨日・それより前）', () => {
  const now = new Date(2026, 10, 25, 9, 0).getTime();
  const w = { today: '今日', yesterday: '昨日', date: '{y}年{m}月{d}日' };
  assert.equal(hhmm(new Date(2026, 10, 25, 8, 5).toISOString()), '08:05');
  assert.equal(hhmm('壊れた'), '');
  assert.equal(dayLabel(new Date(2026, 10, 25, 1).toISOString(), now, w), '今日');
  assert.equal(dayLabel(new Date(2026, 10, 24, 23).toISOString(), now, w), '昨日');
  assert.equal(dayLabel(new Date(2026, 9, 3).toISOString(), now, w), '2026年10月3日');
  assert.equal(dayKey('x'), '');
});

test('2-1: 未読の区切りは、既読の時刻より後の自分以外の最初の発言（既読が無ければ出さない）', () => {
  const chat = [{ id: '1', who: 'agent', at: '2026-11-25T01:00Z' }, { id: '2', who: 'me', at: '2026-11-25T02:00Z' }, { id: '3', who: 'agent', at: '2026-11-25T03:00Z' }];
  assert.equal(firstUnread(chat, '2026-11-25T01:30Z'), '3');
  assert.equal(firstUnread(chat, '2026-11-25T00:00Z'), '1');
  assert.equal(firstUnread(chat, '2026-11-25T04:00Z'), null);
  assert.equal(firstUnread(chat, null), null);
});

test('3-1・2-2: 表示の始まりは id で持ち、新しい発言が来ても上の発言を消さない', () => {
  const mk = n => Array.from({ length: n }, (_, i) => ({ id: String(i) }));
  assert.equal(startIndex(mk(25), null), 5);
  assert.equal(startIndex(mk(25), '5'), 5);
  assert.equal(startIndex(mk(26), '5'), 5); // 1 つ増えても始まりは同じ
  assert.equal(startIndex(mk(26), 'なし'), 6);
  assert.equal(startIndex([], null), 0);
});

test('API: 送る途中で止める合図を、発言と添付の送信に渡す', async () => {
  const seen = [];
  const api = createApi(async (url, o) => { seen.push(!!o.signal); return { ok: true, json: async () => ({}) }; });
  const ac = new AbortController();
  await api.addComment('g', 'x', { signal: ac.signal });
  await api.upload('c', 'g', new File(['x'], 'a'), { signal: ac.signal });
  await api.addComment('g', 'y');
  assert.deepEqual(seen, [true, true, false]);
});

test('1-1: ページの高さは、画面の下に固定された外の物（携帯の下のメニュー）の上端までにする', () => {
  assert.equal(fitHeight({ viewH: 844, top: 60 }), 776);
  assert.equal(fitHeight({ viewH: 844, top: 60, covers: [780] }), 712);   // 下のメニュー 64px の上まで
  assert.equal(fitHeight({ viewH: 844, top: 60, covers: [780, 800] }), 712); // 一番上の物に合わせる
  assert.equal(fitHeight({ viewH: 844, top: 60, covers: [900, -5, NaN] }), 776); // 隠れた物・画面の外の物は数えない
  assert.equal(fitHeight({ viewH: 300, top: 60, covers: [250] }), PAGE_MIN_H);
  assert.equal(fitHeight({ viewH: 844, top: -200 }), 836); // 上にスクロールした時はページの上端を 0 と見る
});
