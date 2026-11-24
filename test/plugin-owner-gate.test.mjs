// plugin の口の分け方（設計 docs/design/2026-11-23-public-office-multi-user.md 2.2b）
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { ROUTES, gateRoute, isOwner } from '../plugins/owner-gate.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PUBLIC = ['office', 'design', 'notify', 'library', 'secretary', 'relay']; // 公開の image に入る plugin（Dockerfile の段と同じ）

test('公開の plugin の manifest の口は、どれも表のどこか 1 つに入る・jobs と webhooks を出さない・設定に ownerUserIds がある', async () => {
  const df = fs.readFileSync(path.join(root, 'packages/aioffice/Dockerfile'), 'utf8');
  assert.match(df, new RegExp(`for p in ${PUBLIC.join(' ')};`), '表の plugin と image の plugin が同じ');
  for (const d of PUBLIC) {
    const m = (await import(pathToFileURL(path.join(root, 'plugins', d, 'src', 'manifest.mjs')).href)).default;
    assert.ok(!m.jobs?.length, `${d}: jobs を出さない（担当を時間で起こす道を作らない）`);
    assert.ok(!m.webhooks?.length, `${d}: webhooks を出さない`);
    const routes = m.apiRoutes || [];
    if (!routes.length) continue;
    const t = ROUTES[m.id]; assert.ok(t, `${m.id} が表にある`);
    assert.ok(m.instanceConfigSchema?.properties?.ownerUserIds, `${m.id}: 設定に ownerUserIds`);
    for (const r of routes) {
      const where = ['member', 'agent', 'owner'].filter(k => t[k].includes(r.routeKey));
      assert.equal(where.length, 1, `${m.id} ${r.routeKey} は表の 1 つだけに入る`);
      assert.equal(r.auth === 'agent', where[0] === 'agent', `${m.id} ${r.routeKey}: 担当の口は auth agent だけ`);
    }
    for (const k of ['member', 'agent', 'owner']) for (const rk of t[k]) assert.ok(routes.some(r => r.routeKey === rk), `${m.id} の表の ${rk} は manifest にある`);
    const w = fs.readFileSync(path.join(root, 'plugins', d, 'src', 'worker.mjs'), 'utf8');
    assert.match(w, new RegExp(`gateRoute\\('${m.id.replace('.', '\\.')}'`), `${m.id}: worker の入口で gateRoute を通す`);
  }
});

test('持ち主だけの口は ownerUserIds の人だけ・設定が無ければ断る・member の口は会社の member（本体が確かめる）に開く・担当の口は設定を読まない', async () => {
  const cfg = { c1: { ownerUserIds: ['own'] } };
  const get = c => cfg[c] || {};
  const g = (k, userId, companyId = 'c1', pid = 'aioffice.notify') => gateRoute(pid, { routeKey: k, companyId, actor: { userId } }, get);
  assert.deepEqual(await g('tick', 'own'), { owner: true });
  assert.equal((await g('tick', 'm1')).deny.status, 403);
  assert.equal((await g('tick', 'own', 'c2')).deny.status, 403, '設定が無い会社は fail-closed');
  assert.equal((await g('settings', undefined)).deny.status, 403);
  assert.deepEqual(await g('notices', 'm1'), { owner: false });
  assert.deepEqual(await g('read', 'own'), { owner: true });
  assert.equal((await g('nope', 'own')).deny.status, 404, '表に無い口は断る');
  let read = 0; const counted = c => { read += 1; return get(c); };
  assert.deepEqual(await gateRoute('aioffice.relay', { routeKey: 'request', companyId: 'c1', actor: { agentId: 'a' } }, counted), { owner: false });
  assert.equal(read, 0);
  assert.equal((await gateRoute('aioffice.relay', { routeKey: 'tick', companyId: 'c1', actor: { userId: 'm1' } }, get)).deny.status, 403);
  assert.equal((await gateRoute('aioffice.library', { routeKey: 'put', companyId: 'c1', actor: { userId: 'own' } }, () => { throw new Error('x'); })).deny.status, 403, '設定が読めない時も断る');
  assert.equal(isOwner({ ownerUserIds: ['own'] }, { userId: '' }), false);
});

test('設計 2.7: 持ち主の返事として学ぶのは ownerUserIds か課題の宛先の人だけ（設定が無い前の版は全部の人）', async () => {
  const { fromOwnerOrAssignee } = await import('../plugins/owner-gate.mjs');
  const cfg = { ownerUserIds: ['o1', 'local-board'] };
  assert.equal(fromOwnerOrAssignee(cfg, {}, { authorUserId: 'o1' }), true);
  assert.equal(fromOwnerOrAssignee(cfg, {}, { authorUserId: 'local-board' }), true, 'local-board の過去の返事も持ち主');
  assert.equal(fromOwnerOrAssignee(cfg, { assigneeUserId: 'm1' }, { authorUserId: 'm1' }), true, '課題の宛先の人');
  assert.equal(fromOwnerOrAssignee(cfg, { assigneeUserId: 'm1' }, { authorUserId: 'm2' }), false, '招いたほかの人');
  assert.equal(fromOwnerOrAssignee(cfg, {}, { authorUserId: '' }), false);
  assert.equal(fromOwnerOrAssignee({}, {}, { authorUserId: 'anyone' }), true, '起動係が書く前・前の版');
});
