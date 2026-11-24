// 図書室の「聞く」: 図書室の記録の抜き出しを資料にした課題を秘書に割り当て、秘書の返事を部屋に出す。
// 範囲: 開発元の記録 docs/review/2026-11-17-library-ask-scope.md（作り方 1〜13・保証 1〜11）
// 課題を作る・担当を起こすのは、この file の handleAsk と handleAskGet の中だけ（保証 10・test が源を見て確かめる）
import { createHash, randomBytes } from 'node:crypto';
import { DICT } from './lib.mjs';

export const ASK_ORIGIN = 'plugin:aioffice.library:ask';
export const ASK = { maxQ: 300, k: 8, perSource: 2, totalChars: 8000, dupMs: 2 * 3600_000, maxOpen: 3, wakeAfterMs: 90_000 };
const CLOSED = new Set(['done', 'cancelled']);
const ANSWERED = new Set(['done', 'in_review']);
export const OPEN_STATUSES = ['backlog', 'todo', 'in_progress', 'in_review', 'blocked'];
const FAILED_RUNS = new Set(['failed', 'timed_out', 'cancelled']);
const S = (companyId, stateKey) => ({ scopeKind: 'company', scopeId: companyId, stateKey });
export const SECRETARY = c => S(c, 'secretary');
export const ASK_WOKE = c => S(c, 'ask_woke');
const ms = t => { const n = Date.parse(t || ''); return Number.isFinite(n) ? n : 0; };

// 正規化: NFKC・前後の空白・続く空白を 1 つ・小文字（作り方 6）
export const normQ = q => String(q ?? '').normalize('NFKC').trim().replace(/\s+/g, ' ').toLowerCase();
export const askOriginId = (companyId, q) => `ask:${createHash('sha256').update(`${companyId}\x1f${normQ(q)}`).digest('hex').slice(0, 24)}`;
export const isAskIssue = i => !!i && i.originKind === ASK_ORIGIN;

// 資料を選ぶ: 同じ出どころから 2 件まで・合計の字数の上限まで（1 件は 1 塊）
export function pickSources(hits, { k = ASK.k, perSource = ASK.perSource, totalChars = ASK.totalChars } = {}) {
  const per = new Map(), out = []; let total = 0;
  for (const h of hits || []) {
    if (out.length >= k) break;
    const src = String(h.id || '').split('#')[0] || String(h.title || '');
    if ((per.get(src) || 0) >= perSource) continue;
    const text = String(h.text || '');
    if (total + text.length > totalChars) continue;
    per.set(src, (per.get(src) || 0) + 1); total += text.length;
    out.push({ title: String(h.title || ''), source: src, text });
  }
  return out;
}


// 課題の本文: 固定の指示 → 問い → 資料（1 回ごとの乱数の境界で囲み、資料の中の同じ列は伏せる・作り方 8）
export function askBody({ q, sources, lang = 'en', boundary = randomBytes(8).toString('hex') }) {
  const fence = `=====LIBRARY-DATA-${boundary}=====`;
  // 資料・問いの中の境界らしい部分（NFKC で正規化して = に続く LIBRARY DATA）は、行の途中でも伏せる。全角の偽の行も伏せ、= の付かないふつうの語「library data」は変えない（実装レビュー P2-1・再レビュー P3-1）
  const FENCE_LIKE = /=+\s*LIBRARY[\s_-]*DATA[\w-]*=*/gi;
  const hide = s => String(s).split('\n').map(l => { const n = l.normalize('NFKC'); return FENCE_LIKE.test(n) ? (FENCE_LIKE.lastIndex = 0, n.replace(FENCE_LIKE, '[boundary hidden]')) : l; }).join('\n');
  // 英語の指示は常に入れ、日本語の時は日本語も足す（AI が英語の指示を読み落とさないように）
  const fixed = [...DICT.en.ask_fixed, DICT.en.ask_fence(fence), '', ...(lang === 'ja' ? [...DICT.ja.ask_fixed, DICT.ja.ask_fence(fence)] : [])];
  const qHead = lang === 'ja' ? `${DICT.en.ask_question} / ${DICT.ja.ask_question.replace(/^## /, '')}` : DICT.en.ask_question;
  const mat = sources.map((s, i) => `[${i + 1}] ${hide(s.title)} (${hide(s.source)})\n${hide(s.text)}`).join('\n\n');
  return `${fixed.join('\n')}\n\n${qHead}\n${hide(q)}\n\n${fence}\n${mat}\n${fence}\n`;
}

// 秘書の id を見回りの body から受ける（wizard の会社にだけ入る。無い時は消す・作り方 2）
export async function takeSecretary(state, companyId, body) {
  const id = typeof body?.secretaryAgentId === 'string' && /^[A-Za-z0-9-]{1,64}$/.test(body.secretaryAgentId) ? body.secretaryAgentId : null;
  const cur = await state.get(SECRETARY(companyId));
  if ((cur?.id || null) !== id) await state.set(SECRETARY(companyId), { id });
  return id;
}

const err = (status, error) => ({ status, body: { error } });

// POST /ask
export async function handleAsk(deps, companyId, input, { search, isJson }) {
  if (!isJson(input.headers)) return err(415, 'library_json_only');
  const q = String(input.body?.q ?? '').trim();
  if (!q || q.length > ASK.maxQ) return err(400, 'library_ask_bad_question');
  const lang = input.body?.lang === 'ja' ? 'ja' : 'en';
  const sec = (await deps.state.get(SECRETARY(companyId)))?.id || null;
  if (!sec) return err(409, 'library_secretary_pending');
  const agent = await deps.agents.get(sec, companyId).catch(() => null);
  if (!agent || (agent.companyId && agent.companyId !== companyId) || agent.status === 'terminated' || agent.status === 'paused') return err(409, 'library_no_secretary');
  const sources = pickSources(await search(q));
  if (!sources.length) return { status: 200, body: { v: 1, found: false } };
  return deps.askChain(companyId, async () => {
    const now = deps.now();
    const originId = askOriginId(companyId, q);
    // 重複は originId で、上限は開いた状態ごとに読む（終わった課題が一覧を埋めて開いた課題が漏れないように・実装レビュー P2-3）
    const same = (await deps.issues.list({ companyId, originKind: ASK_ORIGIN, originId, limit: 20 })).filter(i => isAskIssue(i) && i.originId === originId && !CLOSED.has(i.status)).sort((a, b) => ms(b.createdAt) - ms(a.createdAt));
    const mine = (await Promise.all(OPEN_STATUSES.map(status => deps.issues.list({ companyId, originKind: ASK_ORIGIN, status, limit: 50 })))).flat().filter(i => isAskIssue(i) && !CLOSED.has(i.status));
    if (same[0] && now - ms(same[0].createdAt) <= ASK.dupMs) return { status: 200, body: { v: 1, found: true, already: true, issue: { id: same[0].id, identifier: same[0].identifier ?? null } } };
    if (mine.filter(i => now - ms(i.createdAt) <= ASK.dupMs).length >= ASK.maxOpen) return err(429, 'library_ask_busy');
    const title = `${DICT[lang].ask_title}: ${q.slice(0, 80)}`;
    const issue = await deps.issues.create({ companyId, title, description: askBody({ q, sources, lang }), status: 'todo', priority: 'medium', assigneeAgentId: agent.id, originKind: ASK_ORIGIN, originId });
    return { status: 201, body: { v: 1, found: true, already: false, stale: same[0] ? { identifier: same[0].identifier ?? null } : null, issue: { id: issue.id, identifier: issue.identifier ?? null } } };
  });
}

const isAgentComment = (c, agentId) => !!c && c.authorType === 'agent' && !!agentId && c.authorAgentId === agentId && !c.deletedAt && !!String(c.body ?? '').trim();

// GET /ask/<issueId>: { state: waiting | answered | failed | handed_to, answer, identifier, handedTo }
export async function handleAskGet(deps, companyId, issueId) {
  if (!/^[A-Za-z0-9-]{1,64}$/.test(String(issueId || ''))) return err(404, 'library_ask_not_found');
  const issue = await deps.issues.get(issueId, companyId).catch(() => null);
  if (!issue || issue.companyId !== companyId || !isAskIssue(issue)) return err(404, 'library_ask_not_found');
  const base = { v: 1, identifier: issue.identifier ?? null, answer: null, handedTo: null };
  const comments = await deps.issues.listComments(issue.id, companyId);
  const replies = comments.filter(c => isAgentComment(c, issue.assigneeAgentId)).sort((a, b) => ms(a.createdAt) - ms(b.createdAt));
  if (ANSWERED.has(issue.status) && replies.length) return { status: 200, body: { ...base, state: 'answered', answer: String(replies[replies.length - 1].body) } };
  // 答えの comment なしで閉じられた（実装レビュー P3-b）
  if (CLOSED.has(issue.status) && !replies.length) return { status: 200, body: { ...base, state: 'closed' } };
  // 子の課題の実行は数えない（ほかの担当の失敗を秘書の失敗として出さない・実装レビュー P3-a）
  const runs = await deps.issues.summaries.getOrchestration({ issueId: issue.id, companyId }).then(r => (Array.isArray(r?.runs) ? r.runs : []).filter(x => !x.issueId || x.issueId === issue.id), () => null);
  const last = runs && [...runs].sort((a, b) => ms(b.createdAt) - ms(a.createdAt))[0];
  if (last && FAILED_RUNS.has(last.status) && !replies.some(c => ms(c.createdAt) >= ms(last.createdAt))) return { status: 200, body: { ...base, state: 'failed' } };
  const sub = await deps.issues.getSubtree(issue.id, companyId, { includeRoot: false, includeAssignees: true }).catch(() => null);
  const child = (sub?.issues || []).filter(i => i.parentId === issue.id && i.assigneeAgentId && i.assigneeAgentId !== issue.assigneeAgentId).sort((a, b) => ms(b.createdAt) - ms(a.createdAt))[0];
  if (child) return { status: 200, body: { ...base, state: 'handed_to', handedTo: sub.assignees?.[child.assigneeAgentId]?.name || null } };
  // 作ってから 90 秒たって、返事も実行も無い時だけ 1 回起こし直す（作り方 10）
  if (runs && !CLOSED.has(issue.status) && !replies.length && !runs.length && deps.now() - ms(issue.createdAt) >= ASK.wakeAfterMs) {
    const woke = (await deps.state.get(ASK_WOKE(companyId))) || { ids: [] };
    if (!woke.ids.includes(issue.id)) {
      await deps.issues.requestWakeup(issue.id, companyId, { idempotencyKey: `library-ask:${issue.id}`, reason: 'library question has no reply' });
      await deps.state.set(ASK_WOKE(companyId), { ids: [...woke.ids, issue.id].slice(-50) });
    }
  }
  return { status: 200, body: { ...base, state: 'waiting' } };
}
