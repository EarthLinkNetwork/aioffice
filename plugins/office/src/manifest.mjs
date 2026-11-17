// AI オフィスの画面（会社ごとの /:会社の prefix/office）。設計: docs/design/2026-11-15-public-package.md の「構成」plugins/office
export const PAGE_ROUTE = 'office';
export const UI_SLOTS = [
  { type: 'page', id: 'office', displayName: 'Office', exportName: 'OfficePage', routePath: PAGE_ROUTE },
  // 本体の横の一覧の入口（オフィスに戻る道・範囲 docs/review/2026-11-18-office-ai-panel-ux-scope.md G4・F4）
  { type: 'sidebar', id: 'office-sidebar', displayName: 'Office', exportName: 'OfficeSidebarLink' },
];
export default {
  id: 'aioffice.office',
  apiVersion: 1,
  version: '0.1.0',
  displayName: 'AI Office',
  description: 'The office screen: rooms, the AI employees at their desks, and what each room can do.',
  author: 'AI Office',
  categories: ['ui'],
  capabilities: ['companies.read', 'agents.read', 'issues.read', 'issue.comments.read', 'ui.page.register', 'ui.sidebar.register'],
  entrypoints: { worker: './dist/worker.js', ui: './dist/ui' },
  ui: { slots: UI_SLOTS },
};
