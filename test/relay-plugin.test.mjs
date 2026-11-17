// 回覧の plugin の中身（public/plugins/relay/src/lib.mjs）。設計 docs/design/2026-11-21-office-relay.md 4 節の unit。
// 会社 3 つ（A: 依頼元・B: 課長・C: 部長）を持つ見本の本体と、DB の代わりの記憶の store で、見回りの進み方を確かめる。
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { tick, createRequest, planRequest, approverChain, homeOf, answerOf, userIdOf, ORIGIN_KIND } from '../plugins/relay/src/lib.mjs';
import manifest from '../plugins/relay/src/manifest.mjs';

function memStore(now) {
  const reqs = new Map(), steps = new Map();
  const k = (id, s, r) => `${id}|${s}|${r}`;
  return {
    reqs, steps,
    createRequest: async r => { reqs.set(r.id, { ...structuredClone(r), step: 0, round: 0, state: 'open', result: null, reportedStep: 0, returned: false }); },
    getRequest: async id => (reqs.has(id) ? structuredClone(reqs.get(id)) : null),
    openFor: async (c, x, title) => structuredClone([...reqs.values()].filter(r => r.state === 'open' && r.originCompanyId === c && r.originIssueId === x && r.title === title)),
    openCountFor: async (c, x) => [...reqs.values()].filter(r => r.state === 'open' && r.originCompanyId === c && r.originIssueId === x).length,
    openRequests: async () => [...reqs.values()].filter(r => r.state === 'open').map(r => structuredClone(r)),
    originRequests: async c => [...reqs.values()].filter(r => r.originCompanyId === c && (r.state === 'open' || !r.returned)).map(r => structuredClone(r)),
    setRequest: async (id, p) => { Object.assign(reqs.get(id), structuredClone(p)); },
    claimStep: async s => { const key = k(s.requestId, s.step, s.round); if (steps.has(key)) return null; const row = { ...s, issueId: null, interactionId: null, state: 'open', answer: null, notified: false, updatedAt: new Date(now()).toISOString() }; steps.set(key, row); return structuredClone(row); },
    getStep: async (id, s, r) => (steps.has(k(id, s, r)) ? structuredClone(steps.get(k(id, s, r))) : null),
    stepsOf: async (c, states) => [...steps.values()].filter(s => s.companyId === c && states.includes(s.state)).map(s => structuredClone(s)),
    stepsToClose: async c => [...steps.values()].filter(s => s.companyId === c && !s.notified && reqs.get(s.requestId).state !== 'open' && ['open', 'done', 'invalid'].includes(s.state)).map(s => structuredClone(s)),
    setStep: async (id, s, r, p) => { Object.assign(steps.get(k(id, s, r)), structuredClone(p), { updatedAt: new Date(now()).toISOString() }); },
  };
}

function host() {
  const h = { issues: new Map(), interactions: [], comments: [], wakes: [], updates: [], n: 0, scope: null };
  // 本物の本体と同じく、会社に付いた呼び出しの中では、その会社の物しか読み書きさせない（SDK の InvocationScopeDeniedError）
  const inScope = c => assert.equal(c, h.scope, `呼び出しの会社 ${h.scope} の外（${c}）を読み書きしようとした`);
  h.inScope = inScope;
  h.issues.set('X', { id: 'X', companyId: 'A', title: '見積の件', status: 'in_progress', assigneeAgentId: 'g1', createdByUserId: 'staff' });
  const ctx = {
    issues: {
      get: async (id, c) => { inScope(c); const i = h.issues.get(id); return i && i.companyId === c ? structuredClone(i) : null; },
      list: async ({ companyId, originKind, originId }) => inScope(companyId) || [...h.issues.values()].filter(i => i.companyId === companyId && i.originKind === originKind && i.originId === originId),
      create: async input => { inScope(input.companyId); const id = `Y${++h.n}`; const i = { id, ...input, createdByUserId: null }; h.issues.set(id, i); return structuredClone(i); },
      update: async (id, patch, c, actor) => { inScope(c); const i = h.issues.get(id); assert.equal(i.companyId, c, '別の会社の課題を変えない'); Object.assign(i, patch); h.updates.push({ id, ...patch, actor: actor || null }); return structuredClone(i); },
      createComment: async (id, body, c) => { inScope(c); assert.equal(h.issues.get(id).companyId, c, '別の会社の課題に書かない'); h.comments.push({ id, body }); return { id: `cm${h.comments.length}` }; },
      createInteraction: async (issueId, it, c) => {
        inScope(c);
        assert.equal(h.issues.get(issueId).companyId, c);
        const dup = h.interactions.find(x => x.issueId === issueId && x.idempotencyKey === it.idempotencyKey);
        if (dup) return structuredClone(dup);
        const x = { id: `it${h.interactions.length + 1}`, issueId, companyId: c, status: 'pending', ...structuredClone(it) }; h.interactions.push(x); return structuredClone(x);
      },
      listInteractions: async (issueId, c) => inScope(c) || h.interactions.filter(x => x.issueId === issueId && x.companyId === c).map(x => structuredClone(x)),
      requestWakeup: async (id, c, o) => { inScope(c); h.wakes.push({ id, c, ...o }); return { queued: true }; },
    },
  };
  // 人が答える（宛先でない人も答えられる・本体の human_only は人なら誰でも通すため）
  h.answer = (issueId, by, kind, value) => {
    const x = h.interactions.filter(i => i.issueId === issueId && i.status === 'pending').pop();
    assert.ok(x, `${issueId} に答える口がない`);
    x.resolvedByUserId = by;
    if (kind === 'question') { x.status = 'answered'; x.result = { version: 1, answers: [{ questionId: 'q', optionIds: ['answer'], otherText: value }] }; }
    else { x.status = kind; x.result = { version: 1, outcome: kind, reason: value || null }; }
  };
  return { h, ctx };
}

const CFG = {
  // companies は relay-config が全部の会社の member から書く（宛先にできる会社の一覧）
  directory: { staff: { name: '担当者', companies: ['A'] }, kacho: { name: '課長', email: 'kacho@example.com', companies: ['B'] }, bucho: { name: '部長', companies: ['B', 'C'] }, sato: { name: '佐藤', companies: ['C'] } },
  approvers: { staff: 'kacho', kacho: 'bucho' },
  homes: { bucho: 'C' },
};
const MEMBERS = [
  { companyId: 'A', userId: 'staff', principalType: 'user', status: 'active', membershipRole: 'member' },
  { companyId: 'B', userId: 'kacho', principalType: 'user', status: 'active', membershipRole: 'member' },
  { companyId: 'B', userId: 'bucho', principalType: 'user', status: 'active', membershipRole: 'owner' },
  { companyId: 'C', userId: 'bucho', principalType: 'user', status: 'active', membershipRole: 'owner' },
  { companyId: 'C', userId: 'sato', principalType: 'user', status: 'active', membershipRole: 'owner' },
];

function setup() {
  const { h, ctx } = host();
  const clock = { t: Date.parse('2026-11-22T00:00:00Z') };
  const store = memStore(() => clock.t);
  let n = 0;
  const deps = { ctx, store, now: () => clock.t, newId: () => `r${++n}`, cfgOf: async c => { h.inScope(c); return CFG; }, companyName: async id => { h.inScope(id); return `会社${id}`; }, memberships: async c => { h.inScope(c); return MEMBERS.filter(m => m.companyId === c); }, warn: (msg, meta) => { if (/呼び出しの会社/.test(meta?.error || '')) throw new Error(`会社の範囲の外を読んだ: ${meta.error}`); } };
  const round = async () => { for (const c of ['A', 'B', 'C']) { h.scope = c; await tick(deps, c); } };
  const tickOnly = c => { h.scope = c; return tick(deps, c); };
  const ask = body => (h.scope = 'A', createRequest)(deps, { companyId: 'A', issueId: 'X', actor: { actorType: 'agent', agentId: 'g1', runId: 'run1' }, body });
  return { h, ctx, store, deps, round, tickOnly, ask, clock };
}
const issueFor = (h, userId) => [...h.issues.values()].filter(i => i.assigneeUserId === userId).pop();

test('manifest: 出す口は担当だけ・会社は課題から・見回りの口は board と query の会社', () => {
  const r = Object.fromEntries(manifest.apiRoutes.map(x => [x.routeKey, x]));
  assert.equal(r.request.auth, 'agent');
  assert.deepEqual(r.request.companyResolution, { from: 'issue', param: 'issueId' });
  assert.equal(r.request.checkoutPolicy, 'required-for-agent-in-progress');
  assert.deepEqual(r.tick.companyResolution, { from: 'query', key: 'companyId' });
  assert.equal(manifest.database.namespaceSlug, 'relay');
  assert.match(readFileSync(new URL('../plugins/relay/migrations/001_init.sql', import.meta.url), 'utf8'), /PRIMARY KEY \(request_id, step, round\)/);
});

test('宛先: 名前・email・userId で引ける・同じ名前が 2 人なら引かない・多社の人は homes が要る', () => {
  assert.equal(userIdOf(CFG, '課長'), 'kacho');
  assert.equal(userIdOf(CFG, 'KACHO@example.com'), 'kacho');
  assert.equal(userIdOf(CFG, 'bucho'), 'bucho');
  assert.equal(userIdOf({ directory: { a: { name: '同じ' }, b: { name: '同じ' } } }, '同じ'), null);
  // 届け先: homes → directory の companies（1 つだけの時）→ この会社の member。ほかの会社の member は出す口の中で読めないので設定で決める
  assert.equal(homeOf(CFG, 'bucho', []), 'C');
  assert.equal(homeOf({ directory: CFG.directory }, 'bucho', []), null, '2 つ以上の会社にいて homes が無い人は断る');
  assert.equal(homeOf({ directory: CFG.directory }, 'kacho', []), 'B');
  assert.equal(homeOf({ homes: { bucho: 'A' }, directory: CFG.directory }, 'bucho', []), null, 'homes が宛先にできる会社の外なら断る');
  assert.equal(homeOf({}, 'kacho', MEMBERS.filter(m => m.companyId === 'A')), null);
  assert.equal(homeOf({}, 'kacho', MEMBERS.filter(m => m.companyId === 'B')), 'B');
  assert.equal(homeOf({ directory: { x: { name: 'x' } } }, 'kacho', MEMBERS.filter(m => m.companyId === 'B')), null, 'directory がある形では、会社の一覧の無い人を推測で届けない');
  assert.equal(homeOf({ directory: { u: { name: '宛先' } }, homes: { u: 'B' } }, 'u', []), null, 'directory があって会社の一覧が無い人は、homes があっても断る（codex P2）');
  assert.equal(homeOf({ homes: { u: 'B' } }, 'u', []), 'B', 'directory の無い形（公開版）は homes を使う');
  assert.equal(userIdOf(CFG, 'sato', MEMBERS.filter(m => m.companyId === 'C')), 'sato');
  assert.equal(userIdOf(CFG, '持ち主', [{ companyId: 'A', userId: 'staff', principalType: 'user', status: 'active', membershipRole: 'member' }]), null, 'directory がある形では持ち主で引かない');
  assert.deepEqual(approverChain(CFG, 'staff'), ['kacho', 'bucho']);
  assert.deepEqual(approverChain({ approvers: { a: 'b', b: 'a' } }, 'a'), ['b']);
  assert.match(planRequest({ body: { kind: 'question', title: 't', to: ['誰か'] }, cfg: CFG, memberships: MEMBERS }).error, /宛先が見つかりません/);
  assert.match(planRequest({ body: { kind: 'question', title: 't', to: ['kacho', 'bucho'] }, cfg: CFG, memberships: MEMBERS }).error, /1 人/);
  assert.match(planRequest({ body: { kind: 'approval', title: 't' }, cfg: {}, memberships: MEMBERS }).error, /承認の列/);
  const viewer = [{ companyId: 'B', userId: 'kacho', principalType: 'user', status: 'active', membershipRole: 'viewer' }];
  assert.match(planRequest({ body: { kind: 'question', title: 't', to: ['kacho'] }, cfg: {}, memberships: viewer }).error, /宛先が見つかりません|届け先の会社/, 'viewer は宛先にしない');
});

test('質問: 宛先の会社に課題と答えの口ができ、答えが元の課題に戻り、X を todo に戻して担当を起こす', async () => {
  const { h, round, ask } = setup();
  const r = await ask({ kind: 'question', title: '来週の会議の日程', body: '火曜か水曜で', to: ['佐藤'] });
  assert.equal(r.status, 201);
  assert.deepEqual(r.body.waitingFor, ['佐藤']);
  assert.equal(h.issues.get('X').status, 'blocked');
  assert.deepEqual(h.updates[0].actor, { actorAgentId: 'g1', actorRunId: 'run1' });
  await round();
  const y = issueFor(h, 'sato');
  assert.equal(y.companyId, 'C');
  assert.equal(y.originKind, ORIGIN_KIND);
  assert.match(y.title, /^要対応: \[回覧\] 来週の会議の日程（会社A から）/);
  const it = h.interactions.find(x => x.issueId === y.id);
  assert.equal(it.kind, 'ask_user_questions');
  assert.equal(it.addresseeUserId, 'sato');
  assert.equal(it.resolverPolicy, 'human_only');
  assert.equal(it.continuationPolicy, 'none');
  await round(); // 答えが無い間は何もしない
  assert.equal(h.interactions.length, 1);
  h.answer(y.id, 'sato', 'question', '水曜の午後');
  await round(); await round(); // C の回で読み、次の A の回で戻す
  assert.equal(h.issues.get(y.id).status, 'done');
  assert.equal(h.issues.get('X').status, 'todo');
  assert.ok(h.comments.some(c => c.id === 'X' && c.body === '回覧の答え（佐藤さん）: 水曜の午後'));
  assert.deepEqual(h.wakes.map(w => [w.id, w.c]), [['X', 'A']]);
  await round(); // 2 回戻さない
  assert.equal(h.comments.filter(c => c.id === 'X' && c.body.startsWith('回覧の答え')).length, 1);
  assert.equal(h.wakes.length, 1);
});

test('多段の承認: 担当者 → 課長 → 部長 → 課長 → 担当者。課長は部長の承認が戻るまで待ち、戻ってきた同じ課題で確かめて担当者に戻す', async () => {
  const { h, round, ask } = setup();
  const r = await ask({ kind: 'approval', title: '見積 A 案で出す' });
  assert.deepEqual(r.body.waitingFor, ['課長', '部長']);
  await round();
  const y1 = issueFor(h, 'kacho');
  assert.equal(y1.companyId, 'B');
  assert.equal(h.interactions.find(x => x.issueId === y1.id).payload.acceptLabel, '承認して 部長 に回す');
  assert.equal(issueFor(h, 'bucho'), undefined);
  h.answer(y1.id, 'kacho', 'accepted');
  await round(); await round();
  assert.equal(h.issues.get(y1.id).status, 'blocked', '課長の課題は済みにせず、部長の承認が戻るまで待つ');
  assert.ok(h.comments.some(c => c.id === y1.id && /部長さんに回しました。承認が戻るとこの課題に戻ります/.test(c.body)));
  assert.ok(h.comments.some(c => c.id === 'X' && /部長さんの承認を待っています（2\/3 段目）/.test(c.body)));
  assert.equal(h.issues.get('X').status, 'blocked');
  await round();
  const y2 = issueFor(h, 'bucho');
  assert.equal(y2.companyId, 'C'); // homes で C
  assert.equal(h.interactions.filter(x => x.issueId === y2.id).pop().payload.acceptLabel, '承認して 課長 に戻す');
  h.answer(y2.id, 'bucho', 'accepted');
  await round(); await round();
  // 部長の承認で、課長の同じ課題が開き直り、課長に確かめの口が出る。X はまだ戻らない
  assert.equal(h.issues.get(y2.id).status, 'done');
  assert.equal(h.issues.get(y1.id).status, 'todo');
  assert.equal(issueFor(h, 'kacho').id, y1.id, '課長の課題は作り直さず同じ課題に戻る');
  const back = h.interactions.filter(x => x.issueId === y1.id).pop();
  assert.equal(back.status, 'pending');
  assert.equal(back.payload.acceptLabel, '確かめて依頼元に戻す');
  assert.equal(back.payload.rejectLabel, '差し戻す');
  assert.ok(h.comments.some(c => c.id === y1.id && /部長さんが承認して戻ってきました/.test(c.body)));
  assert.ok(h.comments.some(c => c.id === 'X' && /上の承認が戻り、課長さんの確かめを待っています（3\/3 段目）/.test(c.body)));
  assert.equal(h.issues.get('X').status, 'blocked');
  // 戻りの段で宛先でない人が答えても進まず、出し直しの回で「戻ってきました」を 2 回書かない（独立レビュー Q1）
  h.answer(y1.id, 'sato', 'accepted');
  await round(); await round();
  assert.equal(h.comments.filter(c => c.id === y1.id && /戻ってきました/.test(c.body)).length, 1);
  assert.equal(h.issues.get('X').status, 'blocked');
  h.answer(y1.id, 'kacho', 'accepted');
  await round(); await round();
  assert.equal(h.issues.get(y1.id).status, 'done');
  assert.equal(h.issues.get('X').status, 'todo');
  assert.ok(h.comments.some(c => c.id === 'X' && c.body.startsWith('回覧の承認: 課長 → 部長 が承認しました')));
  assert.equal(h.wakes.length, 1);
});

test('多段の承認: 部長の承認が戻った後に課長が差し戻すと、理由つきで担当者に戻り、部長の課題にも知らせる', async () => {
  const { h, round, ask } = setup();
  await ask({ kind: 'approval', title: '見積 A 案で出す' });
  await round();
  const y1 = issueFor(h, 'kacho');
  h.answer(y1.id, 'kacho', 'accepted');
  await round(); await round();
  const y2 = issueFor(h, 'bucho');
  h.answer(y2.id, 'bucho', 'accepted');
  await round(); await round();
  h.answer(y1.id, 'kacho', 'rejected', '条件が変わった');
  await round(); await round();
  assert.equal(h.issues.get('X').status, 'todo');
  assert.ok(h.comments.some(c => c.id === 'X' && c.body === '回覧の差し戻し: 上の承認の後、課長さんが差し戻しました。理由: 条件が変わった'));
  assert.ok(h.comments.some(c => c.id === y2.id && c.body.startsWith('回覧の差し戻し:')));
  assert.equal(h.comments.filter(c => c.id === y1.id && c.body.startsWith('回覧の差し戻し:')).length, 0, '差し戻した本人の課題には書かない');
});

test('部長が却下したら、待っている課長の課題に結果を書いて閉じ、担当者に戻る', async () => {
  const { h, round, ask } = setup();
  await ask({ kind: 'approval', title: '見積 A 案で出す' });
  await round();
  const y1 = issueFor(h, 'kacho');
  h.answer(y1.id, 'kacho', 'accepted');
  await round(); await round();
  h.answer(issueFor(h, 'bucho').id, 'bucho', 'rejected', '予算外');
  await round(); await round();
  assert.equal(h.issues.get('X').status, 'todo');
  assert.equal(h.issues.get(y1.id).status, 'done');
  assert.ok(h.comments.some(c => c.id === y1.id && c.body === '回覧の却下: 部長さんが却下しました。理由: 予算外'));
});

test('上の承認を待つ間に課長が自分の課題を閉じたら、戻りの時に開き直さず取り消して担当者に戻る', async () => {
  const { h, round, ask } = setup();
  await ask({ kind: 'approval', title: '見積 A 案で出す' });
  await round();
  const y1 = issueFor(h, 'kacho');
  h.answer(y1.id, 'kacho', 'accepted');
  await round(); await round();
  h.issues.get(y1.id).status = 'cancelled';
  const y2 = issueFor(h, 'bucho');
  h.answer(y2.id, 'bucho', 'accepted');
  for (let i = 0; i < 3; i++) await round();
  assert.equal(h.issues.get(y1.id).status, 'cancelled', '開き直さない');
  assert.equal(h.comments.filter(c => c.id === y1.id && /戻ってきました/.test(c.body)).length, 0);
  assert.equal(h.issues.get('X').status, 'todo');
  assert.ok(h.comments.some(c => c.id === 'X' && /課長さんが上の承認を待つ間に課題を閉じたので取り消しました/.test(c.body)));
});

test('取り消しの書き込みが 1 回失敗しても、取り消しの文は 1 回だけ・起こすのは 3 回失敗したら諦めて戻すのは終える', async () => {
  const { h, ctx, round, ask } = setup();
  await ask({ kind: 'question', title: '確かめ', to: ['佐藤'] });
  await round();
  const y = issueFor(h, 'sato');
  h.issues.get('X').status = 'cancelled';
  const upd = ctx.issues.update; let f = 1;
  ctx.issues.update = async (id, p, c, a) => { if (id === y.id && f) { f--; throw new Error('503'); } return upd(id, p, c, a); };
  for (let i = 0; i < 3; i++) await round();
  assert.equal(h.issues.get(y.id).status, 'cancelled');
  assert.equal(h.comments.filter(c => c.id === y.id && c.body.startsWith('取り消しました')).length, 1);

  const t = setup();
  await t.ask({ kind: 'question', title: '確かめ', to: ['佐藤'] });
  await t.round();
  t.h.answer(issueFor(t.h, 'sato').id, 'sato', 'question', 'はい');
  let tries = 0;
  t.ctx.issues.requestWakeup = async () => { tries++; throw new Error('503'); };
  for (let i = 0; i < 5; i++) await t.round();
  assert.equal(tries, 3);
  assert.equal([...t.store.reqs.values()][0].returned, true);
  assert.equal(t.h.comments.filter(c => c.id === 'X' && c.body.startsWith('回覧の答え')).length, 1);
});

test('書き込みが 1 回失敗しても止まらない（答えを読んだ後・元へ戻す時）・同じ文を 2 回書かない', async () => {
  const { h, ctx, round, ask } = setup();
  await ask({ kind: 'question', title: '来週の打ち合わせはいつがよいですか', to: ['佐藤'] });
  await round();
  const y = issueFor(h, 'sato');
  h.answer(y.id, 'sato', 'question', '水曜');
  const orig = ctx.issues.createComment;
  let fail = 2; // Y へのコメント・X へのコメントを 1 回ずつ失敗させる
  ctx.issues.createComment = async (id, body, c) => { if ((id === y.id && fail === 2) || (id === 'X' && fail === 1 && body.startsWith('回覧の答え'))) { fail--; throw new Error('503'); } return orig(id, body, c); };
  for (let i = 0; i < 4; i++) await round();
  assert.equal(fail, 0);
  assert.equal(h.issues.get('X').status, 'todo');
  assert.equal(h.comments.filter(c => c.id === 'X' && c.body === '回覧の答え（佐藤さん）: 水曜').length, 1);
  assert.equal(h.comments.filter(c => c.id === y.id && /元の課題に戻しました/.test(c.body)).length, 1);
});

test('codex P2-1: 回覧を進めた後、段の行の記録だけが失敗しても、答えた課題を取り消さない', async () => {
  const { h, store, round, ask } = setup();
  await ask({ kind: 'question', title: '確かめ', to: ['佐藤'] });
  await round();
  const y = issueFor(h, 'sato');
  h.answer(y.id, 'sato', 'question', 'はい');
  const orig = store.setStep; let f = true;
  store.setStep = async (id, st, rd, p) => { if (f && p.answer?.did?.includes('advance')) { f = false; throw new Error('db'); } return orig(id, st, rd, p); };
  for (let i = 0; i < 4; i++) await round();
  assert.equal(f, false);
  assert.equal(h.issues.get(y.id).status, 'done');
  assert.equal(h.comments.filter(c => c.id === y.id && c.body.startsWith('取り消しました')).length, 0);
  assert.equal(h.issues.get('X').status, 'todo');
});

test('codex P2-2: 作り途中の課題の取り消しが 1 回失敗しても、次の回で閉じる', async () => {
  const { h, ctx, store, round, ask } = setup();
  const r = await ask({ kind: 'question', title: '確かめ', to: ['佐藤'] });
  await store.claimStep({ requestId: r.body.requestId, step: 0, round: 0, companyId: 'C', userId: 'sato' });
  h.issues.set('Yx', { id: 'Yx', companyId: 'C', status: 'todo', assigneeUserId: 'sato', originKind: ORIGIN_KIND, originId: `${r.body.requestId}:0` });
  h.issues.get('X').status = 'cancelled';
  const upd = ctx.issues.update; let f = 1;
  ctx.issues.update = async (id, p, c, a) => { if (id === 'Yx' && f) { f--; throw new Error('503'); } return upd(id, p, c, a); };
  for (let i = 0; i < 3; i++) await round();
  assert.equal(h.issues.get('Yx').status, 'cancelled');
});

test('codex P2-3: 宛先でない答えで無効にした直後（出し直す前）に X が閉じられても、相手の課題を閉じる', async () => {
  const { h, tickOnly, ask } = setup();
  await ask({ kind: 'question', title: '確かめ', to: ['佐藤'] });
  await tickOnly('C');
  const y = issueFor(h, 'sato');
  h.answer(y.id, 'bucho', 'question', '代わりに');
  await tickOnly('C'); // 無効にする（出し直しの口は次の C の回）
  h.issues.get('X').status = 'cancelled';
  await tickOnly('A'); await tickOnly('C'); await tickOnly('C');
  assert.equal(h.issues.get(y.id).status, 'cancelled');
});

test('codex P2-4: 同じ課題から回覧を 2 つ出したら、両方の答えがそろうまで X を戻さない', async () => {
  const { h, round, ask } = setup();
  await ask({ kind: 'question', title: '佐藤さんへ', to: ['佐藤'] });
  await ask({ kind: 'question', title: '課長へ', to: ['課長'] });
  await round();
  h.answer(issueFor(h, 'sato').id, 'sato', 'question', 'はい');
  await round(); await round();
  assert.equal(h.issues.get('X').status, 'blocked');
  assert.equal(h.wakes.length, 0);
  assert.ok(h.comments.some(c => c.id === 'X' && c.body.startsWith('回覧の答え（佐藤さん）')));
  h.answer(issueFor(h, 'kacho').id, 'kacho', 'question', 'いいえ');
  await round(); await round();
  assert.equal(h.issues.get('X').status, 'todo');
  assert.equal(h.wakes.length, 1);
});

test('同じ X の回覧 2 つが同じ回に終わっても、担当を起こすのは 1 回', async () => {
  const { h, round, ask } = setup();
  await ask({ kind: 'question', title: '佐藤さんへ', to: ['佐藤'] });
  await ask({ kind: 'question', title: '課長へ', to: ['課長'] });
  await round();
  h.answer(issueFor(h, 'sato').id, 'sato', 'question', 'はい');
  h.answer(issueFor(h, 'kacho').id, 'kacho', 'question', 'いいえ');
  await round(); await round(); await round();
  assert.equal(h.issues.get('X').status, 'todo');
  assert.equal(h.wakes.length, 1);
});

test('見回りの返事に、失敗の数と最後の理由が載る', async () => {
  const { ctx, tickOnly, ask, clock } = setup();
  await ask({ kind: 'question', title: '確かめ', to: ['佐藤'] });
  ctx.issues.create = async () => { throw new Error('assignee is not a member'); };
  const out = await tickOnly('C');
  assert.equal(out.errors, 1);
  assert.equal(out.lastError, 'assignee is not a member');
  ctx.issues.create = async () => { throw new Error('x'.repeat(400)); };
  clock.t += 3 * 60 * 1000; // 作りかけの段は 2 分たってから続きをする
  assert.equal((await tickOnly('C')).lastError.length, 300, '理由は 300 字まで');
  const ok = await tickOnly('A');
  assert.equal(ok.errors, 0);
  assert.equal('lastError' in ok, false, '成功した回の返事に理由は無い');
});

test('出し直し: 同じ課題・同じ題の回覧が開いていれば、新しく作らずそれを返す', async () => {
  const { h, store, round, ask } = setup();
  const a = await ask({ kind: 'question', title: '来週の打ち合わせ', to: ['佐藤'] });
  const b = await ask({ kind: 'question', title: '来週の打ち合わせ', to: ['佐藤'] });
  assert.equal(b.status, 201);
  assert.equal(b.body.requestId, a.body.requestId);
  assert.equal(store.reqs.size, 1);
  await round();
  assert.equal([...h.issues.values()].filter(i => i.assigneeUserId === 'sato').length, 1);
  // 宛先の違う回覧が開いていても、同じ宛先の出し直しは前の回覧を返す（独立レビュー Q2）
  const c = await ask({ kind: 'question', title: '来週の打ち合わせ', to: ['課長'] });
  assert.notEqual(c.body.requestId, a.body.requestId);
  const d = await ask({ kind: 'question', title: '来週の打ち合わせ', to: ['課長'] });
  assert.equal(d.body.requestId, c.body.requestId);
  assert.equal(store.reqs.size, 2);
});

test('作った後・記録の前に止まった段は、取り消しの時に作った課題を見つけ直して閉じる', async () => {
  const { h, store, round, ask, clock } = setup();
  const r = await ask({ kind: 'question', title: '確かめ', to: ['佐藤'] });
  // 行を取り課題を作った所で止まった形（interaction と記録が無い）
  await store.claimStep({ requestId: r.body.requestId, step: 0, round: 0, companyId: 'C', userId: 'sato' });
  h.issues.set('Yx', { id: 'Yx', companyId: 'C', status: 'todo', assigneeUserId: 'sato', originKind: ORIGIN_KIND, originId: `${r.body.requestId}:0` });
  h.issues.get('X').status = 'cancelled';
  await round(); await round();
  assert.equal(h.issues.get('Yx').status, 'cancelled');
  clock.t += 10 * 60 * 1000;
  await round();
  assert.equal(h.interactions.length, 0, '取り消した後に答えの口を作らない');
});

test('公開版（directory 無し・人は持ち主 1 人）: 「持ち主」で宛先を引ける', () => {
  const ms = [{ companyId: 'A', userId: 'local-board', principalType: 'user', status: 'active', membershipRole: 'owner' }, { companyId: 'B', userId: 'local-board', principalType: 'user', status: 'active', membershipRole: 'owner' }];
  assert.equal(userIdOf({}, '持ち主', ms), 'local-board');
  assert.equal(userIdOf({}, 'owner', ms), 'local-board');
  assert.equal(userIdOf({}, 'local-board', ms), 'local-board');
  assert.equal(userIdOf({}, '持ち主', [...ms, { companyId: 'A', userId: 'u2', principalType: 'user', status: 'active', membershipRole: 'member' }]), null, '2 人以上いれば持ち主で引かない');
  const p = planRequest({ body: { kind: 'question', title: 't', to: ['持ち主'] }, cfg: { homes: { 'local-board': 'B' } }, memberships: ms });
  assert.deepEqual(p.chain, [{ userId: 'local-board', companyId: 'B' }]);
});

test('多段の承認: 途中で却下されたら、そこで止まって理由つきで元へ戻る', async () => {
  const { h, round, ask } = setup();
  await ask({ kind: 'approval', title: '見積 A 案で出す' });
  await round();
  h.answer(issueFor(h, 'kacho').id, 'kacho', 'rejected', '金額を見直して');
  await round(); await round();
  assert.equal(issueFor(h, 'bucho'), undefined);
  assert.equal(h.issues.get('X').status, 'todo');
  assert.ok(h.comments.some(c => c.id === 'X' && c.body === '回覧の却下: 課長さんが却下しました。理由: 金額を見直して'));
});

test('宛先でない人の答えでは進まない（無効と書き、同じ段の答えの口を出し直す）', async () => {
  const { h, round, ask } = setup();
  await ask({ kind: 'approval', title: '見積 A 案で出す' });
  await round();
  const y1 = issueFor(h, 'kacho');
  h.answer(y1.id, 'bucho', 'accepted'); // 部長が先に押した
  await round();
  assert.ok(h.comments.some(c => c.id === y1.id && /部長の答えは無効にしました.*課長さんの答えを待っています/.test(c.body)));
  assert.equal(issueFor(h, 'bucho'), undefined);
  await round();
  const its = h.interactions.filter(x => x.issueId === y1.id);
  assert.equal(its.length, 2); // 同じ課題に 2 回目の口
  assert.equal(its[1].idempotencyKey.endsWith(':0:1'), true);
  h.answer(y1.id, 'kacho', 'accepted');
  await round(); await round();
  assert.ok(issueFor(h, 'bucho'));
});

test('取り消し: 宛先の課題が答えずに閉じられたら X に書いて戻す・X が閉じられたら相手の課題を取り消す', async () => {
  {
    const { h, round, ask } = setup();
    await ask({ kind: 'question', title: '日程', to: ['佐藤'] });
    await round();
    h.issues.get(issueFor(h, 'sato').id).status = 'done';
    await round(); await round();
    assert.equal(h.issues.get('X').status, 'todo');
    assert.ok(h.comments.some(c => c.id === 'X' && /佐藤さんが答えずに閉じました/.test(c.body)));
  }
  {
    const { h, round, ask } = setup();
    await ask({ kind: 'question', title: '日程', to: ['佐藤'] });
    await round();
    h.issues.get('X').status = 'cancelled';
    await round(); await round();
    const y = issueFor(h, 'sato');
    assert.equal(h.issues.get(y.id).status, 'cancelled');
    assert.ok(h.comments.some(c => c.id === y.id && /依頼元の課題が閉じたので取り消しました/.test(c.body)));
    assert.equal(h.wakes.length, 0);
  }
});

test('重なった見回り: 同じ段の課題を 2 回作らない・作る途中で止まった段は作った課題を見つけ直す', async () => {
  const { h, deps, store, ask, clock } = setup();
  const tickC = () => { h.scope = 'C'; return tick(deps, 'C'); };
  await ask({ kind: 'question', title: '日程', to: ['佐藤'] });
  h.scope = 'C';
  await Promise.all([tick(deps, 'C'), tick(deps, 'C')]);
  assert.equal([...h.issues.values()].filter(i => i.assigneeUserId === 'sato').length, 1);
  assert.equal(h.interactions.length, 1);
  // 課題を作った後・記録の前に止まった形
  const s = [...store.steps.values()][0];
  s.interactionId = null;
  await tickC(); // まだ新しい行（作っている途中）には触らない
  assert.equal(s.interactionId, null);
  clock.t += 3 * 60 * 1000;
  await tickC();
  assert.ok(s.interactionId);
  assert.equal([...h.issues.values()].filter(i => i.assigneeUserId === 'sato').length, 1);
  assert.equal(h.interactions.length, 1); // idempotencyKey で同じ口
});

test('担当が待つ間に外されたら起こさない・人が出す口は断る', async () => {
  const { h, round, ask, deps } = setup();
  await ask({ kind: 'question', title: '日程', to: ['佐藤'] });
  await round();
  h.issues.get('X').assigneeAgentId = null;
  h.answer(issueFor(h, 'sato').id, 'sato', 'question', 'はい');
  await round(); await round();
  assert.equal(h.wakes.length, 0);
  assert.equal(h.issues.get('X').status, 'todo');
  const r = await createRequest(deps, { companyId: 'A', issueId: 'X', actor: { actorType: 'user', actorId: 'staff' }, body: { kind: 'question', title: 't', to: ['佐藤'] } });
  assert.equal(r.status, 403);
});

test('答えの文: 質問は書いた文・承認は理由', () => {
  assert.deepEqual(answerOf({ kind: 'ask_user_questions', status: 'answered', payload: { questions: [{ options: [{ id: 'answer', label: '回答' }] }] }, result: { answers: [{ optionIds: ['answer'], otherText: '水曜' }] } }), { outcome: 'answered', text: '水曜' });
  assert.deepEqual(answerOf({ kind: 'request_confirmation', status: 'rejected', result: { outcome: 'rejected', reason: '高い' } }), { outcome: 'rejected', text: '高い' });
});
