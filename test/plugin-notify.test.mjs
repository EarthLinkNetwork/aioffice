// 知らせの plugin（plugins/notify）の試験。本体は偽物
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import manifest from '../plugins/notify/src/manifest.mjs';
import { noticeKey, checkTickBody, eventRow, makeBudget, singleFlight, serialQueue, reconcileApprovals, TICK_BUDGET_MS } from '../plugins/notify/src/lib.mjs';

const { handleTick, handleRoute } = await import('../plugins/notify/src/worker.mjs');

// 0.2.0 で Slack への届けのために http.outbound と secrets.read-ref だけを足した（docs/review/2026-11-18-slack-notify-scope.md 作り方 2）。
// 外へ送る所が postSlack の 1 か所だけなことは test/plugin-notify-slack.test.mjs の lint で確かめる
test('manifest: 担当を起こす・job の capability が無い・外へ送る物は Slack の 2 つだけ', () => {
  for (const c of ['agents.invoke', 'issues.wakeup', 'jobs.schedule']) assert.ok(!manifest.capabilities.includes(c), c);
  for (const c of ['http.outbound', 'secrets.read-ref']) assert.ok(manifest.capabilities.includes(c), c);
  assert.equal(manifest.jobs, undefined);
  assert.equal(manifest.id, 'aioffice.notify');
  for (const r of manifest.apiRoutes) { assert.equal(r.auth, 'board'); assert.deepEqual(r.companyResolution, { from: 'query', key: 'companyId' }); }
});

test('migration の schema は key の hash から決まる名前で修飾してある', async () => {
  const { createHash } = await import('node:crypto');
  const ns = 'plugin_notify_' + createHash('sha256').update(manifest.id).digest('hex').slice(0, 10);
  const sql = readFileSync(new URL('../plugins/notify/migrations/001_init.sql', import.meta.url), 'utf8');
  const tables = [...sql.matchAll(/(?:TABLE|ON)\s+(?:IF NOT EXISTS\s+)?([\w.]+)/g)].map(m => m[1]).filter(n => !/^events_/.test(n));
  assert.ok(tables.length >= 3);
  for (const n of tables) assert.ok(n.startsWith(ns + '.'), n);
});

test('知らせの key: 種類と元の id で決まり、どちらかが違えば別', () => {
  assert.match(noticeKey('approval', 'a1'), /^[0-9a-f]{32}$/);
  assert.equal(noticeKey('approval', 'a1'), noticeKey('approval', 'a1'));
  assert.notEqual(noticeKey('approval', 'a1'), noticeKey('stuck', 'a1'));
  assert.notEqual(noticeKey('approval', 'a1'), noticeKey('approval', 'a2'));
});

test('見回りの口の body: 知らない言語は英語・正しくない時刻帯は無し', () => {
  assert.deepEqual(checkTickBody({ lang: 'ja', timeZone: 'Asia/Tokyo' }), { lang: 'ja', timeZone: 'Asia/Tokyo' });
  assert.deepEqual(checkTickBody({ lang: 'fr', timeZone: 'Mars/Base' }), { lang: 'en', timeZone: null });
  assert.deepEqual(checkTickBody(null), { lang: 'en', timeZone: null });
  assert.equal(checkTickBody({ timeZone: 'x'.repeat(65) }).timeZone, null);
});

test('event の形を確かめる: 会社・元の id・知っている種類が無い物は捨てる', () => {
  const ok = eventRow({ eventType: 'approval.created', companyId: 'c1', entityId: 'a1', occurredAt: '2026-11-16T00:00:00Z' });
  assert.deepEqual(ok, { companyId: 'c1', kind: 'approval', entityId: 'a1', agentId: null, occurredAt: '2026-11-16T00:00:00.000Z' });
  assert.equal(eventRow({ eventType: 'agent.run.failed', companyId: 'c1', entityId: 'r1', payload: { agentId: 'g1' } }).agentId, 'g1');
  assert.equal(eventRow({ eventType: 'approval.created', entityId: 'a1' }), null);
  assert.equal(eventRow({ eventType: 'company.updated', companyId: 'c1', entityId: 'x' }), null);
  assert.equal(eventRow({ eventType: 'agent.run.failed', companyId: 'c1', entityId: 1 }), null);
  assert.equal(eventRow(undefined), null);
});

test('時間の枠: 20 秒を超えると over', () => {
  let t = 1000; const b = makeBudget(() => t);
  assert.equal(TICK_BUDGET_MS, 20000);
  assert.equal(b.over(), false); t += 19999; assert.equal(b.over(), false); assert.equal(b.left(), 1);
  t += 1; assert.equal(b.over(), true);
});

test('同時に 1 つだけ: 動いている間の 2 回目は busy・終われば次が動く', async () => {
  const f = singleFlight(); let release;
  const first = f.run(() => new Promise(r => { release = r; }));
  assert.deepEqual(await f.run(async () => 1), { busy: true });
  release(7); assert.deepEqual(await first, { busy: false, value: 7 });
  assert.deepEqual(await f.run(async () => 2), { busy: false, value: 2 });
  await assert.rejects(f.run(async () => { throw new Error('x'); })); assert.equal(f.running, false);
});

test('待ち行列: 1 本ずつ順に流し、失敗しても次へ進む', async () => {
  const seen = [], errs = []; let active = 0, maxActive = 0;
  const q = serialQueue(e => errs.push(e.message));
  const job = (n, fail) => async () => { active++; maxActive = Math.max(maxActive, active); await new Promise(r => setTimeout(r, 5)); active--; if (fail) throw new Error('f' + n); seen.push(n); };
  q.push(job(1)); q.push(job(2, true)); q.push(job(3));
  assert.equal(q.size, 3);
  await q.idle();
  assert.deepEqual(seen, [1, 3]); assert.deepEqual(errs, ['f2']); assert.equal(maxActive, 1); assert.equal(q.size, 0);
});

test('承認待ちの突き合わせ: 一覧にあって無い物は足し、一覧に無い物は消す・ほかの種類は触らない', () => {
  const notices = [{ key: noticeKey('approval', 'old'), kind: 'approval' }, { key: noticeKey('approval', 'keep'), kind: 'approval' }, { key: noticeKey('stuck', 'old'), kind: 'stuck' }];
  const { add, remove } = reconcileApprovals([{ id: 'keep', title: 'Keep' }, { id: 'new', type: 'hire_agent' }], notices);
  assert.deepEqual(add, [{ key: noticeKey('approval', 'new'), kind: 'approval', originId: 'new', title: 'hire_agent' }]);
  assert.deepEqual(remove, [noticeKey('approval', 'old')]);
});

// 偽の本体と表
function fakeDeps(pending = [], { issues = [], agents = [], interactions = {}, events = [], config = {}, now = 0 } = {}) {
  const notices = new Map(), state = new Map(), ev = events.map((e, i) => ({ id: i + 1, done: false, ...e }));
  let clock = now;
  return {
    notices, state, ev, setNow: v => { clock = v; },
    deps: {
      now: () => clock,
      flight: singleFlight(),
      state: { set: async (k, v) => state.set(JSON.stringify(k), v), get: async k => state.get(JSON.stringify(k)) },
      approvals: { list: async ({ companyId, status }) => (assert.equal(status, 'pending'), pending.filter(a => a.companyId === companyId)) },
      issues: { list: async ({ companyId }) => issues.filter(i => (i.companyId || 'c1') === companyId), listInteractions: async id => interactions[id] || [] },
      agents: { list: async () => agents },
      config: { get: async () => config },
      store: {
        listNotices: async c => [...notices.values()].filter(n => n.c === c),
        addNotice: async (c, n) => { if (!notices.has(c + n.key)) notices.set(c + n.key, { ...n, c, readAt: null }); },
        removeNotice: async (c, k) => notices.delete(c + k),
        markRead: async (c, k) => { const n = notices.get(c + k); if (n) n.readAt = 'now'; },
        openEvents: async c => ev.filter(e => (e.companyId || 'c1') === c && !e.done),
        doneEvents: async (c, ids) => { for (const e of ev) if (ids.includes(e.id)) e.done = true; },
        // AI の上限の記録（ここの試験では止めない。止める試験は plugin-notify-limits-worker.test.mjs）
        openPauses: async () => [], pausesBySource: async () => [],
      },
    },
  };
}

test('見回りの口: 会社ごとに設定を残し、その会社の承認待ちだけを足す・二度流しても同じ', async () => {
  const f = fakeDeps([{ id: 'a1', companyId: 'c1', title: 'Hire' }, { id: 'b1', companyId: 'c2', title: 'Other' }]);
  const r1 = await handleTick(f.deps, 'c1', { lang: 'ja', timeZone: 'Asia/Tokyo' });
  assert.equal(r1.status, 200); assert.deepEqual(r1.body.approvals, { added: 1, removed: 0 });
  const r2 = await handleTick(f.deps, 'c1', { lang: 'ja', timeZone: 'Asia/Tokyo' });
  assert.deepEqual(r2.body.approvals, { added: 0, removed: 0 });
  assert.deepEqual([...f.notices.values()].filter(n => n.kind === 'approval').map(n => [n.c, n.originId]), [['c1', 'a1']]);
  const s = await handleRoute(f.deps, { routeKey: 'settings', companyId: 'c1' });
  assert.deepEqual(s.body.settings, { lang: 'ja', timeZone: 'Asia/Tokyo' });
  const s2 = await handleRoute(f.deps, { routeKey: 'settings', companyId: 'c2' });
  assert.deepEqual(s2.body.settings, { lang: 'en', timeZone: null });
});

test('見回りの口: 決まった承認は消え、動いている間の呼び出しは 409', async () => {
  const pending = [{ id: 'a1', companyId: 'c1' }];
  const f = fakeDeps(pending);
  await handleTick(f.deps, 'c1', {});
  pending.length = 0;
  assert.deepEqual((await handleTick(f.deps, 'c1', {})).body.approvals, { added: 0, removed: 1 });
  let release; const slow = { ...f.deps, approvals: { list: () => new Promise(r => { release = () => r([]); }) } };
  const p = handleTick(slow, 'c1', {});
  assert.equal((await handleTick(slow, 'c1', {})).status, 409);
  release(); assert.equal((await p).status, 200);
});

test('読みました: 32 桁の key だけ受け、その会社の物に印を付ける', async () => {
  const f = fakeDeps([{ id: 'a1', companyId: 'c1' }]);
  await handleTick(f.deps, 'c1', {});
  const key = noticeKey('approval', 'a1');
  assert.equal((await handleRoute(f.deps, { routeKey: 'read', companyId: 'c1', body: { key: '../x' } })).status, 400);
  assert.equal((await handleRoute(f.deps, { routeKey: 'read', companyId: 'c2', body: { key }, owner: true })).status, 200);
  assert.equal(f.notices.get('c1' + key).readAt, null);
  // member（持ち主でない人）は decision 以外の知らせを既読にできない（設計 docs/design/2026-11-23-public-office-multi-user.md 2.2b）
  assert.equal((await handleRoute(f.deps, { routeKey: 'read', companyId: 'c1', body: { key } })).status, 403);
  assert.equal(f.notices.get('c1' + key).readAt, null);
  await handleRoute(f.deps, { routeKey: 'read', companyId: 'c1', body: { key }, owner: true });
  assert.equal(f.notices.get('c1' + key).readAt, 'now');
  assert.equal((await handleRoute(f.deps, { routeKey: 'nope', companyId: 'c1' })).status, 404);
});

// ---- 見回りの中身 ----
import { selectStuck, failingAgents, stepStreaks, digestBody, digestSlot, digestTitle, decisionPage, unanswered, reconcileKind, DICT } from '../plugins/notify/src/lib.mjs';
const MIN = 60000, T0 = Date.parse('2026-11-16T03:00:00Z');
const iss = (id, o = {}) => ({ id, title: `t ${id}`, identifier: `X-${id}`, status: 'in_progress', assigneeAgentId: 'g1', executionRunId: null, parentId: null, updatedAt: new Date(T0 - 61 * MIN).toISOString(), ...o });

test('止まった課題: 59 分は出ず 61 分は出る・実行中・担当なし・paused・閉じていない子を待つ親は出ない', () => {
  const st = new Map([['g1', 'idle'], ['gp', 'paused'], ['gt', 'terminated']]);
  const list = [iss('a'), iss('b', { updatedAt: new Date(T0 - 59 * MIN).toISOString() }), iss('c', { executionRunId: 'r1' }), iss('d', { assigneeAgentId: null }), iss('e', { assigneeAgentId: 'gp' }), iss('f', { assigneeAgentId: 'gt' }),
    iss('p'), iss('k', { parentId: 'p', status: 'in_review', updatedAt: new Date(T0).toISOString() }), iss('q'), iss('k2', { parentId: 'q', status: 'done' })];
  assert.deepEqual(selectStuck(list, { nowMs: T0, idleMin: 60, agentStatus: st }).map(x => x.issueId), ['a', 'q']);
  assert.deepEqual(selectStuck([iss('b', { updatedAt: new Date(T0 - 2 * MIN).toISOString() })], { nowMs: T0, idleMin: 1, agentStatus: st }).map(x => x.issueId), ['b']);
});

test('止まった課題: 定時の回は 1440 分を過ぎたら「古い定時の回」', () => {
  const r = [iss('r', { originKind: 'routine_execution' }), iss('s', { originKind: 'routine_execution', updatedAt: new Date(T0 - 1441 * MIN).toISOString() })];
  assert.deepEqual(selectStuck(r, { nowMs: T0, idleMin: 60 }).map(x => [x.issueId, x.kind]), [['s', 'stale_routine']]);
});

test('失敗の続き: 同じ担当の最後の 3 回が全部失敗の時だけ', () => {
  const f = a => ({ kind: 'run_failed', agentId: a }), ok = a => ({ kind: 'run_finished', agentId: a });
  assert.deepEqual(failingAgents(stepStreaks({}, [f('a'), f('a'), f('a'), f('b'), ok('b'), f('b'), f('b'), f('c'), f('c')])), ['a']);
  assert.deepEqual(failingAgents(stepStreaks({}, [f('a'), f('a'), f('a'), ok('a')])), []);
  // 数は回をまたいで続く（3 回目が次の回の event でも出る）
  assert.deepEqual(failingAgents(stepStreaks(stepStreaks({}, [f('a'), f('a')]), [f('a')])), ['a']);
});

test('朝夕のまとめの回: 持ち主の時刻帯で 8 時と 18 時・値なしは UTC', () => {
  assert.equal(digestSlot(Date.parse('2026-11-15T22:59:00Z'), 'Asia/Tokyo'), null); // JST 7:59
  assert.deepEqual(digestSlot(Date.parse('2026-11-15T23:00:00Z'), 'Asia/Tokyo'), { key: '2026-11-16:am', slot: 'am' }); // JST 8:00
  assert.deepEqual(digestSlot(Date.parse('2026-11-16T09:00:00Z'), 'Asia/Tokyo'), { key: '2026-11-16:pm', slot: 'pm' }); // JST 18:00
  assert.deepEqual(digestSlot(Date.parse('2026-11-16T13:00:00Z'), 'America/New_York'), { key: '2026-11-16:am', slot: 'am' }); // 8:00 EST
  assert.deepEqual(digestSlot(Date.parse('2026-11-16T08:00:00Z'), null), { key: '2026-11-16:am', slot: 'am' });
});

test('まとめの題: 英日・0 件の時の文・UTC の印', () => {
  assert.equal(digestTitle({ slot: 'am', lang: 'en', counts: { approval: 2, stuck: 1 } }), 'Morning summary: 2 approvals, 1 stuck tasks');
  assert.equal(digestTitle({ slot: 'pm', lang: 'ja', counts: { decision: 1 } }), '夕方のまとめ: 判断待ち 1');
  assert.equal(digestTitle({ slot: 'am', lang: 'ja', counts: {}, utc: true }), '朝のまとめ （UTC で動いています）: 待っている物はありません');
  assert.deepEqual(Object.keys(DICT.ja).sort(), Object.keys(DICT.en).sort());
});

test('判断待ち: 開いた課題を新しい順に 50 件まで・答えの無いカードだけ', () => {
  const many = Array.from({ length: 60 }, (_, i) => iss(`i${i}`, { status: i % 2 ? 'todo' : 'blocked', updatedAt: new Date(T0 - i * MIN).toISOString() }));
  const p1 = decisionPage([...many, iss('z', { status: 'done' })]);
  assert.equal(p1.page.length, 50); assert.equal(p1.last, false); assert.ok(!p1.page.some(x => x.id === 'z'));
  const p2 = decisionPage(many, p1.page.at(-1).id);
  assert.equal(p2.page.length, 10); assert.equal(p2.last, true);
  assert.deepEqual([...p1.page, ...p2.page].map(x => x.id).sort(), many.map(x => x.id).sort(), '2 回で全部を読む');
  assert.deepEqual(unanswered([{ id: 1, status: 'pending' }, { id: 2, status: 'answered' }, null]).map(x => x.id), [1]);
  assert.deepEqual(reconcileKind(['stuck', 'stale_routine'], [{ key: 'k1', kind: 'stuck' }], [{ key: 'k2', kind: 'stale_routine' }, { key: 'k3', kind: 'approval' }]), { add: [{ key: 'k1', kind: 'stuck' }], remove: ['k2'] });
});

test('見回りの口: 失敗の event・失敗の続き・止まった課題・判断待ちが出て、直ると消える', async () => {
  const issues = [iss('a'), iss('b', { status: 'todo', updatedAt: new Date(T0).toISOString() })];
  const f = fakeDeps([], { now: T0, issues, agents: [{ id: 'g1', name: 'Writer', status: 'idle' }], interactions: { b: [{ id: 'q1', status: 'pending', title: 'Pick one' }] },
    events: [{ kind: 'run_failed', entityId: 'r1', agentId: 'g1' }, { kind: 'run_failed', entityId: 'r2', agentId: 'g1' }, { kind: 'run_failed', entityId: 'r3', agentId: 'g1' }, { kind: 'issue', entityId: 'a' }] });
  const r = await handleTick(f.deps, 'c1', { lang: 'en' });
  const kinds = () => [...f.notices.values()].map(n => n.kind).sort();
  assert.deepEqual(kinds(), ['decision', 'run_failed', 'run_failed', 'run_failed', 'run_failing', 'stuck']);
  assert.ok(f.ev.every(e => e.done)); assert.equal(r.body.partial, false);
  assert.match([...f.notices.values()].find(n => n.kind === 'run_failing').title, /Runs keep failing: Writer/);
  // 直る: 課題が動き、カードに答え、成功の実行が入る
  issues[0].updatedAt = new Date(T0).toISOString(); f.deps.issues.listInteractions = async () => [{ id: 'q1', status: 'answered' }];
  f.ev.push({ id: 9, kind: 'run_finished', entityId: 'r4', agentId: 'g1', done: false });
  await handleTick(f.deps, 'c1', { lang: 'en' });
  assert.deepEqual(kinds(), ['run_failed', 'run_failed', 'run_failed']);
});

test('見回りの口: 設定の stuckIdleMin で境を変える（最小 1 分）', async () => {
  const f = fakeDeps([], { now: T0, issues: [iss('a', { updatedAt: new Date(T0 - 2 * MIN).toISOString() })], config: { stuckIdleMin: 1 } });
  await handleTick(f.deps, 'c1', {});
  assert.deepEqual([...f.notices.values()].map(n => n.kind), ['stuck']);
});

test('見回りの口: 枠を超えたら判断待ちの続きの位置を残して partial で返し、まとめまでは進む・読めていない回では消さない', async () => {
  const f = fakeDeps([], { now: T0, issues: [iss('b', { status: 'todo' })], interactions: { b: [{ id: 'q1', status: 'pending' }] } });
  await handleTick(f.deps, 'c1', {});
  assert.equal([...f.notices.values()].filter(n => n.kind === 'decision').length, 1);
  let calls = 0; f.deps.now = () => T0 + (calls++ > 2 ? 30000 : 0); // 判断待ちの 1 件目の前で 20 秒を超える
  f.deps.issues.listInteractions = async () => [];
  const r = await handleTick(f.deps, 'c1', {});
  assert.equal(r.body.partial, true); assert.equal(r.body.decision.scanDone, false);
  assert.equal([...f.notices.values()].filter(n => n.kind === 'decision').length, 1, '読めていない回では消さない');

});

test('判断待ちの持ち越し: 古い課題のカードは、新しい課題が 50 件増えても消えず、周を読み終えた時だけ突き合わせる（独立レビュー P1-3）', async () => {
  const issues = [iss('a-old', { status: 'todo', updatedAt: new Date(T0 - 999 * MIN).toISOString() })];
  const inter = { 'a-old': [{ id: 'q-old', status: 'pending' }] };
  const f = fakeDeps([], { now: T0, issues, interactions: inter });
  await handleTick(f.deps, 'c1', {});
  const dec = () => [...f.notices.values()].filter(n => n.kind === 'decision').map(n => n.originId);
  assert.deepEqual(dec(), ['a-old']);
  for (let i = 0; i < 60; i++) issues.push(iss(`z${String(i).padStart(2, '0')}`, { status: 'todo', updatedAt: new Date(T0).toISOString() }));
  const r1 = await handleTick(f.deps, 'c1', {}); // a-old と z00..z48 の 50 件
  assert.equal(r1.body.decision.scanDone, false); assert.deepEqual(dec(), ['a-old'], '周の途中では消さない');
  const r2 = await handleTick(f.deps, 'c1', {}); // 残りの z49..z59
  assert.equal(r2.body.decision.scanDone, true); assert.deepEqual(dec(), ['a-old'], '周を読み終えてもまだ答えていないので残る');
  inter['a-old'] = [{ id: 'q-old', status: 'answered' }];
  await handleTick(f.deps, 'c1', {}); await handleTick(f.deps, 'c1', {});
  assert.deepEqual(dec(), [], '答えた後の周の終わりで消える');
});

test('見回りの口: 朝夕のまとめはその回に 1 通だけ・時刻帯が無いと UTC の印', async () => {
  const f = fakeDeps([{ id: 'a1', companyId: 'c1' }], { now: Date.parse('2026-11-15T23:05:00Z') });
  const r1 = await handleTick(f.deps, 'c1', { lang: 'ja', timeZone: 'Asia/Tokyo' });
  assert.equal(r1.body.digestKey, '2026-11-16:am');
  await handleTick(f.deps, 'c1', { lang: 'ja', timeZone: 'Asia/Tokyo' });
  const d = [...f.notices.values()].filter(n => n.kind === 'digest');
  assert.equal(d.length, 1); assert.equal(d[0].title, '朝のまとめ: 承認待ち 1');
  const g = fakeDeps([], { now: Date.parse('2026-11-16T08:01:00Z') });
  await handleTick(g.deps, 'c1', {});
  assert.equal([...g.notices.values()].find(n => n.kind === 'digest').title, 'Morning summary (running on UTC): nothing is waiting');
});

test('migration は書き換えない: 記録した hash と同じ・新しい file は記録に足す（本体は流した migration の hash を覚えていて、違うと版上げを断る）', async () => {
  const { createHash } = await import('node:crypto');
  const dir = new URL('../plugins/notify/migrations/', import.meta.url);
  const lock = JSON.parse(readFileSync(new URL('../plugins/notify/migrations.lock.json', import.meta.url), 'utf8'));
  const { readdirSync } = await import('node:fs');
  const files = readdirSync(dir).filter(f => f.endsWith('.sql')).sort();
  assert.deepEqual(files, Object.keys(lock).sort(), 'migrations.lock.json に無い file・file の無い記録がある');
  for (const f of files) assert.equal(createHash('sha256').update(readFileSync(new URL(f, dir))).digest('hex'), lock[f], `${f} を書き換えた（新しい番号の file で足す）`);
});

// ---- office の帯（保証 17〜20） ----
import { bannerItems } from '../plugins/office/src/api.mjs';
test('office の帯: 待っている件と未読・見回りの遅れ・起動係を読めない・時刻帯の未設定', () => {
  const L = { timeZone: 'Asia/Tokyo', rounds: { 'aioffice.notify': { late: false } } };
  assert.deepEqual(bannerItems({ pending: 0, notices: [], launcher: L }), []);
  assert.deepEqual(bannerItems({ pending: 2, notices: [{ readAt: null }, { readAt: 'x' }], launcher: L }), [{ key: 'waiting', pending: 2, unread: 1 }]);
  assert.deepEqual(bannerItems({ notices: [], launcher: { ...L, rounds: { 'aioffice.notify': { late: true } } } }).map(b => b.key), ['rounds_late']);
  assert.deepEqual(bannerItems({ notices: [], launcher: 'down' }).map(b => b.key), ['rounds_late']);
  assert.deepEqual(bannerItems({ notices: [], launcher: { ...L, rounds: { 'aioffice.notify': { late: false, lastError: 'tick 404' } } } }).map(b => b.key), ['rounds_late']);
  assert.deepEqual(bannerItems({ notices: [], launcher: { ...L, timeZone: null } }).map(b => b.key), ['tz_unset']);
  // package の外（起動係なし）・知らせの plugin なし（null）では遅れも時刻帯も出さない
  assert.deepEqual(bannerItems({ notices: null, launcher: null }), []);
  assert.deepEqual(bannerItems({ notices: null, launcher: { timeZone: null } }), []);
});

test('office の帯は常にある 1 つの入れ物の中（帯の数が変わっても後ろの欄が作り直されず、受信箱の「済み」が消えない・2026-11-16 e2e で見つけた）', () => {
  const src = readFileSync(new URL('../plugins/office/src/ui.mjs', import.meta.url), 'utf8');
  assert.match(src, /h\('div', \{ 'data-banners': '1' \}, \.\.\.bannerItems\(/);
  assert.ok(!/^\s*\.\.\.bannerItems\(/m.test(src), 'root の子に帯を直に並べない');
});

// ---- 秘密を伏せる（保証 4）・片付け（独立レビュー P2-1・P2-4） ----
import { redactSecrets, RETENTION } from '../plugins/notify/src/lib.mjs';
import { dbStore } from '../plugins/notify/src/worker.mjs';
test('知らせの文の秘密の形を伏せる・普通の文は変えない', async () => {
  const fake = ['sk-' + 'a'.repeat(24), 'ghp_' + 'b'.repeat(30), 'xoxb-' + '1'.repeat(12), 'AKIA' + 'C'.repeat(16)];
  for (const k of fake) assert.ok(!redactSecrets(`use ${k} now`).includes(k), k.slice(0, 4));
  assert.equal(redactSecrets('password: hunter22x'), 'password: [hidden]');
  assert.equal(redactSecrets('Bearer abcdefghijk'), '[hidden]');
  // 仕様の試験の例（保証 4）・大文字と小文字・前後の空白・複数行
  for (const [inp, bad] of [['pcp_board_' + 'a'.repeat(20), 'pcp_board_'], ['DATABASE_URL=postgres://u:pw123456@h/db', 'pw123456'], ['MY_TOKEN: abcdef123456', 'abcdef123456'],
    ['https://hooks.slack.com/services/T000/B000/XXXX', 'hooks.slack.com'], ['acct 12345678 ok', '12345678'], ['api_key = zzzzzz99', 'zzzzzz99'], ['line1\n  Secret:  qwerty1234\nline3', 'qwerty1234'],
    ['-----BEGIN RSA PRIVATE KEY-----\nMIIabc\n-----END RSA PRIVATE KEY-----', 'MIIabc']]) {
    assert.ok(!redactSecrets(inp).includes(bad), inp.slice(0, 20));
  }
  const { KEY_PATTERNS } = await import('../plugins/notify/src/lib.mjs');
  assert.ok(KEY_PATTERNS.length >= 7, '移す元（ops/rag/rag-lib.mjs）の 7 つの形を減らさない');
  assert.equal(redactSecrets('Decision waiting: X-1 Pick a logo color'), 'Decision waiting: X-1 Pick a logo color');
  assert.equal(redactSecrets('判断待ち: 色を選ぶ'), '判断待ち: 色を選ぶ');
});
test('表への書き込みで題を伏せる・突き合わせは種類を絞って上限なしで読む・片付けは 3 本', async () => {
  const calls = [];
  const db = { namespace: 'plugin_notify_x', execute: async (sql, params) => { calls.push({ sql, params }); }, query: async (sql, params) => { calls.push({ sql, params }); return []; } };
  const st = dbStore(db);
  await st.addNotice('c1', { key: 'k', kind: 'decision', originId: 'i', title: 'token=' + 'z'.repeat(20) });
  assert.equal(calls[0].params[4], 'token=[hidden]');
  await st.listNotices('c1', { kinds: ['approval'] });
  assert.ok(!/LIMIT/.test(calls[1].sql)); assert.deepEqual(calls[1].params, ['c1', 'approval']);
  await st.listNotices('c1');
  assert.match(calls[2].sql, /ORDER BY \(read_at IS NOT NULL\), created_at DESC LIMIT 300/);
  await st.prune('c1');
  assert.equal(calls.length, 6); assert.ok(calls.slice(3).every(c => c.params[0] === 'c1'));
  // 読んで 7 日で消すのは失敗とまとめだけ（突き合わせで持つ種類を消すと未読で戻る・2 回目のレビュー P2-A）
  assert.match(calls[3].sql, /kind = ANY\(string_to_array\(\$2, ','\)\)/); assert.equal(calls[3].params[1], 'run_failed,digest');
  assert.equal(RETENTION.readDays, 7);
});

test('office の帯: 承認の知らせは未読に数えず（承認の一覧で数える）、受信箱の知らせの欄にも出さない・捨てた event があると版の帯', async () => {
  const { inboxNotices } = await import('../plugins/office/src/api.mjs');
  const L = { timeZone: 'Asia/Tokyo', rounds: {} };
  const list = [{ kind: 'approval', readAt: null }, { kind: 'run_failed', readAt: null }];
  assert.deepEqual(bannerItems({ pending: 1, notices: list, launcher: L }), [{ key: 'waiting', pending: 1, unread: 1 }]);
  assert.deepEqual(inboxNotices(list).map(n => n.kind), ['run_failed']);
  assert.deepEqual(bannerItems({ notices: [], launcher: { ...L, rounds: { 'aioffice.notify': { late: false, dropped: 2 } } } }).map(b => b.key), ['version_mismatch']);
});

test('題は伏せてから切るので、切れ目にかかった鍵の頭も残らない', async () => {
  const { safeTitle } = await import('../plugins/notify/src/lib.mjs');
  const t = 'x'.repeat(190) + ' sk-' + 'abcdefghijklmnopqrstuvwxyz';
  assert.ok(!safeTitle(t, 200).includes('sk-abc'));
  assert.equal(safeTitle('ふつうの題', 200), 'ふつうの題');
});

test('見回りの口: 最初から枠を超えた回でも、止まった課題と判断待ちを飛ばしてまとめは作る（2 回目のレビュー P3）', async () => {
  const AM = Date.parse('2026-11-15T23:05:00Z'); // JST 8:05（まとめの回に入っている）
  const f = fakeDeps([], { now: AM, issues: [iss('b', { status: 'todo' })], interactions: { b: [{ id: 'q1', status: 'pending' }] } });
  let calls = 0; f.deps.now = () => AM + (calls++ > 0 ? 30000 : 0);
  const r = await handleTick(f.deps, 'c1', { lang: 'ja', timeZone: 'Asia/Tokyo' });
  assert.equal(r.body.partial, true);
  assert.equal(r.body.decision, undefined, '判断待ちは次の回へ回す');
  assert.ok(r.body.digestKey, 'まとめの回の key が返る');
  assert.equal([...f.notices.values()].filter(n => n.kind === 'digest').length, 1, 'まとめの知らせが 1 件できる');
});

// ---- codex の最終確認の 4 件（2026-11-16） ----
test('codex P2-1: 引用符で囲んだ空白入りの値・短い値も名前の規則で伏せる', () => {
  for (const [inp, bad] of [['PASSWORD="alpha bravo charlie"', 'bravo'], ['PASSWORD="ab cd ef"', 'ab cd'], ["api_key = 'x y'", 'x y'], ['token: ab', ': ab'], ['MY_SECRET=abc', 'abc']]) {
    const out = redactSecrets(inp);
    assert.ok(!out.includes(bad), `${inp} → ${out}`);
    assert.match(out, /\[hidden\]/);
  }
  assert.equal(redactSecrets('PASSWORD="a b"'), 'PASSWORD="[hidden]"');
});

test('codex P2-2: まとめは未読の件数と一覧を持ち、前のまとめが未読なら「待っている物はありません」にしない', async () => {
  const AM = Date.parse('2026-11-15T23:05:00Z'), PM = Date.parse('2026-11-16T09:05:00Z');
  const f = fakeDeps([{ id: 'a1', companyId: 'c1', title: 'Hire a designer' }], { now: AM });
  await handleTick(f.deps, 'c1', { lang: 'ja', timeZone: 'Asia/Tokyo' });
  const am = [...f.notices.values()].find(n => n.kind === 'digest');
  assert.match(am.title, /承認待ち 1/);
  assert.match(am.body, /承認待ち: .*Hire a designer/);
  for (const n of f.notices.values()) if (n.kind === 'approval') f.notices.delete(n.c + n.key);
  f.deps.approvals.list = async () => [];
  f.setNow(PM);
  await handleTick(f.deps, 'c1', { lang: 'ja', timeZone: 'Asia/Tokyo' });
  const pm = [...f.notices.values()].find(n => n.kind === 'digest' && n.originId.endsWith(':pm'));
  assert.match(pm.title, /未読の知らせ 1/);
  assert.doesNotMatch(pm.title, /待っている物はありません/);
  assert.match(pm.body, /朝のまとめ/);
  // 多い時は 10 件と「ほか n 件」
  const many = Array.from({ length: 12 }, (_, i) => ({ kind: 'decision', title: `D${i}` }));
  const b = digestBody({ lang: 'en', unread: many });
  assert.equal(b.split('\n').length, 11); assert.match(b, /and 2 more/);
});

test('codex P2-3: event と承認の処理も 1 件ごとに 20 秒の枠を見て、処理した event だけ済みにする', async () => {
  const evs = Array.from({ length: 500 }, (_, i) => ({ kind: 'run_failed', entityId: `r${i}`, agentId: 'a' }));
  const f = fakeDeps([], { events: evs });
  let t = 0; f.deps.now = () => (t += 70); // 1 回の時計の読みごとに 70ms
  const r = await handleTick(f.deps, 'c1', {});
  assert.equal(r.body.partial, true);
  const done = f.ev.filter(e => e.done).length;
  assert.ok(done > 0 && done < 500, `済み ${done}`);
  assert.equal([...f.notices.values()].filter(n => n.kind === 'run_failed').length, done, '済みにした event の分だけ知らせがある');
  t = 0; f.deps.now = () => 0;
  await handleTick(f.deps, 'c1', {});
  assert.equal(f.ev.filter(e => e.done).length, 500, '次の回で残りを処理する');
});

test('codex P2-4: 連続失敗の知らせは、ほかの担当の実行が多くても・event が片付いても、その担当が成功するまで消えない', async () => {
  const f = fakeDeps([], { agents: [{ id: 'A', name: 'Writer', status: 'idle' }, { id: 'B', name: 'Other', status: 'idle' }],
    events: [1, 2, 3].map(i => ({ kind: 'run_failed', entityId: `a${i}`, agentId: 'A' })) });
  await handleTick(f.deps, 'c1', {});
  const failing = () => [...f.notices.values()].filter(n => n.kind === 'run_failing').map(n => n.originId);
  assert.deepEqual(failing(), ['A']);
  // B の成功が 400 回・済んだ event は片付けで消える
  for (let i = 0; i < 400; i++) f.ev.push({ id: 1000 + i, done: false, kind: 'run_finished', entityId: `b${i}`, agentId: 'B' });
  f.ev.splice(0, 3);
  await handleTick(f.deps, 'c1', {});
  assert.deepEqual(failing(), ['A'], 'A は直っていない');
  f.ev.push({ id: 5000, done: false, kind: 'run_finished', entityId: 'a9', agentId: 'A' });
  await handleTick(f.deps, 'c1', {});
  assert.deepEqual(failing(), [], 'A が成功したら消える');
});

test('まとめの一覧は種類の名前を重ねず、承認は本体の payload の題を使い、長い題でも伏せる処理は詰めてから行う', async () => {
  const b = digestBody({ lang: 'ja', unread: [{ kind: 'decision', title: '判断待ち: CMP-4 確認' }, { kind: 'run_failed', title: '実行の失敗' }, { kind: 'approval', title: '人を雇う' }] });
  assert.equal(b, '- 承認待ち: 人を雇う\n- 判断待ち: CMP-4 確認\n- 実行の失敗');
  const f = fakeDeps([{ id: 'a1', companyId: 'c1', type: 'request_board_approval', payload: { title: 'Hire a designer' } }]);
  await handleTick(f.deps, 'c1', {});
  assert.equal([...f.notices.values()].find(n => n.kind === 'approval').title, 'Hire a designer');
  const { safeTitle } = await import('../plugins/notify/src/lib.mjs');
  const long = 'KEY' + 'a.'.repeat(100000);
  const t0 = Date.now(); const out = safeTitle(long, 200);
  assert.ok(Date.now() - t0 < 500, '長い題でも速い'); assert.ok(out.length <= 200);
});

// ---- codex の 2 回目・独立レビューの 2 回目（2026-11-16） ----
test('codex 2 回目 P2-1: 引用符の中の \\" の後ろも伏せる（題の加工から保存まで）', async () => {
  assert.equal(redactSecrets('PASSWORD="alpha \\"bravo charlie" ok'), 'PASSWORD="[hidden]" ok');
  assert.equal(redactSecrets("api_key='a \\'b c' ok"), "api_key='[hidden]' ok");
  const f = fakeDeps([{ id: 'a1', companyId: 'c1', title: 'see PASSWORD="alpha \\"bravo charlie"' }]);
  await handleTick(f.deps, 'c1', {});
  const ti = [...f.notices.values()].find(n => n.kind === 'approval').title;
  assert.ok(!ti.includes('bravo'), ti);
});

test('codex 2 回目 P2-2: 数を持たない版からの版上げでも、出ている「失敗が続いています」は成功まで消えない', async () => {
  const f = fakeDeps([], { agents: [{ id: 'A', name: 'Writer', status: 'idle' }] });
  f.notices.set('c1' + noticeKey('run_failing', 'A'), { key: noticeKey('run_failing', 'A'), kind: 'run_failing', originId: 'A', title: 'x', c: 'c1', readAt: null });
  await handleTick(f.deps, 'c1', {});
  const failing = () => [...f.notices.values()].filter(n => n.kind === 'run_failing').map(n => n.originId);
  assert.deepEqual(failing(), ['A']);
  f.ev.push({ id: 9, done: false, kind: 'run_finished', entityId: 'r9', agentId: 'A' });
  await handleTick(f.deps, 'c1', {});
  assert.deepEqual(failing(), []);
});

test('P3: 英語のまとめで判断待ちの名前を重ねない・長い題の切れ目にかかった鍵を見せない', async () => {
  assert.equal(digestBody({ lang: 'en', unread: [{ kind: 'decision', title: 'Decision waiting: Pick one' }] }), '- Decision waiting: Pick one');
  const { safeTitle } = await import('../plugins/notify/src/lib.mjs');
  const jwt = 'eyJ' + 'a'.repeat(200) + '.eyJ' + 'b'.repeat(200) + '.' + 'c'.repeat(100);
  const s = 'see ' + jwt + ' then ' + 'x'.repeat(585 - 10 - jwt.length > 0 ? 585 - 10 - jwt.length : 70) + ' ghp_' + 'Z'.repeat(36) + ' end';
  for (let pad = 0; pad < 40; pad++) { const out = safeTitle('y'.repeat(pad) + s, 200); assert.ok(!/ghp_Z/.test(out), out); }
});
