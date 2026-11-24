// 通知 API（notify）の口を project のキーで呼ぶ client。
// 口の path と形は、まだ通知 API の側で決まっていない。決まったら NOTIFY_API だけを差し替える（ここ以外に path を書かない）。
// キーはログ・例外の文言・戻り値に出さない（例外には口の名前と HTTP の状態だけを入れる）。

// 仮の形（通知 API の側と合わせる所）:
// - 認証: `Authorization: Bearer <project のキー>`
// - card は「結びつけ × card」で 1 件。宛先は結びつけの id（自由な文字列の宛先にしない）
// - push: false の時は受信箱に入れるだけで push しない（初めて入れる回・中身の更新・後から結びついた人）
// - 押された操作: { id, cardId, bindingId, actionId, version, values: { note?, inputs? }, pressedAt }
// - 済みを返す: { ok: true } か { ok: false, reason }
// - 結びつけ: code を出す → 状態を読む（waiting | claimed | active | rejected | expired | revoked・claimed の時は名乗り出た人の email）→ code を出した本人が確認・断る → 外す
const enc = encodeURIComponent;
export const NOTIFY_API = {
  putCard: (bindingId, cardId) => ['PUT', `/api/v1/plugin/bindings/${enc(bindingId)}/cards/${enc(cardId)}`],
  deleteCard: (bindingId, cardId) => ['DELETE', `/api/v1/plugin/bindings/${enc(bindingId)}/cards/${enc(cardId)}`],
  pendingActions: () => ['GET', '/api/v1/plugin/actions?status=pending'],
  reportAction: actionId => ['POST', `/api/v1/plugin/actions/${enc(actionId)}/result`],
  createBindCode: () => ['POST', '/api/v1/plugin/bindings'],
  bindingState: bindingId => ['GET', `/api/v1/plugin/bindings/${enc(bindingId)}`],
  confirmBinding: bindingId => ['POST', `/api/v1/plugin/bindings/${enc(bindingId)}/confirm`],
  revokeBinding: bindingId => ['DELETE', `/api/v1/plugin/bindings/${enc(bindingId)}`],
  // アプリの話（チャット）。契約: docs/review/2026-11-14-app-chat-spec.md「口の形」
  putAgents: bindingId => ['PUT', `/api/v1/plugin/bindings/${enc(bindingId)}/agents`],
  chatPending: () => ['GET', '/api/v1/plugin/chat/pending'],
  chatSent: messageId => ['POST', `/api/v1/plugin/chat/messages/${enc(messageId)}/sent`],
  putThreadStatus: (bindingId, threadId) => ['PUT', `/api/v1/plugin/bindings/${enc(bindingId)}/threads/${enc(threadId)}/status`],
  postReply: (bindingId, threadId) => ['POST', `/api/v1/plugin/bindings/${enc(bindingId)}/threads/${enc(threadId)}/replies`],
};

export class NotifyError extends Error {
  constructor(op, status, code) { super(`notify ${op} failed: ${status}${code ? ` ${code}` : ''}`); this.op = op; this.status = status; this.code = code || null; }
}

// baseUrl: 通知 API の URL。getKey: キーを返す関数（呼ぶたびに secrets から読む・持ち続けない）。fetch: ctx.http.fetch など。
export function createNotifyClient({ baseUrl, getKey, fetch = globalThis.fetch, timeoutMs = 10_000 }) {
  if (!baseUrl) throw new Error('notify url is not configured');
  const base = String(baseUrl).replace(/\/+$/, '');
  async function call(op, args, body) {
    const [method, path] = NOTIFY_API[op](...args);
    const key = await getKey();
    if (!key) throw new NotifyError(op, 0, 'no-key');
    const ac = new AbortController();
    const t = setTimeout(() => ac.abort(), timeoutMs);
    let res;
    try {
      res = await fetch(base + path, { method, signal: ac.signal, headers: { authorization: `Bearer ${key}`, ...(body ? { 'content-type': 'application/json' } : {}) }, body: body ? JSON.stringify(body) : undefined });
    } catch { throw new NotifyError(op, 0, 'unreachable'); } finally { clearTimeout(t); }
    const text = await res.text().catch(() => '');
    let json = null;
    try { json = text ? JSON.parse(text) : null; } catch { json = null; }
    if (!res.ok) throw new NotifyError(op, res.status, typeof json?.code === 'string' ? json.code.slice(0, 60) : null);
    return json;
  }
  return {
    putCard: ({ bindingId, cardId, version, push, card }) => call('putCard', [bindingId, cardId], { version, push: !!push, card }),
    deleteCard: ({ bindingId, cardId }) => call('deleteCard', [bindingId, cardId]),
    pendingActions: async () => { const r = await call('pendingActions', []); return Array.isArray(r?.actions) ? r.actions : []; },
    reportAction: (actionId, result) => call('reportAction', [actionId], result),
    createBindCode: () => call('createBindCode', [], {}),
    bindingState: bindingId => call('bindingState', [bindingId]),
    confirmBinding: (bindingId, accept) => call('confirmBinding', [bindingId], { accept: !!accept }),
    revokeBinding: bindingId => call('revokeBinding', [bindingId]),
    // 話: 担当の一覧（中身が変わった時だけ呼ぶ）・未送の発言・「送った」・話の状態・担当の返事（commentId で 1 回だけ保存される）
    // companyId: 通知 API は結びつけと会社の対応をこれでしか知らない（会社の画面の中身はこれを送った結びつけにだけ出る）
    putAgents: (bindingId, { departments, secretaryId, companyId }) => call('putAgents', [bindingId], { departments, secretaryId: secretaryId ?? null, companyId }),
    chatPending: async () => { const r = await call('chatPending', []); return Array.isArray(r?.messages) ? r.messages : []; },
    chatSent: (messageId, { issueId, commentId }) => call('chatSent', [messageId], { issueId, ...(commentId ? { commentId } : {}) }),
    putThreadStatus: (bindingId, threadId, { status, handedTo }) => call('putThreadStatus', [bindingId, threadId], { status, ...(handedTo ? { handedTo } : {}) }),
    postReply: (bindingId, threadId, { commentId, text, role }) => call('postReply', [bindingId, threadId], { commentId, text, role }),
  };
}
