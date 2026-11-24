// タスクボードの worker。担当の名前だけを渡す（課題とラベルは画面が本体の /api から読む）。会社は本体が認可した params.companyId だけを使う
import { definePlugin, runWorker } from '@paperclipai/plugin-sdk';

export function createHandlers(ctx) {
  return {
    async agents(p) {
      const companyId = String(p?.companyId || '');
      if (!companyId) throw new Error('companyId is required');
      const list = await ctx.agents.list({ companyId });
      return list.map(a => ({ id: a.id, name: a.name, title: a.title ?? null }));
    },
  };
}

const plugin = definePlugin({
  async setup(ctx) { for (const [key, fn] of Object.entries(createHandlers(ctx))) ctx.data.register(key, fn); },
  async onHealth() { return { status: 'ok' }; },
});
export default plugin;
runWorker(plugin, import.meta.url);
