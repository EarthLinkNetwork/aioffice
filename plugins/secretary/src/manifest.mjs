import { OWNER_SCHEMA } from '../../owner-gate.mjs';
// 秘書の気づきの plugin。範囲: 開発元の記録 docs/review/2026-11-21-secretary-awareness-scope.md（保証 1〜7・作り方の部品 1〜12）
// 会社の物を読み書きするのは、5 分ごとに会社ごとに呼ばれる見回りの口（/tick）の中だけ（job は使わない）。
// 外へ送る宣言（http.outbound・secrets.read-ref）と agents.invoke は持たない。課題を作る・起こす・閉じるのは、見回りの課題と、その提案 1 つずつの子の課題だけ。
// capability は 0.1.0 で要る物を全部ここに書く（版上げで増えると本体が断り、入れ直しになる）。
const route = (routeKey, method, path) => ({ routeKey, method, path, auth: 'board', capability: 'api.routes.register', companyResolution: { from: 'query', key: 'companyId' } });
export default {
  id: 'aioffice.secretary',
  apiVersion: 1,
  version: '0.1.0',
  displayName: 'AI Office secretary rounds',
  description: 'Once an hour the secretary looks over what happened in the office, looks into what matters with its tools, and proposes what to check or do. It only proposes; the owner replies with a comment and the next round follows that.',
  author: 'AI Office',
  categories: ['automation'],
  capabilities: [
    'events.subscribe',
    'plugin.state.read', 'plugin.state.write',
    'database.namespace.migrate', 'database.namespace.read', 'database.namespace.write',
    'issues.read', 'issue.comments.read', 'issue.comments.create', 'approvals.read', 'agents.read',
    'issues.create', 'issues.update', 'issues.wakeup', 'issues.orchestration.read', 'issue.subtree.read',
    'api.routes.register',
  ],
  entrypoints: { worker: './dist/worker.js' },
  // 持ち主の userId（起動係が書く・設計 docs/design/2026-11-23-public-office-multi-user.md 2.2b）
  instanceConfigSchema: { type: 'object', properties: { ownerUserIds: OWNER_SCHEMA } },
  database: { namespaceSlug: 'secretary', migrationsDir: 'migrations' },
  apiRoutes: [
    route('tick', 'POST', '/tick'),
    route('status', 'GET', '/status'),
  ],
};
