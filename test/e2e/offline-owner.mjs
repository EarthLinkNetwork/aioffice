// 網を切った container の中で、最初の持ち主を作るまでを通す（container-stage.sh の「網を切った container でも起動する」の段）。
// container の中で node に stdin で渡して流す（docker exec -i <name> node --input-type=module - < この file）。
// ログインのある形では、plugin を入れ始めるのは起動係の鍵ができてから（最初の持ち主の後）なので、網なしでもそこまで通ることを確かめる（2026-11-24 run 45389081856）
import fs from 'node:fs';
// node の fetch は Host の header を差し替えられないので、住所そのものを localhost:3100 にして Host と Origin をそろえる
const B = 'http://localhost:3100', H = { origin: B, 'content-type': 'application/json' };
const jar = {};
const sleep = ms => new Promise(r => setTimeout(r, ms));
async function call(m, p, b) {
  const h = { ...H }; if (Object.keys(jar).length) h.cookie = Object.entries(jar).map(([k, v]) => `${k}=${v}`).join('; ');
  const r = await fetch(B + p, { method: m, headers: h, body: b ? JSON.stringify(b) : undefined, redirect: 'manual' });
  for (const c of r.headers.getSetCookie()) { const [kv] = c.split(';'); const i = kv.indexOf('='); jar[kv.slice(0, i)] = kv.slice(i + 1); }
  const t = await r.text(); let j = null; try { j = JSON.parse(t); } catch { j = t.slice(0, 200); }
  return { s: r.status, j };
}
async function until(f, what, ms = 180_000) { const t0 = Date.now(); while (Date.now() - t0 < ms) { try { if (await f()) return; } catch { /* 起動中 */ } await sleep(2000); } throw new Error(`待ちきれない: ${what}`); }
const must = (r, what, ok = s => s < 300) => { if (!ok(r.s)) { console.log(`${what} → ${r.s} ${JSON.stringify(r.j).slice(0, 200)}`); process.exit(1); } };
await until(async () => (await call('GET', '/setup/api/state')).j?.stage === 'preclaim', 'claim の前の段');
const code = fs.readFileSync('/data/aioffice/claim-code', 'utf8').trim();
must(await call('POST', '/setup/api/claim-code', { code }), 'claim-code');
must(await call('POST', '/api/auth/sign-up/email', { name: 'Offline owner', email: 'offline@example.test', password: 'Offline-pass-12345' }), 'sign-up');
must(await call('POST', '/api/bootstrap/claim', {}), 'bootstrap claim');
must(await call('POST', '/setup/api/launcher-key'), 'launcher-key');
await until(async () => (await call('GET', '/setup/api/state')).j?.stage === 'ready', '普段の段');
console.log('offline owner ok');
