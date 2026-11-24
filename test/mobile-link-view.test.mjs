import test from 'node:test';
import assert from 'node:assert/strict';
import { linkView } from '../plugins/mobile/src/link-view.mjs';

const NOW = Date.parse('2026-11-13T00:00:00Z');
const p = (bindingId, state, minAgo, left = 5, email = null) => ({ bindingId, state, email, createdAt: new Date(NOW - minAgo * 60_000).toISOString(), expiresAt: new Date(NOW + left * 60_000).toISOString() });

test('何も無ければ none・配列でなくても落ちない', () => {
  assert.deepEqual(linkView([], NOW), { kind: 'none' });
  assert.deepEqual(linkView(null, NOW), { kind: 'none' });
});
test('claimed があれば確認を新しい順に出す（waiting より先）', () => {
  const v = linkView([p('a', 'claimed', 5, 5, 'a@x'), p('w', 'waiting', 1), p('b', 'claimed', 2, 8, 'b@x')], NOW);
  assert.equal(v.kind, 'claimed');
  assert.deepEqual(v.items.map(i => i.bindingId), ['b', 'a']);
});
test('waiting は新しいものを出し、あと何分かを返す・切れたものは出さない', () => {
  const v = linkView([p('old', 'waiting', 9, 1), p('new', 'waiting', 1, 4)], NOW);
  assert.deepEqual([v.kind, v.item.bindingId, v.minutesLeft], ['waiting', 'new', 4]);
  assert.deepEqual(linkView([p('gone', 'claimed', 11, -1, 'a@x')], NOW), { kind: 'none' });
});

test('unknown（読めなかった件）は waiting と同じく表示を保つ', () => {
  const v = linkView([p('u', 'unknown', 1, 4)], NOW);
  assert.deepEqual([v.kind, v.item.bindingId], ['waiting', 'u']);
});
