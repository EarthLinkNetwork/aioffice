// 回覧の DB の読み書き（public/plugins/relay/src/store.mjs）が、本体の plugin の DB の口の決まりに合うことを確かめる。
// 決まりは本体 2026.1001.0 の services/plugin-database.js（validatePluginRuntimeQuery・validatePluginRuntimeExecute）を写した:
// query は SELECT（か WITH）だけで、変更の語を含まない・execute は INSERT/UPDATE/DELETE だけ・どちらも 1 文だけ・schema は plugin の namespace だけ。
// 0.1.1 は claimStep を query の INSERT ... RETURNING で書いていて、本物の本体で毎回断られた（lib の unit は記憶の store で試していたので拾えなかった）。
import test from 'node:test';
import assert from 'node:assert/strict';
import { sqlStore } from '../plugins/relay/src/store.mjs';

const NS = 'plugin_relay_9b8fc185f3';
const norm = s => s.replace(/\s+/g, ' ').trim().toLowerCase();
function checkRefs(sql) {
  for (const m of sql.matchAll(/\b([a-z_][a-z0-9_]*)\.([a-z_][a-z0-9_]*)\b/gi)) {
    const schema = m[1];
    if (/^[a-z]$/i.test(schema)) continue; // 表の別名（s.・r.）
    assert.equal(schema, NS, `namespace の外の schema: ${schema}`);
  }
}
// 本体の bindSql: $n はどれも値があり、渡した値はどれも使う
function bound(n, params) {
  const used = new Set([...n.matchAll(/\$(\d+)/g)].map(m => Number(m[1])));
  for (const i of used) assert.ok(i >= 1 && i <= params.length, `$${i} に値が無い`);
  for (let i = 1; i <= params.length; i++) assert.ok(used.has(i), `値 ${i} が使われていない`);
}
function oneStatement(sql) {
  assert.ok(!sql.trim().replace(/;\s*$/, '').includes(';'), '1 文だけ');
}
function fakeDb(opts = {}) {
  const calls = [];
  return {
    namespace: NS, calls,
    async query(sql, params = []) {
      oneStatement(sql);
      const n = norm(sql);
      assert.ok(n.startsWith('select ') || n.startsWith('with '), `query は SELECT だけ: ${n.slice(0, 60)}`);
      assert.ok(!/\b(insert|update|delete|alter|create|drop|truncate)\b/.test(n), `query に変更の語: ${n.slice(0, 80)}`);
      checkRefs(sql);
      bound(n, params);
      calls.push({ kind: 'query', sql: n, params });
      return opts.query ? opts.query(n, params) : [];
    },
    async execute(sql, params = []) {
      oneStatement(sql);
      const n = norm(sql);
      assert.ok(/^(insert\s+into|update|delete\s+from)\b/.test(n), `execute は INSERT/UPDATE/DELETE だけ: ${n.slice(0, 60)}`);
      assert.ok(!/\b(alter|create|drop|truncate)\b/.test(n), 'execute に DDL の語');
      checkRefs(sql);
      bound(n, params);
      // 本体は書き込み先の表を namespace 付きで見つけられない文を断る
      const target = n.match(/^(?:insert\s+into|update|delete\s+from)\s+([a-z_][a-z0-9_]*)\.([a-z_][a-z0-9_]*)/);
      assert.ok(target && target[1] === NS, `書き込み先が namespace の表でない: ${n.slice(0, 60)}`);
      calls.push({ kind: 'execute', sql: n, params });
      return { rowCount: opts.rowCount ?? 1 };
    },
  };
}

test('store のすべての関数が、本体の DB の口の決まりに合う', async () => {
  const db = fakeDb();
  const st = sqlStore(db);
  await st.createRequest({ id: 'r1', originCompanyId: 'A', originName: '会社A', originIssueId: 'X', originAgentId: 'g', kind: 'question', title: 't', body: 'b', chain: [{ userId: 'u', companyId: 'B' }] });
  await st.getRequest('r1');
  await st.openFor('A', 'X', 't');
  await st.openCountFor('A', 'X');
  await st.openRequests();
  await st.originRequests('A');
  await st.setRequest('r1', { step: 1, round: 0, state: 'answered', result: { at: { step: 0, round: 0 } }, reportedStep: 1, returned: true });
  await st.claimStep({ requestId: 'r1', step: 0, round: 0, companyId: 'B', userId: 'u' });
  await st.getStep('r1', 0, 0);
  await st.stepsOf('B', ['open']);
  await st.stepsToClose('B');
  await st.setStep('r1', 0, 0, { issueId: 'Y', interactionId: 'i', state: 'done', answer: { did: ['advance'] }, notified: true });
  assert.ok(db.calls.length >= 12);
});

test('列の無い patch は SQL を出さずに投げる', () => {
  const st = sqlStore(fakeDb());
  assert.throws(() => st.setStep('r1', 0, 0, { other: 1 }), /nothing to update/);
  assert.throws(() => st.setRequest('r1', {}), /nothing to update/);
});

test('claimStep: 行を取れた時だけ行を返し、取れなかった時（ほかの回が先に取った）は null', async () => {
  const row = { request_id: 'r1', step: 0, round: 0, company_id: 'B', user_id: 'u', issue_id: null, interaction_id: null, state: 'open', answer: null, notified: false, updated_at: new Date('2026-11-22T00:00:00Z') };
  const got = await sqlStore(fakeDb({ rowCount: 1, query: () => [row] })).claimStep({ requestId: 'r1', step: 0, round: 0, companyId: 'B', userId: 'u' });
  assert.equal(got.requestId, 'r1');
  assert.equal(got.updatedAt, '2026-11-22T00:00:00.000Z');
  assert.equal(await sqlStore(fakeDb({ rowCount: 0, query: () => [row] })).claimStep({ requestId: 'r1', step: 0, round: 0, companyId: 'B', userId: 'u' }), null);
});
