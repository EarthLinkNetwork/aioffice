import { OWNER_SCHEMA } from '../../owner-gate.mjs';
// 図書室の plugin。範囲: 開発元の記録 docs/review/2026-11-16-library-notify-scope.md の保証 1〜16
// 会社の物を読み書きするのは、起動係が 5 分ごとに会社ごとに呼ぶ見回りの口（/tick）の中だけ（job は使わない）。
// 外へ送る宣言（http.outbound・secrets.read-ref）と agents.invoke は持たない（保証 2・6）。
// 課題を作る・起こす宣言は「聞く」の口だけが使う（docs/review/2026-11-17-library-ask-scope.md の作り方 1・保証 10）。
// capability は 0.1.0 で要る物を全部ここに書く（版上げで増えると本体が断り、入れ直しになる・実測 15）。
export default {
  id: 'aioffice.library',
  apiVersion: 1,
  version: '0.2.0',
  displayName: 'AI Office library',
  description: 'Keeps a searchable copy of tasks, comments, decisions and files you add, inside the office only, and adds close past records to new tasks for AI staff.',
  author: 'AI Office',
  categories: ['automation'],
  capabilities: [
    'events.subscribe',
    'plugin.state.read', 'plugin.state.write',
    'database.namespace.migrate', 'database.namespace.read', 'database.namespace.write',
    'issues.read', 'issue.comments.read', 'issue.comments.create', 'issue.documents.read', 'issue.interactions.read', 'approvals.read', 'agents.read',
    'issues.create', 'issues.wakeup', 'issues.orchestration.read', 'issue.subtree.read',
    'api.routes.register',
  ],
  entrypoints: { worker: './dist/worker.js' },
  // 持ち主の userId（起動係が書く・設計 docs/design/2026-11-23-public-office-multi-user.md 2.2b）
  instanceConfigSchema: { type: 'object', properties: { ownerUserIds: OWNER_SCHEMA } },
  database: { namespaceSlug: 'library', migrationsDir: 'migrations' },
  apiRoutes: [
    { routeKey: 'tick', method: 'POST', path: '/tick', auth: 'board', capability: 'api.routes.register', companyResolution: { from: 'query', key: 'companyId' } },
    { routeKey: 'search', method: 'GET', path: '/search', auth: 'board', capability: 'api.routes.register', companyResolution: { from: 'query', key: 'companyId' } },
    { routeKey: 'status', method: 'GET', path: '/status', auth: 'board', capability: 'api.routes.register', companyResolution: { from: 'query', key: 'companyId' } },
    { routeKey: 'documents', method: 'GET', path: '/documents', auth: 'board', capability: 'api.routes.register', companyResolution: { from: 'query', key: 'companyId' } },
    { routeKey: 'put', method: 'POST', path: '/documents', auth: 'board', capability: 'api.routes.register', companyResolution: { from: 'query', key: 'companyId' } },
    { routeKey: 'remove', method: 'POST', path: '/documents/remove', auth: 'board', capability: 'api.routes.register', companyResolution: { from: 'query', key: 'companyId' } },
    { routeKey: 'ask', method: 'POST', path: '/ask', auth: 'board', capability: 'api.routes.register', companyResolution: { from: 'query', key: 'companyId' } },
    { routeKey: 'ask-answer', method: 'GET', path: '/ask/answer', auth: 'board', capability: 'api.routes.register', companyResolution: { from: 'query', key: 'companyId' } },
  ],
};
