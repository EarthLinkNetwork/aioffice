// 回覧の worker。中身は lib.mjs（通信と DB は deps で渡す）。設計: docs/design/2026-11-21-office-relay.md
import { randomUUID } from 'node:crypto';
import { definePlugin, runWorker } from '@paperclipai/plugin-sdk';
import { tick, createRequest } from './lib.mjs';
import { sqlStore } from './store.mjs';

let D = null;
// 同じ会社の見回りを重ねない（重なった時は 2 回目を飛ばす。DB の一意の行が最後の守り）
const running = new Set();

const plugin = definePlugin({
  async setup(ctx) {
    const names = new Map();
    D = {
      ctx, store: sqlStore(ctx.db), newId: () => randomUUID(), now: () => Date.now(),
      cfgOf: async companyId => (await ctx.config.get(companyId).catch(() => ({}))) || {},
      // 取れなかった時は覚えない（次の回で取り直す・独立レビュー P3）
      companyName: async id => { if (!names.has(id)) { const n = (await ctx.companies.get(id).catch(() => null))?.name; if (!n) return 'ほかの会社'; names.set(id, n); } return names.get(id); },
      // 本体は会社に付いた呼び出しの中でほかの会社を読ませない（SDK の InvocationScopeDeniedError）ので、読むのはこの会社の member だけ
      memberships: async companyId => (await ctx.access.members.list({ companyId })).map(m => ({ companyId, userId: m.principalId, principalType: m.principalType, status: m.status, membershipRole: m.membershipRole })),
      warn: (msg, meta) => { try { ctx.logger?.warn?.(msg, meta); } catch { /* ログが出せなくても止めない */ } },
    };
  },
  async onApiRequest(input) {
    if (!D) return { status: 503, body: { error: 'not ready' } };
    if (input.routeKey === 'request') return createRequest(D, { companyId: input.companyId, issueId: input.params.issueId, actor: input.actor, body: input.body });
    if (input.routeKey === 'tick') {
      if (running.has(input.companyId)) return { status: 200, body: { skipped: 'running' } };
      running.add(input.companyId);
      try { return { status: 200, body: await tick(D, input.companyId) }; } finally { running.delete(input.companyId); }
    }
    return { status: 404, body: { error: 'unknown route' } };
  },
  async onHealth() { return { status: D ? 'ok' : 'error', message: D ? 'relay ready' : 'not set up' }; },
});

export default plugin;
runWorker(plugin, import.meta.url);
