// デザイン部の依頼の口（POST /api/plugins/aioffice.design/api/request?companyId=…）。
// 担当は画面が添えた id（起動係の state の「雛形 design で作った担当」）で、同じ会社にいるかを確かめる。
// 同じ依頼（originId）の未完了の課題があればそれを返し、同時の 2 回でも 1 件にする（会社ごとに直列）。
import { definePlugin, runWorker } from '@paperclipai/plugin-sdk';
import { checkRequest, issueOf, originIdOf, isOpen, ORIGIN_KIND } from './request.mjs';

let C = null;
const queues = new Map(); // 会社 → 直前の処理（会社ごとに 1 つずつ処理する）
export const queuesSize = () => queues.size;
function serial(key, fn) {
  const prev = queues.get(key) || Promise.resolve();
  const next = prev.then(fn);
  // 待ち行列に置くのは失敗を飲んだ形（受け取り手の無い reject を作らない）。自分が最後なら終わった時に消す
  const tail = next.catch(() => {}).then(() => { if (queues.get(key) === tail) queues.delete(key); });
  queues.set(key, tail);
  return next;
}

export async function handleRequest(ctx, companyId, body) {
  const r = checkRequest(body && typeof body === 'object' ? body : {});
  if (!r.ok) return { status: 400, body: { error: r.error } };
  return serial(companyId, async () => {
    const agents = await ctx.agents.list({ companyId });
    const agent = agents.find(a => a.id === r.agentId);
    if (!agent) return { status: 404, body: { error: 'design_no_agent' } };
    const originId = originIdOf(r);
    const found = (await ctx.issues.list({ companyId, originKind: ORIGIN_KIND, originId, limit: 20 })).filter(i => i.originId === originId && isOpen(i));
    if (found.length) return { status: 200, body: { v: 1, already: true, issue: { id: found[0].id, identifier: found[0].identifier ?? null } } };
    const { title, description } = issueOf(r);
    const issue = await ctx.issues.create({ companyId, title, description, status: 'todo', priority: 'medium', assigneeAgentId: agent.id, originKind: ORIGIN_KIND, originId });
    return { status: 201, body: { v: 1, already: false, issue: { id: issue.id, identifier: issue.identifier ?? null } } };
  });
}

const plugin = definePlugin({
  async setup(ctx) { C = ctx; },
  async onApiRequest(input) {
    if (input.routeKey !== 'request') return { status: 404, body: { error: 'unknown route' } };
    try { return await handleRequest(C, input.companyId, input.body); }
    catch (e) { C.logger.warn('design: request failed', { error: String(e?.message || e).slice(0, 200) }); return { status: 502, body: { error: 'design_failed' } }; }
  },
  async onHealth() { return { status: 'ok' }; },
});
export default plugin;
runWorker(plugin, import.meta.url);
