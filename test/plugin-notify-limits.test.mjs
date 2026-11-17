// 知らせの plugin の AI の使用量の上限の判定の部品の試験（範囲: docs/review/2026-11-18-ai-usage-limit-scope.md（開発元の記録）の 8 節の unit）
// fixture の Claude の値は実測 4（上限に当たった run）・実測 5（通った run）の rate_limit_info の形
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  checkTickBody, eventRow, windowKind, openaiWindows, claudeWindows, limitState, creditsDollars, creditsReading, creditsSpend, overageState,
  isQuotaFailure, resetFromText, limitResetAt, contractPeers, pauseTargets, pauseAction, limitGuardOn, defaultAiLimits, checkAiLimits,
  effectiveAiLimits, spendMode, stopsOnSpend, NEVER_H5_STOP_PCT, SPEND_MODES,
  LIMIT_KINDS, KINDS, DICT, DIGEST_ORDER, KIND_LABEL, digestBody, reconcileKind, noticeKey, AUTO_RESUME, NO_AUTO_RESUME,
} from '../plugins/notify/src/lib.mjs';
import { dbStore } from '../plugins/notify/src/worker.mjs';
import { defaultAiLimits as launcherDefaultAiLimits, SPEND_MODES as LAUNCHER_SPEND_MODES } from '../packages/aioffice/launcher/lib/limits.mjs';

// 実測 4: 週の上限に当たった run のログの rate_limit_info
const M4 = { status: 'rejected', resetsAt: 1795078800, rateLimitType: 'seven_day', overageStatus: 'rejected', overageDisabledReason: 'org_level_disabled', isUsingOverage: false, unifiedWindows: { seven_day: { utilization: 1, resetsAt: 1795078800, status: 'rejected', surpassedThreshold: 1 } } };
// 実測 5: 通った run
const M5 = { status: 'allowed', resetsAt: 1795471200, rateLimitType: 'seven_day', overageStatus: 'rejected', overageDisabledReason: 'org_level_disabled', isUsingOverage: false, unifiedWindows: { seven_day: { utilization: 0.1, resetsAt: 1795471200, status: 'allowed' } } };
const cl = (info, extra = {}) => checkTickBody({ claudeLimits: { observedAt: '2026-11-18T00:00:00Z', runId: 'r1', ...info, ...extra } }).claudeLimits;
// 実測 3 の文
const M3_TEXT = "Claude run failed: subtype=success: You've hit your weekly limit · resets Nov 19, 9am (UTC)";
const LIM = defaultAiLimits();

test('windowKind: 5h・週（label の揺れ）・Credits を分け、Extra usage と codex 以外の limitId は null', () => {
  assert.equal(windowKind('5h limit'), 'h5');
  assert.equal(windowKind('5 hour limit'), 'h5');
  assert.equal(windowKind('Weekly limit'), 'week');
  for (const l of ['weekly', 'Week', '7d limit', '7-day limit', 'seven_day']) assert.equal(windowKind(l), 'week', l);
  assert.equal(windowKind('Credits'), 'credits');
  assert.equal(windowKind('Extra usage'), null);
  assert.equal(windowKind('GPT-5-Codex-Mini · 5h limit'), null);
  assert.equal(windowKind('Other · Weekly limit'), null);
  assert.equal(windowKind(''), null);
  assert.equal(windowKind(undefined), null);
});

test('openaiWindows: 実測 2 の形から 5h だけを判定に使い、Credits は外す・ok:false は読めない', () => {
  const q = checkTickBody({ quota: { provider: 'openai', ok: true, source: 'codex-wham', windows: [{ label: '5h limit', usedPercent: 87, resetsAt: '2026-11-19T14:24:27Z' }, { label: 'Credits', usedPercent: null, resetsAt: null, valueLabel: '$250.80 remaining' }] } }).quota;
  assert.deepEqual(openaiWindows(q), { windows: [{ kind: 'h5', usedPercent: 87, resetsAt: '2026-11-19T14:24:27.000Z', status: null }], unreadable: false });
  assert.deepEqual(openaiWindows({ provider: 'openai', ok: false, windows: [] }), { windows: [], unreadable: true });
  assert.deepEqual(openaiWindows(null), { windows: [], unreadable: false });
});

test('claudeWindows: 実測 4・5 の形を週の窓にし、utilization×100 と resetsAt の ISO を出す', () => {
  const a = claudeWindows(cl(M4));
  assert.deepEqual(a.windows, [{ kind: 'week', usedPercent: 100, resetsAt: '2026-11-19T09:00:00.000Z', status: 'rejected' }]);
  assert.equal(a.unreadable, false); assert.equal(a.status, 'rejected'); assert.equal(a.observedAt, '2026-11-18T00:00:00.000Z');
  const b = claudeWindows(cl(M5));
  assert.deepEqual(b.windows, [{ kind: 'week', usedPercent: 10, resetsAt: '2026-11-23T22:00:00.000Z', status: 'allowed' }]);
  assert.equal(b.unreadable, false);
});

test('claudeWindows: five_hour つき・全体の utilization がある形と無い形', () => {
  const five = cl({ ...M5, unifiedWindows: { ...M5.unifiedWindows, five_hour: { utilization: 0.81, resetsAt: 1795000000, status: 'allowed' } } });
  const w = claudeWindows(five).windows;
  assert.deepEqual(w.map(x => [x.kind, x.usedPercent]), [['week', 10], ['h5', 81]]);
  // 全体の utilization がある時は rateLimitType の窓の値に使う
  assert.equal(claudeWindows(cl({ ...M5, utilization: 0.5 })).windows.find(x => x.kind === 'week').usedPercent, 50);
  // unifiedWindows が無くても全体の値で窓を作る
  const top = claudeWindows(cl({ status: 'allowed', rateLimitType: 'five_hour', utilization: 0.3, resetsAt: 1795000000 }));
  assert.deepEqual(top.windows, [{ kind: 'h5', usedPercent: 30, resetsAt: new Date(1795000000e3).toISOString(), status: 'allowed' }]);
  assert.equal(top.unreadable, false);
});

test('claudeWindows: 知らない窓だけ・知らない status・読もうとして失敗した回は「読めない」・値が無いだけ（run が無い）は読めないにしない', () => {
  assert.equal(claudeWindows(cl({ status: 'allowed', unifiedWindows: { thirty_day: { utilization: 0.2, status: 'allowed' } } })).unreadable, true);
  // 知る窓が残れば、知らない窓は捨てて読める
  const mixed = claudeWindows(cl({ ...M5, unifiedWindows: { ...M5.unifiedWindows, opus_week: { utilization: 0.9, status: 'allowed' } } }));
  assert.equal(mixed.unreadable, false); assert.equal(mixed.windows.length, 1);
  assert.equal(claudeWindows(cl({ ...M5, status: 'paused_for_reasons' })).unreadable, true);
  assert.equal(claudeWindows(cl({ ...M5, unifiedWindows: { seven_day: { utilization: 0.1, status: 'Weird Status!' } } })).unreadable, true);
  assert.equal(claudeWindows(cl({ readError: 'no_event' })).unreadable, true);
  assert.equal(claudeWindows(cl({})).unreadable, true);
  assert.deepEqual(claudeWindows(null), { windows: [], unreadable: false, status: null, observedAt: null });
});

test('limitState: warn 未満は無し・warn 以上は near・stop 以上は over・5 時間の窓は止める % が空なら止めない', () => {
  const r = '2026-11-23T22:00:00.000Z';
  assert.deepEqual(limitState([{ kind: 'week', usedPercent: 79, resetsAt: r }], LIM.openai, 'openai'), { near: [], over: [] });
  const n = limitState([{ kind: 'week', usedPercent: 81, resetsAt: r }], LIM.openai, 'openai');
  assert.equal(n.near.length, 1); assert.equal(n.over.length, 0); assert.equal(n.near[0].key, 'openai:week:2026-11-23T22');
  const o = limitState([{ kind: 'week', usedPercent: 96, resetsAt: r }], LIM.openai, 'openai');
  assert.equal(o.near.length, 1); assert.deepEqual(o.over.map(x => [x.kind, x.reason]), [['week', 'pct']]);
  const h = limitState([{ kind: 'h5', usedPercent: 99, resetsAt: r }], LIM.anthropic, 'anthropic');
  assert.equal(h.near.length, 1); assert.equal(h.over.length, 0, '5 時間の窓は止める % が空なら知らせだけ');
  // 持ち主が 5 時間の窓にも止める % を決めた時は止める
  const lim = checkAiLimits({ anthropic: { h5: { warnPct: 70, stopPct: 90 } } }).anthropic;
  assert.equal(limitState([{ kind: 'h5', usedPercent: 91, resetsAt: r }], lim, 'anthropic').over.length, 1);
});

test('limitState: allowed_warning は % が低くても near・ok:false と空の窓は何も出さない', () => {
  const w = limitState([{ kind: 'week', usedPercent: 40, resetsAt: null, status: 'allowed_warning' }], LIM.anthropic, 'anthropic');
  assert.equal(w.near.length, 1); assert.equal(w.near[0].key, 'anthropic:week:none'); assert.equal(w.over.length, 0);
  assert.deepEqual(limitState(openaiWindows({ provider: 'openai', ok: false, windows: [] }).windows, LIM.openai, 'openai'), { near: [], over: [] });
  assert.deepEqual(limitState([], LIM.openai, 'openai'), { near: [], over: [] });
});

test('limitState: resetsAt の秒の揺れは同じ key・新しい窓は新しい key・会社が 2 つなら会社ごとに 1 件', () => {
  const k = at => limitState([{ kind: 'week', usedPercent: 85, resetsAt: at }], LIM.openai, 'openai').near[0].key;
  assert.equal(k('2026-11-23T22:00:03Z'), k('2026-11-23T21:59:58Z'));
  assert.notEqual(k('2026-11-23T22:00:00Z'), k('2026-11-30T22:00:00Z'));
  // 知らせの表は会社ごとなので、同じ key でも会社ごとに 1 件ずつ・二度目は足さない
  const want = limitState([{ kind: 'week', usedPercent: 85, resetsAt: '2026-11-23T22:00:00Z' }], LIM.openai, 'openai').near.map(x => ({ key: noticeKey('ai_limit_near', x.key), kind: 'ai_limit_near', originId: x.key, title: 't' }));
  const store = { c1: [], c2: [] };
  for (const c of ['c1', 'c2']) for (const n of reconcileKind('ai_limit_near', want, store[c]).add) store[c].push(n);
  assert.equal(store.c1.length, 1); assert.equal(store.c2.length, 1);
  assert.equal(reconcileKind('ai_limit_near', want, store.c1).add.length, 0);
});

test('creditsSpend: 同じ source で減れば spent・同じ値と増えた値（買い足し）は spent でない', () => {
  const a = { source: 'codex-wham', valueLabel: '$250.80 remaining' }, b = { source: 'codex-wham', valueLabel: '$249.10 remaining' };
  assert.deepEqual(creditsSpend(a, b), { spent: true, from: 250.8, to: 249.1, base: { source: 'codex-wham', dollars: 249.1 } });
  assert.equal(creditsSpend(a, a).spent, false);
  assert.equal(creditsSpend(b, a).spent, false);
  assert.equal(creditsDollars('$1,250.00 remaining'), 1250);
});

test('creditsSpend: wham ↔ RPC の入れ替わりは比べず、今の値を新しい基準にする', () => {
  const wham = { source: 'codex-wham', valueLabel: '$250.80 remaining' }, rpc = { source: 'codex-rpc', valueLabel: '$25080.00 remaining' };
  assert.deepEqual(creditsSpend(wham, rpc), { spent: null, base: { source: 'codex-rpc', dollars: 25080 } });
  assert.deepEqual(creditsSpend(rpc, wham), { spent: null, base: { source: 'codex-wham', dollars: 250.8 } });
  // 前の値が無い（初めての回）も基準を置くだけ
  assert.deepEqual(creditsSpend(null, wham), { spent: null, base: { source: 'codex-wham', dollars: 250.8 } });
});

test('creditsSpend: 読めない形・Credits の窓が無い時は null で、前の基準を持ち続ける', () => {
  const a = { source: 'codex-wham', valueLabel: '$250.80 remaining' };
  assert.deepEqual(creditsSpend(a, { source: 'codex-wham', valueLabel: 'N/A' }), { spent: null, base: { source: 'codex-wham', dollars: 250.8 } });
  assert.equal(creditsReading({ provider: 'openai', ok: true, source: 'codex-wham', windows: [{ label: '5h limit', usedPercent: 10 }] }), null);
  assert.equal(creditsReading({ provider: 'openai', ok: false, source: 'codex-wham', windows: [] }), null);
  const r = creditsReading({ provider: 'openai', ok: true, source: 'codex-wham', windows: [{ label: 'Credits', valueLabel: '$12.00 remaining' }] });
  assert.deepEqual(r, { source: 'codex-wham', dollars: 12 });
  assert.equal(creditsSpend(a, r).spent, true);
  assert.equal(creditsSpend(a, null).spent, null);
});

test('overageState: 追加料金で動いている・続く設定・入っていない（実測 4・5）・読めない', () => {
  assert.equal(overageState(cl({ ...M5, isUsingOverage: true })), 'using');
  assert.equal(overageState(cl({ ...M4, overageStatus: 'allowed' })), 'using', 'rejected＋overageStatus allowed は窓の上限を越えて追加料金で通った形');
  assert.equal(overageState(cl({ ...M5, overageStatus: 'allowed' })), 'enabled');
  assert.equal(overageState(cl({ ...M5, status: 'allowed_warning', overageStatus: 'allowed_warning' })), 'enabled');
  assert.equal(overageState(cl({ ...M5, status: 'allowed_warning' })), 'off');
  assert.equal(overageState(cl(M4)), 'off');
  assert.equal(overageState(cl(M5)), 'off');
  assert.equal(overageState(cl({ status: 'allowed' })), 'unreadable', '欄が無い形');
  assert.equal(overageState(cl({ ...M5, readError: 'truncated' })), 'unreadable');
  assert.equal(overageState(null), 'unreadable');
});

test('上限の失敗の判定: errorCode provider_quota を主に、claude と codex の既知の文言・下線の形・ログの rejected', () => {
  assert.equal(isQuotaFailure({ errorCode: 'provider_quota', error: 'anything' }), true);
  const failed = [M3_TEXT, 'Claude usage limit reached', '5-hour limit reached', 'weekly limit reached', 'Session limit reached', "You've hit your limit", 'You’ve hit your session limit',
    'out of extra usage', 'usage cap reached', 'ServiceQuotaExceededException: quota', "You've hit your usage limit for GPT-5. Switch to another model now, or try again at 3:15 PM.",
    'model is at capacity', 'at capacity for this model', 'capacity limit', 'error: rate_limit_reached', 'code=rate_limit', 'usage_limit', 'quota exceeded', 'usage limit exceeded'];
  for (const e of failed) assert.equal(isQuotaFailure({ status: 'failed', errorCode: 'adapter_failed', error: e }), true, e);
  // event の行（errorSnippet）でも同じ
  assert.equal(isQuotaFailure(eventRow({ eventType: 'agent.run.failed', companyId: 'c1', entityId: 'r1', payload: { agentId: 'a1', error: M3_TEXT, errorCode: 'adapter_failed' } })), true);
  for (const e of ['rate_limit_error: 429 too many requests', 'model not found', 'timeout', '']) assert.equal(isQuotaFailure({ status: 'failed', error: e }), false, e);
  assert.equal(isQuotaFailure(null), false);
});

test('上限の失敗の判定: succeeded で上限の文を書いて終えた run は拾い、ふつうの要約は拾わない・ログの rejected', () => {
  assert.equal(isQuotaFailure({ status: 'succeeded', error: M3_TEXT }), true);
  assert.equal(isQuotaFailure({ status: 'succeeded', error: 'Updated the usage limit docs and the capacity limit table' }), false);
  // 長い要約の中で上限の文を引いただけ（課題の中身）は拾わない（実装レビュー r1 の L4）
  assert.equal(isQuotaFailure({ status: 'succeeded', error: `Wrote the FAQ. ${'x'.repeat(100)} It now says "You've hit your weekly limit".` }), false);
  assert.equal(isQuotaFailure({ kind: 'run_finished', errorSnippet: 'x'.repeat(300) + " You've hit your weekly limit" }), false);
  assert.equal(isQuotaFailure({ status: 'succeeded', logStatus: 'rejected', logOverageStatus: 'rejected' }), true);
  assert.equal(isQuotaFailure({ status: 'succeeded', logStatus: 'rejected', logOverageStatus: 'allowed' }), false, '追加料金で通った形は失敗でない（G9b で見る）');
  assert.equal(isQuotaFailure({ status: 'succeeded', logStatus: 'allowed' }), false);
});

test('リセットの時刻: ログの resetsAt（epoch 秒）が文と retryNotBefore より優先', () => {
  const now = Date.parse('2026-11-17T22:21:00Z');
  assert.deepEqual(limitResetAt({ logResetsAt: 1795078800, retryNotBefore: '2026-11-18T00:00:00Z', text: 'resets 3pm (UTC)', nowMs: now }), { at: '2026-11-19T09:00:00.000Z', from: 'log' });
  assert.deepEqual(limitResetAt({ retryNotBefore: '2026-11-18T00:00:00Z', text: M3_TEXT, nowMs: now }), { at: '2026-11-18T00:00:00.000Z', from: 'retry' });
  assert.deepEqual(limitResetAt({ text: M3_TEXT, nowMs: now }), { at: '2026-11-19T09:00:00.000Z', from: 'text' });
  assert.equal(limitResetAt({ text: 'failed', nowMs: now }), null);
  assert.equal(limitResetAt(), null);
});

test('リセットの時刻（文の補い）: 「resets 9am (UTC)」「resets Nov 19, 9am (UTC)」・時刻帯・年をまたぐ形・読めない形は null', () => {
  const now = Date.parse('2026-11-18T03:00:00Z'); // 日本時間 12 時
  assert.equal(resetFromText('resets 9am (UTC)', now), '2026-11-18T09:00:00.000Z');
  assert.equal(resetFromText('resets 2am (UTC)', now), '2026-11-19T02:00:00.000Z', '過ぎた時刻は次の日');
  assert.equal(resetFromText(M3_TEXT, now), '2026-11-19T09:00:00.000Z');
  assert.equal(resetFromText("You've hit your weekly limit · resets Nov 19, 9am (UTC…", now), '2026-11-19T09:00:00.000Z', '記録の文が切れた形（実測 3）');
  assert.equal(resetFromText('resets 9am (Asia/Tokyo)', now), '2026-11-19T00:00:00.000Z');
  assert.equal(resetFromText('resets Nov 19, 9:30pm (Asia/Tokyo)', now), '2026-11-19T12:30:00.000Z');
  assert.equal(resetFromText('resets Jan 2, 3pm (UTC)', Date.parse('2026-12-30T00:00:00Z')), '2027-01-02T15:00:00.000Z', '12 月に書かれた 1 月の日付は次の年');
  assert.equal(resetFromText('or try again at 3:15 PM.', now), '2026-11-18T15:15:00.000Z');
  for (const bad of ['resets soon', 'resets 13pm (UTC)', 'resets 9am (Mars/Base)', 'resets 9am (Asia/Tok…', 'resets Foo 19, 9am (UTC)', 'resets Feb 30, 9am (UTC)', 'no reset here', '']) assert.equal(resetFromText(bad, now), null, bad);
});

test('同じ契約をまとめて止める: 同じ token の担当が全員・API キーの担当と別の token の担当は入らない', () => {
  const groups = checkTickBody({ contractGroups: [
    { contract: 'anthropic:secret-a', provider: 'anthropic', agentIds: ['a1', 'a2', 'a3'] },
    { contract: 'anthropic:secret-b', provider: 'anthropic', agentIds: ['b1'] },
    { contract: 'openai', provider: 'openai', agentIds: ['o1'] },
  ] }).contractGroups;
  assert.deepEqual(contractPeers(groups, 'a2'), { contract: 'anthropic:secret-a', provider: 'anthropic', agentIds: ['a1', 'a2', 'a3'] });
  // API キーの担当は一覧に無いので、その担当だけ
  assert.deepEqual(contractPeers(groups, 'k1'), { contract: null, provider: null, agentIds: ['k1'] });
  const t = pauseTargets(contractPeers(groups, 'a1').agentIds, [{ id: 'a1', status: 'idle' }, { id: 'a2', status: 'running' }, { id: 'a3', status: 'paused' }, { id: 'b1', status: 'idle' }, { id: 'k1', status: 'idle' }]);
  assert.deepEqual(t, { pause: ['a1', 'a2'], skipped: ['a3'], missing: [] });
});

test('G3: 既に paused の担当は止めず記録もしない・消えた担当と terminated も止めない', () => {
  assert.deepEqual(pauseTargets(['x'], [{ id: 'x', status: 'paused' }]), { pause: [], skipped: ['x'], missing: [] });
  assert.deepEqual(pauseTargets(['x', 'y', 'x'], [{ id: 'y', status: 'terminated' }]), { pause: [], skipped: [], missing: ['x', 'y'] });
});

test('戻す・止め直す・閉じる（7 の 6）: 競り合い・人の再開・人の止め直し', () => {
  const rec = { reason: 'provider_quota', untilAt: '2026-11-19T09:00:00Z', agentPausedAt: '2026-11-17T22:22:30Z' };
  const before = Date.parse('2026-11-18T00:00:00Z');
  assert.equal(pauseAction(rec, { status: 'idle', pausedAt: '2026-11-17T22:22:30.000Z' }, { nowMs: before }), 'repause', '走り終わりとの競り合いで idle に戻った');
  assert.equal(pauseAction(rec, { status: 'idle', pausedAt: null }, { nowMs: before }), 'close_resumed');
  assert.equal(pauseAction(rec, { status: 'paused', pausedAt: '2026-11-17T23:00:00Z' }, { nowMs: before }), 'close_repaused');
  assert.equal(pauseAction(rec, { status: 'paused', pausedAt: '2026-11-17T22:22:30Z' }, { nowMs: before }), 'keep');
  assert.equal(pauseAction(rec, undefined, { nowMs: before }), 'close_gone');
  assert.equal(pauseAction(rec, { status: 'terminated', pausedAt: null }, { nowMs: before }), 'close_gone');
});

test('自動で戻す（Q2 の仮の答え = 自動）: 期限を過ぎ pausedAt が記録と同じ時だけ・追加料金・% のまま・期限なし・人が止め直した時は戻さない', () => {
  assert.equal(AUTO_RESUME, true);
  const rec = { reason: 'pct', untilAt: '2026-11-19T09:00:00Z', agentPausedAt: '2026-11-17T22:22:30Z' };
  const agent = { status: 'paused', pausedAt: '2026-11-17T22:22:30Z' };
  const after = Date.parse('2026-11-19T09:00:01Z');
  assert.equal(pauseAction(rec, agent, { nowMs: Date.parse('2026-11-19T08:59:00Z') }), 'keep');
  assert.equal(pauseAction(rec, agent, { nowMs: after }), 'resume');
  assert.equal(pauseAction(rec, agent, { nowMs: after, stillOver: true }), 'keep', 'ChatGPT の窓がまだ止める % 以上');
  for (const reason of NO_AUTO_RESUME) assert.equal(pauseAction({ ...rec, reason }, agent, { nowMs: after }), 'keep', reason);
  assert.equal(pauseAction({ ...rec, untilAt: null }, agent, { nowMs: after }), 'keep', '期限が取れない時は人の再開だけ');
  assert.equal(pauseAction({ ...rec, agentPausedAt: null }, agent, { nowMs: after }), 'keep', 'pausedAt を確かめられない時は自動で戻さない');
  assert.equal(pauseAction(rec, agent, { nowMs: after, autoResume: false }), 'keep', 'Q2 が人の再開だけの時');
});

test('flag: 値が無い時は ON・OFF は止め直さない・自動で戻さない・OFF でも人の再開と止め直しで記録を閉じる', () => {
  assert.equal(limitGuardOn(undefined), true);
  assert.equal(limitGuardOn({}), true);
  assert.equal(limitGuardOn(checkTickBody({ aiLimits: {} }).aiLimits), true);
  assert.equal(limitGuardOn(checkTickBody({ aiLimits: { guard: false } }).aiLimits), false);
  const rec = { reason: 'pct', untilAt: '2026-11-19T09:00:00Z', agentPausedAt: '2026-11-17T22:22:30Z' };
  const off = { guard: false, nowMs: Date.parse('2026-11-20T00:00:00Z') };
  assert.equal(pauseAction(rec, { status: 'idle', pausedAt: '2026-11-17T22:22:30Z' }, off), 'keep');
  assert.equal(pauseAction(rec, { status: 'paused', pausedAt: '2026-11-17T22:22:30Z' }, off), 'keep');
  assert.equal(pauseAction(rec, { status: 'idle', pausedAt: null }, off), 'close_resumed');
  assert.equal(pauseAction(rec, { status: 'paused', pausedAt: '2026-11-18T01:00:00Z' }, off), 'close_repaused');
});

test('checkTickBody: aiLimits は欄ごとに既定へ戻し、止める % の null（止めない）を残す', () => {
  assert.deepEqual(checkTickBody({ aiLimits: {} }).aiLimits, defaultAiLimits());
  const a = checkTickBody({ aiLimits: { guard: false, spend: 'allow', openai: { week: { warnPct: 70, stopPct: 90 }, h5: { warnPct: 'x', stopPct: 150 }, credits: { stopOnSpend: false } }, anthropic: { week: { stopPct: null } } } }).aiLimits;
  assert.equal(a.guard, false); assert.equal(a.spend, 'allow');
  assert.deepEqual(a.openai, { h5: { warnPct: 80, stopPct: null }, week: { warnPct: 70, stopPct: 90 } }, '知らない欄（古い credits）は残さない');
  assert.equal(checkTickBody({ aiLimits: { spend: 'sometimes' } }).aiLimits.spend, 'never', '形の合わない追加料金の扱いは既定（never）');
  assert.deepEqual(a.anthropic.week, { warnPct: 80, stopPct: null });
  assert.equal(checkTickBody({ aiLimits: 'on' }).aiLimits, undefined);
  // 既定は週 80・95、5 時間は 80・止める % は空、追加料金の扱いは never（Q4 の答え 2026-11-18）
  assert.deepEqual(defaultAiLimits().anthropic, { h5: { warnPct: 80, stopPct: null }, week: { warnPct: 80, stopPct: 95 } });
  assert.equal(defaultAiLimits().spend, 'never');
});

test('追加料金の扱い（Q4）: 既定は never・never は 5 時間の窓も 95% で止める・stop と allow は 5 時間の窓をそのまま・止めるのは never と stop', () => {
  assert.deepEqual(SPEND_MODES, ['never', 'stop', 'allow']);
  assert.equal(spendMode(undefined), 'never'); assert.equal(spendMode({ spend: 'x' }), 'never');
  assert.deepEqual(['never', 'stop', 'allow'].map(m => stopsOnSpend({ spend: m })), [true, true, false]);
  assert.equal(NEVER_H5_STOP_PCT, 95);
  const r = '2026-11-23T22:00:00.000Z';
  const h5 = pct => [{ kind: 'h5', usedPercent: pct, resetsAt: r }];
  // never（既定）: 空の止める % は 95%・95 より上に決めた値は 95%・95 より下に決めた値はそのまま
  const never = effectiveAiLimits(defaultAiLimits());
  assert.deepEqual([never.openai.h5.stopPct, never.anthropic.h5.stopPct], [95, 95]);
  assert.equal(limitState(h5(94), never.anthropic, 'anthropic').over.length, 0);
  assert.deepEqual(limitState(h5(95), never.anthropic, 'anthropic').over.map(x => [x.kind, x.reason]), [['h5', 'pct']]);
  assert.deepEqual(limitState(h5(95), never.openai, 'openai').over.map(x => x.kind), ['h5']);
  assert.equal(effectiveAiLimits(checkAiLimits({ openai: { h5: { warnPct: 80, stopPct: 99 } } })).openai.h5.stopPct, 95);
  assert.equal(effectiveAiLimits(checkAiLimits({ openai: { h5: { warnPct: 70, stopPct: 90 } } })).openai.h5.stopPct, 90);
  // never: 週の窓も同じ形（空か 95 より上にして保存しても 95% で止める・下の値はそのまま）
  assert.equal(effectiveAiLimits(defaultAiLimits()).openai.week.stopPct, 95);
  const wk = pct => [{ kind: 'week', usedPercent: pct, resetsAt: r }];
  const weekEmpty = effectiveAiLimits(checkAiLimits({ anthropic: { week: { warnPct: 80, stopPct: null } }, openai: { week: { warnPct: 80, stopPct: 100 } } }));
  assert.deepEqual([weekEmpty.anthropic.week.stopPct, weekEmpty.openai.week.stopPct], [95, 95]);
  assert.equal(limitState(wk(94), weekEmpty.anthropic, 'anthropic').over.length, 0);
  assert.deepEqual(limitState(wk(95), weekEmpty.anthropic, 'anthropic').over.map(x => [x.kind, x.reason]), [['week', 'pct']]);
  assert.deepEqual(limitState(wk(95), weekEmpty.openai, 'openai').over.map(x => x.kind), ['week']);
  assert.equal(effectiveAiLimits(checkAiLimits({ anthropic: { week: { warnPct: 70, stopPct: 90 } } })).anthropic.week.stopPct, 90);
  // stop・allow: 5 時間と週の窓の空の止める % はそのまま（知らせだけ）
  for (const m of ['stop', 'allow']) {
    const L = effectiveAiLimits(checkAiLimits({ spend: m, anthropic: { week: { warnPct: 80, stopPct: null } } }));
    assert.equal(L.anthropic.h5.stopPct, null, m);
    assert.equal(L.anthropic.week.stopPct, null, m);
    assert.equal(limitState(h5(99), L.anthropic, 'anthropic').over.length, 0, m);
    assert.equal(limitState(wk(99), L.anthropic, 'anthropic').over.length, 0, m);
  }
});

test('既定の値: 起動係（正）と notify（値が無い時の倒れる先）が同じ値を持つ', () => {
  assert.deepEqual(defaultAiLimits(), launcherDefaultAiLimits());
  assert.deepEqual(SPEND_MODES, LAUNCHER_SPEND_MODES);
});

test('checkTickBody: quota・quotaRuns・claudeLimits の形の合わない物を捨て、決まった欄だけを残す', () => {
  const b = checkTickBody({
    quota: { provider: 'openai', ok: true, source: 'codex-wham', error: 'Command failed: secret', windows: [{ label: '5h limit', usedPercent: 87, resetsAt: '2026-11-19T14:24:27Z' }, { usedPercent: 3 }, 'x', { label: 'Credits', usedPercent: null, valueLabel: '$250.80 remaining' }] },
    quotaRuns: { complete: false, runs: [{ runId: 'r1', agentId: 'a1', status: 'failed', errorCode: 'provider_quota', error: 'x'.repeat(900), retryNotBefore: 'nope', finishedAt: '2026-11-17T22:21:00Z', logStatus: 'rejected', logResetsAt: 1795078800, extra: 'drop' }, { runId: 'bad id!', agentId: 'a1' }, null] },
    claudeLimits: { ...M4, observedAt: '2026-11-17T22:20:00Z', runId: 'r1', text: 'the whole log', token: 'abc', unifiedWindows: { seven_day: { utilization: 1, resetsAt: 1795078800, status: 'rejected', note: 'drop' }, 'Bad Key': { utilization: 1 } } },
  });
  assert.equal(b.quota.error, undefined, 'quota の error の文は渡さない');
  assert.deepEqual(b.quota.windows.map(w => w.label), ['5h limit', 'Credits']);
  assert.equal(b.quotaRuns.complete, false);
  assert.equal(b.quotaRuns.runs.length, 1);
  const r = b.quotaRuns.runs[0];
  assert.equal(r.error.length, 500); assert.equal(r.retryNotBefore, null); assert.equal(r.extra, undefined); assert.equal(r.logResetsAt, 1795078800);
  assert.equal(b.claudeLimits.text, undefined); assert.equal(b.claudeLimits.token, undefined);
  assert.deepEqual(Object.keys(b.claudeLimits.unifiedWindows), ['seven_day']);
  assert.deepEqual(b.claudeLimits.unifiedWindows.seven_day, { utilization: 1, resetsAt: 1795078800, status: 'rejected', surpassedThreshold: null });
  // 配列の quotaRuns は読み切った回
  assert.equal(checkTickBody({ quotaRuns: [] }).quotaRuns.complete, true);
  for (const bad of [{ quota: { ok: 'yes', provider: 'openai' } }, { quota: { ok: true } }, { quotaRuns: 'x' }, { claudeLimits: [] }]) {
    const out = checkTickBody(bad);
    assert.deepEqual(Object.keys(out).sort(), ['lang', 'timeZone'], JSON.stringify(bad));
  }
});

test('checkTickBody: contractGroups・budgetIncidents・budgetGaps の形の合わない物を捨てる・知らない欄は残さない', () => {
  const b = checkTickBody({
    contractGroups: [{ contract: 'anthropic:ref-1', provider: 'anthropic', agentIds: ['a1', 'a1', 'a2', 5] }, { contract: 'x', provider: 'gemini', agentIds: ['g1'] }, { contract: 'bad contract', provider: 'openai', agentIds: ['o1'] }, { contract: 'openai', provider: 'openai', agentIds: [] }],
    budgetIncidents: [{ id: 'inc1', scopeType: 'agent', scopeId: 'a1', scopeName: 'Writer token=' + 'z'.repeat(20), thresholdType: 'hard', amountLimit: 5000, amountObserved: 5100, policyId: 'drop' }, { scopeType: 'agent' }],
    budgetGaps: [{ agentId: 'k1', kind: 'anthropic_api_key', value: 'drop' }, { kind: 'bedrock' }],
    unknown: { x: 1 },
  });
  assert.deepEqual(b.contractGroups, [{ contract: 'anthropic:ref-1', provider: 'anthropic', agentIds: ['a1', 'a2'] }]);
  assert.deepEqual(b.budgetIncidents, [{ id: 'inc1', scopeType: 'agent', scopeId: 'a1', scopeName: 'Writer token=[hidden]', thresholdType: 'hard', amountLimit: 5000, amountObserved: 5100 }]);
  assert.deepEqual(b.budgetGaps, [{ agentId: 'k1', kind: 'anthropic_api_key' }]);
  assert.equal(b.unknown, undefined);
  // 前からの値は変わらない
  assert.deepEqual(checkTickBody({ lang: 'ja', timeZone: 'Asia/Tokyo' }), { lang: 'ja', timeZone: 'Asia/Tokyo' });
});

test('eventRow: 担当の実行の event は errorCode と error の先頭 500 文字を捨てずに持つ（伏せてから切る）', () => {
  const r = eventRow({ eventType: 'agent.run.failed', companyId: 'c1', entityId: 'r1', occurredAt: '2026-11-17T22:21:00Z', payload: { agentId: 'a1', errorCode: 'provider_quota', error: M3_TEXT } });
  assert.equal(r.errorCode, 'provider_quota'); assert.equal(r.errorSnippet, M3_TEXT);
  const long = eventRow({ eventType: 'agent.run.failed', companyId: 'c1', entityId: 'r1', payload: { error: 'token=' + 'q'.repeat(30) + ' ' + 'word '.repeat(200) } });
  assert.equal(long.errorSnippet.length, 500); assert.ok(long.errorSnippet.startsWith('token=[hidden]'));
  const ok = eventRow({ eventType: 'agent.run.finished', companyId: 'c1', entityId: 'r2', payload: { agentId: 'a1', error: null } });
  assert.equal(ok.errorCode, null); assert.equal(ok.errorSnippet, null);
  // 承認などの event の形は変えない
  assert.equal('errorCode' in eventRow({ eventType: 'approval.created', companyId: 'c1', entityId: 'a1' }), false);
});

test('表への event の書き込み: error_code と error_snippet を書き、読む時も返す', async () => {
  const calls = [];
  const db = { namespace: 'plugin_notify_x', execute: async (sql, params) => { calls.push({ sql, params }); }, query: async (sql, params) => { calls.push({ sql, params }); return []; } };
  const st = dbStore(db);
  await st.addEvent({ companyId: 'c1', kind: 'run_failed', entityId: 'r1', agentId: 'a1', occurredAt: '2026-11-17T22:21:00.000Z', errorCode: 'provider_quota', errorSnippet: 'limit' });
  assert.match(calls[0].sql, /error_code, error_snippet\) VALUES \(\$1, \$2, \$3, \$4, \$5, \$6, \$7\)/);
  assert.deepEqual(calls[0].params.slice(5), ['provider_quota', 'limit']);
  await st.addEvent({ companyId: 'c1', kind: 'approval', entityId: 'p1', occurredAt: '2026-11-17T22:21:00.000Z' });
  assert.deepEqual(calls[1].params.slice(3), [null, '2026-11-17T22:21:00.000Z', null, null]);
  await st.openEvents('c1');
  assert.match(calls[2].sql, /error_code AS "errorCode", error_snippet AS "errorSnippet"/);
});

test('migration 005: 001〜004 は書き換えず、events に 2 つの欄と表 limit_pauses を足す・schema で修飾してある', async () => {
  const { createHash } = await import('node:crypto');
  const ns = 'plugin_notify_' + createHash('sha256').update('aioffice.notify').digest('hex').slice(0, 10);
  const sql = readFileSync(new URL('../plugins/notify/migrations/005_ai_limits.sql', import.meta.url), 'utf8');
  const body = sql.replace(/--.*$/gm, '');
  for (const col of ['error_code', 'error_snippet']) assert.match(body, new RegExp(`ALTER TABLE ${ns}\\.events ADD COLUMN IF NOT EXISTS ${col} text`));
  for (const col of ['company_id', 'agent_id', 'contract', 'window_kind', 'reason', 'until_at', 'paused_at', 'agent_paused_at', 'resumed_at', 'issue_ids', 'source_run_id', 'source_agent_id']) assert.match(body, new RegExp(`\\n  ${col} `), col);
  const refs = [...body.matchAll(/(?:TABLE|ON)\s+(?:IF NOT EXISTS\s+)?([\w.]+)/g)].map(m => m[1]);
  assert.ok(refs.length >= 4);
  for (const n of refs) assert.ok(n.startsWith(ns + '.'), n);
  // 本体は破壊の文を断る
  assert.doesNotMatch(body, /\b(drop|truncate|delete\s+from)\b/i);
});

test('新しい種類: KINDS・まとめの順・名前・英日の辞書に揃っていて、まとめの一覧に名前が出る', () => {
  for (const k of LIMIT_KINDS) {
    assert.ok(KINDS.includes(k), k); assert.ok(DIGEST_ORDER.includes(k), k);
    const lab = KIND_LABEL[k]; assert.ok(lab, k);
    for (const lang of ['en', 'ja']) assert.equal(typeof DICT[lang][lab], 'string', `${lang} ${lab}`);
  }
  assert.deepEqual(Object.keys(DICT.en).sort(), Object.keys(DICT.ja).sort(), '英日の辞書の key が揃う');
  assert.equal(DIGEST_ORDER[0], 'agent_paused_limit', '止めた担当をまとめの先頭に');
  const unread = [{ kind: 'run_failed', title: 'x' }, { kind: 'agent_paused_limit', title: 'Writer' }];
  assert.equal(digestBody({ lang: 'ja', unread }).split('\n')[0], '- AI の上限で止めています: Writer');
  assert.equal(digestBody({ lang: 'en', unread }).split('\n')[0], '- Paused at the AI usage limit: Writer');
});
