// 知らせの plugin を、wizard の後の package で通す（範囲の文書の保証 21 の N1〜N6・G3）。office の e2e の後に流す
// 使い方: AIO_BASE=http://localhost:3100 AIO_LANG=en AIO_CONTAINER=aioffice AIO_SHOTS=<撮る先> node test/e2e/notify.e2e.mjs
//   PLAYWRIGHT_MODULE・PW_EXE は wizard の e2e と同じ。時計は動かさない（8 時と 18 時の境は unit で確かめる）
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { DICT } from '../../plugins/office/src/i18n.mjs';
import { localParts, noticeKey } from '../../plugins/notify/src/lib.mjs';
import { dockerSync } from './docker.mjs';
import { deleteCompany } from './company-delete.mjs';
import { makeNotifyTick } from './notify-tick.mjs';
const RUN = Date.now().toString(36); // 回ごとの印（前の回の物と取り違えない）

const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || 'playwright');
const BASE = process.env.AIO_BASE || 'http://localhost:3100';
const LANG = process.env.AIO_LANG === 'ja' ? 'ja' : 'en';
const CONTAINER = process.env.AIO_CONTAINER || 'aioffice';
const OUT = process.env.AIO_SHOTS || '';
const PASS = process.env.AIO_PASS || 'e2e-owner-password', EMAIL = process.env.AIO_OWNER_EMAIL || 'owner@example.test';
const D = DICT[LANG];
const sleep = ms => new Promise(r => setTimeout(r, ms));
const log = (...a) => console.log('[notify e2e]', ...a);

// container の中から本体（127.0.0.1:3101）に直に頼む（2 社目を作る・plugin を止めるなど、持ち主の画面に無い準備だけ）
function coreRaw(method, p, body) {
  const js = `const K=await(async()=>{try{const f=await import('node:fs');return 'Bearer '+JSON.parse(f.readFileSync('/data/aioffice/board-key.json','utf8')).token}catch{return null}})();const r=await fetch('http://127.0.0.1:3101/api'+process.argv[1],{method:process.argv[2],headers:{'content-type':'application/json',...(K?{authorization:K}:{})},body:process.argv[3]||undefined});const t=await r.text();console.log(JSON.stringify({s:r.status,t}))`;
  const out = dockerSync(['exec', CONTAINER, 'node', '--input-type=module', '-e', js, p, method, body ? JSON.stringify(body) : ''], { encoding: 'utf8', timeout: 60000 });
  const { s, t } = JSON.parse(out.trim().split('\n').pop());
  let j = null; try { j = JSON.parse(t); } catch { j = null; }
  return { status: s, text: t, json: j };
}
function core(method, p, body) { const { status: s, text: t, json: j } = coreRaw(method, p, body); if (s >= 400) throw new Error(`${method} ${p} → ${s} ${t.slice(0, 200)}`); return j; }
// plugin の CLI にも起動係の鍵を渡す（container の中で file から読み、引数には出さない）
const cli = args => dockerSync(['exec', CONTAINER, 'sh', '-c', 'PAPERCLIP_API_KEY=$(node -p "JSON.parse(require(\'fs\').readFileSync(\'/data/aioffice/board-key.json\',\'utf8\')).token") exec paperclipai plugin "$@"', 'sh', ...args, '--api-base', 'http://127.0.0.1:3101', '--json', '-d', '/data/paperclip'], { encoding: 'utf8', timeout: 120000 });
// 本体の DB の「トランザクションの途中」の接続の数（実測 23）。値は出さない
const IDLE_TX = `import{readFileSync}from'node:fs';import{createRequire}from'node:module';const r=createRequire('/opt/aioffice/runtime/node_modules/');const pg=r('pg');const c=JSON.parse(readFileSync('/data/paperclip/instances/default/config.json','utf8'));const k=new pg.Client({host:'127.0.0.1',port:c.database?.embeddedPostgresPort||54329,user:'paperclip',password:c.database?.embeddedPostgresPassword||'paperclip',database:'paperclip'});await k.connect();const x=await k.query("select count(*)::int n from pg_stat_activity where state='idle in transaction'");console.log(x.rows[0].n);await k.end()`;
const idleInTx = () => Number(dockerSync(['exec', CONTAINER, 'node', '--input-type=module', '-e', IDLE_TX], { encoding: 'utf8', timeout: 60000 }).trim());

if (OUT) fs.mkdirSync(OUT, { recursive: true });
const browser = await chromium.launch(process.env.PW_EXE ? { executablePath: process.env.PW_EXE } : {});
const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, locale: LANG === 'ja' ? 'ja-JP' : 'en-US' });
const page = await ctx.newPage();
const errors = []; page.on('pageerror', e => errors.push(String(e)));
let n = 0;
const shot = async name => { if (OUT) await page.screenshot({ path: path.join(OUT, `${LANG}_notify_${String(++n).padStart(2, '0')}-${name}.png`) }); };

// 起動係の state を読む。待ちの間に server が閉じた keep-alive の接続を使い回すと socket hang up になるので、通信の誤りの時だけ読み直す
const getState = async () => { for (let i = 0; ; i++) { try { return await (await ctx.request.get(`${BASE}/setup/api/state`)).json(); } catch (e) { if (i >= 2 || !/socket hang up|ECONNRESET/.test(String(e))) throw e; await sleep(500); } } };
const login = await ctx.request.post(`${BASE}/api/auth/sign-in/email`, { data: { email: EMAIL, password: PASS }, headers: { origin: BASE } });
assert.equal(login.status(), 200, 'ログイン');
const state0 = await getState();
const companyId = state0.company.id, prefix = state0.company.prefix;
const NB = `${BASE}/api/plugins/aioffice.notify/api`;
const q = `companyId=${encodeURIComponent(companyId)}`;
const api = async (method, url, data) => {
  const r = await ctx.request.fetch(url, { method, data, headers: { origin: BASE, 'content-type': 'application/json' }, timeout: 60000 });
  const j = await r.json().catch(() => null);
  assert.ok(r.ok(), `${method} ${url} → ${r.status()} ${JSON.stringify(j).slice(0, 200)}`);
  return j;
};
// 起動係と同じ形で見回りの口を呼ぶ（言語と時刻帯は起動係の state から）
const tick = makeNotifyTick({ ctx, BASE, NB, getState, defaultCompanyId: () => companyId });
const notices = async (cid = companyId) => (await api('GET', `${NB}/notices?companyId=${encodeURIComponent(cid)}`)).notices;
const kinds = list => list.map(x => x.kind);

// 保証 1: 起動係が知らせの plugin を入れて ready にした
const plugins = JSON.parse(dockerSync(['exec', CONTAINER, 'cat', '/data/aioffice/plugins.json'], { encoding: 'utf8' }));
assert.equal(plugins['aioffice.notify']?.status, 'ready', '知らせの plugin が ready');

// ---- N5（前半）: 時刻帯。今が 8〜23 時になる時刻帯を選んで起動係に記録する（時計は動かさない）----
const now = Date.now();
const tz = ['Asia/Tokyo', 'Europe/London', 'America/New_York', 'Pacific/Auckland', 'America/Los_Angeles', 'Asia/Kolkata', 'Etc/GMT+10'].find(z => { const h = localParts(now, z).hour; return h >= 8 && h <= 22; });
assert.ok(tz, '8〜22 時の時刻帯が見つかる');
await api('POST', `${BASE}/setup/api/lang`, { lang: LANG, timeZone: tz });
const state1 = await getState();
assert.equal(state1.timeZone, tz, '起動係の state に時刻帯');

// ---- N1: 承認（1 社目に出て、2 社目には出ない。承認すると消える）と判断のカード ----
const before = await notices();
const ap = core('POST', `/companies/${companyId}/approvals`, { type: 'request_board_approval', payload: { title: 'Notify E2E approval' } });
const co2 = core('POST', '/companies', { name: 'Notify E2E Second Co' });
const ap2 = core('POST', `/companies/${co2.id}/approvals`, { type: 'request_board_approval', payload: { title: 'Second company approval' } });
const cardIssue = core('POST', `/companies/${companyId}/issues`, { title: `Notify E2E decision card ${RUN}`, status: 'todo' });
const card = core('POST', `/issues/${cardIssue.id}/interactions`, { kind: 'request_confirmation', title: 'Notify E2E confirm', payload: { version: 1, prompt: 'Go ahead?' } });
const r1 = await tick();
assert.equal(r1.v, 1); assert.equal(r1.settings.timeZone, tz);
let list = await notices();
assert.ok(list.some(x => x.kind === 'approval' && x.originId === ap.id), 'N1: 承認が 1 件出る');
assert.ok(!list.some(x => x.originId === ap2.id), 'N1: 2 社目の承認は出ない');
assert.ok(list.some(x => x.key === noticeKey('decision', card.id)), 'N1: このカードの判断待ちが 1 件出る');
await tick(co2.id);
assert.ok(!(await notices(co2.id)).some(x => x.originId === ap.id), 'N1: 1 社目の承認は 2 社目に出ない');
// 2 社目は N1 だけで使う。後ろの CI の手順は会社が 1 社であることを確かめるので消す（独立レビュー P1-2）
deleteCompany(coreRaw, co2.id);
assert.deepEqual(core('GET', '/companies').map(c => c.id), [companyId], '会社は 1 社に戻る');

// 画面: 帯に件数が出て、押すと受信箱の「知らせ」の欄へ
await page.goto(`${BASE}/${prefix}/office`);
await page.waitForSelector('[data-banner="waiting"]', { timeout: 60000 });
await shot('banner');
await page.click('[data-banner="waiting"]');
// 承認は「承認」の欄に出て、知らせの欄には出さない（二重にしない）。知らせの欄には判断待ちが出る
await page.waitForSelector(`[data-approval="${ap.id}"]`, { timeout: 30000 });
await page.waitForSelector('[data-notice="decision"]', { timeout: 30000 });
assert.equal((await page.$('[data-notice="approval"]')) === null, true, '承認の知らせは知らせの欄に出ない');
assert.ok((await page.textContent('[data-panel]')).includes(D.inbox_notices), '受信箱に知らせの欄');
await shot('inbox-notices');

core('POST', `/approvals/${ap.id}/approve`, {});
core('POST', `/issues/${cardIssue.id}/interactions/${card.id}/accept`, {});
await tick();
list = await notices();
assert.ok(!list.some(x => x.kind === 'approval' && x.originId === ap.id), 'N1: 承認すると消える');
assert.ok(!list.some(x => x.key === noticeKey('decision', card.id)), 'N1: 答えると消える');
log('N1 ok');

// ---- N2: 担当の実行が失敗すると「失敗」が出る（AI の契約が無いので失敗で残る）----
const agents = core('GET', `/companies/${companyId}/agents`);
const failIssue = core('POST', `/companies/${companyId}/issues`, { title: `Notify E2E run failure ${RUN}`, status: 'todo', assigneeAgentId: agents[0].id });
let failedRuns = [];
for (let i = 0; i < 90 && !failedRuns.length; i++) { const runs = core('GET', `/issues/${failIssue.id}/runs`); failedRuns = (Array.isArray(runs) ? runs : runs.items || []).filter(r => r.status === 'failed').map(r => r.id ?? r.runId); if (!failedRuns.length) await sleep(2000); }
assert.ok(failedRuns.length, 'N2: 実行が失敗で残る');
let mine = false;
for (let i = 0; i < 10 && !mine; i++) { await sleep(1000); await tick(); mine = (await notices()).some(x => x.kind === 'run_failed' && failedRuns.includes(x.originId)); }
assert.ok(mine, 'N2: この課題の実行の失敗の知らせが出る（前の e2e の失敗では通さない）');
log('N2 ok');

// ---- N3: 止まった課題（境を 1 分にする）----
core('POST', '/plugins/aioffice.notify/config', { companyId, configJson: { stuckIdleMin: 1 } });
// 本体は担当の無い in_progress を断る（422）。担当つきの todo で作り、実行が失敗した後に in_progress に戻す
const stuck = core('POST', `/companies/${companyId}/issues`, { title: `Notify E2E stuck ${RUN}`, status: 'todo', assigneeAgentId: agents[0].id });
for (let i = 0; i < 60; i++) { const runs = core('GET', `/issues/${stuck.id}/runs`); if ((Array.isArray(runs) ? runs : runs.items || []).some(r => r.status === 'failed')) break; await sleep(2000); }
core('PATCH', `/issues/${stuck.id}`, { status: 'in_progress' });
await sleep(65000);
const cur = core('GET', `/issues/${stuck.id}`);
await tick();
list = await notices();
const stuckNotice = list.find(x => x.kind === 'stuck' && x.originId === stuck.id);
if (cur.status === 'in_progress' && !cur.executionRunId) {
  assert.ok(stuckNotice, 'N3: 止まった課題が出る');
  await api('POST', `${NB}/notices/read?${q}`, { key: stuckNotice.key });
  assert.ok((await notices()).find(x => x.key === stuckNotice.key).readAt, 'N3: 読みましたで既読');
  log('N3 ok（止まった課題が出て既読にできた）');
} else {
  // 本体が課題を blocked に戻した・実行が付いている（実測 26）: 誤って出ないことだけを確かめる（受け入れる限界）
  assert.ok(!stuckNotice, `N3: ${cur.status} の課題は止まった課題に出ない`);
  log(`N3 ok（課題は ${cur.status}・誤って出ないことを確かめた）`);
}

// ---- N4・N5: まとめは今の回の 1 通だけ・2 回呼んでも増えない・時刻帯は起動係と同じ ----
const settings = (await api('GET', `${NB}/settings?${q}`)).settings;
assert.equal(settings.timeZone, tz, 'N5: plugin の時刻帯が起動係の state と同じ');
assert.equal(settings.lang, LANG);
const slot = localParts(Date.now(), tz);
const slotKey = `${slot.date}:${slot.hour >= 18 ? 'pm' : 'am'}`;
await tick(); await tick();
const digests = (await notices()).filter(x => x.kind === 'digest' && x.originId === slotKey);
assert.equal(digests.length, 1, 'N4・N5: 今の回のまとめが 1 通だけ');
log('N4・N5 ok', slotKey, digests[0].title);
await page.goto(`${BASE}/${prefix}/office`);
await page.click('[data-banner="waiting"]');
await page.waitForSelector('[data-notice="digest"]', { timeout: 30000 });
await shot('digest');

// ---- G3: 起動係ごしに課題 25 件を並べて作り、それぞれに comment を 6 件ずつ付けても本体が止まらない ----
const t0 = Date.now();
await Promise.all(Array.from({ length: 25 }, async (_, i) => {
  const is = await api('POST', `${BASE}/api/companies/${companyId}/issues`, { title: `G3 load ${i}`, status: 'todo' });
  for (let c = 0; c < 6; c++) await api('POST', `${BASE}/api/issues/${is.id}/comments`, { body: `G3 comment ${c}` });
}));
log(`G3: 25 件 × 6 comment を ${Date.now() - t0} ms`);
const health = await ctx.request.get(`${BASE}/api/health`);
assert.equal(health.status(), 200, 'G3: 本体の health が 200');
let idle = idleInTx();
for (let i = 0; i < 10 && idle > 0; i++) { await sleep(1000); idle = idleInTx(); }
assert.equal(idle, 0, 'G3: トランザクションの途中の接続が残らない');
const tg = Date.now(); await tick(); log(`G3: 見回り 1 回 ${Date.now() - tg} ms`);

// ---- N6: plugin を止めると、次の見回りの後に起動係の状態の画面と office の帯に遅れが出る ----
cli(['disable', 'aioffice.notify']);
let late = false;
for (let i = 0; i < 80 && !late; i++) { // 起動係の見回りは 5 分ごと（毎分の確かめ）。最大 8 分待つ
  const s = await getState();
  const r = s.rounds?.['aioffice.notify'];
  late = !!(r && (r.late || r.lastError));
  if (!late) await sleep(6000);
}
assert.ok(late, 'N6: 起動係の state に遅れか失敗');
await page.goto(`${BASE}/${prefix}/office`);
await page.waitForSelector('[data-banner="rounds_late"]', { timeout: 60000 });
assert.ok((await page.textContent('[data-banner="rounds_late"]')).includes(D.banner_rounds_late));
await shot('rounds-late');
await page.goto(`${BASE}/setup/`);
await page.waitForSelector('#rounds-late', { timeout: 60000 });
await shot('launcher-rounds-late');
cli(['enable', 'aioffice.notify']);
log('N6 ok');

assert.deepEqual(errors, [], '画面の JavaScript の誤り');
await browser.close();
log('all ok');
