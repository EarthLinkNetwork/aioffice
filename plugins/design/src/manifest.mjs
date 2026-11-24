import { OWNER_SCHEMA } from '../../owner-gate.mjs';
// デザイン部の依頼の口（office の画面のデザイン部の部屋から呼ぶ）。範囲: docs/review/2026-11-15-office-plugin-scope.md の保証 5
export default {
  id: 'aioffice.design',
  apiVersion: 1,
  version: '0.1.0',
  displayName: 'AI Office design desk',
  description: 'Turns a logo or flyer request from the Design room into a task for the design employee, without creating the same request twice.',
  author: 'AI Office',
  categories: ['automation'],
  capabilities: ['agents.read', 'issues.read', 'issues.create', 'api.routes.register'],
  entrypoints: { worker: './dist/worker.js' },
  // 持ち主の userId（起動係が書く・設計 docs/design/2026-11-23-public-office-multi-user.md 2.2b）
  instanceConfigSchema: { type: 'object', properties: { ownerUserIds: OWNER_SCHEMA } },
  apiRoutes: [
    { routeKey: 'request', method: 'POST', path: '/request', auth: 'board', capability: 'api.routes.register', companyResolution: { from: 'query', key: 'companyId' } },
  ],
};
