// 起動係の AI の使用量の上限の受け持ち（lib/limits.mjs・範囲 docs/review/2026-11-18-ai-usage-limit-scope.md の 7 の 1・7 の 2・8 節の unit）の試験。本体は偽物
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import {
  defaultAiLimits, normalizeAiLimits, mergeAiLimits, contractGroups, budgetGaps, budgetIncidents, pickQuota, creditsReading, creditsSpent,
  isQuotaRun, retryNotBeforeOf, pickRateLimit, scanLogPages, readRunLimits, TRUNC_MARK, createLimitsCollector, createLimitOverrides,
  testHooksEnabled, TEST_HOOK_ENV, RUN_LIST_MAX, redactRunText, SPEND_MODES, spendMode, stopsOnSpend,
} from '../packages/aioffice/launcher/lib/limits.mjs';
import { createRounds } from '../packages/aioffice/launcher/lib/rounds.mjs';
import { createLauncher, isLoopback } from '../packages/aioffice/launcher/server.mjs';

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'aio-limits-'));

// ---- 本物の外側の形（{ts, stream, chunk, seq} の ndjson・run-log-store.js:208-224）の fixture ----
// 実測 4（上限・アカウント A）と実測 5（通った・アカウント B）の rate_limit_info
const INFO_REJECTED = { status: 'rejected', resetsAt: 1795078800, rateLimitType: 'seven_day', overageStatus: 'rejected', overageDisabledReason: 'org_level_disabled', isUsingOverage: false, unifiedWindows: { seven_day: { utilization: 1, resetsAt: 1795078800, status: 'rejected', surpassedThreshold: 1 } } };
const INFO_ALLOWED = { status: 'allowed', resetsAt: 1795471200, rateLimitType: 'seven_day', overageStatus: 'rejected', overageDisabledReason: 'org_level_disabled', isUsingOverage: false, unifiedWindows: { seven_day: { utilization: 0.1, resetsAt: 1795471200, status: 'allowed' } } };
const TOKEN_LIKE = 'sk-ant-oat01-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';
const eventLine = (info, extra = {}) => `${JSON.stringify({ type: 'rate_limit_event', rate_limit_info: info, uuid: 'u-1', session_id: 's-1', ...extra })}\n`;
const rec = (seq, chunk, stream = 'stdout') => `${JSON.stringify({ ts: new Date(Date.UTC(2026, 10, 17, 22, 20, 0) + seq * 10).toISOString(), stream, chunk, seq })}\n`;
// 1 万〜10 万字のログ: 始まりの system・rate_limit_event・本文の行をたくさん・result
function bigLog({ info = INFO_REJECTED, bodyLines = 400, eventExtra = {} } = {}) {
  let seq = 0, out = '';
  out += rec(seq++, 'Run started\n', 'system');
  out += rec(seq++, `${JSON.stringify({ type: 'system', subtype: 'init', session_id: 's-1', tools: [], model: 'claude' })}\n`);
  out += rec(seq++, eventLine({ ...info, secretField: TOKEN_LIKE }, eventExtra));
  for (let i = 0; i < bodyLines; i++) out += rec(seq++, `${JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: `本文の行 ${i} hello body ${TOKEN_LIKE}` }] } })}\n`);
  out += rec(seq++, 'warning: something on stderr\n', 'stderr');
  out += rec(seq++, `${JSON.stringify({ type: 'result', subtype: 'success', is_error: true, result: "You've hit your weekly limit · resets Nov 19, 9am (UTC)" })}\n`);
  return out;
}
// 本体の口 GET /api/heartbeat-runs/:runId/log の偽物（byte で切る・nextOffset・run-log-store.js:128-138）
const logApi = (text, calls = []) => async (runId, offset, limitBytes) => {
  calls.push({ runId, offset, limitBytes });
  const b = Buffer.from(text, 'utf8'), start = Math.min(offset, b.length), end = Math.min(b.length, start + limitBytes);
  return { content: b.subarray(start, end).toString('utf8'), ...(end < b.length ? { nextOffset: end } : {}) };
};

test('設定: 既定は週・5 時間とも知らせる 80%・止める 95%（5 時間の欄は空）・追加料金は never（1 円も使わない）・flag ON', () => {
  const d = defaultAiLimits();
  assert.deepEqual(d.openai, { h5: { warnPct: 80, stopPct: null }, week: { warnPct: 80, stopPct: 95 } });
  assert.deepEqual(d.anthropic, { h5: { warnPct: 80, stopPct: null }, week: { warnPct: 80, stopPct: 95 } });
  assert.equal(d.guard, true);
  assert.equal(d.spend, 'never', '追加料金の扱いの既定は never（持ち主の答え 2026-11-18）');
  assert.deepEqual(SPEND_MODES, ['never', 'stop', 'allow']);
  // 値が無い・形の合わない時は既定（never）に倒す。止める・取り消すのは never と stop
  assert.equal(spendMode({}), 'never'); assert.equal(spendMode({ spend: 'x' }), 'never'); assert.equal(normalizeAiLimits({ spend: 'bogus' }).spend, 'never');
  assert.deepEqual(['never', 'stop', 'allow', undefined].map(m => stopsOnSpend({ spend: m })), [true, true, false, true]);
  assert.deepEqual(normalizeAiLimits(null), d);
  assert.deepEqual(normalizeAiLimits({ guard: 'no', openai: { week: { warnPct: 500 } } }), d); // 形の合わない欄は既定
});

test('設定の口の重ね方: 一部だけ変える・止める % を null（止めない）・形の合わない値と知る % > 止める % は 400', () => {
  const m = mergeAiLimits(defaultAiLimits(), { guard: false, spend: 'allow', openai: { h5: { stopPct: 90 } }, anthropic: { week: { warnPct: 70, stopPct: null } } });
  assert.equal(m.value.guard, false);
  assert.deepEqual(m.value.openai.h5, { warnPct: 80, stopPct: 90 });
  assert.deepEqual(m.value.anthropic.week, { warnPct: 70, stopPct: null });
  assert.equal(m.value.spend, 'allow');
  assert.equal(m.value.openai.week.stopPct, 95); // 触らない欄はそのまま
  for (const bad of [{ guard: 1 }, { openai: { week: { warnPct: 0 } } }, { openai: { week: { stopPct: 101 } } }, { spend: 'yes' }, { spend: null }, { openai: { credits: { stopOnSpend: true } } }, { anthropic: { overage: { stopOnSpend: true } } }, { other: 1 }, { openai: { week: { warnPct: 80.5 } } }])
    assert.ok(mergeAiLimits(defaultAiLimits(), bad).error, JSON.stringify(bad));
  assert.equal(mergeAiLimits(defaultAiLimits(), { openai: { week: { warnPct: 96 } } }).error, 'ai_limits_warn_over_stop');
});

test('同じ契約の担当: Claude は token の secret_ref の id ごと・ChatGPT は 1 組。API キー・Bedrock は別にし、値は出さない', () => {
  const agents = [
    { id: 'a1', adapterType: 'claude_local', status: 'idle', adapterConfig: { env: { CLAUDE_CODE_OAUTH_TOKEN: { type: 'secret_ref', secretId: 'sec-1' } } } },
    { id: 'a2', adapterType: 'claude_local', status: 'paused', adapterConfig: { env: { CLAUDE_CODE_OAUTH_TOKEN: { type: 'secret_ref', secretId: 'sec-1' } } } },
    { id: 'a3', adapterType: 'claude_local', status: 'idle', adapterConfig: { env: { CLAUDE_CODE_OAUTH_TOKEN: { type: 'secret_ref', secretId: 'sec-2' } } } },
    { id: 'a4', adapterType: 'claude_local', status: 'idle', adapterConfig: { env: { CLAUDE_CODE_OAUTH_TOKEN: { type: 'secret_ref', secretId: 'sec-1' }, ANTHROPIC_API_KEY: '***REDACTED***' } } },
    { id: 'a5', adapterType: 'claude_local', status: 'idle', adapterConfig: { env: { CLAUDE_CODE_USE_BEDROCK: { type: 'plain', value: '1' } } } },
    { id: 'a6', adapterType: 'codex_local', status: 'idle', adapterConfig: { env: {} } },
    { id: 'a7', adapterType: 'codex_local', status: 'idle', adapterConfig: { env: { OPENAI_API_KEY: TOKEN_LIKE } } },
    { id: 'a8', adapterType: 'codex_local', status: 'terminated', adapterConfig: {} },
    { id: 'a9', adapterType: 'claude_local', status: 'idle', adapterConfig: { env: { ANTHROPIC_API_KEY: '' } } }, // 空の値は無いのと同じ
  ];
  const { groups, apiAgents } = contractGroups(agents);
  assert.deepEqual(groups, [
    { contract: 'anthropic:sec-1', provider: 'anthropic', agentIds: ['a1', 'a2'] },
    { contract: 'anthropic:sec-2', provider: 'anthropic', agentIds: ['a3'] },
    { contract: 'openai:process', provider: 'openai', agentIds: ['a6'] },
    { contract: 'anthropic:local', provider: 'anthropic', agentIds: ['a9'] },
  ]);
  assert.deepEqual(apiAgents, [{ agentId: 'a4', kind: 'anthropic_api_key' }, { agentId: 'a5', kind: 'bedrock' }, { agentId: 'a7', kind: 'openai_api_key' }]);
  assert.ok(!JSON.stringify({ groups, apiAgents }).includes('sk-ant'));
});

test('予算: 会社の予算があれば穴なし・担当の予算はその担当だけ埋める・止まった incident は決まった欄だけ', () => {
  const api = [{ agentId: 'a4', kind: 'anthropic_api_key' }, { agentId: 'a7', kind: 'openai_api_key' }];
  assert.deepEqual(budgetGaps(api, { policies: [] }), api);
  assert.deepEqual(budgetGaps(api, { policies: [{ scopeType: 'agent', scopeId: 'a4', isActive: true, amount: 5000 }] }), [api[1]]);
  assert.deepEqual(budgetGaps(api, { policies: [{ scopeType: 'company', scopeId: 'c1', isActive: true, amount: 5000 }] }), []);
  assert.deepEqual(budgetGaps(api, { policies: [{ scopeType: 'company', scopeId: 'c1', isActive: false, amount: 0 }] }), api); // 無効の予算は無いのと同じ
  assert.deepEqual(budgetGaps([], { policies: [] }), []); // subscription の担当だけなら穴なし
  const inc = budgetIncidents({ activeIncidents: [{ id: 'i1', companyId: 'c1', scopeType: 'agent', scopeId: 'a4', scopeName: 'A', thresholdType: 'hard', amountLimit: 5000, amountObserved: 5100, approvalId: 'x', windowStart: 'w' }] });
  assert.deepEqual(inc, [{ id: 'i1', scopeType: 'agent', scopeId: 'a4', scopeName: 'A', thresholdType: 'hard', amountLimit: 5000, amountObserved: 5100 }]);
});

test('quota-windows: openai だけを決まった欄に絞り、error の文は渡さない・Credits は同じ source の時だけ比べる', () => {
  const q = pickQuota([{ provider: 'anthropic', ok: false, windows: [], error: 'Claude CLI /usage: Command failed' }, { provider: 'openai', ok: true, source: 'codex-wham', error: 'x', windows: [{ label: '5h limit', usedPercent: 87, resetsAt: '2026-11-19T14:24:27Z', extra: 1 }, { label: 'Credits', usedPercent: null, resetsAt: null, valueLabel: '$250.80 remaining' }] }]);
  assert.deepEqual(q, { provider: 'openai', ok: true, source: 'codex-wham', windows: [{ label: '5h limit', usedPercent: 87, resetsAt: '2026-11-19T14:24:27Z', valueLabel: null }, { label: 'Credits', usedPercent: null, resetsAt: null, valueLabel: '$250.80 remaining' }] });
  assert.equal(pickQuota([{ provider: 'anthropic', ok: false }]), null);
  const a = creditsReading(q);
  assert.deepEqual(a, { source: 'codex-wham', dollars: 250.8 });
  const b = { source: 'codex-wham', dollars: 249.1 }, rpc = { source: 'codex-rpc', dollars: 25080 };
  assert.equal(creditsSpent(a, b).spent, true);
  assert.equal(creditsSpent(b, a).spent, false); // 買い足し
  assert.equal(creditsSpent(a, rpc).spent, false); assert.deepEqual(creditsSpent(a, rpc).base, rpc); // source が替わったら比べず基準を替える
  assert.deepEqual(creditsSpent(a, null), { spent: false, base: a }); // 読めない回は前の基準
});

test('上限の失敗の run を選ぶ: provider_quota・実測 3 の文・下線の形・succeeded は言い切れる文だけ・retryNotBefore は詳細の resultJson から', () => {
  assert.equal(isQuotaRun({ status: 'failed', errorCode: 'provider_quota' }), true);
  assert.equal(isQuotaRun({ status: 'failed', error: "Claude run failed: subtype=success: You've hit your weekly limit · resets Nov 19, 9am (UTC)" }), true);
  assert.equal(isQuotaRun({ status: 'failed', error: 'codex: rate_limit_reached' }), true);
  assert.equal(isQuotaRun({ status: 'failed', error: 'rate_limit_error: 429 too many requests' }), false);
  assert.equal(isQuotaRun({ status: 'succeeded', resultJson: { summary: "You've hit your weekly limit" } }), true);
  assert.equal(isQuotaRun({ status: 'succeeded', resultJson: { summary: 'checked the usage limit settings' } }), false);
  assert.equal(retryNotBeforeOf({ resultJson: { retryNotBefore: '2026-11-17T23:24:14Z' } }), '2026-11-17T23:24:14.000Z');
  assert.equal(retryNotBeforeOf({ resultJson: { summary: 'x' } }), null);
});

test('ログの抜き出し: 1 万〜10 万字のログから rate_limit_event だけ・決まった欄だけ（本文・token の形・知らない欄は入らない）', async () => {
  const text = bigLog();
  assert.ok(text.length > 10_000 && text.length < 200_000, String(text.length));
  const r = await readRunLimits(logApi(text), 'r1');
  assert.equal(r.readError, null);
  assert.deepEqual(r.info, { ...INFO_REJECTED, utilization: null, surpassedThreshold: null, unifiedWindows: { seven_day: { utilization: 1, resetsAt: 1795078800, status: 'rejected', surpassedThreshold: 1 } } });
  const s = JSON.stringify(r);
  for (const bad of ['sk-ant', 'secretField', 'hello body', 'session_id', 'uuid', '本文']) assert.ok(!s.includes(bad), bad);
  // 知らない status・窓の形の悪い文字は 'unknown'
  assert.equal(pickRateLimit({ status: 'Weird Value', unifiedWindows: { 'BAD KEY': {}, five_hour: { utilization: 0.5, status: 'x y' } } }).unifiedWindows.five_hour.status, 'unknown');
  assert.deepEqual(Object.keys(pickRateLimit({ unifiedWindows: { 'BAD KEY': {}, five_hour: {} } }).unifiedWindows), ['five_hour']);
});

test('ログの抜き出し: 1 行が 2 つの record に割れた形・seq の順と届いた順が違う形でもつなげて取る・stderr を混ぜない', () => {
  const line = eventLine(INFO_ALLOWED), half = Math.floor(line.length / 2);
  // 届いた順: seq 3（後半）→ stderr（偽の event 行）→ seq 2（前半）→ seq 1（init）
  const pages = [rec(3, line.slice(half)) + rec(9, eventLine(INFO_REJECTED), 'stderr') + rec(2, line.slice(0, half)) + rec(1, '{"type":"system"}\n')];
  const sc = scanLogPages(pages, { final: true });
  assert.equal(sc.events.length, 1);
  assert.equal(sc.events[0].status, 'allowed'); // stderr の rejected は混ざらない
  // stderr が行の途中に挟まっても、stdout の行は割れない
  const p2 = [rec(1, line.slice(0, 10)) + rec(2, 'noise\n', 'stderr') + rec(3, line.slice(10))];
  assert.equal(scanLogPages(p2, { final: true }).events[0].status, 'allowed');
  // seq の無い record は届いた順
  const p3 = [`${JSON.stringify({ ts: 't', stream: 'stdout', chunk: line.slice(0, 5) })}\n${JSON.stringify({ ts: 't', stream: 'stdout', chunk: line.slice(5) })}\n`];
  assert.equal(scanLogPages(p3, { final: true }).events.length, 1);
});

test('ログの抜き出し: 切り詰めの印で行が消えた形は「読めない」・取れた行は使う', async () => {
  const marker = `\n${TRUNC_MARK} omitted 12345 chars]\n`;
  const lost = rec(1, `{"type":"system"}\n{"type":"assistant","message":"aaa${marker}bbb"}\n`) + rec(2, '{"type":"result"}\n');
  assert.equal((await readRunLimits(logApi(lost), 'r')).readError, 'truncated');
  const kept = rec(1, `${eventLine(INFO_REJECTED)}{"type":"assistant","message":"aaa${marker}bbb"}\n`);
  const r = await readRunLimits(logApi(kept), 'r');
  assert.equal(r.readError, null); assert.equal(r.info.status, 'rejected');
});

test('ログの抜き出し: nextOffset で続きを読む（byte で切れた半端な行・文字は次の page へ）・上限で「読めない」', async () => {
  const text = bigLog({ bodyLines: 300 }).replace('rate_limit_event', 'assistant_x') + rec(999, eventLine(INFO_ALLOWED)); // event は終わりの方
  const calls = [];
  const r = await readRunLimits(logApi(text, calls), 'r1', { pageBytes: 4097 });
  assert.ok(calls.length > 5, String(calls.length));
  assert.equal(r.readError, null); assert.equal(r.info.status, 'allowed');
  assert.equal(r.offset, Buffer.byteLength(text, 'utf8'));
  const over = await readRunLimits(logApi(text), 'r1', { pageBytes: 4096, maxBytes: 8192 });
  assert.equal(over.readError, 'too_large'); assert.equal(over.info, null);
});

test('ログの抜き出し: 行が無い・壊れた record・壊れた内側の行・404・口の失敗で落ちない', async () => {
  assert.equal((await readRunLimits(logApi(''), 'r')).readError, 'no_event');
  const broken = '{"ts":"x","stream":"stdout","chunk":\n' + rec(2, '{"type":"rate_limit_event","rate_limit_info":{"status":\n') + rec(3, '{"type":"result"}\n') + 'not json at all\n';
  assert.equal((await readRunLimits(logApi(broken), 'r')).readError, 'no_event');
  assert.equal((await readRunLimits(async () => { throw Object.assign(new Error('x'), { status: 404 }); }, 'r')).readError, 'no_log');
  assert.equal((await readRunLimits(async () => { throw new Error('ECONNREFUSED'); }, 'r')).readError, 'fetch_failed');
});

test('走っている run: 前の回の続き（offset と内側の半端な行）から読み、2 回に割れて届いた event を拾う', async () => {
  const line = eventLine({ ...INFO_ALLOWED, isUsingOverage: true });
  const first = rec(1, '{"type":"system"}\n') + rec(2, line.slice(0, 20));
  const r1 = await readRunLimits(logApi(first), 'r', { final: false });
  assert.equal(r1.info, null); assert.equal(r1.readError, null); // まだ event が無いのは「読めない」ではない
  assert.equal(r1.offset, Buffer.byteLength(first)); assert.equal(r1.inner, line.slice(0, 20));
  const all = first + rec(3, line.slice(20)) + rec(4, '{"type":"assistant"}\n');
  const calls = [];
  const r2 = await readRunLimits(logApi(all, calls), 'r', { final: false, offset: r1.offset, inner: r1.inner });
  assert.equal(calls[0].offset, r1.offset);
  assert.equal(r2.info.isUsingOverage, true);
});

// ---- 見回りで集める（createLimitsCollector）----
const CL_ENV = { CLAUDE_CODE_OAUTH_TOKEN: { type: 'secret_ref', secretId: 'sec-1' } };
function fakeCore({ agents, runs = [], details = {}, logs = {}, quota = null, overview = { policies: [], activeIncidents: [] } } = {}) {
  const st = { agents, runs, details, logs, quota, overview, calls: [], cancelled: [] };
  const json = (status, body) => ({ ok: status < 300, status, json: async () => body });
  st.fetchFn = async (url, init = {}) => {
    const u = new URL(url), p = u.pathname, m = init.method || 'GET';
    st.calls.push(`${m} ${p}${u.search}`);
    let x;
    if ((x = p.match(/^\/api\/companies\/[^/]+\/agents$/))) return json(200, st.agents);
    if (/\/budgets\/overview$/.test(p)) return json(200, st.overview);
    if (/\/costs\/quota-windows$/.test(p)) return st.quota ? json(200, st.quota) : json(500, {});
    if (/^\/api\/companies\/[^/]+\/heartbeat-runs$/.test(p)) return json(200, st.runs.slice(0, Number(u.searchParams.get('limit'))));
    if ((x = p.match(/^\/api\/heartbeat-runs\/([^/]+)\/log$/))) {
      const t = st.logs[x[1]]; if (t == null) return json(404, { error: 'Run log not found' });
      const off = Number(u.searchParams.get('offset')), lim = Number(u.searchParams.get('limitBytes'));
      const b = Buffer.from(t), end = Math.min(b.length, off + lim);
      return json(200, { content: b.subarray(off, end).toString(), ...(end < b.length ? { nextOffset: end } : {}) });
    }
    if ((x = p.match(/^\/api\/heartbeat-runs\/([^/]+)\/cancel$/)) && m === 'POST') { st.cancelled.push(x[1]); return json(200, {}); }
    if ((x = p.match(/^\/api\/heartbeat-runs\/([^/]+)$/))) return st.details[x[1]] ? json(200, st.details[x[1]]) : json(404, {});
    return json(404, {});
  };
  return st;
}
function collector(core, { state = {}, t0 = Date.parse('2026-11-17T22:30:00Z') } = {}) {
  const s = { aiLimits: defaultAiLimits(), aiLimitsRun: {}, ...state };
  const clock = { t: t0 };
  const c = createLimitsCollector({ pcUrl: 'http://127.0.0.1:3101', getState: () => s, updateState: fn => fn(s), fetchFn: core.fetchFn, now: () => clock.t, log: () => {} });
  return { c, s, clock };
}
const claudeAgents = [{ id: 'a1', adapterType: 'claude_local', status: 'idle', adapterConfig: { env: CL_ENV } }, { id: 'a2', adapterType: 'claude_local', status: 'idle', adapterConfig: { env: CL_ENV } }];
const run = (id, o = {}) => ({ id, agentId: 'a1', status: 'succeeded', createdAt: '2026-11-17T22:25:00Z', startedAt: '2026-11-17T22:25:00Z', finishedAt: '2026-11-17T22:26:00Z', errorCode: null, error: null, resultJson: { summary: 'done' }, ...o });

test('見回り: 契約の一覧・予算・上限の失敗の run（ログの resetsAt・retryNotBefore）・claudeLimits を tick の body に入れる', async () => {
  const core = fakeCore({
    agents: claudeAgents,
    runs: [run('r2', { finishedAt: '2026-11-17T22:27:00Z', startedAt: '2026-11-17T22:26:30Z' }), run('r1', { status: 'failed', errorCode: 'provider_quota', error: "Claude run failed: subtype=success: You've hit your weekly limit · resets Nov 19, 9am (UTC)", resultJson: null })],
    details: { r1: { id: 'r1', status: 'failed', resultJson: { retryNotBefore: '2026-11-17T23:24:14Z' } } },
    logs: { r1: bigLog(), r2: bigLog({ info: INFO_ALLOWED, bodyLines: 20 }) },
  });
  const { c, s } = collector(core);
  const b = await c.collect('c1');
  assert.deepEqual(b.aiLimits, defaultAiLimits());
  assert.deepEqual(b.contractGroups, [{ contract: 'anthropic:sec-1', provider: 'anthropic', agentIds: ['a1', 'a2'] }]);
  assert.deepEqual(b.budgetIncidents, []); assert.deepEqual(b.budgetGaps, []);
  assert.equal(b.quota, undefined); // ChatGPT の担当がいない会社には渡さない
  assert.equal(b.quotaRuns.complete, true);
  assert.deepEqual(b.quotaRuns.runs, [{ runId: 'r1', agentId: 'a1', status: 'failed', errorCode: 'provider_quota', error: "Claude run failed: subtype=success: You've hit your weekly limit · resets Nov 19, 9am (UTC)", retryNotBefore: '2026-11-17T23:24:14.000Z', finishedAt: '2026-11-17T22:26:00.000Z', logStatus: 'rejected', logOverageStatus: 'rejected', logResetsAt: 1795078800 }]);
  // retryNotBefore は上限の失敗の run だけ 1 本ずつ読む（r2 の詳細は読まない）
  assert.deepEqual(core.calls.filter(x => /^GET \/api\/heartbeat-runs\/[^/]+$/.test(x)), ['GET /api/heartbeat-runs/r1']);
  // claudeLimits は始まりが最も新しい run（r2・実測 5 の形）で、observedAt は run の startedAt
  assert.equal(b.claudeLimits.status, 'allowed'); assert.equal(b.claudeLimits.runId, 'r2');
  assert.equal(b.claudeLimits.observedAt, '2026-11-17T22:26:30.000Z'); assert.equal(b.claudeLimits.contract, 'anthropic:sec-1');
  assert.ok(!JSON.stringify(b).includes('sk-ant'));
  // 読んだ時刻は notify が受け取るまで進めない（commit で進む）
  assert.equal(s.aiLimitsRun.c1.lastRoundAt ?? null, null); assert.equal(s.aiLimitsRun.c1.pendingRoundAt, '2026-11-17T22:30:00.000Z');
  c.commit('c1');
  assert.equal(s.aiLimitsRun.c1.lastRoundAt, '2026-11-17T22:30:00.000Z'); assert.equal(s.aiLimitsRun.c1.pendingRoundAt, null);
});

test('最後に読めた値: 新しい run が無い回は前の値を observedAt のまま渡し「読めない」にしない・読もうとして失敗した回だけ readError', async () => {
  const core = fakeCore({ agents: claudeAgents, runs: [run('r1')], logs: { r1: bigLog({ info: INFO_ALLOWED, bodyLines: 10 }) } });
  const { c, clock } = collector(core);
  const b1 = await c.collect('c1');
  assert.equal(b1.claudeLimits.readError, undefined); assert.equal(b1.claudeLimits.observedAt, '2026-11-17T22:25:00.000Z');
  clock.t += 5 * 60_000;
  const b2 = await c.collect('c1');
  assert.equal(b2.claudeLimits.readError, undefined); assert.equal(b2.claudeLimits.observedAt, '2026-11-17T22:25:00.000Z'); assert.equal(b2.claudeLimits.status, 'allowed');
  assert.equal(core.calls.filter(x => x.startsWith('GET /api/heartbeat-runs/r1/log')).length, 1); // 終わった run は 2 回読まない
  // 新しい run のログに行が無い
  core.runs.unshift(run('r3', { startedAt: '2026-11-17T22:36:00Z', finishedAt: '2026-11-17T22:37:00Z' })); core.logs.r3 = rec(1, '{"type":"system"}\n');
  clock.t += 5 * 60_000;
  const b3 = await c.collect('c1');
  assert.equal(b3.claudeLimits.readError, 'no_event');
  assert.equal(b3.claudeLimits.observedAt, '2026-11-17T22:25:00.000Z'); // 最後に読めた値は持ったまま
  // ログの口が無い（404）
  core.runs.unshift(run('r4', { startedAt: '2026-11-17T22:41:00Z', finishedAt: '2026-11-17T22:42:00Z' }));
  clock.t += 5 * 60_000;
  assert.equal((await c.collect('c1')).claudeLimits.readError, 'no_log');
  // 一度も始まらなかった run と取り消された run に行が無くても「読めない」にしない（読めた値を隠さない・2026-11-22 amd64）
  core.runs.unshift(run('r5', { startedAt: null, status: 'cancelled', finishedAt: '2026-11-17T22:47:00Z' })); core.logs.r5 = rec(1, '');
  clock.t += 5 * 60_000;
  assert.equal((await c.collect('c1')).claudeLimits.readError, undefined, '始まらなかった run');
  core.runs.unshift(run('r6', { startedAt: '2026-11-17T22:51:00Z', status: 'cancelled', finishedAt: '2026-11-17T22:51:30Z' })); core.logs.r6 = rec(1, '{"type":"system"}\n');
  clock.t += 5 * 60_000;
  assert.equal((await c.collect('c1')).claudeLimits.readError, undefined, '取り消された run');
  // 始まらなかった run（取り消されていない・ログの口も無い 404）でも「読めない」にしない（レビュー P2・P3）
  core.runs.unshift(run('r7', { startedAt: null, status: 'failed', finishedAt: '2026-11-17T22:56:00Z' }));
  clock.t += 5 * 60_000;
  assert.equal((await c.collect('c1')).claudeLimits.readError, undefined, '始まらなかった run の 404');
  // 同じ回に、読めた run の後に始まらなかった run が終わっても、読めた run の値を渡す（レビュー P1）
  core.runs.unshift(run('r8', { startedAt: '2026-11-17T22:58:00Z', finishedAt: '2026-11-17T22:59:00Z' })); core.logs.r8 = bigLog({ info: { ...INFO_ALLOWED, utilization: 0.81 }, bodyLines: 3 });
  core.runs.unshift(run('r9', { startedAt: null, status: 'cancelled', finishedAt: '2026-11-17T22:59:30Z' })); core.logs.r9 = rec(1, '');
  clock.t += 5 * 60_000;
  const b9 = await c.collect('c1');
  assert.equal(b9.claudeLimits.readError, undefined); assert.equal(b9.claudeLimits.runId, 'r8', '読めた run の値');
  // 始まらずに上限で失敗した run（ログの口も無い）が同じ回にあっても、読めた run の値を渡す（再レビュー P3・noSignal の始まらなかった条件）
  core.runs.unshift(run('r10', { startedAt: '2026-11-17T23:03:00Z', finishedAt: '2026-11-17T23:04:00Z' })); core.logs.r10 = bigLog({ info: INFO_ALLOWED, bodyLines: 3 });
  core.runs.unshift(run('r11', { startedAt: null, status: 'failed', errorCode: 'provider_quota', error: "You've hit your weekly limit", finishedAt: '2026-11-17T23:04:30Z' }));
  clock.t += 5 * 60_000;
  const b11 = await c.collect('c1');
  assert.equal(b11.claudeLimits.readError, undefined, '始まらなかった上限の run で隠さない'); assert.equal(b11.claudeLimits.runId, 'r10');
});

test('run の読み直し: 前の回に running だった run を 1 本ずつ読み、一覧の奥にいても終わりと上限の失敗を拾う', async () => {
  const core = fakeCore({ agents: claudeAgents, runs: [run('long', { status: 'running', finishedAt: null, startedAt: '2026-11-17T22:21:00Z', createdAt: '2026-11-17T22:21:00Z' })], logs: { long: rec(1, '{"type":"system"}\n') } });
  const { c, s, clock } = collector(core);
  await c.collect('c1');
  assert.ok(s.aiLimitsRun.c1.running.long);
  // 次の回: 新しい run が 100 本並び、long は一覧に出てこない（createdAt の新しい順で奥にいる）
  core.runs = Array.from({ length: 100 }, (_, i) => run(`n${i}`, { agentId: 'zz', createdAt: '2026-11-17T22:34:00Z', finishedAt: '2026-11-17T22:31:00Z' }));
  core.details.long = { id: 'long', agentId: 'a1', status: 'failed', errorCode: 'provider_quota', error: "You've hit your weekly limit", startedAt: '2026-11-17T22:21:00Z', finishedAt: '2026-11-17T22:33:00Z', resultJson: { retryNotBefore: '2026-11-17T23:33:00Z' } };
  core.logs.long = rec(1, '{"type":"system"}\n') + rec(2, eventLine(INFO_REJECTED));
  clock.t += 5 * 60_000;
  const b = await c.collect('c1');
  const got = b.quotaRuns.runs.find(r => r.runId === 'long');
  assert.ok(got, JSON.stringify(b.quotaRuns));
  assert.equal(got.retryNotBefore, '2026-11-17T23:33:00.000Z'); assert.equal(got.logResetsAt, 1795078800);
  assert.equal(s.aiLimitsRun.c1.running.long, undefined);
  assert.deepEqual(core.calls.filter(x => x.startsWith('GET /api/heartbeat-runs/long') && !x.includes('/log')), ['GET /api/heartbeat-runs/long']); // 詳細は 1 回だけ
});

test('run の一覧の読み切り: 最も古い run が前回より新しい間は limit を倍に・1000 で届かなければ complete:false・次の回は 1000 から', async () => {
  const mk = (n, at) => Array.from({ length: n }, (_, i) => run(`x${i}`, { agentId: 'zz', createdAt: at, finishedAt: at }));
  const core = fakeCore({ agents: claudeAgents, runs: [...mk(250, '2026-11-17T22:29:00Z')] });
  const { c, s, clock } = collector(core);
  const b = await c.collect('c1');
  assert.deepEqual(core.calls.filter(x => x.includes('/heartbeat-runs?')).map(x => x.split('limit=')[1]), ['100', '200', '400']);
  assert.equal(b.quotaRuns.complete, true);
  core.calls.length = 0; core.runs = mk(1500, '2026-11-17T22:33:00Z'); clock.t += 5 * 60_000;
  const b2 = await c.collect('c1');
  assert.deepEqual(core.calls.filter(x => x.includes('/heartbeat-runs?')).map(x => x.split('limit=')[1]), ['100', '200', '400', '800', '1000']);
  assert.equal(b2.quotaRuns.complete, false); assert.equal(s.aiLimitsRun.c1.nextLimit, RUN_LIST_MAX);
  core.calls.length = 0; clock.t += 5 * 60_000;
  await c.collect('c1');
  assert.equal(core.calls.find(x => x.includes('/heartbeat-runs?')).split('limit=')[1], '1000');
  // 古い run が混じれば 1 回で終わる
  core.calls.length = 0; core.runs = [...mk(50, '2026-11-17T22:44:00Z'), ...mk(100, '2026-11-17T20:00:00Z')]; clock.t += 5 * 60_000;
  const b4 = await c.collect('c1');
  assert.equal(b4.quotaRuns.complete, true); assert.equal(core.calls.filter(x => x.includes('/heartbeat-runs?')).length, 1);
});

test('追加料金の取り消し: 走っている Claude の run のログに isUsingOverage:true → never（既定）と stop は cancel・allow は呼ばない・% の時は呼ばない', async () => {
  const mkCore = info => fakeCore({ agents: claudeAgents, runs: [run('live', { status: 'running', finishedAt: null, startedAt: '2026-11-17T22:28:00Z' })], logs: { live: rec(1, eventLine(info)) + rec(2, '{"type":"assistant"}\n') } });
  const over = { ...INFO_ALLOWED, isUsingOverage: true, overageStatus: 'allowed' };
  const c1 = mkCore(over), x1 = collector(c1);
  const b1 = await x1.c.collect('c1');
  assert.deepEqual(c1.cancelled, ['live']);
  assert.deepEqual(b1.claudeLimits.cancelledRunIds, ['live']); assert.equal(b1.claudeLimits.isUsingOverage, true); assert.equal(b1.claudeLimits.runId, 'live');
  // 次の回も走っていれば、同じ run は 2 回取り消さない
  x1.clock.t += 5 * 60_000; await x1.c.collect('c1');
  assert.deepEqual(c1.cancelled, ['live']);
  // allow（追加料金で続けてよい）: 取り消さない
  const c2 = mkCore(over), x2 = collector(c2, { state: { aiLimits: mergeAiLimits(defaultAiLimits(), { spend: 'allow' }).value } });
  const b2 = await x2.c.collect('c1'); assert.deepEqual(c2.cancelled, []); assert.deepEqual(b2.claudeLimits.cancelledRunIds, []); assert.equal(b2.aiLimits.spend, 'allow');
  // stop（使い始めたら止める）: 取り消す
  const c5 = mkCore(over), x5 = collector(c5, { state: { aiLimits: mergeAiLimits(defaultAiLimits(), { spend: 'stop' }).value } });
  await x5.c.collect('c1'); assert.deepEqual(c5.cancelled, ['live']);
  // flag OFF
  const c3 = mkCore(over), x3 = collector(c3, { state: { aiLimits: { ...defaultAiLimits(), guard: false } } });
  await x3.c.collect('c1'); assert.deepEqual(c3.cancelled, []);
  // % が高いだけ（追加料金ではない）
  const c4 = mkCore({ ...INFO_ALLOWED, unifiedWindows: { seven_day: { utilization: 0.99, resetsAt: 1795471200, status: 'allowed_warning' } } }), x4 = collector(c4);
  await x4.c.collect('c1'); assert.deepEqual(c4.cancelled, []);
});

test('読む run: 同じ回に、読めた run の後で Claude を呼ぶ前に失敗した run（行の無いログ）が終わっても、読めた run の使用率を渡す（2026-11-24 amd64 の e2e の 3）', async () => {
  const core = fakeCore({ agents: claudeAgents, runs: [
    run('late', { status: 'failed', startedAt: '2026-11-17T22:26:00Z', finishedAt: '2026-11-17T22:26:01Z' }),
    run('good', { startedAt: '2026-11-17T22:25:00Z', finishedAt: '2026-11-17T22:25:30Z' }),
  ], logs: { good: bigLog({ info: { ...INFO_ALLOWED, utilization: 0.81 }, bodyLines: 3 }), late: rec(1, '{"type":"system"}\n') } });
  const { c } = collector(core);
  const b = await c.collect('c1');
  assert.equal(b.claudeLimits.readError, undefined, '行の無い失敗の run で隠さない');
  assert.equal(b.claudeLimits.runId, 'good'); assert.equal(b.claudeLimits.utilization, 0.81);
  // 普通に終わった run の行の無いログは、今までどおり「読めない」
  const core2 = fakeCore({ agents: claudeAgents, runs: [
    run('late', { startedAt: '2026-11-17T22:26:00Z', finishedAt: '2026-11-17T22:26:30Z' }),
    run('good', { startedAt: '2026-11-17T22:25:00Z', finishedAt: '2026-11-17T22:25:30Z' }),
  ], logs: { good: bigLog({ info: INFO_ALLOWED, bodyLines: 3 }), late: rec(1, '{"type":"system"}\n') } });
  assert.equal((await collector(core2).c.collect('c1')).claudeLimits.readError, 'no_event');
});

test('追加料金の取り消し: Claude の取り消した id は、notify が追加料金の読みを受け取った回（commit）まで毎回載せる（2026-11-24 arm64 の e2e の 12）', async () => {
  const over = { ...INFO_ALLOWED, isUsingOverage: true, overageStatus: 'allowed' };
  const core = fakeCore({ agents: claudeAgents, runs: [run('live', { status: 'running', finishedAt: null, startedAt: '2026-11-17T22:28:00Z' })], logs: { live: rec(1, eventLine(over)) + rec(2, '{"type":"assistant"}\n') } });
  const { c, clock } = collector(core);
  assert.deepEqual((await c.collect('c1')).claudeLimits.cancelledRunIds, ['live']);
  // 取り消した回の /tick が上限の処理を終えなかった（commit なし）。次の回、run は取り消し済みで、走っている run は無い
  core.runs[0] = { ...core.runs[0], status: 'cancelled', finishedAt: '2026-11-17T22:29:00Z' };
  clock.t += 5 * 60_000;
  const b2 = await c.collect('c1');
  assert.deepEqual(b2.claudeLimits.cancelledRunIds, ['live'], 'commit の前は載せ続ける');
  c.commit('c1');
  clock.t += 5 * 60_000;
  assert.deepEqual((await c.collect('c1')).claudeLimits.cancelledRunIds, [], 'commit の後は載せない');
  assert.deepEqual(core.cancelled, ['live'], '2 回取り消さない');
});

test('独立レビュー 19 回目: 上限で失敗した run の行の無いログは「読めない」のまま・取り消した id は 24 時間で外す・終わった run が 10 本を超えたら新しい 10 本だけ読む', async () => {
  // P3-3: 上限に当たって失敗した run（行が無い）は形が変わった印として数える
  const core = fakeCore({ agents: claudeAgents, runs: [
    run('quota', { status: 'failed', errorCode: 'provider_quota', error: "You've hit your weekly limit", startedAt: '2026-11-17T22:26:00Z', finishedAt: '2026-11-17T22:26:01Z' }),
    run('good', { startedAt: '2026-11-17T22:25:00Z', finishedAt: '2026-11-17T22:25:30Z' }),
  ], logs: { good: bigLog({ info: INFO_ALLOWED, bodyLines: 3 }), quota: rec(1, '{"type":"system"}\n') } });
  assert.equal((await collector(core).c.collect('c1')).claudeLimits.readError, 'no_event');
  // P3-2: 渡せないまま 24 時間たった取り消しの id は外す
  const over = { ...INFO_ALLOWED, isUsingOverage: true, overageStatus: 'allowed' };
  const c2 = fakeCore({ agents: claudeAgents, runs: [run('live', { status: 'running', finishedAt: null, startedAt: '2026-11-17T22:28:00Z' })], logs: { live: rec(1, eventLine(over)) } });
  const x2 = collector(c2);
  assert.deepEqual((await x2.c.collect('c1')).claudeLimits.cancelledRunIds, ['live']);
  c2.runs.length = 0; c2.logs = {};
  x2.clock.t += 60 * 60_000;
  assert.deepEqual((await x2.c.collect('c1')).claudeLimits.cancelledRunIds, [], '新しい run が無い回は前の値に id を載せない');
  x2.clock.t += 24 * 3600_000;
  await x2.c.collect('c1');
  assert.equal(x2.s.aiLimitsRun.c1.claudeUnsent.length, 0, '24 時間で外す');
  // P3-A: 期限は id ごと。後の取り消しで前の id の期限は延びない
  const c4 = fakeCore({ agents: claudeAgents, runs: [run('A', { status: 'running', finishedAt: null, startedAt: '2026-11-17T22:28:00Z' })], logs: { A: rec(1, eventLine(over)) } });
  const x4 = collector(c4);
  await x4.c.collect('c1');
  x4.clock.t += 23 * 3600_000;
  c4.runs.splice(0, c4.runs.length, run('B', { status: 'running', finishedAt: null, startedAt: new Date(x4.clock.t - 60_000).toISOString() })); c4.logs = { B: rec(1, eventLine(over)) };
  assert.deepEqual((await x4.c.collect('c1')).claudeLimits.cancelledRunIds, ['A', 'B']);
  x4.clock.t += 2 * 3600_000; c4.runs.length = 0;
  await x4.c.collect('c1');
  assert.deepEqual(x4.s.aiLimitsRun.c1.claudeUnsent, ['B'], 'A は自分の 24 時間で外れ、B は残る');
  // 独立レビュー 31 回目 P3-3: Credits の減りで取り消した codex の run の id も 24 時間で外す。前の版の記録（時刻の無い id）は今から数える
  const c5 = fakeCore({ agents: claudeAgents, runs: [] });
  const x5 = collector(c5);
  x5.s.aiLimitsRun = { c1: { creditsUnsent: ['legacy'] } };
  await x5.c.collect('c1');
  assert.deepEqual(x5.s.aiLimitsRun.c1.creditsUnsent, ['legacy'], '前の版の id は今から数えて残す');
  assert.ok(Number.isFinite(x5.s.aiLimitsRun.c1.creditsUnsentAt?.legacy), '時刻を付ける');
  x5.clock.t += 25 * 3600_000;
  await x5.c.collect('c1');
  assert.deepEqual(x5.s.aiLimitsRun.c1.creditsUnsent, [], '24 時間で外す');
  // P3-6: 終わった run が 12 本ある回は、新しい方から 10 本のログだけを読む
  const runs = Array.from({ length: 12 }, (_, i) => run(`m${i}`, { startedAt: `2026-11-17T22:25:${String(i * 2).padStart(2, '0')}Z`, finishedAt: `2026-11-17T22:25:${String(i * 2 + 1).padStart(2, '0')}Z` }));
  const c3 = fakeCore({ agents: claudeAgents, runs: runs.reverse(), logs: Object.fromEntries(runs.map(r => [r.id, bigLog({ info: INFO_ALLOWED, bodyLines: 1 })])) });
  await collector(c3).c.collect('c1');
  const read = new Set(c3.calls.filter(x => /\/heartbeat-runs\/m\d+\/log/.test(x)).map(x => x.match(/m\d+/)[0]));
  assert.equal(read.size, 10); assert.ok(!read.has('m0') && !read.has('m1'), '古い 2 本は読まない');
});

test('追加料金の取り消し: ChatGPT は同じ source で Credits が減った回だけ、同じ契約の走っている codex の run を取り消す', async () => {
  const agents = [{ id: 'o1', adapterType: 'codex_local', status: 'idle', adapterConfig: { env: {} } }, { id: 'o2', adapterType: 'codex_local', status: 'idle', adapterConfig: { env: { OPENAI_API_KEY: 'x' } } }, ...claudeAgents];
  const qw = (source, v) => [{ provider: 'openai', ok: true, source, windows: [{ label: '5h limit', usedPercent: 50, resetsAt: '2026-11-19T14:24:27Z' }, { label: 'Credits', usedPercent: null, resetsAt: null, valueLabel: v }] }];
  const core = fakeCore({ agents, quota: qw('codex-wham', '$250.80 remaining'), runs: [run('cx', { agentId: 'o1', status: 'running', finishedAt: null }), run('api', { agentId: 'o2', status: 'running', finishedAt: null }), run('cl', { agentId: 'a1', status: 'running', finishedAt: null })], logs: { cl: rec(1, eventLine(INFO_ALLOWED)) } });
  const { c, s, clock } = collector(core);
  const b1 = await c.collect('c1');
  assert.deepEqual(b1.quota.cancelledRunIds, []); assert.equal(b1.quota.source, 'codex-wham');
  core.quota = qw('codex-rpc', '$25080.00 remaining'); clock.t += 5 * 60_000; // source が替わった回は比べない
  assert.deepEqual((await c.collect('c1')).quota.cancelledRunIds, []);
  core.quota = qw('codex-rpc', '$25070.00 remaining'); clock.t += 5 * 60_000;
  const b3 = await c.collect('c1');
  assert.deepEqual(core.cancelled, ['cx']); // API キーの担当と Claude の run は取り消さない
  assert.deepEqual(b3.quota.cancelledRunIds, ['cx']);
  // notify が上限の処理を読み終えない回（commit なし）が続いても、取り消した id を載せ続ける（2026-11-21 arm64 の e2e の 12・独立レビュー）
  core.quota = qw('codex-rpc', '$25070.00 remaining'); clock.t += 5 * 60_000;
  assert.deepEqual((await c.collect('c1')).quota.cancelledRunIds, ['cx']);
  assert.deepEqual(core.cancelled, ['cx'], '取り消しは 1 回だけ');
  // notify が Credits を比べられない回（quota-windows が答えない）の commit では外さない（独立レビュー r2 の P3-1）
  core.quota = null; clock.t += 5 * 60_000;
  await c.collect('c1'); c.commit('c1');
  core.quota = qw('codex-rpc', '$25070.00 remaining'); clock.t += 5 * 60_000;
  assert.deepEqual((await c.collect('c1')).quota.cancelledRunIds, ['cx'], 'Credits を比べなかった回の commit では外さない');
  // 一覧が読めなかった回（pendingRoundAt なし）の commit: 読んだ時刻は進めず、渡した id は外す（r2 の P3-3）
  const keepRuns = core.runs; core.runs = null; clock.t += 5 * 60_000;
  const before = s.aiLimitsRun.c1.lastRoundAt;
  await c.collect('c1');
  assert.equal(s.aiLimitsRun.c1.pendingRoundAt, null, '一覧が読めない回');
  c.commit('c1');
  assert.equal(s.aiLimitsRun.c1.lastRoundAt, before, '読んだ時刻は進めない');
  core.runs = keepRuns; clock.t += 5 * 60_000;
  assert.deepEqual((await c.collect('c1')).quota.cancelledRunIds, [], 'commit の後は載せない');
  // allow に替えた後は、同じ source で減っても取り消さない
  s.aiLimits = mergeAiLimits(s.aiLimits, { spend: 'allow' }).value;
  core.quota = qw('codex-rpc', '$25060.00 remaining'); clock.t += 5 * 60_000;
  assert.deepEqual((await c.collect('c1')).quota.cancelledRunIds, []); assert.deepEqual(core.cancelled, ['cx']);
  s.aiLimits = mergeAiLimits(s.aiLimits, { spend: 'never' }).value;
  core.quota = qw('codex-rpc', '$25070.00 remaining'); clock.t += 5 * 60_000; // 減っていない回は取り消さない
  assert.deepEqual((await c.collect('c1')).quota.cancelledRunIds, []);
  // quota-windows が答えない回は ok:false（「読めません」に倒す）
  core.quota = null; clock.t += 5 * 60_000;
  assert.deepEqual((await c.collect('c1')).quota, { provider: 'openai', ok: false, source: null, windows: [], cancelledRunIds: [] });
});

test('見回りの係: 上限の値は知らせの tick にだけ足す（図書室には足さない）', async () => {
  const dir = tmp(), core = fakeCore({ agents: claudeAgents, runs: [] });
  const ticks = [];
  const fetchFn = async (url, init = {}) => {
    const u = new URL(url);
    if (u.pathname === '/api/companies') return { ok: true, status: 200, json: async () => [{ id: 'c1' }] };
    if (u.pathname.endsWith('/api/tick')) { ticks.push({ path: u.pathname, body: JSON.parse(init.body) }); return { ok: true, status: 200, json: async () => ({}) }; }
    return core.fetchFn(url, init);
  };
  const s = { done: true, lang: 'ja', aiLimits: defaultAiLimits(), aiLimitsRun: {} };
  const limits = createLimitsCollector({ pcUrl: 'http://127.0.0.1:3101', getState: () => s, updateState: fn => fn(s), fetchFn, log: () => {} });
  const r = createRounds({ pcUrl: 'http://127.0.0.1:3101', dataDir: dir, getState: () => s, installed: () => ['aioffice.notify', 'aioffice.library'], fetchFn, limits });
  await r.runOnce();
  const n = ticks.find(x => x.path.includes('aioffice.notify')), l = ticks.find(x => x.path.includes('aioffice.library'));
  assert.equal(n.body.lang, 'ja'); assert.deepEqual(n.body.aiLimits, defaultAiLimits()); assert.ok(Array.isArray(n.body.contractGroups)); assert.ok(n.body.quotaRuns);
  assert.deepEqual(l.body, { lang: 'ja' });
});

// ---- 起動係の口 ----
const listen = (srv, host = '127.0.0.1') => new Promise(r => srv.listen(0, host, () => r(srv.address().port)));
function req(port, method, p, { body, cookie, connectHost = '127.0.0.1' } = {}) {
  return new Promise((resolve, reject) => {
    const headers = { host: `127.0.0.1:${port}` }; if (cookie) headers.cookie = cookie;
    const data = body == null ? null : JSON.stringify(body); if (data) { headers['content-type'] = 'application/json'; headers['content-length'] = Buffer.byteLength(data); }
    const r = http.request({ host: connectHost, port, method, path: p, headers }, res => { let t = ''; res.on('data', c => { t += c; }); res.on('end', () => { let j = null; try { j = JSON.parse(t); } catch { /* 文字 */ } resolve({ status: res.statusCode, headers: res.headers, json: j }); }); });
    r.on('error', reject); if (data) r.write(data); r.end();
  });
}
async function launcher(opts = {}, host = '127.0.0.1') {
  const dir = tmp();
  const { server, store } = createLauncher({ dataDir: path.join(dir, 'aioffice'), paperclipUrl: 'http://127.0.0.1:9', codexHome: path.join(dir, 'codex-home'), ...opts });
  const port = await listen(server, host);
  const own = await req(port, 'POST', '/setup/api/owner', { body: { password: 'long enough' } });
  return { server, store, port, cookie: own.headers['set-cookie'][0].split(';')[0], dir };
}

test('設定の口 POST /setup/api/ai-limits: 持ち主の cookie だけ・state.json に残り起動し直しても消えない・形の悪い値は 400', async () => {
  const L = await launcher();
  try {
    assert.equal((await req(L.port, 'POST', '/setup/api/ai-limits', { body: { guard: false } })).status, 401);
    // 追加料金の扱いも cookie の無い要求は断り、値は変わらない
    assert.equal((await req(L.port, 'POST', '/setup/api/ai-limits', { body: { spend: 'allow' } })).status, 401);
    assert.equal((await req(L.port, 'GET', '/setup/api/ai-limits')).status, 401);
    assert.equal((await req(L.port, 'GET', '/setup/api/ai-limits', { cookie: L.cookie })).json.aiLimits.spend, 'never');
    const g = await req(L.port, 'GET', '/setup/api/ai-limits', { cookie: L.cookie });
    assert.deepEqual(g.json.aiLimits, defaultAiLimits());
    const ok = await req(L.port, 'POST', '/setup/api/ai-limits', { cookie: L.cookie, body: { guard: false, openai: { week: { stopPct: 90 } } } });
    assert.equal(ok.status, 200); assert.equal(ok.json.aiLimits.guard, false); assert.equal(ok.json.aiLimits.openai.week.stopPct, 90);
    assert.equal((await req(L.port, 'POST', '/setup/api/ai-limits', { cookie: L.cookie, body: { openai: { week: { stopPct: 'x' } } } })).status, 400);
    const saved = JSON.parse(fs.readFileSync(path.join(L.dir, 'aioffice', 'state.json'), 'utf8'));
    assert.equal(saved.aiLimits.guard, false); assert.equal(saved.aiLimits.openai.week.stopPct, 90);
    // 追加料金の扱い: 3 つのどれかだけ受け、state.json に残る
    assert.equal((await req(L.port, 'POST', '/setup/api/ai-limits', { cookie: L.cookie, body: { spend: 'sometimes' } })).status, 400);
    const sp = await req(L.port, 'POST', '/setup/api/ai-limits', { cookie: L.cookie, body: { spend: 'allow' } });
    assert.equal(sp.status, 200); assert.equal(sp.json.aiLimits.spend, 'allow'); assert.equal(sp.json.aiLimits.openai.week.stopPct, 90);
    assert.equal(JSON.parse(fs.readFileSync(path.join(L.dir, 'aioffice', 'state.json'), 'utf8')).aiLimits.spend, 'allow');
  } finally { L.server.close(); }
});

test('試験用の差し替え口: CI の env が無い時は 404・env があっても loopback でなければ 404・両方の時だけ効く', async t => {
  assert.equal(testHooksEnabled({}), false); assert.equal(testHooksEnabled({ [TEST_HOOK_ENV]: '1' }), true); assert.equal(testHooksEnabled({ [TEST_HOOK_ENV]: 'true' }), false);
  for (const a of ['127.0.0.1', '::1', '::ffff:127.0.0.1']) assert.equal(isLoopback(a), true, a);
  for (const a of ['10.0.0.5', '172.17.0.1', '::ffff:192.168.1.5', '', undefined]) assert.equal(isLoopback(a), false, String(a));
  // env が無い（既定）: 口は無いのと同じ 404（cookie があっても）
  const off = await launcher({ limitOverrides: createLimitOverrides(), testHooks: false });
  try {
    const r = await req(off.port, 'POST', '/setup/api/test/ai-limits', { cookie: off.cookie, body: { quotaWindows: [] } });
    assert.equal(r.status, 404); assert.deepEqual(r.json, { error: 'not_found' });
  } finally { off.server.close(); }
  // env あり・loopback: cookie があれば効く
  const ov = createLimitOverrides();
  const on = await launcher({ limitOverrides: ov, testHooks: true }, '0.0.0.0');
  try {
    assert.equal((await req(on.port, 'POST', '/setup/api/test/ai-limits', { body: {} })).status, 401);
    const r = await req(on.port, 'POST', '/setup/api/test/ai-limits', { cookie: on.cookie, body: { quotaWindows: [{ provider: 'openai', ok: true }], logs: { r1: 'x\n' } } });
    assert.equal(r.status, 200); assert.equal(ov.get().quotaWindows.length, 1); assert.equal(ov.get().logs.r1, 'x\n');
    // env あり・loopback でない: 404
    const lan = Object.values(os.networkInterfaces()).flat().find(i => i && i.family === 'IPv4' && !i.internal);
    if (!lan) { t.diagnostic('loopback でない住所が無いので、住所の判定は isLoopback の試験で代える'); return; }
    let r2; try { r2 = await req(on.port, 'POST', '/setup/api/test/ai-limits', { cookie: on.cookie, body: { clear: true }, connectHost: lan.address }); }
    catch (e) { t.diagnostic(`loopback でない住所につながらない（${e.code}）`); return; }
    assert.equal(r2.status, 404); assert.equal(ov.get().quotaWindows.length, 1); // 差し替えは変わらない
  } finally { on.server.close(); }
});

test('差し替えた値で見回りが読む: quota-windows・run の一覧・run のログ（offset と nextOffset も同じ形）', async () => {
  const ov = createLimitOverrides();
  ov.set({ quotaWindows: [{ provider: 'openai', ok: true, source: 'codex-wham', windows: [{ label: 'Weekly limit', usedPercent: 96, resetsAt: '2026-11-20T00:00:00Z' }] }], heartbeatRuns: [run('s1', { status: 'failed', errorCode: 'provider_quota' })], runs: { s1: { id: 's1', resultJson: {} } }, logs: { s1: bigLog() } });
  const core = fakeCore({ agents: [{ id: 'o1', adapterType: 'codex_local', status: 'idle', adapterConfig: { env: {} } }, ...claudeAgents] });
  const s = { aiLimits: defaultAiLimits(), aiLimitsRun: {} };
  const c = createLimitsCollector({ pcUrl: 'http://127.0.0.1:3101', getState: () => s, updateState: fn => fn(s), fetchFn: core.fetchFn, now: () => Date.parse('2026-11-17T22:30:00Z'), overrides: ov, log: () => {} });
  const b = await c.collect('c1');
  assert.equal(b.quota.windows[0].usedPercent, 96);
  assert.equal(b.quotaRuns.runs[0].runId, 's1'); assert.equal(b.quotaRuns.runs[0].logStatus, 'rejected');
  assert.ok(!core.calls.some(x => x.includes('quota-windows') || x.includes('heartbeat-runs')));
  ov.set({ clear: true }); assert.equal(ov.get().quotaWindows, null);
});

// ---- 実装レビュー r1 の指摘の試験（L2・L3・L4・L6）----

test('L2: 知らせるだけの予算（hardStopEnabled:false）は予算ありに数えない', () => {
  const api = [{ agentId: 'a3', kind: 'anthropic_api_key' }];
  assert.deepEqual(budgetGaps(api, { policies: [{ scopeType: 'company', scopeId: 'c1', isActive: true, amount: 5000, hardStopEnabled: false }] }), api);
  assert.deepEqual(budgetGaps(api, { policies: [{ scopeType: 'agent', scopeId: 'a3', isActive: true, amount: 5000, hardStopEnabled: false }] }), api);
  assert.deepEqual(budgetGaps(api, { policies: [{ scopeType: 'agent', scopeId: 'a3', isActive: true, amount: 5000, hardStopEnabled: true }] }), []);
});

test('L3: 窓は rejected で overageStatus が allowed 系の run も追加料金として取り消す・見回りの間に終わった追加料金の run を claudeLimits に選ぶ', async () => {
  const rejOver = { ...INFO_REJECTED, overageStatus: 'allowed', isUsingOverage: false };
  const c1 = fakeCore({ agents: claudeAgents, runs: [run('live', { status: 'running', finishedAt: null, startedAt: '2026-11-17T22:28:00Z' })], logs: { live: rec(1, eventLine(rejOver)) } });
  const x1 = collector(c1);
  await x1.c.collect('c1');
  assert.deepEqual(c1.cancelled, ['live']);
  // 追加料金の run（終わった）と、後に始まった普通の run（走っている）: 追加料金の run を選ぶ
  const over = { ...INFO_ALLOWED, isUsingOverage: true, overageStatus: 'allowed' };
  const c2 = fakeCore({ agents: claudeAgents, runs: [run('live', { status: 'running', finishedAt: null, startedAt: '2026-11-17T22:28:00Z' }), run('od', { startedAt: '2026-11-17T22:25:00Z', finishedAt: '2026-11-17T22:27:00Z' })], logs: { live: rec(1, eventLine(INFO_ALLOWED)), od: rec(1, eventLine(over)) } });
  const b2 = await collector(c2).c.collect('c1');
  assert.deepEqual([b2.claudeLimits.runId, b2.claudeLimits.isUsingOverage], ['od', true]);
});

test('L4: succeeded の run は、要約そのものが上限の文の時だけ（長い要約の中で引いただけでは拾わない）', () => {
  assert.equal(isQuotaRun({ status: 'succeeded', resultJson: { summary: "You've hit your weekly limit · resets Nov 19, 9am (UTC)" } }), true);
  assert.equal(isQuotaRun({ status: 'succeeded', resultJson: { summary: `Wrote the FAQ. ${'x'.repeat(100)} The page now explains: "You've hit your weekly limit" and what to do.` } }), false);
  assert.equal(isQuotaRun({ status: 'failed', error: `${'x'.repeat(400)} You've hit your weekly limit` }), true, '失敗の run は今までどおり');
});

test('L6: notify へ渡す run の error は起動係の側でも伏せる・差し替え口は __proto__ などの key を捨てる', async () => {
  assert.equal(redactRunText(`usage limit reached ${TOKEN_LIKE} API_KEY=abc123`), 'usage limit reached [hidden] API_KEY=[hidden]');
  const core = fakeCore({ agents: claudeAgents, runs: [run('q1', { status: 'failed', errorCode: 'provider_quota', error: `usage limit reached ${TOKEN_LIKE}` })] });
  const b = await collector(core).c.collect('c1');
  const r = b.quotaRuns.runs.find(x => x.runId === 'q1');
  assert.ok(r && !r.error.includes(TOKEN_LIKE) && r.error.includes('[hidden]'));
  const ov = createLimitOverrides();
  const res = ov.set(JSON.parse('{"runs":{"__proto__":{"polluted":1},"r1":{"status":"failed"}},"logs":{"__proto__":"x","r1":"y"}}'));
  assert.deepEqual([res.runs, res.logs], [1, 1]);
  assert.equal(Object.getPrototypeOf(ov.get().runs), Object.prototype);
  assert.equal(({}).polluted, undefined);
});

test('見回りの係: notify の tick が失敗した回は、上限の値の読んだ時刻を進めない（次の回で同じ範囲を読み直す）', async () => {
  const dir = tmp(), core = fakeCore({ agents: claudeAgents, runs: [] });
  let tickOk = false, tickBody = { limits: {} };
  const fetchFn = async (url, init = {}) => {
    const u = new URL(url);
    if (u.pathname === '/api/companies') return { ok: true, status: 200, json: async () => [{ id: 'c1' }] };
    if (u.pathname.endsWith('/api/tick')) return tickOk ? { ok: true, status: 200, json: async () => tickBody } : { ok: false, status: 500, json: async () => ({ error: 'down' }) };
    return core.fetchFn(url, init);
  };
  const s = { done: true, lang: 'ja', aiLimits: defaultAiLimits(), aiLimitsRun: {} };
  const limits = createLimitsCollector({ pcUrl: 'http://127.0.0.1:3101', getState: () => s, updateState: fn => fn(s), fetchFn, log: () => {} });
  const r = createRounds({ pcUrl: 'http://127.0.0.1:3101', dataDir: dir, getState: () => s, installed: () => ['aioffice.notify'], fetchFn, limits });
  await r.runOnce();
  assert.equal(s.aiLimitsRun.c1.lastRoundAt ?? null, null, 'tick が失敗したのに読んだ時刻が進んだ');
  // notify は上限の処理が失敗した回・飛ばした回も 200 を返す。その回も進めない（独立レビュー r4 の中 1）
  tickOk = true;
  for (const b of [{ limitsError: 'x' }, { partial: true }, {}, { limits: {}, limitsError: 'x' }]) {
    tickBody = b; await r.runOnce();
    assert.equal(s.aiLimitsRun.c1.lastRoundAt ?? null, null, `上限の処理を読み終えていない回（${JSON.stringify(b)}）に読んだ時刻が進んだ`);
  }
  tickBody = { limits: {} };
  await r.runOnce();
  assert.ok(s.aiLimitsRun.c1.lastRoundAt, 'tick が通った回に読んだ時刻が進まない');
});
