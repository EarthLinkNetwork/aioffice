// 図書室の意味の近さの検索の速さを測る（範囲 docs/review/2026-11-17-library-embedding-scope.md の「作り込みの前に確かめること」）
// 使い方: OLLAMA_URL=http://127.0.0.1:11434 node test/bench/embed-bench.mjs <thread の数>...
// 出す物: thread ごとに、短い問い・所蔵の 1 行の秒数、列（1 行ずつの取り込み）が動いている間の問いの p95、近さ（cosine）
const URL = (process.env.OLLAMA_URL || 'http://127.0.0.1:11434') + '/api/embed';
const threads = process.argv.slice(2).map(Number).filter(n => n > 0);
if (!threads.length) { console.error('thread の数を 1 つ以上渡す'); process.exit(2); }

async function embed(input, numThread) {
  const t = performance.now();
  const r = await fetch(URL, { method: 'POST', body: JSON.stringify({ model: 'bge-m3', input, options: { num_thread: numThread } }) });
  const j = await r.json();
  if (!j.embeddings) throw new Error(JSON.stringify(j).slice(0, 200));
  return { ms: performance.now() - t, e: j.embeddings };
}
const para = (n, ja) => Array.from({ length: n }, (_, i) => ja
  ? `第${i}節。請求書の締め日は毎月末で、支払いは翌月の二十日までに振り込む。担当は経理で、遅れた時は取引先に連絡する。`
  : `Section ${i}. Invoices close at the end of each month and payment is due by the 20th of the next month. Accounting owns this and contacts the vendor when late.`).join(' ');
const cos = (a, b) => { let d = 0, x = 0, y = 0; for (let i = 0; i < a.length; i++) { d += a[i] * b[i]; x += a[i] * a[i]; y += b[i] * b[i]; } return d / Math.sqrt(x * y); };
const pct = (xs, p) => { const s = [...xs].sort((a, b) => a - b); return s[Math.min(s.length - 1, Math.floor(p * s.length))]; };
const r0 = x => Math.round(x);

const out = [];
for (const n of threads) {
  const warm = await embed('warm up', n); // thread の数を変えると model を読み直すので、最初の 1 回は別に数える（最初の thread だけ disk からの読み込みを含む）
  const q = []; for (let i = 0; i < 5; i++) q.push((await embed(i % 2 ? '取引先への支払いはいつ？' : 'when do we pay vendors?', n)).ms);
  const row = []; for (let i = 0; i < 3; i++) row.push((await embed(para(6, i % 2 === 1), n)).ms);
  // 列が動いている間: 取り込みを 1 行ずつ回しながら、問いを 20 回出す（Ollama は同時に 1 本なので、問いは今の 1 行の後ろに並ぶ）
  let busy = true; const ingest = (async () => { while (busy) await embed(para(6, false), n); })();
  const qb = []; for (let i = 0; i < 20; i++) { await new Promise(r => setTimeout(r, 700)); qb.push((await embed('when do we pay vendors?', n)).ms); }
  busy = false; await ingest;
  out.push({ threads: n, warm: r0(warm.ms), query: q.map(r0), row: row.map(r0), busyQueryP95: r0(pct(qb, 0.95)), busyQueryN: qb.length, busyQueryMax: r0(Math.max(...qb)) });
}
const n0 = threads[threads.length - 1];
const [d] = (await embed(para(2, true), n0)).e, [q1] = (await embed('取引先への支払いはいつ？', n0)).e, [q2] = (await embed('when do we pay vendors?', n0)).e, [q3] = (await embed('社員旅行の行き先', n0)).e;
const result = { arch: process.arch, cpus: (await import('node:os')).availableParallelism(), runs: out, cosine: { paraphraseJa: +cos(d, q1).toFixed(3), english: +cos(d, q2).toFixed(3), unrelated: +cos(d, q3).toFixed(3) } };
console.log(JSON.stringify(result, null, 1));
