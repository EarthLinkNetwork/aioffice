// 回覧の DB の読み書き（本体が作る schema の表）。SDK を読まないので unit で試せる（public/test/relay-store.test.mjs）。
// 本体の決まり: ctx.db.query は SELECT だけ・ctx.db.execute は INSERT/UPDATE/DELETE だけ・どちらも 1 文だけ・schema は plugin の namespace だけ
// DB（本体が作る schema の表）。一意の行で、同じ段・回の課題を 2 回作らない（2.1-2）
export function sqlStore(db) {
  const R = `${db.namespace}.requests`, S = `${db.namespace}.steps`;
  const req = r => r && ({ id: r.id, originCompanyId: r.origin_company_id, originIssueId: r.origin_issue_id, originAgentId: r.origin_agent_id, originName: r.origin_name, kind: r.kind, title: r.title, body: r.body, chain: r.chain, step: r.step, round: r.round, state: r.state, result: r.result, reportedStep: r.reported_step, returned: r.returned });
  const stp = s => s && ({ requestId: s.request_id, step: s.step, round: s.round, companyId: s.company_id, userId: s.user_id, issueId: s.issue_id, interactionId: s.interaction_id, state: s.state, answer: s.answer, notified: s.notified, updatedAt: s.updated_at instanceof Date ? s.updated_at.toISOString() : s.updated_at });
  const COLS = { step: 'step', round: 'round', state: 'state', result: 'result', reportedStep: 'reported_step', returned: 'returned', issueId: 'issue_id', interactionId: 'interaction_id', answer: 'answer', notified: 'notified' };
  const JSONB = new Set(['result', 'answer']);
  const sets = patch => {
    const keys = Object.keys(patch).filter(k => Object.hasOwn(COLS, k));
    // 列が 0 だと SET の後ろが空の文になり DB で構文の誤りになる。呼び出しの誤りとして先に投げる
    if (!keys.length) throw new Error('relay store: nothing to update');
    return { sql: keys.map((k, i) => `${COLS[k]} = $${i + 1}${JSONB.has(k) ? '::jsonb' : ''}`).join(', '), vals: keys.map(k => (JSONB.has(k) ? JSON.stringify(patch[k]) : patch[k])) };
  };
  return {
    createRequest: r => db.execute(`INSERT INTO ${R} (id, origin_company_id, origin_issue_id, origin_agent_id, kind, title, body, chain, origin_name) VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb, $9)`, [r.id, r.originCompanyId, r.originIssueId, r.originAgentId, r.kind, r.title, r.body, JSON.stringify(r.chain), r.originName || null]),
    getRequest: async id => req((await db.query(`SELECT * FROM ${R} WHERE id = $1`, [id]))[0]),
    openFor: async (companyId, issueId, title) => (await db.query(`SELECT * FROM ${R} WHERE state = 'open' AND origin_company_id = $1 AND origin_issue_id = $2 AND title = $3 ORDER BY created_at LIMIT 20`, [companyId, issueId, title])).map(req),
    openCountFor: async (companyId, issueId) => Number((await db.query(`SELECT count(*)::int AS n FROM ${R} WHERE state = 'open' AND origin_company_id = $1 AND origin_issue_id = $2`, [companyId, issueId]))[0]?.n || 0),
    openRequests: async () => (await db.query(`SELECT * FROM ${R} WHERE state = 'open' ORDER BY created_at LIMIT 500`)).map(req),
    originRequests: async companyId => (await db.query(`SELECT * FROM ${R} WHERE origin_company_id = $1 AND (state = 'open' OR returned = false) ORDER BY created_at LIMIT 500`, [companyId])).map(req),
    setRequest: (id, patch) => { const { sql, vals } = sets(patch); return db.execute(`UPDATE ${R} SET ${sql}, updated_at = now() WHERE id = $${vals.length + 1}`, [...vals, id]); },
    // 本体の query は SELECT だけ・execute は INSERT/UPDATE/DELETE だけ（RETURNING の行は返らない）。取れたかは rowCount で見て、行を読み直す
    claimStep: async s => {
      const r = await db.execute(`INSERT INTO ${S} (request_id, step, round, company_id, user_id) VALUES ($1, $2, $3, $4, $5) ON CONFLICT (request_id, step, round) DO NOTHING`, [s.requestId, s.step, s.round, s.companyId, s.userId]);
      if (!r || r.rowCount !== 1) return null;
      return stp((await db.query(`SELECT * FROM ${S} WHERE request_id = $1 AND step = $2 AND round = $3`, [s.requestId, s.step, s.round]))[0]);
    },
    getStep: async (id, step, round) => stp((await db.query(`SELECT * FROM ${S} WHERE request_id = $1 AND step = $2 AND round = $3`, [id, step, round]))[0]),
    stepsOf: async (companyId, states) => (await db.query(`SELECT * FROM ${S} WHERE company_id = $1 AND state = ANY(string_to_array($2, ',')) ORDER BY updated_at LIMIT 500`, [companyId, states.join(',')])).map(stp),
    stepsToClose: async companyId => (await db.query(`SELECT s.* FROM ${S} s JOIN ${R} r ON r.id = s.request_id WHERE s.company_id = $1 AND s.notified = false AND r.state <> 'open' AND s.state IN ('open', 'done', 'invalid') LIMIT 500`, [companyId])).map(stp),
    setStep: (id, step, round, patch) => { const { sql, vals } = sets(patch); return db.execute(`UPDATE ${S} SET ${sql}, updated_at = now() WHERE request_id = $${vals.length + 1} AND step = $${vals.length + 2} AND round = $${vals.length + 3}`, [...vals, id, step, round]); },
  };
}

