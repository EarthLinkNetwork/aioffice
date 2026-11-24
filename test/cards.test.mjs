// mobile plugin の card の型（plugins/mobile/src/cards.mjs）。設計: README.md
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as M from '../plugins/mobile/src/cards.mjs';

const ap = (payload, extra = {}) => ({ id: 'a1', type: 'request_board_approval', status: 'pending', payload, createdAt: '2026-11-10T00:00:00Z', requestedByAgentId: 'g1', ...extra });

test('送る本文がある承認は external-send で、送る本文を全文の欄に出す（返信の承認）', () => {
  const body = 'x'.repeat(3000);
  const c = M.approvalToCard(ap({ title: '返信', summary: 's', replyBody: body, gmailMessageId: 'm1', options: ['approve', 'reject'] }));
  assert.equal(c.risk, 'external-send');
  assert.deepEqual(c.sections[0], { kind: 'outgoing', label: 'Outgoing text', text: body });
  assert.ok(c.sections.some(s => s.label === 'gmailMessageId'));
  assert.deepEqual(c.options.map(o => o.id), ['approve', 'reject']);
});

test('SNS の投稿の承認（body・channel・targetUrl）は external-send・URL はリンクにする', () => {
  const c = M.approvalToCard(ap({ title: 'Qiita', body: '返事', channel: 'qiita', targetUrl: 'https://qiita.com/x' }));
  assert.equal(c.risk, 'external-send');
  assert.equal(c.sections[0].text, '返事');
  assert.deepEqual(c.links, [{ label: 'targetUrl', url: 'https://qiita.com/x' }]);
});

test('送るものが無い承認は internal・payload.risk があればそれを使う', () => {
  assert.equal(M.approvalToCard(ap({ title: 'レビュー', findings: '3 件', verdict: 'approve' })).risk, 'internal');
  assert.equal(M.approvalToCard(ap({ title: '購入', risk: 'money' })).risk, 'money');
  assert.equal(M.approvalToCard(ap({ title: 'x', risk: 'nonsense' })).risk, 'internal');
});

test('送る本文の項目の名前は設定で替えられる', () => {
  assert.equal(M.approvalToCard(ap({ title: 'x', message: 'hi' }), { sendKeys: ['message'] }).risk, 'external-send');
  assert.equal(M.approvalToCard(ap({ title: 'x', message: 'hi' })).risk, 'internal');
});

test('受信箱は承認待ちだけを新しい順に・却下には理由が要る印', () => {
  const list = M.inbox([ap({ title: '古い' }, { id: 'o', createdAt: '2026-11-01T00:00:00Z' }), ap({ title: '済み' }, { id: 'd', status: 'approved' }), ap({ title: '新しい' }, { id: 'n', createdAt: '2026-11-09T00:00:00Z' })]);
  assert.deepEqual(list.map(c => c.id), ['n', 'o']);
  assert.equal(list[0].actions.find(a => a.id === 'reject').needsNote, true);
});

test('判断カードは選択肢・入力欄・期限・本文をそのまま card にし、効き目（effects）は出さない', () => {
  const c = M.decisionToCard({ id: 'd1', title: 'povo の更新', body: '確かめて', status: 'open', expiresAt: '2026-11-12T00:00:00Z', originAgentId: 'g', originIssueId: 'i',
    options: [{ id: 'done', label: 'やった', style: 'primary', effects: [{ type: 'comment_on_issue' }] }, { id: 'drop', label: 'やらない', style: 'destructive' }],
    inputs: [{ id: 'note', label: 'ひとこと', required: false, maxLength: 500 }], metadata: {} });
  assert.equal(c.kind, 'decision'); assert.equal(c.risk, 'internal');
  assert.deepEqual(c.options, [{ id: 'done', label: 'やった', style: 'primary' }, { id: 'drop', label: 'やらない', style: 'destructive' }]);
  assert.deepEqual(c.inputs, [{ id: 'note', label: 'ひとこと', required: false, maxLength: 500 }]);
  assert.equal(c.deadline, '2026-11-12T00:00:00Z'); assert.equal(c.sections[0].text, '確かめて');
  assert.ok(!JSON.stringify(c).includes('comment_on_issue'));
  assert.equal(M.decisionToCard({ id: 'd2', title: 'x', options: [], metadata: { risk: 'money' } }).risk, 'money');
});

test('お金の言葉がある承認・判断カードは money（risk の書き忘れでも通知のボタンで押させない）', () => {
  assert.equal(M.decisionToCard({ id: 'd', title: 'GIF 出力: 試行の費用 上限1米ドル', options: [{ id: 'go', label: '試してよい' }] }).risk, 'money');
  assert.equal(M.decisionToCard({ id: 'd', title: 'povo の更新', body: 'アプリを更新', options: [{ id: 'done', label: 'やった' }] }).risk, 'internal');
  assert.equal(M.approvalToCard(ap({ title: 'AWS の上限', summary: '月 $50 まで' })).risk, 'money');
  assert.equal(M.approvalToCard(ap({ title: 'PR レビュー', summary: '3 件の指摘' })).risk, 'internal');
  // 本文の説明の言葉では当てない（実物の判断カードで誤って当たった文）
  assert.equal(M.decisionToCard({ id: 'd', title: 'povo アプリ更新確認', body: '放置するとアプリからトッピングを購入できません', options: [{ id: 'done', label: 'やった' }] }).risk, 'internal');
  assert.equal(M.decisionToCard({ id: 'd', title: 'Getchu 再設定', body: '明示期限・費用の記載はありません', options: [{ id: 'done', label: 'やった' }] }).risk, 'internal');
  assert.equal(M.decisionToCard({ id: 'd', title: 'サーバーの更新', body: '月 3,000 円かかる', options: [{ id: 'go', label: '進める' }] }).risk, 'money');
});
