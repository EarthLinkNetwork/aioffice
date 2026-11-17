// 会社ごとの判断（本体の decisions）を、結びついた人ごとの board API key で読む・決める。
// 本体の SDK に decisions の口が無いため（SDK に口ができたらそちらへ移り、key を失効させる）。
// key で呼んでよいのは下の 4 つの口だけ（ほかの口は作らない・test で止める）。dismiss は「どれでもない／解決にする」（docs/design/2026-11-22-app-card-ux.md 2.1）。key はログ・例外・戻り値に出さない。
const enc = encodeURIComponent;
export const DECISION_PATHS = {
  listOpen: companyId => ['GET', `/api/companies/${enc(companyId)}/decisions?status=open&limit=100`],
  decide: decisionId => ['POST', `/api/decisions/${enc(decisionId)}/decide`],
  dismiss: decisionId => ['POST', `/api/decisions/${enc(decisionId)}/dismiss`],
  // 課題の質問（ask_user_questions）に押した本人の名義で答える（回覧の設計 2.1-3・SDK に答えの中身を渡す口が無いため）
  respond: (issueId, interactionId) => ['POST', `/api/issues/${enc(issueId)}/interactions/${enc(interactionId)}/respond`],
};

export class DecisionsError extends Error {
  constructor(op, status) { super(`decisions ${op} failed: ${status}`); this.op = op; this.status = status; }
}

// baseUrl: 本体の URL（plugin から本体を呼ぶ時の URL）。
export function createDecisionsClient({ baseUrl, fetch = globalThis.fetch, timeoutMs = 10_000 }) {
  if (!baseUrl) throw new Error('host url is not configured');
  const base = String(baseUrl).replace(/\/+$/, '');
  async function call(op, args, key, body) {
    if (!key) throw new DecisionsError(op, 0);
    const [method, path] = DECISION_PATHS[op](...args);
    const ac = new AbortController();
    const t = setTimeout(() => ac.abort(), timeoutMs);
    let res;
    try {
      res = await fetch(base + path, { method, signal: ac.signal, headers: { authorization: `Bearer ${key}`, ...(body ? { 'content-type': 'application/json' } : {}) }, body: body ? JSON.stringify(body) : undefined });
    } catch { throw new DecisionsError(op, 0); } finally { clearTimeout(t); }
    if (!res.ok) throw new DecisionsError(op, res.status);
    return res.json().catch(() => null);
  }
  return {
    // status=open の判断（key の持ち主の名義で読む）
    listOpen: async (companyId, key) => {
      const r = await call('listOpen', [companyId], key);
      const list = Array.isArray(r) ? r : Array.isArray(r?.decisions) ? r.decisions : Array.isArray(r?.items) ? r.items : [];
      return list.filter(d => d && d.status === 'open');
    },
    // 押した人の key で決める（idempotencyKey は押された操作の id）
    decide: (decisionId, { optionId, inputValues, idempotencyKey }, key) =>
      call('decide', [decisionId], key, { optionId, ...(inputValues && Object.keys(inputValues).length ? { inputValues } : {}), idempotencyKey }),
    // 選択肢のどれでもなく閉じる（押した人の key・理由つき。本体は効き目の無い選択肢があればそれを選んだ扱いにする）
    dismiss: (decisionId, { reason }, key) => call('dismiss', [decisionId], key, { reason: String(reason || '').slice(0, 2000) || null }),
    // 問い 1 つ・1 つを選ぶ答え（otherText は自由に書く選択肢の文）
    respond: (issueId, interactionId, { questionId, optionId, otherText }, key) =>
      call('respond', [issueId, interactionId], key, { answers: [{ questionId, optionIds: [optionId], ...(otherText ? { otherText: String(otherText).slice(0, 20000) } : {}) }] }),
  };
}
