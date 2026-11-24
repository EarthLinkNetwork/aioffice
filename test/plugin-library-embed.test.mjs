import test from 'node:test';
import assert from 'node:assert/strict';
import { EMBED, numThreadFrom, cpusetCount, f32ToB64, b64ToF32, normalize, VectorStore, semanticPoints } from '../plugins/library/src/embed.mjs';
import { rank, pickHits, strongEnough } from '../plugins/library/src/lib.mjs';

test('thread の数: cgroup v2 の quota・v1 の quota・cpuset・制限なしの順に、切り捨てで最小 1', () => {
  assert.equal(numThreadFrom({ cpuMax: 'max 100000', avail: 16 }), 16);
  assert.equal(numThreadFrom({ cpuMax: '200000 100000', avail: 16 }), 2);
  assert.equal(numThreadFrom({ cpuMax: '150000 100000', avail: 16 }), 1);
  assert.equal(numThreadFrom({ cpuMax: '50000 100000', avail: 16 }), 1);
  assert.equal(numThreadFrom({ cfsQuota: 400000, cfsPeriod: 100000, avail: 16 }), 4);
  assert.equal(numThreadFrom({ cfsQuota: -1, cfsPeriod: 100000, avail: 8 }), 8);
  assert.equal(numThreadFrom({ cpuset: cpusetCount('0-3'), avail: 20 }), 4, 'CPU を固定した container（機械全体のコアの数で起こすと 100 倍遅くなった実測）');
  assert.equal(numThreadFrom({ cpuset: cpusetCount('0-3'), cpuMax: '200000 100000', avail: 20 }), 2);
  assert.equal(numThreadFrom({}), 1);
  assert.equal(cpusetCount('0-3,6,8-9'), 7);
  assert.equal(cpusetCount(''), null);
});

test('ベクトルの base64 の往復: NaN・−0 を含め同じ値に戻り、PostgreSQL の改行を飛ばす', () => {
  const v = Float32Array.from({ length: 1024 }, (_, i) => Math.sin(i) * (i % 7 ? 1 : -3.4e-5)); v[3] = NaN; v[4] = -0;
  const b = f32ToB64(v);
  const withNl = b.replace(/(.{76})/g, '$1\n'); // PostgreSQL の encode(…,'base64') の形
  const back = b64ToF32(withNl);
  assert.equal(back.length, 1024);
  assert.ok(Number.isNaN(back[3]));
  assert.ok(Object.is(back[4], -0));
  assert.equal(Buffer.from(back.buffer).equals(Buffer.from(v.buffer)), true);
  assert.throws(() => b64ToF32(Buffer.from([1, 2, 3]).toString('base64')));
});

test('normalize: 長さ 0・NaN は null、ほかは長さ 1', () => {
  assert.equal(normalize(new Float32Array(4)), null);
  assert.equal(normalize(Float32Array.from([1, NaN])), null);
  const n = normalize(Float32Array.from([3, 4]));
  assert.ok(Math.abs(n[0] - 0.6) < 1e-6 && Math.abs(n[1] - 0.8) < 1e-6);
});

const unit = (...xs) => normalize(Float32Array.from(xs));

test('記憶: 下限以上の上位だけを返し、会社ごとに分ける（保証 4）', () => {
  const s = new VectorStore({ dims: 2 });
  s.set('c1', [{ id: 'a', vec: unit(1, 0) }, { id: 'b', vec: unit(1, 1) }, { id: 'c', vec: unit(0, 1) }]);
  s.set('c2', [{ id: 'x', vec: unit(1, 0) }]);
  const top = s.top('c1', unit(1, 0), { floor: 0.5 });
  assert.deepEqual(top.map(t => t.id), ['a', 'b'], '0 度と 45 度は下限 0.5 以上・90 度は外れる');
  assert.ok(!top.some(t => t.id === 'x'), '他の会社のベクトルは候補に入らない');
  assert.deepEqual(s.top('c3', unit(1, 0)), [], '読み込んでいない会社は空');
  assert.deepEqual(s.top('c1', null), []);
});

test('記憶の上限: 1 社の上限を超える古い行は載せず、全体を超える時は最近使っていない会社から降ろす（作り方 14）', () => {
  const s = new VectorStore({ dims: 2, maxBytes: 2 * 4 * 3 }); // 3 行ぶん
  s.set('c1', [1, 2, 3, 4].map(i => ({ id: `n${i}`, vec: unit(1, i) })));
  assert.deepEqual(s.get('c1').ids, ['n3', 'n2', 'n1'], '新しい順に渡した先頭（新しい行）を残し、中では古い順に持つ');
  s.top('c1', unit(1, 0), { now: 5 });
  s.set('c2', [{ id: 'y', vec: unit(1, 0) }]);
  assert.equal(s.has('c1'), false, '全体の上限を超えたので、使った時が古い c1 を降ろす');
  assert.equal(s.has('c2'), true, '今入れた会社は降ろさない');
});

test('意味の点と rank: 語が 1 つも当たらない言い換えでも下限以上なら当たり、下限より下は捨てる（作り方 14a・2 回目の B-1）', () => {
  assert.equal(semanticPoints(0.44), 0);
  assert.equal(semanticPoints(NaN), 0);
  assert.ok(Math.abs(semanticPoints(1) - EMBED.weight) < 1e-9);
  const rows = [
    { id: '1', srcId: 'doc:pay.md', kind: 'doc', title: '支払いの決まり', text: '請求書の締めは月末', date: '2026-11-01' },
    { id: '2', srcId: 'doc:trip.md', kind: 'doc', title: '社員旅行', text: '行き先は海', date: '2026-11-02' },
  ];
  const cos = new Map([['1', 0.641], ['2', 0.342]]);
  const hits = rank(rows, 'when do we pay vendors', { cos, now: Date.parse('2026-11-17') });
  assert.deepEqual(hits.map(h => h.srcId), ['doc:pay.md'], '言い換え（0.641）は当たり、関係ない（0.342）は捨てる');
  assert.equal(hits[0].semanticOnly, true);
  assert.equal(hits[0].cos, 0.641);
  assert.deepEqual(rank(rows, 'when do we pay vendors', { now: Date.parse('2026-11-17') }), [], '意味の検索が使えない時は今までどおり語の当たりだけ');
});

test('添え書きは意味だけの当たりを入れない（作り方 14a・3 回目の P3）', () => {
  const rows = [{ id: '1', srcId: 'doc:pay.md', kind: 'doc', title: '支払いの決まり', text: '請求書の締めは月末', date: '2026-11-16' }];
  const hits = rank(rows, 'when do we pay vendors', { cos: new Map([['1', 0.9]]), now: Date.parse('2026-11-17') });
  assert.equal(hits.length, 1);
  assert.equal(strongEnough(hits[0]), false);
  assert.deepEqual(pickHits(hits), []);
});

// ---- 裏の列・問い・世代（embedder.mjs と worker の dbStore） ----
import { readFileSync } from 'node:fs';
import { semanticEngine, EmbedError, ollamaClient } from '../plugins/library/src/embedder.mjs';
import { dbStore, searchCompany } from '../plugins/library/src/worker.mjs';

// 埋め込みの表の偽物（本物の SQL の意味を写す: seq は「会社の最大 + 1」と時刻の大きい方・新しさは hash の一致・CASCADE）
function embStore(chunks, { clock = { t: 1000 } } = {}) {
  const emb = new Map(), fail = new Map(); let gen = 0;
  const live = id => chunks.find(c => c.id === id);
  const st = {
    emb, fail, clock, bump: () => { gen++; },
    // 行を消す（CASCADE で埋め込みも消える）。bump: 世代を進めるか（2 文目の失敗を写せる）
    del: (id, { bump = true } = {}) => { const i = chunks.findIndex(c => c.id === id); if (i >= 0) chunks.splice(i, 1); emb.delete(id); fail.delete(id); if (bump) gen++; },
    embedCompanies: async () => [...new Set(chunks.map(c => c.c))],
    embedTodo: async (c, digest, limit) => chunks.filter(r => r.c === c).filter(r => { const e = emb.get(r.id), f = fail.get(r.id); return (!e || e.hash !== r.hash || e.digest !== digest) && (!f || f.hash !== r.hash || f.tries < EMBED.maxFailures); }).slice(0, limit),
    putEmbedding: async (c, id, hash, digest, b64) => {
      const max = Math.max(0, ...[...emb.values()].filter(e => e.c === c).map(e => e.seq));
      emb.set(id, { c, hash, digest, b64, seq: Math.max(max + 1, clock.t++) });
    },
    failEmbed: async (c, id, hash) => { const f = fail.get(id); fail.set(id, { hash, tries: f && f.hash === hash ? f.tries + 1 : 1 }); },
    loadEmbeddings: async (c, digest, after, limit) => [...emb.entries()].filter(([, e]) => e.c === c && e.digest === digest && e.seq > after).sort((a, b) => a[1].seq - b[1].seq).slice(0, limit).map(([id, e]) => ({ id, vec: e.b64, seq: e.seq })),
    freshIds: async (c, ids, digest) => ids.filter(id => { const r = live(id), e = emb.get(id); return r && r.c === c && e && e.hash === r.hash && e.digest === digest; }).map(id => ({ id, seq: emb.get(id).seq })),
    generation: async () => gen,
  };
  return st;
}
const vecOf = text => { const v = new Float32Array(EMBED.dims); v[/支払|pay/.test(text) ? 0 : 1] = 1; v[2] = 0.1; return v; };
function fakeClient({ down = false, timeout = () => false, reject = () => false } = {}) {
  const calls = [];
  return { calls, numThread: 4, alive: async () => !down,
    embed: async (input, ms) => { calls.push({ input, ms }); if (down) throw new EmbedError('x', { down: true }); if (timeout(input)) throw new EmbedError('t', { timeout: true }); if (reject(input)) throw new EmbedError('ollama 400', { status: 400 }); return vecOf(input); } };
}
const noSleep = async () => {};
// 記憶に読み込んでから問う（最初の問いは warming を返し、裏で読む）
async function warm(eng, c) { const r = await eng.search(c, 'x'); if (r.reason === 'warming') await eng.load(c, true); }
const ids = r => (r.hits || []).map(x => x.id).sort();

test('列: 会社ごとに 1 行ずつ埋め込み、断られた行は 3 回で諦め、落ちている時と時間切れは数えない（作り方 8）', async () => {
  const chunks = [{ c: 'c1', id: 'a', hash: 'h1', title: '支払い', text: '月末' }, { c: 'c1', id: 'bad', hash: 'h1', title: 'x', text: 'BAD' }, { c: 'c2', id: 'z', hash: 'h1', title: 'trip', text: 'sea' }];
  const store = embStore(chunks);
  const down = semanticEngine({ store, client: fakeClient({ down: true }), sleep: noSleep });
  await down.round();
  assert.equal(store.fail.size, 0, '落ちている間は行の失敗に数えない');
  assert.equal(down.status().ok, false);
  assert.equal(down.status().reason, 'unavailable');
  const slow = semanticEngine({ store, client: fakeClient({ timeout: () => true }), sleep: noSleep });
  await slow.round();
  assert.equal(store.fail.size, 0, '時間切れも行の失敗に数えない');
  const eng = semanticEngine({ store, client: fakeClient({ reject: s => s.includes('BAD') }), sleep: noSleep });
  for (let i = 0; i < 5; i++) await eng.round();
  assert.deepEqual([...store.emb.keys()].sort(), ['a', 'z']);
  assert.equal(store.fail.get('bad').tries, EMBED.maxFailures, '3 回で諦め、それ以上は呼ばない');
  chunks[1].hash = 'h2'; await eng.round();
  assert.equal(store.fail.get('bad').tries, 1, '中身が変わったら数え直す');
  assert.equal(eng.status().ok, true);
});

test('問い: 記憶に無い会社は warming で返して裏で読み、会社の記憶だけから下限以上を返す（保証 4・作り方 12・13）', async () => {
  const chunks = [{ c: 'c1', id: 'a', hash: 'h', title: '支払い', text: '月末' }, { c: 'c1', id: 'b', hash: 'h', title: '旅行', text: '海' }, { c: 'c2', id: 'z', hash: 'h', title: 'pay', text: 'other company' }];
  const store = embStore(chunks);
  const eng = semanticEngine({ store, client: fakeClient(), sleep: noSleep });
  await eng.round();
  assert.deepEqual(await eng.search('c1', 'pay'), { hits: null, reason: 'warming' }, '問いの中で全部を読まない');
  await eng.load('c1', true);
  assert.deepEqual(ids(await eng.search('c1', 'when do we pay')), ['a'], '他の会社の z は出ない・関係ない b は下限の下');
  chunks.push({ c: 'c1', id: 'a2', hash: 'h', title: '支払い 2', text: '' }); await eng.round();
  assert.deepEqual(ids(await eng.search('c1', 'pay')), ['a', 'a2'], '足した行は seq の続きで入る');
  store.del('a');
  assert.deepEqual(ids(await eng.search('c1', 'pay')), ['a2'], '消した行は、裏の読み直しの前でも引き直しで落ちる');
  await eng.load('c1', true);
  assert.ok(!eng.vectors.get('c1').ids.includes('a'), '世代が進んだので記憶からも消える');
  const dead = semanticEngine({ store, client: fakeClient({ down: true }), sleep: noSleep });
  await dead.round();
  assert.deepEqual(await dead.search('c1', 'pay'), { hits: null, reason: 'unavailable' });
});

test('問い: 書き直した行は、列が埋め直すまで古い意味で当たらない（保証 5・独立レビュー B-1）', async () => {
  const chunks = [{ c: 'c1', id: 'doc:a.md#0', hash: 'h1', title: '支払い', text: '月末' }];
  const store = embStore(chunks);
  const eng = semanticEngine({ store, client: fakeClient(), sleep: noSleep });
  await eng.round(); await warm(eng, 'c1');
  assert.deepEqual(ids(await eng.search('c1', 'pay')), ['doc:a.md#0']);
  chunks[0].hash = 'h2'; chunks[0].title = '社員旅行'; chunks[0].text = '海'; // 置き直し（id は同じ・世代は進まない）
  assert.deepEqual(ids(await eng.search('c1', 'pay')), [], '古い意味では当たらない');
  await eng.round();
  assert.deepEqual(ids(await eng.search('c1', 'pay')), [], '埋め直した後は新しい意味（旅行）なので当たらない');
});

test('問い: 最大の seq の行が消えて世代が進まなくても、その後の埋め込みが記憶に入る（独立レビュー P2-1）', async () => {
  const chunks = [{ c: 'c1', id: 'a', hash: 'h', title: 'trip', text: '' }, { c: 'c1', id: 'b', hash: 'h', title: 'sea', text: '' }];
  const store = embStore(chunks, { clock: { t: 1 } });
  const eng = semanticEngine({ store, client: fakeClient(), sleep: noSleep });
  await eng.round(); await warm(eng, 'c1');
  const seqB = store.emb.get('b').seq;
  store.del('b', { bump: false }); // 2 文目（世代を進める）が落ちた
  chunks.push({ c: 'c1', id: 'n', hash: 'h', title: '支払い', text: '' }); await eng.round();
  assert.ok(store.emb.get('n').seq > seqB, 'seq を使い回さない');
  assert.deepEqual(ids(await eng.search('c1', 'pay')), ['n']);
});

test('問い: 時間切れは timeout として返し、全体を使えない扱いにしない。待ちの上限は直近 20 行の最大から（作り方 8a・11）', async () => {
  const chunks = [{ c: 'c1', id: 'a', hash: 'h', title: '支払い', text: '' }];
  const store = embStore(chunks);
  let t = 0; const client = fakeClient({ timeout: s => s === 'slow' });
  const eng = semanticEngine({ store, client, sleep: noSleep, now: () => (t += 100) });
  await eng.round(); await warm(eng, 'c1');
  assert.deepEqual(await eng.search('c1', 'slow'), { hits: null, reason: 'timeout' });
  assert.equal(eng.status().ok, true, '1 回の時間切れで使えない扱いにしない');
  await eng.search('c1', 'pay');
  const ms = client.calls.at(-1).ms;
  assert.equal(ms, Math.ceil(eng.rowMaxMs() * 1.2) + 1000);
  for (let i = 0; i < 25; i++) eng.st.rows.push(i === 0 ? 99_999 : 10), eng.st.rows.length > 20 && eng.st.rows.shift();
  assert.equal(eng.rowMaxMs(), 10, '古い遅い行は 20 行で忘れる');
});

test('時間切れが続けば使えない扱いにして帯につなぎ、問いの待ちは測れていない時も 30 秒にしない（2 回目のレビュー P2-A）', async () => {
  const chunks = [{ c: 'c1', id: 'a', hash: 'h', title: '支払い', text: '' }];
  const store = embStore(chunks);
  let slow = false; const calls = [];
  const client = { numThread: 2, alive: async () => true, embed: async (input, ms) => { calls.push(ms); if (slow) throw new EmbedError('t', { timeout: true }); return vecOf(input); } };
  const eng = semanticEngine({ store, client, sleep: noSleep });
  await eng.round(); await warm(eng, 'c1');
  eng.st.rows.length = 0; // 起こし直した後（まだ測れていない）
  await eng.search('c1', 'pay');
  assert.ok(calls.at(-1) <= EMBED.queryTimeoutMs && EMBED.queryTimeoutMs < 30_000, '測れていない時も問いの待ちは 30 秒にしない');
  slow = true;
  for (let i = 0; i < EMBED.timeoutsToDown - 1; i++) assert.equal((await eng.search('c1', 'pay')).reason, 'timeout');
  assert.equal(eng.status().ok, true, '1〜2 回の時間切れでは使える扱いのまま');
  await eng.search('c1', 'pay');
  assert.equal(eng.status().ok, false);
  assert.equal(eng.status().reason, 'timeout');
  assert.ok(eng.status().since, '使えなくなった時刻が立つ（30 分で帯）');
  slow = false; chunks.push({ c: 'c1', id: 'b', hash: 'h', title: 'x', text: '' }); await eng.round();
  assert.equal(eng.status().ok, true, '列が 1 行を埋められたら戻る');
  assert.equal(eng.status().since, null);
});

test('時間切れで止めた後は、/api/version が答えても空の列の回りでは戻さず、短い埋め込みが返った時だけ戻す（3 回目のレビュー P2-C）', async () => {
  const chunks = [{ c: 'c1', id: 'a', hash: 'h', title: '支払い', text: '' }];
  const store = embStore(chunks);
  let hung = false;
  const client = { numThread: 2, alive: async () => true, embed: async input => { if (hung) throw new EmbedError('t', { timeout: true }); return vecOf(input); } };
  const eng = semanticEngine({ store, client, sleep: noSleep });
  await eng.round(); await warm(eng, 'c1');
  hung = true;
  for (let i = 0; i < EMBED.timeoutsToDown; i++) await eng.search('c1', 'pay');
  const since = eng.status().since;
  assert.equal(eng.status().ok, false);
  await eng.round(); await eng.round(); // 列は空・/api/version は答える
  assert.equal(eng.status().ok, false, '固まったままなら戻さない');
  assert.equal(eng.status().since, since, '使えなくなった時刻は変わらない（30 分で帯）');
  hung = false; await eng.round();
  assert.equal(eng.status().ok, true, '短い埋め込みが返ったら戻る');
});

test('同じ行が続けて時間切れなら、その行を失敗に回し、列全体は止めない（3 回目のレビュー P3）', async () => {
  const chunks = [{ c: 'c1', id: 'big', hash: 'h', title: 'BIG', text: '' }, { c: 'c1', id: 'ok', hash: 'h', title: '支払い', text: '' }];
  const store = embStore(chunks);
  const client = { numThread: 2, alive: async () => true, embed: async input => { if (input.startsWith('BIG')) throw new EmbedError('t', { timeout: true }); return vecOf(input); } };
  const eng = semanticEngine({ store, client, sleep: noSleep });
  await eng.round(); await eng.round(); await eng.round();
  assert.equal(store.fail.get('big')?.tries, 1, '2 回目の時間切れで失敗に回す');
  assert.ok(store.emb.has('ok'), '後ろの行は埋まる');
  assert.equal(eng.status().ok, true);
});

test('Ollama の全体が固まっている間は、どの行も失敗に数えない・行の時間切れは会社ごとに数える（4 回目のレビュー P2-D・P3）', async () => {
  const chunks = [{ c: 'c1', id: 'doc:readme.md#0', hash: 'h', title: 'x', text: '1' }, { c: 'c2', id: 'doc:readme.md#0', hash: 'h', title: 'x', text: '2' }];
  const store = embStore(chunks);
  let hung = true;
  const client = { numThread: 2, alive: async () => true, embed: async input => { if (hung) throw new EmbedError('t', { timeout: true }); return vecOf(input); } };
  const eng = semanticEngine({ store, client, sleep: noSleep });
  for (let i = 0; i < 12; i++) await eng.round();
  assert.equal(store.fail.size, 0, '全体が固まっている間は failEmbed を呼ばない');
  assert.equal(eng.status().reason, 'timeout');
  hung = false; await eng.round();
  assert.equal(store.emb.size, 1, '戻ったら埋まる（偽の store は id で持つので 1 つ）');
  // 会社をまたいで数えない: c1 の行だけが遅い時、c2 の同じ名前の行は 1 回目で失敗に回らない
  store.emb.clear(); store.fail.clear();
  const failedBy = []; const origFail = store.failEmbed; store.failEmbed = async (c, ...r) => { failedBy.push(c); return origFail(c, ...r); };
  const client2 = { numThread: 2, alive: async () => true, embed: async input => { if (input === 'x\n1') throw new EmbedError('t', { timeout: true }); if (input === 'x\n2' && !client2.once) { client2.once = true; throw new EmbedError('t', { timeout: true }); } return vecOf(input); } };
  const eng2 = semanticEngine({ store, client: client2, sleep: noSleep });
  await eng2.round(); // c1 の行が 1 回目の時間切れ
  await eng2.round(); // c1 の行が 2 回目 → 失敗。c2 の行は 1 回目の時間切れ
  assert.deepEqual(failedBy, ['c1'], '失敗に回るのは c1 の行だけ（c2 の同じ名前の行は 1 回目なので待つ）');
});

test('埋め直した行の新しい埋め込みが記憶にまだ無い時（増分の 501 行目以降）、記憶の古い意味で当てない（codex P2・保証 5）', async () => {
  const chunks = [{ c: 'c1', id: 'chg', hash: 'h1', title: '支払い', text: '月末' }];
  const store = embStore(chunks);
  const eng = semanticEngine({ store, client: fakeClient(), sleep: noSleep });
  await eng.round(); await warm(eng, 'c1');
  assert.deepEqual(ids(await eng.search('c1', 'pay')), ['chg'], '前提: 古い意味で当たる');
  for (let i = 0; i < EMBED.pageRows + 100; i++) chunks.push({ c: 'c1', id: `n${i}`, hash: 'h1', title: 'trip', text: String(i) });
  const old = chunks.shift(); chunks.push({ ...old, hash: 'h2', title: 'trip', text: '旅行' }); // 書き直して、埋め直しは増分の最後に来る
  while ((await store.embedTodo('c1', EMBED.modelDigest, 1)).length) await eng.round();
  assert.equal(store.emb.get('chg').hash, 'h2', '前提: DB では埋め直し済み');
  const r = await eng.search('c1', 'pay'); // 増分は 1 ページ（500 行）までなので、chg の新しい埋め込みはまだ記憶に無い
  assert.deepEqual(ids(r), [], '記憶の古いベクトルで当てない');
});

test('埋め込みの口が 500 を返し続け /api/version は答える時も、使えない扱いにして帯につなぎ、行の失敗に数えず、埋め込みが返れば戻る（codex P2・保証 7）', async () => {
  const chunks = [{ c: 'c1', id: 'a', hash: 'h1', title: '支払い', text: '' }];
  const store = embStore(chunks);
  let broken = false;
  const client = { numThread: 2, alive: async () => true, embed: async input => { if (broken) throw new EmbedError('ollama 500', { status: 500 }); return vecOf(input); } };
  const eng = semanticEngine({ store, client, sleep: noSleep });
  await eng.round(); await warm(eng, 'c1');
  broken = true;
  for (let i = 0; i < EMBED.timeoutsToDown; i++) await eng.search('c1', 'pay');
  assert.equal(eng.status().ok, false, '500 が続けば使えない扱い');
  const since = eng.status().since; assert.ok(since);
  chunks.push({ c: 'c1', id: 'b', hash: 'h1', title: 'x', text: '' });
  await eng.round(); await eng.round();
  assert.equal(store.fail.size, 0, '全体の失敗は行の失敗に数えない');
  assert.equal(eng.status().ok, false); assert.equal(eng.status().since, since, '使えなくなった時刻は変わらない（30 分で帯）');
  broken = false; await eng.round();
  assert.equal(eng.status().ok, true, '埋め込みが返れば戻る');
});

test('問いの中の増分の読み込みは 1 ページまでで、残りは裏で読む（2 回目のレビュー P3）', async () => {
  const chunks = [{ c: 'c1', id: 'a0', hash: 'h', title: 'x', text: '' }];
  const store = embStore(chunks);
  const eng = semanticEngine({ store, client: fakeClient(), sleep: noSleep });
  await eng.round(); await warm(eng, 'c1');
  for (let i = 1; i <= EMBED.pageRows + 10; i++) chunks.push({ c: 'c1', id: `a${i}`, hash: 'h', title: 'x', text: '' });
  await eng.round(); for (let i = 0; i < 20 && store.embedTodo && (await store.embedTodo('c1', EMBED.modelDigest, 1)).length; i++) await eng.round();
  let pages = 0; const orig = store.loadEmbeddings; store.loadEmbeddings = async (...a) => { pages++; return orig(...a); };
  await eng.search('c1', 'pay');
  assert.equal(pages, 1, '問いの中では 1 ページだけ読む');
  for (let i = 0; i < 50 && eng.vectors.get('c1').ids.length < chunks.length; i++) await new Promise(r => setTimeout(r, 10));
  assert.equal(eng.vectors.get('c1').ids.length, chunks.length, '残りは裏で読み終える');
});

test('列と問いの順番: 問いが来ている間、列は次の行に進まない（作り方 8a）', async () => {
  const chunks = [1, 2, 3].map(i => ({ c: 'c1', id: `r${i}`, hash: 'h', title: 'x', text: String(i) }));
  const store = embStore(chunks);
  const order = []; let release;
  const gate = new Promise(r => { release = r; });
  const client = { numThread: 1, alive: async () => true, embed: async input => { order.push(input.includes('\n') ? 'row' : 'query'); return vecOf(input); } };
  const sleeps = [];
  const eng = semanticEngine({ store, client, sleep: async ms => { sleeps.push(ms); if (ms === 50) { await gate; } } });
  eng.st.queries = 1; // 問いが来ている
  const r = eng.round();
  await new Promise(x => setImmediate(x));
  assert.deepEqual(order, [], '問いの印が立っている間は行を出さない');
  eng.st.queries = 0; release();
  await r;
  assert.equal(order.filter(x => x === 'row').length, 3);
});

test('Ollama の口: 断られた時は生きているかで分け、届かない・時間切れを分ける（作り方 8）', async () => {
  const mk = (embedRes, versionOk) => async (url, opt) => {
    if (url.endsWith('/api/version')) { if (versionOk) return { ok: true }; throw new Error('ECONNREFUSED'); }
    return embedRes(opt);
  };
  const c400 = ollamaClient({ url: 'http://x', numThread: 2, fetchImpl: mk(() => ({ ok: false, status: 400 }), true) });
  await assert.rejects(c400.embed('a'), e => e instanceof EmbedError && !e.down && !e.timeout && e.status === 400);
  const c500dead = ollamaClient({ url: 'http://x', numThread: 2, fetchImpl: mk(() => ({ ok: false, status: 500 }), false) });
  await assert.rejects(c500dead.embed('a'), e => e.down === true);
  const refused = ollamaClient({ url: 'http://x', numThread: 2, fetchImpl: mk(() => { throw new TypeError('fetch failed'); }, false) });
  await assert.rejects(refused.embed('a'), e => e.down === true && !e.timeout);
  const late = ollamaClient({ url: 'http://x', numThread: 2, fetchImpl: mk(() => { const e = new Error('t'); e.name = 'TimeoutError'; throw e; }, true) });
  await assert.rejects(late.embed('a'), e => e.timeout === true && !e.down);
  let body = null;
  const good = ollamaClient({ url: 'http://x', numThread: 3, fetchImpl: mk(opt => { body = JSON.parse(opt.body); return { ok: true, json: async () => ({ embeddings: [Array(EMBED.dims).fill(0.1)] }) }; }, true) });
  assert.equal((await good.embed('a')).length, EMBED.dims);
  assert.equal(body.options.num_thread, 3, 'num_thread はいつも同じ値');
  const short = ollamaClient({ url: 'http://x', numThread: 3, fetchImpl: mk(() => ({ ok: true, json: async () => ({ embeddings: [[1, 2]] }) }), true) });
  await assert.rejects(short.embed('a'), e => e instanceof EmbedError && !e.down);
});

test('世代: chunks の行を消す SQL は delChunks の中だけで、行が消えた時だけ世代を進める（作り方 13・独立レビュー P2-2）', async () => {
  const src = readFileSync(new URL('../plugins/library/src/worker.mjs', import.meta.url), 'utf8');
  // 大文字小文字・書き方を問わず、chunks の表を消す・空にする文は 1 か所だけ
  assert.equal((src.match(/delete\s+from\s+\$\{[^}]*chunks[^}]*\}/gi) || []).length, 1, 'chunks を消す SQL は delChunks の中だけ');
  assert.equal((src.match(/delete\s+from\s+[^`]*chunks/gi) || []).length, 1, '名前を直に書いて消す SQL も無い');
  assert.equal((src.match(/truncate\s+(table\s+)?[^`]*chunks/gi) || []).length, 0);
  const log = []; let rc = 1;
  const db = { namespace: 'ns', execute: async sql => { log.push(sql.replace(/\s+/g, ' ')); return { rowCount: sql.startsWith('DELETE') ? rc : 1 }; }, query: async () => [] };
  const s = dbStore(db);
  await s.dropIssueExcept('c1', 'i1', []); await s.dropMissingIssues('c1', ['i2']); await s.removeDoc('c1', 'a.md');
  const dels = log.map((q, i) => [q, i]).filter(([q]) => q.startsWith('DELETE FROM ns.chunks'));
  assert.equal(dels.length, 3);
  for (const [, i] of dels) assert.match(log[i + 1], /INSERT INTO ns\.generations/);
  log.length = 0; rc = 0;
  await s.dropIssueExcept('c1', 'i1', []);
  assert.ok(!log.some(q => q.includes('generations')), '消えた行が 0 の時は世代を進めない（取り込みのたびに読み直さない）');
});

test('検索: 語が当たらない言い換えも意味の候補で出し、返事に意味の検索を使えたかと理由を書く・添え書きは語だけ（作り方 11・14a）', async () => {
  const rows = { r1: { id: 'r1', srcId: 'doc:pay.md', kind: 'doc', title: '支払いの決まり', text: '締めは月末', date: '2026-11-16' } };
  let semCalls = 0;
  const deps = { now: () => Date.parse('2026-11-17'),
    store: { candidates: async () => [], byIdentifier: async () => [], byIds: async (c, ids) => ids.map(id => rows[id]).filter(Boolean) },
    semantic: { search: async () => { semCalls++; return { hits: [{ id: 'r1', cos: 0.64 }], reason: null }; } } };
  const meta = {};
  assert.deepEqual((await searchCompany(deps, 'c1', 'when do we pay vendors', { meta })).map(h => h.srcId), ['doc:pay.md']);
  assert.deepEqual(meta, { semantic: true, reason: null });
  assert.deepEqual(await searchCompany(deps, 'c1', 'when do we pay vendors', { semantic: false }), []);
  assert.equal(semCalls, 1);
  assert.deepEqual((await searchCompany(deps, 'c1', 'ねこ')).map(h => h.srcId), ['doc:pay.md'], '語に分けられない短い問いも意味では問う');
  deps.semantic.search = async () => ({ hits: null, reason: 'warming' });
  const m2 = {};
  assert.deepEqual(await searchCompany(deps, 'c1', 'when do we pay vendors', { meta: m2 }), [], '使えない時は語だけ');
  assert.deepEqual(m2, { semantic: false, reason: 'warming' });
});

test('記憶の足し込み: 同じ id は置き換え、上限を超えたら古い行から落とす', () => {
  const s = new VectorStore({ dims: 2, maxBytes: 2 * 4 * 3 });
  s.set('c1', [{ id: 'b', vec: unit(1, 1) }, { id: 'a', vec: unit(1, 0) }], { seq: 2 });
  s.upsert('c1', [{ id: 'a', vec: unit(0, 1) }, { id: 'c', vec: unit(1, 2) }, { id: 'd', vec: unit(1, 3) }], 5);
  const c = s.get('c1');
  assert.deepEqual(c.ids, ['b', 'c', 'd']);
  assert.equal(c.seq, 5);
  assert.deepEqual(s.top('c1', unit(0, 1), { floor: 0.99 }).map(x => x.id), []);
  s.upsert('c1', [{ id: 'b', vec: unit(0, 1) }], 6);
  assert.deepEqual(s.top('c1', unit(0, 1), { floor: 0.99 }).map(x => x.id), ['b']);
});

import { semanticDown, SEMANTIC_DOWN_MS } from '../plugins/office/src/api.mjs';
import { DICT as ODICT } from '../plugins/office/src/i18n.mjs';
test('部屋の帯: 意味の検索が 30 分続けて使えない時だけ出し、止めている時は出さない・英日の文がある（作り方 15）', () => {
  const now = Date.parse('2026-11-17T10:00:00Z'), ago = ms => new Date(now - ms).toISOString();
  assert.equal(semanticDown({ ok: false, reason: 'unavailable', since: ago(SEMANTIC_DOWN_MS) }, now), true);
  assert.equal(semanticDown({ ok: false, reason: 'unavailable', since: ago(SEMANTIC_DOWN_MS - 1) }, now), false);
  assert.equal(semanticDown({ ok: true, reason: null, since: null }, now), false);
  assert.equal(semanticDown({ ok: false, reason: 'off', since: ago(SEMANTIC_DOWN_MS * 2) }, now), false);
  assert.equal(semanticDown(undefined, now), false);
  for (const l of ['en', 'ja']) for (const k of ['library_semantic_down', 'library_semantic_backlog']) assert.ok(ODICT[l][k], `${l}.${k}`);
});
