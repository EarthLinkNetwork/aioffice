// 図書室の plugin の worker（範囲: docs/review/2026-11-16-library-notify-scope.md の保証 3・7・11〜14）
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { createHash } from 'node:crypto';
import manifest from '../plugins/library/src/manifest.mjs';
import { handleTick, handleRoute, eventRow, ingestIssue } from '../plugins/library/src/worker.mjs';
import { singleFlight } from '../plugins/notify/src/lib.mjs';
import { BRIEF_MARK, LIMITS } from '../plugins/library/src/lib.mjs';

// 表を Map で真似る（会社の id で絞ることも同じ形）
function memStore() {
  const chunks = new Map(), docs = new Map(), events = [], seq = { n: 0 };
  const ck = (c, id) => `${c}\u0000${id}`;
  return {
    chunks, docs, events,
    addEvent: async r => { events.push({ id: events.length + 1, done: false, ...r }); },
    openEvents: async c => events.filter(e => e.companyId === c && !e.done),
    doneEvents: async (c, ids) => { for (const e of events) if (e.companyId === c && ids.includes(e.id)) e.done = true; },
    pruneEvents: async () => {},
    putSource: async (c, srcId, rows) => {
      const have = new Map([...chunks.values()].filter(r => r.c === c && r.srcId === srcId).map(r => [r.id, r.hash]));
      let n = 0;
      for (const r of rows) { if (have.get(r.id) === r.hash) { have.delete(r.id); continue; } have.delete(r.id); n++; chunks.set(ck(c, r.id), { ...r, c, updatedAt: ++seq.n }); }
      for (const id of have.keys()) chunks.delete(ck(c, id));
      return n;
    },
    dropIssueExcept: async (c, issueId, keep) => { for (const [k, r] of chunks) if (r.c === c && r.issueId === issueId && !keep.includes(r.srcId)) chunks.delete(k); },
    dropMissingIssues: async (c, live) => { for (const [k, r] of chunks) if (r.c === c && r.issueId && !live.includes(r.issueId)) chunks.delete(k); },
    byIdentifier: async (c, id, limit = LIMITS.k) => { const re = new RegExp(`(^|[^a-z0-9])${id}([^0-9]|$)`, 'i'); return [...chunks.values()].filter(r => r.c === c && (re.test(r.title) || re.test(r.text))).sort((a, b) => b.updatedAt - a.updatedAt).slice(0, limit); },
    // 本物と同じく新しい順に上限で切る
    candidates: async (c, ws, limit = LIMITS.candidates) => [...chunks.values()].filter(r => r.c === c && ws.some(w => (`${r.title}\n${r.text}`).toLowerCase().includes(w.toLowerCase()))).sort((a, b) => b.updatedAt - a.updatedAt).slice(0, limit),
    counts: async c => ({ chunks: [...chunks.values()].filter(r => r.c === c).length, docs: [...docs.values()].filter(d => d.c === c).length, bytes: [...docs.values()].filter(d => d.c === c).reduce((s, d) => s + d.size, 0) }),
    listDocs: async c => [...docs.values()].filter(d => d.c === c).map(({ name, size }) => ({ name, size })),
    docSize: async (c, name) => docs.get(ck(c, name))?.size ?? null,
    putDoc: async (c, name, text, size) => { docs.set(ck(c, name), { c, name, text, size }); },
    removeDoc: async (c, name) => { docs.delete(ck(c, name)); for (const [k, r] of chunks) if (r.c === c && r.srcId === `doc:${name}`) chunks.delete(k); },
  };
}

const NOW = Date.parse('2026-11-16T03:00:00Z');
function fakeDeps({ issues = [], comments = {}, documents = {}, interactions = {}, approvals = [], agents = [] } = {}) {
  const state = new Map(), created = [];
  let clock = NOW;
  const store = memStore();
  return {
    store, state, created, setNow: v => { clock = v; },
    deps: {
      store, now: () => clock, flight: singleFlight(),
      state: { get: async k => state.get(JSON.stringify(k)), set: async (k, v) => state.set(JSON.stringify(k), v) },
      agents: { list: async () => agents },
      approvals: { list: async ({ companyId }) => approvals.filter(a => a.companyId === companyId), get: async (id, c) => approvals.find(a => a.id === id && a.companyId === c) || null },
      issues: {
        list: async ({ companyId, status, limit = 1e9 }) => issues.filter(i => i.companyId === companyId && (!status || i.status === status)).slice(0, limit),
        get: async (id, c) => issues.find(i => i.id === id && i.companyId === c) || null,
        listComments: async id => comments[id] || [],
        listInteractions: async id => interactions[id] || [],
        documents: { list: async id => (documents[id] || []).map(({ key, title }) => ({ key, title })), get: async (id, key) => (documents[id] || []).find(d => d.key === key) || null },
        createComment: async (id, body, c) => { created.push({ id, body, c }); comments[id] = [...(comments[id] || []), { id: `brief${created.length}`, body, authorAgentId: null }]; },
      },
    },
  };
}
const issue = (id, o = {}) => ({ id, companyId: 'c1', identifier: `CMP-${id.replace(/\D/g, '') || 1}`, title: `Task ${id}`, description: '', status: 'done', createdAt: new Date(NOW - 864e5).toISOString(), updatedAt: new Date(NOW - 864e5).toISOString(), ...o });
const JSONH = { 'content-type': 'application/json' };

test('manifest: 外へ送る宣言と agents.invoke を持たない・口は会社で絞る（課題を作る・起こすのは聞くの口だけ: test/plugin-library-ask.test.mjs）', () => {
  for (const c of ['http.outbound', 'secrets.read-ref', 'agents.invoke']) assert.ok(!manifest.capabilities.includes(c), c);
  for (const r of manifest.apiRoutes) { assert.equal(r.auth, 'board'); assert.deepEqual(r.companyResolution, { from: 'query', key: 'companyId' }); }
  assert.equal(manifest.id, 'aioffice.library');
});

test('migration: 配った file は書き換えない（hash が記録と同じ・記録に無い file が無い）・schema は本体の決めた名前', () => {
  const dir = new URL('../plugins/library/migrations/', import.meta.url);
  const lock = JSON.parse(readFileSync(new URL('../plugins/library/migrations.lock.json', import.meta.url)));
  const files = readdirSync(dir).filter(f => f.endsWith('.sql')).sort();
  assert.deepEqual(files, Object.keys(lock).sort());
  for (const f of files) assert.equal(createHash('sha256').update(readFileSync(new URL(f, dir))).digest('hex'), lock[f], f);
  const ns = `plugin_library_${createHash('sha256').update('aioffice.library').digest('hex').slice(0, 10)}`;
  assert.match(readFileSync(new URL('001_init.sql', dir), 'utf8'), new RegExp(`${ns}\\.chunks`));
});

test('event: 課題・comment・文書の event は課題の id で 1 行・承認は決まった時・形の合わない物は捨てる', () => {
  assert.deepEqual(eventRow({ eventType: 'issue.comment.created', companyId: 'c1', entityId: 'cm1', payload: { issueId: 'i1' }, occurredAt: '2026-11-16T00:00:00Z' }), { companyId: 'c1', kind: 'issue', entityId: 'i1', occurredAt: '2026-11-16T00:00:00.000Z' });
  assert.equal(eventRow({ eventType: 'approval.decided', companyId: 'c1', entityId: 'a1' }).kind, 'approval');
  assert.equal(eventRow({ eventType: 'agent.run.failed', companyId: 'c1', entityId: 'r1' }), null);
  assert.equal(eventRow({ eventType: 'issue.created', entityId: 'i1' }), null);
});

test('取り込み: 題・本文・人の comment・文書・答えた判断を入れ、AI の comment・添え書き・答えていない判断は入れない。消えた comment の行は消える', async () => {
  const f = fakeDeps({
    issues: [issue('i1', { description: 'Make a flyer for the autumn sale' })],
    comments: { i1: [{ id: 'h', body: 'Please use the blue logo for the flyer.', authorAgentId: null }, { id: 'ai', body: 'I will make the flyer with the blue logo now.', authorAgentId: 'a1' }, { id: 'b', body: `${BRIEF_MARK}\nold brief text that is long` }] },
    documents: { i1: [{ key: 'plan', title: 'Plan', body: 'Print 500 flyers' }, { key: 'library-brief', body: 'echo' }] },
    interactions: { i1: [{ id: 'x1', status: 'answered', title: 'Which color?', result: { answers: ['blue'] } }, { id: 'x2', status: 'pending', title: 'Size?' }] },
  });
  await ingestIssue(f.deps, 'c1', 'i1');
  const srcs = [...new Set([...f.store.chunks.values()].map(r => r.srcId))].sort();
  assert.deepEqual(srcs, ['comment:h', 'decision:x1', 'document:i1:plan', 'issue:i1']);
  f.deps.issues.listComments = async () => [];
  await ingestIssue(f.deps, 'c1', 'i1');
  assert.ok(![...f.store.chunks.values()].some(r => r.srcId === 'comment:h'));
});

test('探す口: その会社の行だけ・秘密の形は出ない・2 社目の言葉で 1 社目を引いても 0 件', async () => {
  const f = fakeDeps({ issues: [issue('i1', { description: 'flyer key pcp_board_abcdefghijklmnop0123' }), issue('i2', { companyId: 'c2', title: 'Secret merger plan', description: 'merger' })] });
  await ingestIssue(f.deps, 'c1', 'i1'); await ingestIssue(f.deps, 'c2', 'i2');
  const r = await handleRoute(f.deps, { routeKey: 'search', companyId: 'c1', query: { q: 'flyer' } });
  assert.equal(r.body.results.length, 1);
  assert.ok(!JSON.stringify(r.body).includes('pcp_board_abcdef'));
  assert.equal((await handleRoute(f.deps, { routeKey: 'search', companyId: 'c1', query: { q: 'merger' } })).body.results.length, 0);
});

test('置く口: JSON だけ（415）・決まりに合わない物は 400・道は捨てる・秘密は伏せて保存・検索に当たる・消せる', async () => {
  const f = fakeDeps();
  assert.equal((await handleRoute(f.deps, { routeKey: 'put', companyId: 'c1', headers: {}, body: { name: 'a.md', text: 'x' } })).status, 415);
  assert.equal((await handleRoute(f.deps, { routeKey: 'put', companyId: 'c1', headers: { 'content-type': 'text/plain' }, body: { name: 'a.md', text: 'x' } })).status, 415);
  assert.equal((await handleRoute(f.deps, { routeKey: 'put', companyId: 'c1', headers: JSONH, body: { name: 'a.pdf', text: 'x' } })).status, 400);
  const ok = await handleRoute(f.deps, { routeKey: 'put', companyId: 'c1', headers: JSONH, body: { name: '../guide.md', text: 'Brand colors are navy.\n\nAPI_KEY=abcdef123456' } });
  assert.deepEqual(ok.body, { v: 1, name: 'guide.md' });
  const saved = [...f.store.docs.values()][0];
  assert.ok(!saved.text.includes('abcdef123456'), saved.text);
  const r = await handleRoute(f.deps, { routeKey: 'search', companyId: 'c1', query: { q: 'brand navy' } });
  assert.equal(r.body.results[0].srcId, 'doc:guide.md');
  // 同じ名前で置き換え（数に入れ直さない）
  assert.equal((await handleRoute(f.deps, { routeKey: 'put', companyId: 'c1', headers: JSONH, body: { name: 'guide.md', text: 'Brand colors are green.' } })).status, 200);
  assert.equal((await handleRoute(f.deps, { routeKey: 'documents', companyId: 'c1' })).body.documents.length, 1);
  await handleRoute(f.deps, { routeKey: 'remove', companyId: 'c1', headers: JSONH, body: { name: 'guide.md' } });
  assert.equal((await handleRoute(f.deps, { routeKey: 'search', companyId: 'c1', query: { q: 'brand green' } })).body.results.length, 0);
});

test('見回り: AI の担当の新しい課題に添え書きがちょうど 1 つ付き（英日）、二度流しても増えない・自分の課題は添えない', async () => {
  const agents = [{ id: 'ai', adapterType: 'claude_local', status: 'idle' }];
  const old = issue('i1', { title: 'Autumn sale flyer', description: 'Made a flyer with the blue logo for the autumn sale' });
  const fresh = issue('i9', { title: 'Winter sale flyer', description: 'Make a flyer for the winter sale with the logo', status: 'todo', assigneeAgentId: 'ai', createdAt: new Date(NOW - 3600e3).toISOString() });
  const f = fakeDeps({ issues: [old, fresh], agents });
  await ingestIssue(f.deps, 'c1', 'i1');
  const r1 = await handleTick(f.deps, 'c1', { lang: 'ja' });
  assert.equal(r1.body.briefs, 1);
  assert.equal(f.created.length, 1);
  assert.ok(f.created[0].body.startsWith(BRIEF_MARK));
  assert.match(f.created[0].body, /図書室から/);
  assert.match(f.created[0].body, /Autumn sale flyer/);
  assert.ok(!f.created[0].body.includes('Winter sale flyer'), '自分の課題は添えない');
  await handleTick(f.deps, 'c1', { lang: 'ja' });
  assert.equal(f.created.length, 1, '二度目は足さない');
  // 添え書きの comment は所蔵に入らない（こだま）
  await ingestIssue(f.deps, 'c1', 'i9');
  assert.ok(![...f.store.chunks.values()].some(r => r.text.includes('図書室から')));
});

test('見回り: 毎日の照合は枠を超えたら続きの id を残し、次の回で最後まで読み、消えた課題の行を消す', async () => {
  const issues = Array.from({ length: 30 }, (_, i) => issue(`i${String(i).padStart(2, '0')}`, { description: `topic ${i}` }));
  const f = fakeDeps({ issues });
  let t = NOW; f.deps.now = () => (t += 700); // 時計の読みごとに 0.7 秒
  const r1 = await handleTick(f.deps, 'c1', {});
  assert.equal(r1.body.partial, true); assert.equal(r1.body.scanDone, false);
  const half = new Set([...f.store.chunks.values()].map(r => r.issueId)).size;
  assert.ok(half > 0 && half < 30, `${half}`);
  f.deps.now = () => NOW;
  issues.splice(0, 1); // 1 つ消える
  const r2 = await handleTick(f.deps, 'c1', {});
  assert.equal(r2.body.scanDone, true);
  const ids = new Set([...f.store.chunks.values()].map(r => r.issueId));
  assert.equal(ids.size, 29); assert.ok(!ids.has('i00'));
  // 同じ日はもう読まない
  assert.equal((await handleTick(f.deps, 'c1', {})).body.scanDone, undefined);
});

test('見回り: event の課題だけ読み直し、処理した event だけ済みにする・動いている間は 409', async () => {
  const f = fakeDeps({ issues: [issue('i1', { description: 'alpha' })] });
  await handleTick(f.deps, 'c1', {}); // 今日の照合を済ませる
  f.deps.issues.list = async () => []; // 添え書き・照合は読まない
  const i1 = await f.deps.issues.get('i1', 'c1'); i1.description = 'beta gamma';
  await f.store.addEvent({ companyId: 'c1', kind: 'issue', entityId: 'i1', occurredAt: '' });
  await f.store.addEvent({ companyId: 'c1', kind: 'issue', entityId: 'i1', occurredAt: '' });
  const r = await handleTick(f.deps, 'c1', {});
  assert.ok(r.body.ingested >= 1);
  assert.equal(f.store.events.filter(e => !e.done).length, 0);
  assert.equal((await handleRoute(f.deps, { routeKey: 'search', companyId: 'c1', query: { q: 'gamma' } })).body.results.length, 1);
  let release; f.deps.agents.list = () => new Promise(res => { release = () => res([]); });
  const p = handleTick(f.deps, 'c1', {});
  assert.equal((await handleTick(f.deps, 'c1', {})).status, 409);
  while (!release) await new Promise(r => setImmediate(r)); // tick の初めの秘書の id の読み書きの後で担当の一覧に届く
  release(); await p;
});

test('状態の口: 所蔵の数・置いた文書の数・添えた回数・最後に取り込んだ時刻', async () => {
  const f = fakeDeps({ issues: [issue('i1', { description: 'alpha' })] });
  await handleTick(f.deps, 'c1', {});
  const s = (await handleRoute(f.deps, { routeKey: 'status', companyId: 'c1' })).body;
  assert.equal(s.chunks, 1); assert.equal(s.docs, 0); assert.equal(s.briefs, 0); assert.equal(s.lastIngestAt, new Date(NOW).toISOString());
});

// ---- 独立レビュー（PR #29）の直し ----
test('照合: 一覧が本文を頭 1200 字で切って返しても、切れた物は読み直して後ろの語が当たり続ける（P2-1）', async () => {
  const long = `${'Opening notes about the shop. '.repeat(60)}\n\nThe secret ingredient is cardamom.`;
  const full = issue('i1', { title: 'Recipe notes', description: long });
  const f = fakeDeps({ issues: [full] });
  // 本体の一覧と同じく、頭 1200 字にして descriptionTruncated を付けて返す
  f.deps.issues.list = async ({ companyId }) => [full].filter(i => i.companyId === companyId).map(i => ({ ...i, description: i.description.slice(0, 1200), descriptionTruncated: true }));
  await ingestIssue(f.deps, 'c1', 'i1');
  const hit = async () => (await handleRoute(f.deps, { routeKey: 'search', method: 'GET', companyId: 'c1', query: { q: 'cardamom' }, headers: {} })).body.results.length;
  assert.ok(await hit() >= 1, 'event の道で全文が入る');
  await handleTick(f.deps, 'c1', { lang: 'en' });
  assert.ok(await hit() >= 1, '照合の後も 1200 字より後ろの語が当たる');
});

test('添え書き: 書けたのに誤りで返っても、次の回は comment の印を見て二度書かない（P2-2）', async () => {
  const agents = [{ id: 'ai', adapterType: 'claude_local', status: 'idle' }];
  const fresh = issue('i9', { title: 'Winter flyer', description: 'Make a flyer', status: 'todo', assigneeAgentId: 'ai', createdAt: new Date(NOW - 3600e3).toISOString() });
  const f = fakeDeps({ issues: [fresh], agents });
  const write = f.deps.issues.createComment;
  f.deps.issues.createComment = async (...a) => { await write(...a); throw new Error('socket hang up'); };
  await handleTick(f.deps, 'c1', { lang: 'en' });
  await handleTick(f.deps, 'c1', { lang: 'en' });
  await handleTick(f.deps, 'c1', { lang: 'en' });
  assert.equal(f.created.length, 1, 'comment は 1 つのまま');
});

test('添え書き: 終わった課題が 500 件を超えても、開いた課題を状態ごとに取って添える（pre-codex レビュー P3）', async () => {
  const agents = [{ id: 'ai', adapterType: 'claude_local', status: 'idle' }];
  const old = Array.from({ length: 600 }, (_, i) => issue(`d${i}`, { title: `Closed ${i}` }));
  const fresh = issue('i9', { title: 'Winter flyer', description: 'Make a flyer', status: 'todo', assigneeAgentId: 'ai', createdAt: new Date(NOW - 3600e3).toISOString() });
  const f = fakeDeps({ issues: [...old, fresh], agents });
  await handleTick(f.deps, 'c1', { lang: 'en' });
  assert.deepEqual(f.created.map(c => c.id), ['i9']);
});

test('見回り: 照合の一覧が上限で切れた時は、載らなかった課題の行を消さない（pre-codex レビュー P3）', async () => {
  const issues = [issue('i1', { description: 'alpha' }), issue('i2', { description: 'beta' }), issue('i3', { description: 'gamma' })];
  const f = fakeDeps({ issues });
  await handleTick(f.deps, 'c1', {});
  assert.equal(new Set([...f.store.chunks.values()].map(r => r.issueId)).size, 3);
  f.deps.scanLimit = 2; f.setNow(NOW + 864e5); // 次の日・一覧は 2 件で切れる
  const r = await handleTick(f.deps, 'c1', {});
  assert.equal(r.body.scanDone, true); assert.equal(r.body.scanCapped, true);
  assert.equal(new Set([...f.store.chunks.values()].map(r => r.issueId)).size, 3, 'i3 の行は残る');
});

test('見回り: 本体が既定の 500 件で一覧を切る版でも、載らなかった課題の行を消さない（独立レビュー 6 回目 P2-2）', async () => {
  const issues = Array.from({ length: 501 }, (_, i) => issue(`i${String(i).padStart(3, '0')}`, { description: `topic ${i}` }));
  const f = fakeDeps({ issues });
  await handleTick(f.deps, 'c1', {});
  const list = f.deps.issues.list;
  f.deps.issues.list = async a => (await list(a)).slice(0, 500); // limit を無視して 500 件で切る本体
  f.setNow(NOW + 864e5);
  const r = await handleTick(f.deps, 'c1', {});
  assert.equal(r.body.scanCapped, true);
  assert.ok([...f.store.chunks.values()].some(x => x.issueId === 'i500'), '501 件目の行は残る');
});

test('見回り: 形の合わない event を捨てた数を返事の dropped に出す（保証 8・独立レビュー 6 回目 P2-1）', async () => {
  const f = fakeDeps({ issues: [] });
  f.deps.dropped = 3;
  assert.equal((await handleTick(f.deps, 'c1', {})).body.dropped, 3);
});

test('見回り: 承認の照合も枠で切れた次の回は続きから読み、後半を落とさない（codex 1 回目 P2-1）', async () => {
  const approvals = Array.from({ length: 30 }, (_, i) => ({ id: `a${String(i).padStart(2, '0')}`, companyId: 'c1', type: 'hire_agent', status: 'approved', decidedAt: new Date(NOW - 3600e3).toISOString(), decisionNote: `note ${i}`, payload: { name: `Agent ${i}` } }));
  const f = fakeDeps({ approvals });
  let t = NOW; f.deps.now = () => (t += 700);
  for (let n = 0; n < 6; n++) await handleTick(f.deps, 'c1', {});
  const got = new Set([...f.store.chunks.values()].filter(r => String(r.srcId).startsWith('approval:')).map(r => r.srcId));
  assert.equal(got.size, 30, `${got.size}`);
});

test('置く口: 同じ会社に同時に置いても、文書の数の上限を超えない（codex 1 回目 P2-2）', async () => {
  const f = fakeDeps();
  for (let i = 0; i < LIMITS.docsPerCompany - 1; i++) await f.store.putDoc('c1', `d${i}.md`, 'x', 1);
  const put = name => handleRoute(f.deps, { routeKey: 'put', method: 'POST', companyId: 'c1', query: {}, headers: JSONH, body: { name, text: 'hello' } });
  const rs = await Promise.all([put('a.md'), put('b.md')]);
  assert.deepEqual(rs.map(r => r.status).sort(), [200, 400]);
  assert.equal((await f.store.counts('c1')).docs, LIMITS.docsPerCompany);
});

test('探す: 課題の番号がちょうど一致した物は、新しい行が候補の上限を埋めても結果に出る（保証 13・codex 1 回目 P2-3）', async () => {
  const f = fakeDeps();
  await f.store.putSource('c1', 'issue:old', [{ id: 'old#0', srcId: 'issue:old', issueId: 'old', kind: 'issue', title: 'CMP-7 Old flyer plan', date: '2025-01-01', text: 'flyer', hash: 'h' }]);
  for (let i = 0; i < 10; i++) await f.store.putSource('c1', `issue:s${i}`, [{ id: `s${i}#0`, srcId: `issue:s${i}`, issueId: `s${i}`, kind: 'issue', title: `CMP-${70 + i} Similar number ${i}`, date: '2026-10-01', text: 'other', hash: 'h' }]); // 前の数字が同じ番号（独立レビュー 7 回目 P2）
  for (let i = 0; i < LIMITS.candidates + 20; i++) await f.store.putSource('c1', `issue:n${i}`, [{ id: `n${i}#0`, srcId: `issue:n${i}`, issueId: `n${i}`, kind: 'issue', title: `CMP-${1000 + i} New flyer ${i}`, date: '2026-11-01', text: 'flyer', hash: 'h' }]);
  const r = await handleRoute(f.deps, { routeKey: 'search', method: 'GET', companyId: 'c1', query: { q: 'CMP-7 flyer' }, headers: {} });
  assert.ok(r.body.results.some(x => x.srcId === 'issue:old' || x.issueId === 'old'), JSON.stringify(r.body.results.slice(0, 3)));
});

test('見回り: 1 件の課題が読めなくても止まらず、他の課題を取り込み、読めなかった数を状態に出す（P3-1）', async () => {
  const f = fakeDeps({ issues: [issue('i1', { title: 'Broken one' }), issue('i2', { title: 'Healthy bakery note' })] });
  const lc = f.deps.issues.listComments;
  f.deps.issues.listComments = async (id, c) => { if (id === 'i1') throw new Error('boom'); return lc(id, c); };
  const r = await handleTick(f.deps, 'c1', { lang: 'en' });
  assert.equal(r.status, 200);
  assert.equal(r.body.failed, 1);
  assert.ok([...f.store.chunks.values()].some(x => x.title.includes('Healthy bakery note')));
  const st = await handleRoute(f.deps, { routeKey: 'status', method: 'GET', companyId: 'c1', query: {}, headers: {} });
  assert.equal(st.body.lastFailed, 1);
});

test('取り込み: 会話の課題（conversationAgentId 付き）は入れず、前に入った行も消す（P3-3）', async () => {
  const conv = issue('i5', { title: 'Chat with secretary', description: 'hello there friend', conversationAgentId: 'ai' });
  const f = fakeDeps({ issues: [conv] });
  await f.store.putSource('c1', 'issue:i5', [{ id: 'issue:i5#0', srcId: 'issue:i5', issueId: 'i5', kind: 'issue', title: 'old', text: 'old', hash: 'x' }]);
  assert.equal(await ingestIssue(f.deps, 'c1', 'i5'), 0);
  assert.ok(![...f.store.chunks.values()].some(x => x.issueId === 'i5'));
});

// ---- 2 回目の独立レビュー（PR #29）の直し ----
test('見回り: 全部読めない時は最後に読んだ時刻を進めず、失敗の数は次の見回りでも見え、3 回で諦めた数に移る（2 回目 P2-A）', async () => {
  const f = fakeDeps({ issues: [issue('i1'), issue('i2')] });
  f.deps.issues.listComments = async () => { throw new Error('forbidden'); };
  const st = async () => (await handleRoute(f.deps, { routeKey: 'status', method: 'GET', companyId: 'c1', query: {}, headers: {} })).body;
  await handleTick(f.deps, 'c1', { lang: 'en' });
  let s = await st();
  assert.equal(s.lastIngestAt, null, '1 件も読めない照合では進めない');
  assert.equal(s.lastFailed, 2);
  f.setNow(NOW + 5 * 60e3); await handleTick(f.deps, 'c1', { lang: 'en' });
  s = await st();
  assert.equal(s.lastFailed, 2, '次の見回りでも見えている');
  f.setNow(NOW + 10 * 60e3); await handleTick(f.deps, 'c1', { lang: 'en' });
  s = await st();
  assert.equal(s.retrying, 0); assert.equal(s.gaveUp, 2); assert.equal(s.lastFailed, 2, '諦めた数としてその日は残る');
  assert.equal(s.lastIngestAt, null);
});

test('見回り: 読めなかった課題は次の見回りで読み直し、読めたら一覧から消える（2 回目 P2-A）', async () => {
  const f = fakeDeps({ issues: [issue('i1', { title: 'Flaky bakery record' })] });
  const lc = f.deps.issues.listComments; let broken = true;
  f.deps.issues.listComments = async (id, c) => { if (broken) throw new Error('timeout'); return lc(id, c); };
  await handleTick(f.deps, 'c1', { lang: 'en' });
  assert.ok(![...f.store.chunks.values()].some(x => x.issueId === 'i1'));
  broken = false; f.setNow(NOW + 5 * 60e3);
  await handleTick(f.deps, 'c1', { lang: 'en' });
  assert.ok([...f.store.chunks.values()].some(x => x.title.includes('Flaky bakery record')), '読み直して入った');
  const s = (await handleRoute(f.deps, { routeKey: 'status', method: 'GET', companyId: 'c1', query: {}, headers: {} })).body;
  assert.equal(s.retrying, 0); assert.equal(s.lastFailed, 0);
});

test('取り込み: 隠した課題と harness の課題も入れない（本体の一覧に出ない物・2 回目 P3-a）', async () => {
  const f = fakeDeps({ issues: [issue('i6', { title: 'Hidden plan', hiddenAt: new Date(NOW).toISOString() }), issue('i7', { title: 'Harness run', harnessKind: 'eval' })] });
  assert.equal(await ingestIssue(f.deps, 'c1', 'i6'), 0);
  assert.equal(await ingestIssue(f.deps, 'c1', 'i7'), 0);
  assert.equal(f.store.chunks.size, 0);
});

test('置く口: 使えない名前は library_doc_name で断る（2 回目 P3-b）', async () => {
  const f = fakeDeps();
  const r = await handleRoute(f.deps, { routeKey: 'put', method: 'POST', companyId: 'c1', query: {}, headers: JSONH, body: { name: `${'a'.repeat(201)}.md`, text: 'x' } });
  assert.equal(r.status, 400); assert.equal(r.body.error, 'library_doc_name');
});

// ---- 3 回目の独立レビュー（PR #29）の P3 ----
test('見回り: 1 回の見回りで同じ物を二度読まない・読み直しで全部直れば時刻が進む・諦めた数は日が替わると 0（3 回目 P3-1・2・4）', async () => {
  const f = fakeDeps({ issues: [issue('i1', { title: 'Wobbly record' })] });
  const lc = f.deps.issues.listComments; let broken = true, calls = 0;
  f.deps.issues.listComments = async (id, c) => { calls++; if (broken) throw new Error('timeout'); return lc(id, c); };
  const st = async () => (await handleRoute(f.deps, { routeKey: 'status', method: 'GET', companyId: 'c1', query: {}, headers: {} })).body;
  await handleTick(f.deps, 'c1', { lang: 'en' });
  // 翌日: 読み直しの一覧の物は、読み直し・event・照合で 1 回だけ試す
  f.setNow(NOW + 864e5); await f.store.addEvent({ companyId: 'c1', kind: 'issue', entityId: 'i1' }); calls = 0;
  await handleTick(f.deps, 'c1', { lang: 'en' });
  assert.equal(calls, 1, '1 回の見回りで 1 回だけ試す');
  assert.equal((await st()).retrying, 1, 'まだ諦めていない');
  // 読み直しで直れば、その日の照合が済んでいるので時刻が進む
  broken = false; f.setNow(NOW + 864e5 + 5 * 60e3);
  await handleTick(f.deps, 'c1', { lang: 'en' });
  const s = await st();
  assert.equal(s.retrying, 0); assert.equal(s.lastIngestAt, new Date(NOW + 864e5 + 5 * 60e3).toISOString());
  assert.equal(s.gaveUp, 0);
});

// ---- 4 回目の独立レビュー（PR #29）の P2・P3 ----
const stOf = async f => (await handleRoute(f.deps, { routeKey: 'status', method: 'GET', companyId: 'c1', query: {}, headers: {} })).body;
test('見回り: 照合と同じ回に諦めた物は読めた数に入れず、時刻を進めない・諦めた次の日は諦めた数が 0（4 回目 P2・P3）', async () => {
  const f = fakeDeps({ issues: [issue('i1')] });
  f.deps.issues.listComments = async () => { throw new Error('down'); };
  await handleTick(f.deps, 'c1', { lang: 'en' });                                   // 1 日目: 照合で失敗 n=1
  f.setNow(NOW + 5 * 60e3); await handleTick(f.deps, 'c1', { lang: 'en' });        // 1 日目: 読み直しで失敗 n=2
  f.setNow(NOW + 864e5); await handleTick(f.deps, 'c1', { lang: 'en' });           // 2 日目: 読み直しで n=3 で諦め・同じ回の照合
  let s = await stOf(f);
  assert.equal(s.gaveUp, 1); assert.equal(s.lastIngestAt, null, '一度も読めていないので進めない');
  f.setNow(NOW + 2 * 864e5);
  s = await stOf(f);
  assert.equal(s.gaveUp, 0, '日が替われば 0');
});

test('見回り: 前の日に時刻が入っていても、読み直しで全部直れば時刻が進む（4 回目 P3・3 回目 P3-2）', async () => {
  const f = fakeDeps({ issues: [issue('i1', { title: 'Steady record' })] });
  const lc = f.deps.issues.listComments; let broken = false;
  f.deps.issues.listComments = async (id, c) => { if (broken) throw new Error('down'); return lc(id, c); };
  await handleTick(f.deps, 'c1', { lang: 'en' });
  assert.equal((await stOf(f)).lastIngestAt, new Date(NOW).toISOString());
  broken = true; f.setNow(NOW + 864e5); await handleTick(f.deps, 'c1', { lang: 'en' });
  assert.equal((await stOf(f)).lastIngestAt, new Date(NOW).toISOString(), '1 件も読めない照合では進めない');
  broken = false; f.setNow(NOW + 864e5 + 5 * 60e3); await handleTick(f.deps, 'c1', { lang: 'en' });
  assert.equal((await stOf(f)).lastIngestAt, new Date(NOW + 864e5 + 5 * 60e3).toISOString(), '読み直しで直れば進む');
});

test('見回り: 読み直しは 1 回の見回りで 50 件まで（4 回目 P3・3 回目 P3-3）', async () => {
  const many = Array.from({ length: 51 }, (_, k) => issue(`i${String(k).padStart(3, '0')}`));
  const f = fakeDeps({ issues: many });
  let calls = 0;
  f.deps.issues.listComments = async () => { calls++; throw new Error('down'); };
  await handleTick(f.deps, 'c1', { lang: 'en' });
  assert.equal((await stOf(f)).retrying, 51);
  calls = 0; f.setNow(NOW + 5 * 60e3); await handleTick(f.deps, 'c1', { lang: 'en' });
  assert.equal(calls, 50, '1 回に 50 件だけ読み直す');
});

test('見回り: event で読めなかった承認は、同じ回の照合で二度読まず、読めない数に 1 回だけ入る（5 回目 P3-1）', async () => {
  const f = fakeDeps({ approvals: [{ id: 'a1', companyId: 'c1', status: 'approved', type: 'request_board_approval', payload: { title: 'Logo budget' } }] });
  let gets = 0;
  f.deps.approvals.get = async () => { gets++; throw new Error('down'); };
  await f.store.addEvent({ companyId: 'c1', kind: 'approval', entityId: 'a1' });
  const r = await handleTick(f.deps, 'c1', { lang: 'en' });
  assert.equal(gets, 1, '1 回の見回りで 1 回だけ読む');
  assert.equal(r.body.failed, 1);
  assert.equal((await stOf(f)).retrying, 1);
});

test('図書室への問いの課題は取り込まない（資料の写しを記録にしない・聞くの保証 8）', async () => {
  const f = fakeDeps({ issues: [issue('i7', { description: 'zebra crossing notes', originKind: 'plugin:aioffice.library:ask', originId: 'ask:x' }), issue('i8', { description: 'zebra stripes' })] });
  assert.equal(await ingestIssue(f.deps, 'c1', 'i7'), 0);
  await ingestIssue(f.deps, 'c1', 'i8');
  const r = await handleRoute(f.deps, { routeKey: 'search', companyId: 'c1', query: { q: 'zebra' } });
  assert.deepEqual(r.body.results.map(x => String(x.id).split('#')[0]), ['issue:i8']);
});

// manifest の口の key は全部 worker が振り分ける（manifest だけ直して worker を直し忘れると 404 で黙って止まる・独立レビュー P3-1）
test('manifest の口の key は全部 worker の handleRoute が受ける（unknown route にならない）', async () => {
  const { default: manifest } = await import('../plugins/library/src/manifest.mjs');
  for (const r of manifest.apiRoutes) {
    const f = fakeDeps();
    let out = null;
    try { out = await handleRoute(f.deps, { routeKey: r.routeKey, companyId: 'c1', headers: JSONH, query: {}, body: {} }); } catch { out = null; } // 振り分けた先で偽の deps が足りずに投げても、振り分けはできている
    assert.notEqual(out?.body?.error, 'unknown route', r.routeKey);
  }
});
