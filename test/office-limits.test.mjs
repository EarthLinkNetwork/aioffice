// office の画面の AI の使用量の上限（範囲: docs/review/2026-11-18-ai-usage-limit-scope.md（開発元の記録）の 7 の 7・8 節の unit の画面の物）:
// 帯（ai_limit_paused・ai_quota_unreadable・ai_overage_enabled・budget_unset の出る・出ない）・受信箱の「再開」・予算の画面へのつながり・
// 担当の欄の「AI の上限で停止中」・「AI の契約」の欄の使用率と上限の設定
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { register } from 'node:module';
import { DICT, translator } from '../plugins/office/src/i18n.mjs';
import { bannerItems, bannerText, bannerLook, BANNER_LOOK, limitGroup, limitPauseOf, resumeLimitGroup, usageRows, limitsBody, limitsForm, createApi } from '../plugins/office/src/api.mjs';

register('./fixtures/react-alias-hooks.mjs', import.meta.url);
const R = await import('./fixtures/mini-react.mjs');
const P = await import('../plugins/office/src/panels.mjs');
const h = R.createElement;
const tEn = translator('en'), tJa = translator('ja');
const click = node => node.props.onClick({ preventDefault() {}, currentTarget: node });
const deferred = () => { let resolve, reject; const p = new Promise((a, b) => { resolve = a; reject = b; }); return { p, resolve, reject }; };

const L = { timeZone: 'Asia/Tokyo', rounds: { 'aioffice.notify': { late: false } } };
const PAT = { a1: '2026-11-17T22:21:00.001Z', a2: '2026-11-17T22:21:00.002Z', o1: '2026-11-17T23:00:00.000Z' };
// 本体の担当の読み（再開の前の確かめ・M3）: 記録と同じ pausedAt で paused
const getAgentSame = async id => ({ id, status: 'paused', pausedAt: PAT[id] });
const PAUSES = [
  { agentId: 'a1', contract: 'anthropic:ref-1', reason: 'provider_quota', untilAt: '2026-11-19T09:00:00.000Z', agentPausedAt: PAT.a1, sourceAgentId: 'a1' },
  { agentId: 'a2', contract: 'anthropic:ref-1', reason: 'provider_quota', untilAt: '2026-11-19T09:00:00.000Z', agentPausedAt: PAT.a2, sourceAgentId: 'a1' },
  { agentId: 'o1', contract: 'openai', reason: 'credits', untilAt: null, agentPausedAt: PAT.o1, sourceAgentId: null },
];
const notice = (kind, originId, o = {}) => ({ key: `${kind}-${originId}`.padEnd(32, '0').slice(0, 32), kind, originId, title: `${kind} ${originId}`, body: null, createdAt: '2026-11-17T22:30:00Z', readAt: null, ...o });

test('帯: 止めている担当が 1 人以上で ai_limit_paused（赤・押すと受信箱）、0 人なら出ない・読んだ知らせでも出る', () => {
  assert.deepEqual(bannerItems({ notices: [], launcher: L }), []);
  assert.deepEqual(bannerItems({ notices: [], launcher: L, limits: { pauses: [] } }), []);
  // 知らせ（既読）と記録の担当の和で数える（予算で止まった担当の知らせも同じ帯・G7）
  const b = bannerItems({ notices: [notice('agent_paused_limit', 'a1', { readAt: 'x' }), notice('agent_paused_limit', 'budget-scope')], launcher: L, limits: { pauses: PAUSES } });
  assert.deepEqual(b[0], { key: 'ai_limit_paused', n: 4 });
  assert.deepEqual(bannerLook('ai_limit_paused'), { tone: 'alert', to: 'inbox' });
  assert.equal(bannerText(tEn, b[0]), 'AI usage limit: 4 employees are paused. Open the inbox to resume them.');
  assert.equal(bannerText(tJa, b[0]), 'AI の上限で 4 人を止めています。受信箱から再開できます。');
  // 止めた担当の帯は「待っている件」より上
  assert.deepEqual(bannerItems({ pending: 1, notices: [], launcher: L, limits: { pauses: PAUSES.slice(0, 1) } }).map(x => x.key), ['ai_limit_paused', 'waiting']);
});

test('帯: 読めない（ai_quota_unreadable）・追加料金で続く設定（ai_overage_enabled）・予算が未設定（budget_unset）は案内の色で押せない・無ければ出ない', () => {
  assert.deepEqual(bannerItems({ notices: [notice('ai_quota_unreadable', 'anthropic', { readAt: 'x' })], launcher: L }).map(x => x.key), ['ai_quota_unreadable'], '閉じても（読んでも）出る・G2a');
  assert.deepEqual(bannerItems({ notices: [notice('ai_limit_near', 'openai:week')], launcher: L }).map(x => x.key), ['waiting'], '読めれば出ない');
  assert.deepEqual(bannerItems({ notices: [], launcher: L, limits: { overageEnabled: true } }).map(x => x.key), ['ai_overage_enabled']);
  assert.deepEqual(bannerItems({ notices: [], launcher: L, limits: { overageEnabled: false } }), []);
  assert.deepEqual(bannerItems({ notices: [notice('budget_unset', 'gaps:2', { readAt: 'x' })], launcher: L }).map(x => x.key), ['budget_unset']);
  for (const k of ['ai_quota_unreadable', 'ai_overage_enabled', 'budget_unset']) assert.deepEqual(bannerLook(k), { tone: 'info' }, k);
  // 知らせの plugin が無い所（null）では出さない
  assert.deepEqual(bannerItems({ notices: null, launcher: null, limits: null }), []);
  // 帯の key は全部、英日の辞書にある
  for (const k of Object.keys(BANNER_LOOK)) { assert.ok(`banner_${k}` in DICT.en, `en.banner_${k}`); assert.ok(`banner_${k}` in DICT.ja, `ja.banner_${k}`); }
});

test('画面: 押せる帯は Button の分岐（生の button を書かない）・赤い帯は alert の形・案内の色は status', () => {
  const ui = readFileSync(new URL('../plugins/office/src/ui.mjs', import.meta.url), 'utf8');
  assert.match(ui, /if \(look\.to\) return h\(Button, \{ key: b\.key, kind: look\.tone === 'alert' \? 'alert' : 'banner'/);
  assert.match(ui, /bannerItems\(\{ pending, notices: notices\.data, limits,/);
  const controls = readFileSync(new URL('../plugins/office/src/controls.mjs', import.meta.url), 'utf8');
  assert.match(controls, /alert: 'aio-btn aio-btn-banner aio-btn-alert'/);
  assert.match(controls, /\.aio-banner-info \{/);
});

test('再開の組: 同じ契約の記録の担当を全員・記録の無い担当（予算・人が止めた）は null・担当の欄の期限', () => {
  assert.deepEqual(limitGroup({ pauses: PAUSES }, 'a2'), ['a2', 'a1']);
  assert.deepEqual(limitGroup({ pauses: PAUSES }, 'o1'), ['o1']);
  assert.equal(limitGroup({ pauses: PAUSES }, 'budget-scope'), null);
  assert.equal(limitGroup(null, 'a1'), null);
  assert.deepEqual(limitGroup({ pauses: [{ agentId: 'x', contract: null }] }, 'x'), ['x']);
  assert.deepEqual(limitPauseOf({ pauses: PAUSES }, 'a1'), { reason: 'provider_quota', untilAt: '2026-11-19T09:00:00.000Z' });
  assert.deepEqual(limitPauseOf({ pauses: PAUSES }, 'o1'), { reason: 'credits', untilAt: null });
  assert.equal(limitPauseOf({ pauses: PAUSES }, 'zz'), null);
});

test('再開: 担当ごとに本体の resume → 戻せた担当だけ notify の /limit/resume。本体が断った担当は記録を閉じない', async () => {
  const calls = [];
  const api = {
    getAgent: getAgentSame,
    resumeAgent: async id => { calls.push(['resume', id]); if (id === 'a2') throw Object.assign(new Error('x'), { status: 409 }); return {}; },
    limitResume: async (c, ids) => { calls.push(['close', c, ids]); return { closed: ids, stillPaused: [] }; },
  };
  const r = await resumeLimitGroup({ api, companyId: 'c1', agentIds: ['a1', 'a2'], limits: { pauses: PAUSES } });
  assert.deepEqual(calls, [['resume', 'a1'], ['resume', 'a2'], ['close', 'c1', ['a1']]]);
  assert.deepEqual(r, { resumed: ['a1'], failed: [{ id: 'a2', status: 409 }], changed: [], closed: ['a1'], stillPaused: [] });
  // 全員断られた時は notify を呼ばない
  calls.length = 0;
  const r2 = await resumeLimitGroup({ api: { ...api, resumeAgent: async () => { throw new Error('down'); } }, companyId: 'c1', agentIds: ['a1'], limits: { pauses: PAUSES } });
  assert.deepEqual([calls, r2.resumed, r2.failed.length], [[], [], 1]);
});

test('再開の前の確かめ（M3）: 見回りの後に予算・人が止め直した担当（pausedAt が違う）・もう paused でない担当・記録に pausedAt が無い担当は戻さない', async () => {
  const calls = [];
  // a2 は見回りの後に予算で止め直された（pausedAt が新しい）。o1 は人がもう再開した
  const now = { a1: { status: 'paused', pausedAt: PAT.a1 }, a2: { status: 'paused', pausedAt: '2026-11-18T03:00:00.000Z', pauseReason: 'budget' }, o1: { status: 'idle', pausedAt: null } };
  const api = {
    getAgent: async id => { calls.push(['get', id]); return { id, ...now[id] }; },
    resumeAgent: async id => { calls.push(['resume', id]); return {}; },
    limitResume: async (c, ids) => { calls.push(['close', ids]); return { closed: ids, stillPaused: [] }; },
  };
  const r = await resumeLimitGroup({ api, companyId: 'c1', agentIds: ['a1', 'a2', 'o1'], limits: { pauses: PAUSES } });
  assert.deepEqual(calls, [['get', 'a1'], ['resume', 'a1'], ['get', 'a2'], ['get', 'o1'], ['close', ['a1']]]);
  assert.deepEqual([r.resumed, r.changed], [['a1'], ['a2', 'o1']]);
  // 記録に pausedAt が無い・記録が無い担当は、確かめられないので本体を呼ばない
  calls.length = 0;
  const r2 = await resumeLimitGroup({ api, companyId: 'c1', agentIds: ['a1', 'zz'], limits: { pauses: [{ ...PAUSES[0], agentPausedAt: null }] } });
  assert.deepEqual([calls, r2.changed], [[], ['a1', 'zz']]);
  // 本体の担当を読めない時は failed（戻さない）
  const r3 = await resumeLimitGroup({ api: { ...api, getAgent: async () => { throw Object.assign(new Error('x'), { status: 500 }); } }, companyId: 'c1', agentIds: ['a1'], limits: { pauses: PAUSES } });
  assert.deepEqual([r3.resumed, r3.failed], [[], [{ id: 'a1', status: 500 }]]);
});

test('画面の口: notify の画面の値・記録を閉じる・本体の resume・起動係の上限の設定（同じ origin・cookie・id は符号化）', async () => {
  const seen = [];
  const api = createApi(async (url, init) => { seen.push([init.method, url, init.credentials, init.body ?? null]); return { ok: true, status: 200, json: async () => ({}) }; });
  await api.notifyLimits('c/1'); await api.limitResume('c1', ['a1']); await api.resumeAgent('a/1'); await api.getAgent('a/1'); await api.aiLimits(); await api.saveAiLimits({ guard: false });
  assert.deepEqual(seen, [
    ['GET', '/api/plugins/aioffice.notify/api/settings?companyId=c%2F1', 'same-origin', null],
    ['POST', '/api/plugins/aioffice.notify/api/limit/resume?companyId=c1', 'same-origin', '{"agentIds":["a1"]}'],
    ['POST', '/api/agents/a%2F1/resume', 'same-origin', '{}'],
    ['GET', '/api/agents/a%2F1', 'same-origin', null],
    ['GET', '/setup/api/ai-limits', 'same-origin', null],
    ['POST', '/setup/api/ai-limits', 'same-origin', '{"guard":false}'],
  ]);
});

const inbox = (over = {}) => {
  const calls = [];
  const api = {
    getAgent: getAgentSame,
    resumeAgent: async id => { calls.push(['resume', id]); return {}; },
    limitResume: async (c, ids) => { calls.push(['close', ids]); return { closed: ids, stillPaused: [] }; },
    noticeRead: async () => ({}),
    ...over.api,
  };
  let reloads = 0;
  const root = R.render(h(P.InboxPanel, { api, t: over.t || tEn, approvals: { data: [] }, decisions: { data: [] }, notices: { data: over.notices || [] }, limits: over.limits ?? { pauses: PAUSES }, companyId: 'c1', prefix: 'PFX', reload: () => { reloads++; }, onClose() {} }));
  return { root, calls, reloads: () => reloads };
};

test('受信箱: 止めた担当の知らせに「再開（N 人）」・押すと処理中 → 組の全員を本体で再開し notify で閉じる・結果の文', async () => {
  const d = deferred();
  const f = inbox({ notices: [notice('ai_limit_near', 'openai:week'), notice('agent_paused_limit', 'a1', { readAt: 'x', body: 'Hit the plan limit · until 2026-11-19 09:00 UTC\n- TES-1 Fix' })], api: { limitResume: async (c, ids) => { await d.p; return { closed: ids, stillPaused: [] }; } } });
  const items = R.findAll(f.root.tree, n => n.props['data-notice'] !== undefined).map(n => n.props['data-notice']);
  assert.deepEqual(items, ['agent_paused_limit', 'ai_limit_near'], '止めた担当（既読でも）を一番上に出す');
  assert.equal(R.byAttr(f.root.tree, 'data-inbox-empty'), null, '既読の止めた担当の知らせだけでも「待っている件はありません」にしない');
  const btn = R.byAttr(f.root.tree, 'data-limit-resume', 'a1');
  assert.equal(R.text(btn), 'Resume (2)');
  assert.ok(R.text(R.byAttr(f.root.tree, 'data-notice', 'agent_paused_limit')).includes('TES-1 Fix'), '課題へのつながりの本文');
  const p = click(btn); await R.settle(2);
  const busy = R.byAttr(f.root.tree, 'data-limit-resume', 'a1');
  assert.deepEqual([busy.props['aria-busy'], busy.props.disabled], ['true', true]);
  assert.match(R.text(busy), new RegExp(tEn('busy')));
  d.resolve(); await p; await R.settle();
  const res = R.byAttr(f.root.tree, 'data-limit-resume-result');
  assert.deepEqual([res.props['data-limit-resume-result'], res.props['data-tone'], R.text(res)], ['limit_resumed', 'ok', 'Resumed 2 employees.']);
  assert.equal(f.reloads(), 1, '終わったら受信箱・帯・担当を読み直す');
  assert.equal(R.byAttr(f.root.tree, 'data-limit-resume', 'a1').props['aria-busy'], undefined);
});

test('受信箱: 再開を本体が断った時は赤の文・記録の無い担当（予算で止まった）には再開を出さない', async () => {
  const f = inbox({ notices: [notice('agent_paused_limit', 'o1'), notice('agent_paused_limit', 'budget-scope')], api: { resumeAgent: async () => { throw Object.assign(new Error('x'), { status: 403 }); } } });
  assert.equal(R.byAttr(f.root.tree, 'data-limit-resume', 'budget-scope'), null);
  await click(R.byAttr(f.root.tree, 'data-limit-resume', 'o1')); await R.settle();
  const res = R.byAttr(f.root.tree, 'data-limit-resume-result');
  assert.deepEqual([res.props['data-limit-resume-result'], res.props['data-tone']], ['limit_resume_failed', 'err']);
  assert.deepEqual(f.calls, [], 'notify の記録は閉じない');
});

test('受信箱: 予算が未設定の知らせに本体の予算の画面へのつながり・追加料金の知らせに前と今の残り', () => {
  const f = inbox({ t: tJa, notices: [notice('budget_unset', 'gaps:1', { title: 'No budget set for API key agents: 1' }), notice('ai_credits_spent', 't1', { title: 'Started using extra credits ($250.80 → $249.10)' })] });
  const link = R.byAttr(f.root.tree, 'data-budget-link');
  assert.deepEqual([link.type, link.props.href, link.props.className, R.text(link)], ['a', '/PFX/budgets', 'aio-link', tJa('budget_open')]);
  assert.ok(R.text(R.byAttr(f.root.tree, 'data-notice', 'ai_credits_spent')).includes('$250.80 → $249.10'));
  assert.equal(R.byAttr(f.root.tree, 'data-limit-resume'), null);
});

test('担当の欄: 記録があれば「AI の上限で停止中（〜まで）」・期限が無ければ再開を押すまで・記録が無ければ出さない', () => {
  const work = { data: { now: [], recent: [] } };
  const a = R.render(h(P.AgentPanel, { agent: { id: 'a1', name: 'A', status: 'paused' }, work, t: tJa, limitPause: { reason: 'provider_quota', untilAt: '2026-11-19T09:00:00.000Z' }, onIssue() {}, onClose() {} }));
  const p = R.byAttr(a.tree, 'data-agent-limit');
  assert.equal(p.props['data-agent-limit'], '2026-11-19T09:00:00.000Z');
  assert.ok(R.text(p).startsWith('AI の上限で停止中 （') && R.text(p).endsWith(' まで）'));
  const m = R.render(h(P.AgentPanel, { agent: { id: 'o1', name: 'O', status: 'paused' }, work, t: tEn, limitPause: { reason: 'credits', untilAt: null }, onIssue() {}, onClose() {} }));
  assert.equal(R.text(R.byAttr(m.tree, 'data-agent-limit')), 'Paused at the AI usage limit (until you resume it)');
  const n = R.render(h(P.AgentPanel, { agent: { id: 'x', name: 'X', status: 'idle' }, work, t: tEn, onIssue() {}, onClose() {} }));
  assert.equal(R.byAttr(n.tree, 'data-agent-limit'), null);
});

test('上限の設定の入力: 起動係の値と欄の文字の行き来・空の止める % は止めない・形の合わない値は送らない', () => {
  const v = { guard: true, spend: 'stop', openai: { h5: { warnPct: 80, stopPct: null }, week: { warnPct: 80, stopPct: 95 } }, anthropic: { h5: { warnPct: 70, stopPct: null }, week: { warnPct: 85, stopPct: 95 } } };
  const f = limitsForm(v);
  assert.deepEqual(f.openai.h5, { warnPct: '80', stopPct: '' });
  assert.deepEqual(limitsBody(f).body, v);
  assert.equal(limitsForm(undefined).guard, true, '値が無ければ既定（ON）');
  // 追加料金の扱い: 値が無い・形の合わない時は既定の never。3 つのどれでもない値は送らない
  assert.equal(limitsForm(undefined).spend, 'never'); assert.equal(limitsForm({ spend: 'x' }).spend, 'never');
  for (const m of ['never', 'stop', 'allow']) assert.equal(limitsBody({ ...f, spend: m }).body.spend, m);
  assert.deepEqual(limitsBody({ ...f, spend: 'sometimes' }), { error: 'limits_bad_spend' });
  assert.deepEqual(limitsBody({ ...f, openai: { ...f.openai, week: { warnPct: '96', stopPct: '95' } } }), { error: 'limits_warn_over_stop' });
  assert.deepEqual(limitsBody({ ...f, openai: { ...f.openai, week: { warnPct: '', stopPct: '95' } } }), { error: 'limits_bad_pct' });
  assert.deepEqual(limitsBody({ ...f, anthropic: { ...f.anthropic, h5: { warnPct: '80', stopPct: '101' } } }), { error: 'limits_bad_pct' });
  assert.deepEqual(limitsBody({ ...f, anthropic: { ...f.anthropic, h5: { warnPct: '8.5', stopPct: '' } } }), { error: 'limits_bad_pct' });
  assert.deepEqual(usageRows({ windows: [{ kind: 'h5', usedPercent: 12.6 }] }), [{ kind: 'week', usedPercent: null, resetsAt: null }, { kind: 'h5', usedPercent: 13, resetsAt: null }]);
});

const AI_LIMITS = { guard: true, spend: 'never', openai: { h5: { warnPct: 80, stopPct: null }, week: { warnPct: 80, stopPct: 95 } }, anthropic: { h5: { warnPct: 80, stopPct: null }, week: { warnPct: 80, stopPct: 95 } } };
const VIEW = {
  overageEnabled: true, pauses: [],
  openai: { observedAt: '2026-11-18T01:00:00.000Z', unreadable: false, windows: [{ kind: 'h5', usedPercent: 41 }, { kind: 'week', usedPercent: 81 }] },
  claude: { observedAt: '2026-11-18T00:40:00.000Z', unreadable: true, windows: [{ kind: 'week', usedPercent: 96 }] },
};
const limitsApi = (over = {}) => { const calls = []; return { calls, api: { aiLimits: async () => ({ aiLimits: AI_LIMITS }), saveAiLimits: async b => { calls.push(b); return { aiLimits: b }; }, ...over } }; };

test('AI の契約の欄: Claude と ChatGPT の直近の使用率（週・5 時間）と読んだ時刻・読めない・追加料金で続く設定', async () => {
  const f = limitsApi();
  const root = R.render(h(P.LimitsSection, { api: f.api, t: tEn, limits: VIEW })); await R.settle();
  assert.equal(R.text(R.byAttr(root.tree, 'data-limits-pct', 'openai:week')), 'Weekly 81%');
  assert.equal(R.text(R.byAttr(root.tree, 'data-limits-pct', 'openai:h5')), '5-hour 41%');
  assert.equal(R.text(R.byAttr(root.tree, 'data-limits-pct', 'anthropic:week')), 'Weekly 96%');
  assert.equal(R.text(R.byAttr(root.tree, 'data-limits-pct', 'anthropic:h5')), `5-hour ${tEn('limits_no_value')}`);
  assert.equal(R.byAttr(root.tree, 'data-limits-read-at', '2026-11-18T01:00:00.000Z').type, 'p');
  assert.equal(R.text(R.byAttr(root.tree, 'data-limits-unreadable', 'anthropic')), tEn('limits_unreadable_anthropic'));
  assert.equal(R.byAttr(root.tree, 'data-limits-unreadable', 'openai'), null);
  assert.ok(R.byAttr(root.tree, 'data-limits-overage-enabled'));
  // 入力欄は起動係の値（止める % の空は止めない）
  assert.equal(R.byAttr(root.tree, 'data-limits-input', 'openai.h5.stopPct').props.value, '');
  assert.equal(R.byAttr(root.tree, 'data-limits-input', 'anthropic.week.stopPct').props.value, '95');
  assert.equal(R.byAttr(root.tree, 'data-limits-guard').props.checked, true);
  // 追加料金の扱い: 3 つの選択肢が辞書の文で並び、既定（never）が選ばれていて、allow の注意は出ない
  assert.deepEqual(['never', 'stop', 'allow'].map(m => R.byAttr(root.tree, 'data-limits-spend-mode', m).props.checked), [true, false, false]);
  assert.ok(R.text(R.byAttr(root.tree, 'data-limits-spend')).includes(tEn('limits_spend_never')));
  assert.equal(R.byAttr(root.tree, 'data-limits-spend-warn'), null);
  // 追加料金の扱いは起動係で 1 つ・全部の会社に効くことを、選択肢の上に辞書の文で書く（英日）
  const scope = R.byAttr(root.tree, 'data-limits-spend-scope');
  assert.ok(scope, '範囲の文が出る');
  assert.deepEqual([scope.type, R.text(scope)], ['p', tEn('limits_spend_scope')]);
  const rJa = R.render(h(P.LimitsSection, { api: limitsApi().api, t: tJa, limits: VIEW })); await R.settle();
  assert.equal(R.text(R.byAttr(rJa.tree, 'data-limits-spend-scope')), tJa('limits_spend_scope'));
  assert.notEqual(tEn('limits_spend_scope'), tJa('limits_spend_scope'));
  // 「1 円も使わない」の説明に、気づくまでの数分の少額は使われることがあると書く（英日・範囲の 4 節の保証しないことに合わせる）
  assert.ok(R.text(R.byAttr(root.tree, 'data-limits-spend')).includes(tEn('limits_spend_never_help')));
  assert.ok(R.text(R.byAttr(rJa.tree, 'data-limits-spend')).includes(tJa('limits_spend_never_help')));
  assert.match(tEn('limits_spend_never_help'), /A small amount may still be used in the few minutes before AI Office notices\./);
  assert.match(tJa('limits_spend_never_help'), /気づくまでの数分の少額は使われることがあります。/);
});

test('AI の契約の欄: 上限の保存は押した直後から処理中・形の合わない値は送らず赤の文・スイッチを切って保存', async () => {
  const d = deferred();
  const f = limitsApi({ saveAiLimits: async b => { f.calls.push(b); await d.p; return { aiLimits: b }; } });
  const root = R.render(h(P.LimitsSection, { api: f.api, t: tJa, limits: null })); await R.settle();
  assert.equal(R.byAttr(root.tree, 'data-limits-read-at', 'none').type, 'p', '読んでいない時は「まだ読んでいない」');
  // 知らせる % を止める % より上にすると送らない
  R.byAttr(root.tree, 'data-limits-input', 'openai.week.warnPct').props.onChange({ target: { value: '99' } }); await R.settle();
  await click(R.byAttr(root.tree, 'data-limits-save')); await R.settle();
  assert.deepEqual([f.calls.length, R.byAttr(root.tree, 'data-limits-result').props['data-limits-result']], [0, 'limits_warn_over_stop']);
  R.byAttr(root.tree, 'data-limits-input', 'openai.week.warnPct').props.onChange({ target: { value: '85' } });
  R.byAttr(root.tree, 'data-limits-guard').props.onChange({ target: { checked: false } });
  R.byAttr(root.tree, 'data-limits-spend-mode', 'allow').props.onChange({ target: { checked: true } }); await R.settle();
  // allow を選ぶと、お金が上限なく出ていくことを赤の文で書く
  const warn = R.byAttr(root.tree, 'data-limits-spend-warn');
  assert.deepEqual([warn.props.className, R.text(warn)], ['aio-err', tJa('limits_spend_allow_warn')]);
  const p = click(R.byAttr(root.tree, 'data-limits-save')); await R.settle(2);
  const busy = R.byAttr(root.tree, 'data-limits-save');
  assert.deepEqual([busy.props['aria-busy'], busy.props.disabled], ['true', true]);
  assert.match(R.text(busy), new RegExp(tJa('saving')));
  d.resolve(); await p; await R.settle();
  assert.deepEqual([f.calls[0].guard, f.calls[0].openai.week, f.calls[0].spend], [false, { warnPct: 85, stopPct: 95 }, 'allow']);
  const res = R.byAttr(root.tree, 'data-limits-result');
  assert.deepEqual([res.props['data-limits-result'], res.props['data-tone'], R.text(res)], ['limits_saved', 'ok', tJa('limits_saved')]);
  // 起動係が断った時（400）は辞書の文
  const g = limitsApi({ saveAiLimits: async () => { throw Object.assign(new Error('x'), { status: 400, body: { error: 'ai_limits_warn_over_stop' } }); } });
  const r2 = R.render(h(P.LimitsSection, { api: g.api, t: tEn })); await R.settle();
  await click(R.byAttr(r2.tree, 'data-limits-save')); await R.settle();
  assert.deepEqual([R.byAttr(r2.tree, 'data-limits-result').props['data-limits-result'], R.byAttr(r2.tree, 'data-limits-result').props['data-tone']], ['limits_warn_over_stop', 'err']);
});

test('AI の契約の欄: 上限の節は欄の中（起動係のある所）に出る・欄の文字は辞書の key だけ', async () => {
  const src = readFileSync(new URL('../plugins/office/src/panels.mjs', import.meta.url), 'utf8');
  assert.match(src, /api\.aiLimits \? h\(LimitsSection, \{ api, t, limits \}\) : null/);
  for (const k of ['limits_title', 'limits_help', 'limits_w_week', 'limits_w_h5', 'limits_warn', 'limits_stop', 'limits_guard', 'limits_save', 'limits_saved', 'limits_bad_pct', 'limits_warn_over_stop', 'limits_save_failed', 'limits_unreadable_openai', 'limits_unreadable_anthropic', 'limits_overage_enabled', 'limit_resume', 'limit_resumed', 'limit_resume_failed', 'limit_resume_still', 'limit_resume_changed', 'budget_open', 'agent_limit_paused', 'limit_until', 'limit_until_manual', 'limits_spend_title', 'limits_spend_scope', 'limits_spend_never', 'limits_spend_never_help', 'limits_spend_stop', 'limits_spend_stop_help', 'limits_spend_allow', 'limits_spend_allow_help', 'limits_spend_allow_warn', 'limits_bad_spend']) {
    assert.ok(DICT.en[k] && DICT.ja[k], k);
  }
  assert.equal(Object.keys(DICT.en).length, Object.keys(DICT.ja).length, '英日の key の数');
});
