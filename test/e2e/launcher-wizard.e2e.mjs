// まっさらな container の wizard を実際のブラウザで通す（英語・日本語）。各段を撮る
// 使い方: AIO_BASE=http://localhost:3100 AIO_LANG=en AIO_SHOTS=<撮る先> node test/e2e/launcher-wizard.e2e.mjs
//   PLAYWRIGHT_MODULE で playwright の置き場を、PW_EXE で chromium を指せる。AIO_CODEX=1 の時だけ本物の device login の code を出す（OpenAI へつなぐ）
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { dockerSync } from './docker.mjs';

const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || 'playwright');
const BASE = process.env.AIO_BASE || 'http://localhost:3100';
const LANG = process.env.AIO_LANG === 'ja' ? 'ja' : 'en';
const OUT = process.env.AIO_SHOTS || '';
const PASS = 'e2e-owner-password', EMAIL = process.env.AIO_OWNER_EMAIL || 'owner@example.test', CONTAINER = process.env.AIO_CONTAINER || 'aioffice';
const T = {
  en: { company: 'Sample Studio', step: { lang: 'Language', owner: 'Owner account', company: 'Company name', ai: 'Choose your AI', secretary: 'Secretary', agents: 'More AI employees', folder: 'Your files', done: 'Done' }, login: 'Sign in with your office account.' },
  ja: { company: 'サンプル工房', step: { lang: 'Language', /* 言語を選ぶ前は英語 */ owner: '持ち主のアカウント', company: '会社の名前', ai: '使う AI を選ぶ', secretary: '秘書', agents: 'ほかの AI 社員', folder: '手元の文書', done: '完了' }, login: 'オフィスのアカウントでサインインしてください。' },
}[LANG];

if (OUT) fs.mkdirSync(OUT, { recursive: true });
const browser = await chromium.launch(process.env.PW_EXE ? { executablePath: process.env.PW_EXE } : {});
const errors = [];
const ctx = await browser.newContext({ viewport: { width: 1100, height: 760 }, locale: LANG === 'ja' ? 'ja-JP' : 'en-US' });
const page = await ctx.newPage();
page.on('pageerror', e => errors.push(String(e)));
// 診断: wizard の口の 2xx 以外の応答を書き出す（段が進まない時に、断られたのか・落ちたのかを CI のログで分ける・2026-11-25 の arm64）
page.on('response', async r => { if (r.url().includes('/setup/api/') && r.status() >= 300) console.error(`wizard の口: ${r.request().method()} ${new URL(r.url()).pathname} ${r.status()} ${(await r.text().catch(() => '')).slice(0, 200)}`); });
let n = 0;
const shot = async name => { if (OUT) await page.screenshot({ path: path.join(OUT, `${LANG}_${String(++n).padStart(2, '0')}-${name}.png`) }); };
const onStep = async id => { await page.waitForSelector(`section[data-step="${id}"]`); assert.equal(await page.textContent(`section[data-step="${id}"] h2`), T.step[id], `${id} の見出し`); assert.doesNotMatch(await page.textContent('#app'), /null|undefined/, `${id} に null・undefined の文字が出ない`); assert.equal((await page.$('.warn')) === null, true, 'volume の警告が出ない（名前つきの volume）'); };

await page.goto(`${BASE}/`);
assert.match(page.url(), /\/setup\/$/, '最初の画面は wizard');
await onStep('lang'); assert.equal(await page.textContent('h1'), 'Set up your AI office', '言語を選ぶ前は英語'); await shot('lang');
await page.click(`[data-lang="${LANG}"]`);
await onStep('owner'); assert.equal(await page.getAttribute('html', 'lang'), LANG);
// 最初の持ち主: docker logs の code（container を起こした人だけが見られる）・名前・メール・パスワード（設計 docs/design/2026-11-23-public-office-multi-user.md 2.3）
const code = String(dockerSync(['exec', CONTAINER, 'cat', '/data/aioffice/claim-code'], { encoding: 'utf8' })).trim();
await page.fill('#code', code); await page.fill('#oname', LANG === 'ja' ? '持ち主' : 'Owner'); await page.fill('#email', EMAIL);
await page.fill('#pw1', PASS); await page.fill('#pw2', `${PASS}x`); await page.click('#owner-next');
await page.waitForFunction(() => document.querySelector('.err')?.textContent);
await page.fill('#pw2', PASS); await shot('owner');
await page.click('#owner-next');
await onStep('company'); await page.fill('#company', T.company); await shot('company');
await page.click('#company-next');
// 使う AI を選ぶ段（docs/review/2026-11-17-wizard-ai-choice-scope.md の保証 1）: ChatGPT と Claude の両方が出て、1 つに決め打ちしない
await onStep('ai');
await page.waitForSelector('#ai-list [data-ai="chatgpt"]', { timeout: 60000 });
assert.ok(await page.$('#ai-list [data-ai="claude"]'), 'Claude の行がある');
assert.ok(await page.$('#ai-list [data-ai-install="claude_local"]'), 'Claude はダウンロードのボタンから始まる（image に入れない）');
await shot('ai');
if (process.env.AIO_CODEX === '1') {
  await page.click('[data-ai-connect="codex_local"]');
  await page.waitForSelector('#codex-code', { timeout: 60000 });
  assert.match(await page.textContent('#codex-code'), /^[A-Z0-9]{4}-[A-Z0-9]{4,6}$/);
  assert.match(await page.getAttribute('#codex-url', 'href'), /^https:\/\/auth\.openai\.com\//);
  await shot('codex-code');
}
await page.click('#ai-later');
await onStep('secretary'); await shot('secretary');
await page.click('#secretary-next');
await onStep('agents');
const boxes = await page.$$eval('section[data-step="agents"] .choice b', els => els.map(e => e.textContent));
assert.deepEqual(boxes, LANG === 'ja' ? ['デザイン課', '調べもの係'] : ['Design Desk', 'Research Desk']);
await page.check('input[value="design"]'); await shot('agents');
await page.click('#agents-next');

// 手元の文書の段（docs/review/2026-11-17-wizard-folder-scope.md の保証 1・2・5）: フォルダを選ぶ → 1 回目はわざと落とす → やり直す → 図書室に入って検索で当たる
await onStep('folder');
await page.waitForSelector('#folder-input:not([disabled])', { timeout: 180000 }); // 図書室の plugin が入るまでは選ぶ欄が出ない
const pick = fs.mkdtempSync(path.join(os.tmpdir(), 'aio-folder-'));
const notes = path.join(pick, 'notes');
for (const [rel, text] of [['a/README.md', '# Brand\nOur palette word is zephyrpalette.'], ['b/README.md', '# Books\nThe ledger word is quokkaledger.'], ['guide.txt', 'Opening hours are 9 to 5.'], ['.hidden/secret.md', 'hidden'], ['logo.png', 'not text']]) {
  fs.mkdirSync(path.dirname(path.join(notes, rel)), { recursive: true }); fs.writeFileSync(path.join(notes, rel), text);
}
await page.setInputFiles('#folder-input', notes);
await page.waitForSelector('[data-folder-ready]');
assert.equal(await page.getAttribute('[data-folder-ready]', 'data-folder-ready'), '3', '.md と .txt の 3 件（隠しフォルダと .png は送らない）');
assert.deepEqual((await page.$$eval('[data-folder-skipped] li', els => els.map(e => e.getAttribute('data-why')))).sort(), ['hidden', 'type']);
await shot('folder-picked');
await page.route('**/setup/api/library/folder', r => r.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ error: 'busy' }) }), { times: 1 });
await page.click('#folder-put');
await page.waitForFunction(() => document.querySelector('section[data-step="folder"] .err')?.textContent);
assert.equal(await page.isEnabled('#folder-put'), true, '失敗した後はもう一度押せる');
assert.equal(await page.isEnabled('#folder-input'), true, '失敗した後は選び直せる');
await shot('folder-failed');
await page.click('#folder-put');
await page.waitForSelector('[data-folder-done]', { timeout: 60000 });
assert.equal(await page.getAttribute('[data-folder-done]', 'data-folder-done'), '3', '3 件とも図書室に入った');
await shot('folder-done');
await page.click('#folder-next');
await onStep('done'); await shot('done');
const wiz = await (await page.request.get(`${BASE}/setup/api/state`)).json();
for (const [q, name] of [['zephyrpalette', 'notes › a › README.md'], ['quokkaledger', 'notes › b › README.md']]) {
  const r = await (await page.request.get(`${BASE}/api/plugins/aioffice.library/api/search?companyId=${encodeURIComponent(wiz.company.id)}&q=${q}`)).json();
  assert.ok((r.results || []).some(x => x.title === name || String(x.srcId).endsWith(name)), `検索で当たる: ${q} → ${JSON.stringify((r.results || []).map(x => [x.srcId, x.title]))}`);
}
// 後の図書室の点検（L6・L7）と再インストールの記録の対象を変えないよう、入れた 3 件を外す（独立レビュー P3-2・P3-3）
for (const name of ['notes › a › README.md', 'notes › b › README.md', 'notes › guide.txt']) {
  const r = await page.request.post(`${BASE}/api/plugins/aioffice.library/api/documents/remove?companyId=${encodeURIComponent(wiz.company.id)}`, { headers: { origin: BASE, 'content-type': 'application/json' }, data: { name } });
  assert.ok(r.ok(), `外す: ${name} → ${r.status()}`);
}
const left = await (await page.request.get(`${BASE}/api/plugins/aioffice.library/api/documents?companyId=${encodeURIComponent(wiz.company.id)}`)).json();
assert.deepEqual((left.documents || []).map(d => d.name).filter(n => n.startsWith('notes › ')), [], '入れた 3 件は外れた（独立レビュー P3-5）');
fs.rmSync(pick, { recursive: true, force: true });

await Promise.all([page.waitForNavigation(), page.click('#open-office')]);
await page.waitForLoadState('networkidle', { timeout: 30000 }).catch(() => {});
await page.waitForTimeout(1500);
assert.doesNotMatch(page.url(), /\/onboarding|\/setup/, `本体の初回の案内へ送られない: ${page.url()}`);
const body = await page.textContent('body');
assert.ok(body.includes(T.company), '本体の画面に会社の名前が出る');
assert.ok(!/Create your first agent/i.test(body), '担当を作る案内が出ない');
await shot('office');

// cookie の無いブラウザは本体へ通らず、合言葉の入力になる
const other = await browser.newContext({ viewport: { width: 1100, height: 760 } });
const p2 = await other.newPage();
await p2.goto(`${BASE}/`);
assert.match(p2.url(), /\/setup\/$/);
await p2.waitForSelector('#login');
assert.equal(await p2.textContent('section[data-step="owner"] p'), T.login);
if (OUT) await p2.screenshot({ path: path.join(OUT, `${LANG}_${String(++n).padStart(2, '0')}-login-other-browser.png`) });
const api = await p2.request.get(`${BASE}/api/companies`);
assert.ok([302, 401, 403].includes(api.status()) || api.url().endsWith('/setup/'), 'session なしで本体の API に届かない');

assert.deepEqual(errors, [], 'ページの JS のエラーが無い');
await browser.close();
console.log(`ok ${LANG}: wizard → office (${n} shots)`);
