import { OWNER_SCHEMA } from '../../owner-gate.mjs';
// 回覧（office の間の質問と多段の承認）の plugin。設計: docs/design/2026-11-21-office-relay.md
// 出す口は担当の run の中から（auth agent・会社は課題から決まる）。見回りの口は外（cron・起動係の見回り）が会社ごとに呼ぶ。
// capability は要る物を全部ここに書く（版上げで増えると本体が断り、入れ直しになる）。
export default {
  id: 'aioffice.relay',
  apiVersion: 1,
  version: '0.1.3',
  displayName: 'AI Office relay (questions and approvals between offices)',
  description: 'An agent can ask a person in another company of this office a question, or send something up a chain of approvers. Each person gets an issue in their own company; the answer comes back to the original issue.',
  author: 'AI Office',
  categories: ['automation'],
  capabilities: [
    'companies.read', 'access.members.read',
    'database.namespace.migrate', 'database.namespace.read', 'database.namespace.write',
    'issues.read', 'issues.create', 'issues.update', 'issues.wakeup',
    'issue.comments.read', 'issue.comments.create',
    'issue.interactions.read', 'issue.interactions.create',
    'api.routes.register', 'instance.settings.register',
  ],
  entrypoints: { worker: './dist/worker.js' },
  database: { namespaceSlug: 'relay', migrationsDir: 'migrations' },
  instanceConfigSchema: {
    type: 'object',
    properties: {
      directory: { type: 'object', title: 'People: userId → { name, email }', additionalProperties: { type: 'object', properties: { name: { type: 'string' }, email: { type: 'string' } } } },
      homes: { type: 'object', title: 'Where each person receives relays: userId → companyId (required for people in two or more companies)', additionalProperties: { type: 'string' } },
      approvers: { type: 'object', title: 'Default approval chain: userId → the userId above them', additionalProperties: { type: 'string' } },
      ownerUserIds: OWNER_SCHEMA,
      defaultRequester: { type: 'string', title: 'Start of the default approval chain when an agent created the issue (userId)' },
    },
  },
  apiRoutes: [
    { routeKey: 'request', method: 'POST', path: '/v1/issues/:issueId/requests', auth: 'agent', capability: 'api.routes.register', companyResolution: { from: 'issue', param: 'issueId' }, checkoutPolicy: 'required-for-agent-in-progress' },
    { routeKey: 'tick', method: 'POST', path: '/tick', auth: 'board', capability: 'api.routes.register', companyResolution: { from: 'query', key: 'companyId' } },
  ],
};
