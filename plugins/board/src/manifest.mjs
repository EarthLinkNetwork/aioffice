// タスクボード（/:会社の prefix/board）。課題をリストと Kanban で見て、札を動かして状態を変え、ラベル・担当で絞る。
// 設計: docs/design/2026-11-24-secretary-conversation-kanban.md §6。課題とラベルは画面から本体の /api を直に読む・書く（押した人の名義）
export const BOARD_ROUTE = 'board';
export const UI_SLOTS = [
  { type: 'page', id: 'board', displayName: 'Task board', exportName: 'BoardPage', routePath: BOARD_ROUTE },
  { type: 'sidebar', id: 'board-sidebar', displayName: 'Task board', exportName: 'BoardSidebarLink' },
];
export default {
  id: 'aioffice.board',
  apiVersion: 1,
  version: '0.1.0',
  displayName: 'AI Office task board',
  description: 'The task board: every open task as a list or a Kanban board, with one-click filters by label and owner.',
  author: 'AI Office',
  categories: ['ui'],
  capabilities: ['companies.read', 'agents.read', 'ui.page.register', 'ui.sidebar.register'],
  entrypoints: { worker: './dist/worker.js', ui: './dist/ui' },
  ui: { slots: UI_SLOTS },
};
