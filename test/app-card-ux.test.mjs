// 判断カードの使い勝手（docs/design/2026-11-22-app-card-ux.md）のアプリの決め事: 共通の操作の分け方・要約の出し方・話へ渡す本文・カードと話の行き来。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { choiceStep, choiceOptions } from '../apps/mobile/src/decide.ts';
import { commonActions, shownSummary } from '../apps/mobile/src/card.ts';
import { cardChatText, cardOfThread, CARD_PREFIX } from '../apps/mobile/src/chat/logic.ts';
import { root, push, top, openCardThreadStack, toCardFromChat, chatRoute, backLabel } from '../apps/mobile/src/chat/nav.ts';

const card = (o = {}) => ({ v: 1, id: 'decision:co1:d1', bindingId: 'b1', kind: 'decision', risk: 'internal', title: '会議の日程', summary: '', recommendation: '', options: [], deadline: null, sections: [], links: [], createdAt: null, actions: [], ...o });
const COMMON = [{ id: 'aio:none', label: 'どれでもない（理由を書いて返す）', needsNote: true }, { id: 'aio:resolve', label: '解決にする' }, { id: 'aio:refresh', label: '判断を最新にする' }];

test('共通の操作は選択肢に混ぜず、別の並びに出す（確認の件の 2 択にも足される）', () => {
  const c = card({ kind: 'interaction', actions: [{ id: 'accept', label: 'はい' }, { id: 'reject', label: 'いいえ' }, ...COMMON.filter(a => a.id !== 'aio:resolve')] });
  assert.deepEqual(choiceOptions(c).map(o => o.id), ['accept', 'reject']);
  assert.deepEqual(commonActions(c).map(a => a.id), ['aio:none', 'aio:refresh']);
  const d = card({ options: [{ id: 'a', label: '火曜' }], actions: [{ id: 'a', label: '火曜' }, ...COMMON] });
  assert.deepEqual(choiceOptions(d).map(o => o.id), ['a']);
  assert.deepEqual(commonActions(d).map(a => a.id), ['aio:none', 'aio:resolve', 'aio:refresh']);
});

test('どれでもないは理由を書く・最新にするはすぐ送る・お金の件の解決にするは確かめる', () => {
  const d = card({ actions: COMMON });
  assert.equal(choiceStep(d, 'aio:none'), 'note');
  assert.equal(choiceStep(d, 'aio:refresh'), 'send');
  assert.equal(choiceStep(d, 'aio:resolve'), 'send');
  assert.equal(choiceStep(card({ risk: 'money', actions: COMMON }), 'aio:resolve'), 'confirm');
  assert.equal(choiceStep(card({ risk: 'money', actions: COMMON }), 'aio:refresh'), 'send');
});

test('画面の要約: 頭の「会社 · 担当」は外す・本文から作った要約は出さない（本文と 2 回出さない）', () => {
  assert.equal(shownSummary(card({ from: '見本の会社 · 事務担当', summary: '見本の会社 · 事務担当\n返信を送ってよいか' })), '返信を送ってよいか');
  assert.equal(shownSummary(card({ from: '見本の会社 · 事務担当', summary: '見本の会社 · 事務担当\n来週の定例', summaryDerived: true })), '');
  assert.equal(shownSummary(card({ summary: '前の形の要約' })), '前の形の要約');
});

test('話へ渡す本文: 題・本文の先頭・選択肢（共通の操作は入れない）・書いた一言。お金の件は本文を入れない', () => {
  const sections = [{ kind: 'body', label: 'Details', text: '来週の定例をいつにするか決めてください。' }];
  const actions = [{ id: 'a', label: '火曜' }, ...COMMON];
  const t = cardChatText(card({ from: '見本の会社 · 事務担当', summary: '見本の会社 · 事務担当\n来週の定例', summaryDerived: true, sections, options: [{ id: 'a', label: '火曜' }], actions }), '木曜も候補にしたい');
  assert.ok(t.startsWith(`${CARD_PREFIX}会議の日程`));
  assert.ok(t.includes('詳細:\n来週の定例をいつにするか決めてください。'));
  assert.ok(t.includes('・火曜'));
  assert.ok(!t.includes('どれでもない'));
  assert.ok(t.endsWith('木曜も候補にしたい'));
  const m = cardChatText(card({ risk: 'money', sections: [{ kind: 'body', label: 'Details', text: '5000 円の請求' }] }));
  assert.ok(!m.includes('5000 円の請求'));
});

test('話から元のカードを探す: card に付いた話・この端末で始めた話。無ければ null', () => {
  const a = card({ id: 'k1', thread: { id: 't1', agentId: 'g1' } });
  const b = card({ id: 'k2' });
  const local = new Map([['k2', { threadId: 't2' }]]);
  assert.equal(cardOfThread([a, b], 't1', local)?.id, 'k1');
  assert.equal(cardOfThread([a, b], 't2', local)?.id, 'k2');
  assert.equal(cardOfThread([a, b], 't3', local), null);
  assert.equal(cardOfThread([a, b], null, local), null);
});

test('返事の通知から: 受信箱 → カード → 話。札を押すと、一つ前のカードへ戻る・でなければカードを積む', () => {
  const c = card({ thread: { id: 't1', agentId: 'g1' } });
  const s = openCardThreadStack(c, { threadId: 't1', agentName: '事務担当' });
  assert.deepEqual(s.map(r => r.name), ['inbox', 'card', 'chat']);
  assert.equal(top(s).cardId, c.id);
  assert.equal(top(s).agentId, 'g1');
  assert.equal(backLabel(s), '‹ 判断');
  assert.deepEqual(toCardFromChat(s, c).map(r => r.name), ['inbox', 'card']);
  const fromSecretary = push(root('secretary'), chatRoute('g1', '事務担当', 't1'));
  assert.deepEqual(toCardFromChat(fromSecretary, c).map(r => r.name), ['secretary', 'chat', 'card']);
});

test('埋め込みの話の最初の発言は、件の中身つきの本文の最後の段落（自分の一言）だけを出す材料になる', async () => {
  const { DEFAULT_ASK } = await import('../apps/mobile/src/chat/logic.ts');
  const t = cardChatText(card({ sections: [{ kind: 'body', label: 'Details', text: '本文' }] }), '木曜にしたい');
  assert.equal(t.split('\n\n').pop(), '木曜にしたい');
  assert.equal(cardChatText(card()).split('\n\n').pop(), DEFAULT_ASK);
});
