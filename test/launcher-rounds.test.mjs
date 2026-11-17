// 起動係の見回りの係（lib/rounds.mjs）・書き込みの関所（lib/gate.mjs）・capability が増えた時の入れ直し（lib/plugins.mjs）の試験。本体と CLI は偽物
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createGate, WRITE_METHODS } from '../packages/aioffice/launcher/lib/gate.mjs';
import { createRounds, lastDigestSlot, DIGEST_LATE_MS, tickBody, ROUND_PLUGINS, EVERY_MS, LATE_MS } from '../packages/aioffice/launcher/lib/rounds.mjs';
import { createPluginInstaller, CAPABILITY_ESCALATION } from '../packages/aioffice/launcher/lib/plugins.mjs';
import { validTimeZone } from '../packages/aioffice/launcher/server.mjs';

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'aio-rounds-'));

test('関所: 6 本までは通し、7 本目は待たせ、1 本終わると流れる', async () => {
  const g = createGate({ max: 6 });
  const rel = []; for (let i = 0; i < 6; i++) rel.push(await g.acquire());
  let seventh = false; const p = g.acquire().then(r => { seventh = true; return r; });
  await new Promise(r => setImmediate(r));
  assert.equal(seventh, false); assert.equal(g.waiting, 1); assert.equal(g.active, 6);
  rel[0](); rel[0](); // 二度呼んでも 1 本分だけ空く
  const r7 = await p; assert.equal(seventh, true); assert.equal(g.active, 6); assert.equal(g.waiting, 0);
  r7(); for (const r of rel.slice(1)) r(); assert.equal(g.active, 0);
});

test('関所: 待ちが上限を超えると gate_timeout・待ちの列から外れる', async () => {
  let fire; const g = createGate({ max: 1, waitMs: 60_000, setTimer: fn => { fire = fn; return 1; }, clearTimer: () => {} });
  const r1 = await g.acquire();
  const p = g.acquire(); fire();
  await assert.rejects(p, /gate_timeout/); assert.equal(g.waiting, 0);
  r1(); assert.equal(g.active, 0);
  assert.ok(WRITE_METHODS.has('POST') && WRITE_METHODS.has('PATCH') && !WRITE_METHODS.has('GET'));
});

test('見回りの body: 言語は en か ja・時刻帯は state にある時だけ', () => {
  assert.deepEqual(tickBody({ lang: 'ja', timeZone: 'Asia/Tokyo' }), { lang: 'ja', timeZone: 'Asia/Tokyo' });
  assert.deepEqual(tickBody({ lang: null, timeZone: null }), { lang: 'en' });
  assert.equal(validTimeZone('Asia/Tokyo'), 'Asia/Tokyo'); assert.equal(validTimeZone('Mars/Base'), null); assert.equal(validTimeZone(5), null);
});

// 本体の偽物: 会社の一覧と plugin の見回りの口
function fakeCore({ companies = [{ id: 'c1' }, { id: 'c2' }], fail = {} } = {}) {
  const calls = [];
  const fetchFn = async (url, init = {}) => {
    const u = new URL(url);
    calls.push({ method: init.method || 'GET', path: u.pathname, companyId: u.searchParams.get('companyId'), body: init.body ? JSON.parse(init.body) : null });
    if (u.pathname === '/api/companies') return { ok: true, status: 200, json: async () => companies };
    const m = u.pathname.match(/^\/api\/plugins\/([^/]+)\/api\/tick$/);
    if (m) { const st = fail[decodeURIComponent(m[1])] || 200; return { ok: st < 300, status: st, json: async () => (st < 300 ? { v: 1, digestKey: 'd1' } : { error: 'notify_busy' }) }; }
    return { ok: false, status: 404, json: async () => ({}) };
  };
  return { fetchFn, calls };
}

test('見回り: wizard の前は呼ばない・後は会社ごと・入っている plugin ごとに 1 回ずつ呼び、言語と時刻帯を渡す', async () => {
  const dir = tmp(), core = fakeCore(); let t = Date.parse('2026-11-16T00:00:00Z'); const state = { done: false, lang: 'ja', timeZone: 'Asia/Tokyo' };
  const r = createRounds({ pcUrl: 'http://127.0.0.1:3101', dataDir: dir, getState: () => state, installed: () => ['aioffice.notify', 'aioffice.office'], fetchFn: core.fetchFn, now: () => t });
  await r.runOnce(); assert.equal(core.calls.length, 0);
  state.done = true; await r.runOnce();
  const ticks = core.calls.filter(c => c.path.endsWith('/tick'));
  assert.deepEqual(ticks.map(c => [c.method, c.path, c.companyId]), [['POST', '/api/plugins/aioffice.notify/api/tick', 'c1'], ['POST', '/api/plugins/aioffice.notify/api/tick', 'c2']]);
  assert.deepEqual(ticks[0].body, { lang: 'ja', timeZone: 'Asia/Tokyo' });
  assert.equal(r.status()['aioffice.notify'].late, false); assert.equal(r.status()['aioffice.library'], undefined);
  assert.ok(ROUND_PLUGINS.includes('aioffice.library'));
});

test('見回り: 5 分たつまでは流さず、成功が 15 分ないと遅れ・失敗は記録する', async () => {
  const dir = tmp(); let t = Date.parse('2026-11-16T00:00:00Z');
  const core = fakeCore({ fail: {} }); const state = { done: true, lang: 'en' };
  const r = createRounds({ pcUrl: 'http://x', dataDir: dir, getState: () => state, installed: () => ['aioffice.notify'], fetchFn: core.fetchFn, now: () => t });
  assert.ok(await r.maybeRun()); const n = core.calls.length;
  t += EVERY_MS - 1; assert.equal(await r.maybeRun(), null); assert.equal(core.calls.length, n);
  t += 1; assert.ok(await r.maybeRun());
  const failing = fakeCore({ fail: { 'aioffice.notify': 409 } });
  const r2 = createRounds({ pcUrl: 'http://x', dataDir: dir, getState: () => state, installed: () => ['aioffice.notify'], fetchFn: failing.fetchFn, now: () => t });
  t += EVERY_MS; await r2.maybeRun();
  assert.match(r2.status()['aioffice.notify'].lastError, /tick 409 notify_busy/);
  assert.equal(r2.status()['aioffice.notify'].late, false);
  t += LATE_MS - EVERY_MS + 1; assert.equal(r2.status()['aioffice.notify'].late, true);
});

test('見回り: 本体の会社の一覧が読めない時は、入っている plugin に失敗を記録する', async () => {
  const dir = tmp(); const t = 1_800_000_000_000;
  const r = createRounds({ pcUrl: 'http://x', dataDir: dir, getState: () => ({ done: true }), installed: () => ['aioffice.notify'], fetchFn: async () => { throw new Error('ECONNREFUSED'); }, now: () => t });
  await r.runOnce(); assert.match(r.status()['aioffice.notify'].lastError, /ECONNREFUSED/);
});

// capability が増えた版上げ
function host({ upgradeErr = '' } = {}) {
  const plugins = new Map([['aioffice.notify', { pluginKey: 'aioffice.notify', status: 'ready', packagePath: null }]]);
  const calls = [];
  const fetchFn = async url => { const p = new URL(url).pathname; if (p === '/api/health') return { ok: true, json: async () => ({}) }; if (p === '/api/plugins') return { ok: true, json: async () => [...plugins.values()] }; return { ok: false, status: 404, json: async () => ({}) }; };
  const runCli = async (_b, args) => {
    calls.push(args.filter(a => !a.startsWith('http') && a !== '--api-base' && a !== '--json').join(' '));
    const [, cmd, a2, a3] = args;
    if (cmd === 'upgrade') return upgradeErr ? { ok: false, out: '', err: upgradeErr } : { ok: true, out: '', err: '' };
    if (cmd === 'uninstall') { plugins.delete(a2); return { ok: true, out: '', err: '' }; }
    if (cmd === 'install') { plugins.set('aioffice.notify', { pluginKey: 'aioffice.notify', status: 'ready', packagePath: a3 }); return { ok: true, out: '', err: '' }; }
    return { ok: true, out: '', err: '' };
  };
  return { fetchFn, runCli, calls };
}
function bundled() { const root = tmp(), dir = path.join(root, 'notify'); fs.mkdirSync(dir); fs.writeFileSync(path.join(dir, 'BUILD_ID'), 'b2'); fs.writeFileSync(path.join(dir, 'PLUGIN_KEY'), JSON.stringify({ key: 'aioffice.notify' })); return root; }

test('入れ直し: capability が増えて upgrade を断られた時だけ、--force なしで外して入れ直す', async () => {
  const msg = 'API error 400: Upgrade for "x" introduces new capabilities that require approval: issue.comments.create.';
  assert.ok(CAPABILITY_ESCALATION.test(msg));
  const h = host({ upgradeErr: msg });
  const rec = await createPluginInstaller({ pcUrl: 'http://127.0.0.1:3101', dataDir: tmp(), pluginsDir: bundled(), fetchFn: h.fetchFn, runCli: h.runCli, sleep: async () => {}, healthTries: 2, healthRounds: 1 }).ensure();
  assert.deepEqual(h.calls.map(c => c.split(' ').slice(0, 2).join(' ')), ['plugin upgrade', 'plugin uninstall', 'plugin install']);
  assert.ok(h.calls.every(c => !c.includes('--force')));
  assert.equal(rec['aioffice.notify'].status, 'ready'); assert.equal(rec['aioffice.notify'].buildId, 'b2');
});

test('入れ直し: ほかの理由で upgrade が失敗した時は外さない（failed のまま次の起動でやり直す）', async () => {
  const h = host({ upgradeErr: 'API error 500: boom' });
  const rec = await createPluginInstaller({ pcUrl: 'http://127.0.0.1:3101', dataDir: tmp(), pluginsDir: bundled(), fetchFn: h.fetchFn, runCli: h.runCli, sleep: async () => {}, healthTries: 2, healthRounds: 1 }).ensure();
  assert.deepEqual(h.calls.map(c => c.split(' ').slice(0, 2).join(' ')), ['plugin upgrade']);
  assert.equal(rec['aioffice.notify'].status, 'failed');
});

test('関所: 列で待つ間に abort すると列から抜けて gate_aborted・枠は増えない・abort 済みはすぐ断る', async () => {
  const g = createGate({ max: 1 });
  const r1 = await g.acquire();
  const ac = new AbortController();
  const p = g.acquire({ signal: ac.signal });
  assert.equal(g.waiting, 1);
  ac.abort();
  await assert.rejects(p, /gate_aborted/);
  assert.equal(g.waiting, 0); assert.equal(g.active, 1);
  r1(); assert.equal(g.active, 0);
  await assert.rejects(g.acquire({ signal: ac.signal }), /gate_aborted/);
  assert.equal(g.active, 0);
});

test('見回り: ready でない plugin は口を呼ばず遅れとして出す（独立レビュー P2-3）', async () => {
  const dir = tmp(), core = fakeCore(); const t = Date.parse('2026-11-16T00:00:00Z');
  const r = createRounds({ pcUrl: 'http://x', dataDir: dir, getState: () => ({ done: true, lang: 'en' }), installed: () => ['aioffice.notify'], ready: () => [], fetchFn: core.fetchFn, now: () => t });
  await r.runOnce();
  assert.equal(core.calls.filter(c => c.path.endsWith('/tick')).length, 0);
  assert.deepEqual(r.status()['aioffice.notify'], { late: true, lastOkAt: null, lastError: 'not_ready' });
});

test('まとめの回: 持ち主の時刻帯で今より前の最後の回の key と始まりの時刻', () => {
  const tokyo = 'Asia/Tokyo';
  assert.deepEqual(lastDigestSlot(Date.parse('2026-11-16T00:30:00Z'), tokyo), { key: '2026-11-16:am', at: Date.parse('2026-11-15T23:00:00Z') }); // JST 9:30
  assert.deepEqual(lastDigestSlot(Date.parse('2026-11-16T10:00:00Z'), tokyo), { key: '2026-11-16:pm', at: Date.parse('2026-11-16T09:00:00Z') }); // JST 19:00
  assert.deepEqual(lastDigestSlot(Date.parse('2026-11-15T20:00:00Z'), tokyo), { key: '2026-11-15:pm', at: Date.parse('2026-11-15T09:00:00Z') }); // JST 5:00
});

test('見回り: まとめの回の始まりから 1 時間たっても、その回の key が返事に無いと遅れ（保証 20・独立レビュー P2-2）', async () => {
  const dir = tmp(); let t = Date.parse('2026-11-15T22:00:00Z'); // JST 7:00 に起動
  const state = { done: true, lang: 'ja', timeZone: 'Asia/Tokyo' };
  let digestKey = null;
  const fetchFn = async (url, init) => { const u = new URL(url); if (u.pathname === '/api/companies') return new Response(JSON.stringify([{ id: 'c1' }])); return new Response(JSON.stringify({ v: 1, digestKey })); };
  const r = createRounds({ pcUrl: 'http://x', dataDir: dir, getState: () => state, installed: () => ['aioffice.notify'], fetchFn, now: () => t });
  await r.runOnce();
  t = Date.parse('2026-11-15T23:50:00Z'); await r.runOnce(); // JST 8:50: まだ 1 時間たっていない
  assert.equal(r.status()['aioffice.notify'].late, false);
  t = Date.parse('2026-11-16T00:05:00Z'); await r.runOnce(); // JST 9:05: 回の key が出ていない
  assert.equal(r.status()['aioffice.notify'].late, true);
  digestKey = '2026-11-16:am'; await r.runOnce();
  assert.equal(r.status()['aioffice.notify'].late, false);
  assert.equal(DIGEST_LATE_MS, 3600000);
});
