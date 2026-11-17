// スマホアプリ向けの受信箱（汎用）。判断待ちを通知 API へ送り、押された操作を押した人の名義で反映する。設計: README.md
// 結びつけの画面（/:会社の prefix/ai-office）と左の並びの入口。mock: docs/mocks/plugin-link-page-mock.html
// mock は承認済み（docs/mocks/README.md の索引）。false にすると画面も、key の依頼も、key の無い人へのお知らせも出なくなる
export const UI_APPROVED = true;
export const UI_SLOTS = [
  { type: 'page', id: 'ai-office', displayName: 'AI Office', exportName: 'AiOfficePage', routePath: 'ai-office' },
  { type: 'sidebar', id: 'ai-office-link', displayName: 'AI Office', exportName: 'AiOfficeSidebar' },
];
const secretRef = { type: 'object', properties: { type: { const: 'secret_ref' }, secretId: { type: 'string' }, version: { type: ['integer', 'string'] } }, required: ['type', 'secretId'] };
export default {
  id: 'aioffice.mobile',
  apiVersion: 1,
  version: '0.8.0',
  displayName: 'Mobile inbox',
  description: 'Sends the decisions that need a human to the mobile app through the notification API, applies the button a linked member pressed in their own name, and relays app chats with agents through issues.',
  author: 'AI Office',
  categories: ['automation'],
  capabilities: [
    'approvals.read', 'approvals.respond', 'companies.read', 'issues.read', 'issue.interactions.read', 'issue.interactions.respond', 'access.members.read',
    // アプリの話（チャット）: 課題を作る・開き直す・起こす・comment を読む／人の名前で書く・子の課題と実行の結果を読む・担当の一覧を読む
    'issues.create', 'issues.update', 'issues.wakeup', 'issue.comments.read', 'issue.comments.create', 'issue.comments.create_human_attributed',
    'issue.subtree.read', 'issues.orchestration.read', 'agents.read',
    'events.subscribe', 'plugin.state.read', 'plugin.state.write', 'http.outbound', 'secrets.read-ref',
    'api.routes.register', 'instance.settings.register', ...(UI_APPROVED ? ['ui.page.register', 'ui.sidebar.register'] : []),
  ],
  entrypoints: { worker: './dist/worker.js', ...(UI_APPROVED ? { ui: './dist/ui' } : {}) },
  ...(UI_APPROVED ? { ui: { slots: UI_SLOTS } } : {}),
  instanceConfigSchema: {
    type: 'object',
    properties: {
      sendKeys: { type: 'array', items: { type: 'string' }, title: 'Payload keys that mean the approval sends something outside', default: ['replyBody', 'body', 'to', 'targetUrl', 'channel'] },
      notifyUrl: { type: 'string', title: 'Notification API URL' },
      notifyKey: { ...secretRef, title: 'Notification API project key (secret)' },
      notifyKeysByCompany: { type: 'object', additionalProperties: secretRef, title: 'Project key per company id (when each company is its own project)' },
      hostHeaders: { type: 'object', additionalProperties: secretRef, title: 'Extra headers sent when calling this Paperclip at hostUrl (e.g. an access proxy service token). Values are secrets; authorization/cookie are not allowed' },
      departments: {
        type: 'object', title: 'Departments per company id, shown in the app (agents not listed here go to "other")',
        additionalProperties: { type: 'array', items: { type: 'object', properties: { key: { type: 'string' }, name: { type: 'string' }, agentIds: { type: 'array', items: { type: 'string' } } }, required: ['name', 'agentIds'] } },
      },
      secretaryId: { type: 'object', additionalProperties: { type: 'string' }, title: 'Secretary agent id per company id (the default chat partner in the app)' },
      hostUrl: { type: 'string', pattern: '^https://', title: 'Public https URL the plugin uses to call this Paperclip (company decisions only; http, loopback and private addresses are not reachable)' },
    },
  },
  apiRoutes: [
    { routeKey: 'inbox', method: 'GET', path: '/v1/inbox', auth: 'board', capability: 'api.routes.register', companyResolution: { from: 'query', key: 'companyId' } },
    { routeKey: 'decide', method: 'POST', path: '/v1/decide', auth: 'board', capability: 'api.routes.register', companyResolution: { from: 'query', key: 'companyId' } },
    // 定期の処理の入口（会社ごと・board の鍵で毎分呼ぶ）。本体は会社の付いた呼び出し（出来事・API の口など）の中でしか会社の物を読ませないので、
    // 自前の setInterval や本体の job（会社が付かない）からは動かせない
    { routeKey: 'tick', method: 'POST', path: '/v1/tick', auth: 'board', capability: 'api.routes.register', companyResolution: { from: 'query', key: 'companyId' } },
  ],
};
