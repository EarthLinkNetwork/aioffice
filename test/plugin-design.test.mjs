// デザイン部の依頼の口（plugins/design）の試験。本体は偽物
import test from 'node:test';
import assert from 'node:assert/strict';
import { checkRequest, issueOf, originIdOf, ORIGIN_KIND } from '../plugins/design/src/request.mjs';

const { handleRequest, queuesSize } = await import('../plugins/design/src/worker.mjs').catch(() => ({}));

test('依頼を確かめる: 種類・名前・長さ・担当', () => {
  assert.deepEqual(checkRequest({ kind: 'poster', name: 'x', agentId: 'a' }), { ok: false, error: 'design_bad_kind' });
  assert.deepEqual(checkRequest({ kind: 'logo', name: ' ', agentId: 'a' }), { ok: false, error: 'design_need_name' });
  assert.deepEqual(checkRequest({ kind: 'flyer', name: '', agentId: 'a' }), { ok: false, error: 'design_need_title' });
  assert.equal(checkRequest({ kind: 'logo', name: 'x'.repeat(81), agentId: 'a' }).error, 'design_name_too_long');
  assert.equal(checkRequest({ kind: 'logo', name: 'x', brief: 'y'.repeat(2001), agentId: 'a' }).error, 'design_brief_too_long');
  assert.equal(checkRequest({ kind: 'logo', name: 'x' }).error, 'design_no_agent');
  assert.deepEqual(checkRequest({ kind: 'logo', name: ' Sample\u0007 ', brief: '', agentId: 'a1', lang: 'fr' }), { ok: true, kind: 'logo', name: 'Sample', brief: '', lang: 'en', agentId: 'a1' });
});

test('課題の題と本文は英日で作り、同じ依頼は言語を替えても同じ id', () => {
  const en = issueOf({ kind: 'logo', name: 'Sample Studio', brief: '', lang: 'en' });
  const ja = issueOf({ kind: 'logo', name: 'Sample Studio', brief: '', lang: 'ja' });
  assert.equal(en.title, '[Design] Logo: Sample Studio'); assert.equal(ja.title, '[デザイン] ロゴ: Sample Studio');
  assert.match(en.description, /Attach the images/); assert.match(ja.description, /添付し/);
  assert.equal(originIdOf({ kind: 'logo', name: 'A', brief: 'b' }), originIdOf({ kind: 'logo', name: 'A', brief: 'b', lang: 'ja' }));
  assert.notEqual(originIdOf({ kind: 'logo', name: 'A', brief: 'b' }), originIdOf({ kind: 'flyer', name: 'A', brief: 'b' }));
});

function fakeCtx({ agents = [{ id: 'd1', name: 'Design Desk' }] } = {}) {
  const issues = [];
  return {
    agents: { list: async () => agents },
    issues: {
      list: async ({ originKind, originId }) => issues.filter(i => i.originKind === originKind && i.originId === originId),
      create: async b => { await new Promise(r => setTimeout(r, 5)); const i = { ...b, id: `i${issues.length + 1}`, identifier: `SAM-${issues.length + 1}` }; issues.push(i); return i; },
    },
    _issues: issues,
  };
}

test('依頼の口: 課題を作り、同じ依頼は同じ課題を返す（同時の 2 回でも 1 件）', { skip: !handleRequest }, async () => {
  const ctx = fakeCtx();
  const body = { kind: 'logo', name: 'Sample Studio', brief: 'round', agentId: 'd1', lang: 'en' };
  const [a, b] = await Promise.all([handleRequest(ctx, 'c1', body), handleRequest(ctx, 'c1', body)]);
  assert.deepEqual([a.status, b.status].sort(), [200, 201]);
  assert.equal(ctx._issues.length, 1);
  assert.equal(ctx._issues[0].originKind, ORIGIN_KIND); assert.equal(ctx._issues[0].assigneeAgentId, 'd1');
  const c = await handleRequest(ctx, 'c1', { ...body, lang: 'ja' });
  assert.deepEqual([c.status, c.body.already, c.body.issue.id], [200, true, 'i1']);
});

test('依頼の口: 閉じた課題は数えず、新しく作る', { skip: !handleRequest }, async () => {
  const ctx = fakeCtx();
  const body = { kind: 'flyer', name: 'Open day', agentId: 'd1' };
  await handleRequest(ctx, 'c1', body); ctx._issues[0].status = 'done';
  const r = await handleRequest(ctx, 'c1', body);
  assert.equal(r.status, 201); assert.equal(ctx._issues.length, 2);
});

test('依頼の口: 担当が会社にいなければ 404・中身が足りなければ 400', { skip: !handleRequest }, async () => {
  const ctx = fakeCtx({ agents: [] });
  assert.equal((await handleRequest(ctx, 'c1', { kind: 'logo', name: 'x', agentId: 'd1' })).status, 404);
  assert.equal((await handleRequest(ctx, 'c1', { kind: 'logo', name: '', agentId: 'd1' })).status, 400);
  assert.equal(ctx._issues.length, 0);
});

test('依頼の口: 処理が失敗しても次の依頼は通り、終わったら待ち行列が空になる', { skip: !handleRequest }, async () => {
  const ctx = fakeCtx(); let fail = true;
  const inner = ctx.issues.create; ctx.issues.create = async b => { if (fail) { fail = false; throw new Error('boom'); } return inner(b); };
  const unhandled = []; const on = e => unhandled.push(e); process.on('unhandledRejection', on);
  const body = { kind: 'logo', name: 'Queue', agentId: 'd1' };
  const [a, b] = await Promise.allSettled([handleRequest(ctx, 'c9', body), handleRequest(ctx, 'c9', body)]);
  await new Promise(r => setTimeout(r, 20)); process.off('unhandledRejection', on);
  assert.equal(a.status, 'rejected'); assert.equal(b.value.status, 201);
  assert.equal(queuesSize(), 0); assert.deepEqual(unhandled, []);
});
