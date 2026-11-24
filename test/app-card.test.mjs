// アプリの card の判定（apps/mobile/src/card.ts）。急ぎ・札・一覧から見たにできるかを mock の見本どおりに決める。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isGuarded, isUrgent, pillsOf, kindTitle, relTime } from '../apps/mobile/src/card.ts';

// 日付の区切りは端末の時刻帯で決まる。test は見本と同じ日本時間で見る
process.env.TZ = 'Asia/Tokyo';
const NOW = Date.parse('2026-11-10T07:43:00+09:00');
const card = o => ({ v: 1, id: 'x', kind: 'approval', risk: 'internal', title: 't', summary: '', recommendation: '', options: [], deadline: null, sections: [], links: [], createdAt: null, actions: [], ...o });

test('急ぎ: 期限が今日か明日なら急ぎ、明後日は急ぎでない（mock: 期限 11/11 は急ぎ・締切 11/12 は急ぎでない）', () => {
  assert.equal(isUrgent(card({ deadline: '2026-11-11T18:00:00+09:00' }), NOW), true);
  assert.equal(isUrgent(card({ deadline: '2026-11-12T09:00:00+09:00' }), NOW), false);
  assert.equal(isUrgent(card({ tags: [{ tone: 'urgent', label: '急ぎ' }] }), NOW), true);
  assert.equal(isUrgent(card({}), NOW), false);
});

test('札: 急ぎ・外への送信・お金・取り消せない、サーバーの札は重ねない', () => {
  const labels = c => pillsOf(c, NOW).map(p => p.label);
  assert.deepEqual(labels(card({ risk: 'external-send', deadline: '2026-11-10T20:00:00+09:00' })), ['急ぎ', '外への送信']);
  assert.deepEqual(labels(card({ risk: 'money', tags: [{ tone: 'urgent', label: '急ぎ' }] })), ['急ぎ', 'お金']);
  assert.deepEqual(labels(card({ risk: 'external-send', tags: [{ tone: 'sns', label: 'SNS の通知' }] })), ['外への送信', 'SNS の通知']);
  assert.deepEqual(labels(card({ risk: 'irreversible' })), ['取り消せない']);
});

test('外への送信・お金・取り消せない件は一覧から見たにできない（開いて全文を見てから決める）', () => {
  assert.equal(isGuarded(card({ risk: 'internal' })), false);
  for (const risk of ['external-send', 'money', 'irreversible']) assert.equal(isGuarded(card({ risk })), true);
});

test('画面の題と時刻の表示', () => {
  assert.equal(kindTitle(card({ risk: 'external-send' })), '送信の承認');
  assert.equal(kindTitle(card({ kind: 'decision' })), '判断カード');
  assert.equal(relTime(new Date(NOW - 5 * 60000).toISOString(), NOW), '5分前');
  assert.equal(relTime(new Date(NOW - 26 * 3600000).toISOString(), NOW), '昨日');
});
