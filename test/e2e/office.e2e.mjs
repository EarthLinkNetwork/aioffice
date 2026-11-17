// wizard の後のオフィスの画面を実際のブラウザで通す（英語・日本語）。範囲の文書の保証 9。各段を撮る
// 使い方: AIO_BASE=http://localhost:3100 AIO_LANG=en AIO_CONTAINER=aioffice AIO_SHOTS=<撮る先> node test/e2e/office.e2e.mjs
//   PLAYWRIGHT_MODULE・PW_EXE は wizard の e2e と同じ。AIO_CODEX=1 の時だけ「AI の契約をつなぐ」で本物の code を出す
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { DICT, ABOUT } from '../../plugins/office/src/i18n.mjs';
import { dockerSync } from './docker.mjs';

const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || 'playwright');
const BASE = process.env.AIO_BASE || 'http://localhost:3100';
const LANG = process.env.AIO_LANG === 'ja' ? 'ja' : 'en';
const OTHER = LANG === 'ja' ? 'en' : 'ja';
const CONTAINER = process.env.AIO_CONTAINER || 'aioffice';
const OUT = process.env.AIO_SHOTS || '';
const PASS = process.env.AIO_PASS || 'e2e-owner-password';
const D = DICT[LANG];
const prepScript = fs.readFileSync(new URL('./office-prep.mjs', import.meta.url), 'utf8');

if (OUT) fs.mkdirSync(OUT, { recursive: true });
const browser = await chromium.launch(process.env.PW_EXE ? { executablePath: process.env.PW_EXE } : {});
const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, locale: LANG === 'ja' ? 'ja-JP' : 'en-US' });
const errors = [];
const page = await ctx.newPage();
page.on('pageerror', e => errors.push(String(e)));
let n = 0;
const shot = async name => { if (OUT) await page.screenshot({ path: path.join(OUT, `${LANG}_office_${String(++n).padStart(2, '0')}-${name}.png`) }); };
const closePanel = async () => { await page.click('[data-panel] [data-close]'); await page.waitForSelector('[data-panel]', { state: 'detached' }); };

// 見た目の確かめ（範囲 docs/review/2026-11-18-office-ai-panel-ux-scope.md G3・F5・F6）。色はブラウザが計算した値を canvas で sRGB にして比べる
// - オフィスの中の全部の a: ボタンの形のリンク（aio-btn）以外は下線あり・色が本文と違う
// - 文字と、その後ろの背景（透明なら親をたどって重ねる）の明るさの比が 4.5 以上
const looks = sel => page.evaluate(sel => {
  const cv = document.createElement('canvas'); cv.width = cv.height = 1; const g = cv.getContext('2d', { willReadFrequently: true });
  const rgba = c => { g.clearRect(0, 0, 1, 1); g.fillStyle = '#000'; g.fillStyle = c; g.fillRect(0, 0, 1, 1); const [r, gg, b, a] = g.getImageData(0, 0, 1, 1).data; return [r, gg, b, a / 255]; };
  const over = (top, under) => [0, 1, 2].map(i => top[i] * top[3] + under[i] * (1 - top[3])).concat(1);
  const bgOf = el => { const layers = []; for (let e = el; e; e = e.parentElement) { const c = rgba(getComputedStyle(e).backgroundColor); if (c[3] > 0) layers.push(c); if (c[3] >= 1) break; } let base = [255, 255, 255, 1]; for (const l of layers.reverse()) base = over(l, base); return base; };
  const lum = ([r, gg, b]) => { const f = v => { v /= 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; }; return 0.2126 * f(r) + 0.7152 * f(gg) + 0.0722 * f(b); };
  const ratio = (a, b) => { const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p); return (x + 0.05) / (y + 0.05); };
  const root = document.querySelector('[data-office="root"]'), body = rgba(getComputedStyle(root).color);
  // 押せないボタン（disabled）は文字の比の対象の外（WCAG 1.4.3 の例外）
  return [...document.querySelectorAll(sel)].filter(el => el.offsetParent !== null && el.textContent.trim() && !el.closest('button:disabled, select:disabled')).map(el => {
    const cs = getComputedStyle(el), bg = bgOf(el), fg = over(rgba(cs.color), bg);
    return { tag: el.tagName.toLowerCase(), text: el.textContent.trim().slice(0, 40), endsExt: el.textContent.trim().endsWith('↗'), button: el.classList.contains('aio-btn'), underline: cs.textDecorationLine.includes('underline'),
      sameAsBody: Math.abs(fg[0] - body[0]) + Math.abs(fg[1] - body[1]) + Math.abs(fg[2] - body[2]) < 30, ratio: Math.round(ratio(fg, bg) * 100) / 100, external: el.getAttribute('target') === '_blank', rel: el.getAttribute('rel') };
  });
}, sel);
let linksSeen = 0;
const checkLinks = async where => {
  const list = await looks('[data-office="root"] a');
  for (const x of list) {
    if (!x.button) { assert.ok(x.underline, `${where}: リンクに下線 ${x.text}`); assert.ok(!x.sameAsBody, `${where}: リンクの色が本文と違う ${x.text}`); }
    assert.ok(x.ratio >= 4.5, `${where}: リンクの文字と背景の比 ${x.ratio} ${x.text}`);
    if (x.external) { assert.equal(x.rel, 'noopener noreferrer', `${where}: ${x.text}`); assert.ok(x.endsExt, `${where}: 外へ開くリンクに ↗ ${x.text}`); }
  }
  linksSeen += list.length; return list.length;
};
const checkContrast = async (where, sel = '[data-panel] a, [data-panel] button, [data-panel] p, [data-panel] .aio-badge, [data-panel] h2, [data-panel] h3') => {
  const list = await looks(sel);
  assert.ok(list.length > 0, `${where}: 調べる文字がある`);
  const low = list.filter(x => x.ratio < 4.5);
  assert.deepEqual(low, [], `${where}: 明るさの比が 4.5 より低い文字`);
};

// 持ち主として入る（同じ Origin）
const login = await ctx.request.post(`${BASE}/setup/api/login`, { data: { password: PASS }, headers: { origin: BASE } });
assert.equal(login.status(), 200, 'ログイン');
const state = await (await ctx.request.get(`${BASE}/setup/api/state`)).json();
assert.equal(state.lang, LANG); assert.equal(state.office, 'ready', 'オフィスの plugin が ready');
const prefix = state.company.prefix, companyId = state.company.id;
assert.ok(prefix && state.agents.design, '会社の prefix とデザインの担当が state にある');

// 1. 画面が開き、担当の一覧に 2 人・見出しは選んだ言語
await page.goto(`${BASE}/${prefix}/office`);
await page.waitForSelector('[data-office="root"] [data-people] li', { timeout: 60000 });
assert.equal(await page.textContent('[data-office="root"] h1'), D.title);
assert.equal(await page.$$eval('[data-people] li', els => els.length), 2, '担当は秘書とデザインの 2 人');
await page.waitForTimeout(1500); await shot('office');

// 1b. オフィスに戻る道（G4・F3・F4）: 本体の横の一覧に Office の入口があり、押すとオフィス。ログイン後に / を開くとオフィス
await page.goto(`${BASE}/${prefix}/dashboard`);
const nav = await page.waitForSelector('[data-office-nav]', { timeout: 60000 });
assert.equal(await nav.getAttribute('href'), `/${prefix}/office`);
assert.equal((await nav.textContent()).trim(), D.sidebar_office);
await shot('sidebar');
await Promise.all([page.waitForURL(`**/${prefix}/office`), nav.click()]);
await page.waitForSelector('[data-office="root"] [data-people] li', { timeout: 60000 });
await page.goto(`${BASE}/`);
assert.equal(new URL(page.url()).pathname, `/${prefix}/office`, 'ログイン後の / はオフィスへ');
await page.waitForSelector('[data-office="root"] [data-people] li', { timeout: 60000 });

// 2. 各部屋の「ここでできること」
for (const room of Object.keys(ABOUT)) {
  await page.click(`[data-room="${room}"]`);
  await page.waitForSelector(`[data-about="${room}"]`);
  assert.equal(await page.textContent(`[data-panel="about-${room}"] h2`), D[ABOUT[room][0]]);
  assert.deepEqual(await page.$$eval(`[data-about="${room}"] li`, els => els.map(e => e.textContent)), ABOUT[room][1].map(k => D[k]));
  await shot(`about-${room}`);
  await closePanel();
}


// 3. デザインの依頼: 画面から 1 件。同じ依頼をもう一度送ると同じ課題。別の依頼を同時に 2 回送っても 1 件
await page.click('[data-room="design"]');
await page.fill('[data-design-name]', LANG === 'ja' ? 'サンプル工房' : 'Sample Studio');
await page.fill('[data-design-brief]', LANG === 'ja' ? '丸い形・緑' : 'Round, green');
await page.click('[data-design-send]');
await page.waitForSelector('[data-design-result="design_sent"]'); await shot('design-sent');
await page.click('[data-design-send]');
await page.waitForSelector('[data-design-result="design_already"]');
const par = await page.evaluate(async ({ companyId, agentId, lang }) => {
  const send = () => fetch(`/api/plugins/aioffice.design/api/request?companyId=${encodeURIComponent(companyId)}`, { method: 'POST', credentials: 'same-origin', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ kind: 'flyer', name: 'Open day', brief: '', agentId, lang }) }).then(async r => ({ status: r.status, body: await r.json() }));
  return Promise.all([send(), send()]);
}, { companyId, agentId: state.agents.design, lang: LANG });
assert.deepEqual(par.map(r => r.status).sort(), [200, 201], `同時の 2 回: ${JSON.stringify(par)}`);
assert.equal(par[0].body.issue.id, par[1].body.issue.id, '同時の 2 回は同じ課題');
const designIssues = (await (await ctx.request.get(`${BASE}/api/companies/${companyId}/issues`)).json()).filter(i => i.originKind === 'plugin:aioffice.design:request');
assert.equal(designIssues.length, 2, 'デザインの課題はロゴ 1 件・チラシ 1 件');
assert.ok(designIssues.every(i => i.assigneeAgentId === state.agents.design));
await closePanel();

// 4. AI の契約の欄（G1・G2・F7）: AI の一覧と社員ごとの AI。押した直後から処理中、返すと欄の中に結果の文
await page.click('[data-open="connect"]');
await page.waitForSelector('[data-panel="connect"] [data-ai-list]', { timeout: 60000 });
await page.waitForSelector('[data-panel="connect"] [data-assign-list]', { timeout: 60000 });
// 並び（独立レビュー r2 の 8）: 社員ごとの AI が一番上、AI の一覧はその下。まだつないでいない AI は「ほかの AI をつなぐ（n）」の開閉の中
assert.ok(await page.$eval('[data-panel="connect"] [data-assign-list]', el => !!(el.compareDocumentPosition(document.querySelector('[data-panel="connect"] [data-ai-list]')) & Node.DOCUMENT_POSITION_FOLLOWING)), '社員ごとの AI が AI の一覧より上');
const moreSel = '[data-panel="connect"] [data-ai-more]';
const anyConnected = !!(await page.$('[data-panel="connect"] [data-ai-main] [data-ai-state="connected"]'));
assert.equal(await page.getAttribute(moreSel, 'aria-expanded'), anyConnected ? 'false' : 'true', 'つないだ AI が無い時だけ開いている');
if (anyConnected) await page.click(moreSel);
assert.equal(await page.getAttribute(moreSel, 'aria-expanded'), 'true');
assert.ok(await page.$('[data-ai="codex_local"]') && await page.$('[data-ai="claude_local"]'), 'ChatGPT と Claude の行');
assert.ok(await page.$$eval('[data-assign]', els => els.length) >= 2, '社員ごとの AI の欄（秘書とデザイン）');
assert.equal(await page.getAttribute('[data-open="connect"]', 'aria-pressed'), 'true', '開いている欄の見出しのボタンは押された形');
await checkContrast('AI の契約の欄'); await shot('ai-panel');
// 処理中: Playwright の route で応答を止めている間に aria-busy・押せない・「処理中…」。止めた要求は本体へ流さずに返す（時間の閾値は使わない）
let release;
const heldRoute = new Promise(r => { release = r; });
const hold = route => release(route);
await page.route('**/setup/api/ai/install', hold); await page.route('**/setup/api/ai/start', hold);
const busySel = await page.$eval('[data-panel="connect"] [data-ai-install], [data-panel="connect"] [data-ai-connect]', el => (el.hasAttribute('data-ai-install') ? `[data-ai-install="${el.getAttribute('data-ai-install')}"]` : `[data-ai-connect="${el.getAttribute('data-ai-connect')}"]`));
await page.click(busySel);
const route = await heldRoute;
const during = await page.$eval(busySel, el => ({ busy: el.getAttribute('aria-busy'), disabled: el.disabled, text: el.textContent }));
assert.deepEqual([during.busy, during.disabled], ['true', true], '止めている間は aria-busy で押せない');
assert.ok(during.text.includes(D.busy), `「処理中」: ${during.text}`);
assert.equal((await page.$('[data-ai-result]')) === null, true, '返すまで結果の文は出ない');
await shot('ai-busy');
await route.fulfill({ status: 409, contentType: 'application/json', body: JSON.stringify({ error: 'ai_install_first' }) });
await page.waitForSelector('[data-ai-result="ai_r_install_first"]');
assert.equal(await page.textContent('[data-ai-result]'), D.ai_r_install_first);
assert.equal(await page.getAttribute(busySel, 'aria-busy'), null, '返すと処理中を外す');
await page.unroute('**/setup/api/ai/install', hold); await page.unroute('**/setup/api/ai/start', hold);
if (process.env.AIO_CODEX === '1') {
  await page.waitForSelector('[data-codex-start], [data-codex-code], [data-ai-reconnect="codex_local"]');
  if (await page.$('[data-codex-start]')) await page.click('[data-codex-start]');
  else if (await page.$('[data-ai-reconnect="codex_local"]')) await page.click('[data-ai-reconnect="codex_local"]'); // つないである時は「つなぎ直す」で code を出す // wizard で出した code がまだ生きていれば、そのまま出る
  await page.waitForSelector('[data-codex-code]', { timeout: 60000 });
  assert.match(await page.textContent('[data-codex-code]'), /^[A-Z0-9]{4}-[A-Z0-9]{4,6}$/);
  assert.match(await page.getAttribute('[data-codex-url]', 'href'), /^https:\/\/auth\.openai\.com\//);
  await checkLinks('ChatGPT の code'); await shot('connect-code');
  await page.click('[data-ai-cancel="codex_local"]');
} else {
  assert.ok(await page.$('[data-codex-start]'), 'ChatGPT をつなぐボタン'); await shot('connect');
}
await closePanel();

// 5. 仕事の掲示 → 課題の中身・担当の仕事・記録
await page.click('[data-open="tasks"]');
await page.waitForSelector('[data-panel="tasks"] [data-issue]'); await shot('tasks');
await page.click('[data-panel="tasks"] [data-issue] button');
await page.waitForSelector(`[data-panel="issue"] a[href^="/${prefix}/issues/"]`); await shot('issue');
await checkLinks('課題の中身');
await closePanel();
await page.click(`[data-people] [data-agent="${state.agents.design}"] button`);
await page.waitForSelector('[data-panel="agent"] [data-issue]'); await shot('agent');
await closePanel();
await page.click('[data-open="log"]');
await page.waitForSelector('[data-panel="log"] [data-activity]'); await shot('log');
await closePanel();

// 6. 受信箱（準備は担当の実行を失敗で残すので、オフィスの画面を撮った後にする）
const prep = JSON.parse(dockerSync(['exec', '-i', CONTAINER, 'node', '--input-type=module', '-'], { input: prepScript, encoding: 'utf8', timeout: 120000 }).trim().split('\n').pop());
await page.reload();
await page.waitForSelector('[data-inbox-count="3"]', { timeout: 30000 });
await page.click('[data-open="inbox"]');
await page.waitForSelector(`[data-decision="${prep.decision}"] [data-option="a"]`);
assert.ok(await page.$(`[data-approval="${prep.approvals[0]}"] a[href="https://example.com/1"]`), 'AI の文の http(s) は link');
await shot('inbox');
assert.ok(await checkLinks('受信箱') >= 2, '受信箱の AI の文のリンク');
await checkContrast('受信箱');
await page.fill(`[data-note="${prep.approvals[0]}"]`, LANG === 'ja' ? '進めてください' : 'Go ahead');
await page.click(`[data-approve="${prep.approvals[0]}"]`);
await page.click(`[data-reject="${prep.approvals[1]}"]`);
await page.click(`[data-decision="${prep.decision}"] [data-option="a"]`);
for (const [sel, key] of [[`[data-approval="${prep.approvals[0]}"]`, 'decided_approved'], [`[data-approval="${prep.approvals[1]}"]`, 'decided_rejected'], [`[data-decision="${prep.decision}"]`, 'decided_done']])
  assert.equal(await (await page.waitForSelector(`${sel} [data-done]`)).textContent(), D[key]);
await shot('inbox-done');
const ap = await (await ctx.request.get(`${BASE}/api/companies/${companyId}/approvals`)).json();
assert.deepEqual(prep.approvals.map(id => ap.find(a => a.id === id)?.status), ['approved', 'rejected']);
assert.equal(ap.find(a => a.id === prep.approvals[0]).decisionNote, LANG === 'ja' ? '進めてください' : 'Go ahead');
const de = await (await ctx.request.get(`${BASE}/api/companies/${companyId}/decisions?status=decided`)).json();
assert.equal(de.find(d => d.id === prep.decision)?.chosenOptionId, 'a');
await closePanel();

// 6b. 準備で置いた偽の auth.json で、AI の契約の欄の ChatGPT の行が「つながっている」（F7）。暗い画面（本体の .dark）でも文字と背景の比が 4.5 以上（F5）
await page.click('[data-open="connect"]');
await page.waitForSelector('[data-panel="connect"] [data-ai="codex_local"][data-ai-state="connected"]', { timeout: 30000 });
assert.equal((await page.textContent('[data-ai="codex_local"] [data-ai-connected]')).trim(), D.ai_s_connected);
// 欄を開き直すと起動係の一覧（connected() は auth.json をその都度読む）を読み直すので、偽の auth.json の後は担当ごとの select の全部で ChatGPT を選べる
const assignOpts = await page.$$eval('[data-panel="connect"] select[data-assign]', els => els.map(s => ({ disabled: s.disabled, codex: [...s.options].some(o => o.value === 'codex_local' && !o.disabled) })));
assert.ok(assignOpts.length >= 2, `担当ごとの select: ${JSON.stringify(assignOpts)}`);
assert.ok(assignOpts.every(o => !o.disabled && o.codex), `割り当ての欄で ChatGPT を選べる: ${JSON.stringify(assignOpts)}`);
assert.ok(await page.$('[data-panel="connect"] [data-ai-main] [data-ai="codex_local"] [data-ai-reconnect="codex_local"]'), 'つないだ AI は上の段に、つなぎ直すボタンつきで出る');
assert.equal(await page.getAttribute('[data-panel="connect"] [data-ai-more]', 'aria-expanded'), 'false', 'つないだ AI がある時、ほかの AI は閉じている');
assert.equal((await page.$('[data-panel="connect"] [data-ai-others]')) === null, true);
await shot('ai-connected');
await page.evaluate(() => document.documentElement.classList.add('dark'));
await page.waitForFunction(() => document.getAnimations().filter(a => a instanceof CSSTransition).length === 0); // 色の移り変わり（transition）が終わってから測る
await checkContrast('暗い画面の AI の契約の欄'); await shot('ai-dark');
await page.evaluate(() => document.documentElement.classList.remove('dark'));
await closePanel();

// 7. 言語の切り替え（起動係に保存される）→ 戻す
await page.selectOption('[data-lang]', OTHER);
await page.waitForFunction(t => document.querySelector('[data-office="root"] h1')?.textContent === t, DICT[OTHER].title);
assert.equal((await (await ctx.request.get(`${BASE}/setup/api/state`)).json()).lang, OTHER);
await shot(`lang-${OTHER}`);
await page.selectOption('[data-lang]', LANG);
await page.waitForFunction(t => document.querySelector('[data-office="root"] h1')?.textContent === t, D.title);

// 8. 別の port の Origin からの読みに access-control-* が付かない（起動係の中継が落とす）
const cors = await ctx.request.get(`${BASE}/api/companies`, { headers: { origin: 'http://localhost:9999' } });
assert.deepEqual(Object.keys(cors.headers()).filter(k => k.startsWith('access-control-')), []);

assert.ok(linksSeen >= 3, `オフィスの中のリンクを見た数: ${linksSeen}`);
assert.deepEqual(errors, [], 'ページの JS のエラーが無い');
await browser.close();
console.log(`ok ${LANG}: office (${n} shots)`);
