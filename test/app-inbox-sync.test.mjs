// 結びつけの後の会社一覧の読み直し・押した通知の件の読み方・バッジの件数（apps/mobile/src/notify/offices.ts と push-logic.ts）。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { badgeTotal, isStaleLoad, pickOffice, syncOffices } from '../apps/mobile/src/notify/offices.ts';
import { tapTargetOf } from '../apps/mobile/src/notify/push-logic.ts';

const off = (id, pending, canView = true) => ({ id, name: id, pending, canView });

test('A: サインインの後に結びつけた時、読み直した一覧から office を選び受信箱が件を読む', async () => {
  let bound = false;
  const cardsAsked = [];
  const client = {
    listOffices: async () => (bound ? [off('b1', 25)] : []),
    listCards: async id => { cardsAsked.push(id); return id === 'b1' ? [{ id: 'c1' }] : []; },
  };
  const before = await syncOffices(client, null);
  assert.equal(before.officeId, null); // サインイン直後は空のまま
  bound = true;
  const after = await syncOffices(client, before.officeId);
  assert.equal(after.officeId, 'b1');
  assert.deepEqual(await client.listCards(after.officeId), [{ id: 'c1' }]);
  assert.deepEqual(cardsAsked, ['b1']);
});

test('A: 選んでいる office が一覧に無い・見る権限が無い時は最初の canView、あれば維持', () => {
  const list = [off('x', 1, false), off('b1', 2), off('b2', 3)];
  assert.equal(pickOffice(list, null), 'b1');
  assert.equal(pickOffice(list, 'gone'), 'b1');
  assert.equal(pickOffice(list, 'x'), 'b1');
  assert.equal(pickOffice(list, 'b2'), 'b2');
  assert.equal(pickOffice([], null), null);
  assert.equal(pickOffice([off('x', 1, false)], null), null);
});

test('B: content.data が空でも trigger.payload の bindingId・cardId で開く', () => {
  const payload = { aps: { alert: 'x' }, bindingId: 'b1', cardId: 'c1' };
  assert.deepEqual(tapTargetOf({ data: undefined }, { type: 'push', payload }), { bindingId: 'b1', cardId: 'c1' });
  assert.deepEqual(tapTargetOf({}, { type: 'push', payload }), { bindingId: 'b1', cardId: 'c1' });
  assert.deepEqual(tapTargetOf({ data: {} }, { type: 'push', payload }), { bindingId: 'b1', cardId: 'c1' });
});

test('B: content.data が正しければそれを優先・どちらにも無ければ null', () => {
  assert.deepEqual(tapTargetOf({ data: { bindingId: 'd', cardId: 'e' } }, { type: 'push', payload: { bindingId: 'b1', cardId: 'c1' } }), { bindingId: 'd', cardId: 'e' });
  for (const t of [null, undefined, 'x', { type: 'push' }, { type: 'push', payload: { bindingId: 'b1' } }]) assert.equal(tapTargetOf({ data: undefined }, t), null);
  assert.equal(tapTargetOf(null, null), null);
});

test('C: バッジは見える全 office の未読の合計・見えない office と負の値は数えない', async () => {
  assert.equal(badgeTotal([off('a', 25), off('b', 3), off('c', 9, false)]), 28);
  assert.equal(badgeTotal([]), 0);
  assert.equal(badgeTotal([off('a', -4)]), 0);
  const r = await syncOffices({ listOffices: async () => [off('a', 25)] }, null);
  assert.equal(r.badge, 25);
});

test('古い office の load の結果は捨てる・officeId が null でもつないだ後の一覧の読み直しで office が決まる', async () => {
  assert.equal(isStaleLoad('a', 'b'), true);
  assert.equal(isStaleLoad('a', null), true);
  assert.equal(isStaleLoad('a', 'a'), false);
  // つないだ直後は canView=false(承認待ち)で officeId は null。承認後の読み直し(引いた時)で選ばれる
  let approved = false;
  const client = { listOffices: async () => [off('b1', 3, approved)] };
  const r1 = await syncOffices(client, null);
  assert.equal(r1.officeId, null);
  assert.equal(r1.badge, 0);
  approved = true;
  const r2 = await syncOffices(client, r1.officeId);
  assert.equal(r2.officeId, 'b1');
  assert.equal(r2.badge, 3);
});
