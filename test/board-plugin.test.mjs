// タスクボードの計算と API の形（設計 docs/design/2026-11-24-secretary-conversation-kanban.md §6）
import test from 'node:test';
import assert from 'node:assert/strict';
import { COLUMNS, columnOf, movePatch, boardRows, applyFilter, byColumn, facetCounts, findRejectLabel, newFilter, toggleFilter, filterSize, checkNewLabel, safeColor, shownColumn, isIssueShape, moveRefusal, serverRefusal, browserLang } from '../plugins/board/src/board-lib.mjs';
import { createApi } from '../plugins/office/src/api.mjs';
import manifest from '../plugins/board/src/manifest.mjs';
import { createHandlers } from '../plugins/board/src/worker.mjs';
import { DICT } from '../plugins/office/src/i18n.mjs';

const NOW = Date.parse('2026-11-24T00:00:00Z');
const R = 'lab-return';
const opts = { rejectLabelId: R, now: NOW };
const issue = (id, status, extra = {}) => ({ id, title: id, status, labelIds: [], updatedAt: '2026-11-23T00:00:00Z', ...extra });

test('列: 本体の状態をそのまま列にし、差し戻しは todo ＋ ラベルで表す', () => {
  assert.equal(columnOf(issue('a', 'todo'), opts), 'todo');
  assert.equal(columnOf(issue('a', 'backlog'), opts), 'todo');
  assert.equal(columnOf(issue('a', 'in_progress'), opts), 'doing');
  assert.equal(columnOf(issue('a', 'in_review'), opts), 'review');
  assert.equal(columnOf(issue('a', 'blocked'), opts), 'blocked');
  assert.equal(columnOf(issue('a', 'todo', { labelIds: [R] }), opts), 'back');
  assert.equal(columnOf(issue('a', 'todo', { labelIds: [], labels: [{ id: R }] }), opts), 'back', 'labels の形でも読む');
  assert.equal(columnOf(issue('a', 'in_progress', { labelIds: [R] }), opts), 'doing', '進行中はラベルが残っていても進行中');
  assert.equal(columnOf(issue('a', 'cancelled'), opts), null);
  assert.equal(columnOf(issue('a', 'todo', { labelIds: [R] }), { now: NOW }), 'todo', 'ラベルが無い会社では差し戻しの列に入らない');
});

test('完了の列は直近 7 日だけ', () => {
  assert.equal(columnOf(issue('a', 'done', { completedAt: '2026-11-20T00:00:00Z' }), opts), 'done');
  assert.equal(columnOf(issue('a', 'done', { completedAt: '2026-11-10T00:00:00Z' }), opts), null);
  assert.equal(columnOf(issue('a', 'done', { completedAt: null, updatedAt: '2026-11-23T00:00:00Z' }), opts), 'done');
});

test('動かす: 列ごとの変更。差し戻しへは todo ＋ ラベル、差し戻しから出すとラベルを外す', () => {
  assert.deepEqual(movePatch(issue('a', 'todo'), 'doing', opts), { status: 'in_progress' });
  assert.deepEqual(movePatch(issue('a', 'in_progress'), 'review', opts), { status: 'in_review' });
  assert.deepEqual(movePatch(issue('a', 'in_review'), 'done', opts), { status: 'done' });
  assert.deepEqual(movePatch(issue('a', 'in_review', { labelIds: ['x'] }), 'back', opts), { status: 'todo', labelIds: ['x', R] });
  assert.deepEqual(movePatch(issue('a', 'todo', { labelIds: ['x'] }), 'back', opts), { labelIds: ['x', R] }, '未着手から差し戻しへは状態を変えない');
  assert.deepEqual(movePatch(issue('a', 'todo', { labelIds: ['x', R] }), 'todo', opts), { labelIds: ['x'] }, '差し戻しから未着手へはラベルだけ外す');
  assert.deepEqual(movePatch(issue('a', 'todo', { labelIds: [R] }), 'doing', opts), { status: 'in_progress', labelIds: [] });
  assert.equal(movePatch(issue('a', 'todo'), 'todo', opts), null, '同じ列は変更なし');
  assert.equal(movePatch(issue('a', 'todo'), 'nowhere', opts), null);
  assert.equal(movePatch(issue('a', 'in_review'), 'back', { now: NOW }), null, '差し戻しのラベルが無い時は送らない');
  assert.deepEqual(movePatch(issue('a', 'backlog'), 'back', opts), { labelIds: [R] }, 'backlog は backlog のまま差し戻しへ');
  assert.deepEqual(movePatch(issue('a', 'backlog', { labelIds: [R] }), 'todo', opts), { labelIds: [] }, 'backlog を黙って todo に変えない');
  assert.deepEqual(movePatch(issue('a', 'backlog'), 'doing', opts), { status: 'in_progress' });
});

test('動かした後の課題は、動かした先の列に入る（往復）', () => {
  for (const from of ['backlog', 'todo', 'in_progress', 'in_review', 'blocked', 'done']) for (const to of COLUMNS) {
    const i = issue('a', from, { completedAt: '2026-11-23T00:00:00Z' });
    const patch = movePatch(i, to, opts);
    const after = { ...i, ...(patch || {}) };
    assert.equal(columnOf(after, opts), to, `${from} → ${to}`);
  }
});

const DATA = [
  issue('1', 'todo', { labelIds: ['money'], assigneeAgentId: 'ag1' }),
  issue('2', 'in_review', { labelIds: ['money', 'due'], assigneeAgentId: 'ag2' }),
  issue('3', 'in_review', { labelIds: ['sec'], assigneeAgentId: 'ag1' }),
  issue('4', 'blocked', { labelIds: ['money'], assigneeAgentId: 'ag2' }),
  issue('5', 'todo', { labelIds: [R] }),
  issue('6', 'cancelled', { labelIds: ['money'] }),
];

test('絞り込み: 同じ種類の中はどれか・種類の間はどれも', () => {
  const rows = boardRows(DATA, opts);
  assert.equal(rows.length, 5, 'cancelled は出さない');
  const ids = f => applyFilter(rows, f).map(r => r.id);
  let f = toggleFilter(newFilter(), 'labels', 'money');
  assert.deepEqual(ids(f), ['1', '2', '4']);
  f = toggleFilter(f, 'labels', 'sec');
  assert.deepEqual(ids(f), ['1', '2', '3', '4']);
  f = toggleFilter(f, 'agents', 'ag1');
  assert.deepEqual(ids(f), ['1', '3']);
  f = toggleFilter(f, 'quick', 'decide');
  assert.deepEqual(ids(f), ['3']);
  assert.equal(filterSize(f), 4);
  f = toggleFilter(f, 'quick', 'decide');
  assert.equal(filterSize(f), 3, 'もう一度押すと外れる');
  assert.deepEqual(ids(toggleFilter(newFilter(), 'quick', 'held')), ['4', '5']);
  const both = toggleFilter(toggleFilter(newFilter(), 'quick', 'held'), 'quick', 'decide');
  assert.deepEqual(ids(both), ['2', '3', '4', '5'], 'すぐ絞るの 2 つを押すと、どちらかに当たる件');
  assert.deepEqual(facetCounts(rows, both).quick, { decide: 2, held: 2 }, '件数は押した後に出る件と合う');
  assert.deepEqual(ids(toggleFilter(newFilter(), 'agents', '')), ['5'], '担当なしでも絞れる');
});

test('件数: 自分の種類の絞り込みは外して数える', () => {
  const rows = boardRows(DATA, opts);
  const f = toggleFilter(toggleFilter(newFilter(), 'labels', 'money'), 'agents', 'ag2');
  const c = facetCounts(rows, f);
  assert.equal(c.labels.money, 2, '担当 ag2 の中の money');
  assert.equal(c.labels.due, 1);
  assert.equal(c.labels.sec, undefined);
  assert.equal(c.agents.ag1, 1, 'money の中の ag1');
  assert.equal(c.agents.ag2, 2);
  assert.deepEqual(c.quick, { decide: 1, held: 1 });
});

test('列ごとの札は、新しく動いた順', () => {
  const rows = boardRows([issue('a', 'todo', { updatedAt: '2026-11-20T00:00:00Z' }), issue('b', 'todo', { updatedAt: '2026-11-22T00:00:00Z' })], opts);
  const cols = byColumn(rows);
  assert.deepEqual(cols.todo.map(r => r.id), ['b', 'a']);
  assert.deepEqual(Object.keys(cols), COLUMNS);
});

test('差し戻しのラベルは英語と日本語のどちらの名前でも見つける', () => {
  const names = [DICT.en.board_label_returned, DICT.ja.board_label_returned];
  assert.equal(findRejectLabel([{ id: 'x', name: 'money' }, { id: 'r', name: ' returned ' }], names).id, 'r');
  assert.equal(findRejectLabel([{ id: 'r', name: DICT.ja.board_label_returned }], names).id, 'r');
  assert.equal(findRejectLabel([{ id: 'x', name: 'money' }], names), null);
});

test('ラベルの名前: 空・長すぎ・同じ名前は断る', () => {
  const labels = [{ id: 'x', name: 'Money' }];
  assert.deepEqual(checkNewLabel('  home   stuff ', labels), { ok: true, name: 'home stuff' });
  assert.equal(checkNewLabel('   ', labels).why, 'empty');
  assert.equal(checkNewLabel('money', labels).why, 'exists');
  assert.equal(checkNewLabel('a'.repeat(31), labels).why, 'long');
  assert.equal(checkNewLabel('returned', labels, ['Returned', DICT.ja.board_label_returned]).why, 'reserved', '差し戻しのラベルを別の言語の名前でもう 1 つ作らせない');
  assert.equal(checkNewLabel(DICT.ja.board_label_returned, labels, ['Returned', DICT.ja.board_label_returned]).why, 'reserved');
  assert.equal(checkNewLabel('Returned', [{ id: 'r', name: 'returned' }], ['Returned']).why, 'exists', 'もうある時は「もうある」');
  for (const why of ['long', 'exists', 'reserved']) for (const lang of ['en', 'ja']) assert.ok(DICT[lang][`board_err_label_${why}`], `${lang} ${why}`);
});

test('ラベルの色: # と 16 進だけを通す', () => {
  assert.equal(safeColor('#2f8a57', '#000'), '#2f8a57');
  assert.equal(safeColor(' #FFF ', '#000'), '#FFF');
  for (const bad of ['#12345', '#1234567', 'url(https://x.example/a.png)', 'red; background-image: url(x)', '', null, 'expression(1)']) assert.equal(safeColor(bad, '#000'), '#000');
});

test('読み直した 1 件が課題の形でなければ使わない（ラベルを全部消す変更を送らない）', () => {
  assert.equal(isIssueShape({ id: 'a', labelIds: [] }, 'a'), true);
  assert.equal(isIssueShape({ id: 'a', labels: [{ id: 'x' }] }, 'a'), true);
  for (const bad of [null, {}, { id: 'a' }, { issue: { id: 'a', labelIds: [] } }, { id: 'b', labelIds: [] }]) assert.equal(isIssueShape(bad, 'a'), false);
});

test('携帯の列: 人が選んだ列は件が無くても出す。選ぶ前は件のある最初の列', () => {
  const cols = byColumn(boardRows([issue('a', 'in_review')], opts));
  assert.equal(shownColumn(null, cols), 'review');
  assert.equal(shownColumn('done', cols), 'done');
  assert.equal(shownColumn(null, byColumn([])), 'todo');
});

test('API: 閉じていない課題を最後のページまで読み、完了は直近だけを足す', async () => {
  const calls = [];
  const page = n => Array.from({ length: n }, (_, k) => ({ id: `i${calls.length}-${k}` }));
  const api = createApi(async (url, init) => {
    calls.push([init.method, url]);
    const body = url.includes('status=done') ? [{ id: 'd1' }, { id: 'i1-0' }] : calls.length === 1 ? page(500) : page(3);
    return { ok: true, status: 200, json: async () => body };
  });
  const out = await api.boardIssues('co 1', '2026-11-17T00:00:00.000Z');
  assert.equal(calls.length, 3);
  assert.match(calls[0][1], /^\/api\/companies\/co%201\/issues\?status=backlog,todo,in_progress,in_review,blocked&sortField=id&sortDir=asc&limit=500&excludeRoutineExecutions=true$/);
  assert.match(calls[1][1], /&excludeRoutineExecutions=true&afterId=i1-499$/);
  assert.match(calls[2][1], /status=done&updatedSince=2026-11-17T00%3A00%3A00\.000Z&sortField=updated&sortDir=desc&limit=500&excludeRoutineExecutions=true$/);
  assert.equal(out.length, 500 + 3 + 1, '同じ id は 1 回だけ');
});

test('API: 定期の実行も出す時は、外す指定を付けない', async () => {
  const urls = [];
  const api = createApi(async url => { urls.push(url); return { ok: true, status: 200, json: async () => [] }; });
  await api.boardIssues('co', '2026-11-17T00:00:00.000Z', { routines: true });
  assert.equal(urls.length, 2);
  for (const u of urls) assert.doesNotMatch(u, /excludeRoutineExecutions/);
});

test('本体が断る動きは送る前に理由を返す（担当なしの進行中・止まっている）', () => {
  assert.equal(moveRefusal(issue('a', 'todo'), 'doing'), 'need_owner');
  assert.equal(moveRefusal(issue('a', 'todo', { assigneeAgentId: 'ag' }), 'doing'), null);
  assert.equal(moveRefusal(issue('a', 'todo', { assigneeUserId: 'u' }), 'doing'), null);
  assert.equal(moveRefusal(issue('a', 'todo', { assigneeAgentId: 'ag' }), 'blocked'), 'blocked_rule');
  for (const to of ['todo', 'review', 'back', 'done']) assert.equal(moveRefusal(issue('a', 'todo'), to), null, to);
  assert.equal(serverRefusal({ status: 422, body: { error: 'in_progress issues require an assignee' } }), 'need_owner');
  assert.equal(serverRefusal({ status: 422, body: { error: 'Entering blocked requires unresolved blockers, a pending interaction/approval, or unblockDescriptor' } }), 'blocked_rule');
  assert.equal(serverRefusal({ status: 422, body: { error: 'something else' } }), null);
  assert.equal(serverRefusal({ status: 500, body: { error: 'require an assignee' } }), null);
  for (const why of ['need_owner', 'blocked_rule']) for (const lang of ['en', 'ja']) assert.ok(DICT[lang][`board_err_${why}`]);
});

test('API: 動かす・ラベルを作る口', async () => {
  const calls = [];
  const api = createApi(async (url, init) => { calls.push([init.method, url, init.body]); return { ok: true, status: 200, json: async () => ({ id: 'ok' }) }; });
  await api.patchIssue('is/1', { status: 'done' });
  await api.createLabel('co', 'home', '#000000');
  await api.labels('co');
  await api.issue('is/1');
  assert.deepEqual(calls, [
    ['PATCH', '/api/issues/is%2F1', '{"status":"done"}'],
    ['POST', '/api/companies/co/labels', '{"name":"home","color":"#000000"}'],
    ['GET', '/api/companies/co/labels', undefined],
    ['GET', '/api/issues/is%2F1', undefined],
  ]);
});

test('manifest: タスクボードの page と sidebar の slot がある', () => {
  const page = manifest.ui.slots.find(s => s.id === 'board');
  assert.deepEqual([page.type, page.routePath, page.exportName], ['page', 'board', 'BoardPage']);
  assert.equal(manifest.ui.slots.find(s => s.id === 'board-sidebar').exportName, 'BoardSidebarLink');
  assert.equal(manifest.id, 'aioffice.board');
});

test('worker: 担当の名前だけを返し、会社の id が無ければ断る', async () => {
  const hd = createHandlers({ agents: { list: async ({ companyId }) => [{ id: 'a1', name: 'Mail', title: null, secret: 'x', companyId }] } });
  assert.deepEqual(await hd.agents({ companyId: 'co' }), [{ id: 'a1', name: 'Mail', title: null }]);
  await assert.rejects(() => hd.agents({}), /companyId is required/);
});

test('文言: 列の名前が英日とも 6 列ぶんある', () => {
  for (const lang of ['en', 'ja']) for (const c of COLUMNS) assert.ok(DICT[lang][`board_col_${c}`], `${lang} ${c}`);
});

test('画面の言語の初めの値はブラウザの言語（日本語なら日本語・他は英語）', () => {
  assert.equal(browserLang({ language: 'ja-JP' }), 'ja');
  assert.equal(browserLang({ language: 'ja' }), 'ja');
  assert.equal(browserLang({ language: 'en-US' }), 'en');
  assert.equal(browserLang({ language: 'jam' }), 'en');
  assert.equal(browserLang(null), 'en');
});
