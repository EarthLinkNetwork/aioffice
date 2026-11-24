// 知らせの plugin の、本体に触らない部分（unit で確かめる）
import { createHash } from 'node:crypto';

// AI の使用量の上限の知らせの種類（範囲: docs/review/2026-11-18-ai-usage-limit-scope.md（開発元の記録）の 7 の 3）
// agent_resumed_limit は自動で戻した知らせ（G6。第 2 段で足した）
export const LIMIT_KINDS = ['agent_paused_limit', 'ai_limit_near', 'ai_credits_spent', 'ai_overage_started', 'ai_quota_unreadable', 'budget_unset', 'agent_resumed_limit'];
export const KINDS = ['approval', 'decision', 'run_failed', 'run_failing', 'stuck', 'stale_routine', 'digest', 'slack_failed', 'slack_resaved', ...LIMIT_KINDS];
export const EVENT_KINDS = {
  'approval.created': 'approval',
  'approval.decided': 'approval',
  'agent.run.failed': 'run_failed',
  'agent.run.finished': 'run_finished',
  'issue.created': 'issue',
  'issue.updated': 'issue',
  'issue.comment.created': 'issue',
  // 本体の予算の incident（G7・範囲 7 の 8）。entityId は incident の id
  'budget.incident.opened': 'budget_opened',
  'budget.incident.resolved': 'budget_resolved',
};
export const TICK_BUDGET_MS = 20000; // 本体は 30 秒で口を切り、その後は会社の物を読めない（実測 21）
export const LANGS = ['en', 'ja'];

// 知らせの key は「種類＋元の id」の hash（同じ物を二度出さない・保証 18）
export function noticeKey(kind, originId) {
  return createHash('sha256').update(String(kind) + '\u0000' + String(originId)).digest('hex').slice(0, 32);
}

// 起動係が見回りの口に渡す値。知らない言語は英語、正しくない時刻帯は無し（worker は UTC にする・保証 9）
export function validTimeZone(tz) {
  if (typeof tz !== 'string' || !tz || tz.length > 64) return null;
  try { new Intl.DateTimeFormat('en', { timeZone: tz }); return tz; } catch { return null; }
}
// 上限の値（aiLimits・quota など）は、形の合う物だけを返す。無い欄・形の合わない欄は返さない（捨てる・範囲 7 の 2）
export function checkTickBody(body) {
  const b = body && typeof body === 'object' ? body : {};
  const out = { lang: LANGS.includes(b.lang) ? b.lang : 'en', timeZone: validTimeZone(b.timeZone) };
  const put = (k, v) => { if (v != null) out[k] = v; };
  put('aiLimits', checkAiLimits(b.aiLimits));
  put('quota', checkQuota(b.quota));
  put('quotaRuns', checkQuotaRuns(b.quotaRuns));
  put('claudeLimits', checkClaudeLimits(b.claudeLimits));
  put('contractGroups', checkContractGroups(b.contractGroups));
  put('budgetIncidents', checkBudgetIncidents(b.budgetIncidents));
  put('budgetGaps', checkBudgetGaps(b.budgetGaps));
  return out;
}

// event の形を受けた所で確かめる。合わない物は null（捨てて数える・保証 8）
export function eventRow(ev) {
  if (!ev || typeof ev !== 'object') return null;
  const kind = EVENT_KINDS[ev.eventType];
  const companyId = typeof ev.companyId === 'string' ? ev.companyId : '';
  const entityId = typeof ev.entityId === 'string' ? ev.entityId : '';
  if (!kind || !companyId || !entityId) return null;
  const t = Date.parse(ev.occurredAt);
  const agentId = typeof ev.payload?.agentId === 'string' ? ev.payload.agentId : null;
  const row = { companyId, kind, entityId, agentId, occurredAt: new Date(Number.isFinite(t) ? t : Date.now()).toISOString() };
  // 担当の実行の event は errorCode と error の先頭 500 文字を持つ（上限の失敗の判定・範囲 7 の 5）。文は伏せてから切る
  if (kind === 'run_failed' || kind === 'run_finished') {
    const code = ev.payload?.errorCode;
    row.errorCode = typeof code === 'string' && code ? code.slice(0, 64) : null;
    row.errorSnippet = typeof ev.payload?.error === 'string' && ev.payload.error ? safeTitle(ev.payload.error, ERROR_SNIPPET_MAX) : null;
  }
  return row;
}

// 1 回の口の時間の枠（時計は引数で渡す）
export function makeBudget(now, limitMs = TICK_BUDGET_MS) {
  const start = now();
  return { start, left: () => limitMs - (now() - start), over: () => now() - start >= limitMs };
}

// 同時に 1 つだけ動かす。動いている間は { busy: true }（口は 409 で返す・保証 7）
export function singleFlight() {
  let running = false;
  return {
    get running() { return running; },
    async run(fn) {
      if (running) return { busy: true };
      running = true;
      try { return { busy: false, value: await fn() }; } finally { running = false; }
    },
  };
}

// 1 本の鍵: run(fn) を届いた順に 1 つずつ流し、fn の結果（か例外）をそのまま返す。
// 担当を止める処理（上限の失敗の event と見回りの上限の処理）を順番に流し、読んでから書くまでの間に別の処理が割り込まない（上限の範囲の実装レビュー r1 の H1）
export function mutex() {
  let tail = Promise.resolve();
  return {
    run(fn) {
      const p = tail.then(() => fn());
      tail = p.then(() => {}, () => {});
      return p;
    },
  };
}

// key ごとの鍵（promise の鎖）。同じ key の fn は前の fn が終わってから 1 つずつ動く。前の失敗は次を止めない。
// 中で同じ鍵を取り直すと待ち続けるので、鍵の中では鍵を取らない関数だけを呼ぶ
export function keyedChain() {
  const tails = new Map();
  return (key, fn) => {
    const p = (tails.get(key) || Promise.resolve()).then(() => fn());
    const tail = p.catch(() => {});
    tails.set(key, tail);
    tail.then(() => { if (tails.get(key) === tail) tails.delete(key); });
    return p;
  };
}

// 1 本ずつ流す待ち行列。失敗は onError に渡して次へ進む（event の追記は後から書ける・実測 22）
export function serialQueue(onError = () => {}) {
  let tail = Promise.resolve();
  let size = 0;
  return {
    get size() { return size; },
    push(fn) {
      size++;
      const p = tail.then(fn).catch(onError).finally(() => { size--; });
      tail = p;
      return p;
    },
    idle() { return tail; },
  };
}

// 承認待ちの突き合わせ（保証 17）: 本体の待っている一覧にあって知らせに無い物は足し、一覧に無い物は消す
export function reconcileApprovals(pending, notices) {
  const want = new Map(pending.map(a => [noticeKey('approval', a.id), a]));
  const have = new Set(notices.filter(n => n.kind === 'approval').map(n => n.key));
  const add = [...want].filter(([k]) => !have.has(k)).map(([key, a]) => ({ key, kind: 'approval', originId: a.id, title: safeTitle(a.title || a.payload?.title || a.type || 'Approval', 200) }));
  const remove = [...have].filter(k => !want.has(k));
  return { add, remove };
}

// ---- 見回りの中身（保証 17・19）----
export const OPEN_STATUSES = ['todo', 'in_progress', 'in_review', 'blocked'];
const CLOSED_CHILD = new Set(['done', 'cancelled']);
const ms = v => { const t = typeof v === 'number' ? v : Date.parse(v); return Number.isFinite(t) ? t : 0; };

// 判断待ちを読む課題: 開いた課題を id の順に並べ、続きの位置（cursor の id より後）から max 件。
// last=true はこの頁で最後まで読んだ（周の終わり）。1 回 50 件で区切り、続きは次の回（保証 7・17）
export function decisionPage(issues, cursor = null, max = 50) {
  const open = issues.filter(i => OPEN_STATUSES.includes(i.status)).sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  const rest = cursor ? open.filter(i => i.id > cursor) : open;
  return { page: rest.slice(0, max), last: rest.length <= max };
}
// 答えの無い判断のカード（status が pending の物）
export const unanswered = interactions => (interactions || []).filter(x => x && x.status === 'pending');

// 止まった課題（stuck-issues-lib.mjs の selectStuck から起こす所を除いた形）
// in_progress のまま idleMin 分動きが無い物。実行中・担当なし・担当が paused か terminated・閉じていない子を待つ親は除く。
// 定時の回（originKind が routine_execution）は 1440 分を過ぎたら「古い定時の回」として出す
export function selectStuck(issues, { nowMs, idleMin = 60, agentStatus = new Map() }) {
  const waiting = new Set(issues.filter(i => i.parentId && !CLOSED_CHILD.has(i.status)).map(i => i.parentId));
  const out = [];
  for (const i of issues) {
    if (i.status !== 'in_progress' || !i.assigneeAgentId || i.executionRunId) continue;
    // 秘書の見回りは秘書の plugin が 2 時間で閉じる（docs/review/2026-11-21-secretary-awareness-scope.md 作り方 11）
    // 外すのは見回りの課題だけ。提案 1 つずつの子の課題（…:proposal）は秘書の plugin が閉じないので、止まれば知らせる
    if (String(i.originKind || '') === 'plugin:aioffice.secretary:round') continue;
    const st = agentStatus.get(i.assigneeAgentId);
    if (st === 'paused' || st === 'terminated') continue;
    if (waiting.has(i.id)) continue;
    const idle = Math.floor((nowMs - ms(i.updatedAt)) / 60000);
    const routine = i.originKind === 'routine_execution';
    if (routine ? idle < 1440 : idle < idleMin) continue;
    out.push({ issueId: i.id, identifier: i.identifier ?? null, title: safeTitle(i.title || '', 200), kind: routine ? 'stale_routine' : 'stuck', idleMin: idle });
  }
  return out;
}

// 同じ担当の続けての失敗の数（担当ごと）。event を古い順に当て、失敗で 1 足し、その担当の成功で 0 に戻す。
// 数は会社の state に持つので、ほかの担当の実行の多さや、片付けで消えた event では戻らない（codex P2-4）
export function stepStreaks(streaks, events) {
  const out = { ...(streaks || {}) };
  for (const e of events) {
    if (!e.agentId) continue;
    if (e.kind === 'run_failed') out[e.agentId] = (out[e.agentId] || 0) + 1;
    else if (e.kind === 'run_finished') delete out[e.agentId];
  }
  return out;
}
export const failingAgents = (streaks, n = 3) => Object.entries(streaks || {}).filter(([, k]) => k >= n).map(([id]) => id);

// 種類ごとの突き合わせ: want にあって知らせに無い物は足し、want に無い物は消す
export function reconcileKind(kinds, want, notices) {
  const ks = new Set([].concat(kinds));
  const w = new Map(want.map(n => [n.key, n]));
  const have = new Set(notices.filter(n => ks.has(n.kind)).map(n => n.key));
  return { add: [...w.values()].filter(n => !have.has(n.key)), remove: [...have].filter(k => !w.has(k)) };
}

// 朝夕のまとめの回: 持ち主の時刻帯で 8 時と 18 時。その回の時刻を過ぎて最初の見回りで 1 通（key は日付と朝・夕）
export function localParts(nowMs, timeZone) {
  const f = new Intl.DateTimeFormat('en-CA', { timeZone: timeZone || 'UTC', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', hourCycle: 'h23' });
  const p = Object.fromEntries(f.formatToParts(new Date(nowMs)).map(x => [x.type, x.value]));
  return { date: `${p.year}-${p.month}-${p.day}`, hour: Number(p.hour) };
}
export function digestSlot(nowMs, timeZone) {
  const { date, hour } = localParts(nowMs, timeZone);
  if (hour >= 18) return { key: `${date}:pm`, slot: 'pm' };
  if (hour >= 8) return { key: `${date}:am`, slot: 'am' };
  return null;
}

// 文字は英日の辞書から（保証 9）
export const DICT = {
  en: { am: 'Morning summary', pm: 'Evening summary', none: 'nothing is waiting', approval: 'approvals', decision: 'decisions', run_failed: 'failed runs', stuck: 'stuck tasks', unread: 'unread notices', utc: '(running on UTC)', failing: 'Runs keep failing', failed: 'Run failed', stuck_t: 'Stuck', stale: 'Old scheduled run', decision_t: 'Decision waiting',
    paused_t: 'Paused at the AI usage limit', near_t: 'Close to the AI usage limit', credits_t: 'Started using extra credits', overage_t: 'Started using Claude extra usage', unreadable_t: 'Cannot read AI usage', budget_t: 'No budget set for API key agents',
    resumed_t: 'Resumed after the AI usage limit', resume_manual: 'resume by hand', until: 'until', runs_unread: 'could not read the whole run list', claude_unreadable: 'Cannot read Claude usage; agents will be paused when the limit is hit', openai_unreadable: 'Cannot read ChatGPT usage', credits_unreadable: 'Cannot read the remaining extra credits', overage_enabled: 'Work continues on extra usage after the limit',
    paused: 'paused agents', budget_stop_t: 'Stopped by the budget', budget_gaps: 'Billed with no limit. Set a budget on the budgets page',
    r_pct: 'Usage reached the stop level', r_provider_quota: 'Hit the plan limit', r_overage: 'Started using extra usage', r_credits: 'Started spending extra credits', w_h5: '5-hour', w_week: 'weekly' },
  ja: { am: '朝のまとめ', pm: '夕方のまとめ', none: '待っている物はありません', approval: '承認待ち', decision: '判断待ち', run_failed: '失敗', stuck: '止まった課題', unread: '未読の知らせ', utc: '（UTC で動いています）', failing: '失敗が続いています', failed: '実行の失敗', stuck_t: '止まっています', stale: '古い定時の回', decision_t: '判断待ち',
    paused_t: 'AI の上限で止めています', near_t: 'AI の上限に近づいています', credits_t: '追加料金を使い始めました', overage_t: 'Claude の追加料金を使い始めました', unreadable_t: 'AI の使用率を読めません', budget_t: 'API キーで動く担当に予算が未設定です',
    resumed_t: 'AI の上限から再開しました', resume_manual: '人の「再開」まで', until: 'まで', runs_unread: 'run の一覧を読み切れませんでした', claude_unreadable: 'Claude の使用率を読めません・上限に当たったら止めます', openai_unreadable: 'ChatGPT の使用率を読めません', credits_unreadable: '追加料金の残りを読めません', overage_enabled: '上限の後は追加料金で続く設定です',
    paused: '止めている担当', budget_stop_t: '予算で止まりました', budget_gaps: '上限なしで課金されます。予算の画面で決めてください',
    r_pct: '使用率が止める % に達しました', r_provider_quota: '契約の上限に当たりました', r_overage: '追加料金を使い始めました', r_credits: '追加料金の残りが減りました', w_h5: '5 時間', w_week: '週' },
};
// Slack に送る文（範囲 docs/review/2026-11-18-slack-notify-scope.md S5・S7）。{n} は件数
Object.assign(DICT.en, {
  slack_digest_am: 'Morning summary', slack_digest_pm: 'Evening summary', slack_waiting: '{n} waiting', slack_none: 'nothing is waiting',
  slack_more: 'and {n} more', slack_open: 'Open AI Office',
  slack_head_approval: 'Approval waiting', slack_head_decision: 'Decision waiting', slack_head_run_failing: 'Runs keep failing', slack_head_stuck: 'Stuck task', slack_head_stale_routine: 'Old scheduled run',
  slack_overflow: 'There are {n} more notices (see them in the office)', slack_overflow_head: 'More notices',
  slack_test: 'A test message from AI Office',
  slack_ex_approval: 'Example: publish the new price list', slack_ex_decision: 'Example: which logo to use', slack_ex_run_failing: 'Example: Secretary', slack_ex_stuck: 'Example: monthly report',
  slack_failed_title: 'Slack: messages are not being delivered',
  slack_resaved_title: 'Slack: you changed the address, so sending is off. Look at the sample and turn it on again.',
});
Object.assign(DICT.ja, {
  slack_digest_am: '朝のまとめ', slack_digest_pm: '夕方のまとめ', slack_waiting: '待っている物 {n} 件', slack_none: '待っている物はありません',
  slack_more: 'ほか {n} 件', slack_open: 'AI オフィスで開く',
  slack_head_approval: '承認待ち 1 件', slack_head_decision: '判断待ち 1 件', slack_head_run_failing: '失敗が続いています', slack_head_stuck: '止まった課題', slack_head_stale_routine: '古い定時の回',
  slack_overflow: 'ほか {n} 件の知らせがあります（オフィスで見てください）', slack_overflow_head: 'ほかの知らせ',
  slack_test: 'AI オフィスからの試しの 1 通です',
  slack_ex_approval: '例: 新しい価格表を公開する', slack_ex_decision: '例: どのロゴを使うか', slack_ex_run_failing: '例: 秘書', slack_ex_stuck: '例: 月次の報告',
  slack_failed_title: 'Slack: 知らせが届いていません',
  slack_resaved_title: 'Slack: 宛先を替えたので、送りを止めました。見本を見て ON にし直してください。',
});
export const t = (lang, k) => (DICT[lang] || DICT.en)[k] ?? DICT.en[k] ?? k;

// まとめの一覧（保証 19「件数と一覧」）: 未読の知らせを種類の順に 1 行ずつ、多い時は max 件までと「ほか n 件」
// 止めた担当（赤の帯）を先頭に、お金の出る物を次に置く
export const DIGEST_ORDER = ['agent_paused_limit', 'approval', 'decision', 'ai_overage_started', 'ai_credits_spent', 'budget_unset', 'ai_limit_near', 'ai_quota_unreadable', 'agent_resumed_limit', 'run_failing', 'run_failed', 'stuck', 'stale_routine', 'digest'];
export const KIND_LABEL = { approval: 'approval', decision: 'decision_t', run_failing: 'failing', run_failed: 'failed', stuck: 'stuck_t', stale_routine: 'stale', digest: 'unread',
  agent_paused_limit: 'paused_t', ai_limit_near: 'near_t', ai_credits_spent: 'credits_t', ai_overage_started: 'overage_t', ai_quota_unreadable: 'unreadable_t', budget_unset: 'budget_t', agent_resumed_limit: 'resumed_t' };
export function digestBody({ lang = 'en', unread, max = 10 }) {
  const rows = [...unread].sort((a, b) => DIGEST_ORDER.indexOf(a.kind) - DIGEST_ORDER.indexOf(b.kind));
  // 題の頭に種類の名前が既にある物（判断待ち・失敗など）は、名前を重ねない
  const lines = rows.slice(0, max).map(n => { const lab = t(lang, KIND_LABEL[n.kind] || 'unread'), ti = String(n.title || '').slice(0, 120); return ti.startsWith(lab) ? `- ${ti}` : `- ${lab}: ${ti}`; });
  if (rows.length > max) lines.push(lang === 'ja' ? `ほか ${rows.length - max} 件` : `and ${rows.length - max} more`);
  return lines.join('\n');
}
export function digestTitle({ slot, lang = 'en', counts, utc = false }) {
  const head = t(lang, slot) + (utc ? ` ${t(lang, 'utc')}` : '');
  // paused（止めている担当）は既読でも毎回数える（G4）
  const parts = ['paused', 'approval', 'decision', 'run_failed', 'stuck', 'unread'].filter(k => counts[k] > 0).map(k => lang === 'ja' ? `${t(lang, k)} ${counts[k]}` : `${counts[k]} ${t(lang, k)}`);
  return `${head}: ${parts.length ? parts.join(lang === 'ja' ? '・' : ', ') : t(lang, 'none')}`;
}

// 知らせの文に入った秘密の形を伏せる（保証 4）。題は AI や人が書いた物なので、鍵・token・password の形を [hidden] にする
// KEY_PATTERNS は 開発元の ops/rag/rag-lib.mjs の KEY_PATTERNS（7 つ）を丸ごと移し、Google の鍵・JWT・Bearer を足した物（減らさない）
export const KEY_PATTERNS = [
  /\b(sk-(?:ant-|proj-)?[A-Za-z0-9_-]{16,})/g, /\b(gh[pousr]_[A-Za-z0-9]{20,})/g, /\b(AKIA[0-9A-Z]{16})\b/g,
  /\b(xox[abposr]-[A-Za-z0-9-]{10,})/g, /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z ]*PRIVATE KEY-----|$)/g,
  /\b(pcp_(?:board|bootstrap|invite|cli_auth)_[A-Za-z0-9_-]{16,})/g, /https:\/\/hooks\.slack\.com\/services\/[A-Za-z0-9/]+/g,
  /\bAIza[0-9A-Za-z_-]{30,}/g, /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g, /\b(?:bearer)\s+[A-Za-z0-9._~+/=-]{8,}/gi,
];
// 名前の規則: 名前に KEY・TOKEN・SECRET・PASSWORD・PASSWD・PRIVATE を含む NAME=値・NAME: 値（MY_TOKEN のように _ の後に続く名前も）
// 値は、引用符で囲んだ物は閉じの引用符まで丸ごと（空白を含むパスフレーズも）、囲まない物は空白・区切りまで。短い値も伏せる（codex P2-1）
const NAME_RULE = /\b([A-Za-z0-9_.-]*(?:KEY|TOKEN|SECRET|PASSWORD|PASSWD|PRIVATE|PWD)[A-Za-z0-9_.-]*)(\s*[:=]\s*)("(?:[^"\\\n]|\\.)*"?|'(?:[^'\\\n]|\\.)*'?|[^\s"'`,;]+)/gi; // 引用符の中の \" は値の続き（codex 2 回目 P2-1）
export function redactSecrets(text) {
  let s = String(text ?? '');
  for (const re of KEY_PATTERNS) s = s.replace(re, '[hidden]');
  s = s.replace(NAME_RULE, (_, n, sep, v) => { const q = v[0] === '"' || v[0] === "'" ? v[0] : ''; return `${n}${sep}${q}[hidden]${q}`; });
  s = s.replace(/(\b[a-z][a-z0-9+.-]*:\/\/)([^\s/:@]+):([^\s/@]+)@/gi, '$1$2:[hidden]@'); // URL の user:pass@
  return s.replace(/(?<![0-9A-Za-z])[0-9]{7,}(?![0-9A-Za-z])/g, '[hidden]'); // 7 桁以上の数字（口座番号など）
}
// 片付けの決まり（知らせが際限なく溜まらない・独立レビュー P2-4）: 失敗とまとめは、読んだら 7 日・読まなくても 14 日で消す。
// 突き合わせで持つ種類（承認・判断待ち・止まった課題・失敗の続き）は、元が片付いた時だけ消す（読んだ物を消すと次の回に未読で戻るため・2 回目のレビュー P2-A）
export const RETENTION = { readDays: 7, noisyKinds: ['run_failed', 'digest'], noisyDays: 14, eventDays: 14 };

// 題は先に伏せてから切る（切った後に伏せると、切れ目にかかった鍵の頭が形に合わず残る・独立レビュー P3-1）
// 伏せる前に n＋400 字までに詰める（本体の題には長さの上限が無く、名前の規則は区切りの多い長い文で処理量が増えるため・独立レビュー P3）。
// 400 字の余りは、切れ目にかかった鍵も形に合って伏せられるだけの長さ
export function safeTitle(text, n) {
  const s = String(text ?? '');
  if (s.length <= n + 400) return redactSecrets(s).slice(0, n);
  // 窓の終わりを最後の空白まで戻し、切れ目にかかった鍵を窓に入れない（独立レビュー 2 回目 P3-A）
  const w = s.slice(0, n + 400), cut = w.search(/\s\S*$/);
  return redactSecrets(cut > 0 ? w.slice(0, cut) : w).slice(0, n);
}

// ==== AI の使用量の上限（範囲: docs/review/2026-11-18-ai-usage-limit-scope.md（開発元の記録）の 3 節・7 節）====
// ここは判定の部品だけ（純関数）。止める・知らせる・表に書くのは worker が受け持つ

export const ERROR_SNIPPET_MAX = 500; // event と run の error は先頭 500 文字だけ持つ（範囲 7 の 5）
// 持ち主の答え（範囲 10 節・2026-11-18）: Q2 = 自動で再開する。Q4（追加料金）は設定 spend（AI オフィス（起動係）で 1 つ・全部の会社に効く）で、既定は never（defaultAiLimits）
export const AUTO_RESUME = true;
// 自動では戻さない理由（追加料金で止めた時・G6）
export const NO_AUTO_RESUME = new Set(['credits', 'overage']);
export const LIMIT_REASONS = ['pct', 'provider_quota', 'overage', 'credits'];

// 既定の上限（G1）: 週・5 時間とも知らせる 80%、止める 95%。5 時間の窓の「止める %」は空（spend が stop・allow なら知らせだけ）
// 追加料金の扱い spend（Q4・AI オフィス（起動係）で 1 つ・全部の会社に効く）: never = 1 円も使わない（stop に加えて 5 時間と週の窓も 95% 以下で先に止める）・
// stop = 使い始めたら知らせて止める・allow = 知らせるだけ。既定は never。既定の正は起動係（launcher/lib/limits.mjs の defaultAiLimits）で、
// ここの既定は届いた値が無い・形の合わない時の倒れる先として同じ値を持つ（同じことを unit で確かめる）
export const SPEND_MODES = ['never', 'stop', 'allow'];
export const NEVER_H5_STOP_PCT = 95;
export function defaultAiLimits() {
  const prov = () => ({ h5: { warnPct: 80, stopPct: null }, week: { warnPct: 80, stopPct: 95 } });
  return { guard: true, spend: 'never', openai: prov(), anthropic: prov() };
}
export const spendMode = L => (SPEND_MODES.includes(L?.spend) ? L.spend : defaultAiLimits().spend);
// 追加料金を使い始めた時に止めるか（never と stop）
export const stopsOnSpend = L => spendMode(L) !== 'allow';
// 判定に使う上限: never の時は 5 時間と週の窓の「止める %」を 95% 以下にする（空なら 95%）。他はそのまま
export function effectiveAiLimits(L) {
  const base = L || defaultAiLimits();
  if (spendMode(base) !== 'never') return base;
  const cap = w => ({ ...(w || {}), stopPct: Math.min(w?.stopPct ?? NEVER_H5_STOP_PCT, NEVER_H5_STOP_PCT) });
  const prov = p => ({ ...(p || {}), h5: cap(p?.h5), week: cap(p?.week) });
  return { ...base, openai: prov(base.openai), anthropic: prov(base.anthropic) };
}
// flag aiLimitGuard（G8）: 値がまだ無い時は ON とみなす。OFF は guard が false の時だけ
export const limitGuardOn = aiLimits => aiLimits?.guard !== false;

// ---- 見回りの口の body の検査（範囲 7 の 2）----
const isObj = v => !!v && typeof v === 'object' && !Array.isArray(v);
const ID_RE = /^[A-Za-z0-9_.:-]{1,128}$/;
const WORD_RE = /^[a-z][a-z0-9_]{0,31}$/;
const okId = v => (typeof v === 'string' && ID_RE.test(v) ? v : null);
const okWord = v => (typeof v === 'string' && WORD_RE.test(v) ? v : null);
// 状態の文字: 形の合わない文字は 'unknown' にする（捨てると「無い」と区別できず、知らない状態を「読めない」に倒せない）
const okStatus = v => (v == null ? null : okWord(v) ?? 'unknown');
const okNum = v => (typeof v === 'number' && Number.isFinite(v) ? v : null);
const okEpoch = v => (typeof v === 'number' && Number.isFinite(v) && v > 1e9 && v < 1e11 ? Math.floor(v) : null); // epoch 秒
const okIso = v => { if (typeof v !== 'string' || v.length > 40) return null; const t = Date.parse(v); return Number.isFinite(t) ? new Date(t).toISOString() : null; };
const okText = (v, n) => (typeof v === 'string' && v ? safeTitle(v, n) : null);
const okIds = (v, max) => (Array.isArray(v) ? [...new Set(v.map(okId).filter(Boolean))].slice(0, max) : []);
const okPct = v => (typeof v === 'number' && Number.isFinite(v) && v >= 1 && v <= 100 ? Math.round(v) : undefined);
const list = (v, max, fn) => (Array.isArray(v) ? v.slice(0, max).map(fn).filter(Boolean) : null);

// 持ち主の決めた上限。欄ごとに、形の合わない値は既定に戻す（止める % は null で「止めない」）
export function checkAiLimits(v) {
  if (!isObj(v)) return null;
  const d = defaultAiLimits();
  const win = (w, def) => {
    const o = isObj(w) ? w : {};
    const stop = o.stopPct === null ? null : okPct(o.stopPct);
    return { warnPct: okPct(o.warnPct) ?? def.warnPct, stopPct: stop === undefined ? def.stopPct : stop };
  };
  const prov = (p, def) => ({ h5: win(p?.h5, def.h5), week: win(p?.week, def.week) });
  return { guard: typeof v.guard === 'boolean' ? v.guard : true, spend: spendMode(v), openai: prov(v.openai, d.openai), anthropic: prov(v.anthropic, d.anthropic) };
}
// quota-windows の 1 つの provider の答え（ChatGPT）。error の文は渡さない（本体の process の command が入る・実測 1）
export function checkQuota(v) {
  if (!isObj(v) || typeof v.ok !== 'boolean' || !okWord(v.provider)) return null;
  const windows = list(v.windows, 20, w => {
    if (!isObj(w) || typeof w.label !== 'string' || !w.label) return null;
    return { label: w.label.slice(0, 80), usedPercent: okNum(w.usedPercent), resetsAt: okIso(w.resetsAt), valueLabel: typeof w.valueLabel === 'string' ? w.valueLabel.slice(0, 80) : null };
  }) || [];
  return { provider: v.provider, ok: v.ok, source: typeof v.source === 'string' && v.source ? v.source.slice(0, 40) : null, windows, cancelledRunIds: okIds(v.cancelledRunIds, 50) };
}
// 起動係が読んだ上限の失敗の run。配列か { runs, complete }（complete: false は一覧を読み切れなかった回）
function checkRun(r) {
  if (!isObj(r)) return null;
  const runId = okId(r.runId), agentId = okId(r.agentId);
  if (!runId || !agentId) return null;
  return {
    runId, agentId, status: okWord(r.status), errorCode: okWord(r.errorCode), error: okText(r.error, ERROR_SNIPPET_MAX),
    retryNotBefore: okIso(r.retryNotBefore), finishedAt: okIso(r.finishedAt),
    logStatus: okStatus(r.logStatus), logOverageStatus: okStatus(r.logOverageStatus), logResetsAt: okEpoch(r.logResetsAt),
  };
}
export function checkQuotaRuns(v) {
  const runs = Array.isArray(v) ? v : isObj(v) && Array.isArray(v.runs) ? v.runs : null;
  if (!runs) return null;
  return { runs: list(runs, 1000, checkRun), complete: isObj(v) && typeof v.complete === 'boolean' ? v.complete : true };
}
// Claude の run のログの rate_limit_event の決まった欄だけ（範囲 3.3）。readError は起動係が読もうとして失敗した時の理由
export function checkClaudeLimits(v) {
  if (!isObj(v)) return null;
  const unifiedWindows = {};
  if (isObj(v.unifiedWindows)) {
    for (const [k, w] of Object.entries(v.unifiedWindows).slice(0, 8)) {
      if (!WORD_RE.test(k) || !isObj(w)) continue;
      unifiedWindows[k] = { utilization: okNum(w.utilization), resetsAt: okEpoch(w.resetsAt), status: okStatus(w.status), surpassedThreshold: okNum(w.surpassedThreshold) };
    }
  }
  return {
    observedAt: okIso(v.observedAt), runId: okId(v.runId), contract: okContract(v.contract), readError: v.readError == null ? null : okWord(v.readError) ?? 'unknown',
    status: okStatus(v.status), resetsAt: okEpoch(v.resetsAt), rateLimitType: okStatus(v.rateLimitType), overageStatus: okStatus(v.overageStatus),
    overageDisabledReason: okStatus(v.overageDisabledReason), isUsingOverage: typeof v.isUsingOverage === 'boolean' ? v.isUsingOverage : null,
    utilization: okNum(v.utilization), surpassedThreshold: okNum(v.surpassedThreshold), unifiedWindows, cancelledRunIds: okIds(v.cancelledRunIds, 50),
  };
}
// 同じ契約の担当の一覧（起動係が env のキー名と secret_ref の id で作る。値は入らない）
const CONTRACT_RE = /^[A-Za-z0-9_.:-]{1,160}$/;
const okContract = v => (typeof v === 'string' && CONTRACT_RE.test(v) ? v : null);
export const PROVIDERS = ['anthropic', 'openai'];
export function checkContractGroups(v) {
  return list(v, 50, g => {
    if (!isObj(g) || !okContract(g.contract) || !PROVIDERS.includes(g.provider)) return null;
    const agentIds = okIds(g.agentIds, 500);
    return agentIds.length ? { contract: g.contract, provider: g.provider, agentIds } : null;
  });
}
// 本体の budgets/overview の activeIncidents（G7）
export function checkBudgetIncidents(v) {
  return list(v, 100, x => {
    if (!isObj(x) || !okId(x.id)) return null;
    return { id: x.id, scopeType: okWord(x.scopeType), scopeId: okId(x.scopeId), scopeName: okText(x.scopeName, 80), thresholdType: okWord(x.thresholdType), amountLimit: okNum(x.amountLimit), amountObserved: okNum(x.amountObserved) };
  });
}
// API キー・Bedrock で動き、予算の無い担当（G7b）。kind はキーの種類の名前（値ではない）
export function checkBudgetGaps(v) {
  return list(v, 500, x => (isObj(x) && okId(x.agentId) ? { agentId: x.agentId, kind: okWord(x.kind) } : null));
}

// ---- 窓と使用率（G2・G3）----
// ChatGPT の窓の label を種類に分ける。「<名前> · 5h limit」（codex 以外の limitId）・Extra usage などは null（判定に使わない）
export function windowKind(label) {
  if (typeof label !== 'string') return null;
  const s = label.trim();
  if (!s || s.includes('·')) return null;
  if (/^(?:5\s*-?\s*h(?:ours?|rs?)?|five[\s_-]*hours?)(?:\s+limit)?$/i.test(s)) return 'h5';
  if (/^(?:weekly|week|7\s*-?\s*d(?:ays?)?|seven[\s_-]*days?)(?:\s+limit)?$/i.test(s)) return 'week';
  if (/^credits$/i.test(s)) return 'credits';
  return null;
}
// ChatGPT の quota の答えから、判定に使う窓（5 時間・週）だけを出す。ok:false は「読めない」
export function openaiWindows(quota) {
  if (!quota) return { windows: [], unreadable: false };
  if (quota.ok !== true) return { windows: [], unreadable: true };
  const windows = [];
  for (const w of quota.windows || []) {
    const kind = windowKind(w.label);
    if ((kind === 'h5' || kind === 'week') && typeof w.usedPercent === 'number') windows.push({ kind, usedPercent: w.usedPercent, resetsAt: w.resetsAt ?? null, status: null });
  }
  return { windows, unreadable: false };
}
const CLAUDE_WINDOW = { seven_day: 'week', five_hour: 'h5' };
const CLAUDE_STATUS = new Set(['allowed', 'allowed_warning', 'rejected']);
const pctOf = u => Math.round(u * 1000) / 10; // 0〜1 の割合 → %
const epochIso = s => (typeof s === 'number' && Number.isFinite(s) ? new Date(s * 1000).toISOString() : null);
// Claude の claudeLimits を窓に分ける。seven_day → week、five_hour → h5。utilization×100 を usedPercent、resetsAt（epoch 秒）を ISO に。
// 知らない窓は捨てる。知らない status・読もうとして失敗した回・使える窓が 1 つも無い時は unreadable（G2a）
export function claudeWindows(cl) {
  if (!cl) return { windows: [], unreadable: false, status: null, observedAt: null };
  let unreadable = !!cl.readError;
  if (cl.status != null && !CLAUDE_STATUS.has(cl.status)) unreadable = true;
  const byKind = new Map();
  for (const [k, w] of Object.entries(cl.unifiedWindows || {})) {
    const kind = CLAUDE_WINDOW[k];
    if (!kind) continue; // 知らない窓（使える窓が残らなければ下で unreadable）
    if (w.status != null && !CLAUDE_STATUS.has(w.status)) { unreadable = true; continue; }
    if (typeof w.utilization !== 'number' || w.utilization < 0) continue;
    byKind.set(kind, { kind, usedPercent: pctOf(w.utilization), resetsAt: epochIso(w.resetsAt), status: w.status ?? null });
  }
  // 全体の utilization は rateLimitType の窓の値（実測 4・5 では全体の欄に無く、unifiedWindows にだけあった）
  const top = CLAUDE_WINDOW[cl.rateLimitType];
  if (top && typeof cl.utilization === 'number' && cl.utilization >= 0) {
    const prev = byKind.get(top);
    byKind.set(top, { kind: top, usedPercent: pctOf(cl.utilization), resetsAt: epochIso(cl.resetsAt) ?? prev?.resetsAt ?? null, status: prev?.status ?? (CLAUDE_STATUS.has(cl.status) ? cl.status : null) });
  }
  if (!byKind.size) unreadable = true;
  return { windows: [...byKind.values()], unreadable, status: CLAUDE_STATUS.has(cl.status) ? cl.status : null, observedAt: cl.observedAt ?? null };
}
// 知らせの key に使う resetsAt は時間で丸める（同じ窓の resetsAt が秒で揺れても 1 件・G2c）
const resetHour = iso => { const t = Date.parse(iso); return Number.isFinite(t) ? new Date(Math.round(t / 3600000) * 3600000).toISOString().slice(0, 13) : 'none'; };
// 近い（near）と超えた（over）を出す（両方の契約で共通）。allowed_warning と rejected の窓は % に関係なく near。
// over は「止める %」を持つ窓だけ（5 時間の窓は既定で null = 止めない）。key は provider＋窓の種類＋resetsAt を時間で丸めた値
export function limitState(windows, limits, provider) {
  const near = [], over = [];
  for (const w of windows || []) {
    const lim = limits?.[w.kind];
    if (!lim) continue;
    const pct = typeof w.usedPercent === 'number' ? w.usedPercent : null;
    const item = { provider, kind: w.kind, usedPercent: pct, resetsAt: w.resetsAt ?? null, key: `${provider}:${w.kind}:${resetHour(w.resetsAt)}` };
    if ((pct != null && lim.warnPct != null && pct >= lim.warnPct) || w.status === 'allowed_warning' || w.status === 'rejected') near.push(item);
    if (pct != null && lim.stopPct != null && pct >= lim.stopPct) over.push({ ...item, reason: 'pct' });
  }
  return { near, over };
}

// ---- 追加料金の枠（G9）----
// 「$250.80 remaining」→ 250.8。形の違う物（N/A など）は null
export function creditsDollars(valueLabel) {
  const m = typeof valueLabel === 'string' && valueLabel.trim().match(/^\$\s*([0-9][0-9,]*(?:\.[0-9]+)?)\s+remaining$/i);
  if (!m) return null;
  const n = Number(m[1].replace(/,/g, ''));
  return Number.isFinite(n) ? n : null;
}
// quota の答えから Credits の残りを source つきで読む。窓が無い・読めない時は null
export function creditsReading(quota) {
  if (!quota || quota.ok !== true || !quota.source) return null;
  const w = (quota.windows || []).find(x => windowKind(x.label) === 'credits');
  const dollars = w ? creditsDollars(w.valueLabel) : null;
  return dollars == null ? null : { source: quota.source, dollars };
}
// 前の回と今の回の残りを比べる。同じ source の時だけ比べる（wham は balance/100・RPC は balance のままで作りが違う・範囲 2.4）。
// spent: true は減った・false は同じか増えた（買い足し）・null は比べなかった。base は次の回に持つ基準
// （source が違う回は今の値を新しい基準に、今が読めない回は前の基準を持ち続ける）
export function creditsSpend(prev, now) {
  const norm = r => {
    if (!isObj(r) || typeof r.source !== 'string' || !r.source) return null;
    const dollars = typeof r.dollars === 'number' && Number.isFinite(r.dollars) ? r.dollars : creditsDollars(r.valueLabel);
    return dollars == null ? null : { source: r.source, dollars };
  };
  const p = norm(prev), n = norm(now);
  if (!n) return { spent: null, base: p };
  if (!p || p.source !== n.source) return { spent: null, base: n };
  return { spent: n.dollars < p.dollars - 0.005, from: p.dollars, to: n.dollars, base: n };
}
// Claude の追加料金の状態（G9b）: using（追加料金で動いている）・enabled（上限の後は追加料金で続く設定）・off（入っていない）・unreadable
const OVERAGE_ON = new Set(['allowed', 'allowed_warning']);
export function overageState(cl) {
  if (!cl || cl.readError) return 'unreadable';
  if (cl.isUsingOverage === true) return 'using';
  const rejected = cl.status === 'rejected' || Object.values(cl.unifiedWindows || {}).some(w => w?.status === 'rejected');
  if (OVERAGE_ON.has(cl.overageStatus)) return rejected ? 'using' : 'enabled'; // 窓の上限を越えて追加料金で通った形
  if (cl.overageStatus === 'rejected') return 'off';
  return 'unreadable';
}

// ---- 上限の失敗の判定（G5）----
// 上限に当たったと言い切れる文（成功で終わった run の要約にもかける）
export const QUOTA_HIT_RE = /(?:you(?:'|’)ve\s+hit\s+your\s+(?:\w+\s+)?limit|(?:session|usage|weekly|5[-\s]?hour|claude\s+usage)\s+(?:limit|cap)\s+(?:reached|exceeded)|out\s+of\s+extra\s+usage|\brate_limit_reached\b|\busage_limit_(?:reached|exceeded)\b)/i;
// 失敗の run にかける広い形: 本体の claude・codex・recovery の正規表現に、下線の rate_limit・rate_limit_reached・usage_limit を足した物
// （\brate_limit\b は rate_limit_error（一時的な 429）には当たらない）
export const QUOTA_ERROR_RE = new RegExp(QUOTA_HIT_RE.source + '|' + /(?:extra\s+usage\b|usage\s+limit|usage\s+cap|model\s+(?:is\s+)?at\s+capacity|at\s+capacity\s+for\s+this\s+model|capacity\s+limit|provider\s+quota|quota\s+(?:limit\s+)?exceeded|servicequotaexceededexception|\brate_limit\b|\busage_limit\b)/i.source, 'i');
// r: event の行（errorCode・errorSnippet・kind）か quotaRuns の run（status・errorCode・error・logStatus・logOverageStatus）
export function isQuotaFailure(r) {
  if (!r || typeof r !== 'object') return false;
  if (r.errorCode === 'provider_quota') return true;
  // Claude のログの status:"rejected"。ただし追加料金で通った形（overageStatus が allowed 系）は失敗ではない（G9b で見る）
  if (r.logStatus === 'rejected' && !OVERAGE_ON.has(r.logOverageStatus)) return true;
  const text = typeof r.error === 'string' && r.error ? r.error : typeof r.errorSnippet === 'string' ? r.errorSnippet : '';
  if (!text) return false;
  const ok = r.status === 'succeeded' || r.kind === 'run_finished';
  return ok ? okRunHit(text) : QUOTA_ERROR_RE.test(text);
}
// 成功で終わった run は、要約そのものが上限の文の時だけ拾う（短い文で、文の初めの方に言い切れる文がある）。
// 課題の中身として上限の文を引いただけの長い要約で、契約の担当を全員止めない（実装レビュー r1 の L4）
export const OK_HIT_MAX_LEN = 300, OK_HIT_MAX_AT = 80;
export function okRunHit(text) {
  const s = String(text ?? '');
  if (s.length > OK_HIT_MAX_LEN) return false;
  const m = QUOTA_HIT_RE.exec(s);
  return !!m && m.index <= OK_HIT_MAX_AT;
}

// ---- リセットの時刻（G3a・G6）----
const MONTHS = { jan: 0, feb: 1, mar: 2, apr: 3, may: 4, jun: 5, jul: 6, aug: 7, sep: 8, oct: 9, nov: 10, dec: 11 };
const RESET_RE = /\b(?:resets?|try\s+again)\s+(?:at\s+)?((?:[A-Za-z]{3,9}\.?\s+\d{1,2}(?:st|nd|rd|th)?,?\s+(?:\d{4},?\s+)?)?\d{1,2}(?::\d{2})?\s*[ap]\.?\s*m\.?)(?:\s*\(([^)\n]{0,64})\)?)?/i;
function tzOffsetMs(ms, timeZone) {
  const f = new Intl.DateTimeFormat('en-US', { timeZone, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' });
  const p = Object.fromEntries(f.formatToParts(new Date(ms)).map(x => [x.type, x.value]));
  return Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour, +p.minute, +p.second) - Math.floor(ms / 1000) * 1000;
}
// その時刻帯の壁の時計の時刻 → epoch ms
function zonedToUtc(y, mo, d, h, mi, timeZone) {
  const guess = Date.UTC(y, mo, d, h, mi);
  const off = tzOffsetMs(guess, timeZone);
  const t = guess - off, off2 = tzOffsetMs(t, timeZone);
  return off2 === off ? t : guess - off2;
}
// 失敗の文から取るリセットの時刻（補い）: 「resets 9am (UTC)」「resets Nov 19, 9am (UTC)」「(Asia/Tokyo)」・年をまたぐ形。
// 時刻帯の無い文は UTC と読む。知らない時刻帯・途中で切れた時刻帯（「(Asia/Tok…」）・読めない形は null
export function resetFromText(text, nowMs) {
  const m = String(text ?? '').match(RESET_RE);
  if (!m) return null;
  const tzRaw = m[2] == null ? '' : m[2].replace(/(?:…|\.{3})\s*$/u, '').trim();
  const tz = tzRaw ? validTimeZone(tzRaw) : 'UTC';
  if (!tz) return null;
  const p = m[1].match(/^(?:([A-Za-z]{3,9})\.?\s+(\d{1,2})(?:st|nd|rd|th)?,?\s+(?:(\d{4}),?\s+)?)?(\d{1,2})(?::(\d{2}))?\s*([ap])/i);
  if (!p) return null;
  const h12 = Number(p[4]), mi = Number(p[5] ?? 0);
  if (h12 < 1 || h12 > 12 || mi > 59) return null;
  const h = (h12 % 12) + (p[6].toLowerCase() === 'p' ? 12 : 0);
  const today = localParts(nowMs, tz).date.split('-').map(Number); // [年, 月, 日]
  if (p[1]) {
    const mo = MONTHS[p[1].slice(0, 3).toLowerCase()], d = Number(p[2]);
    if (mo == null || d < 1 || d > 31) return null;
    const at = y => { const c = new Date(Date.UTC(y, mo, d)); return c.getUTCMonth() === mo ? zonedToUtc(y, mo, d, h, mi, tz) : null; };
    let t = at(p[3] ? Number(p[3]) : today[0]);
    // 年の無い日付が 30 日より前なら次の年（12 月に「Jan 2」と書かれた形）
    if (t != null && !p[3] && t < nowMs - 30 * 86400000) t = at(today[0] + 1);
    return t == null ? null : new Date(t).toISOString();
  }
  let t = zonedToUtc(today[0], today[1] - 1, today[2], h, mi, tz);
  if (t <= nowMs) { const n = new Date(Date.UTC(today[0], today[1] - 1, today[2] + 1)); t = zonedToUtc(n.getUTCFullYear(), n.getUTCMonth(), n.getUTCDate(), h, mi, tz); }
  return new Date(t).toISOString();
}
// 止め続ける期限: ログの resetsAt（epoch 秒）を優先し、無ければ run の retryNotBefore、その次に失敗の文。どれも無ければ null（人の再開だけ）
export function limitResetAt({ logResetsAt, retryNotBefore, text, nowMs } = {}) {
  const log = okEpoch(logResetsAt);
  if (log != null) return { at: epochIso(log), from: 'log' };
  const rnb = okIso(retryNotBefore);
  if (rnb) return { at: rnb, from: 'retry' };
  const fromText = text ? resetFromText(text, nowMs) : null;
  return fromText ? { at: fromText, from: 'text' } : null;
}

// ---- 同じ契約の担当（G5）と、止める前の確かめ（G3）----
// その担当と同じ契約の担当の一覧（その担当を含む）。一覧に無い担当はその担当だけ
export function contractPeers(groups, agentId) {
  for (const g of groups || []) if (g.agentIds.includes(agentId)) return { contract: g.contract, provider: g.provider, agentIds: [...new Set(g.agentIds)] };
  return { contract: null, provider: null, agentIds: [agentId] };
}
// 止める担当を選ぶ: 既に paused の担当（人が止めた・予算で止まった）は止めず記録もしない（skipped）。
// 担当の一覧に無い・terminated の担当も止めない（missing）
export function pauseTargets(agentIds, agents) {
  const by = new Map((agents || []).map(a => [a.id, a]));
  const pause = [], skipped = [], missing = [];
  for (const id of new Set(agentIds)) {
    const a = by.get(id);
    if (!a || a.status === 'terminated') missing.push(id);
    else if (a.status === 'paused') skipped.push(id);
    else pause.push(id);
  }
  return { pause, skipped, missing };
}

// ---- 戻す・止め直す・閉じる（範囲 7 の 6）----
const sameTime = (a, b) => a != null && b != null && Date.parse(a) === Date.parse(b);
// rec: limit_pauses の開いた行（reason・untilAt・agentPausedAt）。agent: agents.list の担当（status・pausedAt）。
// 返す値: close_gone（担当が消えた）・close_resumed（人が再開した）・close_repaused（人が止め直した）・close_changed（pausedAt が違う）
//   ・repause（走り終わりとの競り合いで idle に戻った）・resume（自動で戻す）・keep。
// 閉じる判定は flag OFF でも行う。止め直す・自動で戻すは flag ON の時だけ（G8）。
// stillOver: ChatGPT の % で止めた時に、その窓がまだ「止める %」以上か（G6）
export function pauseAction(rec, agent, { guard = true, nowMs = Date.now(), autoResume = AUTO_RESUME, stillOver = false } = {}) {
  if (!agent || agent.status === 'terminated') return 'close_gone';
  const known = rec.agentPausedAt != null;
  if (agent.status !== 'paused') {
    if (agent.pausedAt == null) return 'close_resumed';
    if (!known || sameTime(agent.pausedAt, rec.agentPausedAt)) return guard ? 'repause' : 'keep';
    return 'close_changed';
  }
  if (known && agent.pausedAt != null && !sameTime(agent.pausedAt, rec.agentPausedAt)) return 'close_repaused';
  // 自動で戻すのは、記録の pausedAt と同じだと確かめられた時だけ（人が止め直した担当を外さない・G6）
  if (!guard || !autoResume || !known || !sameTime(agent.pausedAt, rec.agentPausedAt)) return 'keep';
  if (NO_AUTO_RESUME.has(rec.reason) || stillOver) return 'keep';
  const until = Date.parse(rec.untilAt);
  return Number.isFinite(until) && nowMs >= until ? 'resume' : 'keep';
}

// ==== 止める・知らせる・戻す（第 2 段・範囲 7 の 3〜7 の 6・7 の 8・7 の 9）====
// worker が使う、本体に触らない部品

// 時刻を ISO の文字にそろえる（本体の口は Date か文字で返す。Date.parse(Date) は ms を落とすので先に文字にする）
export const toIso = v => {
  if (v == null || v === '') return null;
  const n = v instanceof Date ? v.getTime() : typeof v === 'number' ? v : Date.parse(v);
  return Number.isFinite(n) ? new Date(n).toISOString() : null;
};
// 止める理由の名前（知らせの本文）
export const REASON_LABEL = { pct: 'r_pct', provider_quota: 'r_provider_quota', overage: 'r_overage', credits: 'r_credits' };
const ADAPTER_OF = { anthropic: 'claude_local', openai: 'codex_local' };

// 止める担当の組: contract を指せばその組、指さなければその provider の組を全部。組が 1 つも無い時は、
// その provider の adapter の担当（一覧の adapterType）を同じ契約とみなす（範囲 6 節: 迷う時は同じ契約として止める）
export function providerGroup(groups, { provider, contract = null, agents = [] }) {
  const gs = (groups || []).filter(g => g.provider === provider && (!contract || g.contract === contract));
  if (gs.length) return { contract: contract || gs[0].contract, agentIds: [...new Set(gs.flatMap(g => g.agentIds))] };
  if (contract && (groups || []).some(g => g.provider === provider)) return { contract, agentIds: [] };
  return { contract: contract || provider, agentIds: (agents || []).filter(a => a.adapterType === ADAPTER_OF[provider]).map(a => a.id) };
}
// resetsAt を過ぎた窓は古い値として外す（Claude は最後に読めた値を持ち続けるので、戻した後に古い値で止め直さない）
export const liveWindows = (windows, nowMs) => (windows || []).filter(w => { const r = Date.parse(w.resetsAt); return !Number.isFinite(r) || r > nowMs; });

// 止め続ける期限の上書き（範囲 7 の 5）: ログの resetsAt は常に正。ログが無い時は、今の期限・文・retryNotBefore の遅い方
// （P1: 週の上限でも retryNotBefore は約 1 時間後のことがあり、早い方で戻すと次の 1 本がまた失敗する）
export function betterUntil(current, { logResetsAt = null, retryNotBefore = null, text = null, nowMs = Date.now() } = {}) {
  const log = limitResetAt({ logResetsAt, nowMs });
  if (log) return log.at;
  const cands = [current, okIso(retryNotBefore), text ? resetFromText(text, nowMs) : null].map(toIso).filter(Boolean);
  return cands.length ? new Date(Math.max(...cands.map(Date.parse))).toISOString() : null;
}

// 止めている担当の知らせ（G4）。key は記録の id と期限（期限が変われば本文も新しくする）。originId は担当の id
export function pauseNotice(rec, { lang = 'en', agentName = null, issues = [] } = {}) {
  const head = `${t(lang, 'paused_t')}: ${safeTitle(agentName || rec.agentId, 80)}`;
  const at = rec.untilAt ? `${rec.untilAt.slice(0, 16).replace('T', ' ')} UTC` : null;
  const until = at ? (lang === 'ja' ? `${at} ${t(lang, 'until')}` : `${t(lang, 'until')} ${at}`) : t(lang, 'resume_manual');
  const lines = [`${t(lang, REASON_LABEL[rec.reason] || 'r_provider_quota')} · ${until}`];
  for (const i of issues.slice(0, 10)) lines.push(`- ${i.identifier ? `${i.identifier} ` : ''}${safeTitle(i.title || '', 120)}`);
  return { key: noticeKey('agent_paused_limit', `${rec.id}:${rec.untilAt || ''}`), kind: 'agent_paused_limit', originId: rec.agentId, title: head.slice(0, 200), body: lines.join('\n') };
}
// 戻した知らせ（G6）。止めた時に担当が持っていた課題を本文に出す
export function resumedNotice(r, lang = 'en') {
  const lines = (r.issues || []).slice(0, 10).map(i => `- ${i.identifier ? `${i.identifier} ` : ''}${safeTitle(i.title || '', 120)}`);
  return { key: noticeKey('agent_resumed_limit', `${r.recId}`), kind: 'agent_resumed_limit', originId: r.agentId, title: `${t(lang, 'resumed_t')}: ${safeTitle(r.name || r.agentId, 80)}`.slice(0, 200), body: lines.length ? lines.join('\n') : null };
}
// 本体の予算で止まった物（G7）。止めた担当と同じ種類で出す（帯と受信箱を同じにする）。originId は予算の範囲の id
export function budgetNotice(inc, lang = 'en') {
  const name = safeTitle(inc.scopeName || inc.scopeId || inc.id, 80);
  const usd = c => `$${(c / 100).toFixed(2)}`;
  const amt = typeof inc.amountLimit === 'number' ? ` (${typeof inc.amountObserved === 'number' ? `${usd(inc.amountObserved)} / ` : ''}${usd(inc.amountLimit)})` : '';
  return { key: noticeKey('agent_paused_limit', `budget:${inc.id}`), kind: 'agent_paused_limit', originId: inc.scopeId || inc.id, title: `${t(lang, 'budget_stop_t')}: ${name}${amt}`.slice(0, 200) };
}
// 予算の incident: hard（止まる）だけ。thresholdType の分からない物（event だけで知った物）も出す
export const hardIncidents = list => (list || []).filter(x => x.thresholdType == null || x.thresholdType === 'hard');

// 新しい知らせを出さない時（flag OFF）の突き合わせ: 既にある物は残し、無くなった物は消す
export const keepOnly = (want, notices) => { const have = new Set((notices || []).map(n => n.key)); return want.filter(n => have.has(n.key)); };
