// mobile plugin の worker（plugins/mobile/src/worker.mjs）: 出来事の受け取り・定期の 1 回（API の口 /v1/tick）・設定の確かめ。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import plugin, { validateConfig } from '../plugins/mobile/src/worker.mjs';

const KEY = 'project-key-for-worker-test-0123';
const CO = 'co1';

function startNotify() {
  const s = { puts: [], deletes: [], actions: [], results: new Map(), bindings: new Map([['b1', 'active']]), requests: [] };
  const server = http.createServer(async (req, res) => {
    let body = '';
    for await (const c of req) body += c;
    const json = body ? JSON.parse(body) : null;
    const p = new URL(req.url, 'http://x').pathname;
    s.requests.push(`${req.method} ${p}`);
    const send = (code, obj) => { res.writeHead(code, { 'content-type': 'application/json' }); res.end(JSON.stringify(obj ?? {})); };
    if ((req.headers.authorization || '') !== `Bearer ${KEY}`) return send(401, {});
    let m;
    if ((m = p.match(/^\/api\/v1\/plugin\/bindings\/([^/]+)\/cards\/([^/]+)$/))) {
      if (req.method === 'PUT') { s.puts.push({ bid: m[1], cid: decodeURIComponent(m[2]), push: json.push, version: json.version }); return send(200, { ok: true }); }
      if (req.method === 'DELETE') { s.deletes.push({ bid: m[1], cid: decodeURIComponent(m[2]) }); return send(200, { ok: true }); }
    }
    if (req.method === 'GET' && p === '/api/v1/plugin/actions') return send(200, { actions: s.actions.filter(a => !s.results.has(a.id)) });
    if (req.method === 'POST' && (m = p.match(/^\/api\/v1\/plugin\/actions\/([^/]+)\/result$/))) { s.results.set(decodeURIComponent(m[1]), json); return send(200, { ok: true }); }
    send(404, {});
  });
  return new Promise(r => server.listen(0, '127.0.0.1', () => r({ s, server, url: `http://127.0.0.1:${server.address().port}` })));
}

test('worker: approval.created の出来事で card を送り、口 /v1/tick の poll で押された操作を反映し、sync で片付いた card を消す', async t => {
  const srv = await startNotify();
  t.after(() => srv.server.close());
  const state = new Map();
  const k = x => `${x.scopeKind}|${x.scopeId}|${x.namespace}|${x.stateKey}`;
  const handlers = {}; const actions = {}; const logs = [];
  const approvals = [{ id: 'a1', companyId: CO, type: 'request_board_approval', status: 'pending', payload: { title: '返信の承認', summary: 's' }, createdAt: '2026-11-10T00:00:00Z' }];
  const decided = [];
  const ctx = {
    config: { get: async () => ({ notifyUrl: srv.url, notifyKey: { type: 'secret_ref', secretId: 's1' } }) },
    secrets: { resolve: async () => KEY },
    http: { fetch: (u, i) => fetch(u, i) },
    companies: { list: async () => [{ id: CO }] },
    events: { on: (ev, fn) => { handlers[ev] = fn; } },
    actions: { register: (name, fn) => { actions[name] = fn; } },
    logger: { warn: (m, meta) => logs.push(JSON.stringify([m, meta])), info: () => {} },
    state: { get: async x => structuredClone(state.get(k(x))), set: async (x, v) => { state.set(k(x), structuredClone(v)); } },
    access: { members: { list: async () => [{ principalType: 'user', principalId: 'u1', status: 'active', membershipRole: 'owner' }] } },
    approvals: {
      list: async () => approvals.filter(a => a.status === 'pending'),
      get: async id => approvals.find(a => a.id === id) || null,
      decide: async (id, input) => { decided.push({ id, ...input }); const a = approvals.find(x => x.id === id); a.status = 'approved'; return { approval: a, applied: true }; },
    },
    issues: { list: async () => [], listInteractions: async () => [] },
  };
  await plugin.definition.setup(ctx);
  assert.deepEqual(Object.keys(handlers).sort(), ['approval.created', 'approval.decided', 'issue.comment.created']);
  assert.deepEqual(Object.keys(actions).sort(), ['keys.request', 'keys.revokeAll', 'keys.status', 'link.confirm', 'link.list', 'link.pending', 'link.remove', 'link.role', 'link.start', 'link.status']);
  // 判断の key の操作は、画面から送る値の人でなく本体のログインで決まる人（actor）で動く。hostUrl が無い会社では依頼を作らない
  assert.deepEqual(await actions['keys.request']({ userId: 'u1' }, { companyId: CO, actor: { type: 'agent', agentId: 'g1' } }), { ok: false, reason: 'not-configured' });
  assert.deepEqual(await actions['keys.status']({ userId: 'u1' }, { companyId: CO, actor: { type: 'agent' } }), { state: 'none' });
  // 結びつけ済みの人を状態に置く
  await ctx.state.set({ scopeKind: 'company', scopeId: CO, namespace: 'mobile', stateKey: 'bindings' }, { b1: { userId: 'u1', status: 'active', email: null, createdAt: '2026-11-10T00:00:00Z' } });
  await handlers['approval.created']({ companyId: CO });
  assert.deepEqual(srv.s.puts.map(p => [p.bid, p.cid, p.push]), [['b1', 'approval:co1:a1', false]]);
  const version = srv.s.puts[0].version;
  srv.s.actions.push({ id: 'act1', cardId: 'approval:co1:a1', bindingId: 'b1', actionId: 'approve', version, values: {}, pressedAt: new Date().toISOString() });
  // 定期の処理は API の口 /v1/tick（会社ごと・what=poll|sync）。外の cron が呼ぶ
  const tickApi = what => plugin.definition.onApiRequest({ routeKey: 'tick', companyId: CO, query: { what }, params: {}, body: null, actor: { actorType: 'user', actorId: 'board' } });
  assert.deepEqual((await tickApi('poll')).body.what, 'poll');
  assert.deepEqual(srv.s.results.get('act1'), { ok: true });
  assert.deepEqual(decided, [{ id: 'a1', action: 'approve', actorUserId: 'u1', decisionNote: null }]);
  assert.deepEqual(srv.s.deletes, [{ bid: 'b1', cid: 'approval:co1:a1' }]);
  assert.equal((await tickApi('sync')).status, 200);
  assert.equal((await tickApi('nope')).status, 400);
  assert.equal(srv.s.puts.length, 1);
  assert.ok(!logs.join('\n').includes(KEY));
});

test('worker: hostUrl は https だけを受ける', () => {
  assert.equal(validateConfig({ hostUrl: 'https://paperclip.example.com' }).ok, true);
  assert.equal(validateConfig({}).ok, true);
  assert.equal(validateConfig({ hostUrl: 'http://paperclip.example.com' }).ok, false);
  assert.equal(validateConfig({ hostUrl: 'not a url' }).ok, false);
});

test('manifest: 本体の形に合い、結びつけの画面の route はお知らせの URL と同じ', async () => {
  const { pluginManifestV1Schema } = await import('@paperclipai/shared');
  const manifest = (await import('../plugins/mobile/src/manifest.mjs')).default;
  const { UI_SLOTS, UI_APPROVED } = await import('../plugins/mobile/src/manifest.mjs');
  const r = pluginManifestV1Schema.safeParse(manifest);
  assert.equal(r.success, true, r.success ? '' : JSON.stringify(r.error.issues));
  // 画面を出した形（mock が承認された後）も本体の形に合う
  const withUi = { ...manifest, capabilities: [...manifest.capabilities, 'ui.page.register', 'ui.sidebar.register'], entrypoints: { ...manifest.entrypoints, ui: './dist/ui' }, ui: { slots: UI_SLOTS } };
  const r2 = pluginManifestV1Schema.safeParse(withUi);
  assert.equal(r2.success, true, r2.success ? '' : JSON.stringify(r2.error.issues));
  // mock は承認済み（docs/mocks/README.md の索引）なので、画面を本体に出す
  assert.equal(UI_APPROVED, true);
  assert.deepEqual(manifest.ui, { slots: UI_SLOTS });
  assert.equal(manifest.entrypoints.ui, './dist/ui');
  assert.ok(manifest.capabilities.includes('ui.page.register') && manifest.capabilities.includes('ui.sidebar.register'));
  const { PAGE_ROUTE } = await import('../plugins/mobile/src/worker.mjs');
  assert.equal(UI_SLOTS.find(x => x.type === 'page').routePath, PAGE_ROUTE);
  const ui = await import('node:fs').then(fs => fs.readFileSync(new URL('../plugins/mobile/src/ui.mjs', import.meta.url), 'utf8'));
  assert.match(ui, new RegExp(`PAGE_ROUTE = '${PAGE_ROUTE}'`));
  for (const s of UI_SLOTS) assert.match(ui, new RegExp(`export function ${s.exportName}\\b`));
});
