// 会社ごとの判断の key を出す・確かめる・入れ替える・失効させるために、本体の CLI のログインの口と board API key の口を呼ぶ client。
// key で呼んでよいのは KEY_PATHS の 4 つだけ（ほかの口は作らない・test で止める）。依頼の口（CHALLENGE_PATHS）は key を使わない。
// key・依頼の秘密はログ・例外の文言・戻り値（作った key 以外）に出さない（例外には口の名前と HTTP の状態だけを入れる）。
const enc = encodeURIComponent;
export const CHALLENGE_PATHS = {
  createChallenge: () => ['POST', '/api/cli-auth/challenges'],
  challengeState: (id, token) => ['GET', `/api/cli-auth/challenges/${enc(id)}?token=${enc(token)}`],
};
export const KEY_PATHS = {
  me: () => ['GET', '/api/cli-auth/me'],
  listKeys: () => ['GET', '/api/board-api-keys'],
  createKey: () => ['POST', '/api/board-api-keys'],
  revokeCurrent: () => ['POST', '/api/cli-auth/revoke-current'],
};
export const KEY_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 本体の既定と同じ 30 日（期限なしの key は作らない）

export class HostAuthError extends Error {
  constructor(op, status) { super(`host ${op} failed: ${status}`); this.op = op; this.status = status; }
}

export function createHostAuthClient({ baseUrl, fetch = globalThis.fetch, timeoutMs = 10_000 }) {
  if (!baseUrl) throw new Error('host url is not configured');
  const base = String(baseUrl).replace(/\/+$/, '');
  async function call(op, [method, path], key, body) {
    const ac = new AbortController();
    const t = setTimeout(() => ac.abort(), timeoutMs);
    let res;
    try {
      res = await fetch(base + path, { method, signal: ac.signal, headers: { ...(key ? { authorization: `Bearer ${key}` } : {}), ...(body ? { 'content-type': 'application/json' } : {}) }, body: body ? JSON.stringify(body) : undefined });
    } catch { throw new HostAuthError(op, 0); } finally { clearTimeout(t); }
    if (!res.ok) throw new HostAuthError(op, res.status);
    return res.json().catch(() => null);
  }
  const withKey = (op, key, body) => { if (!key) throw new HostAuthError(op, 0); return call(op, KEY_PATHS[op](), key, body); };
  return {
    // 承認の画面の URL は hostUrl から作る（本体が返す approvalUrl は呼ばれた時の URL で作られるため使わない）
    approvalUrl: path => (typeof path === 'string' && path.startsWith('/') ? base + path : null),
    createChallenge: async ({ clientName, companyId }) => {
      const r = await call('createChallenge', CHALLENGE_PATHS.createChallenge(), null, { command: 'aioffice mobile: company decisions', clientName: String(clientName).slice(0, 120), requestedAccess: 'board', requestedCompanyId: companyId });
      if (!r?.id || !r?.token || !r?.boardApiToken) throw new HostAuthError('createChallenge', 'bad-response');
      return { id: r.id, token: r.token, pendingKey: r.boardApiToken, approvalPath: r.approvalPath || null, expiresAt: r.expiresAt || null };
    },
    challengeState: async (id, token) => (await call('challengeState', CHALLENGE_PATHS.challengeState(id, token)))?.status || 'unknown',
    // key の持ち主（userId）と key の id
    me: async key => { const r = await withKey('me', key); return { userId: r?.userId || null, keyId: r?.keyId || null }; },
    // key の期限（自分の key の一覧から id で探す。見つからなければ null）
    expiresAtOf: async (key, keyId) => { const r = await withKey('listKeys', key); const k = Array.isArray(r) ? r.find(x => x?.id === keyId) : null; return k?.expiresAt ? new Date(k.expiresAt).toISOString() : null; },
    createKey: async (key, { name, expiresAt, companyId }) => {
      const r = await withKey('createKey', key, { name: String(name).slice(0, 120), expiresAt, requestedCompanyId: companyId });
      if (!r?.id || !r?.token) throw new HostAuthError('createKey', 'bad-response');
      return { keyId: r.id, key: r.token, expiresAt: r.expiresAt ? new Date(r.expiresAt).toISOString() : expiresAt };
    },
    revokeCurrent: async key => { await withKey('revokeCurrent', key); return true; },
  };
}
