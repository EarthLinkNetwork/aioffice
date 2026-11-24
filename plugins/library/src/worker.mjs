// 図書室の plugin の worker。範囲: docs/review/2026-11-16-library-notify-scope.md（開発元の記録）の保証 3・4・7・11〜14
// - event は表への 1 行の追記だけ（待ち行列で 1 本ずつ・処理はすぐ返す・実測 22）
// - 会社の物は、起動係が呼ぶ見回りの口（/tick）の中だけで読む。同時に 1 つ・20 秒の枠（1 件ごとに見る）
// 見回りの順: 設定 → 添え書き → event の課題と承認の取り込み → 毎日の照合（id の順に続きから・読み終えたら元の消えた行を消す）
import { gateRoute, fromOwnerOrAssignee } from '../../owner-gate.mjs';
import { definePlugin, runWorker } from '@paperclipai/plugin-sdk';
import { checkTickBody, makeBudget, singleFlight, serialQueue } from '../../notify/src/lib.mjs';
import { semanticEngine, ollamaClient, containerThreads } from './embedder.mjs';
import { EMBED } from './embed.mjs';
import { handleAsk, handleAskGet, takeSecretary, isAskIssue } from './ask.mjs';
import { rowsOf, sourcesOfIssue, decidedApproval, approvalText, checkDoc, docName, words, rank, briefQuery, pickHits, renderBrief, planBrief, pruneLedger, addTry, redactSecrets, isBriefText, LIMITS, BRIEF_STATUSES } from './lib.mjs';

export const EVENT_KINDS = {
  'issue.created': 'issue', 'issue.updated': 'issue', 'issue.comment.created': 'issue',
  'issue.document.created': 'issue', 'issue.document.updated': 'issue', 'issue.document.deleted': 'issue',
  'approval.decided': 'approval',
};
export function eventRow(ev) {
  if (!ev || typeof ev !== 'object') return null;
  const kind = EVENT_KINDS[ev.eventType];
  const companyId = typeof ev.companyId === 'string' ? ev.companyId : '';
  // comment と文書の event は課題の id を payload に持つ。課題を丸ごと読み直す
  const entityId = kind === 'issue' && typeof ev.payload?.issueId === 'string' ? ev.payload.issueId : (typeof ev.entityId === 'string' ? ev.entityId : '');
  if (!kind || !companyId || !entityId) return null;
  const t = Date.parse(ev.occurredAt);
  return { companyId, kind, entityId, occurredAt: new Date(Number.isFinite(t) ? t : Date.now()).toISOString() };
}

const S = (companyId, stateKey) => ({ scopeKind: 'company', scopeId: companyId, stateKey });
const SETTINGS = c => S(c, 'settings'), SCAN = c => S(c, 'scan'), LEDGER = c => S(c, 'brief_ledger'), STATS = c => S(c, 'stats'), RETRY = c => S(c, 'retry');

// plugin の表への読み書き（SQL はここだけ・どれも会社の id で絞る）
export function dbStore(db) {
  const ns = db.namespace, tb = { events: `${ns}.events`, chunks: `${ns}.chunks`, documents: `${ns}.documents`, emb: `${ns}.embeddings`, fail: `${ns}.embed_failures`, gen: `${ns}.generations` };
  // chunks の行を消す SQL はここだけを通す（消すたびに会社の世代を 1 つ進め、意味の検索の記憶を読み直させる・範囲 作り方 13）
  const delChunks = async (companyId, where, params) => { const d = await db.execute(`DELETE FROM ${tb.chunks} WHERE company_id = $1 AND ${where}`, [companyId, ...params]); if (!(Number(d?.rowCount) > 0)) return d; await db.execute(`INSERT INTO ${tb.gen} (company_id, gen) VALUES ($1, 1) ON CONFLICT (company_id) DO UPDATE SET gen = ${tb.gen}.gen + 1`, [companyId]); return d; };
  return {
    delChunks,
    addEvent: r => db.execute(`INSERT INTO ${tb.events} (company_id, kind, entity_id, occurred_at) VALUES ($1, $2, $3, $4)`, [r.companyId, r.kind, r.entityId, r.occurredAt]),
    openEvents: (companyId, limit = 500) => db.query(`SELECT id, kind, entity_id AS "entityId" FROM ${tb.events} WHERE company_id = $1 AND done = false ORDER BY id LIMIT ${Number(limit)}`, [companyId]),
    doneEvents: (companyId, ids) => ids.length ? db.execute(`UPDATE ${tb.events} SET done = true WHERE company_id = $1 AND id = ANY(string_to_array($2, ',')::bigint[])`, [companyId, ids.map(Number).filter(Number.isFinite).join(',')]) : null,
    pruneEvents: companyId => db.execute(`DELETE FROM ${tb.events} WHERE company_id = $1 AND done = true AND occurred_at < now() - make_interval(days => 14)`, [companyId]),
    // 元 1 つ分の行を入れ替える。hash が同じ行は書かない。戻り値は書いた行の数
    putSource: async (companyId, srcId, rows) => {
      const have = new Map((await db.query(`SELECT id, hash FROM ${tb.chunks} WHERE company_id = $1 AND src_id = $2`, [companyId, srcId])).map(r => [r.id, r.hash]));
      let n = 0;
      for (const r of rows) {
        if (have.get(r.id) === r.hash) { have.delete(r.id); continue; }
        have.delete(r.id); n++;
        await db.execute(`INSERT INTO ${tb.chunks} (company_id, id, src_id, issue_id, kind, title, date, text, hash) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
          ON CONFLICT (company_id, id) DO UPDATE SET src_id = EXCLUDED.src_id, issue_id = EXCLUDED.issue_id, kind = EXCLUDED.kind, title = EXCLUDED.title, date = EXCLUDED.date, text = EXCLUDED.text, hash = EXCLUDED.hash, updated_at = now()`,
        [companyId, r.id, r.srcId, r.issueId, r.kind, r.title, String(r.date || ''), r.text, r.hash]);
      }
      if (have.size) await delChunks(companyId, `id = ANY(string_to_array($2, E'\\x1f'))`, [[...have.keys()].join('\x1f')]);
      return n;
    },
    // 課題 1 つ分の元の一覧を入れ替える（消えた comment・文書・カードの行を消す）
    dropIssueExcept: (companyId, issueId, keepSrcIds) => delChunks(companyId, `issue_id = $2 AND NOT (src_id = ANY(string_to_array($3, E'\\x1f')))`, [issueId, keepSrcIds.join('\x1f')]),
    // 照合を読み終えた時: 今ある課題の id にも置いた文書・承認にも当たらない行を消す
    dropMissingIssues: (companyId, liveIssueIds) => delChunks(companyId, `issue_id IS NOT NULL AND NOT (issue_id = ANY(string_to_array($2, ',')))`, [liveIssueIds.join(',')]),
    // 候補: 語のどれかが題か本文に入る行（ILIKE・会社で絞る）。並べ替えは lib の rank
    candidates: (companyId, ws, limit = LIMITS.candidates) => ws.length ? db.query(`SELECT id, src_id AS "srcId", issue_id AS "issueId", kind, title, date, text FROM ${tb.chunks}
      WHERE company_id = $1 AND (title ILIKE ANY(string_to_array($2, E'\\x1f')) OR text ILIKE ANY(string_to_array($2, E'\\x1f'))) ORDER BY updated_at DESC LIMIT ${Number(limit)}`,
    [companyId, ws.map(w => `%${w.replace(/[\\%_]/g, m => `\\${m}`)}%`).join('\x1f')]) : [],
    // 課題の番号がちょうど一致する行（前後が英数字でない所で区切る。CMP-7 で CMP-70 を取らない・独立レビュー 7 回目 P2）
    byIdentifier: (companyId, ident, limit = LIMITS.k) => db.query(`SELECT id, src_id AS "srcId", issue_id AS "issueId", kind, title, date, text FROM ${tb.chunks}
      WHERE company_id = $1 AND (title ~* $2 OR text ~* $2) ORDER BY updated_at DESC LIMIT ${Number(limit)}`,
    [companyId, `(^|[^a-z0-9])${ident.replace(/[^a-z0-9-]/gi, '')}([^0-9]|$)`]),
    counts: async companyId => (await db.query(`SELECT (SELECT count(*)::int FROM ${tb.chunks} WHERE company_id = $1) AS chunks, (SELECT count(*)::int FROM ${tb.documents} WHERE company_id = $1) AS docs, (SELECT coalesce(sum(size), 0)::int FROM ${tb.documents} WHERE company_id = $1) AS bytes`, [companyId]))[0],
    listDocs: companyId => db.query(`SELECT name, size, updated_at AS "updatedAt" FROM ${tb.documents} WHERE company_id = $1 ORDER BY name`, [companyId]),
    docSize: async (companyId, name) => (await db.query(`SELECT size FROM ${tb.documents} WHERE company_id = $1 AND name = $2`, [companyId, name]))[0]?.size ?? null,
    putDoc: (companyId, name, text, size) => db.execute(`INSERT INTO ${tb.documents} (company_id, name, text, size) VALUES ($1, $2, $3, $4) ON CONFLICT (company_id, name) DO UPDATE SET text = EXCLUDED.text, size = EXCLUDED.size, updated_at = now()`, [companyId, name, text, size]),
    removeDoc: async (companyId, name) => { await db.execute(`DELETE FROM ${tb.documents} WHERE company_id = $1 AND name = $2`, [companyId, name]); await delChunks(companyId, 'src_id = $2', [`doc:${name}`]); },
    // ---- 意味の近さの検索（範囲 2026-11-17 作り方 8〜13） ----
    embedCompanies: async () => (await db.query(`SELECT DISTINCT company_id AS "companyId" FROM ${tb.chunks}`)).map(r => r.companyId),
    // まだ埋めていない・中身が変わった・model が変わった行。諦めた行（3 回）と次の時刻の前の行は除く。新しい行から
    embedTodo: (companyId, digest, limit) => db.query(`SELECT c.id, c.hash, c.title, c.text FROM ${tb.chunks} c LEFT JOIN ${tb.emb} e ON e.company_id = c.company_id AND e.chunk_id = c.id LEFT JOIN ${tb.fail} f ON f.company_id = c.company_id AND f.chunk_id = c.id
      WHERE c.company_id = $1 AND (e.chunk_id IS NULL OR e.hash <> c.hash OR e.model_digest <> $2) AND (f.chunk_id IS NULL OR f.hash <> c.hash OR (f.tries < ${EMBED.maxFailures} AND f.next_at <= now())) ORDER BY c.updated_at DESC LIMIT ${Number(limit)}`, [companyId, digest]),
    // seq は減らない値: 会社の最大 + 1 と今の時刻（マイクロ秒）の大きい方。最大の行が消えても同じ値を使い回さない（独立レビュー P2-1）
    putEmbedding: (companyId, chunkId, hash, digest, b64) => db.execute(`INSERT INTO ${tb.emb} (company_id, chunk_id, hash, model_digest, vec, seq) SELECT $1, $2, $3, $4, decode($5, 'base64'), GREATEST(coalesce((SELECT max(seq) FROM ${tb.emb} WHERE company_id = $1), 0) + 1, (extract(epoch FROM clock_timestamp()) * 1000000)::bigint)
      ON CONFLICT (company_id, chunk_id) DO UPDATE SET hash = EXCLUDED.hash, model_digest = EXCLUDED.model_digest, vec = EXCLUDED.vec, seq = EXCLUDED.seq, updated_at = now()`, [companyId, chunkId, hash, digest, b64]),
    failEmbed: (companyId, chunkId, hash) => db.execute(`INSERT INTO ${tb.fail} (company_id, chunk_id, hash, tries, next_at) VALUES ($1, $2, $3, 1, now() + make_interval(mins => 10))
      ON CONFLICT (company_id, chunk_id) DO UPDATE SET tries = CASE WHEN ${tb.fail}.hash = EXCLUDED.hash THEN ${tb.fail}.tries + 1 ELSE 1 END, hash = EXCLUDED.hash, next_at = EXCLUDED.next_at`, [companyId, chunkId, hash]),
    loadEmbeddings: (companyId, digest, afterSeq, limit) => db.query(`SELECT e.chunk_id AS id, encode(e.vec, 'base64') AS vec, e.seq FROM ${tb.emb} e WHERE e.company_id = $1 AND e.model_digest = $2 AND e.seq > $3 ORDER BY e.seq LIMIT ${Number(limit)}`, [companyId, digest, Number(afterSeq) || 0]),
    generation: async companyId => (await db.query(`SELECT gen FROM ${tb.gen} WHERE company_id = $1`, [companyId]))[0]?.gen ?? 0,
    byIds: (companyId, ids) => ids.length ? db.query(`SELECT id, src_id AS "srcId", issue_id AS "issueId", kind, title, date, text FROM ${tb.chunks} WHERE company_id = $1 AND id = ANY(string_to_array($2, E'\\x1f'))`, [companyId, ids.join('\x1f')]) : [],
    // 行が今もあり、埋め込みの hash が今の本文と同じ id（書き直した行の古い意味で当てない・保証 5）
    freshIds: async (companyId, ids, digest) => ids.length ? (await db.query(`SELECT c.id, e.seq FROM ${tb.chunks} c JOIN ${tb.emb} e ON e.company_id = c.company_id AND e.chunk_id = c.id AND e.hash = c.hash AND e.model_digest = $3 WHERE c.company_id = $1 AND c.id = ANY(string_to_array($2, E'\\x1f'))`, [companyId, ids.join('\x1f'), digest])).map(r => ({ id: r.id, seq: Number(r.seq) })) : [],
    // 残り: 今の本文の埋め込みが無く、諦めてもいない行。failed: 今の本文で 3 回断られて諦めた行
    embedBacklog: async (companyId, digest) => (await db.query(`SELECT count(*) FILTER (WHERE e.chunk_id IS NULL AND NOT coalesce(f.hash = c.hash AND f.tries >= ${EMBED.maxFailures}, false))::int AS backlog, count(*) FILTER (WHERE e.chunk_id IS NULL AND f.hash = c.hash AND f.tries >= ${EMBED.maxFailures})::int AS failed
      FROM ${tb.chunks} c LEFT JOIN ${tb.emb} e ON e.company_id = c.company_id AND e.chunk_id = c.id AND e.hash = c.hash AND e.model_digest = $2 LEFT JOIN ${tb.fail} f ON f.company_id = c.company_id AND f.chunk_id = c.id WHERE c.company_id = $1`, [companyId, digest]))[0],
  };
}

// 課題 1 つを読み直して所蔵を入れ替える（comment は event に頭しか来ないので全文を読む・実測 18）
// 並べ方と続きから読む判定を同じ比べ方にする（独立レビュー P3-2）
const RETRY_PER_TICK = 50;
const cmpId = (a, b) => { const x = String(a), y = String(b); return x < y ? -1 : x > y ? 1 : 0; };
export const isSecretaryRound = issue => String(issue?.originKind || '').startsWith('plugin:aioffice.secretary');
export async function ingestIssue(deps, companyId, issueOrId) {
  const issue = typeof issueOrId === 'string' ? await deps.issues.get(issueOrId, companyId) : issueOrId;
  if (!issue || issue.companyId && issue.companyId !== companyId) return 0;
  // 本体の一覧に出ない課題（会話・隠した物・harness の物。本体の visibleIssueCondition と list の conversationAgentId の条件）は取り込まない。
  // event で入っては照合で消えるのを繰り返さず、隠した課題の中身を探す結果と添え書きに出さない（独立レビュー P3-3・2 回目 P3-a）
  // 図書室への問いの課題（資料の写しが本文に入る）は取り込まない（聞くの保証 8・独立レビュー P2-1）
  if (issue.conversationAgentId || issue.hiddenAt || issue.harnessKind || isAskIssue(issue)) { await deps.store.dropIssueExcept(companyId, issue.id, []); return 0; }
  // 秘書の見回りの課題は、本文（出来事の写し）を入れず、持ち主の返事（人のコメント）だけを会社の書架に入れる
  // （持ち主の返事を会社ごとに学ぶ・AI のコメントは入れない保証 11 のまま・docs/review/2026-11-21-secretary-awareness-scope.md 作り方 11）
  if (isSecretaryRound(issue)) {
    // 持ち主（ownerUserIds）か課題の宛先の人の返事だけ（招いた人のコメントは持ち主の返事にしない・設計 2.7）
    const cfg = deps.cfgOf ? await deps.cfgOf(companyId) : {};
    const comments = (await deps.issues.listComments(issue.id, companyId) || []).filter(c => c.authorType === 'user' && c.authorUserId && fromOwnerOrAssignee(cfg, issue, c));
    // 人の返事が無い回は書架に何も置かない（題名だけの行で探す結果を埋めない・再レビュー 2 回目 P3-4）
    const srcs = sourcesOfIssue({ issue: { ...issue, description: '' }, comments, documents: [], interactions: [] }).filter(x => x.kind !== 'issue');
    let n = 0;
    for (const s of srcs) n += await deps.store.putSource(companyId, s.id, rowsOf(s));
    await deps.store.dropIssueExcept(companyId, issue.id, srcs.map(s => s.id));
    return n;
  }
  const [comments, docs, interactions] = await Promise.all([
    deps.issues.listComments(issue.id, companyId),
    deps.issues.documents.list(issue.id, companyId),
    deps.issues.listInteractions(issue.id, companyId),
  ]);
  const documents = [];
  for (const d of docs || []) { if (d.key === 'library-brief') continue; const full = await deps.issues.documents.get(issue.id, d.key, companyId); if (full) documents.push(full); }
  const srcs = sourcesOfIssue({ issue, comments, documents, interactions });
  let n = 0;
  for (const s of srcs) n += await deps.store.putSource(companyId, s.id, rowsOf(s));
  await deps.store.dropIssueExcept(companyId, issue.id, srcs.map(s => s.id));
  return n;
}
async function ingestApproval(deps, companyId, id) {
  const a = await deps.approvals.get(id, companyId);
  if (!decidedApproval(a)) return 0;
  return deps.store.putSource(companyId, `approval:${a.id}`, rowsOf({ id: `approval:${a.id}`, kind: 'approval', title: String(a.payload?.title || a.type || 'approval'), date: a.decidedAt || a.updatedAt, text: approvalText(a) }));
}

// semantic: 意味の近さの候補も使うか（添え書きは語だけ・範囲 作り方 14a）。meta に意味の検索を使えたか（semantic）と使えなかった理由を書く（作り方 11）
export async function searchCompany(deps, companyId, q, { k = LIMITS.k, semantic = true, meta = {} } = {}) {
  const ws = words(q);
  const useSem = semantic && !!deps.semantic;
  meta.semantic = false; meta.reason = useSem ? null : 'off';
  const hasId = /[A-Z]{2,6}-\d/.test(String(q));
  // 語に分けられない短い問い（「ねこ」など）も、意味の検索では問う
  if (!ws.length && !hasId && !useSem) return [];
  const rows = ws.length || hasId ? await deps.store.candidates(companyId, ws.length ? ws : [String(q).trim().toLowerCase()]) : [];
  // 課題の番号は、新しい順の上限で落ちないように番号だけで別に取って足す（保証 13・codex 1 回目 P2-3）
  const ids = [...new Set((String(q).match(/\b[A-Za-z]{2,6}-\d+\b/g) || []).map(x => x.toLowerCase()))].slice(0, 5);
  const seen = new Set(rows.map(r => r.id));
  for (const id of ids) for (const r of await deps.store.byIdentifier(companyId, id, LIMITS.k)) if (!seen.has(r.id)) { seen.add(r.id); rows.push(r); }
  // 意味の近さ（使えない時は null で、語だけの検索のまま）
  const sem = useSem ? await deps.semantic.search(companyId, q) : null;
  if (sem) { meta.semantic = !!sem.hits; meta.reason = sem.reason; }
  const cos = new Map((sem?.hits || []).map(x => [String(x.id), x.cos]));
  const more = [...cos.keys()].filter(id => !seen.has(id));
  if (more.length) for (const r of await deps.store.byIds(companyId, more)) if (!seen.has(r.id)) { seen.add(r.id); rows.push(r); }
  return rank(rows, q, { now: deps.now(), k, cos });
}

export async function handleTick(deps, companyId, body) {
  const r = await deps.flight.run(async () => {
    const budget = makeBudget(deps.now);
    const settings = checkTickBody(body);
    await takeSecretary(deps.state, companyId, body); // 秘書の id（wizard の会社の tick にだけ入る・聞くの作り方 2）
    await deps.state.set(SETTINGS(companyId), settings);
    const out = { v: 1, settings, briefs: 0, ingested: 0, partial: false };
    const stats = (await deps.state.get(STATS(companyId))) || { briefs: 0, lastIngestAt: null };
    // 添え書き（照合より先・1 回 8 件まで）
    const agents = await deps.agents.list({ companyId });
    let ledger = pruneLedger((await deps.state.get(LEDGER(companyId))) || {}, deps.now());
    // 添え書きの候補は開いた状態だけを状態ごとに取る（終わった課題が 500 件を埋めて開いた課題が漏れないように・pre-codex レビュー P3）
    const open = (await Promise.all(BRIEF_STATUSES.map(status => deps.issues.list({ companyId, status, limit: 500 })))).flat();
    for (const issue of planBrief({ issues: open, agents, ledger, now: deps.now() }).picked) {
      if (budget.over()) { out.partial = true; break; }
      const mark = n => { ledger.issues = { ...(ledger.issues || {}), [issue.id]: { at: new Date(deps.now()).toISOString(), n } }; };
      try {
        // 書く前に comment の印を見る（書けたのに誤りで返った時・台帳を残す前に落ちた時も二度書かない・保証 14・独立レビュー P2-2）
        const existing = await deps.issues.listComments(issue.id, companyId);
        if ((existing || []).some(c => isBriefText(c.body))) mark(-1);
        else {
          const q = briefQuery(issue);
          const hits = pickHits(await searchCompany(deps, companyId, q, { k: 12, semantic: false }), { selfId: issue.id });
          await deps.issues.createComment(issue.id, renderBrief({ hits, q, lang: settings.lang }), companyId);
          mark(hits.length); out.briefs++; stats.briefs++;
        }
      } catch { addTry(ledger, issue.id, deps.now()); }
      await deps.state.set(LEDGER(companyId), ledger); // 1 件ごとに残す
    }
    await deps.state.set(LEDGER(companyId), ledger);
    // 読めなかった物の読み直しの一覧（1 件の失敗で見回りを止めず、黙って落とさない・独立レビュー P3-1・2 回目 P2-A）
    // 失敗した課題と承認は一覧に残し、次の見回りで先に読み直す。LIMITS.tries 回読めなければ諦め、その日に諦めた数を状態に出す
    const day = new Date(deps.now()).toISOString().slice(0, 10);
    const retry = (await deps.state.get(RETRY(companyId))) || {};
    if (stats.gaveUpDay !== day) { stats.gaveUpDay = day; stats.gaveUp = 0; }
    const tried = new Map(); // 1 回の見回りで試した物とその結果。二度読まない（読み直し → event → 照合で 3 回を使い切らない・3 回目 P3-1）。照合は結果で ok・bad を分ける（4 回目 P2）
    const read = async (kind, id) => {
      const key = `${kind}:${id}`;
      tried.set(key, false);
      try { out.ingested += kind === 'issue' ? await ingestIssue(deps, companyId, id) : await ingestApproval(deps, companyId, id); delete retry[key]; tried.set(key, true); return true; }
      catch {
        out.failed = (out.failed || 0) + 1;
        const n = (retry[key]?.n || 0) + 1;
        if (n >= LIMITS.tries) { delete retry[key]; stats.gaveUp = (stats.gaveUp || 0) + 1; out.gaveUp = (out.gaveUp || 0) + 1; } else retry[key] = { kind, id: String(id), n };
        return false;
      }
    };
    // 1 回の見回りで読み直すのは RETRY_PER_TICK 件まで（上流が遅い時に新しい event を後回しにしない・3 回目 P3-3）
    let retried = 0;
    const hadRetry = Object.keys(retry).length > 0;
    for (const [key, x] of Object.entries({ ...retry })) {
      if (budget.over()) { out.partial = true; break; }
      if (retried >= RETRY_PER_TICK) break;
      if (retry[key]) { retried++; await read(x.kind, x.id); }
    }
    // event の課題と承認（1 件ごとに枠を見る・同じ課題は 1 回だけ読む・処理した event だけ済みにする。読めなかった物は読み直しの一覧が持つ）
    const evs = await deps.store.openEvents(companyId);
    const seen = new Set(), done = [];
    for (const e of evs) {
      if (budget.over()) { out.partial = true; break; }
      const key = `${e.kind}:${e.entityId}`;
      const rk = `${e.kind === 'issue' ? 'issue' : 'approval'}:${e.entityId}`;
      if (!seen.has(key) && !tried.has(rk)) { seen.add(key); await read(e.kind === 'issue' ? 'issue' : 'approval', e.entityId); }
      done.push(e.id);
    }
    await deps.store.doneEvents(companyId, done);
    // 毎日の照合: その日にまだ読み終えていなければ、id の順に「最後に終えた id」より後から読む（並びの変化に強い）
    const scan = (await deps.state.get(SCAN(companyId))) || {};
    if (scan.doneDay !== day && !budget.over()) {
      // 本体が limit を無視して既定の 500 件で切る版でも行を消し過ぎないよう、500 件以上が返った日は「切れた」と見なす（独立レビュー 6 回目 P2-2）
      const scanMax = deps.scanLimit || 5000, sureMax = Math.min(scanMax, 500);
      const listed = await deps.issues.list({ companyId, limit: scanMax });
      const all = listed.filter(i => i && i.id).sort((a, b) => cmpId(a.id, b.id));
      let last = scan.day === day ? scan.lastId || '' : '';
      let aLast = scan.day === day ? scan.aLast || '' : '';
      let finished = true, ok = scan.day === day ? scan.ok || 0 : 0, bad = scan.day === day ? scan.bad || 0 : 0;
      for (const i of all) {
        if (last && cmpId(i.id, last) <= 0) continue;
        if (budget.over()) { finished = false; out.partial = true; break; }
        // 一覧は本文を頭 1200 字で切って返すので、切れた物は id で読み直す（独立レビュー P2-1・本体の issues.js の descriptionTruncated）
        if (tried.has(`issue:${i.id}`)) { if (tried.get(`issue:${i.id}`)) ok++; else bad++; last = String(i.id); continue; } // この回に試し済み（その回の結果は tried が持つ）
        if (i.descriptionTruncated) { if (await read('issue', String(i.id))) ok++; else bad++; }
        else { try { out.ingested += await ingestIssue(deps, companyId, i); delete retry[`issue:${i.id}`]; ok++; } catch { await read('issue', String(i.id)) ? ok++ : bad++; } }
        last = String(i.id);
      }
      if (finished) {
        // 一覧が上限で切れた時は、載らなかった課題を「消えた」と見なせないので行を消さない（pre-codex レビュー P3）
        if (listed.length < sureMax) await deps.store.dropMissingIssues(companyId, all.map(i => i.id));
        else out.scanCapped = true;
        // 承認も id の順に「最後に終えた承認」より後から読む（枠で切れた次の回に頭から読み直して後半を落とさない・codex 1 回目 P2-1）
        const decided = (await deps.approvals.list({ companyId })).filter(decidedApproval).sort((a, b) => cmpId(a.id, b.id));
        for (const a of decided) {
          if (aLast && cmpId(a.id, aLast) <= 0) continue;
          if (budget.over()) { finished = false; out.partial = true; break; }
          const ak = `approval:${a.id}`;
          if (tried.has(ak)) { if (tried.get(ak)) ok++; else bad++; } else if (await read('approval', a.id)) ok++; else bad++;
          aLast = String(a.id);
        }
      }
      await deps.state.set(SCAN(companyId), finished ? { day, doneDay: day, lastId: '', aLast: '', ok, bad } : { day, doneDay: scan.doneDay || null, lastId: last, aLast, ok, bad });
      // 1 件も読めずに失敗だけがあった照合では「最後に読んだ時刻」を進めない（読めない状態が続けば 30 時間で赤く出る）
      if (finished && (ok > 0 || bad === 0)) stats.lastIngestAt = new Date(deps.now()).toISOString();
      if (finished) await deps.store.pruneEvents(companyId);
      out.scanDone = finished;
    }
    // 読み直しで全部直り、その日の照合が済んでいれば時刻を進める（次の日の照合まで赤い帯を誤って出さない・3 回目 P3-2）
    const scanNow = (await deps.state.get(SCAN(companyId))) || {};
    if (hadRetry && !Object.keys(retry).length && !out.gaveUp && scanNow.doneDay === day) stats.lastIngestAt = new Date(deps.now()).toISOString();
    await deps.state.set(RETRY(companyId), retry);
    stats.retrying = Object.keys(retry).length;
    if (out.ingested && !stats.lastIngestAt) stats.lastIngestAt = new Date(deps.now()).toISOString();
    await deps.state.set(STATS(companyId), stats);
    out.budgetLeftMs = Math.max(0, budget.left());
    // 形の合わない event を捨てた数を返し、起動係ごしに office の「版と合わない」の帯に出す（保証 8・独立レビュー 6 回目 P2-1）
    out.dropped = deps.dropped || 0;
    return out;
  });
  if (r.busy) return { status: 409, body: { error: 'library_busy' } };
  return { status: 200, body: r.value };
}

// 文書を置く・消すは会社ごとに 1 本ずつ流す（数と大きさの確かめから保存までの間に別の要求が入って上限を超えないように・codex 1 回目 P2-2）。
// worker は plugin ごとに 1 つの process なので、process の中の順番で足りる
const docChains = new Map();
const inDocOrder = (companyId, fn) => {
  const prev = docChains.get(companyId) || Promise.resolve();
  const run = prev.then(fn, fn);
  const tail = run.then(() => {}, () => {});
  docChains.set(companyId, tail);
  tail.then(() => { if (docChains.get(companyId) === tail) docChains.delete(companyId); });
  return run;
};
const isJson = h => /^application\/json\b/i.test(String(h?.['content-type'] || h?.['Content-Type'] || ''));
export async function handleRoute(deps, input) {
  const companyId = input.companyId;
  const k = input.routeKey;
  if (k === 'tick') return handleTick(deps, companyId, input.body);
  if (k === 'search') {
    const q = String(input.query?.q || '').slice(0, LIMITS.query);
    const meta = {};
    const results = q.trim() ? await searchCompany(deps, companyId, q, { meta }) : [];
    return { status: 200, body: { v: 1, q, results, semantic: !!meta.semantic, ...(meta.semantic ? {} : { semanticReason: meta.reason || 'empty' }) } };
  }
  if (k === 'status') {
    const [counts, stats, scan, emb] = await Promise.all([deps.store.counts(companyId), deps.state.get(STATS(companyId)), deps.state.get(SCAN(companyId)), deps.semantic ? deps.store.embedBacklog(companyId, EMBED.modelDigest) : null]);
    const semantic = deps.semantic ? { ...deps.semantic.status(), backlog: emb?.backlog ?? 0, failed: emb?.failed ?? 0 } : { ok: false, reason: 'off', since: null, backlog: 0, failed: 0 };
    return { status: 200, body: { v: 1, ...counts, semantic, briefs: stats?.briefs || 0, lastIngestAt: stats?.lastIngestAt || null, lastFailed: (stats?.retrying || 0) + (stats?.gaveUpDay === new Date(deps.now()).toISOString().slice(0, 10) ? stats?.gaveUp || 0 : 0), retrying: stats?.retrying || 0, gaveUp: stats?.gaveUpDay === new Date(deps.now()).toISOString().slice(0, 10) ? stats?.gaveUp || 0 : 0, scanDay: scan?.doneDay || null } };
  }
  if (k === 'documents') return { status: 200, body: { v: 1, documents: await deps.store.listDocs(companyId) } };
  if (k === 'put' || k === 'remove') return inDocOrder(companyId, () => putOrRemove(deps, k, companyId, input));
  if (k === 'ask') return handleAsk(deps, companyId, input, { isJson, search: q => searchCompany(deps, companyId, q) });
  if (k === 'ask-answer') return handleAskGet(deps, companyId, String(input.query?.issueId || ''));
  return { status: 404, body: { error: 'unknown route' } };
}

async function putOrRemove(deps, k, companyId, input) {
  {
    // 本体は Content-Type の無い POST を通すので、ここで JSON だけにする（form の CSRF を断る・保証 12）
    if (!isJson(input.headers)) return { status: 415, body: { error: 'library_json_only' } };
    const name = docName(input.body?.name);
    if (k === 'remove') { if (!name) return { status: 400, body: { error: 'library_bad_name' } }; await deps.store.removeDoc(companyId, name); return { status: 200, body: { v: 1 } }; }
    const c = await deps.store.counts(companyId);
    const old = await deps.store.docSize(companyId, name);
    const chk = checkDoc({ name: input.body?.name, text: input.body?.text }, { count: c.docs - (old == null ? 0 : 1), bytes: c.bytes - (old || 0) });
    if (!chk.ok) return { status: 400, body: { error: `library_doc_${chk.why}` } };
    const text = redactSecrets(input.body.text);
    await deps.store.putDoc(companyId, chk.name, text, chk.size);
    await deps.store.putSource(companyId, `doc:${chk.name}`, rowsOf({ id: `doc:${chk.name}`, kind: 'doc', title: chk.name, date: new Date(deps.now()).toISOString(), text }));
    return { status: 200, body: { v: 1, name: chk.name } };
  }
}

let D = null, C = null;
const plugin = definePlugin({
  async setup(ctx) {
    C = ctx;
    const queue = serialQueue(e => ctx.logger.warn('library: event append failed', { error: String(e?.message || e).slice(0, 200) }));
    D = { store: dbStore(ctx.db), state: ctx.state, issues: ctx.issues, approvals: ctx.approvals, agents: ctx.agents, cfgOf: async c => (await ctx.config.get(c).catch(() => ({}))) || {}, now: () => Date.now(), flight: singleFlight(), queue, dropped: 0, semantic: null, askChain: (c, fn) => inDocOrder(`ask:${c}`, fn) };
    // 意味の近さの検索: image の中の Ollama（127.0.0.1）へ。AIOFFICE_LIBRARY_SEMANTIC=off で止める。Ollama が無い時は state が down のまま語だけで動く
    if (process.env.AIOFFICE_LIBRARY_SEMANTIC !== 'off') {
      const client = ollamaClient({ url: process.env.AIOFFICE_OLLAMA_URL || 'http://127.0.0.1:11434', numThread: containerThreads() });
      D.semantic = semanticEngine({ store: D.store, client, log: (m, x) => ctx.logger.warn(m, x) });
      D.semantic.start();
    }
    for (const name of Object.keys(EVENT_KINDS)) {
      ctx.events.on(name, async ev => {
        const row = eventRow(ev);
        if (!row) { D.dropped++; return; }
        queue.push(() => D.store.addEvent(row));
      });
    }
  },
  async onApiRequest(input) {
    if (!C) return { status: 503, body: { error: 'not ready' } };
    const g = await gateRoute('aioffice.library', input, c => C.config.get(c)); if (g.deny) return g.deny;
    try { return await handleRoute(D, input); }
    catch (e) { return { status: 502, body: { error: 'library_failed', detail: String(e?.message || e).slice(0, 200) } }; }
  },
  async onHealth() { return { status: 'ok' }; },
  async onShutdown() { D?.semantic?.stop(); },
});
export default plugin;
runWorker(plugin, import.meta.url);
