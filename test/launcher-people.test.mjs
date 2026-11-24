// 人と承認の列（設計 docs/design/2026-11-23-public-office-multi-user.md 2.5）
import test from 'node:test';
import assert from 'node:assert/strict';
import { isPerson, peopleIndex, setBoss, relayConfig, peopleRows } from '../packages/aioffice/launcher/lib/people.mjs';

const m = (id, role = 'operator', extra = {}) => ({ principalType: 'user', principalId: id, status: 'active', membershipRole: role, user: { name: id.toUpperCase(), email: `${id}@x.test` }, ...extra });
const byCo = { c1: [m('own', 'owner'), m('a'), m('b'), m('v', 'viewer'), m('local-board', 'owner'), m('gone', 'operator', { status: 'archived' }), { principalType: 'agent', principalId: 'ag', status: 'active', membershipRole: 'operator' }], c2: [m('a')] };

test('人は user・active・viewer でない・local-board でない。会社をまたいだ人は 1 人にまとめる', () => {
  assert.equal(isPerson(m('v', 'viewer')), false);
  const ix = peopleIndex(byCo);
  assert.deepEqual(Object.keys(ix).sort(), ['a', 'b', 'own']);
  assert.deepEqual(ix.a.companies, ['c1', 'c2']);
});

test('上の人: 自分・輪・知らない人は断る。空で外す', () => {
  const ix = peopleIndex(byCo);
  let p = setBoss({}, 'b', 'a', ix).people;
  p = setBoss(p, 'a', 'own', ix).people;
  assert.equal(setBoss(p, 'own', 'b', ix).error, 'boss_loop');
  assert.equal(setBoss(p, 'a', 'a', ix).error, 'boss_self');
  assert.equal(setBoss(p, 'a', 'v', ix).error, 'person_unknown');
  assert.equal(setBoss(p, 'a', null, ix).people.a.boss, undefined);
});

test('relay の設定: directory は全部の会社の人・approvers は上の人・defaultRequester は持ち主。会社から外れた上の人の手前で止める', () => {
  const ix = peopleIndex(byCo);
  const cfg = relayConfig({ index: ix, people: { b: { boss: 'a' }, a: { boss: 'own' }, own: { boss: 'gone' } }, ownerUserId: 'own' });
  assert.deepEqual(cfg.approvers, { b: 'a', a: 'own' });
  assert.equal(cfg.defaultRequester, 'own');
  assert.deepEqual(cfg.directory.a, { name: 'A', email: 'a@x.test', companies: ['c1', 'c2'] });
  assert.equal(relayConfig({ index: ix, people: {}, ownerUserId: 'local-board' }).defaultRequester, undefined);
  const rows = peopleRows({ index: ix, people: { own: { boss: 'gone' }, a: { mail: 'a@x.test', mailConfirmed: true } } });
  assert.deepEqual(rows.find(r => r.userId === 'own').warn, ['boss_gone', 'mail_unconfirmed']);
  assert.deepEqual(rows.find(r => r.userId === 'a').warn, []);
});
