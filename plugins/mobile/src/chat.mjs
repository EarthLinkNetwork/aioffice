// アプリの話（チャット）を本体の課題と通知 API の間で受け渡す。仕様: docs/review/2026-11-14-app-chat-spec.md（保証 1〜8・12・15・16）
// - poll（15 秒おき）: 通知 API の未送の発言を取り、新しい話は担当つき todo の課題（本文 = 最初の発言）に、続きは結びつけの持ち主の名前の comment にする
//   （閉じた課題は先に todo へ戻す）。書く前に state に「発言の id → 課題の id・comment の id」を書き、やり直しでも 1 つしか作らない
// - 出来事 issue.comment.created: 話の索引にある課題の、担当（課題の担当）が書いた comment だけを返事として通知 API に渡す
// - sync（毎分）: 直近 24 時間に発言のあった話（最大 20）の comment を読み直して未送の返事を渡す・発言から 3 分たって返事も実行も無い時だけ 1 回起こす・
//   最後の実行が失敗なら system の返事「返事できませんでした」・話の状態（waiting / done / failed・回した先）・担当の一覧（変わった時だけ）
// 状態は plugin の状態（会社ごと・namespace mobile）に置く。発言の全文と鍵はログ・例外の文言に出さない。
import { createHash } from 'node:crypto';

export const CHAT_ORIGIN_KIND = 'plugin:aioffice.mobile:chat';
export const WAKE_AFTER_MS = 3 * 60_000;
export const RECENT_MS = 24 * 60 * 60_000;
export const MAX_SYNC_THREADS = 20;
export const FAILED_TEXT = '返事できませんでした';
export const OTHER_DEPARTMENT = Object.freeze({ key: 'other', name: 'その他' });
export const TITLE_CHARS = 40;
// 通知 API の発言の上限（仕様 11）に合わせて、返事もこの長さで切る
export const REPLY_MAX_CHARS = 4000;
const CLOSED = new Set(['done', 'cancelled']);
const FAILED_RUNS = new Set(['failed', 'timed_out']);
const NS = 'mobile';
const DAY_MS = 24 * 60 * 60_000;
const MESSAGE_KEEP_MS = 7 * DAY_MS; // 「発言の id → 課題」の記録を残す長さ（通知 API がやり直す間より十分長く）
const INDEX_KEEP_MS = 90 * DAY_MS; // 話の索引を残す長さ（通知 API の発言の写しの寿命と同じ）
const REPLIED_KEEP = 200;
const CLOCK_SKEW_MS = 60_000;

const iso = t => new Date(t).toISOString();
const ms = v => { const t = Date.parse(v instanceof Date ? v.toISOString() : String(v ?? '')); return Number.isFinite(t) ? t : NaN; };
const errText = e => String(e?.message ?? e).slice(0, 200);
export const titleOf = text => [...String(text).replace(/\s+/g, ' ').trim()].slice(0, TITLE_CHARS).join('');
const clip = text => { const a = [...String(text ?? '')]; return a.length > REPLY_MAX_CHARS ? `${a.slice(0, REPLY_MAX_CHARS - 1).join('')}…` : a.join(''); };
// 返事 = その課題に、課題の担当（agent）が書いた comment
const isReply = (c, issueId, agentId) => !!c && c.authorType === 'agent' && !!agentId && c.authorAgentId === agentId && (!c.issueId || c.issueId === issueId) && !c.deletedAt && !!String(c.body ?? '').trim();

export function createChat({ ctx, notifyFor, configFor = async () => ({}), now = Date.now }) {
  const st = {
    get: async (companyId, key, dflt) => (await ctx.state.get({ scopeKind: 'company', scopeId: companyId, namespace: NS, stateKey: key })) ?? dflt,
    set: (companyId, key, v) => ctx.state.set({ scopeKind: 'company', scopeId: companyId, namespace: NS, stateKey: key }, v),
  };
  const warn = (msg, meta) => { try { ctx.logger?.warn?.(msg, meta); } catch { /* ログが出せなくても止めない */ } };
  // 会社ごとに 1 本ずつ順に回す（poll・出来事・sync が同じ state を書くため）
  const locks = new Map();
  const serial = (companyId, fn) => { const p = (locks.get(companyId) || Promise.resolve()).then(fn, fn); locks.set(companyId, p.catch(() => {})); return p; };

  // ---- poll: アプリの発言を本体に書く ----
  async function deliver(companyId, m) {
    if (!m || typeof m.id !== 'string' || !m.id || typeof m.threadId !== 'string' || !m.threadId) return { skip: 'shape' };
    const text = String(m.text ?? '');
    if (!text.trim()) return { skip: 'empty' };
    // 発言はこの会社の active な結びつけの物だけ（同じ鍵をほかの会社と使う時は、その会社が扱う）
    const b = (await st.get(companyId, 'bindings', {}))[m.bindingId];
    if (!b || b.status !== 'active' || !b.userId) return { skip: 'binding' };
    const msgs = await st.get(companyId, 'chatMessages', {});
    const rec = msgs[m.id];
    if (rec?.issueId && (rec.kind === 'created' || rec.commentId)) return { issueId: rec.issueId, commentId: rec.commentId || null, kind: rec.kind };
    const idx = await st.get(companyId, 'chatIssues', {});
    const byThread = Object.keys(idx).find(id => idx[id].threadId === m.threadId && idx[id].bindingId === m.bindingId) || null;
    // 新しい話として記録した発言のやり直しは、索引に話が入っていても新しい話の道に戻す（originId で課題を見つける・comment にしない）
    if (rec?.kind === 'created') return newThread(companyId, m, text, rec, msgs, idx, { b, byThread });
    const target = rec?.issueId || m.threadIssueId || byThread;
    if (target) {
      const e = idx[target];
      // 話の課題は、その結びつけ・その話の物だけ（ほかの結びつけの課題に書かせない）
      if (!e || e.bindingId !== m.bindingId || e.threadId !== m.threadId) return { skip: 'thread' };
      return continueThread(companyId, m, text, b, target, rec, msgs, idx);
    }
    return newThread(companyId, m, text, rec, msgs, idx, { b, byThread });
  }

  async function newThread(companyId, m, text, rec, msgs, idx, { b, byThread }) {
    const agent = await ctx.agents.get(String(m.agentId || ''), companyId).catch(() => null);
    if (!agent || agent.status === 'terminated') return { skip: 'agent' };
    // 書く前に記録する（課題を作った後に落ちても、やり直しで originId から見つける）
    if (!rec) { msgs[m.id] = { kind: 'created', threadId: m.threadId, bindingId: m.bindingId, at: iso(now()) }; await st.set(companyId, 'chatMessages', msgs); }
    let issue = null;
    if (rec) issue = (await ctx.issues.list({ companyId, originKind: CHAT_ORIGIN_KIND, originId: m.id, limit: 5 })).find(i => i.originId === m.id) || null;
    if (rec && !issue && byThread) {
      // やり直しで、この発言の課題は無いが話には既に別の課題がある（前の回にこの発言が落ちた間に、同じ話の後の発言が課題を作った）。
      // 2 つ目の課題は作らず、その課題への続きの発言にする（1 つの話に課題 1 件・担当を 2 回起こさない）
      delete msgs[m.id];
      return continueThread(companyId, m, text, b, byThread, null, msgs, idx);
    }
    if (!issue) {
      // 割り当てで担当が 1 回起きる。最初の発言は comment にしない（2 回動かないように）
      issue = await ctx.issues.create({ companyId, title: titleOf(text) || '…', description: text, status: 'todo', assigneeAgentId: agent.id, originKind: CHAT_ORIGIN_KIND, originId: m.id });
    }
    // 索引を先に書く（記録に課題の id が入った後は、やり直しが索引を見ずに戻るため）
    idx[issue.id] = { threadId: m.threadId, bindingId: m.bindingId, agentId: agent.id, lastMessageId: m.id, lastMessageAt: Number.isFinite(ms(issue.createdAt)) ? iso(ms(issue.createdAt)) : iso(now()), replied: [], failedRuns: [], woke: null, statusKey: null };
    await st.set(companyId, 'chatIssues', idx);
    msgs[m.id] = { ...msgs[m.id], issueId: issue.id };
    await st.set(companyId, 'chatMessages', msgs);
    // 判断の件から始めた話: card と話を、その人ごとに結び付ける（書くのはここだけ・relay は読んで card に話と結論を出す）
    if (typeof m.cardId === 'string' && m.cardId) {
      const links = await st.get(companyId, 'cardThreads', {});
      (links[m.cardId] = links[m.cardId] || {})[m.bindingId] = { issueId: issue.id, threadId: m.threadId, agentId: agent.id, at: iso(now()) };
      await st.set(companyId, 'cardThreads', links);
    }
    return { issueId: issue.id, commentId: null, kind: 'created' };
  }

  async function continueThread(companyId, m, text, b, issueId, rec, msgs, idx) {
    const issue = await ctx.issues.get(issueId, companyId);
    if (!issue) return { skip: 'issue' };
    if (!rec) { msgs[m.id] = { kind: 'comment', threadId: m.threadId, bindingId: m.bindingId, issueId, at: iso(now()) }; await st.set(companyId, 'chatMessages', msgs); }
    let comment = null;
    if (rec) {
      // やり直し: 前の回に書けていた comment を探す（同じ人・同じ本文・記録の後）。
      // ほかの発言の comment として記録済みの物は除く（「はい」のような同じ本文が続いても、前の発言の comment と取り違えない）。
      // 時刻の下限は、記録の時刻から時計のずれの幅を引いた所と、この話のほかの発言の記録の時刻のうち、この記録より前で最も新しい所の遅い方
      const taken = new Set();
      let since = ms(rec.at) - CLOCK_SKEW_MS;
      for (const [id, x] of Object.entries(msgs)) {
        if (id === m.id || x?.issueId !== issueId) continue;
        if (x.commentId) taken.add(x.commentId);
        const at = ms(x.at);
        if (at < ms(rec.at) && at > since) since = at;
      }
      comment = (await ctx.issues.listComments(issueId, companyId)).find(c => !taken.has(c.id) && c.authorType === 'user' && c.authorUserId === b.userId && c.body === text && !(ms(c.createdAt) < since)) || null;
    }
    if (!comment) {
      // 閉じた課題への人の comment は担当を起こさないので、先に開き直す
      if (CLOSED.has(issue.status)) await ctx.issues.update(issueId, { status: 'todo' }, companyId);
      comment = await ctx.issues.createComment(issueId, text, companyId, { actorUserId: b.userId });
    }
    const e = idx[issueId];
    e.lastMessageId = m.id;
    e.lastMessageAt = Number.isFinite(ms(comment.createdAt)) ? iso(ms(comment.createdAt)) : iso(now());
    await st.set(companyId, 'chatIssues', idx);
    msgs[m.id] = { ...msgs[m.id], issueId, commentId: comment.id };
    await st.set(companyId, 'chatMessages', msgs);
    return { issueId, commentId: comment.id, kind: 'comment' };
  }

  async function poll(companyId) {
    const out = { polled: false, created: 0, commented: 0, skipped: 0, failed: 0, deferred: 0 };
    const notify = await notifyFor(companyId);
    if (!notify) return out;
    const list = await notify.chatPending();
    out.polled = true;
    // 話（結びつけ + 話の id）の発言が失敗・skip になったら、この回はその話の後の発言を書かない（発言の順を守る・
    // 前の発言が新しい話を作れなかった間に、後の発言が別の課題を作らない）。次の回に前の発言から順にやり直す
    const held = new Set();
    for (const m of list) {
      const threadKey = JSON.stringify([m?.bindingId ?? null, m?.threadId ?? null]);
      if (held.has(threadKey)) { out.deferred++; continue; }
      const r = await serial(companyId, () => deliver(companyId, m)).catch(e => { warn('mobile: chat message could not be written', { error: errText(e) }); return { error: true }; });
      // 形の崩れた発言・空の発言はその発言だけの事なので、話の後の発言は止めない（止めると話がずっと進まない）
      if (r.skip && r.skip !== 'shape' && r.skip !== 'empty') held.add(threadKey);
      if (r.error) held.add(threadKey);
      if (r.skip) { out.skipped++; continue; }
      if (r.error) { out.failed++; continue; }
      try {
        await notify.chatSent(m.id, { issueId: r.issueId, commentId: r.commentId });
      } catch (e) { warn('mobile: chat message could not be marked sent', { status: e?.status ?? null }); out.failed++; continue; }
      if (r.kind === 'created') out.created++; else out.commented++;
      await serial(companyId, async () => {
        const msgs = await st.get(companyId, 'chatMessages', {});
        if (msgs[m.id]) msgs[m.id].sent = true;
        const cut = now() - MESSAGE_KEEP_MS;
        for (const [id, x] of Object.entries(msgs)) if (ms(x.at) < cut) delete msgs[id];
        await st.set(companyId, 'chatMessages', msgs);
      }).catch(e => warn('mobile: chat state could not be written', { error: errText(e) }));
    }
    return out;
  }

  // ---- 返事: 担当の comment を通知 API に渡す ----
  async function deliverReplies(companyId, notify, issueId, { issue = null, comments = null } = {}) {
    const idx = await st.get(companyId, 'chatIssues', {});
    const e = idx[issueId];
    if (!e) return 0;
    issue = issue || await ctx.issues.get(issueId, companyId);
    if (!issue) return 0;
    comments = comments || await ctx.issues.listComments(issueId, companyId);
    const replied = new Set(e.replied || []);
    let n = 0;
    try {
      for (const c of comments) {
        if (!isReply(c, issueId, issue.assigneeAgentId) || replied.has(c.id)) continue;
        await notify.postReply(e.bindingId, e.threadId, { commentId: c.id, text: clip(c.body), role: 'agent' });
        replied.add(c.id); n++;
      }
    } finally {
      if (n) { e.replied = [...replied].slice(-REPLIED_KEEP); await st.set(companyId, 'chatIssues', idx); }
    }
    return n;
  }

  async function onCommentCreated(event) {
    const companyId = event?.companyId;
    const issueId = event?.payload?.issueId || event?.entityId;
    if (!companyId || !issueId) return { ignored: true };
    // 話の索引に無い課題（子の課題・ほかの課題）は本体を読みに行かない
    if (!(await st.get(companyId, 'chatIssues', {}))[issueId]) return { ignored: true };
    const notify = await notifyFor(companyId);
    if (!notify) return { ignored: true };
    const replies = await serial(companyId, () => deliverReplies(companyId, notify, issueId));
    return { replies };
  }

  // ---- sync: 読み直し・起こす・失敗・状態・担当の一覧 ----
  async function syncThread(companyId, notify, issueId, out) {
    const issue = await ctx.issues.get(issueId, companyId);
    if (!issue) return;
    const comments = await ctx.issues.listComments(issueId, companyId);
    out.replies += await deliverReplies(companyId, notify, issueId, { issue, comments });
    const idx = await st.get(companyId, 'chatIssues', {});
    const e = idx[issueId];
    if (!e) return;
    const runs = await ctx.issues.summaries.getOrchestration({ issueId, companyId }).then(r => (Array.isArray(r?.runs) ? r.runs : []).filter(x => !x.issueId || x.issueId === issueId), err => { warn('mobile: chat runs could not be read', { error: errText(err) }); return null; });
    const lastMsg = ms(e.lastMessageAt);
    const agentReplies = comments.filter(c => isReply(c, issueId, issue.assigneeAgentId));
    let dirty = false;
    // 7: 発言の後の最後の実行が失敗し、その後に返事が無い
    let failed = false;
    const last = runs && [...runs].sort((a, b) => ms(b.createdAt) - ms(a.createdAt))[0];
    if (last && FAILED_RUNS.has(last.status) && ms(last.createdAt) >= lastMsg && !agentReplies.some(c => ms(c.createdAt) >= ms(last.createdAt))) {
      failed = true;
      const done = new Set(e.failedRuns || []);
      if (!done.has(last.id)) {
        await notify.postReply(e.bindingId, e.threadId, { commentId: `run-failed:${last.id}`, text: FAILED_TEXT, role: 'system' });
        e.failedRuns = [...done, last.id].slice(-50); dirty = true; out.failed++;
      }
    }
    // 2: 発言から 3 分たって、返事も担当の実行も無い時だけ 1 回起こす（実行が読めない時は起こさない）
    if (runs && !failed && !CLOSED.has(issue.status) && e.woke !== e.lastMessageId && now() - lastMsg >= WAKE_AFTER_MS
      && !agentReplies.some(c => ms(c.createdAt) >= lastMsg) && !runs.some(r => ms(r.createdAt) >= lastMsg)) {
      await ctx.issues.requestWakeup(issueId, companyId, { idempotencyKey: e.lastMessageId, reason: 'chat message has no reply' });
      e.woke = e.lastMessageId; dirty = true; out.woke++;
    }
    // 8: 話の状態と回した先
    const status = failed ? 'failed' : CLOSED.has(issue.status) ? 'done' : 'waiting';
    let handedTo = null;
    if (status === 'waiting') {
      const sub = await ctx.issues.getSubtree(issueId, companyId, { includeRoot: false, includeAssignees: true }).catch(err => { warn('mobile: chat subtree could not be read', { error: errText(err) }); return null; });
      const child = (sub?.issues || []).filter(i => i.id !== issueId && i.parentId === issueId && !CLOSED.has(i.status) && i.assigneeAgentId && i.assigneeAgentId !== issue.assigneeAgentId)
        .sort((a, b) => ms(b.createdAt) - ms(a.createdAt))[0];
      handedTo = child ? (sub.assignees?.[child.assigneeAgentId]?.name || null) : null;
    }
    const key = JSON.stringify([status, handedTo]);
    if (e.statusKey !== key) {
      await notify.putThreadStatus(e.bindingId, e.threadId, { status, handedTo });
      e.statusKey = key; dirty = true; out.statuses++;
    }
    if (dirty) await st.set(companyId, 'chatIssues', idx);
  }

  const departmentsOf = (cfg, companyId) => { const d = cfg?.departments?.[companyId]; return Array.isArray(d) ? d : []; };
  const secretaryOf = (cfg, companyId) => (typeof cfg?.secretaryId === 'string' ? cfg.secretaryId : typeof cfg?.secretaryId?.[companyId] === 'string' ? cfg.secretaryId[companyId] : null);
  const agentView = a => ({ id: a.id, name: String(a.name ?? ''), role: String(a.title || a.role || ''), blurb: String(a.capabilities ?? '').slice(0, 200) });

  // 12: 担当の一覧（部署は設定。設定に無い担当は「その他」）と結びつけの会社の id を、結びつけごとに中身が変わった時だけ送る
  async function syncAgents(companyId, notify, out) {
    const bindings = await st.get(companyId, 'bindings', {});
    const active = Object.keys(bindings).filter(id => bindings[id].status === 'active');
    const cfg = (await configFor(companyId)) || {};
    const agents = (await ctx.agents.list({ companyId, limit: 500 })).filter(a => a && a.status !== 'terminated');
    const byId = new Map(agents.map(a => [a.id, a]));
    const placed = new Set();
    const departments = [];
    departmentsOf(cfg, companyId).forEach((d, i) => {
      const ids = Array.isArray(d?.agentIds) ? d.agentIds : [];
      const list = ids.filter(id => byId.has(id)).map(id => { placed.add(id); return agentView(byId.get(id)); });
      departments.push({ key: String(d?.key || `d${i + 1}`), name: String(d?.name || ''), agents: list });
    });
    const rest = agents.filter(a => !placed.has(a.id)).sort((a, b) => String(a.name).localeCompare(String(b.name))).map(agentView);
    if (rest.length) departments.push({ ...OTHER_DEPARTMENT, agents: rest });
    const sec = secretaryOf(cfg, companyId);
    // companyId も hash に入れる（companyId の無い形で送り済みの結びつけにも 1 回送り直す）
    const body = { departments, secretaryId: sec && byId.has(sec) ? sec : null, companyId };
    const hash = createHash('sha256').update(JSON.stringify(body)).digest('hex').slice(0, 32);
    await serial(companyId, async () => {
      const sent = await st.get(companyId, 'chatAgents', {});
      let dirty = false;
      for (const id of Object.keys(sent)) if (!active.includes(id)) { delete sent[id]; dirty = true; }
      try {
        for (const bid of active) {
          if (sent[bid] === hash) continue;
          await notify.putAgents(bid, body);
          sent[bid] = hash; dirty = true; out.agents++;
        }
      } finally { if (dirty) await st.set(companyId, 'chatAgents', sent); }
    });
  }

  async function sync(companyId) {
    const out = { synced: false, threads: 0, replies: 0, woke: 0, failed: 0, statuses: 0, agents: 0 };
    const notify = await notifyFor(companyId);
    if (!notify) return out;
    out.synced = true;
    await syncAgents(companyId, notify, out).catch(e => warn('mobile: chat agents could not be sent', { error: errText(e) }));
    const idx = await st.get(companyId, 'chatIssues', {});
    const t = now();
    const recent = Object.keys(idx).filter(id => t - ms(idx[id].lastMessageAt) <= RECENT_MS)
      .sort((a, b) => ms(idx[b].lastMessageAt) - ms(idx[a].lastMessageAt)).slice(0, MAX_SYNC_THREADS);
    for (const issueId of recent) {
      out.threads++;
      await serial(companyId, () => syncThread(companyId, notify, issueId, out)).catch(e => warn('mobile: chat thread could not be synced', { error: errText(e) }));
    }
    // 古い話を索引から外す（通知 API の写しが消えた後）
    await serial(companyId, async () => {
      const cur = await st.get(companyId, 'chatIssues', {});
      const old = Object.keys(cur).filter(id => !(t - ms(cur[id].lastMessageAt) <= INDEX_KEEP_MS));
      if (old.length) { for (const id of old) delete cur[id]; await st.set(companyId, 'chatIssues', cur); }
      // card と話の結び付きも、索引と同じ長さで外す
      const links = await st.get(companyId, 'cardThreads', {});
      let dirty = false;
      for (const [cardId, per] of Object.entries(links)) {
        for (const [bid, l] of Object.entries(per || {})) if (!(t - ms(l?.at) <= INDEX_KEEP_MS)) { delete per[bid]; dirty = true; }
        if (!Object.keys(per || {}).length) { delete links[cardId]; dirty = true; }
      }
      if (dirty) await st.set(companyId, 'cardThreads', links);
    }).catch(e => warn('mobile: chat state could not be written', { error: errText(e) }));
    return out;
  }

  return { poll, sync, onCommentCreated };
}
