// AI の使用量の上限で、起動係が受け持つ所（開発元の記録 docs/review/2026-11-18-ai-usage-limit-scope.md の 7 の 1・7 の 2・6 節）。
// - 設定 aiLimits（state.json）の既定と検査（口 POST /setup/api/ai-limits）
// - 見回りで会社ごとに loopback で本体を読み、notify の /tick の body に入れる値を作る:
//   quota（quota-windows の ChatGPT）・quotaRuns（上限の失敗の run）・claudeLimits（run のログの rate_limit_event の決まった欄）・
//   contractGroups（同じ契約の担当）・budgetIncidents・budgetGaps
// - 追加料金の時だけ、走っている run を本体の cancel で取り消す（6 節の単一の書き手の例外）。担当を止めるのは notify だけ
// 判定（止める・知らせる）は notify が受け持つ。ここでは本体の値を決まった形に写すだけ
// 本体の値の本文・token・ログの他の行は渡さない・起動係のログにも書かない

// ---- 設定（7 の 1・G1・G8・9 節の Q4）----
// 既定: 週・5 時間とも知らせる 80%・止める 95%。5 時間の窓の「止める %」は空（追加料金の扱いが never の時は、notify が 5 時間と週の窓とも 95% 以下で止める）
// 追加料金の扱い spend（AI オフィス（起動係）で 1 つ・全部の会社に効く。Q4 の答え 2026-11-18）: never = 1 円も使わない（stop に加えて 5 時間と週の窓も 95% 以下で先に止める）・
// stop = 使い始めたら知らせて止め、走っている run も取り消す・allow = 知らせるだけ（止めず、取り消さない）。既定は never。
// 既定の正はここ（起動係）。notify の defaultAiLimits は値が無い時の倒れる先で、同じ値を持つ（同じことを unit で確かめる）
export const SPEND_MODES = ['never', 'stop', 'allow'];
export function defaultAiLimits() {
  const prov = () => ({ h5: { warnPct: 80, stopPct: null }, week: { warnPct: 80, stopPct: 95 } });
  return { guard: true, spend: 'never', openai: prov(), anthropic: prov() };
}
// 追加料金を使い始めた時に止める・取り消すか（never と stop）。値が無い・形の合わない時は既定
export const spendMode = L => (SPEND_MODES.includes(L?.spend) ? L.spend : defaultAiLimits().spend);
export const stopsOnSpend = L => spendMode(L) !== 'allow';
const isObj = v => !!v && typeof v === 'object' && !Array.isArray(v);
const pctOk = v => Number.isInteger(v) && v >= 1 && v <= 100;

// state.json の値を正しい形にそろえる（形の合わない欄は既定）。見回りと画面で使う
export function normalizeAiLimits(v) {
  const d = defaultAiLimits();
  if (!isObj(v)) return d;
  const out = { guard: typeof v.guard === 'boolean' ? v.guard : true, spend: spendMode(v) };
  for (const p of ['openai', 'anthropic']) {
    const src = isObj(v[p]) ? v[p] : {};
    out[p] = {};
    for (const w of ['h5', 'week']) {
      const o = isObj(src[w]) ? src[w] : {};
      out[p][w] = { warnPct: pctOk(o.warnPct) ? o.warnPct : d[p][w].warnPct, stopPct: o.stopPct === null ? null : pctOk(o.stopPct) ? o.stopPct : d[p][w].stopPct };
    }
  }
  return out;
}

// 口の body を今の値に重ねる。形の合わない値は捨てずに 400（{ error }）。返り値は { value } か { error }
export function mergeAiLimits(cur, body) {
  if (!isObj(body)) return { error: 'ai_limits_bad' };
  const next = normalizeAiLimits(cur);
  for (const k of Object.keys(body)) if (!['guard', 'spend', 'openai', 'anthropic'].includes(k)) return { error: 'ai_limits_bad' };
  if ('guard' in body) { if (typeof body.guard !== 'boolean') return { error: 'ai_limits_bad' }; next.guard = body.guard; }
  if ('spend' in body) { if (!SPEND_MODES.includes(body.spend)) return { error: 'ai_limits_bad' }; next.spend = body.spend; }
  for (const p of ['openai', 'anthropic']) {
    if (!(p in body)) continue;
    const src = body[p];
    if (!isObj(src)) return { error: 'ai_limits_bad' };
    for (const k of Object.keys(src)) if (!['h5', 'week'].includes(k)) return { error: 'ai_limits_bad' };
    for (const w of ['h5', 'week']) {
      if (!(w in src)) continue;
      const o = src[w];
      if (!isObj(o)) return { error: 'ai_limits_bad' };
      if ('warnPct' in o) { if (!pctOk(o.warnPct)) return { error: 'ai_limits_bad' }; next[p][w].warnPct = o.warnPct; }
      if ('stopPct' in o) { if (o.stopPct !== null && !pctOk(o.stopPct)) return { error: 'ai_limits_bad' }; next[p][w].stopPct = o.stopPct; }
      if (next[p][w].stopPct != null && next[p][w].warnPct > next[p][w].stopPct) return { error: 'ai_limits_warn_over_stop' };
    }
  }
  return { value: next };
}

// ---- 同じ契約の担当（7 の 2 の contractGroups・G7b）----
// 担当の env のキー名と CLAUDE_CODE_OAUTH_TOKEN の secret_ref の id だけを見る（値は読まない。空の文字は無いのと同じ）
const envOf = a => (isObj(a?.adapterConfig?.env) ? a.adapterConfig.env : {});
const hasKey = (env, k) => Object.hasOwn(env, k) && env[k] != null && env[k] !== '';
const refOf = v => (isObj(v) && v.type === 'secret_ref' && typeof v.secretId === 'string' && /^[A-Za-z0-9_.:-]{1,120}$/.test(v.secretId) ? v.secretId : null);
// 返す値: groups（[{ contract, provider, agentIds }]）・apiAgents（API キー・Bedrock の担当 [{ agentId, kind }]）
export function contractGroups(agents) {
  const by = new Map(), apiAgents = [];
  const add = (contract, provider, id) => { if (!by.has(contract)) by.set(contract, { contract, provider, agentIds: [] }); by.get(contract).agentIds.push(id); };
  for (const a of Array.isArray(agents) ? agents : []) {
    if (!a || typeof a.id !== 'string' || a.status === 'terminated') continue;
    const env = envOf(a);
    if (a.adapterType === 'claude_local') {
      if (hasKey(env, 'CLAUDE_CODE_USE_BEDROCK') || hasKey(env, 'ANTHROPIC_BEDROCK_BASE_URL')) { apiAgents.push({ agentId: a.id, kind: 'bedrock' }); continue; }
      if (hasKey(env, 'ANTHROPIC_API_KEY')) { apiAgents.push({ agentId: a.id, kind: 'anthropic_api_key' }); continue; }
      // token の秘密ごとに 1 つの契約。参照の無い担当（手で env を変えた・まだつないでいない）はまとめて 1 つ（迷う時は同じ契約として止める・6 節）
      const ref = refOf(env.CLAUDE_CODE_OAUTH_TOKEN);
      add(ref ? `anthropic:${ref}` : 'anthropic:local', 'anthropic', a.id);
    } else if (a.adapterType === 'codex_local') {
      if (hasKey(env, 'OPENAI_API_KEY')) { apiAgents.push({ agentId: a.id, kind: 'openai_api_key' }); continue; }
      add('openai:process', 'openai', a.id); // ChatGPT の資格は本体の process の 1 組（5 節）
    }
  }
  return { groups: [...by.values()], apiAgents };
}

// ---- 予算（G7・G7b）----
export function budgetIncidents(overview) {
  return (Array.isArray(overview?.activeIncidents) ? overview.activeIncidents : []).slice(0, 100).filter(x => isObj(x) && typeof x.id === 'string')
    .map(x => ({ id: x.id, scopeType: x.scopeType ?? null, scopeId: x.scopeId ?? null, scopeName: x.scopeName ?? null, thresholdType: x.thresholdType ?? null, amountLimit: x.amountLimit ?? null, amountObserved: x.amountObserved ?? null }));
}
// API キー・Bedrock の担当のうち、その担当にも会社にも有効な予算が無い物。
// 知らせるだけの予算（hardStopEnabled:false）は止めないので、予算ありに数えない（実装レビュー r1 の L2）
export function budgetGaps(apiAgents, overview) {
  const pol = (Array.isArray(overview?.policies) ? overview.policies : []).filter(p => isObj(p) && p.isActive !== false && p.hardStopEnabled !== false && Number(p.amount) > 0);
  if (pol.some(p => p.scopeType === 'company')) return [];
  const covered = new Set(pol.filter(p => p.scopeType === 'agent').map(p => p.scopeId));
  return (apiAgents || []).filter(a => !covered.has(a.agentId));
}

// ---- quota-windows（ChatGPT）----
// openai の答えだけを、label・usedPercent・resetsAt・valueLabel と source に絞る。error の文は渡さない（本体の command が入る・実測 1）
export function pickQuota(results) {
  const r = (Array.isArray(results) ? results : []).find(x => isObj(x) && x.provider === 'openai');
  if (!r) return null;
  const windows = (Array.isArray(r.windows) ? r.windows : []).slice(0, 20).filter(w => isObj(w) && typeof w.label === 'string')
    .map(w => ({ label: w.label.slice(0, 80), usedPercent: typeof w.usedPercent === 'number' ? w.usedPercent : null, resetsAt: typeof w.resetsAt === 'string' ? w.resetsAt : null, valueLabel: typeof w.valueLabel === 'string' ? w.valueLabel.slice(0, 80) : null }));
  return { provider: 'openai', ok: r.ok === true, source: typeof r.source === 'string' && r.source ? r.source.slice(0, 40) : null, windows };
}
// Credits の残り（notify の creditsDollars・creditsSpend と同じ読み方。同じ source の時だけ比べる・範囲 2.4）
export function creditsReading(quota) {
  if (!quota || quota.ok !== true || !quota.source) return null;
  const w = quota.windows.find(x => /^credits$/i.test(String(x.label).trim()));
  const m = typeof w?.valueLabel === 'string' && w.valueLabel.trim().match(/^\$\s*([0-9][0-9,]*(?:\.[0-9]+)?)\s+remaining$/i);
  const n = m ? Number(m[1].replace(/,/g, '')) : NaN;
  return Number.isFinite(n) ? { source: quota.source, dollars: n } : null;
}
export function creditsSpent(prev, now) {
  if (!now) return { spent: false, base: prev ?? null };
  if (!prev || prev.source !== now.source) return { spent: false, base: now };
  return { spent: now.dollars < prev.dollars - 0.005, base: now };
}

// ---- 上限の失敗の run（7 の 2 の quotaRuns）----
// notify の QUOTA_HIT_RE・QUOTA_ERROR_RE と同じ形（起動係は渡す run を選ぶだけで、判定は notify がやり直す）
const QUOTA_HIT_RE = /(?:you(?:'|’)ve\s+hit\s+your\s+(?:\w+\s+)?limit|(?:session|usage|weekly|5[-\s]?hour|claude\s+usage)\s+(?:limit|cap)\s+(?:reached|exceeded)|out\s+of\s+extra\s+usage|\brate_limit_reached\b|\busage_limit_(?:reached|exceeded)\b)/i;
const QUOTA_ERROR_RE = new RegExp(QUOTA_HIT_RE.source + '|' + /(?:extra\s+usage\b|usage\s+limit|usage\s+cap|model\s+(?:is\s+)?at\s+capacity|at\s+capacity\s+for\s+this\s+model|capacity\s+limit|provider\s+quota|quota\s+(?:limit\s+)?exceeded|servicequotaexceededexception|\brate_limit\b|\busage_limit\b)/i.source, 'i');
export const TERMINAL = new Set(['succeeded', 'failed', 'cancelled', 'timed_out', 'interrupted']);
// 一覧の行の resultJson は要約などの決まった欄だけ（heartbeat.js:2117-2125）
const resultText = run => { const r = isObj(run?.resultJson) ? run.resultJson : {}; return [r.summary, r.result, r.message, r.error].filter(x => typeof x === 'string' && x).join('\n'); };
export function runQuotaText(run) {
  if (run?.status === 'succeeded') return resultText(run);
  return typeof run?.error === 'string' && run.error ? run.error : resultText(run);
}
// 成功で終わった run は、要約そのものが上限の文の時だけ（notify の okRunHit と同じ形・実装レビュー r1 の L4）
const okRunHit = s => { if (s.length > 300) return false; const m = QUOTA_HIT_RE.exec(s); return !!m && m.index <= 80; };
export function isQuotaRun(run) {
  if (!run) return false;
  if (run.errorCode === 'provider_quota') return true;
  const text = runQuotaText(run);
  if (!text) return false;
  return run.status === 'succeeded' ? okRunHit(text) : QUOTA_ERROR_RE.test(text);
}
// notify へ渡す前に、run の error の中の鍵・token の形を伏せる（notify も伏せるが、起動係の側でも伏せる・実装レビュー r1 の L6）。
// 形は notify の KEY_PATTERNS と名前の規則・URL の user:pass@ と同じ（7 桁以上の数字は notify が伏せる）
const RUN_KEY_PATTERNS = [
  /\b(sk-(?:ant-|proj-)?[A-Za-z0-9_-]{16,})/g, /\b(gh[pousr]_[A-Za-z0-9]{20,})/g, /\b(AKIA[0-9A-Z]{16})\b/g,
  /\b(xox[abposr]-[A-Za-z0-9-]{10,})/g, /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z ]*PRIVATE KEY-----|$)/g,
  /\b(pcp_(?:board|bootstrap|invite|cli_auth)_[A-Za-z0-9_-]{16,})/g, /https:\/\/hooks\.slack\.com\/services\/[A-Za-z0-9/]+/g,
  /\bAIza[0-9A-Za-z_-]{30,}/g, /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g, /\b(?:bearer)\s+[A-Za-z0-9._~+/=-]{8,}/gi,
];
const RUN_NAME_RULE = /\b([A-Za-z0-9_.-]*(?:KEY|TOKEN|SECRET|PASSWORD|PASSWD|PRIVATE|PWD)[A-Za-z0-9_.-]*)(\s*[:=]\s*)("(?:[^"\\\n]|\\.)*"?|'(?:[^'\\\n]|\\.)*'?|[^\s"'`,;]+)/gi;
export function redactRunText(text) {
  let s = String(text ?? '');
  for (const re of RUN_KEY_PATTERNS) s = s.replace(re, '[hidden]');
  s = s.replace(RUN_NAME_RULE, (_, n, sep, v) => { const q = v[0] === '"' || v[0] === "'" ? v[0] : ''; return `${n}${sep}${q}[hidden]${q}`; });
  return s.replace(/(\b[a-z][a-z0-9+.-]*:\/\/)([^\s/:@]+):([^\s/@]+)@/gi, '$1$2:[hidden]@');
}
const isoOrNull = v => { if (v == null || v === '') return null; const t = v instanceof Date ? v.getTime() : typeof v === 'number' ? v : Date.parse(v); return Number.isFinite(t) ? new Date(t).toISOString() : null; };
export const retryNotBeforeOf = run => { const r = isObj(run?.resultJson) ? run.resultJson : {}; return isoOrNull(r.retryNotBefore ?? r.transientRetryNotBefore); };

// ---- run のログの rate_limit_event（7 の 2 の手順 1〜5・3.3）----
export const TRUNC_MARK = '[paperclip truncated run log chunk:';
const WORD = /^[a-z][a-z0-9_]{0,31}$/;
const word = v => (v == null ? null : typeof v === 'string' && WORD.test(v) ? v : 'unknown');
const num = v => (typeof v === 'number' && Number.isFinite(v) ? v : null);
// rate_limit_info の決まった欄だけを数値と決まった文字に写す（ほかの欄・本文は捨てる）
export function pickRateLimit(info) {
  if (!isObj(info)) return null;
  const unifiedWindows = {};
  if (isObj(info.unifiedWindows)) {
    for (const [k, w] of Object.entries(info.unifiedWindows).slice(0, 8)) {
      if (!WORD.test(k) || !isObj(w)) continue;
      unifiedWindows[k] = { utilization: num(w.utilization), resetsAt: num(w.resetsAt), status: word(w.status), surpassedThreshold: num(w.surpassedThreshold) };
    }
  }
  return {
    status: word(info.status), resetsAt: num(info.resetsAt), rateLimitType: word(info.rateLimitType), overageStatus: word(info.overageStatus),
    overageDisabledReason: word(info.overageDisabledReason), isUsingOverage: typeof info.isUsingOverage === 'boolean' ? info.isUsingOverage : null,
    utilization: num(info.utilization), surpassedThreshold: num(info.surpassedThreshold), unifiedWindows,
  };
}
const INNER_CARRY_MAX = 64 * 1024; // 内側の半端な行の持ち越しの上限（rate_limit_event の行は数百字。長い行は捨てて次の改行から読み直す）

// 外側の ndjson を読む。pages は改行で終わる完全な行だけの文字（起動係が page を最後の改行で切って渡す）、tail は終わりの半端な行。
// inner は前の回の内側の半端な行（走っている run の続き）。final: run が終わっている（tail と内側の最後の行も読む）。
// 返す値: events（決まった欄に写した rate_limit_event）・truncated（切り詰めの印）・inner（次の回へ持ち越す内側の半端な行）
export function scanLogPages(pages, { tail = '', inner = '', final = false } = {}) {
  const recs = []; let truncated = false, arrival = 0, lastSeq = -Infinity;
  const take = line => {
    if (!line.trim()) return;
    let r; try { r = JSON.parse(line); } catch { return; } // 壊れた record は捨てる
    if (!isObj(r) || r.stream !== 'stdout' || typeof r.chunk !== 'string') return; // stderr・system は混ぜない
    if (r.chunk.includes(TRUNC_MARK)) truncated = true;
    const seq = typeof r.seq === 'number' && Number.isFinite(r.seq) ? r.seq : null;
    if (seq != null) lastSeq = Math.max(lastSeq, seq);
    // seq の無い record は届いた順（直前までの seq の後ろ）に置く
    recs.push({ key: seq ?? lastSeq, n: arrival++, chunk: r.chunk });
  };
  for (const content of pages) for (const line of String(content ?? '').split('\n')) take(line);
  if (final && tail) take(tail);
  recs.sort((a, b) => a.key - b.key || a.n - b.n);
  const lines = ((inner || '') + recs.map(r => r.chunk).join('')).split('\n');
  let rest = lines.pop();
  if (final) { lines.push(rest); rest = ''; }
  const events = [];
  for (const l of lines) {
    const s = l.trim();
    if (!s.startsWith('{') || !s.includes('rate_limit_event')) continue;
    let o; try { o = JSON.parse(s); } catch { continue; } // 壊れた内側の行は捨てる
    if (isObj(o) && o.type === 'rate_limit_event') { const p = pickRateLimit(o.rate_limit_info); if (p) events.push(p); }
  }
  return { events, truncated, inner: rest.length > INNER_CARRY_MAX ? '' : rest };
}

export const LOG_PAGE_BYTES = 1024 * 1024; // 本体の口の上限（agents.js:100-107）
export const LOG_MAX_BYTES = 4 * 1024 * 1024; // 1 本あたりの上限（7 の 2 の手順 4）

// 1 本の run のログを offset から読み、rate_limit_event を抜く。getLog(runId, offset, limitBytes) は本体の口の答え { content, nextOffset }。
// page は最後の改行で切り、次の page はその後ろの byte から読む（byte で切れた半端な行・文字は次の読みに回す）。
// 返す値: { info（最後の rate_limit_event の決まった欄か null）, readError（読めない理由か null）, offset（次に読む byte）, inner }
export async function readRunLimits(getLog, runId, { offset = 0, inner = '', final = true, maxBytes = LOG_MAX_BYTES, pageBytes = LOG_PAGE_BYTES } = {}) {
  const pages = []; let off = offset, read = 0, over = false, eof = false, tail = '';
  try {
    for (;;) {
      if (read >= maxBytes) { over = true; break; }
      const r = await getLog(runId, off, Math.min(pageBytes, maxBytes - read));
      const content = typeof r?.content === 'string' ? r.content : '';
      const more = typeof r?.nextOffset === 'number' && Number.isFinite(r.nextOffset) && r.nextOffset > off;
      const nl = content.lastIndexOf('\n');
      const whole = nl < 0 ? '' : content.slice(0, nl + 1), b = Buffer.byteLength(whole, 'utf8');
      if (whole) pages.push(whole);
      off += b; read += Buffer.byteLength(content, 'utf8');
      if (!more) { eof = true; tail = content.slice(nl + 1); break; }
      if (!b) { over = true; break; } // 1 page に改行が無い（record が大きすぎる）
    }
  } catch (e) {
    return { info: null, readError: e?.status === 404 ? 'no_log' : 'fetch_failed', offset, inner };
  }
  const done = final && eof;
  const sc = scanLogPages(pages, { tail, inner, final: done });
  const info = sc.events.length ? sc.events[sc.events.length - 1] : null;
  let readError = null;
  if (over && !info) readError = 'too_large'; // 上限で読み切れない
  else if (!info && sc.truncated) readError = 'truncated'; // 切り詰めで中ほどが消えた
  else if (!info && done) readError = 'no_event';
  return { info, readError, offset: off, inner: sc.inner };
}

// その run が追加料金で動いているか（ログの rate_limit_event の決まった欄から）
const OVERAGE_ALLOWED = new Set(['allowed', 'allowed_warning']);
export const usingOverage = info => !!info && (info.isUsingOverage === true || (info.status === 'rejected' && OVERAGE_ALLOWED.has(info.overageStatus)));

// ---- 試験用の差し替え口（7 の 2 の最後・8 節）----
// CI だけが付ける env が設定され、かつ呼び手が loopback の時だけ有効。配る image には env を入れない
export const TEST_HOOK_ENV = 'AIOFFICE_CI_TEST_HOOKS';
export const TEST_HOOK_PATH = 'POST /setup/api/test/ai-limits';
// loopback の判定は server.mjs の isLoopback（Slack の口と同じ 1 つ）を使う
const BAD_KEYS = new Set(['__proto__', 'constructor', 'prototype']);
export const testHooksEnabled = (env = process.env) => env[TEST_HOOK_ENV] === '1';
// 差し替えの値: quotaWindows（quota-windows の答え）・heartbeatRuns（会社の run の一覧）・runs（runId → GET /api/heartbeat-runs/:runId の答え）・logs（runId → ログの外側の ndjson の文字）
export function createLimitOverrides() {
  const o = { quotaWindows: null, heartbeatRuns: null, runs: {}, logs: {} };
  return {
    get: () => o,
    set(body) {
      if (body?.clear === true) { o.quotaWindows = null; o.heartbeatRuns = null; o.runs = {}; o.logs = {}; }
      if ('quotaWindows' in (body || {})) o.quotaWindows = Array.isArray(body.quotaWindows) ? body.quotaWindows : null;
      if ('heartbeatRuns' in (body || {})) o.heartbeatRuns = Array.isArray(body.heartbeatRuns) ? body.heartbeatRuns : null;
      // __proto__・constructor などの key は捨てる（Object.assign で prototype を書き換えない・実装レビュー r1 の L6）
      if (isObj(body?.runs)) for (const [k, v] of Object.entries(body.runs)) if (okRunId(k) && !BAD_KEYS.has(k)) o.runs[k] = v;
      if (isObj(body?.logs)) for (const [k, v] of Object.entries(body.logs)) if (typeof v === 'string' && okRunId(k) && !BAD_KEYS.has(k)) o.logs[k] = v;
      return { quotaWindows: !!o.quotaWindows, heartbeatRuns: !!o.heartbeatRuns, runs: Object.keys(o.runs).length, logs: Object.keys(o.logs).length };
    },
  };
}

// ---- 見回りで会社ごとに値を集める（7 の 2）----
export const RUN_LIST_START = 100, RUN_LIST_MAX = 1000;
const FIRST_SINCE_MS = 10 * 60_000; // 初めての回は 10 分前より後に終わった run だけを見る（古い上限の失敗で止めない）
const KEEP_IDS = 300;
const okRunId = v => typeof v === 'string' && /^[A-Za-z0-9_.:-]{1,128}$/.test(v);

// pcUrl: 本体（loopback）。getState/updateState: 起動係の state.json（aiLimits と、会社ごとの見回りの記録 aiLimitsRun）。
// overrides: 試験用の差し替え（createLimitOverrides）。log: 起動係のログ（本体の値の本文は書かない）
export function createLimitsCollector({ pcUrl, getState, updateState, fetchFn = fetch, now = () => Date.now(), overrides = null, log = m => console.log(m) }) {
  const host = new URL(pcUrl).host;
  async function call(method, p, { timeoutMs = 30_000 } = {}) {
    const r = await fetchFn(new URL(p, pcUrl), { method, headers: { 'content-type': 'application/json', host }, ...(method === 'POST' ? { body: '{}' } : {}), signal: AbortSignal.timeout(timeoutMs) });
    let j = null; try { j = await r.json(); } catch { /* 空 */ }
    if (!r.ok) throw Object.assign(new Error(`paperclip ${method} ${p.split('?')[0]} → ${r.status}`), { status: r.status });
    return j;
  }
  const ov = () => overrides?.get?.() || null;
  const getQuota = async companyId => ov()?.quotaWindows ?? call('GET', `/api/companies/${encodeURIComponent(companyId)}/costs/quota-windows`, { timeoutMs: 25_000 });
  const getRuns = async (companyId, limit) => ov()?.heartbeatRuns?.slice(0, limit) ?? call('GET', `/api/companies/${encodeURIComponent(companyId)}/heartbeat-runs?limit=${limit}`);
  const getRun = async runId => ov()?.runs?.[runId] ?? call('GET', `/api/heartbeat-runs/${encodeURIComponent(runId)}`);
  const getLog = async (runId, offset, limitBytes) => {
    const fake = ov()?.logs?.[runId];
    if (typeof fake === 'string') {
      const b = Buffer.from(fake, 'utf8'), end = Math.min(b.length, offset + limitBytes);
      return { content: b.subarray(Math.min(offset, b.length), end).toString('utf8'), ...(end < b.length ? { nextOffset: end } : {}) };
    }
    return call('GET', `/api/heartbeat-runs/${encodeURIComponent(runId)}/log?offset=${offset}&limitBytes=${limitBytes}`);
  };
  const cancelRun = runId => call('POST', `/api/heartbeat-runs/${encodeURIComponent(runId)}/cancel`);

  // run の一覧を前の回の時刻まで読み切る（since が無いので limit を倍にする・r3 の L4）
  async function readRunList(companyId, sinceMs, startLimit) {
    let limit = startLimit, rows = [];
    for (;;) {
      const got = await getRuns(companyId, limit);
      rows = Array.isArray(got) ? got : [];
      if (rows.length < limit) return { rows, complete: true, limit };
      const oldest = rows[rows.length - 1];
      const at = Date.parse(oldest?.finishedAt ?? oldest?.createdAt ?? '');
      if (Number.isFinite(at) && at <= sinceMs) return { rows, complete: true, limit };
      if (limit >= RUN_LIST_MAX) return { rows, complete: false, limit };
      limit = Math.min(limit * 2, RUN_LIST_MAX);
    }
  }

  async function collect(companyId) {
    const s = getState() || {};
    const L = normalizeAiLimits(s.aiLimits), guard = L.guard !== false;
    const prev = isObj(s.aiLimitsRun?.[companyId]) ? s.aiLimitsRun[companyId] : {};
    const startMs = now(), startIso = new Date(startMs).toISOString();
    const sinceMs = Number.isFinite(Date.parse(prev.lastRoundAt)) ? Date.parse(prev.lastRoundAt) : startMs - FIRST_SINCE_MS;
    const rt = {
      lastRoundAt: prev.lastRoundAt ?? null, nextLimit: prev.nextLimit === RUN_LIST_MAX ? RUN_LIST_MAX : RUN_LIST_START,
      running: isObj(prev.running) ? { ...prev.running } : {}, readRunIds: Array.isArray(prev.readRunIds) ? prev.readRunIds.slice(-KEEP_IDS) : [],
      cancelled: Array.isArray(prev.cancelled) ? prev.cancelled.slice(-KEEP_IDS) : [], claudeLast: isObj(prev.claudeLast) ? prev.claudeLast : null,
      creditsBase: isObj(prev.creditsBase) ? prev.creditsBase : null,
      creditsUnsent: Array.isArray(prev.creditsUnsent) ? prev.creditsUnsent.slice(-50) : [],
      creditsSent: [], // この回に notify へ渡し、notify が Credits を比べられる回（Credits の読みがある）の id。commit はこれだけを外す（独立レビュー r2 の P3-1）
    };
    const body = { aiLimits: L };

    // 担当 → 同じ契約の一覧・API キーの担当
    let agents = null;
    try { const a = await call('GET', `/api/companies/${encodeURIComponent(companyId)}/agents`); agents = Array.isArray(a) ? a : null; } catch (e) { log(`aioffice: limits could not list agents: ${e.status || e.message}`); }
    const cg = contractGroups(agents || []);
    if (agents) body.contractGroups = cg.groups;
    const groupOf = new Map(cg.groups.flatMap(g => g.agentIds.map(id => [id, g])));
    const isClaude = id => groupOf.get(id)?.provider === 'anthropic', isCodex = id => groupOf.get(id)?.provider === 'openai';

    // 予算（G7・G7b）
    try {
      const o = await call('GET', `/api/companies/${encodeURIComponent(companyId)}/budgets/overview`);
      body.budgetIncidents = budgetIncidents(o);
      if (agents) body.budgetGaps = budgetGaps(cg.apiAgents, o);
    } catch (e) { log(`aioffice: limits could not read budgets: ${e.status || e.message}`); }

    // ChatGPT の使用率（契約の担当がいる時だけ。読めない回は ok:false で「読めません」に倒す）
    let quota = null;
    if (cg.groups.some(g => g.provider === 'openai')) {
      try { quota = pickQuota(await getQuota(companyId)) || { provider: 'openai', ok: false, source: null, windows: [] }; }
      catch { quota = { provider: 'openai', ok: false, source: null, windows: [] }; }
    }

    // run の一覧（読み切り）と、前の回に running だった run の読み直し（r4 の L2）
    let list = null;
    try { list = await readRunList(companyId, sinceMs, rt.nextLimit); } catch (e) { log(`aioffice: limits could not list runs: ${e.status || e.message}`); }
    const detail = new Map(); // runId → GET /api/heartbeat-runs/:runId の答え（retryNotBefore を読む）
    const finished = new Map(), runningNow = new Map();
    if (list) {
      rt.nextLimit = list.complete ? RUN_LIST_START : RUN_LIST_MAX;
      if (!list.complete) log('aioffice: limits could not read the whole run list');
      for (const r of list.rows) {
        if (!r || !okRunId(r.id)) continue;
        if (r.status === 'running') runningNow.set(r.id, r);
        else if (TERMINAL.has(r.status) && Date.parse(r.finishedAt) > sinceMs) finished.set(r.id, r);
      }
      for (const [id, rec] of Object.entries(rt.running)) {
        if (finished.has(id) || runningNow.has(id)) continue;
        try {
          const r = await getRun(id); detail.set(id, r);
          if (r && TERMINAL.has(r.status)) finished.set(id, { ...r, agentId: r.agentId ?? rec.agentId });
          else if (r && r.status === 'running') runningNow.set(id, { ...r, agentId: r.agentId ?? rec.agentId });
          else delete rt.running[id];
        } catch (e) { if (e.status === 404) delete rt.running[id]; }
      }
    }

    // 上限の失敗の run と、Claude のログを読む run
    const quotaRuns = [];
    const claudeCands = []; // { run, info, readError }
    const readLog = async (run, final) => {
      const keep = rt.running[run.id] || {};
      const r = await readRunLimits(getLog, run.id, { offset: keep.offset || 0, inner: keep.inner || '', final });
      if (final) { delete rt.running[run.id]; rt.readRunIds.push(run.id); }
      else rt.running[run.id] = { agentId: run.agentId, offset: r.offset, inner: r.inner, info: r.info ?? keep.info ?? null, startedAt: run.startedAt ?? keep.startedAt ?? null };
      return { info: r.info ?? keep.info ?? null, readError: r.readError };
    };
    // 読む run は、始まって最後まで走った Claude の run から選ぶ。始まらなかった run・取り消された run を選ぶと、同じ回に終わった
    // 普通の run のログを読まずに次の回で一覧から外れ、その使用率が二度と読まれない（PR #122 の独立レビュー P1）
    const latestClaude = [...finished.values()].filter(r => isClaude(r.agentId) && r.startedAt && r.status !== 'cancelled').sort((a, b) => Date.parse(b.finishedAt) - Date.parse(a.finishedAt))[0] || null;
    for (const run of finished.values()) {
      const quotaHit = isQuotaRun(run);
      let lg = null;
      const wantLog = isClaude(run.agentId) && !rt.readRunIds.includes(run.id) && (quotaHit || run === latestClaude || rt.running[run.id]);
      if (wantLog) { lg = await readLog(run, true); claudeCands.push({ run, ...lg }); }
      else if (rt.running[run.id]) delete rt.running[run.id];
      const logRejected = lg?.info?.status === 'rejected';
      if (!quotaHit && !logRejected) continue;
      let rnb = retryNotBeforeOf(detail.get(run.id) || run);
      if (quotaHit && !rnb && !detail.has(run.id)) { try { const d = await getRun(run.id); detail.set(run.id, d); rnb = retryNotBeforeOf(d); } catch { /* 無ければ文と resetsAt で決める */ } }
      quotaRuns.push({
        runId: run.id, agentId: run.agentId, status: run.status ?? null, errorCode: run.errorCode ?? null, error: redactRunText(runQuotaText(run)).slice(0, 500) || null,
        retryNotBefore: rnb, finishedAt: isoOrNull(run.finishedAt),
        ...(lg?.info ? { logStatus: lg.info.status, logOverageStatus: lg.info.overageStatus, logResetsAt: lg.info.resetsAt } : {}),
      });
    }
    if (list) body.quotaRuns = { runs: quotaRuns.slice(0, 1000), complete: list.complete };

    // 走っている run: Claude はログの始まりの rate_limit_event を読み続ける（追加料金を見るため・r4 の M2）。それ以外は id だけ持つ
    const runningClaude = [];
    for (const run of runningNow.values()) {
      if (isClaude(run.agentId)) {
        const lg = await readLog(run, false);
        if (lg.info) runningClaude.push({ run, info: lg.info });
        else if (lg.readError && lg.readError !== 'no_event') claudeCands.push({ run, info: null, readError: lg.readError });
      } else if (!rt.running[run.id]) rt.running[run.id] = { agentId: run.agentId, offset: 0, inner: '', info: null, startedAt: run.startedAt ?? null };
    }
    // 持ち続ける running の run は古い方から 200 本まで（読み直しの時間を見回りの枠に収める）
    const ids = Object.keys(rt.running);
    for (const id of ids.slice(0, Math.max(0, ids.length - 200))) delete rt.running[id];

    // 追加料金の時の取り消し（6 節の例外・追加料金の扱いが never・stop の時だけ）
    const cancel = async ids => {
      const out = [];
      for (const id of ids) {
        if (rt.cancelled.includes(id)) { out.push(id); continue; }
        try { await cancelRun(id); rt.cancelled.push(id); out.push(id); log(`aioffice: cancelled run ${id} on extra usage`); }
        catch (e) { log(`aioffice: could not cancel run ${id}: ${e.status || e.message}`); }
      }
      return out;
    };
    // 追加料金で走っている run: isUsingOverage:true に加え、窓は rejected で overageStatus が allowed 系の形（notify の overageState の using と同じ・実装レビュー r1 の L3）
    const overageRuns = runningClaude.filter(x => usingOverage(x.info));
    let claudeCancelled = [];
    if (guard && stopsOnSpend(L) && overageRuns.length) claudeCancelled = await cancel(overageRuns.map(x => x.run.id));

    // Credits の減り（同じ source の時だけ比べる）。減った回に同じ契約の走っている codex の run を取り消す
    if (quota) {
      const cs = creditsSpent(rt.creditsBase, creditsReading(quota));
      rt.creditsBase = cs.base;
      const now = cs.spent && guard && stopsOnSpend(L) ? await cancel([...runningNow.values()].filter(r => isCodex(r.agentId)).map(r => r.id)) : [];
      // 取り消した id は、notify が上限の処理を読み終えた回（commit）まで毎回載せる。取り消した回の /tick が上限の処理を飛ばす・失敗すると、
      // notify は次の回で減りを見て知らせを作るが、その回の起動係は減りを見ないので、id を 1 回だけ載せる形では知らせから消えていた（2026-11-21 arm64 の e2e の 12・独立レビュー）
      rt.creditsUnsent = [...new Set([...rt.creditsUnsent, ...now])].slice(-50);
      quota.cancelledRunIds = [...rt.creditsUnsent];
      rt.creditsSent = creditsReading(quota) ? [...rt.creditsUnsent] : [];
      body.quota = quota;
    }

    // claudeLimits: 追加料金で走っている run を先に、無ければ今回読めた中で始まりが最も新しい run。読めなかった時は最後に読めた値に readError を付ける
    const fields = (run, info) => ({ ...info, observedAt: isoOrNull(run.startedAt) ?? isoOrNull(run.createdAt), runId: run.id, contract: groupOf.get(run.agentId)?.contract ?? null });
    const good = [...runningClaude.map(x => ({ run: x.run, info: x.info })), ...claudeCands.filter(x => x.info)];
    good.sort((a, b) => (Date.parse(b.run.startedAt) || 0) - (Date.parse(a.run.startedAt) || 0));
    // 追加料金で動いた run が見回りの間に終わり、後に始まった普通の run が走っていても、追加料金の run を先に選ぶ（L3）
    const pick = overageRuns[0] || good.find(x => usingOverage(x.info)) || good[0] || null;
    // 一度も始まらなかった run・取り消された run は Claude を呼ぶ前に終わることがあり、ログに行が無くても形が変わった印にならない。
    // これを「読めない」にすると、同じ回に読めた値を隠して知らせと止めが出なくなる（2026-11-22 amd64 の e2e の 3 番で 0 件・止まらない）
    // 始まらなかった run は理由（no_event・no_log など）によらず外す（開始時刻が無いと下の比べで必ず勝ってしまう・レビュー P2）
    const noSignal = x => !x.run.startedAt || (x.readError === 'no_event' && x.run.status === 'cancelled');
    const failed = claudeCands.find(x => !x.info && x.readError && !noSignal(x) && (x.run === latestClaude || isQuotaRun(x.run)));
    if (pick) rt.claudeLast = fields(pick.run, pick.info);
    if (pick && (!failed || Date.parse(pick.run.startedAt) >= Date.parse(failed.run.startedAt))) body.claudeLimits = { ...rt.claudeLast, cancelledRunIds: claudeCancelled };
    else if (failed) body.claudeLimits = { ...(rt.claudeLast || { contract: groupOf.get(failed.run.agentId)?.contract ?? null }), readError: failed.readError, cancelledRunIds: claudeCancelled };
    else if (rt.claudeLast && cg.groups.some(g => g.provider === 'anthropic')) body.claudeLimits = { ...rt.claudeLast, cancelledRunIds: [] }; // 新しい run が無い回は最後に読めた値（G2a）

    // 読んだ時刻は、notify の /tick が受け取れた時だけ進める（commit）。一覧が読めなかった回と、/tick が失敗した回は前の時刻を残し、次の回で同じ範囲を読み直す
    // （event が落ち、同じ回の /tick も失敗すると、その回の quotaRuns が失われていた・e2e を書いた時に見つけた）
    rt.pendingRoundAt = list ? startIso : null;
    rt.readRunIds = rt.readRunIds.slice(-KEEP_IDS); rt.cancelled = rt.cancelled.slice(-KEEP_IDS);
    updateState(x => { x.aiLimitsRun = { ...(isObj(x.aiLimitsRun) ? x.aiLimitsRun : {}), [companyId]: rt }; });
    return body;
  }
  // notify の /tick が成功した会社だけ、collect で読んだ時刻を lastRoundAt に進める
  function commit(companyId) {
    updateState(x => {
      const all = isObj(x.aiLimitsRun) ? x.aiLimitsRun : {};
      const rt = all[companyId];
      if (!isObj(rt)) return;
      // notify が上限の処理を読み終え、Credits を比べられた回に渡した id は届いたので、一覧が読めなかった回（pendingRoundAt なし）でも外す
      const done = new Set(Array.isArray(rt.creditsSent) ? rt.creditsSent : []);
      const sent = { ...rt, creditsUnsent: (Array.isArray(rt.creditsUnsent) ? rt.creditsUnsent : []).filter(id => !done.has(id)), creditsSent: [] };
      x.aiLimitsRun = { ...all, [companyId]: rt.pendingRoundAt ? { ...sent, lastRoundAt: rt.pendingRoundAt, pendingRoundAt: null } : sent };
    });
  }
  return { collect, commit, getLog, readRunList };
}
