// 図書室の意味の近さの検索の裏の列と問い（Ollama と DB に触る部分・どちらも差し替えて試験する）
// 範囲: 開発元の記録 docs/review/2026-11-17-library-embedding-scope.md（作り方 5〜7・10〜14）
import { readFileSync } from 'node:fs';
import { availableParallelism } from 'node:os';
import { EMBED, numThreadFrom, cpusetCount, normalize, b64ToF32, f32ToB64, VectorStore } from './embed.mjs';

const rd = p => { try { return readFileSync(p, 'utf8').trim(); } catch { return null; } };
// container で使える CPU の数（cgroup v2・v1 の順に読む）
export function containerThreads() {
  return numThreadFrom({
    cpuMax: rd('/sys/fs/cgroup/cpu.max'),
    cfsQuota: rd('/sys/fs/cgroup/cpu/cpu.cfs_quota_us'), cfsPeriod: rd('/sys/fs/cgroup/cpu/cpu.cfs_period_us'),
    cpuset: cpusetCount(rd('/sys/fs/cgroup/cpuset.cpus.effective') ?? rd('/sys/fs/cgroup/cpuset/cpuset.effective_cpus')),
    avail: availableParallelism(),
  });
}

// down: Ollama に届かない（行の失敗には数えない）。timeout: 時間切れ（行の失敗にも down にも数えない）。どちらでもない失敗だけを行の失敗に数える
export class EmbedError extends Error {
  constructor(message, { down = false, timeout = false, status = null } = {}) { super(message); this.down = down; this.timeout = timeout; this.status = status; }
}
const isTimeout = e => e?.name === 'TimeoutError' || e?.name === 'AbortError';

export function ollamaClient({ url, numThread, fetchImpl = globalThis.fetch }) {
  const alive = async () => { try { return (await fetchImpl(`${url}/api/version`, { signal: AbortSignal.timeout(2000) })).ok; } catch { return false; } };
  return {
    numThread, alive,
    async embed(input, timeoutMs = EMBED.callTimeoutMs) {
      let r;
      try {
        r = await fetchImpl(`${url}/api/embed`, {
          method: 'POST', headers: { 'content-type': 'application/json' },
          // num_thread は常に同じ値（変えると model を読み直す）
          body: JSON.stringify({ model: EMBED.model, input, truncate: true, options: { num_thread: numThread } }),
          signal: AbortSignal.timeout(timeoutMs),
        });
      } catch (e) {
        if (isTimeout(e)) throw new EmbedError('ollama timeout', { timeout: true });
        throw new EmbedError(`ollama unreachable: ${String(e?.name || e).slice(0, 80)}`, { down: true });
      }
      if (!r.ok) { const up = await alive(); throw new EmbedError(`ollama ${r.status}`, { down: !up, status: r.status }); }
      let j; try { j = await r.json(); } catch (e) { if (isTimeout(e)) throw new EmbedError('ollama timeout', { timeout: true }); throw new EmbedError('ollama bad json'); }
      const v = j?.embeddings?.[0];
      if (!Array.isArray(v) || v.length !== EMBED.dims) throw new EmbedError('ollama bad embedding');
      return Float32Array.from(v);
    },
  };
}

// 裏の列と問い。store は worker の dbStore（embed* の口）、client は ollamaClient
// 状態: ready（使える）・warming（記憶を読んでいる）・unavailable（Ollama が答えない）。since は使えなくなった時刻（範囲 作り方 15）
export function semanticEngine({ store, client, now = Date.now, sleep = ms => new Promise(r => setTimeout(r, ms)), log = () => {}, vectors = new VectorStore() }) {
  const st = { up: null, why: null, since: now(), rows: [], queries: 0, embedded: 0, failed: 0, lastError: null, stopped: false, idleMs: 5_000, timeouts: 0 };
  const digest = EMBED.modelDigest;
  const loading = new Map(); // 会社 → 読み込みの Promise（会社ごとに 1 本だけ）
  const rowTimeouts = new Map(); // 行 → 時間切れの数（同じ行が続けて時間切れなら、その行を失敗に回す・3 回目のレビュー P3）
  const setUp = (up, why = 'unavailable') => { if (up && st.up !== true) st.since = null; if (!up && st.up !== false) st.since = now(); st.up = up; st.why = up ? null : why; if (up) st.timeouts = 0; };
  // 時間切れ・Ollama の全体の失敗が続けば使えない扱いにする（process は生きていても答えない・500 を返し続ける Ollama を帯につなぐ・2 回目のレビュー P2-A・codex P2）
  const failGlobal = why => { st.timeouts++; if (st.timeouts >= EMBED.timeoutsToDown) setUp(false, why); };
  const timedOut = () => failGlobal('timeout');
  // 短い埋め込みが返るか（/api/version でなく、埋め込みそのものが動くかを見る）
  const pingEmbed = async () => { try { await client.embed('ping', EMBED.queryTimeoutMs); return true; } catch { return false; } };
  // 1 行の最大は直近 20 行だけで見る（1 回の遅い行で問いの待ちが長いままにならない）
  const rowMaxMs = () => (st.rows.length ? Math.max(...st.rows) : 0);

  // 1 行を埋め込む。戻り値: 'ok' | 'failed' | 'wait'（Ollama が答えない・時間切れ: 行には数えず列ごと待つ）
  async function embedRow(companyId, row) {
    const t = now();
    try {
      const vec = normalize(await client.embed(`${row.title}\n${row.text}`));
      if (!vec) throw new EmbedError('zero vector');
      await store.putEmbedding(companyId, row.id, row.hash, digest, f32ToB64(vec));
      st.rows.push(now() - t); if (st.rows.length > 20) st.rows.shift();
      st.embedded++; setUp(true);
      return 'ok';
    } catch (e) {
      st.lastError = String(e?.message || e).slice(0, 200);
      if (e instanceof EmbedError && e.down) { setUp(false); return 'wait'; }
      if (e instanceof EmbedError && e.timeout) {
        // その行の問題か Ollama の全体の問題かを、短い埋め込みで分ける（全体が固まっている間は行の失敗に数えない・4 回目のレビュー P2-D）
        if (!(await pingEmbed())) { timedOut(); return 'wait'; }
        const key = `${companyId}\x1f${row.id}`; // chunk の id は会社ごとにだけ一意
        const n = (rowTimeouts.get(key) || 0) + 1;
        if (n >= 2) { rowTimeouts.delete(key); await store.failEmbed(companyId, row.id, row.hash); st.failed++; return 'failed'; }
        rowTimeouts.set(key, n); return 'wait';
      }
      if (!(e instanceof EmbedError)) throw e; // DB の失敗は回りごと止めて次の回に
      // 500 等: 短い埋め込みも失敗するなら Ollama の全体の問題（行の失敗に数えず、続けば使えない扱い・codex P2）
      if (!(await pingEmbed())) { failGlobal('error'); return 'wait'; }
      await store.failEmbed(companyId, row.id, row.hash); st.failed++;
      return 'failed';
    }
  }

  // 1 回り: 会社ごとに順番に、まだ埋めていない行を 1 行ずつ。問いが来ている間は次の行に進まない（範囲 作り方 8a）
  async function round() {
    let done = 0;
    for (const companyId of await store.embedCompanies()) {
      const todo = await store.embedTodo(companyId, digest, EMBED.batch);
      for (const row of todo) {
        while (st.queries > 0 && !st.stopped) await sleep(50);
        if (st.stopped) return done;
        const r = await embedRow(companyId, row);
        if (r === 'wait') return done;
        done++;
        await sleep(EMBED.restMs);
      }
    }
    // 戻す: 時間切れで止めた時は /api/version では戻さず、短い埋め込みが実際に返った時だけ戻す（HTTP の口は生きていて runner が固まった Ollama・3 回目のレビュー P2-C）
    if (st.up !== true) {
      if (st.why === 'timeout' || st.why === 'error') { if (await pingEmbed()) setUp(true); }
      else setUp(await client.alive());
    }
    return done;
  }

  async function loop() {
    while (!st.stopped) {
      let n = 0;
      try { n = await round(); } catch (e) { st.lastError = String(e?.message || e).slice(0, 200); log('library: embed round failed', { error: st.lastError }); }
      // 仕事が無い時は間隔を 60 秒まで延ばす（空の列で DB を叩き続けない）
      st.idleMs = n ? 5_000 : Math.min(60_000, st.idleMs * 2);
      if (!st.stopped) await sleep(n ? EMBED.restMs : st.up === false ? 15_000 : st.idleMs);
    }
  }

  // 記憶を DB に合わせる（会社ごとに 1 本だけ）。full: 全部を読み直す・そうでなければ seq の続きだけ
  // maxPages: 問いの中で読む時の上限（残りは裏で続ける）
  function load(companyId, full, { maxPages = Infinity } = {}) {
    if (loading.has(companyId)) return loading.get(companyId);
    let more = false;
    const p = (async () => {
      const gen = Number(await store.generation(companyId)) || 0;
      const c = vectors.get(companyId);
      const inc = !full && c && c.generation === gen;
      let after = inc ? c.seq : 0;
      const rows = [];
      for (let n = 0; ; n++) {
        if (inc && n >= maxPages) { more = true; break; }
        const page = await store.loadEmbeddings(companyId, digest, after, EMBED.pageRows);
        for (const x of page) { const v = b64ToF32(x.vec); if (v.length === vectors.dims) rows.push({ id: x.id, vec: v, seq: Number(x.seq) }); after = Math.max(after, Number(x.seq)); }
        if (page.length < EMBED.pageRows) break;
      }
      if (inc) { if (rows.length) vectors.upsert(companyId, rows, after); }
      else vectors.set(companyId, rows.reverse(), { generation: gen, seq: after }); // 新しい順に渡す（上限で古い行を落とす）
    })().catch(e => { st.lastError = String(e?.message || e).slice(0, 200); }).finally(() => { loading.delete(companyId); if (more && !st.stopped) setTimeout(() => load(companyId, false), 0); }); // 残りは問いの返事の後に裏で
    loading.set(companyId, p);
    return p;
  }

  // 問い: { hits: [{ id, cos }] | null, reason }。使えない時は hits が null で、語だけの検索に戻る（範囲 作り方 11〜13）
  async function search(companyId, q) {
    if (st.stopped || st.up === false) return { hits: null, reason: st.why === 'timeout' ? 'timeout' : 'unavailable' };
    const c = vectors.get(companyId);
    // 記憶に無い会社は裏で読み、終わるまで warming（問いの中で全部を読まない）
    if (!c) { load(companyId, true); return { hits: null, reason: 'warming' }; }
    st.queries++;
    try {
      const gen = Number(await store.generation(companyId)) || 0;
      if (gen !== c.generation) load(companyId, true);          // 消えた行がある: 裏で読み直し、今は前の記憶で問う（消えた行は下の引き直しで落ちる）
      else if (!loading.has(companyId)) await load(companyId, false, { maxPages: 1 }); // 足した行: seq の続きを 1 ページまで（残りは裏で）
      // 問いは今の 1 行の後ろに並ぶので、1 行の最大 × 1.2 + 1 秒まで待つ（まだ測れていない時は 1 回の上限）
      const m = rowMaxMs();
      const timeout = m ? Math.min(EMBED.queryTimeoutMs, Math.ceil(m * 1.2) + 1000) : EMBED.queryTimeoutMs;
      const qv = normalize(await client.embed(q, timeout));
      st.timeouts = 0;
      if (!vectors.has(companyId)) return { hits: null, reason: 'warming' }; // 問いの間に降ろされた
      const top = vectors.top(companyId, qv, { now: now() });
      if (!top.length) return { hits: [], reason: null };
      // 行が今もあり、埋め込みの hash が今の本文と同じで、記憶のベクトルが DB の今の埋め込み（seq）と同じ物だけを残す
      // （書き直した行の古い意味で当てない・埋め直した後に記憶が追いついていない時も当てない・保証 5・codex P2）
      const fresh = new Map((await store.freshIds(companyId, top.map(x => x.id), digest)).map(r => [String(r.id), Number(r.seq)]));
      return { hits: top.filter(x => fresh.get(String(x.id)) === Number(x.seq)).map(({ id, cos }) => ({ id, cos })), reason: null };
    } catch (e) {
      st.lastError = String(e?.message || e).slice(0, 200);
      if (e instanceof EmbedError && e.timeout) { timedOut(); return { hits: null, reason: 'timeout' }; }
      if (e instanceof EmbedError && e.down) { setUp(false); return { hits: null, reason: 'unavailable' }; }
      if (e instanceof EmbedError && !(await pingEmbed())) failGlobal('error');
      return { hits: null, reason: 'unavailable' };
    } finally { st.queries--; }
  }

  return {
    st, round, loop, load, search, vectors, rowMaxMs,
    start() { loop(); },
    stop() { st.stopped = true; },
    // ok は Ollama が答えるか。since は使えなくなった時刻（30 分続けば部屋に帯）
    status: () => ({ ok: st.up === true, reason: st.up === true ? null : st.up === false ? st.why : 'warming', since: st.since ? new Date(st.since).toISOString() : null, numThread: client.numThread ?? null, rowMaxMs: Math.round(rowMaxMs()), lastError: st.lastError }),
  };
}
