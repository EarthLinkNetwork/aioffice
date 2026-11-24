// Slack への届けを、wizard の後の package で偽の受け口に向けて通す（範囲 docs/review/2026-11-18-slack-notify-scope.md「確かめ方」の e2e 1〜12・P1）。
// 知らせ・図書室の e2e の後に流す。container は CI の Slack の段で、試験の網（198.18.0.0/24）・--add-host hooks.slack.com・試験用の CA を付けて起こし直してある
// （配る起動の行には入れない。CI の grep の段と unit が確かめる）。
// 使い方: AIO_BASE=http://localhost:3100 AIO_LANG=en AIO_CONTAINER=aioffice AIO_SHOTS=<撮る先> AIO_SLACK_FAKE=http://127.0.0.1:3199 AIO_SLACK_STATE=<json の置き場> node test/e2e/slack.e2e.mjs
//   AIO_SLACK_PHASE=after-reinstall: 入れ直しの後の確かめ（12）だけを流す。PLAYWRIGHT_MODULE・PW_EXE は wizard の e2e と同じ
// 時計は動かさない。まとめは時刻帯を替えて新しい回を作り、見回りの口を手で呼んで作る。見回りと送りの口は試験から手で呼ぶ
// 同時に存在するまとめの回は時刻帯 UTC-12〜+14 で最大 4 つ（少ない時刻は 3 つ）。1 社で使う回は 2 つまでにし、ほかの確かめは承認待ちで起こす
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFileSync, spawnSync } from 'node:child_process';
import { DICT } from '../../plugins/office/src/i18n.mjs';
import { digestSlot } from '../../plugins/notify/src/lib.mjs';
import { dockerSync } from './docker.mjs';
import { deleteCompany } from './company-delete.mjs';
import { makeNotifyTick } from './notify-tick.mjs';

const BASE = process.env.AIO_BASE || 'http://localhost:3100';
const LANG = process.env.AIO_LANG === 'ja' ? 'ja' : 'en';
const CONTAINER = process.env.AIO_CONTAINER || 'aioffice';
const OUT = process.env.AIO_SHOTS || '';
const PASS = process.env.AIO_PASS || 'e2e-owner-password', EMAIL = process.env.AIO_OWNER_EMAIL || 'owner@example.test';
const FAKE = process.env.AIO_SLACK_FAKE || 'http://127.0.0.1:3199';
const STATE_FILE = process.env.AIO_SLACK_STATE || '';
const PHASE = process.env.AIO_SLACK_PHASE || 'main';
const D = DICT[LANG];
const RUN = Date.now().toString(36);
const sleep = ms => new Promise(r => setTimeout(r, ms));
let lastStep = 'start'; // メモリの見張りが出す「直前の段」
const log = (...a) => { lastStep = String(a[0]).slice(0, 40); console.log('[slack e2e]', ...a); };
const SHOT_DAY = '2026-11-18';

// 偽の token（試験ごとに作る。数えるのはこの文字）
const part = () => crypto.randomBytes(9).toString('hex').toUpperCase();
const mkTok = () => `T${part()}/B${part()}/${crypto.randomBytes(12).toString('hex')}`;
const urlOf = tok => `https://hooks.slack.com/services/${tok}`;
const pathOf = tok => `/services/${tok}`;

// container の中から本体（127.0.0.1:3101）に直に頼む（担当と同じ道: Authorization なし）。raw は status を返し、投げない
function coreRaw(method, p, body) {
  const js = `const K=await(async()=>{try{const f=await import('node:fs');return 'Bearer '+JSON.parse(f.readFileSync('/data/aioffice/board-key.json','utf8')).token}catch{return null}})();const r=await fetch('http://127.0.0.1:3101/api'+process.argv[1],{method:process.argv[2],headers:{'content-type':'application/json',...(K?{authorization:K}:{})},body:process.argv[3]||undefined});const t=await r.text();console.log(JSON.stringify({s:r.status,t}))`;
  const out = dockerSync(['exec', CONTAINER, 'node', '--input-type=module', '-e', js, p, method, body ? JSON.stringify(body) : ''], { encoding: 'utf8', timeout: 60000 });
  const { s, t } = JSON.parse(out.trim().split('\n').pop());
  let j = null; try { j = JSON.parse(t); } catch { j = null; }
  return { status: s, json: j, text: t };
}
function core(method, p, body) { const r = coreRaw(method, p, body); if (r.status >= 400) throw new Error(`${method} ${p} → ${r.status} ${r.text.slice(0, 200)}`); return r.json; }
const sh = (args, opts = {}) => dockerSync(args, { encoding: 'utf8', timeout: 120000, maxBuffer: 256 * 1024 * 1024, ...opts });
// 偽の受け口の操作の口
const fake = {
  got: async tok => (await (await fetch(`${FAKE}/got?path=${encodeURIComponent(pathOf(tok))}`)).json()),
  all: async () => (await (await fetch(`${FAKE}/got`)).json()),
  mode: async m => { await fetch(`${FAKE}/mode`, { method: 'POST', body: JSON.stringify(m) }); },
  reset: async () => { await fetch(`${FAKE}/reset`, { method: 'POST' }); },
};

const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || 'playwright');
if (OUT) fs.mkdirSync(OUT, { recursive: true });
const browser = await chromium.launch(process.env.PW_EXE ? { executablePath: process.env.PW_EXE } : {});
const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, locale: LANG === 'ja' ? 'ja-JP' : 'en-US' });
const page = await ctx.newPage();
const errors = []; page.on('pageerror', e => errors.push(String(e)));
// office と起動係の口の返事を全部覚える（11: URL の文字が返事に出ないことを数える）
const bodies = [];
// メモリの見張り: この試験の process が 6 番の前後で 12GB まで膨らみ kernel に止められた（2026-11-21 amd64・2026-11-22 arm64）。
// 2GB を超えたら 5 秒ごとに、どこが膨らんでいるか（heap・external・arrayBuffers）と貯めた返事の数と長さ・直前の段を 1 行出す
const memTimer = setInterval(() => {
  const m = process.memoryUsage(); if (m.rss < 2 * 1024 ** 3) return;
  const mb = v => Math.round(v / 1024 ** 2);
  let chars = 0; for (const b of bodies) chars += b ? b.length : 0;
  console.log('[slack e2e] mem', JSON.stringify({ after: lastStep, rss: mb(m.rss), heapUsed: mb(m.heapUsed), external: mb(m.external), arrayBuffers: mb(m.arrayBuffers), bodies: bodies.length, bodiesMB: mb(chars * 2) }));
}, 5000);
memTimer.unref();
page.on('response', async r => { if (/\/setup\/api\/|\/api\/plugins\/aioffice\.notify\//.test(r.url())) { try { bodies.push(await r.text()); } catch { /* 本文なし */ } } });
let shotN = 0;
const shot = async name => { if (OUT) await page.screenshot({ path: path.join(OUT, `${SHOT_DAY}_${LANG}_slack-${String(++shotN).padStart(2, '0')}-${name}.png`), fullPage: false }); };

const getState = async () => { for (let i = 0; ; i++) { try { return await (await ctx.request.get(`${BASE}/setup/api/state`)).json(); } catch (e) { if (i >= 2 || !/socket hang up|ECONNRESET/.test(String(e))) throw e; await sleep(500); } } };
assert.equal((await ctx.request.post(`${BASE}/api/auth/sign-in/email`, { data: { email: EMAIL, password: PASS }, headers: { origin: BASE } })).status(), 200, 'ログイン');
const state0 = await getState();
const companyId = state0.company.id, prefix = state0.company.prefix;
const NB = `${BASE}/api/plugins/aioffice.notify/api`;
const apiRaw = async (method, url, data) => { const r = await ctx.request.fetch(url, { method, data, headers: { origin: BASE, 'content-type': 'application/json' }, timeout: 60000 }); const j = await r.json().catch(() => null); bodies.push(JSON.stringify(j)); return { status: r.status(), json: j }; };
const api = async (method, url, data) => { const r = await apiRaw(method, url, data); assert.ok(r.status < 400, `${method} ${url} → ${r.status} ${JSON.stringify(r.json).slice(0, 200)}`); return r.json; };
const tick = makeNotifyTick({ ctx, BASE, NB, getState, defaultCompanyId: () => companyId });
const deliver = async (cid = companyId) => api('POST', `${NB}/deliver?companyId=${encodeURIComponent(cid)}`, {});
const status = async (cid = companyId) => api('GET', `${NB}/slack?companyId=${encodeURIComponent(cid)}`);
const notices = async (cid = companyId) => (await api('GET', `${NB}/notices?companyId=${encodeURIComponent(cid)}`)).notices;
const roundTrip = async (n = 3, cid = companyId) => { for (let i = 0; i < n; i++) { await tick(cid); await deliver(cid); } };
// 新しいまとめを 1 つ作る: 今が 8〜23 時で、まだ使っていない回になる時刻帯を起動係に記録し、見回りの口を呼ぶ
async function newDigest(cids = [companyId]) {
  const used = new Set(); for (const c of cids) for (const n of await notices(c)) if (n.kind === 'digest') used.add(n.originId);
  const zones = [...Array.from({ length: 14 }, (_, i) => `Etc/GMT-${i + 1}`), 'Etc/UTC', ...Array.from({ length: 12 }, (_, i) => `Etc/GMT+${i + 1}`)];
  const tz = zones.find(z => { const s = digestSlot(Date.now(), z); return s && !used.has(s.key); });
  assert.ok(tz, 'まだ使っていないまとめの回の時刻帯がある');
  await api('POST', `${BASE}/setup/api/lang`, { lang: LANG, timeZone: tz });
  for (const c of cids) await tick(c);
  return digestSlot(Date.now(), tz).key;
}
const approval = (title, cid = companyId) => core('POST', `/companies/${cid}/approvals`, { type: 'request_board_approval', payload: { title } });
// 持ち主の画面
async function openSlack() {
  await page.goto(`${BASE}/${prefix}/office`);
  await page.click('[data-open="inbox"]');
  await page.waitForSelector('[data-slack]:not([data-slack="loading"])', { timeout: 60000 });
  await page.locator('#aio-slack').scrollIntoViewIfNeeded();
}
const slackMsg = async () => page.getAttribute('[data-slack-msg]', 'data-slack-msg', { timeout: 30000 });
async function ownerPreviewAndOn({ kinds = ['digest', 'approval'], form = 'titles', expect = 'slack_on_done' } = {}) {
  await openSlack();
  for (const k of ['digest', 'approval', 'decision', 'run_failing', 'stuck']) { const box = page.locator(`[data-slack-kind="${k}"]`); if ((await box.isChecked()) !== kinds.includes(k)) await box.click(); }
  await page.selectOption('[data-slack-form]', form);
  await page.click('[data-slack-preview]');
  await page.waitForSelector('[data-slack-sample]', { timeout: 30000 });
  await page.click('[data-slack-on]');
  await page.waitForSelector('[data-slack-msg]', { timeout: 30000 });
  assert.equal(await slackMsg(), expect);
}
async function ownerSave(url) {
  await openSlack();
  await page.fill('[data-slack-url]', url);
  await page.click('[data-slack-save]');
  await page.waitForSelector('[data-slack-msg="slack_saved"]', { timeout: 30000 });
}
const notifyCfg = cid => core('GET', `/plugins/aioffice.notify/config?companyId=${encodeURIComponent(cid)}`)?.configJson || {};
async function offAndRemove() {
  await api('POST', `${NB}/slack/off?companyId=${encodeURIComponent(companyId)}`, {});
  await api('POST', `${BASE}/setup/api/slack`, { companyId, remove: true });
  const s = await status(); assert.equal(s.on, false); assert.equal(s.configured, false, '宛先を消した');
}
const saveState = o => { if (STATE_FILE) fs.writeFileSync(STATE_FILE, JSON.stringify(o)); };
const loadState = () => JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));

if (PHASE === 'after-reinstall') {
  // ---- 12: 入れ直しの後、ON の状態・送りの記録・止まった状態が残り、既に送った知らせを 2 回目に送らない ----
  const S = loadState();
  const plugins = JSON.parse(sh(['exec', CONTAINER, 'cat', '/data/aioffice/plugins.json']));
  assert.equal(plugins['aioffice.notify']?.status, 'ready', '入れ直した知らせの plugin が ready');
  const st = await status();
  assert.equal(st.on, true, '12: ON が残る'); assert.equal(st.lastOkAt, S.lastOkAt, '12: 最後に届いた時刻が残る');
  const before = (await fake.got(S.tokA)).length;
  await roundTrip(2);
  assert.equal((await fake.got(S.tokA)).length, before, '12: 送った知らせを 2 回目に送らない');
  approval(`Slack E2E after reinstall ${RUN}`); await tick(); await deliver();
  assert.equal((await fake.got(S.tokA)).length, before + 1, '12: 入れ直しの後も新しい知らせは届く');
  log('12 ok');
  await offAndRemove();
  await browser.close();
  process.exit(0);
}

const tokA = mkTok(), tokA2 = mkTok(), tokX = mkTok(), tokB = mkTok(), tokY = mkTok(), tokC = mkTok();
const ALL_TOKS = [tokA, tokA2, tokX, tokB, tokY, tokC];
await fake.reset();

// ---- P1: 偽の受け口に container から届く（名前・CA・網）。本体の http.fetch からの到達は 5 の試しの 1 通で確かめる ----
const p1 = sh(['exec', CONTAINER, 'node', '-e', `fetch('https://hooks.slack.com/services/P1/P1/p1',{method:'POST',body:'{}'}).then(r=>console.log(r.status),e=>console.log('ERR',e.cause?.code||e.message))`]).trim();
assert.equal(p1, '200', `P1: container から偽の受け口に届く（${p1}）`);
await fake.reset();

// ---- 1: 宛先を入れる前: 承認・判断のカード・まとめを作り、見回りと送りを 3 回 → 0 件 ----
approval(`Slack E2E before dest ${RUN}`);
const cardIssue = core('POST', `/companies/${companyId}/issues`, { title: `Slack E2E card ${RUN}`, status: 'todo' });
core('POST', `/issues/${cardIssue.id}/interactions`, { kind: 'request_confirmation', title: 'Slack E2E confirm', payload: { version: 1, prompt: 'Go ahead?' } });
await roundTrip(3);
assert.equal((await fake.all()).length, 0, '1: 宛先の前は 0 件');
const s1 = await status(); assert.equal(s1.on, false); assert.equal(s1.configured, false);
await openSlack(); await shot('empty');
// AI の連携の欄（docs/review/2026-11-22-notify-via-ai-connectors-scope.md 作り方 2）: 会社向けの道（Slack）の上に出て、気をつけることを書く。
// 状態の語は container の ChatGPT のつなぎ方で変わるので、決まった語のどれかであることだけを見る
await page.waitForSelector('[data-connectors]:not([data-connectors="loading"])', { timeout: 60000 });
const connState = await page.getAttribute('[data-connectors]', 'data-connectors');
assert.ok(['ok', 'not_connected', 'busy', 'error'].includes(connState), `1: 連携の欄の状態 ${connState}`);
assert.ok(await page.$('[data-connectors-risk]'), '1: 連携の欄に気をつけること');
assert.ok(await page.evaluate(() => { const c = document.getElementById('aio-connectors'), s = document.getElementById('aio-slack'); return !!(c && s && (c.compareDocumentPosition(s) & Node.DOCUMENT_POSITION_FOLLOWING)); }), '1: 連携の欄は Slack の欄の上');
log(`1: 連携の欄 ${connState}`);
await page.locator('#aio-connectors').scrollIntoViewIfNeeded(); await shot('connectors');
log('1 ok');

// ---- 2: 宛先を保存したが ON にしない → 0 件。伏せた宛先が出て、URL の文字が画面のどこにも無い ----
await ownerSave(urlOf(tokA));
await page.waitForSelector('[data-slack-dest="saved"]', { timeout: 30000 });
const html2 = await page.content();
const inputs2 = await page.$$eval('input', els => els.map(e => e.value));
for (const p of tokA.split('/')) { assert.ok(!html2.includes(p), '2: 画面の HTML に URL の段が無い'); assert.ok(!inputs2.some(v => v.includes(p)), '2: 入力の欄の値に URL の段が無い'); }
assert.ok(html2.includes(D.slack_masked));
await shot('saved');
approval(`Slack E2E saved not on ${RUN}`); await roundTrip(3);
assert.equal((await fake.all()).length, 0, '2: ON の前は 0 件');
assert.equal((await status()).configured, true);
log('2 ok');

// ---- 3: 見本 → 撮る。種類を変えた後に古い見本のまま ON を押すと断られる ----
await openSlack();
await page.locator('[data-slack-kind="approval"]').check();
await page.click('[data-slack-preview]');
await page.waitForSelector('[data-slack-sample-msg="digest"]', { timeout: 30000 });
await page.waitForSelector('[data-slack-sample-button]');
await shot('preview');
await page.selectOption('[data-slack-form]', 'counts');
await page.click('[data-slack-on]');
await page.waitForSelector('[data-slack-msg="slack_e_slack_preview_stale"]', { timeout: 30000 });
assert.equal((await status()).on, false, '3: 古い見本では ON にならない');
log('3 ok');

// ---- 3b: 担当の道（Authorization なしで本体の口）から confirm → 403。見本の前に本体の口で秘密の値・参照を替える → 持ち主が ON を押しても 409 ----
const pvA = await api('GET', `${BASE}/setup/api/slack/preview?companyId=${companyId}&kinds=digest&form=titles`);
const agentConfirm = body => coreRaw('POST', `/plugins/aioffice.notify/api/slack/confirm?companyId=${companyId}`, { kinds: ['digest'], form: 'titles', previewHash: pvA.hash, lang: LANG, officeUrl: `${BASE}/${prefix}/office`, ...body });
assert.equal(agentConfirm({}).status, 403, '3b: nonce なし');
assert.equal(agentConfirm({ nonce: crypto.randomBytes(32).toString('hex') }).status, 403, '3b: 作っていない nonce');
assert.equal((await status()).on, false);
const secretIdA = notifyCfg(companyId).slack.webhook.secretId;
core('POST', `/secrets/${secretIdA}/rotate`, { value: urlOf(tokX) }); // 秘密の値を替える
await ownerPreviewAndOn({ kinds: ['digest'], expect: 'slack_e_slack_dest_changed' });
core('POST', `/secrets/${secretIdA}/rotate`, { value: urlOf(tokA) }); // 戻す
const other = core('POST', `/companies/${companyId}/secrets`, { name: `Slack E2E other ${RUN}`, key: `SLACK_E2E_OTHER_${RUN.toUpperCase()}`, value: urlOf(tokX) });
const cfg0 = notifyCfg(companyId);
core('POST', '/plugins/aioffice.notify/config', { companyId, configJson: { ...cfg0, slack: { webhook: { type: 'secret_ref', secretId: other.id } } } }); // 設定の参照を替える
await ownerPreviewAndOn({ kinds: ['digest'], expect: 'slack_e_slack_dest_changed' });
core('POST', '/plugins/aioffice.notify/config', { companyId, configJson: cfg0 }); // 戻す
assert.equal((await status()).on, false);
assert.equal((await fake.got(tokA)).length + (await fake.got(tokX)).length, 0, '3b: どちらの path にも 0 件');
// 本体の設定の口で種類を足す欄は無い（schema が断る）。種類と形は ON の時の写し（state）だけで決まる
assert.ok(coreRaw('POST', '/plugins/aioffice.notify/config', { companyId, configJson: { ...cfg0, slack: { ...cfg0.slack, kinds: ['approval', 'decision', 'run_failing', 'stuck'] } } }).status >= 400, '3b: 設定の口で種類は替えられない');
log('3b ok');

// ---- 4: 見本を見直して ON → まとめを作って送り → 1 件・見本と同じ。もう一度呼んでも 1 件。承認は 1 件増え、選んでいない判断待ちは増えない ----
await ownerPreviewAndOn({ kinds: ['digest', 'approval'], form: 'titles' });
assert.equal((await status()).on, true);
await newDigest();
const pv4 = await api('GET', `${BASE}/setup/api/slack/preview?companyId=${companyId}&kinds=digest,approval&form=titles`);
await deliver();
let gotA = await fake.got(tokA);
assert.equal(gotA.length, 1, '4: まとめが 1 件');
const sentDigest = gotA[0].body;
assert.equal(sentDigest.text, pv4.messages[0].text, '4: text が見本と同じ'); assert.deepEqual(sentDigest.blocks, pv4.messages[0].blocks, '4: blocks が見本と同じ');
assert.equal(sentDigest.text.split('\n').length, 1, '4: 見出し 1 行');
assert.equal(sentDigest.blocks.filter(b => b.type === 'actions').flatMap(b => b.elements).length, 1, '4: url ボタン 1 つ');
assert.ok(!sentDigest.blocks.filter(b => b.type === 'section').some(b => /https?:/.test(b.text.text)), '4: 文の中に link が無い');
assert.equal(sentDigest.link_names, false); assert.equal(sentDigest.unfurl_links, false); assert.equal(sentDigest.unfurl_media, false);
await deliver(); assert.equal((await fake.got(tokA)).length, 1, '4: もう一度呼んでも 1 件');
approval(`Slack E2E @here <!channel> ${RUN}`); await tick(); await deliver();
gotA = await fake.got(tokA);
assert.equal(gotA.length, 2, '4: 承認で 1 件増える');
const apBody = JSON.stringify(gotA[1].body);
assert.ok(!apBody.includes('<!channel>') && !/(?<!＠)@here/.test(apBody), `4: 呼び出しにならない文字 ${apBody.slice(0, 300)}`);
const card2 = core('POST', `/companies/${companyId}/issues`, { title: `Slack E2E card2 ${RUN}`, status: 'todo' });
core('POST', `/issues/${card2.id}/interactions`, { kind: 'request_confirmation', title: 'Slack E2E confirm 2', payload: { version: 1, prompt: 'Again?' } });
await roundTrip(2);
assert.equal((await fake.got(tokA)).length, 2, '4: 選んでいない判断待ちは増えない');
await openSlack();
assert.ok(await page.getAttribute('[data-slack-last-ok]', 'data-slack-last-ok'), '4: 欄に最後に届いた時刻');
await shot('on');
log('4 ok');

// ---- 5: 試しの 1 通 → 1 件増え、会社の題が無い（P1: 本体の http.fetch から偽の受け口に届く） ----
await page.click('[data-slack-test]');
await page.waitForSelector('[data-slack-msg="slack_test_ok"]', { timeout: 30000 });
gotA = await fake.got(tokA);
assert.equal(gotA.length, 3, '5: 試しの 1 通');
assert.ok(!JSON.stringify(gotA[2].body).includes(RUN), '5: 会社の題が無い');
log('5 ok');

// ---- 6: OFF → 承認を作って送り 3 回 → 増えない。OFF のまま試しの 1 通は押せない。ON にし直しても OFF の間の物は送らない ----
await page.click('[data-slack-off]');
await page.waitForSelector('[data-slack-msg="slack_off_done"]', { timeout: 30000 });
log('6: OFF');
await page.waitForSelector('[data-slack-test]', { state: 'detached', timeout: 15000 }).catch(e => { if (e?.name !== 'TimeoutError') throw e; }); // OFF の知らせが先に出て、ボタンが消える描き直しが後になることがある（2026-11-22 arm64 の日本語）
assert.equal((await page.$('[data-slack-test]')) === null, true, '6: OFF の時は試しのボタンが無い');
approval(`Slack E2E while off ${RUN}`); await roundTrip(3);
log('6: OFF の間の 3 回');
assert.equal((await fake.got(tokA)).length, 3, '6: OFF の間は増えない');
assert.equal(coreRaw('POST', `/plugins/aioffice.notify/api/slack/test?companyId=${companyId}`, {}).status, 409, '6: OFF の時の試しは断る');
log('6: ON にし直す前');
await ownerPreviewAndOn({ kinds: ['digest', 'approval'] });
await roundTrip(2);
assert.equal((await fake.got(tokA)).length, 3, '6: OFF の間にできた知らせは ON にし直しても送らない');
log('6 ok');

// ---- 6b: ON のまま種類を外して ON にし直すと、外した種類の送り残しは届かない（まとめの回は使わず、承認待ちで起こす）----
// 429（Retry-After: 2）で承認の 1 通を待ちに残し、OFF にせずに種類を「まとめだけ」にして ON にし直す
await fake.mode({ status: 429, body: '', headers: { 'retry-after': '2' } });
approval(`Slack E2E deselected ${RUN}`); await tick(); await deliver();
const n6b = (await fake.got(tokA)).length; // 429 を受けた 1 回は記録に残る
assert.equal((await status()).waiting, 1, '6b: 承認の 1 通が待ちに残る');
await fake.mode({ status: 200 });
await ownerPreviewAndOn({ kinds: ['digest'] });
assert.equal((await status()).waiting, 0, '6b: ON にし直すと前の ON の待ちが消える');
await sleep(2500); await roundTrip(2);
assert.equal((await fake.got(tokA)).length, n6b, '6b: 外した種類（承認）の送り残しは届かない');
await ownerPreviewAndOn({ kinds: ['digest', 'approval'] }); // 後ろの段のために戻す
await roundTrip(1);
assert.equal((await fake.got(tokA)).length, n6b, '6b: 種類を戻しても、前の ON の時の承認は送らない');
log('6b ok');

// ---- 7: 429（Retry-After: 2）→ その回は送られず 2 秒後に 1 件。500 → 送られず欄に失敗、直した後に届く ----
// 本体は秘密を引く口を 1 分 30 回までにしている。ここまでの段で使い切っていると、送りは一時の失敗（dest_unavailable）で待ちに残り、
// 2 秒の待ちを確かめられない。1 分待って本体の上限の窓を空けてから確かめる（上限に当たった時に OFF にしないことは製品の保証どおり）
await sleep(61_000);
await fake.mode({ status: 429, body: '', headers: { 'retry-after': '2' } });
approval(`Slack E2E rate ${RUN}`); await tick(); await deliver();
let n7 = (await fake.got(tokA)).length; // 429 を受けた 1 回は記録に残る
await fake.mode({ status: 200 });
await deliver(); assert.equal((await fake.got(tokA)).length, n7, '7: 2 秒の前は送らない');
await sleep(2500); const d7 = await deliver();
const got7 = await fake.got(tokA);
assert.equal(got7.length, n7 + 1, `7: 2 秒後に 1 件（n7=${n7}・届いた ${got7.length}・deliver ${JSON.stringify(d7).slice(0, 300)}・最後 ${JSON.stringify(got7.slice(n7).map(g => g.body?.text ?? g.body).slice(0, 3)).slice(0, 400)}）`);
await fake.mode({ status: 500, body: 'oops' });
approval(`Slack E2E 500 ${RUN}`); await tick(); await deliver();
const s7 = await status(); assert.equal(s7.lastFail?.status, 500, '7: 欄に失敗'); assert.equal(s7.waiting, 1);
const n7b = (await fake.got(tokA)).length;
await fake.mode({ status: 200 });
await sleep(61_000); await deliver(); // 送り直しは 1 分後
assert.equal((await fake.got(tokA)).length, n7b + 1, '7: 直した後に届く');
log('7 ok');

// ---- 8: 404 no_service → OFF・帯と欄に「Slack に届いていません」と no_service。新しい知らせは増えない。入れ直して ON にするとまた届く ----
await fake.mode({ status: 404, body: 'no_service' });
approval(`Slack E2E dead ${RUN}`); await tick(); await deliver();
const s8 = await status(); assert.equal(s8.on, false); assert.equal(s8.offReason, 'dead'); assert.equal(s8.offCode, 'no_service');
await page.goto(`${BASE}/${prefix}/office`);
await page.waitForSelector('[data-banner="slack_failed"]', { timeout: 60000 });
await page.click('[data-banner="slack_failed"]');
await page.waitForSelector('[data-slack-reason="dead"]', { timeout: 30000 });
assert.ok((await page.textContent('[data-slack-reason="dead"]')).includes('no_service'));
assert.ok((await notices()).some(n => n.kind === 'slack_failed'), '8: 受信箱にも 1 件');
await shot('stopped');
const n8 = (await fake.got(tokA)).length;
await fake.mode({ status: 200 });
approval(`Slack E2E after dead ${RUN}`); await roundTrip(2);
assert.equal((await fake.got(tokA)).length, n8, '8: 止まった後は増えない');
await ownerSave(urlOf(tokA)); await ownerPreviewAndOn({ kinds: ['digest', 'approval'] });
approval(`Slack E2E revived ${RUN}`); await tick(); await deliver();
assert.equal((await fake.got(tokA)).length, n8 + 1, '8: 入れ直して ON にするとまた届く');
await page.goto(`${BASE}/${prefix}/office`); await sleep(2000);
assert.equal((await page.$('[data-banner="slack_failed"]')) === null, true, '8: 直ると帯が消える');
log('8 ok');

// ---- 9: 偽の受け口が 30 秒待つ → 送りの口が 20 秒以内に返り、見回りの口は遅れない ----
await fake.mode({ status: 200, delayMs: 30_000 });
approval(`Slack E2E slow ${RUN}`); const tt0 = Date.now(); await tick(); const tickMs = Date.now() - tt0;
const d0 = Date.now(); const d9 = await deliver(); const dMs = Date.now() - d0;
assert.ok(dMs < 20_000, `9: 送りの口が ${dMs}ms`); assert.equal(d9.last, 'timeout');
const t1 = Date.now(); await tick(); assert.ok(Date.now() - t1 < Math.max(10_000, tickMs * 3), '9: 見回りの口は遅れない');
await fake.mode({ status: 200, delayMs: 0 });
await sleep(31_000); // 待たせた要求の片付け
log('9 ok');

// ---- 10: 2 社目。A のまとめは A の path にだけ、B のまとめは B の path にだけ。B を OFF にすると B は増えない。A の設定に B の秘密は置けない ----
const coB = core('POST', '/companies', { name: `Slack E2E Second ${RUN}` });
await api('POST', `${BASE}/setup/api/slack`, { companyId: coB.id, url: urlOf(tokB) });
const pvB = await api('GET', `${BASE}/setup/api/slack/preview?companyId=${coB.id}&kinds=digest&form=titles`);
assert.equal((await api('POST', `${BASE}/setup/api/slack/confirm`, { companyId: coB.id, kinds: ['digest'], form: 'titles', previewHash: pvB.hash })).on, true);
const a10 = (await fake.got(tokA)).length;
// A のまとめの数え始めは 61 秒の待ちの前に取る。その時あったまとめは、待ちの間の見回りと下の deliver() で a10b より前に送り終わるので、
// 「a10b の後に届いた A のまとめ」は必ずこの後に作られた物になる（読む順のずれで誤って落ちない・独立レビュー 29 回目 P3-A）。
// 受け入れる限界: 待ちの間に作られ a10b より前に送られた A のまとめも数に入るので、許す数が 1 つ多くなり得る。
// また B の知らせが A の設定で描かれる漏れが、A の正規のまとめと同じ回に 1 件だけ起きると数では見えない（P3-B）。その漏れは A の URL・B の URL・本文の判定と、11 番以降の数で拾う
const aDigests0 = new Set((await notices(companyId)).filter(n => n.kind === 'digest').map(n => n.originId));
await sleep(61_000); await deliver(); // 9 の待ちの片付け（A の送り直しの分）
const a10b = (await fake.got(tokA)).length;
// まとめの回は日付と朝・夕方で決まり、時刻によっては 1 日に 2 つしか作れない。A は 4 で 1 つ使い、A のまとめが A の path に届くことも 4 で確かめた。
// ここでは B だけに新しいまとめを作り、B の path にだけ届いて A の path には来ないことを確かめる（回す時刻に依らない）
// 上の 61 秒の待ちの間に、定時の見回りが今の時刻帯の B のまとめを先に 1 つ作って届けることがある（前の時刻帯がまだまとめの回の枠の中の時。
// 2026-11-20 arm64 で 2 件になって落ちた）。なので newDigest の前の B の数から 1 件増えることを見る
await deliver(coB.id);
const b10 = (await fake.got(tokB)).length;
assert.ok(b10 <= 1, `10: 定時の見回りが作る B のまとめは今の回の 1 つまで（${b10}）`);
await newDigest([coB.id]);
await deliver(companyId); await deliver(coB.id);
const gotB = await fake.got(tokB);
// newDigest は時刻帯（起動係の設定・全社に効く）を替えるので、定時の見回りが A にも同じ回の A のまとめを作って届けることがある（2026-11-24 amd64 で A が 12 !== 11 で落ちた）。
// なので A の数そのものは見ず、A に新しく届いた物を 1 件ずつ説明させる: その間に A 自身に新しく作られたまとめの数まで・A の会社の URL で描かれている・
// B の会社の URL を含まない・B に届いたどの本文とも同じでない。B の知らせが A の設定で描かれて A に送られる漏れは、数が A の新しいまとめを超えて落ちる
const newA = (await fake.got(tokA)).slice(a10b);
const aDigestsNew = (await notices(companyId)).filter(n => n.kind === 'digest' && !aDigests0.has(n.originId)).length;
const coBFull = core('GET', `/companies/${coB.id}`);
assert.ok(coBFull.issuePrefix && coBFull.issuePrefix !== prefix, '10: B の prefix が読める');
const urlA = `/${encodeURIComponent(prefix)}/office`, urlB = `/${encodeURIComponent(coBFull.issuePrefix)}/office`;
if (newA.length) log(`10: この間に A に届いた ${newA.length} 件（A に新しく作られたまとめ ${aDigestsNew}）: ${newA.map(g => JSON.stringify(g.body).slice(0, 120)).join(' | ')}`);
assert.ok(newA.length <= aDigestsNew, `10: A に届いた物（${newA.length}）は A 自身の新しいまとめ（${aDigestsNew}）で説明できる`);
assert.ok(gotB.slice(b10).length === 1 && gotB.every(x => JSON.stringify(x.body).includes(urlB)), '10: B の物は B の URL で描かれている');
for (const g of newA) {
  const t = JSON.stringify(g.body);
  assert.ok(t.includes(urlA), '10: A に届いた物は A の URL で描かれている');
  assert.ok(!t.includes(urlB), '10: A に B の URL の物が来ない');
  assert.ok(!gotB.some(x => JSON.stringify(x.body) === t), '10: B のまとめは A の path に来ない（同じ本文）');
}
assert.equal(gotB.length, b10 + 1, '10: newDigest の B のまとめは B の path に 1 件');
for (const g of gotB) assert.ok(!JSON.stringify(g.body).includes('Slack E2E @here'), '10: B に A の題が混ざらない');
// OFF の確かめは、まとめの回を 1 つも使っていない 3 社目（C）で行う。まとめの回は「日付と朝・夕方」で、時刻帯を全部回してもある時点で選べるのは 2〜3 個。
// B は見回りの分と上の newDigest の分で 2 つ使うことがあり、B でもう 1 つ作ろうとすると時刻によって回が足りない（2026-11-20 arm64 で落ちた）
await api('POST', `${NB}/slack/off?companyId=${coB.id}`, {});
await tick(coB.id); await deliver(coB.id); // 見回りと同じ回し方で、OFF の B に新しく届かないことだけを見る（本当の確かめは下の C）
assert.equal((await fake.got(tokB)).length, b10 + 1, '10: B を OFF にすると増えない');
const coC = core('POST', '/companies', { name: `Slack E2E Third ${RUN}` });
await api('POST', `${BASE}/setup/api/slack`, { companyId: coC.id, url: urlOf(tokC) });
const pvC = await api('GET', `${BASE}/setup/api/slack/preview?companyId=${coC.id}&kinds=digest&form=titles`);
assert.equal((await api('POST', `${BASE}/setup/api/slack/confirm`, { companyId: coC.id, kinds: ['digest'], form: 'titles', previewHash: pvC.hash })).on, true);
await api('POST', `${NB}/slack/off?companyId=${coC.id}`, {});
const c0 = (await fake.got(tokC)).length; // ON から OFF までの 1 秒未満に見回りが C のまとめを届けた分（ふつう 0）
const kC = await newDigest([coC.id]); await deliver(coC.id);
assert.ok((await notices(coC.id)).some(n => n.kind === 'digest' && n.originId === kC), '10: OFF の C にも newDigest の回のまとめの知らせはできる');
assert.equal((await fake.got(tokC)).length, c0, '10: OFF にした C にはまとめが届かない');
await api('POST', `${BASE}/setup/api/slack`, { companyId: coC.id, remove: true });
deleteCompany(coreRaw, coC.id);
const bSecret = notifyCfg(coB.id).slack.webhook.secretId;
const cross = coreRaw('POST', '/plugins/aioffice.notify/config', { companyId, configJson: { ...notifyCfg(companyId), slack: { webhook: { type: 'secret_ref', secretId: bSecret } } } });
assert.ok(cross.status >= 400 && cross.status < 500, `10: A の設定に B の秘密は置けない（${cross.status}）`);
await api('POST', `${BASE}/setup/api/slack`, { companyId: coB.id, remove: true });
deleteCompany(coreRaw, coB.id); // 後ろの CI の段は会社が 1 社であることを確かめるので消す
assert.ok(a10 >= 0);
log('10 ok');

// ---- 11: 秘密の数え（P3・P8）。宛先の保存をわざと 4xx にした回を含めて、偽の token の文字を数える ----
const bad1 = await apiRaw('POST', `${BASE}/setup/api/slack`, { companyId: 'no-such-company', url: urlOf(tokY) }); // 起動係が会社を確かめて秘密の口を呼ばない
assert.equal(bad1.status, 404);
const bad2 = coreRaw('POST', `/companies/${companyId}/secrets`, { name: `Slack E2E other ${RUN}`, key: `SLACK_E2E_OTHER_${RUN.toUpperCase()}`, value: urlOf(tokY) }); // 本体の秘密の口の失敗（P8）: 実在の会社に同じ名前で保存する
assert.equal(bad2.status, 409, `P8: 同じ名前の秘密は 409（${bad2.status}）`);
core('DELETE', `/secrets/${other.id}`);
await openSlack(); bodies.push(await page.content());
const secretParts = ALL_TOKS.flatMap(t => t.split('/'));
const count = (label, text) => { const n = secretParts.reduce((a, p) => a + (String(text).split(p).length - 1), 0); log(`11: ${label}: ${n}`); return n; };
const where = {
  docker_logs: (r => String(r.stdout) + String(r.stderr))(spawnSync('docker', ['logs', CONTAINER], { encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 })),
  plugin_logs: coreRaw('GET', '/plugins/aioffice.notify/logs?limit=1000').text,
  activity: coreRaw('GET', `/companies/${companyId}/activity?limit=500`).text,
  launcher_state: sh(['exec', CONTAINER, 'cat', '/data/aioffice/state.json']) + sh(['exec', CONTAINER, 'cat', '/data/aioffice/rounds.json']),
  notify_tables: sh(['exec', CONTAINER, 'node', '--input-type=module', '-e', `import{readFileSync}from'node:fs';import{createRequire}from'node:module';const r=createRequire('/opt/aioffice/runtime/node_modules/');const pg=r('pg');const c=JSON.parse(readFileSync('/data/paperclip/instances/default/config.json','utf8'));const k=new pg.Client({host:'127.0.0.1',port:c.database?.embeddedPostgresPort||54329,user:'paperclip',password:c.database?.embeddedPostgresPassword||'paperclip',database:'paperclip'});await k.connect();for(const t of ['notices','sends','events']){const x=await k.query('select * from plugin_notify_4b4010a560.'+t);console.log(JSON.stringify(x.rows))}const s=await k.query("select * from plugin_state where plugin_id in (select id from plugins where plugin_key='aioffice.notify')").catch(()=>({rows:[]}));console.log(JSON.stringify(s.rows));const pc=await k.query("select config_json from plugin_config").catch(()=>({rows:[]}));console.log(JSON.stringify(pc.rows));await k.end()`]),
  responses: bodies.join('\n'),
};
const total = Object.entries(where).reduce((a, [k, v]) => a + count(k, v), 0);
assert.equal(total, 0, '11: 偽の token の文字は、ログ・活動・state・表・口の返事・画面の HTML のどこにも 0');
saveState({ tokA, lastOkAt: (await status()).lastOkAt });
assert.deepEqual(errors, [], 'ページの error が無い');
log('11 ok — all slack e2e passed');
// 後ろの CI の段は試験の網と名前の付け替えの無い container で動くので、本物の Slack へ送らないよう OFF にして宛先を消す（入れ直しの確かめ 12 に持ち越す時だけ残す）
if (process.env.AIO_SLACK_KEEP !== '1') await offAndRemove();
await browser.close();
