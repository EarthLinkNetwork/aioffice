import { OWNER_SCHEMA } from '../../owner-gate.mjs';
// 知らせの plugin。範囲: 開発元の記録 docs/review/2026-11-16-library-notify-scope.md の保証 1〜10・17〜20、
// Slack への届けは docs/review/2026-11-18-slack-notify-scope.md の S1〜S8
// 会社の物を読み書きするのは、起動係が 5 分ごとに会社ごとに呼ぶ見回りの口（/tick）と送りの口（/deliver）の中だけ（job は使わない・実測 1・16・17）。
// 0.2.0 で Slack に送るための http.outbound と secrets.read-ref を足した（版上げで capability が増えると本体が断るので、起動係が外して入れ直す・実測 15・G2）。
// 0.3.0 で AI の使用量の上限のための agents.pause・agents.resume と migration 005 を足した（同じく版上げで入れ直す）。
// 0.4.0 でメールで届けるための口（mail・mail-preview・mail-pending・mail-result）と migration 006 を足した（capability は増えない・設定の欄も増えない:
// アドレスとアプリ パスワードは起動係の state にだけ置くので、instanceConfigSchema には何も足さない。範囲 docs/review/2026-11-19-mail-notify-scope.md r2・r3）。
const route = (routeKey, method, path) => ({ routeKey, method, path, auth: 'board', capability: 'api.routes.register', companyResolution: { from: 'query', key: 'companyId' } });
export default {
  id: 'aioffice.notify',
  apiVersion: 1,
  version: '0.4.0',
  displayName: 'AI Office notices',
  description: 'Keeps one list of what is waiting for the owner (approvals, decisions, failed runs, stuck tasks) and a morning and evening summary. Sends them to the owner\'s Slack or mail only after the owner turns it on.',
  author: 'AI Office',
  categories: ['automation'],
  capabilities: [
    'events.subscribe',
    'plugin.state.read', 'plugin.state.write',
    'database.namespace.migrate', 'database.namespace.read', 'database.namespace.write',
    'issues.read', 'issue.interactions.read', 'approvals.read', 'agents.read',
    // AI の上限で担当を止める・戻す（範囲 docs/review/2026-11-18-ai-usage-limit-scope.md の 7 の 4。止める書き手はこの plugin の 1 本）
    'agents.pause', 'agents.resume',
    'api.routes.register',
    'http.outbound', 'secrets.read-ref',
  ],
  entrypoints: { worker: './dist/worker.js' },
  database: { namespaceSlug: 'notify', migrationsDir: 'migrations' },
  // stuckIdleMin: 止まった課題の境の分（既定 60・最小 1。CI の N3 では 1 にする）
  // slack.webhook: Slack の宛先の秘密の参照（起動係だけが書く。URL そのものは置かない・S3）
  instanceConfigSchema: {
    type: 'object',
    properties: {
      ownerUserIds: OWNER_SCHEMA,
      stuckIdleMin: { type: 'integer', minimum: 1, maximum: 10080, default: 60 },
      slack: { type: 'object', properties: { webhook: { type: 'object', format: 'secret-ref' } }, additionalProperties: false },
    },
    additionalProperties: false,
  },
  apiRoutes: [
    route('tick', 'POST', '/tick'),
    route('settings', 'GET', '/settings'),
    route('notices', 'GET', '/notices'),
    route('read', 'POST', '/notices/read'),
    route('slack', 'GET', '/slack'),
    route('slack-preview', 'GET', '/slack/preview'),
    route('slack-confirm', 'POST', '/slack/confirm'),
    route('slack-off', 'POST', '/slack/off'),
    route('slack-test', 'POST', '/slack/test'),
    route('deliver', 'POST', '/deliver'),
    // メールで届ける（送るのは起動係。ここは文を作って待ちに積み、結果を受ける）
    route('mail', 'GET', '/mail'),
    route('mail-preview', 'GET', '/mail/preview'),
    route('mail-pending', 'GET', '/mail/pending'),
    route('mail-result', 'POST', '/mail/result'),
    // 画面の「再開」の後に、止めた記録を閉じる（G6）
    route('limit-resume', 'POST', '/limit/resume'),
  ],
};
