import test from 'node:test';
import assert from 'node:assert/strict';
import { compareStates, searchHitsDoc } from './e2e/reinstall-compare.mjs';

const before = { cid: 'c1', docs: ['a.md'], chunks: 10, briefs: 2, read: ['n1'], unread: ['n2', 'n3'] };

test('入れ直しの比べ: 同じなら合格・所蔵が増えるのは合格', () => {
  assert.deepEqual(compareStates(before, { ...before }), []);
  assert.deepEqual(compareStates(before, { ...before, chunks: 12 }), []);
});

test('入れ直しの比べ: 既読が消える・未読が消える・既読に化ける・文書や添え書きが変わると落ちる（codex 2 回目 P2）', () => {
  assert.equal(compareStates(before, { ...before, read: [] }).length, 1, '既読の知らせが消えた');
  assert.equal(compareStates(before, { ...before, unread: ['n2'] }).length, 1, '未読の知らせが消えた');
  assert.equal(compareStates(before, { ...before, read: ['n1', 'n2'], unread: ['n3'] }).length, 1, '未読が既読に化けた');
  assert.equal(compareStates(before, { ...before, docs: [] }).length, 1);
  assert.equal(compareStates(before, { ...before, chunks: 9 }).length, 1);
  assert.equal(compareStates(before, { ...before, briefs: 3 }).length, 1);
  assert.equal(compareStates(before, { ...before, cid: 'c2' }).length, 1);
});

test('網なしの検索: 置いた文書そのものが当たった時だけ合格（別の文書だけでは落ちる・codex 2 回目 P2）', () => {
  assert.equal(searchHitsDoc([{ srcId: 'doc:unrelated.md' }], 'a.md'), false);
  assert.equal(searchHitsDoc([], 'a.md'), false);
  assert.equal(searchHitsDoc([{ srcId: 'doc:unrelated.md' }, { srcId: 'doc:a.md' }], 'a.md'), true);
});
