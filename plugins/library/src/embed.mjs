// 図書室の意味の近さの検索の判定（通信も DB もしない純粋な関数）
// 範囲: 開発元の記録 docs/review/2026-11-17-library-embedding-scope.md（作り方 5・9・12・14・14a）
export const EMBED = Object.freeze({
  model: 'bge-m3',
  // registry.ollama.ai の library/bge-m3:latest の model の層（packages/aioffice/embed/fetch-embed.sh と同じ値）
  modelDigest: 'sha256:daec91ffb5dd0c27411bd71f29932917c49cf529a641d0168496c3a501e3062c',
  dims: 1024,
  floor: 0.45,          // 意味だけで当たる下限（作り方 14a・実測 言い換え 0.641・英語 0.514・関係ない 0.342）
  weight: 0.6,          // 語の点に足す意味の点の重み
  semanticTop: 30,      // 意味の候補の上限
  memoryBytes: 160 * 1024 * 1024, // 記憶の全体の上限（作り方 14）
  batch: 50,            // 列が 1 回に拾う行
  restMs: 200,          // 列が 1 行ごとに休む
  callTimeoutMs: 30_000,// Ollama への 1 回の呼び出し（列の 1 行）
  queryTimeoutMs: 8_000, // 問いの待ちの上限（本体から worker への呼び出しの 30 秒の枠に語の検索の分を残す・初回の model の読み込み 3.2 秒を含む）
  timeoutsToDown: 3,    // 続けてこの回数だけ時間切れなら使えない扱いにする（帯につなぐ）
  maxFailures: 3,       // 1 行を諦めるまでの失敗の数（Ollama が生きている時の 4xx/5xx だけ数える）
  pageRows: 500,        // 記憶への読み込みの 1 ページ
});

// container で使える CPU の数（作り方 5・受け入れる限界）。値を変えると Ollama が model を読み直すので、1 か所で決める
// cpuMax: cgroup v2 の cpu.max の中身（"max 100000" か "200000 100000"）、cfsQuota/cfsPeriod: cgroup v1、cpuset: 使える CPU の数、avail: availableParallelism()
export function numThreadFrom({ cpuMax = null, cfsQuota = null, cfsPeriod = null, cpuset = null, avail = 1 } = {}) {
  let n = Number(cpuset) > 0 ? Math.floor(Number(cpuset)) : Math.max(1, Math.floor(Number(avail) || 1));
  const m = String(cpuMax || '').trim().split(/\s+/);
  if (m.length === 2 && m[0] !== 'max') { const q = Number(m[0]), p = Number(m[1]); if (q > 0 && p > 0) n = Math.min(n, Math.max(1, Math.floor(q / p))); }
  else if (Number(cfsQuota) > 0 && Number(cfsPeriod) > 0) n = Math.min(n, Math.max(1, Math.floor(Number(cfsQuota) / Number(cfsPeriod))));
  return Math.max(1, n);
}
// "0-3,6" の形の cpuset の数
export function cpusetCount(s) {
  let n = 0;
  for (const part of String(s || '').trim().split(',').filter(Boolean)) {
    const [a, b] = part.split('-').map(Number);
    if (Number.isInteger(a) && Number.isInteger(b) && b >= a) n += b - a + 1; else if (Number.isInteger(a)) n += 1;
  }
  return n || null;
}

// ベクトル ⇄ base64（bytea を本体の DB の口に文字で渡す・作り方 9）。little-endian の Float32
export function f32ToB64(vec) {
  const f = vec instanceof Float32Array ? vec : Float32Array.from(vec);
  const buf = Buffer.alloc(f.length * 4);
  for (let i = 0; i < f.length; i++) buf.writeFloatLE(f[i], i * 4);
  return buf.toString('base64');
}
export function b64ToF32(b64) {
  const buf = Buffer.from(String(b64 || ''), 'base64'); // PostgreSQL の encode が入れる改行は飛ばされる
  if (buf.length % 4) throw new Error(`vector byte length is not a multiple of 4 (${buf.length})`);
  const f = new Float32Array(buf.length / 4);
  for (let i = 0; i < f.length; i++) f[i] = buf.readFloatLE(i * 4);
  return f;
}
// 単位の長さにそろえる（cosine を内積で取るため）。長さ 0 や NaN を含む物は null
export function normalize(vec) {
  let s = 0; for (let i = 0; i < vec.length; i++) { const x = vec[i]; if (!Number.isFinite(x)) return null; s += x * x; }
  if (!(s > 0)) return null;
  const k = 1 / Math.sqrt(s), out = new Float32Array(vec.length);
  for (let i = 0; i < vec.length; i++) out[i] = vec[i] * k;
  return out;
}

// 会社ごとの記憶（作り方 12〜14）。ids と、単位の長さにそろえたベクトルを連続の Float32Array に並べる
// seqs は各行の埋め込みの seq（問いの時に DB の今の seq と照らし、埋め直した行の古い意味で当てない・codex P2）
export class VectorStore {
  constructor({ dims = EMBED.dims, maxBytes = EMBED.memoryBytes } = {}) { this.dims = dims; this.maxBytes = maxBytes; this.companies = new Map(); }
  bytes() { let n = 0; for (const c of this.companies.values()) n += c.data.byteLength; return n; }
  // rows: { id, vec(Float32Array), date } を新しい順に。1 社の上限を超える古い行は載せない（作り方 14）
  set(companyId, rows, { generation = 0, seq = 0 } = {}) {
    const cap = Math.floor(this.maxBytes / (this.dims * 4));
    const take = rows.slice(0, cap).reverse(); // 中では古い順に持つ（upsert は末尾に足し、先頭から落とす）
    const data = new Float32Array(take.length * this.dims), ids = [], seqs = [];
    take.forEach((r, i) => { data.set(r.vec, i * this.dims); ids.push(r.id); seqs.push(Number(r.seq) || 0); });
    this.companies.set(companyId, { ids, seqs, data, generation, seq, usedAt: 0 });
    this.evict(companyId);
  }
  // 全体の上限を超える時は、最近検索に使っていない会社から降ろす（keep は降ろさない）
  evict(keep) {
    const order = [...this.companies.entries()].filter(([k]) => k !== keep).sort((a, b) => a[1].usedAt - b[1].usedAt);
    while (this.bytes() > this.maxBytes && order.length) this.companies.delete(order.shift()[0]);
  }
  // seq の続きの行を足す（同じ id は置き換え）。1 社の上限を超えたら古い行（先頭）から落とす
  upsert(companyId, rows, seq) {
    const c = this.companies.get(companyId); if (!c) return this.set(companyId, [...rows].reverse(), { seq });
    const d = this.dims, idx = new Map(c.ids.map((id, i) => [id, i])), add = [];
    for (const r of rows) { const i = idx.get(r.id); if (i === undefined) { idx.set(r.id, -1); add.push(r); } else if (i >= 0) { c.data.set(r.vec, i * d); c.seqs[i] = Number(r.seq) || 0; } else add[add.findIndex(x => x.id === r.id)] = r; }
    if (add.length) {
      const cap = Math.floor(this.maxBytes / (d * 4)), total = c.ids.length + add.length, drop = Math.max(0, total - cap);
      const data = new Float32Array((total - drop) * d);
      data.set(c.data.subarray(Math.min(drop, c.ids.length) * d));
      const ids = c.ids.slice(Math.min(drop, c.ids.length)), seqs = c.seqs.slice(Math.min(drop, c.ids.length));
      const addKeep = add.slice(Math.max(0, drop - c.ids.length));
      addKeep.forEach((r, i) => data.set(r.vec, (ids.length + i) * d));
      c.ids = [...ids, ...addKeep.map(r => r.id)]; c.seqs = [...seqs, ...addKeep.map(r => Number(r.seq) || 0)]; c.data = data;
    }
    c.seq = Math.max(c.seq, Number(seq) || 0);
    this.evict(companyId);
  }
  has(companyId) { return this.companies.has(companyId); }
  get(companyId) { return this.companies.get(companyId) || null; }
  drop(companyId) { this.companies.delete(companyId); }
  // q: 単位の長さのベクトル。下限以上の上位 n 件を { id, cos, seq } で
  top(companyId, q, { floor = EMBED.floor, n = EMBED.semanticTop, now = 0 } = {}) {
    const c = this.companies.get(companyId); if (!c || !q) return [];
    c.usedAt = now;
    const out = [], d = this.dims;
    for (let i = 0; i < c.ids.length; i++) {
      let s = 0; const o = i * d;
      for (let j = 0; j < d; j++) s += c.data[o + j] * q[j];
      if (s >= floor) out.push({ id: c.ids[i], cos: s, seq: c.seqs[i] });
    }
    return out.sort((a, b) => b.cos - a.cos || String(a.id).localeCompare(String(b.id))).slice(0, n);
  }
}

// 意味の点（作り方 14a）: 0.6 × max(0, cos − floor) / (1 − floor)
export const semanticPoints = (cos, { floor = EMBED.floor, weight = EMBED.weight } = {}) =>
  Number.isFinite(cos) && cos >= floor ? weight * Math.max(0, cos - floor) / (1 - floor) : 0;
