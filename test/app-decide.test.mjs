// 判断の件で選択肢を押した時の次の段（apps/mobile/src/decide.ts）。1 回押したら送る・理由が要る操作は理由の欄・外への送信やお金は確かめる。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { choiceStep, choiceOptions } from '../apps/mobile/src/decide.ts';

const card = (o = {}) => ({ v: 1, id: 'c1', bindingId: 'b1', kind: 'decision', risk: 'internal', title: 't', summary: '', recommendation: '', options: [], deadline: null, sections: [], links: [], createdAt: null, actions: [], ...o });

test('社内の件: 選択肢を押したらすぐ送る', () => {
  const c = card({ options: [{ id: 'done', label: 'やった' }], actions: [{ id: 'done', label: 'やった' }] });
  assert.equal(choiceStep(c, 'done'), 'send');
});

test('理由が要る操作（断る）: 理由の欄を出す', () => {
  const c = card({ kind: 'interaction', actions: [{ id: 'accept', label: '受ける' }, { id: 'reject', label: '断る', needsNote: true }] });
  assert.equal(choiceStep(c, 'reject'), 'note');
  assert.equal(choiceStep(c, 'accept'), 'send');
});

test('外への送信・お金・取り消せない件: 確かめの画面を挟む', () => {
  for (const risk of ['external-send', 'money', 'irreversible']) {
    assert.equal(choiceStep(card({ risk, actions: [{ id: 'done', label: 'やった' }] }), 'done'), 'confirm');
  }
});

test('選択肢: options があればそれ、無ければ actions から作る', () => {
  assert.deepEqual(choiceOptions(card({ options: [{ id: 'a', label: 'A' }] })).map(o => o.id), ['a']);
  assert.deepEqual(choiceOptions(card({ actions: [{ id: 'x', label: 'X' }] })).map(o => o.id), ['x']);
});
