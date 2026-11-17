// メールで届ける（持ち主の Gmail から持ち主の Gmail へ）を、wizard の後の package で偽の SMTP の受け口に向けて通す（範囲 docs/review/2026-11-19-mail-notify-scope.md の r2「確かめ方」と r3）。
// Slack の e2e（slack.e2e.mjs）の後に流す。container は CI のメールの段で、試験の網（198.18.0.0/24）・--add-host smtp.gmail.com・試験用の CA・
// -e NODE_EXTRA_CA_CERTS・-e AIOFFICE_CI_MAIL_TEST=1・-e AIOFFICE_CI_TEST_HOOKS=1 を付けて起こしてある（配る起動の行には入れない。CI の grep の段と unit が確かめる）。
// 使い方: AIO_BASE=http://localhost:3100 AIO_LANG=en AIO_CONTAINER=aioffice AIO_SHOTS=<撮る先> AIO_MAIL_FAKE=http://127.0.0.1:3299 AIO_MAIL_STATE=<json の置き場> node test/e2e/mail.e2e.mjs
//   AIO_MAIL_PHASE=refuse-no-marker|refuse-no-ca: 試験の印の env が無い・試験用の CA を渡さない container で、メールが断られる（接続しない・TLS で失敗する）ことだけを確かめる
//   AIO_MAIL_PHASE=after-reinstall: 入れ直しの後の確かめだけを流す。PLAYWRIGHT_MODULE・PW_EXE は wizard の e2e と同じ
// 時計は動かさない。見回りの口（notify の /tick）と起動係の「見回りを今 1 回流す」口（CI の env がある時だけ開く）を試験から手で呼ぶ
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFileSync, spawnSync } from 'node:child_process';
import { MAIL_DICT } from '../../packages/aioffice/launcher/lib/mail-core.mjs';
import { dockerSync } from './docker.mjs';

const BASE = process.env.AIO_BASE || 'http://localhost:3100';
const LANG = process.env.AIO_LANG === 'ja' ? 'ja' : 'en';
const CONTAINER = process.env.AIO_CONTAINER || 'aioffice';
const OUT = process.env.AIO_SHOTS || '';
const PASS = process.env.AIO_PASS || 'e2e-owner-password';
const FAKE = process.env.AIO_MAIL_FAKE || 'http://127.0.0.1:3299';
const STATE_FILE = process.env.AIO_MAIL_STATE || '';
const PHASE = process.env.AIO_MAIL_PHASE || 'main';
const RUN = Date.now().toString(36);
const sleep = ms => new Promise(r => setTimeout(r, ms));
const log = (...a) => console.log('[mail e2e]', ...a);
const SHOT_DAY = '2026-11-19';
const letters = n => Array.from(crypto.randomBytes(n), b => String.fromCharCode(97 + (b % 26))).join('');
// 偽のアドレスとアプリ パスワード（試験ごとに作る。数えるのはこの文字）
const mkAddr = () => `e2e${letters(10)}@gmail.com`;
const mkPw = () => letters(16);

// container の中から本体（127.0.0.1:3101）に直に頼む（担当と同じ道: Authorization なし）。raw は status を返し、投げない
function coreRaw(method, p, body) {
  const js = `const r=await fetch('http://127.0.0.1:3101/api'+process.argv[1],{method:process.argv[2],headers:{'content-type':'application/json'},body:process.argv[3]||undefined});const t=await r.text();console.log(JSON.stringify({s:r.status,t}))`;
  const out = dockerSync(['exec', CONTAINER, 'node', '--input-type=module', '-e', js, p, method, body ? JSON.stringify(body) : ''], { encoding: 'utf8', timeout: 60000 });
  const { s, t } = JSON.parse(out.trim().split('\n').pop());
  let j = null; try { j = JSON.parse(t); } catch { j = null; }
  return { status: s, json: j, text: t };
}
function core(method, p, body) { const r = coreRaw(method, p, body); if (r.status >= 400) throw new Error(`${method} ${p} → ${r.status} ${r.text.slice(0, 200)}`); return r.json; }
const sh = (args, opts = {}) => dockerSync(args, { encoding: 'utf8', timeout: 120000, maxBuffer: 256 * 1024 * 1024, ...opts });
// 偽の受け口の操作の口
const fake = {
  got: async () => (await (await fetch(`${FAKE}/got`)).json()),
  mode: async m => { await fetch(`${FAKE}/mode`, { method: 'POST', body: JSON.stringify(m) }); },
  reset: async () => { await fetch(`${FAKE}/reset`, { method: 'POST' }); },
};
const mails = async () => (await fake.got()).got;

const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || 'playwright');
if (OUT) fs.mkdirSync(OUT, { recursive: true });
const browser = await chromium.launch(process.env.PW_EXE ? { executablePath: process.env.PW_EXE } : {});
const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, locale: LANG === 'ja' ? 'ja-JP' : 'en-US' });
const page = await ctx.newPage();
const errors = []; page.on('pageerror', e => errors.push(String(e)));
// office と起動係の口の返事を全部覚える（秘密の文字が返事に出ないことを数える）
const bodies = [];
page.on('response', async r => { if (/\/setup\/api\/|\/api\/plugins\/aioffice\.notify\//.test(r.url())) { try { bodies.push(await r.text()); } catch { /* 本文なし */ } } });
let shotN = 0;
const shot = async name => { if (OUT) await page.screenshot({ path: path.join(OUT, `${SHOT_DAY}_${LANG}_mail-${String(++shotN).padStart(2, '0')}-${name}.png`), fullPage: false }); };

const getState = async () => { for (let i = 0; ; i++) { try { return await (await ctx.request.get(`${BASE}/setup/api/state`)).json(); } catch (e) { if (i >= 2 || !/socket hang up|ECONNRESET/.test(String(e))) throw e; await sleep(500); } } };
assert.equal((await ctx.request.post(`${BASE}/setup/api/login`, { data: { password: PASS }, headers: { origin: BASE } })).status(), 200, 'ログイン');
const state0 = await getState();
const companyId = state0.company.id, prefix = state0.company.prefix;
const NB = `${BASE}/api/plugins/aioffice.notify/api`;
const apiRaw = async (method, url, data) => { const r = await ctx.request.fetch(url, { method, data, headers: { origin: BASE, 'content-type': 'application/json' }, timeout: 60000 }); const j = await r.json().catch(() => null); bodies.push(JSON.stringify(j)); return { status: r.status(), json: j }; };
const api = async (method, url, data) => { const r = await apiRaw(method, url, data); assert.ok(r.status < 400, `${method} ${url} → ${r.status} ${JSON.stringify(r.json).slice(0, 200)}`); return r.json; };
const tick = async (cid = companyId) => { const s = await getState(); return api('POST', `${NB}/tick?companyId=${encodeURIComponent(cid)}`, { lang: s.lang, ...(s.timeZone ? { timeZone: s.timeZone } : {}) }); };
const ownerCookie = async () => { const c = (await ctx.cookies()).find(x => x.name === 'aio_owner'); assert.ok(c, '持ち主の cookie'); return `${c.name}=${c.value}`; };
// 起動係の「見回りを今 1 回流す」口を container の中（loopback）から呼ぶ（CI の env がある時だけ開く）
async function mailRound() {
  const js = `const r=await fetch('http://127.0.0.1:3100/setup/api/test/mail-round',{method:'POST',headers:{'content-type':'application/json',host:'localhost:3100',cookie:process.argv[1]},body:'{}'});console.log(JSON.stringify({s:r.status,t:await r.text()}))`;
  const out = JSON.parse(sh(['exec', CONTAINER, 'node', '--input-type=module', '-e', js, await ownerCookie()]).trim().split('\n').pop());
  assert.equal(out.s, 200, `見回りの口 ${out.s} ${out.t.slice(0, 120)}（container を -e AIOFFICE_CI_TEST_HOOKS=1 で起こす）`);
  return JSON.parse(out.t).round;
}
const cycle = async (n = 1, cid = companyId) => { let last = null; for (let i = 0; i < n; i++) { await tick(cid); last = await mailRound(); } return last; };
const mstatus = async (cid = companyId) => api('GET', `${BASE}/setup/api/mail?companyId=${encodeURIComponent(cid)}`);
const approval = (title, cid = companyId) => core('POST', `/companies/${cid}/approvals`, { type: 'request_board_approval', payload: { title } });
const notices = async (cid = companyId) => (await api('GET', `${NB}/notices?companyId=${encodeURIComponent(cid)}`)).notices;
// 持ち主の画面
async function openMail() {
  await page.goto(`${BASE}/${prefix}/office`);
  await page.click('[data-open="inbox"]');
  await page.waitForSelector('[data-mail]:not([data-mail="loading"])', { timeout: 60000 });
  await page.locator('#aio-mail').scrollIntoViewIfNeeded();
}
const mailMsg = async () => page.getAttribute('[data-mail-msg]', 'data-mail-msg', { timeout: 30000 });
async function ownerPreviewAndOn({ kinds = ['approval'], form = 'titles', expect = 'slack_on_done' } = {}) {
  await openMail();
  for (const k of ['digest', 'approval', 'decision', 'run_failing', 'stuck']) { const box = page.locator(`[data-mail-kind="${k}"]`); if ((await box.isChecked()) !== kinds.includes(k)) await box.click(); }
  await page.selectOption('[data-mail-form]', form);
  await page.click('[data-mail-preview]');
  await page.waitForSelector('[data-mail-sample]', { timeout: 30000 });
  await page.click('[data-mail-on]');
  await page.waitForSelector('[data-mail-msg]', { timeout: 30000 });
  assert.equal(await mailMsg(), expect);
}
async function ownerSave(addr, pw) {
  await openMail();
  await page.fill('[data-mail-addr]', addr);
  await page.fill('[data-mail-pass]', pw);
  await page.click('[data-mail-save]');
  await page.waitForSelector('[data-mail-msg="mail_saved"]', { timeout: 30000 });
}
async function removeAll() { await api('POST', `${BASE}/setup/api/mail/off`, { companyId }); await api('POST', `${BASE}/setup/api/mail`, { companyId, remove: true }); assert.equal((await mstatus()).saved, false, '宛先を消した'); }
const saveState = o => { if (STATE_FILE) fs.writeFileSync(STATE_FILE, JSON.stringify(o)); };
const loadState = () => JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
// 送られた 1 通の中身を読む（ヘッダーの名前・件名・text・HTML）
function parseMail(m) {
  const [head, ...rest] = m.data.split('\r\n\r\n');
  const flat = head.replace(/\r\n[ \t]/g, ' ');
  const headers = Object.fromEntries(flat.split('\r\n').map(l => [l.slice(0, l.indexOf(':')), l.slice(l.indexOf(':') + 2)]));
  const boundary = head.match(/boundary="([^"]+)"/)[1];
  const parts = m.data.split(`--${boundary}`).slice(1, -1).map(p => Buffer.from(p.split('\r\n\r\n')[1].replace(/\r\n/g, ''), 'base64').toString('utf8'));
  const subject = headers.Subject.includes('=?UTF-8?B?') ? flat.match(/^Subject: (.*)$/m)[1].split(' ').map(w => Buffer.from(w.slice(10, -2), 'base64').toString('utf8')).join('') : headers.Subject;
  return { headers, names: Object.keys(headers).sort(), subject, text: parts[0], html: parts[1], rcpt: m.cmds.filter(c => c.startsWith('RCPT')) };
}

if (PHASE === 'refuse-no-marker' || PHASE === 'refuse-no-ca') {
  // ---- 試験の印の env が無い（CA だけ渡している）・試験用の CA を渡さない container では、メールが断られる（r3 の 8）。前の段で ON のまま残した state を使う ----
  const S = loadState();
  assert.equal((await mstatus()).on, true, 'ON が残っている');
  const before = await fake.got();
  approval(`Mail E2E refuse ${PHASE} ${RUN}`);
  await cycle(2);
  const after = await fake.got();
  assert.equal(after.got.length, before.got.length, '1 通も届かない');
  assert.equal(after.connections, before.connections, '偽の受け口に TLS の手順まで進まない（接続を確立しない）');
  assert.ok(!after.commands.slice(before.commands.length).some(c => /^(AUTH|MAIL|RCPT|DATA)/.test(c)), 'AUTH も送らない（アプリ パスワードを渡さない）');
  const st = await mstatus();
  if (PHASE === 'refuse-no-marker') { assert.equal(st.on, false); assert.equal(st.offCode, 'test_ca_env', 'やり直さず OFF にして印を残す'); await page.goto(`${BASE}/${prefix}/office`); await page.waitForSelector('[data-banner="mail_ca_env"]', { timeout: 60000 }); }
  else { assert.equal(st.lastFail?.code, 'tls', `${PHASE}: 失敗の印は tls`); assert.ok(st.failStreak >= 1); assert.equal(st.on, true, 'tls の失敗は OFF にしない（やり直し）'); }
  log(`${PHASE} ok`);
  assert.ok(S.addr, '前の段が残した記録がある');
  // 最後の断りの段は、本物の Gmail へ送らないよう OFF にして宛先を消す
  if (PHASE === 'refuse-no-marker' && process.env.AIO_MAIL_KEEP !== '1') await removeAll();
  await browser.close();
  process.exit(0);
}

if (PHASE === 'after-reinstall') {
  // ---- 入れ直しの後、ON の状態・送りの記録が残り、既に送った知らせを 2 回目に送らない ----
  const S = loadState();
  const plugins = JSON.parse(sh(['exec', CONTAINER, 'cat', '/data/aioffice/plugins.json']));
  assert.equal(plugins['aioffice.notify']?.status, 'ready', '入れ直した知らせの plugin が ready');
  const st = await mstatus();
  assert.equal(st.on, true, 'ON が残る'); assert.equal(st.lastOkAt, S.lastOkAt, '最後に届いた時刻が残る');
  const before = (await mails()).length;
  await cycle(2);
  assert.equal((await mails()).length, before, '送った知らせを 2 回目に送らない');
  approval(`Mail E2E after reinstall ${RUN}`); await cycle(1);
  assert.equal((await mails()).length, before + 1, '入れ直しの後も新しい知らせは届く');
  log('after-reinstall ok');
  await removeAll();
  await browser.close();
  process.exit(0);
}

const ADDR = mkAddr(), PW = mkPw(), ADDR2 = mkAddr(), PW2 = mkPw(), ADDR_B = mkAddr(), PW_B = mkPw();
const SECRETS = [ADDR, ADDR.split('@')[0], PW, ADDR2, ADDR2.split('@')[0], PW2, ADDR_B, ADDR_B.split('@')[0], PW_B];
await fake.reset();

// ---- P1: container から偽の受け口に TLS で届き、証明書が通り、挨拶（220）が返る（名前・CA・網） ----
const p1 = sh(['exec', CONTAINER, 'node', '-e', `const t=require('node:tls').connect({host:'smtp.gmail.com',port:465,servername:'smtp.gmail.com'});t.setEncoding('utf8');t.once('data',d=>{console.log(d.slice(0,3));t.destroy()});t.on('error',e=>console.log('ERR',e.code||e.message))`]).trim();
assert.equal(p1, '220', `P1: container から偽の受け口に届く（${p1}）`);
await fake.reset();

// ---- 1: アドレスを入れる前: 承認・判断のカードを作り、見回りと送りを 3 回 → 0 通。欄は空 ----
approval(`Mail E2E before addr ${RUN}`);
const cardIssue = core('POST', `/companies/${companyId}/issues`, { title: `Mail E2E card ${RUN}`, status: 'todo' });
core('POST', `/issues/${cardIssue.id}/interactions`, { kind: 'request_confirmation', title: 'Mail E2E confirm', payload: { version: 1, prompt: 'Go ahead?' } });
await cycle(3);
assert.equal((await fake.got()).connections, 0, '1: アドレスの前は 0 回の接続');
const s1 = await mstatus(); assert.equal(s1.on, false); assert.equal(s1.saved, false);
await openMail(); await shot('empty');
log('1 ok');

// ---- 2: 保存したが ON にしない → 0 通。伏せたアドレスが出て、元の文字が画面のどこにも無い（入力の欄も空） ----
await ownerSave(ADDR, PW);
await page.waitForSelector('[data-mail-dest="saved"]', { timeout: 30000 });
const html2 = await page.content();
const inputs2 = await page.$$eval('input', els => els.map(e => e.value));
for (const s of [ADDR, ADDR.split('@')[0].slice(1), PW]) { assert.ok(!html2.includes(s), '2: 画面の HTML に元の文字が無い'); assert.ok(!inputs2.some(v => v.includes(s)), '2: 入力の欄の値に元の文字が無い'); }
assert.equal(await page.textContent('[data-mail-masked]'), `${ADDR[0]}***@gmail.com`);
await shot('saved');
approval(`Mail E2E saved not on ${RUN}`); await cycle(3);
assert.equal((await fake.got()).connections, 0, '2: ON の前は 0 回の接続');
assert.equal((await mstatus()).saved, true);
log('2 ok');

// ---- 3: 見本 → 撮る。選びを変えた後に古い見本のまま ON を押すと断られる ----
await openMail();
await page.locator('[data-mail-kind="approval"]').check();
await page.click('[data-mail-preview]');
await page.waitForSelector('[data-mail-sample-msg="approval"]', { timeout: 30000 });
await shot('preview');
await page.selectOption('[data-mail-form]', 'counts');
await page.click('[data-mail-on]');
await page.waitForSelector('[data-mail-msg="mail_e_mail_preview_stale"]', { timeout: 30000 });
assert.equal((await mstatus()).on, false, '3: 古い見本では ON にならない');
log('3 ok');

// ---- 3b: 担当の道（cookie なし・Authorization なし）では ON にも保存にも送りにも触れない。notify の口に ON にする道が無い ----
const anon = (method, p, body) => {
  const js = `const r=await fetch('http://127.0.0.1:3100'+process.argv[1],{method:process.argv[2],headers:{'content-type':'application/json',host:'localhost:3100'},body:process.argv[3]||undefined});console.log(JSON.stringify({s:r.status}))`;
  return JSON.parse(sh(['exec', CONTAINER, 'node', '--input-type=module', '-e', js, p, method, body ? JSON.stringify(body) : '']).trim().split('\n').pop()).s;
};
assert.equal(anon('POST', '/setup/api/mail/confirm', { companyId, kinds: ['approval'], form: 'titles', previewHash: 'a'.repeat(32) }), 401, '3b: cookie なしで ON にできない');
assert.equal(anon('POST', '/setup/api/mail', { companyId, addr: ADDR2, pw: PW2 }), 401, '3b: cookie なしで宛先を替えられない');
assert.equal(anon('POST', '/setup/api/mail/test', { companyId }), 401);
assert.equal(anon('POST', '/setup/api/test/mail-round', {}), 401, '3b: 見回りの口は cookie が無ければ 401（loopback でも）');
// 本体（Paperclip 2026.1001.0）は失敗した要求の本文を error-handler でログに書くので、無い口の確かめには 12 で数える値と別の値を送る（数える値を試験が自分で本体へ送らない）
const PROBE_ADDR = mkAddr(), PROBE_PW = mkPw();
for (const p of ['mail/confirm', 'mail/on', 'mail/save', 'mail/test']) assert.ok(coreRaw('POST', `/plugins/aioffice.notify/api/${p}?companyId=${companyId}`, { addr: PROBE_ADDR, pw: PROBE_PW }).status >= 400, `3b: notify の口 ${p} は無い`);
const agentPending = coreRaw('GET', `/plugins/aioffice.notify/api/mail/pending?companyId=${companyId}`); // onAt なしは空
assert.equal(agentPending.status, 200); assert.deepEqual(agentPending.json.rows, []);
assert.equal((await mstatus()).on, false); assert.equal((await fake.got()).connections, 0);
log('3b ok');

// ---- 4: 見本を見直して ON → 承認で 1 通。見本と同じ件名と本文・ヘッダーは決めた物だけ・From と To は同じ・RCPT は 1 つ。もう一度流しても 1 通 ----
await ownerPreviewAndOn({ kinds: ['approval'], form: 'titles' });
assert.equal((await mstatus()).on, true);
const pv4 = await api('GET', `${BASE}/setup/api/mail/preview?companyId=${companyId}&kinds=approval&form=titles`);
approval(`Mail E2E <b>first</b> ${RUN}`); await cycle(1);
let got = await mails();
assert.equal(got.length, 1, '4: 承認で 1 通');
const m4 = parseMail(got[0]);
assert.deepEqual(m4.names, ['Content-Type', 'Date', 'From', 'MIME-Version', 'Message-ID', 'Subject', 'To'], '4: ヘッダーは決めた物だけ');
assert.equal(m4.headers.From, `<${ADDR}>`); assert.equal(m4.headers.To, `<${ADDR}>`); assert.deepEqual(m4.rcpt, [`RCPT TO:<${ADDR}>`]);
assert.equal(got[0].authUser, ADDR); assert.equal(got[0].authPass, PW);
assert.equal(m4.subject, pv4.messages[0].subject, '4: 件名が見本と同じ'); assert.ok(!m4.subject.includes(RUN), '4: 件名に題が入らない');
assert.ok(m4.text.includes(`Mail E2E`) && m4.html.includes('&lt;b&gt;first&lt;/b&gt;'), '4: 題は HTML では escape'); assert.equal((m4.html.match(/href=/g) || []).length, 1, '4: リンクは 1 つ');
assert.equal(m4.text.split(/\r?\n/)[0], m4.subject.replace('[AI Office] ', ''), '4: 本文の見出しは件名と同じ辞書の文'); // 本文は SMTP の決まりで CRLF（smtp.mjs の crlf）
await cycle(2); assert.equal((await mails()).length, 1, '4: もう一度流しても 1 通');
await openMail();
assert.ok(await page.getAttribute('[data-mail-last-ok]', 'data-mail-last-ok'), '4: 欄に最後に届いた時刻'); assert.equal(await page.getAttribute('[data-mail-sent-today]', 'data-mail-sent-today'), '1');
await shot('on');
log('4 ok');

// ---- 5: 選んでいない判断待ちは増えない。試しの 1 通 → 1 通増え、会社の題が無い ----
const card2 = core('POST', `/companies/${companyId}/issues`, { title: `Mail E2E card2 ${RUN}`, status: 'todo' });
core('POST', `/issues/${card2.id}/interactions`, { kind: 'request_confirmation', title: 'Mail E2E confirm 2', payload: { version: 1, prompt: 'Again?' } });
await cycle(2); assert.equal((await mails()).length, 1, '5: 選んでいない判断待ちは増えない');
await page.click('[data-mail-test]');
await page.waitForSelector('[data-mail-msg="mail_test_ok"]', { timeout: 30000 });
got = await mails(); assert.equal(got.length, 2, '5: 試しの 1 通');
assert.ok(!JSON.stringify(got[1]).includes(RUN), '5: 会社の題が無い'); assert.equal(parseMail(got[1]).subject, `[AI Office] ${MAIL_DICT[LANG].test_subject}`);
log('5 ok');

// ---- 6: OFF → 承認を作って流す → 増えない。OFF の時は試しのボタンが無い。ON にし直しても OFF の間の物は送らない ----
await page.click('[data-mail-off]');
await page.waitForSelector('[data-mail-msg="slack_off_done"]', { timeout: 30000 });
await page.waitForSelector('[data-mail-test]', { state: 'detached', timeout: 15000 }).catch(e => { if (e?.name !== 'TimeoutError') throw e; }); // OFF の知らせが先に出て、ボタンが消える描き直しが後になることがある（2026-11-22 arm64 の日本語）
assert.equal((await page.$('[data-mail-test]')) === null, true, '6: OFF の時は試しのボタンが無い');
const c6 = (await fake.got()).connections;
approval(`Mail E2E while off ${RUN}`); await cycle(3);
assert.equal((await fake.got()).connections, c6, '6: OFF の間は接続しない');
assert.equal((await ctx.request.post(`${BASE}/setup/api/mail/test`, { data: { companyId }, headers: { origin: BASE } })).status(), 409, '6: OFF の時の試しは断る');
await ownerPreviewAndOn({ kinds: ['approval'] }); await cycle(2);
assert.equal((await mails()).length, 2, '6: OFF の間にできた知らせは ON にし直しても送らない');
log('6 ok');

// ---- 7: 認証の失敗（535）→ OFF・帯と欄に「メールが届いていません」と auth_failed。新しい知らせは増えない。保存し直して ON にするとまた届く ----
await fake.mode({ auth: '535-5.7.8 Username and Password not accepted.\r\n535 5.7.8 secret-answer-text' });
approval(`Mail E2E dead ${RUN}`); await cycle(1);
const s7 = await mstatus(); assert.equal(s7.on, false); assert.equal(s7.offReason, 'dead'); assert.equal(s7.offCode, 'auth_failed');
assert.ok(!JSON.stringify(s7).includes('secret-answer-text'), '7: 答えの本文を出さない');
await page.goto(`${BASE}/${prefix}/office`);
await page.waitForSelector('[data-banner="mail_failed"]', { timeout: 60000 });
await page.click('[data-banner="mail_failed"]');
await page.waitForSelector('[data-mail-reason="dead"]', { timeout: 30000 });
assert.ok((await page.textContent('[data-mail-reason="dead"]')).includes('auth_failed'));
await shot('stopped');
const n7 = (await mails()).length, c7 = (await fake.got()).connections;
await fake.mode({}); approval(`Mail E2E after dead ${RUN}`); await cycle(2);
assert.equal((await fake.got()).connections, c7, '7: 止まった後は接続しない'); assert.equal((await mails()).length, n7);
await ownerSave(ADDR2, PW2); await ownerPreviewAndOn({ kinds: ['approval'] }); // 保存し直したので、OFF から見本を見て ON
approval(`Mail E2E revived ${RUN}`); await cycle(1);
got = await mails(); assert.equal(got.length, n7 + 1, '7: 保存し直して ON にするとまた届く'); assert.equal(got.at(-1).authUser, ADDR2); assert.deepEqual(parseMail(got.at(-1)).rcpt, [`RCPT TO:<${ADDR2}>`], '7: 新しい宛先へ');
await page.goto(`${BASE}/${prefix}/office`); await sleep(2000);
assert.equal((await page.$('[data-banner="mail_failed"]')) === null, true, '7: 直ると帯が消える');
log('7 ok');

// ---- 8: 1 日の上限（550 5.4.5）→ その日は送らない・OFF にしない・帯と欄「今日の上限」。保存し直すまで接続しない ----
await fake.mode({ end: '550 5.4.5 Daily user sending limit exceeded. secret-limit-text' });
approval(`Mail E2E day ${RUN}`); await cycle(1);
const s8 = await mstatus(); assert.equal(s8.on, true, '8: 上限は OFF にしない'); assert.equal(s8.dayBlocked, true);
await page.goto(`${BASE}/${prefix}/office`); await page.waitForSelector('[data-banner="mail_day"]', { timeout: 60000 });
const c8 = (await fake.got()).connections; await fake.mode({}); approval(`Mail E2E day2 ${RUN}`); await cycle(2);
assert.equal((await fake.got()).connections, c8, '8: その日は接続しない');
await ownerSave(ADDR, PW); await ownerPreviewAndOn({ kinds: ['approval'] }); // 戻す（保存し直しで上限の印も消える）
log('8 ok');

// ---- 9: 4xx（421）→ OFF にせずやり直す（1 分後）。続けての失敗が欄に出て、直った後に届く ----
await fake.mode({ greeting: '421 4.7.0 try again later' });
approval(`Mail E2E retry ${RUN}`); await cycle(1);
const s9 = await mstatus(); assert.equal(s9.on, true); assert.equal(s9.lastFail?.status, 421); assert.equal(s9.lastFail?.ext, '4.7.0'); assert.ok(s9.failStreak >= 1);
const n9 = (await mails()).length; await fake.mode({});
await cycle(1); assert.equal((await mails()).length, n9, '9: 1 分の前は送らない');
await sleep(61_000); await cycle(1);
assert.equal((await mails()).length, n9 + 1, '9: 直った後に届く');
log('9 ok');

// ---- 10: DATA の後で切れる → 1 分後に 1 回だけ再送する（同じ Message-ID なので受け手が見分けられる）。再送が届くと 1 通ずつで終わる ----
await fake.reset(); await fake.mode({ cut: 'end' });
approval(`Mail E2E dup ${RUN}`); await cycle(1);
assert.equal((await mails()).length, 1, '10: 切れても本文は 1 回受け口に届いた');
await fake.mode({}); await sleep(61_000); await cycle(1);
const dup = await mails();
assert.equal(dup.length, 2, '10: 切れた後 1 回だけ再送');
assert.equal(parseMail(dup[0]).headers['Message-ID'], parseMail(dup[1]).headers['Message-ID'], '10: 同じ Message-ID');
await cycle(2); assert.equal((await mails()).length, 2, '10: 届いた後は送らない');
await fake.reset();
log('10 ok');

// ---- 11: 2 社目。A の承認は A の宛先にだけ、B の承認は B の宛先にだけ。B を OFF にすると B は増えない ----
const coB = core('POST', '/companies', { name: `Mail E2E Second ${RUN}` });
await api('POST', `${BASE}/setup/api/mail`, { companyId: coB.id, addr: ADDR_B, pw: PW_B });
const pvB = await api('GET', `${BASE}/setup/api/mail/preview?companyId=${coB.id}&kinds=approval&form=titles`);
assert.equal((await api('POST', `${BASE}/setup/api/mail/confirm`, { companyId: coB.id, kinds: ['approval'], form: 'titles', previewHash: pvB.hash })).on, true);
approval(`Mail E2E only A ${RUN}`); approval(`Mail E2E only B ${RUN}`, coB.id);
await tick(companyId); await tick(coB.id); await mailRound();
const g11 = await mails();
const toA = g11.filter(g => g.authUser === ADDR), toB = g11.filter(g => g.authUser === ADDR_B);
assert.equal(toA.length, 1, '11: A の宛先に A の分だけ'); assert.equal(toB.length, 1, '11: B の宛先に B の分だけ');
assert.ok(parseMail(toA[0]).text.includes('only A') && !parseMail(toA[0]).text.includes('only B'), '11: A に B の題が混ざらない');
assert.ok(parseMail(toB[0]).text.includes('only B') && !parseMail(toB[0]).text.includes('only A'), '11: B に A の題が混ざらない');
assert.deepEqual(parseMail(toB[0]).rcpt, [`RCPT TO:<${ADDR_B}>`]);
await api('POST', `${BASE}/setup/api/mail/off`, { companyId: coB.id });
approval(`Mail E2E B off ${RUN}`, coB.id); await tick(coB.id); await mailRound();
assert.equal((await mails()).filter(g => g.authUser === ADDR_B).length, 1, '11: B を OFF にすると増えない');
await api('POST', `${BASE}/setup/api/mail`, { companyId: coB.id, remove: true });
core('DELETE', `/companies/${coB.id}`); // 後ろの CI の段は会社が 1 社であることを確かめるので消す
log('11 ok');

// ---- 12: 秘密の数え（P3）。偽のアドレスとアプリ パスワードを、起動係のログ・本体のログ・notify の表と state・口の返事・画面の HTML・rounds.json で数えて 0（state.json は置き場なので除く） ----
await openMail(); bodies.push(await page.content());
const count = (label, text) => {
  const n = SECRETS.reduce((a, p) => a + (String(text).split(p).length - 1), 0); log(`12: ${label}: ${n}`);
  if (n) for (const l of String(text).split('\n').filter(l => SECRETS.some(p => l.includes(p))).slice(0, 5)) log(`12: ${label} の行（値は伏せる）: ${SECRETS.reduce((t, p) => t.split(p).join('<S>'), l).slice(0, 300)}`); // どこに出たかを次の失敗で読めるように
  return n;
};
const where = {
  docker_logs: (r => String(r.stdout) + String(r.stderr))(spawnSync('docker', ['logs', CONTAINER], { encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 })),
  plugin_logs: coreRaw('GET', '/plugins/aioffice.notify/logs?limit=1000').text,
  activity: coreRaw('GET', `/companies/${companyId}/activity?limit=500`).text,
  rounds: sh(['exec', CONTAINER, 'cat', '/data/aioffice/rounds.json']),
  notify_tables: sh(['exec', CONTAINER, 'node', '--input-type=module', '-e', `import{readFileSync}from'node:fs';import{createRequire}from'node:module';const r=createRequire('/opt/aioffice/runtime/node_modules/');const pg=r('pg');const c=JSON.parse(readFileSync('/data/paperclip/instances/default/config.json','utf8'));const k=new pg.Client({host:'127.0.0.1',port:c.database?.embeddedPostgresPort||54329,user:'paperclip',password:c.database?.embeddedPostgresPassword||'paperclip',database:'paperclip'});await k.connect();for(const t of ['notices','sends','mail_sends','events']){const x=await k.query('select * from plugin_notify_4b4010a560.'+t);console.log(JSON.stringify(x.rows))}const s=await k.query("select * from plugin_state where plugin_id in (select id from plugins where plugin_key='aioffice.notify')").catch(()=>({rows:[]}));console.log(JSON.stringify(s.rows));const pc=await k.query("select config_json from plugin_config").catch(()=>({rows:[]}));console.log(JSON.stringify(pc.rows));const sec=await k.query("select * from company_secrets").catch(()=>({rows:[]}));console.log(JSON.stringify(sec.rows));await k.end()`]),
  responses: bodies.join('\n'),
};
const total = Object.entries(where).reduce((a, [k, v]) => a + count(k, v), 0);
assert.equal(total, 0, '12: 偽のアドレスとパスワードの文字は、ログ・表・state（plugin）・rounds・口の返事・画面の HTML のどこにも 0');
// 起動係の state.json は置き場: ここに有ること・mode 600 であること
const stateRaw = sh(['exec', CONTAINER, 'cat', '/data/aioffice/state.json']);
assert.ok(stateRaw.includes(PW), '12: パスワードの置き場は起動係の state.json だけ');
assert.equal(sh(['exec', CONTAINER, 'stat', '-c', '%a', '/data/aioffice/state.json']).trim(), '600', '12: state.json は mode 600');
saveState({ addr: ADDR, lastOkAt: (await mstatus()).lastOkAt });
assert.deepEqual(errors, [], 'ページの error が無い');
log('12 ok — all mail e2e passed');
// 後ろの CI の段は試験の網と名前の付け替えの無い container で動くので、本物の Gmail へ送らないよう OFF にして宛先を消す（断る段と入れ直しの確かめに持ち越す時だけ残す）
if (process.env.AIO_MAIL_KEEP !== '1') await removeAll();
await browser.close();
