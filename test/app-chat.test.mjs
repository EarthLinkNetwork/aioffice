// アプリの「秘書・担当と話す・Daily Times・会社」（docs/review/2026-11-14-app-chat-spec.md・mock docs/mocks/app-chat-mock.html）の RN に依らない部分。
// 通知 API のアプリの口（口の形の節）の呼び方・下のタブの並び・話の状態の文言・判断の件から話を作る流れ・読み直しの間隔・通知の行き先を確かめる。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHttpClient } from '../apps/mobile/src/notify/http.ts';
import { createFakeClient } from '../apps/mobile/src/notify/fake.ts';
import { tapTarget, tapTargetOf, pushReloads } from '../apps/mobile/src/notify/push-logic.ts';
import { MAIN_TABS } from '../apps/mobile/src/chat/labels.ts';
import {
  THINKING, MAX_TEXT, POLL_MS, POLL_MAX_MS, statusLabel, dayLabel, threadMeta, showThinking, nextPoll, mergeMessages, lastAt,
  cardChatText, cardChip, cardAgent, startCardChat, deptRows, todayMeta, editionLabel, handedNote, rulesNote, talkPlaceholder, checkText,
} from '../apps/mobile/src/chat/logic.ts';
import { root, push, pop, top, backLabel, tabOf, chatRoute, chatKey, withThread, openThreadStack } from '../apps/mobile/src/chat/nav.ts';

const BASE = 'https://notify.example.test';
const mem = (t = null) => ({ t, async get() { return this.t; }, async set(v) { this.t = v; }, async clear() { this.t = null; } });
function setup({ routes = {}, token = 'TOK', fetch: f, ...rest } = {}) {
  const calls = [];
  const fetch = f ?? (async (url, init = {}) => {
    const u = new URL(url);
    const key = `${init.method} ${u.pathname}`;
    calls.push({ key, search: u.search, auth: init.headers?.authorization, body: init.body ? JSON.parse(init.body) : undefined });
    const r = routes[key] ?? { status: 404, body: {} };
    const res = typeof r === 'function' ? r({ url: u, body: init.body ? JSON.parse(init.body) : undefined }) : r;
    return { status: res.status, json: async () => res.body };
  });
  const store = mem(token);
  return { client: createHttpClient({ baseUrl: BASE, store, fetch, openAuth: async () => null, ...rest }), calls, store };
}
const card = (o = {}) => ({ v: 1, id: 'c1', bindingId: 'b1', kind: 'decision', risk: 'internal', title: 'Gateway の直しの方針', summary: '今の PR ではなく別の課題で直す方針を了承しますか。', recommendation: '今は了承しない', options: [{ id: 'ok', label: '別の課題で直す方針を了承' }, { id: 'no', label: '今は了承しない', style: 'primary' }], deadline: null, sections: [], links: [], createdAt: null, actions: [], ...o });
const dir = { secretaryId: 'sec', departments: [
  { key: 'tech', name: '技術', agents: [{ id: 'a-sec', name: 'セキュリティ', role: 'security', blurb: '秘密の扱いの確かめ' }] },
  { key: 'other', name: 'その他', agents: [{ id: 'sec', name: '秘書', role: 'secretary', blurb: '' }] },
] };

// ---- 通知 API のアプリの口（口の形・/api/v1/app）

test('口: 担当の一覧・話の一覧・話の発言・会社のサマリーを Bearer つきで読む', async () => {
  const { client, calls } = setup({ routes: {
    'GET /api/v1/app/bindings/b%201/agents': { status: 200, body: dir },
    'GET /api/v1/app/bindings/b1/agents': { status: 200, body: dir },
    'GET /api/v1/app/bindings/b1/threads': { status: 200, body: { threads: [{ id: 't1', agentId: 'sec', title: 'x', status: 'waiting', lastMessageAt: '2026-11-14T01:02:00Z' }] } },
    'GET /api/v1/app/bindings/b1/threads/t1/messages': { status: 200, body: { messages: [{ id: 'm1', role: 'me', text: 'やあ', at: '2026-11-14T01:02:00Z' }], status: 'waiting' } },
    'GET /api/v1/app/bindings/b1/overview': { status: 200, body: { departments: [], whole: { summary: 's' }, dailyTimes: null, at: 'x' } },
  } });
  assert.deepEqual(await client.chatAgents('b1'), dir);
  const th = await client.listThreads('b1', 'sec');
  assert.equal(th[0].id, 't1');
  assert.equal(calls.at(-1).search, '?agentId=sec');
  const page = await client.listMessages('b1', 't1', '2026-11-14T01:00:00.000Z');
  assert.equal(page.status, 'waiting'); assert.equal(page.messages[0].text, 'やあ');
  assert.equal(new URLSearchParams(calls.at(-1).search).get('after'), '2026-11-14T01:00:00.000Z');
  await client.listMessages('b1', 't1');
  assert.equal(calls.at(-1).search, ''); // after が無い時は全部
  assert.equal((await client.overview('b1')).whole.summary, 's');
  assert.ok(calls.every(c => c.auth === 'Bearer TOK'));
});

test('口: 新しい話は POST threads { agentId, text, cardId? } → 201 { thread }・続きの発言は POST messages { text } → 201 { message }', async () => {
  const { client, calls } = setup({ routes: {
    'POST /api/v1/app/bindings/b1/threads': ({ body }) => ({ status: 201, body: { thread: { id: 't9', agentId: body.agentId, title: body.text.slice(0, 40), status: 'waiting', lastMessageAt: 'x' } } }),
    'POST /api/v1/app/bindings/b1/threads/t9/messages': { status: 201, body: { message: { id: 'm2', role: 'me', text: 'つづき', at: 'y' } } },
  } });
  const r = await client.createThread('b1', { agentId: 'sec', text: 'はじめ' });
  assert.equal(r.ok, true); assert.equal(r.thread.id, 't9');
  assert.deepEqual(calls[0].body, { agentId: 'sec', text: 'はじめ' }); // cardId は付けない
  await client.createThread('b1', { agentId: 'a-sec', text: 'x', cardId: 'c1' });
  assert.deepEqual(calls[1].body, { agentId: 'a-sec', text: 'x', cardId: 'c1' });
  const s = await client.sendMessage('b1', 't9', 'つづき');
  assert.equal(s.ok, true); assert.equal(s.sent.id, 'm2');
  assert.deepEqual(calls[2].body, { text: 'つづき' });
});

test('口: 送る失敗は例外にせず画面に出す文を返す（404・通信の失敗・期限・401）', async () => {
  const a = setup({ routes: { 'POST /api/v1/app/bindings/b1/threads/t1/messages': { status: 404, body: { code: 'thread-not-found' } } } });
  assert.deepEqual(await a.client.sendMessage('b1', 't1', 'x'), { ok: false, message: 'この話は見つかりません' });
  const b = setup({ routes: { 'POST /api/v1/app/bindings/b1/threads': { status: 404, body: { code: 'card-not-found' } } } });
  assert.deepEqual(await b.client.createThread('b1', { agentId: 'a', text: 'x', cardId: 'c' }), { ok: false, message: 'この件はもうありません' });
  // 通信の失敗・期限は、届いたかを読み直しで確かめる。確かめる読みも失敗した時は「もう一度押して」と言わない（二重に送らない）
  const c = setup({ verifyWaitMs: 0, fetch: async () => { throw new TypeError('Network request failed'); } });
  const cm = (await c.client.sendMessage('b1', 't1', 'x')).message;
  assert.match(cm, /通信できませんでした/); assert.match(cm, /引いて読み直し/); assert.doesNotMatch(cm, /もう一度押してください/);
  const d = setup({ actTimeoutMs: 20, verifyWaitMs: 0, fetch: (_u, init) => new Promise((_, rej) => init.signal?.addEventListener('abort', () => rej(new Error('aborted')))) });
  const dm = (await d.client.createThread('b1', { agentId: 'a', text: 'x' })).message;
  assert.match(dm, /応答がありません/); assert.match(dm, /引いて読み直し/); assert.doesNotMatch(dm, /もう一度押してください/);
  const e = setup({ routes: { 'POST /api/v1/app/bindings/b1/threads/t1/messages': { status: 401, body: {} } } });
  let n = 0; e.client.onUnauthorized(() => { n++; });
  assert.match((await e.client.sendMessage('b1', 't1', 'x')).message, /サインインし直して/);
  assert.equal(e.store.t, null); assert.equal(n, 1);
});

// 送る口が失敗した時の読み直し（独立レビュー P2: サーバーが保存した後に応答だけ落ちると、押し直しで同じ発言が 2 つできる）
const flaky = (routes, failKey, mode = 'network') => {
  const calls = [];
  const fetch = (url, init = {}) => {
    const u = new URL(url); const key = `${init.method} ${u.pathname}`;
    calls.push({ key, search: u.search });
    if (key === failKey) {
      return mode === 'abort'
        ? new Promise((_, rej) => init.signal?.addEventListener('abort', () => rej(new Error('aborted'))))
        : Promise.reject(new TypeError('Network request failed'));
    }
    const r = routes[key] ?? { status: 404, body: {} };
    const res = typeof r === 'function' ? r({ url: u }) : r;
    return Promise.resolve({ status: res.status, json: async () => res.body });
  };
  return { client: createHttpClient({ baseUrl: BASE, store: mem('TOK'), fetch, openAuth: async () => null, actTimeoutMs: 20, verifyWaitMs: 0 }), calls };
};

test('口: 続きの発言の応答が落ちても、届いていれば送れたにする（押し直させない）', async () => {
  const now = new Date().toISOString();
  const mine = { id: 'm9', role: 'me', text: 'もう一度', at: now };
  for (const mode of ['network', 'abort']) {
    const { client, calls } = flaky({ 'GET /api/v1/app/bindings/b1/threads/t1/messages': { status: 200, body: { messages: [{ id: 'm1', role: 'system', text: '返事できませんでした', at: '2026-11-01T00:00:00Z' }, mine], status: 'waiting' } } },
      'POST /api/v1/app/bindings/b1/threads/t1/messages', mode);
    assert.deepEqual(await client.sendMessage('b1', 't1', 'もう一度'), { ok: true, sent: mine });
    assert.equal(calls.filter(x => x.key.startsWith('POST')).length, 1); // 送り直さない
  }
});

// 独立レビュー P2（二重の送信）: 送った後の失敗・期限切れでは、端末が諦めてもサーバーは保存を続けていることがある（読み直しの後に保存が終わる）。
// 読み直して見つからなくても「届いていない」と言い切らず、引いて読み直してから送るよう頼む（押し直しで同じ発言・話が 2 つできない）
test('口: 送った後の失敗・期限切れで発言が見つからなくても「届いていない」と言い切らない（押し直させない）', async () => {
  const old = { id: 'm0', role: 'me', text: 'もう一度', at: '2026-01-01T00:00:00Z' }; // 前に同じ文を送った分（今回の物ではない）
  for (const mode of ['network', 'abort']) {
    const { client, calls } = flaky({ 'GET /api/v1/app/bindings/b1/threads/t1/messages': { status: 200, body: { messages: [old], status: 'failed' } } },
      'POST /api/v1/app/bindings/b1/threads/t1/messages', mode);
    const r = await client.sendMessage('b1', 't1', 'もう一度');
    assert.equal(r.ok, false);
    assert.match(r.message, mode === 'abort' ? /応答がありません/ : /通信できませんでした/);
    assert.match(r.message, /引いて読み直し/); assert.match(r.message, /届いていない時だけもう一度送って/);
    assert.doesNotMatch(r.message, /届いていませんでした/); assert.doesNotMatch(r.message, /もう一度押してください/);
    assert.equal(calls.filter(x => x.key.startsWith('POST')).length, 1);
  }
});

test('口: 送る前の失敗（通信を始める前）と分かる時だけ「届いていない・もう一度押して」と言い、読み直さない', async () => {
  const calls = [];
  const fetch = async (url, init = {}) => { calls.push(`${init.method} ${new URL(url).pathname}`); return { status: 200, json: async () => ({}) }; };
  const broken = { async get() { throw new Error('keychain locked'); }, async set() {}, async clear() {} }; // token を読む所で落ちる = 送っていない
  const client = createHttpClient({ baseUrl: BASE, store: broken, fetch, openAuth: async () => null, verifyWaitMs: 0 });
  for (const r of [await client.sendMessage('b1', 't1', 'x'), await client.createThread('b1', { agentId: 'a', text: 'x' })]) {
    assert.equal(r.ok, false); assert.match(r.message, /届いていません/); assert.match(r.message, /もう一度押してください/);
  }
  assert.deepEqual(calls, []); // POST もしていないし、読み直しもしない
});

test('口: 新しい話の応答が落ちても、作られていればその話を返す（同じ話を 2 つ作らない）', async () => {
  const now = new Date().toISOString();
  const t7 = { id: 't7', agentId: 'sec', title: '明日の予定', status: 'waiting', lastMessageAt: now };
  const t6 = { id: 't6', agentId: 'sec', title: '別の話', status: 'done', lastMessageAt: now };
  const t5 = { id: 't5', agentId: 'sec', title: '明日の予定', status: 'done', lastMessageAt: '2026-01-01T00:00:00Z' };
  const msgs = { t6: [{ id: 'x6', role: 'me', text: '別の話', at: now }], t7: [{ id: 'x7', role: 'me', text: '明日の予定', at: now }] };
  for (const mode of ['network', 'abort']) {
    const { client, calls } = flaky({
      'GET /api/v1/app/bindings/b1/threads': { status: 200, body: { threads: [t6, t7, t5] } },
      'GET /api/v1/app/bindings/b1/threads/t6/messages': { status: 200, body: { messages: msgs.t6, status: 'done' } },
      'GET /api/v1/app/bindings/b1/threads/t7/messages': { status: 200, body: { messages: msgs.t7, status: 'waiting' } },
    }, 'POST /api/v1/app/bindings/b1/threads', mode);
    assert.deepEqual(await client.createThread('b1', { agentId: 'sec', text: '明日の予定' }), { ok: true, thread: t7 });
    assert.equal(calls.find(x => x.key === 'GET /api/v1/app/bindings/b1/threads').search, '?agentId=sec');
    assert.ok(!calls.some(x => x.key === 'GET /api/v1/app/bindings/b1/threads/t5/messages')); // 古い話は見ない
    assert.equal(calls.filter(x => x.key.startsWith('POST')).length, 1);
  }
  const none = flaky({ 'GET /api/v1/app/bindings/b1/threads': { status: 200, body: { threads: [t5] } } }, 'POST /api/v1/app/bindings/b1/threads');
  // 作られた話が見つからなくても、送った後の失敗・期限切れなら言い切らない（後から作られることがある。押し直すと話が 2 つできる）
  for (const mode of ['network', 'abort']) {
    const none = flaky({ 'GET /api/v1/app/bindings/b1/threads': { status: 200, body: { threads: [t5] } } }, 'POST /api/v1/app/bindings/b1/threads', mode);
    const r = await none.client.createThread('b1', { agentId: 'sec', text: '明日の予定' });
    assert.equal(r.ok, false); assert.match(r.message, /引いて読み直し/);
    assert.doesNotMatch(r.message, /届いていませんでした/); assert.doesNotMatch(r.message, /もう一度押してください/);
  }
});

test('口: 空の発言と 4000 字を超える発言は送らない', async () => {
  const { client, calls } = setup();
  assert.equal((await client.sendMessage('b1', 't1', '   ')).ok, false);
  assert.match((await client.createThread('b1', { agentId: 'a', text: 'あ'.repeat(MAX_TEXT + 1) })).message, /4000 字/);
  assert.equal(calls.length, 0);
  assert.equal(checkText('あ'.repeat(MAX_TEXT)), null);
});

test('口: 読む口は 200 でなければ失敗にする（前の画面を残す）。会社のサマリーがまだ無い 404 は null', async () => {
  const { client } = setup({ routes: {
    'GET /api/v1/app/bindings/b1/agents': { status: 500, body: {} },
    'GET /api/v1/app/bindings/b1/threads': { status: 200, body: {} },
    'GET /api/v1/app/bindings/b1/threads/t1/messages': { status: 404, body: { code: 'thread-not-found' } },
    'GET /api/v1/app/bindings/b1/overview': { status: 404, body: {} },
  } });
  await assert.rejects(client.chatAgents('b1'));
  await assert.rejects(client.listThreads('b1', 'a'));
  await assert.rejects(client.listMessages('b1', 't1'));
  assert.equal(await client.overview('b1'), null);
});

test('口: 読む口の 401 も token を消してサインイン画面へ戻す合図を出す', async () => {
  const { client, store } = setup({ routes: { 'GET /api/v1/app/bindings/b1/threads/t1/messages': { status: 401, body: {} } } });
  let n = 0; client.onUnauthorized(() => { n++; });
  await assert.rejects(client.listMessages('b1', 't1'));
  assert.equal(store.t, null); assert.equal(n, 1);
});

test('fake: 秘書との新しい話を作ると一覧に出て、少し後に返事が来る', async () => {
  const f = createFakeClient({ replyAfterMs: 5 });
  const d = await f.chatAgents('o1');
  const r = await f.createThread('o1', { agentId: d.secretaryId, text: '明日の予定を教えて' });
  assert.equal(r.ok, true);
  assert.equal((await f.listThreads('o1', d.secretaryId))[0].id, r.thread.id);
  assert.equal((await f.listMessages('o1', r.thread.id)).status, 'waiting');
  await new Promise(res => setTimeout(res, 20));
  const page = await f.listMessages('o1', r.thread.id);
  assert.deepEqual(page.messages.map(m => m.role), ['me', 'agent']);
  assert.equal(page.status, 'done');
  assert.ok(await f.overview('o1'));
});

// ---- 下のタブ・画面の行き来

test('下のタブは 受信箱・秘書・Daily Times・会社 の順（設定はタブに置かない）', () => {
  assert.deepEqual(MAIN_TABS.map(t => t.label), ['受信箱', '秘書', 'Daily Times', '会社']);
  assert.deepEqual(MAIN_TABS.map(t => t.icon), ['📥', '💬', '📰', '🏢']);
  assert.equal(MAIN_TABS.some(t => t.label === '設定'), false);
});

test('画面の行き来: 会社 → 部署 → 担当と話す、戻る時の文言は mock のとおり', () => {
  let s = root('company');
  s = push(s, { name: 'dept', key: 'tech', title: '技術' });
  s = push(s, { name: 'chat', agentId: 'a-sec', agentName: 'セキュリティ', threadId: null });
  assert.equal(backLabel(s), '‹ 技術');
  assert.equal(tabOf(s), 'company');
  s = pop(s);
  assert.equal(backLabel(s), '‹ 会社');
  assert.equal(backLabel(root('company')), null);
  // 秘書の履歴は「‹ 秘書」、判断の件から開いた話は「‹ 判断」、判断の件は「‹ 受信箱」、⚙️ の設定は元の画面の名前
  assert.equal(backLabel(push(root('secretary'), { name: 'history', agentId: 'sec', agentName: '秘書' })), '‹ 秘書');
  const fromCard = push(push(root('inbox'), { name: 'card', card: card() }), { name: 'chat', agentId: 'a-sec', agentName: 'セキュリティ', threadId: 't1' });
  assert.equal(backLabel(fromCard), '‹ 判断');
  assert.equal(backLabel(pop(fromCard)), '‹ 受信箱');
  assert.equal(backLabel(push(root('daily'), { name: 'settings' })), '‹ Daily Times');
  assert.equal(pop(root('inbox')).length, 1); // 一番下は消さない
});

// ---- 話の状態の文言（mock ②）

test('話の状態: 返事待ち・済み・返事できませんでした', () => {
  assert.equal(statusLabel('waiting'), '返事待ち');
  assert.equal(statusLabel('done'), '済み');
  assert.equal(statusLabel('failed'), '返事できませんでした');
});

test('話の一覧の 2 行目: 「今日 10:02・事務担当に回した・済み」「昨日・経理に回した・返事待ち」「11/12・済み」', () => {
  const now = new Date(2026, 10, 14, 15, 0).getTime();
  const at = (d, h, m) => new Date(2026, 10, d, h, m).toISOString();
  assert.equal(threadMeta({ id: 't', agentId: 's', title: 'x', status: 'done', handedTo: '事務担当', lastMessageAt: at(14, 10, 2) }, now), '今日 10:02・事務担当に回した・済み');
  assert.equal(threadMeta({ id: 't', agentId: 's', title: 'x', status: 'waiting', handedTo: '経理', lastMessageAt: at(13, 9, 0) }, now), '昨日・経理に回した・返事待ち');
  assert.equal(threadMeta({ id: 't', agentId: 's', title: 'x', status: 'done', lastMessageAt: at(12, 9, 0) }, now), '11/12・済み');
  assert.equal(dayLabel(at(14, 9, 5), now), '今日 9:05');
  assert.equal(handedNote('事務担当'), '事務担当に回した');
  assert.equal(rulesNote('セキュリティ'), 'セキュリティの決まりとスキルに従って答えています');
  assert.equal(talkPlaceholder('セキュリティ', false), 'セキュリティに話す');
  assert.equal(talkPlaceholder('秘書', true), '秘書に話す（マイクで話して書ける）');
});

test('「考えています…」: 返事待ちの間・自分の発言が最後の間は出す。済み・失敗では出さない', () => {
  const me = { id: 'm1', role: 'me', text: 'x', at: '1' };
  const ai = { id: 'm2', role: 'agent', text: 'y', at: '2' };
  const sys = { id: 'm3', role: 'system', text: '返事できませんでした', at: '3' };
  assert.equal(THINKING, '考えています…');
  assert.equal(showThinking([me], 'waiting'), true);
  assert.equal(showThinking([me, ai], 'waiting'), true); // 秘書が担当に回して待っている間
  assert.equal(showThinking([me, ai], 'done'), false);
  assert.equal(showThinking([me, ai, me], 'done'), true); // 閉じた話に続きを送った直後（開き直す前）
  assert.equal(showThinking([me, sys], 'failed'), false);
  // 「返事できませんでした」の話へ続きを送った直後: 状態は failed のままでも、自分の発言が最後なら出す（独立レビュー P2・保証 7）
  assert.equal(showThinking([me, sys, { ...me, id: 'm4', at: '4' }], 'failed'), true);
  assert.equal(nextPoll(showThinking([me, sys, { ...me, id: 'm4', at: '4' }], 'failed'), 1000, 1000), 5000); // 5 秒おきの読み直しも始まる
  assert.equal(showThinking([], 'done'), false);
});

test('読み直し: 返事待ちの間だけ 5 秒おき・始めてから 3 分で止める', () => {
  assert.equal(POLL_MS, 5000); assert.equal(POLL_MAX_MS, 180000);
  assert.equal(nextPoll(true, 1000, 1000), 5000);
  assert.equal(nextPoll(true, 1000, 1000 + 179_999), 5000);
  assert.equal(nextPoll(true, 1000, 1000 + 180_000), null);
  assert.equal(nextPoll(false, 1000, 1000), null);
});

test('発言を合わせる: 同じ id は 1 つ・古い順・最後の時刻を after に使う', () => {
  const a = [{ id: 'm1', role: 'me', text: 'x', at: '2026-11-14T01:00:00Z' }];
  const b = [{ id: 'm2', role: 'agent', text: 'y', at: '2026-11-14T01:01:00Z' }, { id: 'm1', role: 'me', text: 'x', at: '2026-11-14T01:00:00Z' }];
  const m = mergeMessages(a, b);
  assert.deepEqual(m.map(x => x.id), ['m1', 'm2']);
  assert.equal(lastAt(m), '2026-11-14T01:01:00Z');
  assert.equal(lastAt([]), undefined);
});

// ---- 判断の件の「決められない — 担当と話す」

test('判断の件から話す: 本文に件の題・要約・選択肢を入れ、最初の行は ④ の札になる', () => {
  const t = cardChatText(card());
  assert.match(t, /^判断の件から: Gateway の直しの方針\n/);
  assert.match(t, /今の PR ではなく別の課題で直す方針を了承しますか。/);
  assert.match(t, /別の課題で直す方針を了承/);
  assert.match(t, /今は了承しない/);
  assert.ok(t.length <= MAX_TEXT);
  assert.equal(cardChip([{ id: 'm', role: 'me', text: t, at: 'x' }]), '判断の件から: Gateway の直しの方針');
  assert.equal(cardChip([{ id: 'm', role: 'me', text: 'ふつうの話', at: 'x' }]), null);
  assert.ok(cardChatText(card({ summary: 'あ'.repeat(9000) })).length <= MAX_TEXT);
});

test('判断の件から話す相手: 件を作った担当（一覧にいれば）・分からなければ秘書', () => {
  assert.deepEqual(cardAgent(card({ requestedBy: { agentId: 'a-sec' } }), dir), { id: 'a-sec', name: 'セキュリティ' });
  assert.deepEqual(cardAgent(card({ requestedBy: { userId: 'u1' } }), dir), { id: 'sec', name: '秘書' });
  assert.deepEqual(cardAgent(card({ requestedBy: { agentId: 'gone' } }), dir), { id: 'sec', name: '秘書' });
  assert.deepEqual(cardAgent(card(), dir), { id: 'sec', name: '秘書' });
});

test('判断の件から話す流れ: cardId つきで新しい話を作り、開く話と担当を返す', async () => {
  const sent = [];
  const client = {
    chatAgents: async () => dir,
    createThread: async (b, input) => { sent.push([b, input]); return { ok: true, thread: { id: 't5', agentId: input.agentId, title: 'x', status: 'waiting', lastMessageAt: 'x' } }; },
  };
  const r = await startCardChat(client, card({ requestedBy: { agentId: 'a-sec' } }));
  assert.deepEqual({ ...r, thread: r.thread?.id }, { ok: true, threadId: 't5', thread: 't5', agent: { id: 'a-sec', name: 'セキュリティ' } });
  assert.equal(sent[0][0], 'b1');
  assert.equal(sent[0][1].cardId, 'c1');
  assert.equal(sent[0][1].agentId, 'a-sec');
  assert.equal(sent[0][1].text, cardChatText(card({ requestedBy: { agentId: 'a-sec' } })));
  // 失敗は文で返す（作れない・担当の一覧が読めない・結びつけが分からない）
  assert.deepEqual(await startCardChat({ ...client, createThread: async () => ({ ok: false, message: 'この件はもうありません' }) }, card()), { ok: false, message: 'この件はもうありません' });
  assert.equal((await startCardChat({ ...client, chatAgents: async () => { throw new Error('500'); } }, card())).ok, false);
  assert.equal((await startCardChat(client, card({ bindingId: undefined }))).ok, false);
});

// ---- 会社・Daily Times

test('会社の部署: サマリーの部署に担当の一覧を合わせる。サマリーが無くても担当の部署は出す', () => {
  const ov = { departments: [{ key: 'tech', name: '技術', summary: 'PR 2 本をレビュー', caution: '警報 1', working: ['セキュリティ'] }], whole: { summary: '全体' }, dailyTimes: null, at: 'x' };
  const rows = deptRows(ov, dir);
  assert.equal(rows[0].name, '技術'); assert.equal(rows[0].working, 1); assert.equal(rows[0].caution, '警報 1');
  assert.equal(rows[0].agents[0].name, 'セキュリティ');
  assert.equal(rows[1].key, 'other'); assert.equal(rows[1].summary, '');
  assert.deepEqual(deptRows(null, dir).map(r => r.key), ['tech', 'other']);
  assert.deepEqual(deptRows(ov, null).map(r => r.agents.length), [0]);
});

test('Daily Times: 号の名前・今日することの件数と期限きょうの数', () => {
  assert.equal(editionLabel('11/14'), '11/14 号');
  assert.equal(editionLabel('11/14 号'), '11/14 号');
  assert.equal(todayMeta(['料金の確認（期限きょう）', '投票（あと 2 日）', 'a', 'b']), '4 件・期限きょう 1');
  assert.equal(todayMeta(['a']), '1 件');
});

// ---- 通知の行き先

test('通知の行き先: 判断の件（bindingId・cardId）はこれまでどおり、話の返事（bindingId・threadId）は話を開く', () => {
  assert.deepEqual(tapTarget({ bindingId: 'b1', cardId: 'c1' }), { bindingId: 'b1', cardId: 'c1' });
  assert.deepEqual(tapTarget({ bindingId: 'b1', threadId: 't1', agentId: 'a1' }), { bindingId: 'b1', threadId: 't1', agentId: 'a1' });
  assert.deepEqual(tapTarget({ bindingId: 'b1', threadId: 't1' }), { bindingId: 'b1', threadId: 't1' });
  assert.equal(tapTarget({ bindingId: 'b1', threadId: '' }), null);
  // 題 = 担当の名前（通知の題）を、開いた話の題に使う
  assert.deepEqual(tapTargetOf({ title: 'セキュリティ', data: {} }, { type: 'push', payload: { bindingId: 'b1', threadId: 't1' } }), { bindingId: 'b1', threadId: 't1', agentName: 'セキュリティ' });
});

test('push で届いた返事: 開いている話の時だけ読み直す', () => {
  const open = { bindingId: 'b1', threadId: 't1' };
  assert.equal(pushReloads({ bindingId: 'b1', threadId: 't1' }, open), true);
  assert.equal(pushReloads({ bindingId: 'b1', threadId: 't2' }, open), false);
  assert.equal(pushReloads({ bindingId: 'b2', threadId: 't1' }, open), false);
  assert.equal(pushReloads({ bindingId: 'b1', cardId: 'c1' }, open), false);
  assert.equal(pushReloads({ bindingId: 'b1', threadId: 't1' }, null), false);
  assert.equal(pushReloads(null, open), false);
});

// 独立レビュー P2（別の話を開いて別の話へ送る）: 通知から開くと積み重ねはいつも [秘書, 話] で長さが同じ。担当が通知に無い・同じ担当の時に
// 話の画面が作り直されず、本文は前の話のまま・送ると前の話へ届いた。開くたびに別の画面の鍵にし、最初の発言で話の id が付く時は作り直さない
test('通知を 2 回続けて押す: 2 回目の話は別の画面として開き直す（担当が通知に無い時・同じ担当の時も）', () => {
  for (const [a, b] of [[{ bindingId: 'b1', threadId: 't1' }, { bindingId: 'b1', threadId: 't2' }],
    [{ bindingId: 'b1', threadId: 't1', agentId: 'a1' }, { bindingId: 'b1', threadId: 't2', agentId: 'a1' }],
    [{ bindingId: 'b1', threadId: 't1', agentId: 'a1' }, { bindingId: 'b1', threadId: 't2', agentId: 'a2', agentName: 'B' }],
    [{ bindingId: 'b1', threadId: 't1' }, { bindingId: 'b1', threadId: 't1' }]]) { // 同じ話の通知でも開き直して全部読む
    const s1 = openThreadStack(a); const s2 = openThreadStack(b);
    assert.equal(s1.length, s2.length);
    assert.equal(top(s2).threadId, b.threadId); assert.equal(top(s2).agentId, b.agentId ?? '');
    assert.notEqual(chatKey('b1', top(s1)), chatKey('b1', top(s2)));
  }
  assert.equal(top(openThreadStack({ bindingId: 'b1', threadId: 't1' })).agentName, '担当');
  assert.equal(tabOf(openThreadStack({ bindingId: 'b1', threadId: 't1' })), 'secretary');
});

test('話の画面の鍵: 最初の発言で話の id が付いても同じ画面のまま・別の会社なら別の画面・戻ると前の話の画面', () => {
  const s = push(root('company'), chatRoute('a1', 'セキュリティ', null));
  const k = chatKey('b1', top(s));
  const s2 = withThread(s, 't9');
  assert.equal(top(s2).threadId, 't9'); assert.equal(chatKey('b1', top(s2)), k); assert.equal(s2.length, s.length);
  assert.notEqual(chatKey('b2', top(s2)), k);
  assert.deepEqual(withThread(root('inbox'), 't9'), root('inbox')); // 話の画面でなければ何もしない
  // 履歴から別の話を開いて戻る: 戻った先は前の話の画面（鍵が戻る）
  const h = push(push(s2, { name: 'history', agentId: 'a1', agentName: 'セキュリティ' }), chatRoute('a1', 'セキュリティ', 't3'));
  assert.notEqual(chatKey('b1', top(h)), k);
  assert.equal(chatKey('b1', top(pop(pop(h)))), k);
});
