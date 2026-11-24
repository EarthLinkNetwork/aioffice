// 受信箱の「自分宛て」（設計 2.7・2 回目と 3 回目の独立レビュー）: 承認と判断は持ち主（board）宛て・人に回った物は自分に割り当てた課題
import test from 'node:test';
import assert from 'node:assert/strict';
import { register } from 'node:module';
import { translator } from '../plugins/office/src/i18n.mjs';

register('./fixtures/react-alias-hooks.mjs', import.meta.url);
const R = await import('./fixtures/mini-react.mjs');
const P = await import('../plugins/office/src/panels.mjs');
const h = R.createElement;
const t = translator('en');
const click = node => node.props.onClick({ preventDefault() {}, currentTarget: node });
const approvals = { data: [{ id: 'ap1', type: 'hire', payload: { title: 'Hire' }, createdAt: '2026-11-24T00:00:00Z' }] };
const decisions = { data: [{ id: 'de1', title: 'Pick one', question: 'Pick one', options: [], createdAt: '2026-11-24T00:00:00Z' }] };
const myIssues = [{ id: 'is1', identifier: 'AAA-1', title: 'Routed to B', status: 'todo' }];
const render = mine => R.render(h(P.InboxPanel, { api: {}, t, approvals, decisions, mine, onIssue: () => {}, notices: { data: [] }, companyId: 'c1', prefix: 'AAA', reload: () => {}, onClose: () => {} }));
const has = (root, attr) => R.findAll(root.tree, n => n.props[attr] !== undefined).length;

test('招いた人の「自分宛て」: 自分の課題だけ・持ち主宛ての承認と判断は出ない。「全部」で出る', async () => {
  const root = render({ isOwner: false, issues: myIssues });
  assert.equal(has(root, 'data-my-issue'), 1);
  assert.equal(has(root, 'data-approval'), 0, '承認は出ない');
  assert.equal(has(root, 'data-decision'), 0, '判断は出ない');
  click(R.byAttr(root.tree, 'data-scope', 'all')); await R.settle(2);
  assert.equal(has(root, 'data-approval'), 1, '「全部」では承認も出る');
  assert.equal(has(root, 'data-decision'), 1);
});

test('持ち主の「自分宛て」: 承認と判断と自分の課題', () => {
  const root = render({ isOwner: true, issues: [] });
  assert.equal(has(root, 'data-approval'), 1);
  assert.equal(has(root, 'data-decision'), 1);
  assert.equal(has(root, 'data-my-issue'), 0);
});

test('ログイン中の人が分からない所（前の版）は切り替えを出さず全部', () => {
  const root = render(null);
  assert.equal(has(root, 'data-inbox-scope'), 0);
  assert.equal(has(root, 'data-approval'), 1);
  assert.equal(has(root, 'data-decision'), 1);
});

test('自分宛ての課題は、閉じていない物だけを本体で絞り、500 件を超えても最後のページまで読む（codex の最終確認 P2）', async () => {
  const { createApi } = await import('../plugins/office/src/api.mjs');
  const urls = [];
  const all = Array.from({ length: 1201 }, (_, k) => ({ id: `i${String(k).padStart(5, '0')}`, assigneeUserId: 'u2', status: 'todo' }));
  let reads = 0;
  const api = createApi(async url => {
    urls.push(url);
    const q = new URL(url, 'http://x').searchParams;
    assert.equal(q.get('offset'), null, 'offset は使わない（本体は afterId と offset を一緒に受けない）');
    const a = q.get('afterId');
    const page = all.filter(i => !a || i.id > a).slice(0, Number(q.get('limit')));
    if (reads++ === 0) all.splice(0, 100); // 1 ページ目を読んだ直後に 100 件が閉じて列から消えても、読み落とさない（17 回目のレビュー P2 の兄弟）
    return { ok: true, status: 200, json: async () => page };
  });
  const got = await api.myIssues('c1', 'u2');
  assert.equal(got.length, 1201, '101 件目より後も読む');
  assert.equal(urls.length, 3);
  for (const u of urls) assert.match(u, /status=backlog,todo,in_progress,in_review,blocked&/, '閉じた課題で枠を埋めない');
});
