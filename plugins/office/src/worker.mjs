// office の画面のデータ（担当・仕事の掲示・課題の中身・担当の仕事）。会社は本体が認可した params.companyId だけを使う。
// 承認・判断・出来事は SDK に口が無い・書く操作なので、画面から本体の /api を直に呼ぶ（src/api.mjs・範囲の「前提」）
import { definePlugin, runWorker } from '@paperclipai/plugin-sdk';

const BODY_MAX = 1500, COMMENTS = 3, TASKS_MAX = 30;
const cut = (s, n) => { const v = String(s ?? ''); return v.length > n ? `${v.slice(0, n)}…` : v; };
const brief = i => ({ id: i.id, identifier: i.identifier ?? null, title: cut(i.title, 200), status: i.status ?? null, priority: i.priority ?? null, assigneeAgentId: i.assigneeAgentId ?? null, updatedAt: i.updatedAt ?? null });
const newest = (a, b) => String(b.updatedAt || '').localeCompare(String(a.updatedAt || ''));

export function createHandlers(ctx) {
  const need = p => { const companyId = String(p?.companyId || ''); if (!companyId) throw new Error('companyId is required'); return companyId; };
  return {
    async agents(p) {
      const companyId = need(p);
      const list = await ctx.agents.list({ companyId });
      return list.map(a => ({ id: a.id, name: a.name, title: a.title ?? null, role: a.role ?? null, status: a.status ?? null, lastHeartbeatAt: a.lastHeartbeatAt ?? null }));
    },
    async tasks(p) {
      const companyId = need(p);
      // 止まった課題（AI の契約が切れた・担当の実行が失敗した）も掲示に出す。消えると持ち主が気づけない
      const [doing, next, blocked] = await Promise.all(['in_progress', 'todo', 'blocked'].map(status => ctx.issues.list({ companyId, status, limit: TASKS_MAX })));
      return { doing: doing.sort(newest).map(brief), next: next.sort(newest).map(brief), blocked: blocked.sort(newest).map(brief) };
    },
    async issue(p) {
      const companyId = need(p), issueId = String(p?.issueId || '');
      if (!issueId) throw new Error('issueId is required');
      const issue = await ctx.issues.get(issueId, companyId);
      if (!issue) return null;
      const comments = (await ctx.issues.listComments(issueId, companyId)).slice(-COMMENTS);
      return { ...brief(issue), description: cut(issue.description, BODY_MAX), comments: comments.map(c => ({ id: c.id, body: cut(c.body, BODY_MAX), authorAgentId: c.authorAgentId ?? null, authorUserId: c.authorUserId ?? null, createdAt: c.createdAt ?? null })) };
    },
    async agentWork(p) {
      const companyId = need(p), agentId = String(p?.agentId || '');
      if (!agentId) throw new Error('agentId is required');
      const list = await ctx.issues.list({ companyId, assigneeAgentId: agentId, limit: 20 });
      const sorted = list.sort(newest);
      return { now: sorted.filter(i => i.status === 'in_progress').map(brief), recent: sorted.filter(i => i.status !== 'in_progress').slice(0, 5).map(brief) };
    },
  };
}

const plugin = definePlugin({
  async setup(ctx) {
    const h = createHandlers(ctx);
    for (const [key, fn] of Object.entries(h)) ctx.data.register(key, fn);
  },
  async onHealth() { return { status: 'ok' }; },
});
export default plugin;
runWorker(plugin, import.meta.url);
