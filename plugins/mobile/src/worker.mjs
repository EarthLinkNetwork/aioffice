// スマホアプリ向けの受信箱（汎用）。
// - 通知 API へ送る: 判断待ちを card（v1）にして結びついた人宛てに送り、片付いたら消す（relay.mjs）
// - 押された操作を通知 API から取りに行き、押した人の名義で反映する（外への呼び出しだけ）
// - 会社ごとの判断の key を出す・確かめる・入れ替える・失効させる（relay.mjs・host-auth-client.mjs）
// - 結びつけの画面（本体の「AI Office」の page・ui.mjs）が呼ぶ操作: link.*・keys.*
// - アプリの話（チャット）: 発言を課題・comment に書き、担当の返事・話の状態・担当の一覧を通知 API へ渡す（chat.mjs）
// - GET /v1/inbox・POST /v1/decide（v0.1.0）は、本体の画面から card を作る・決める部品として残す
import { createSecretCache } from './secret-cache.mjs';
import { makeHostFetch, allowedHostHeaderName } from './host-fetch.mjs';
import { definePlugin, runWorker } from '@paperclipai/plugin-sdk';
import { inbox, DEFAULT_SEND_KEYS } from './cards.mjs';
import { createNotifyClient } from './notify-client.mjs';
import { createDecisionsClient } from './decisions-client.mjs';
import { createHostAuthClient } from './host-auth-client.mjs';
import manifest from './manifest.mjs';
import { createRelay } from './relay.mjs';
import { createChat } from './chat.mjs';


let C = null;
let relay = null;
let chat = null;
const sendKeysOf = cfg => (Array.isArray(cfg.sendKeys) && cfg.sendKeys.length ? cfg.sendKeys : DEFAULT_SEND_KEYS);
const cfgOf = async companyId => (await C.config.get(companyId).catch(() => ({}))) || {};

async function notifyFor(companyId) {
  const cfg = await cfgOf(companyId);
  const ref = (cfg.notifyKeysByCompany && cfg.notifyKeysByCompany[companyId]) || cfg.notifyKey;
  if (!cfg.notifyUrl || !ref) return null;
  // キーは呼ぶたびに secrets から読む（持ち続けない・ログに出さない）
  // 通知 API に鍵を断られたら（401）覚えた鍵を捨てる（次の呼び出しで解き直す・入れ替えに追いつく）
  return createNotifyClient({ baseUrl: cfg.notifyUrl, getKey: () => secrets().get(ref, companyId),
    fetch: async (u, i) => { const r = await C.http.fetch(u, i); if (r?.status === 401) secrets().forget(ref, companyId); return r; } });
}
// 本体の URL は https だけを受ける（判断の key を載せて呼ぶため。http は設定の時点で断る）
export const isHttpsUrl = u => { try { return new URL(String(u)).protocol === 'https:'; } catch { return false; } };
export function validateConfig(cfg = {}) {
  const errors = [];
  if (cfg.hostUrl && !isHttpsUrl(cfg.hostUrl)) errors.push('hostUrl must be an https:// URL (the decision key is sent to it)');
  for (const k of Object.keys(cfg.hostHeaders || {})) if (!allowedHostHeaderName(k)) errors.push(`hostHeaders: header name not allowed: ${k}`);
  return errors.length ? { ok: false, errors } : { ok: true };
}
// 本体を呼ぶ fetch: 設定の hostHeaders（名前 → 秘密の参照）を解いて足す（本体が認証の proxy の後ろにある時）
// 解いた秘密は 5 分だけ覚える（本体は plugin・会社ごとに 1 分 30 回までしか秘密を解かせない）
let _secrets = null;
const _lastHostRefresh = new Map(); // 会社 -> 最後に proxy の header を捨てた時刻
const secrets = () => (_secrets ??= createSecretCache({ resolve: (ref, o) => C.secrets.resolve(ref, o) }));
async function hostFetchFor(companyId, cfg) {
  const refs = cfg.hostHeaders && typeof cfg.hostHeaders === 'object' ? cfg.hostHeaders : {};
  return makeHostFetch({
    fetch: (u, i) => C.http.fetch(u, i),
    // 捨てて解き直すのは会社ごとに 60 秒に 1 回まで（本体の 1 分 30 回の上限を守る）
    refresh: () => { const now = Date.now(); if (now - (_lastHostRefresh.get(companyId) ?? 0) < 60_000) return false; _lastHostRefresh.set(companyId, now); for (const ref of Object.values(refs)) secrets().forget(ref, companyId); return true; },
    getHeaders: async () => Object.fromEntries(await Promise.all(Object.entries(refs).map(async ([k, ref]) => [k, await secrets().get(ref, companyId).catch(err => { C.logger.warn('mobile: hostHeaders secret could not be resolved; calling without it', { header: k, error: String(err?.message ?? err).slice(0, 120) }); return ''; })]))),
  });
}
async function decisionsFor(companyId) {
  const cfg = await cfgOf(companyId);
  if (!cfg.hostUrl) return null;
  if (!isHttpsUrl(cfg.hostUrl)) { C.logger.warn('mobile: hostUrl is not https; company decisions are not read'); return null; }
  return createDecisionsClient({ baseUrl: cfg.hostUrl, fetch: await hostFetchFor(companyId, cfg) });
}

async function hostAuthFor(companyId) {
  const cfg = await cfgOf(companyId);
  if (!cfg.hostUrl || !isHttpsUrl(cfg.hostUrl)) return null;
  return createHostAuthClient({ baseUrl: cfg.hostUrl, fetch: await hostFetchFor(companyId, cfg) });
}
// 結びつけの画面の URL（お知らせの「Paperclip で開く」）: <hostUrl>/<会社の prefix>/<PAGE_ROUTE>
export const PAGE_ROUTE = 'ai-office';
async function pageUrlFor(companyId) {
  if (!manifest.ui) return null; // 画面を出していない間（mock の承認待ち）
  const cfg = await cfgOf(companyId);
  if (!cfg.hostUrl || !isHttpsUrl(cfg.hostUrl)) return null;
  const co = await C.companies.get(companyId).catch(() => null);
  return co?.issuePrefix ? `${String(cfg.hostUrl).replace(/\/+$/, '')}/${encodeURIComponent(co.issuePrefix)}/${PAGE_ROUTE}` : null;
}

const ticking = new Set(); // /v1/tick を処理中の「会社|種類」（同じ会社の同じ種類が重なったら飛ばす）

const plugin = definePlugin({
  async setup(ctx) {
    C = ctx;
    relay = createRelay({ ctx, notifyFor, decisionsFor, hostAuthFor, pageUrlFor, sendKeysFor: async id => sendKeysOf(await cfgOf(id)) });
    chat = createChat({ ctx, notifyFor, configFor: cfgOf });
    // 承認は出た時の出来事で 1 分以内に送る・決まったら消す
    for (const ev of ['approval.created', 'approval.decided']) {
      ctx.events.on(ev, async e => { if (e.companyId) await relay.syncCompany(e.companyId).catch(err => ctx.logger.warn('mobile: sync failed', { error: String(err?.message || err) })); });
    }
    // 話の課題に comment が付いたら、担当の返事だけをアプリへ渡す（出来事は会社の付いた呼び出しなので本体を読める）
    ctx.events.on('issue.comment.created', async e => { await chat.onCommentCreated(e).catch(err => ctx.logger.warn('mobile: chat reply failed', { error: String(err?.message || err).slice(0, 200) })); });
    // 定期の処理は API の口 /v1/tick（会社ごと・毎分・外の cron が board の鍵で呼ぶ）で回す。
    // 本体は会社の付いた呼び出しの中でしか会社の物を読ませない。自前の setInterval は「invocation scope が無い」と断られ（2026-11-13 実機）、
    // 本体の job は会社が付かないので、どちらも使えない。
    // 結びつけの画面の操作。人は本体のログインで決まる actor だけを使い、params の人は使わない
    const who = c => ({ companyId: c.companyId || c.actor?.companyId, userId: c.actor?.type === 'user' ? c.actor.userId : null });
    ctx.actions.register('link.start', async (_p, c) => { const w = who(c); return relay.bindings.start(w.companyId, w.userId); });
    ctx.actions.register('link.status', async (p, c) => { const w = who(c); return relay.bindings.status(w.companyId, w.userId, String(p.bindingId || '')); });
    ctx.actions.register('link.confirm', async (p, c) => { const w = who(c); const r = await relay.bindings.confirm(w.companyId, w.userId, String(p.bindingId || ''), p.accept === true); if (r.ok) relay.syncCompany(w.companyId).catch(() => {}); return r; });
    ctx.actions.register('link.role', async (_p, c) => { const w = who(c); return relay.bindings.role(w.companyId, w.userId); });
    ctx.actions.register('link.pending', async (_p, c) => { const w = who(c); return relay.bindings.pending(w.companyId, w.userId); });
    ctx.actions.register('link.list', async (_p, c) => { const w = who(c); return relay.bindings.list(w.companyId, w.userId); });
    ctx.actions.register('link.remove', async (p, c) => { const w = who(c); return relay.bindings.remove(w.companyId, w.userId, String(p.bindingId || '')); });
    // 判断の key: 依頼を作る（承認の URL は押した本人にだけ返す）・本人の状態
    ctx.actions.register('keys.request', async (_p, c) => { const w = who(c); return relay.decisionKeys.request(w.companyId, w.userId); });
    ctx.actions.register('keys.status', async (_p, c) => { const w = who(c); return relay.decisionKeys.status(w.companyId, w.userId); });
    ctx.actions.register('keys.revokeAll', async (_p, c) => { const w = who(c); return relay.decisionKeys.revokeAll(w.companyId, w.userId); });
  },
  async onApiRequest(input) {
    const sendKeys = sendKeysOf(await cfgOf(input.companyId));
    if (input.routeKey === 'tick') {
      // 会社ごとの定期の 1 回。what=sync は判断待ちを探して送る（毎分）、what=poll は押された操作を取りに行く（15 秒おき）。
      // 本体の API の口は 30 秒で切れるので、2 つを 1 回の呼び出しに詰めない（件が多い時に途中で切れて半端になる）。
      const what = String(input.query?.what || '');
      if (what !== 'sync' && what !== 'poll') return { status: 400, body: { error: 'what must be sync or poll' } };
      const lock = `${input.companyId}|${what}`;
      if (ticking.has(lock)) return { status: 200, body: { v: 1, what, skipped: 'busy' } };
      ticking.add(lock);
      try {
        // 話（chat）は判断の件とは別に回す（判断の件が 1 つも無くても未送の発言を取りに行く）。2 つは同時に走らせ、30 秒の内に収める
        const chatFailed = label => e => { C.logger.warn(`mobile: chat ${label} failed`, { error: String(e?.message || e).slice(0, 200) }); return { ok: false }; };
        const [out, chatOut] = what === 'sync'
          ? await Promise.all([
            relay.syncCompany(input.companyId).then(() => ({ ok: true }), e => { C.logger.warn('mobile: sync failed', { error: String(e?.message || e) }); return { ok: false }; }),
            chat.sync(input.companyId).catch(chatFailed('sync')),
          ])
          : await Promise.all([
            relay.pollActions(input.companyId).catch(e => { C.logger.warn('mobile: poll failed', { error: String(e?.message || e) }); return { ok: false }; }),
            chat.poll(input.companyId).catch(chatFailed('poll')),
          ]);
        return { status: 200, body: { v: 1, what, ...out, chat: chatOut } };
      } finally { ticking.delete(lock); }
    }
    if (input.routeKey === 'inbox') {
      const list = await C.approvals.list({ companyId: input.companyId, status: 'pending' });
      return { status: 200, body: { v: 1, companyId: input.companyId, cards: inbox(list, { sendKeys }) } };
    }
    if (input.routeKey === 'decide') {
      const b = input.body && typeof input.body === 'object' ? input.body : {};
      if (!b.id || !['approve', 'reject'].includes(b.action)) return { status: 400, body: { error: 'id and action (approve | reject) are required' } };
      if (b.action === 'reject' && !String(b.note || '').trim()) return { status: 400, body: { error: 'a note is required to reject' } };
      if (!input.actor.userId) return { status: 403, body: { error: 'only a signed-in member can decide' } };
      const r = await C.approvals.decide(String(b.id), { action: b.action, actorUserId: input.actor.userId, decisionNote: String(b.note || '').slice(0, 2000) || null }, input.companyId);
      return { status: 200, body: { v: 1, id: r.approval.id, status: r.approval.status, applied: r.applied } };
    }
    return { status: 404, body: { error: 'unknown route' } };
  },
  async onValidateConfig(config) { return validateConfig(config || {}); },
  async onHealth() { return { status: 'ok' }; },
});
export default plugin;
runWorker(plugin, import.meta.url);
