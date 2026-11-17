// 図書室の plugin を、wizard の後の package で通す（範囲の文書の保証 21 の L1〜L6）。office・知らせの e2e の後に流す
// 使い方: AIO_BASE=http://localhost:3100 AIO_LANG=en AIO_CONTAINER=aioffice AIO_SHOTS=<撮る先> node test/e2e/library.e2e.mjs
//   PLAYWRIGHT_MODULE・PW_EXE は wizard の e2e と同じ
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { DICT, ABOUT } from '../../plugins/office/src/i18n.mjs';
import { BRIEF_MARK, DICT as LDICT, words } from '../../plugins/library/src/lib.mjs';
import { dockerSync } from './docker.mjs';
const RUN = Date.now().toString(36); // 回ごとの印（前の回の物と取り違えない）
const EVAL = JSON.parse(fs.readFileSync(new URL('../fixtures/library-eval.json', import.meta.url), 'utf8'));

const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || 'playwright');
const BASE = process.env.AIO_BASE || 'http://localhost:3100';
const LANG = process.env.AIO_LANG === 'ja' ? 'ja' : 'en';
const CONTAINER = process.env.AIO_CONTAINER || 'aioffice';
const OUT = process.env.AIO_SHOTS || '';
const PASS = process.env.AIO_PASS || 'e2e-owner-password';
const D = DICT[LANG];
const sleep = ms => new Promise(r => setTimeout(r, ms));
const log = (...a) => console.log('[library e2e]', ...a);

// container の中から本体（127.0.0.1:3101）に直に頼む（課題・2 社目を作るなど、持ち主の画面に無い準備だけ）
function core(method, p, body) {
  const js = `const r=await fetch('http://127.0.0.1:3101/api'+process.argv[1],{method:process.argv[2],headers:{'content-type':'application/json'},body:process.argv[3]||undefined});const t=await r.text();console.log(JSON.stringify({s:r.status,t}))`;
  const out = dockerSync(['exec', CONTAINER, 'node', '--input-type=module', '-e', js, p, method, body ? JSON.stringify(body) : ''], { encoding: 'utf8', timeout: 60000 });
  const { s, t } = JSON.parse(out.trim().split('\n').pop());
  let j = null; try { j = JSON.parse(t); } catch { j = null; }
  if (s >= 400) throw new Error(`${method} ${p} → ${s} ${t.slice(0, 200)}`);
  return j;
}
const list = x => (Array.isArray(x) ? x : x?.items || []);

if (OUT) fs.mkdirSync(OUT, { recursive: true });
const browser = await chromium.launch(process.env.PW_EXE ? { executablePath: process.env.PW_EXE } : {});
const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, locale: LANG === 'ja' ? 'ja-JP' : 'en-US' });
const page = await ctx.newPage();
const errors = []; page.on('pageerror', e => errors.push(String(e)));
let n = 0;
const shot = async name => { if (OUT) await page.screenshot({ path: path.join(OUT, `${LANG}_library_${String(++n).padStart(2, '0')}-${name}.png`) }); };

const getState = async () => { for (let i = 0; ; i++) { try { return await (await ctx.request.get(`${BASE}/setup/api/state`)).json(); } catch (e) { if (i >= 2 || !/socket hang up|ECONNRESET/.test(String(e))) throw e; await sleep(500); } } };
const login = await ctx.request.post(`${BASE}/setup/api/login`, { data: { password: PASS }, headers: { origin: BASE } });
assert.equal(login.status(), 200, 'ログイン');
const state0 = await getState();
const companyId = state0.company.id, prefix = state0.company.prefix;
const LB = `${BASE}/api/plugins/aioffice.library/api`;
const api = async (method, url, data) => {
  const r = await ctx.request.fetch(url, { method, data, headers: { origin: BASE, 'content-type': 'application/json' }, timeout: 60000 });
  const j = await r.json().catch(() => null);
  assert.ok(r.ok(), `${method} ${url} → ${r.status()} ${JSON.stringify(j).slice(0, 200)}`);
  return j;
};
const cq = cid => `companyId=${encodeURIComponent(cid)}`;
// 起動係と同じ形で見回りの口を呼ぶ。動いている間（409）は待って呼び直す
const tick = async (cid = companyId) => {
  const s = await getState();
  for (let i = 0; i < 30; i++) {
    const r = await ctx.request.post(`${LB}/tick?${cq(cid)}`, { data: { lang: s.lang, ...(s.timeZone ? { timeZone: s.timeZone } : {}) }, headers: { origin: BASE, 'content-type': 'application/json' }, timeout: 60000 });
    if (r.status() === 409) { await sleep(2000); continue; }
    assert.ok(r.ok(), `tick ${r.status()}`); return r.json();
  }
  throw new Error('tick が 409 のまま');
};
// 記憶を裏で読んでいる間（warming）は問い直す
const searchFull = async (q, cid = companyId) => { let r = null; for (let i = 0; i < 30; i++) { r = await api('GET', `${LB}/search?${cq(cid)}&q=${encodeURIComponent(q)}`); if (r.semanticReason !== 'warming') break; await sleep(2000); } return r; };
const search = async (q, cid = companyId) => (await searchFull(q, cid)).results;

// 保証 1: 起動係が図書室の plugin を入れて ready にした
const plugins = JSON.parse(dockerSync(['exec', CONTAINER, 'cat', '/data/aioffice/plugins.json'], { encoding: 'utf8' }));
assert.equal(plugins['aioffice.library']?.status, 'ready', '図書室の plugin が ready');

// ---- L1: 図書室の部屋（ここでできること・所蔵の数）----
await tick();
await page.goto(`${BASE}/${prefix}/office`);
await page.click('[data-room="library"]');
await page.waitForSelector('[data-about="library"]');
assert.equal(await page.textContent('[data-panel="about-library"] h2'), D[ABOUT.library[0]]);
assert.deepEqual(await page.$$eval('[data-about="library"] li', els => els.map(e => e.textContent)), ABOUT.library[1].map(k => D[k]));
await page.waitForSelector('[data-library-status]');
assert.match(await page.textContent('[data-library-status]'), new RegExp(D.library_last));
assert.equal((await page.$('[data-library-stale]')) === null, true, 'L1: 見回りの後は赤い帯が出ない');
assert.equal((await page.$('[data-library-failed]')) === null, true, 'L1: 読めなかった記録が無い');
await shot('room');
log('L1 ok');

// ---- L2: 文書を置く（画面から）・秘密の形は伏せて保存し、検索にも出ない。課題の秘密も同じ ----
const SECRET = `pcp_board_${RUN}abcdefghijklmnop0123`;
const docName = `brand-${RUN}.md`;
await page.setInputFiles('[data-library-file]', { name: docName, mimeType: 'text/markdown', buffer: Buffer.from(`# Brand ${RUN}\n\nOur brand color is navy ${RUN}.\n\nAPI_KEY=${SECRET}\n`) });
await page.waitForSelector(`[data-library-added="${docName}"]`);
await page.waitForSelector(`[data-library-doc="${docName}"]`);
await page.fill('[data-library-q]', `navy ${RUN}`);
await page.click('[data-library-go]');
await page.waitForSelector(`[data-library-hit="doc:${docName}"]`);
assert.ok(!(await page.textContent('[data-library="panel"]')).includes(SECRET), 'L2: 画面に秘密が出ない');
await shot('doc-search');
const secretIssue = core('POST', `/companies/${companyId}/issues`, { title: `Library E2E secret ${RUN}`, description: `deploy with ${SECRET} and DATABASE_URL=postgres://u:p@h/db`, status: 'todo' });
await tick();
const sh = await search(`secret ${RUN}`);
assert.ok(sh.some(x => x.srcId === `issue:${secretIssue.id}`), 'L2: 課題が検索に当たる');
assert.ok(!JSON.stringify(await search(RUN)).includes(SECRET), 'L2: 検索の結果に秘密が出ない');
assert.ok(!JSON.stringify(sh).includes('u:p@'), 'L2: URL の user:pass も出ない');
log('L2 ok');

// ---- L3: 2 社目の物は 1 社目の検索に出ない ----
const co2 = core('POST', '/companies', { name: `Library E2E Second Co ${RUN}` });
// 2 社目にしか無い語で探す（回の印だけだと 1 社目の物にも半分当たるため）
const ONLY2 = `mergerx${RUN}`;
const i2 = core('POST', `/companies/${co2.id}/issues`, { title: `Merger plan ${ONLY2}`, description: `confidential ${ONLY2}`, status: 'todo' });
await tick(co2.id); await tick();
assert.ok((await search(ONLY2, co2.id)).length >= 1, 'L3: 2 社目の中では当たる');
// 意味の近さの検索は 1 社目の中の近い記録（同じ回の印を持つ物）を返しうるので、2 社目の課題が無いことを id で、語の当たりが無いことを semanticOnly で確かめる
const r1 = await search(ONLY2);
const ids1 = JSON.stringify(r1.map(x => [x.srcId, x.semanticOnly ? 'sem' : 'word']));
assert.ok(!r1.some(x => String(x.srcId) === `issue:${i2.id}`), `L3: 1 社目の検索に 2 社目の課題は出ない ${ids1}`);
assert.equal(r1.filter(x => !x.semanticOnly).length, 0, `L3: 2 社目にしか無い語は 1 社目で語として当たらない ${ids1}`);
core('DELETE', `/companies/${co2.id}`); // 後の e2e（知らせ）が会社を 1 社と見るので、知らせの e2e と同じく片付ける
log('L3 ok');

// ---- L6（準備）: 点検の記録を入れる（L4 の添え書きの引き先にもなる）----
for (const r of EVAL.records) core('POST', `/companies/${companyId}/issues`, { title: `${r.title} ${RUN}`, description: r.text, status: 'done' });
await tick();

// ---- L4: AI の担当の課題に添え書きがちょうど 1 つ（その回の言語の見出し）・担当を起こさない ----
const agents = list(core('GET', `/companies/${companyId}/agents`));
const ai = agents.find(a => a.adapterType !== 'process' && a.status !== 'terminated');
assert.ok(ai, 'AI の担当がいる');
const briefIssue = core('POST', `/companies/${companyId}/issues`, { title: `Flyer print order again ${RUN}`, description: 'Order flyers on matte paper like last time', status: 'todo', assigneeAgentId: ai.id });
// 割り当てで本体が起こした実行が終わるのを待ち、その時の実行の数を基準にする
const runsOf = () => list(core('GET', `/issues/${briefIssue.id}/runs`));
let base = [];
for (let i = 0; i < 90; i++) { base = runsOf(); if (base.length && base.every(r => ['failed', 'succeeded', 'cancelled', 'timed_out'].includes(r.status))) break; await sleep(2000); }
await tick(); await tick();
const comments = list(core('GET', `/issues/${briefIssue.id}/comments`));
const briefs = comments.filter(c => String(c.body || '').includes(BRIEF_MARK));
assert.equal(briefs.length, 1, 'L4: 添え書きはちょうど 1 つ');
assert.ok(briefs[0].body.includes(LDICT[LANG].brief_heading), 'L4: 見出しはその回の言語');
assert.match(briefs[0].body, /Flyer print order/, 'L4: 近い記録（前の印刷の注文）が添えてある');
await sleep(3000);
assert.equal(runsOf().length, base.length, 'L4: 添え書きで担当の実行は増えない');
log(`L4 ok（実行の数 ${base.length} のまま）`);

// ---- L5: 添え書きの写しは所蔵に戻らない（こだま）----
const echo = await search(`${LDICT[LANG].brief_heading} ${RUN}`);
assert.ok(!echo.some(x => String(x.text).includes(BRIEF_MARK) || String(x.text).includes(LDICT[LANG].brief_heading)), 'L5: 添え書きの文が所蔵に無い');
log('L5 ok');

// ---- L6: 点検（上位 5 件に答えの言葉が入る割合が下限以上）----
let pass = 0;
for (const x of EVAL.questions) { const hits = (await search(`${x.q}`)).slice(0, 5); if (hits.some(h => `${h.title}\n${h.text}`.includes(x.a))) pass++; }
const rate = pass / EVAL.questions.length;
log(`L6 点検 ${pass}/${EVAL.questions.length}`);
assert.ok(rate >= EVAL.passRate, `L6: 合格の割合 ${rate} < ${EVAL.passRate}`);

// ---- L7: 意味の近さの検索（image の中の Ollama と bge-m3・範囲 2026-11-17 の保証 1〜3）----
// 裏の列が全部の行を埋め終わるのを待つ（1 行ずつ・普通の PC で 1 行 2〜4 秒）
let sem = null;
for (let i = 0; i < 180; i++) { sem = (await api('GET', `${LB}/status?${cq(companyId)}`)).semantic; if (sem?.ok && sem.backlog === 0) break; await sleep(5000); }
log('L7 semantic', JSON.stringify(sem));
assert.equal(sem?.ok, true, 'L7: 意味の検索が使える');
assert.equal(sem.backlog, 0, 'L7: 埋め終わっている');
const recWords = new Set(EVAL.records.flatMap(x => words(`${x.title} ${x.text}`)));
for (const x of EVAL.semantic.questions) {
  assert.deepEqual(words(x.q).filter(w => recWords.has(w)), [], `L7: 問い「${x.q}」と記録の語が交わらない`);
  const res = await searchFull(x.q);
  assert.equal(res.semantic, true, `L7: 返事が semantic === true（${res.semanticReason}）`);
  const hits = res.results.slice(0, 5);
  const h = hits.find(y => `${y.title}\n${y.text}`.includes(x.a));
  assert.ok(h, `L7: 「${x.q}」の上位 5 件に ${x.a} が入る（${JSON.stringify(hits.map(y => [y.title, y.cos]))}）`);
  assert.equal(h.semanticOnly, true, 'L7: 語では当たらず意味だけで当たった');
}
for (const q of EVAL.semantic.unrelated) {
  const hits = await search(q);
  assert.equal(hits.filter(y => y.semanticOnly).length, 0, `L7: 関係ない問い「${q}」に意味だけの当たりが無い（${JSON.stringify(hits.map(y => [y.title, y.cos]))}）`);
}
// 担当の user から model を消せない（置き場は読み取りだけ・範囲 作り方 2・独立レビュー P2-4）。消そうとした後も意味の検索が使える
const del = dockerSync(['exec', CONTAINER, 'node', '-e', "fetch('http://127.0.0.1:11434/api/delete',{method:'DELETE',body:JSON.stringify({model:'bge-m3'})}).then(r=>console.log(r.status))"], { encoding: 'utf8' }).trim();
assert.ok(Number(del) >= 400, `L7: /api/delete が断られる（${del}）`);
// 消す要求で Ollama が model を一度手放すと、次の問いは読み直しの間に時間切れで語の検索に戻ることがある（2026-11-20 自前の arm64 の機械・cancel task）。
// 守るのは「model が消えない」ことなので、時間切れの間は理由を出して待ち、60 秒の内に意味の検索に戻ることを確かめる（消えていれば戻らない）
let afterDel = null;
for (let i = 0; i < 12; i++) {
  afterDel = await searchFull(EVAL.semantic.questions[0].q);
  if (afterDel.semantic === true) break;
  if (afterDel.semanticReason !== 'timeout') break; // 待つのは時間切れの時だけ（ほかの理由は待たずに落とす）
  log(`L7 消そうとした後の問い ${i + 1} 回目: semantic=${afterDel.semantic}（${afterDel.semanticReason}）`);
  await sleep(5000);
}
assert.equal(afterDel.semantic, true, `L7: 消そうとした後も意味の検索が使える（${afterDel.semanticReason}）`);
log('L7 ok');

// ---- L8: 文書をまとめて置き、列が動いている間の問いの p95 と、見回りの口・本体の health の秒数を測る（範囲 2026-11-17 の保証 8b）----
const filler = i => Array.from({ length: 5 }, (_, j) => `Section ${j} of note ${i} ${RUN}. ` + 'Meeting notes about seasonal menus, staff shifts, supplier calls and shop cleaning routines. '.repeat(10)).join('\n\n');
for (let i = 0; i < 12; i++) await api('POST', `${LB}/documents?${cq(companyId)}`, { name: `bulk-${RUN}-${i}.md`, text: filler(i) });
const qt = []; let healthMax = 0, tickMax = 0, busySeen = 0;
for (let i = 0; i < 20; i++) {
  const st = (await api('GET', `${LB}/status?${cq(companyId)}`)).semantic; if (st.backlog > 0) busySeen++;
  let t = Date.now(); await searchFull(EVAL.semantic.questions[i % EVAL.semantic.questions.length].q); qt.push(Date.now() - t);
  t = Date.now(); core('GET', '/health'); healthMax = Math.max(healthMax, Date.now() - t);
  if (i % 5 === 0) { t = Date.now(); await tick(); tickMax = Math.max(tickMax, Date.now() - t); }
  await sleep(700);
}
const p95 = [...qt].sort((a, b) => a - b)[Math.min(qt.length - 1, Math.floor(0.95 * qt.length))];
const line = `L8 列が動いている間（${busySeen}/20 回）の問いの p95 ${p95}ms・最大 ${Math.max(...qt)}ms・health の最大 ${healthMax}ms・見回りの口の最大 ${tickMax}ms（線: 問いの p95 3000ms・口と health 30000ms）`;
log(line);
if (process.env.GITHUB_STEP_SUMMARY) fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, `- library e2e (${LANG}): ${line}\n`);
assert.ok(busySeen >= 1, 'L8: 列が動いている間に測った');
assert.ok(healthMax < 30000 && tickMax < 30000, 'L8: 見回りの口と本体の health が 30 秒の内に返る');
if (p95 > 3000) log(`L8 注意: 問いの p95 が提案の線 3000ms を超えた（${p95}ms）。持ち主に実測と一緒に戻す`);
for (let i = 0; i < 12; i++) await api('POST', `${LB}/documents/remove?${cq(companyId)}`, { name: `bulk-${RUN}-${i}.md` });
log('L8 ok');

// 画面の部屋に置いた文書を外す（後片付け・外す button の確かめ）
await page.goto(`${BASE}/${prefix}/office`);
await page.click('[data-room="library"]');
await page.click(`[data-library-remove="${docName}"]`);
await page.waitForSelector(`[data-library-doc="${docName}"]`, { state: 'detached' });
assert.ok(!(await search(`navy ${RUN}`)).some(x => x.srcId === `doc:${docName}`), '外した文書は検索に出ない（回の印だけで他の物に半分当たるので、その文書の当たりが無いことを見る）');
await shot('removed');
assert.deepEqual(errors, [], 'ページの誤り');
await browser.close();
log('all ok');
