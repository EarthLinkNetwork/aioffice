// AI の使用量の上限の e2e（範囲 docs/review/2026-11-18-ai-usage-limit-scope.md（開発元の記録）の 8 節の e2e のシナリオ 1〜7・9〜12 と 1b（追加料金の扱いの設定）。
// 本物の Paperclip と notify・office・起動係で回す。知らせの e2e の後に流す。
//
// 前提（container の起こし方）: 起動係の試験用の差し替え口（POST /setup/api/test/ai-limits）は、CI だけが付ける env
// AIOFFICE_CI_TEST_HOOKS=1 がある時だけ開く（launcher/lib/limits.mjs の TEST_HOOK_ENV）。RUN.txt の行には無いので、この e2e の前に
// 同じ volume で container を env つきで起こし直す（終わったら RUN.txt の行で起こし直す・container-stage.sh の「AI の使用量の上限」の段）:
//   docker rm -f aioffice
//   docker run -d --name aioffice --stop-timeout 60 -p 127.0.0.1:3100:3100 -v aioffice:/data -e AIOFFICE_CI_TEST_HOOKS=1 ghcr.io/earthlinknetwork/aioffice:<TAG>
// 使い方: AIO_BASE=http://localhost:3100 AIO_LANG=en AIO_CONTAINER=aioffice AIO_SHOTS=<撮る先> node test/e2e/limits.e2e.mjs
//   PLAYWRIGHT_MODULE・PW_EXE は wizard の e2e と同じ。AIO_LIMIT_G5_SEC（既定 30）は上限の失敗の run の終わりから担当が paused になるまでの上限の秒数
//
// 作り:
// - claude の CLI は test/e2e/stubs/claude-quota-cli（配る image には入れない）を docker cp で container の /tmp にだけ写し、担当の adapterConfig の
//   command で指す（engine=cli）。出す形は担当ごとの env AIO_STUB_CONFIG の JSON で選ぶ（シナリオごとに別の file・別の契約）
// - 契約はシナリオごとに別の秘密（CLAUDE_CODE_OAUTH_TOKEN の secret_ref）にする。起動係は secret_ref の id で同じ契約をまとめる
// - ChatGPT の使用率（quota-windows）は差し替え口で流す。Claude の使用率は stub が出す rate_limit_event を本物の本体のログの口を通して読む
// - 見回りを待たずに回す口は起動係に無い。起動係は毎分 <data>/aioffice/rounds.json の lastRunAt を見て 5 分ごとに回すので、
//   lastRunAt を消して次の毎分の確かめで回させる（forceRound。待ちは 1 分ほど）
// - 「始まった run」は startedAt が null でない run で数える（行の数では数えない・8 節）
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { DICT } from '../../plugins/office/src/i18n.mjs';
import { defaultAiLimits, TEST_HOOK_ENV } from '../../packages/aioffice/launcher/lib/limits.mjs';
import { dockerSync } from './docker.mjs';

const RUN = Date.now().toString(36); // 回ごとの印（前の回の物と取り違えない）
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || 'playwright');
const BASE = process.env.AIO_BASE || 'http://localhost:3100';
const LANG = process.env.AIO_LANG === 'ja' ? 'ja' : 'en';
const C = process.env.AIO_CONTAINER || 'aioffice';
const OUT = process.env.AIO_SHOTS || '';
const PASS = process.env.AIO_PASS || 'e2e-owner-password', EMAIL = process.env.AIO_OWNER_EMAIL || 'owner@example.test';
const G5_SEC = Number(process.env.AIO_LIMIT_G5_SEC) || 30;
const D = DICT[LANG];
const HERE = path.dirname(fileURLToPath(import.meta.url));
const STUB_SRC = path.join(HERE, 'stubs', 'claude-quota-cli');
const STUB_DIR = '/tmp/aio-limits-e2e';
const STUB = `${STUB_DIR}/claude-quota-cli`;
const sleep = ms => new Promise(r => setTimeout(r, ms));
const log = (...a) => console.log('[limits e2e]', ...a);
const iso = sec => new Date(sec * 1000).toISOString();
const hourKey = sec => iso(sec).slice(0, 13); // notify の知らせの key の時間（resetsAt を時間で丸めた値）
// 先の時刻（epoch 秒・時間ちょうど）。シナリオごとに時間をずらし、知らせの key を分ける
const futureHour = hours => Math.ceil(Date.now() / 3600000) * 3600 + hours * 3600;

// ---- docker・本体 ----
const dx = (args, opts = {}) => dockerSync(args, { encoding: 'utf8', timeout: 120000, ...opts });
const node = (js, ...argv) => dx(['exec', C, 'node', '--input-type=module', '-e', js, ...argv]).trim();
// container の中から本体（127.0.0.1:3101・ログイン無しのモード）に直に頼む（担当・課題・秘密を作るなど、持ち主の画面に無い準備だけ）
function core(method, p, body, { allow = false } = {}) {
  const js = `const K=await(async()=>{try{const f=await import('node:fs');return 'Bearer '+JSON.parse(f.readFileSync('/data/aioffice/board-key.json','utf8')).token}catch{return null}})();const r=await fetch('http://127.0.0.1:3101/api'+process.argv[1],{method:process.argv[2],headers:{'content-type':'application/json',...(K?{authorization:K}:{})},body:process.argv[3]||undefined});const t=await r.text();console.log(JSON.stringify({s:r.status,t}))`;
  const { s, t } = JSON.parse(node(js, p, method, body ? JSON.stringify(body) : '').split('\n').pop());
  let j = null; try { j = JSON.parse(t); } catch { j = null; }
  if (allow) return { s, j };
  if (s >= 400) throw new Error(`${method} ${p} → ${s} ${t.slice(0, 300)}`);
  return j;
}
// plugin の CLI にも起動係の鍵を渡す（container の中で file から読み、引数には出さない）
const cli = args => dx(['exec', C, 'sh', '-c', 'PAPERCLIP_API_KEY=$(node -p "JSON.parse(require(\'fs\').readFileSync(\'/data/aioffice/board-key.json\',\'utf8\')).token") exec paperclipai plugin "$@"', 'sh', ...args, '--api-base', 'http://127.0.0.1:3101', '--json', '-d', '/data/paperclip']);
const writeJson = (file, obj) => node(`import{writeFileSync,mkdirSync,renameSync}from'node:fs';import{dirname}from'node:path';mkdirSync(dirname(process.argv[1]),{recursive:true});writeFileSync(process.argv[1]+'.tmp',process.argv[2]);renameSync(process.argv[1]+'.tmp',process.argv[1])`, file, JSON.stringify(obj));
// stub の出す形（シナリオごとの file）
const stubCfg = (name, cfg) => writeJson(`${STUB_DIR}/${name}.json`, cfg);
const pluginsReady = () => { try { const j = JSON.parse(dx(['exec', C, 'cat', '/data/aioffice/plugins.json'])); return ['aioffice.notify', 'aioffice.office'].every(k => j[k]?.status === 'ready'); } catch { return false; } };
async function waitUp() {
  for (let i = 0; i < 120; i++) {
    let ok = false; try { node(`const r=await fetch('http://127.0.0.1:3101/api/health');process.exit(r.ok?0:1)`); ok = true; } catch { ok = false; }
    if (ok && pluginsReady()) return;
    await sleep(2000);
  }
  throw new Error('本体か plugin が ready にならない');
}

// 見回りをすぐ回す（rounds.json の lastRunAt を消す）。この時刻より後に始まった回で notify の /tick が通るまで待つ
async function forceRound(label) {
  // 数えるのは「呼んだ時刻より後に始まり、前に見た回より新しい」回だけ（猶予を持たせると、直前の確かめの回を次の値の回と数えて落ちた・2026-11-18 の e2e）
  const readRec = () => { try { return JSON.parse(dx(['exec', C, 'cat', '/data/aioffice/rounds.json'])); } catch { return {}; } };
  const prevOk = Date.parse(readRec().plugins?.['aioffice.notify']?.lastOkAt || '') || 0;
  const t0 = Date.now();
  for (let i = 0; i < 100; i++) {
    const rec = readRec();
    const ok = Date.parse(rec.plugins?.['aioffice.notify']?.lastOkAt || '');
    if (Number.isFinite(ok) && ok >= t0 && ok > prevOk) { log(`round ok (${label})`); return; }
    // 回っている回が終わりに書き戻して消した印を戻すこともあるので、まだ新しい回が始まっていなければ毎回消し直す
    if (!(Date.parse(rec.lastRunAt || '') >= t0)) node(`import{readFileSync,writeFileSync,renameSync}from'node:fs';const f='/data/aioffice/rounds.json';let r={};try{r=JSON.parse(readFileSync(f,'utf8'))}catch{r={plugins:{}}};r.lastRunAt=null;writeFileSync(f+'.tmp',JSON.stringify(r,null,2));renameSync(f+'.tmp',f)`);
    await sleep(3000);
  }
  throw new Error(`見回りが回らない（${label}）`);
}

// 帯が無いことは、5 秒の間に 10 回見て一度も出ないことで確かめる（1 回だけ見ると、遅れて描かれる帯を見逃して偽の pass になる・独立レビュー r4 の低 5）
async function assertNoBanner(kind, msg) {
  for (let i = 0; i < 10; i++) { assert.equal((await page.$(`[data-banner="${kind}"]`)) === null, true, msg); await sleep(500); }
}
// ---- 画面と持ち主の口 ----
if (OUT) fs.mkdirSync(OUT, { recursive: true });
const browser = await chromium.launch(process.env.PW_EXE ? { executablePath: process.env.PW_EXE } : {});
const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, locale: LANG === 'ja' ? 'ja-JP' : 'en-US' });
const page = await ctx.newPage();
const errors = []; page.on('pageerror', e => errors.push(String(e)));
let n = 0;
const shot = async name => { if (OUT) await page.screenshot({ path: path.join(OUT, `2026-11-18_${LANG}_limit-${String(++n).padStart(2, '0')}-${name}.png`) }); };
const getState = async () => { for (let i = 0; ; i++) { try { return await (await ctx.request.get(`${BASE}/setup/api/state`)).json(); } catch (e) { if (i >= 2 || !/socket hang up|ECONNRESET/.test(String(e))) throw e; await sleep(500); } } };
const login = async () => { const r = await ctx.request.post(`${BASE}/api/auth/sign-in/email`, { data: { email: EMAIL, password: PASS }, headers: { origin: BASE } }); assert.equal(r.status(), 200, 'ログイン'); };
const api = async (method, url, data) => {
  const r = await ctx.request.fetch(url, { method, data, headers: { origin: BASE, 'content-type': 'application/json' }, timeout: 60000 });
  const j = await r.json().catch(() => null);
  assert.ok(r.ok(), `${method} ${url} → ${r.status()} ${JSON.stringify(j).slice(0, 200)}`);
  return j;
};
// 持ち主の session（本体の sign-in の cookie）。起動係はこれで持ち主かを本体に聞く
const ownerCookie = async () => { const cs = await ctx.cookies(); assert.ok(cs.length, '持ち主の cookie'); return cs.map(c => `${c.name}=${c.value}`).join('; '); };
// 起動係の試験用の差し替え口を container の中（loopback）から呼ぶ
async function hook(body) {
  const js = `const r=await fetch('http://127.0.0.1:3100/setup/api/test/ai-limits',{method:'POST',headers:{'content-type':'application/json',host:'localhost:3100',cookie:process.argv[1]},body:process.argv[2]});console.log(JSON.stringify({s:r.status,t:await r.text()}))`;
  return JSON.parse(node(js, await ownerCookie(), JSON.stringify(body)).split('\n').pop());
}
const setHook = async body => { const r = await hook(body); assert.equal(r.s, 200, `差し替え口 ${r.s} ${r.t.slice(0, 120)}`); };
const setLimits = body => api('POST', `${BASE}/setup/api/ai-limits`, body);

await login();
const state0 = await getState();
const companyId = state0.company.id, prefix = state0.company.prefix;
const NB = `${BASE}/api/plugins/aioffice.notify/api`;
const q = `companyId=${encodeURIComponent(companyId)}`;
const notices = async () => (await api('GET', `${NB}/notices?${q}`)).notices;
const limitsView = async () => (await api('GET', `${NB}/settings?${q}`)).limits || {};
const ofKind = async kind => (await notices()).filter(x => x.kind === kind);
const agentOf = id => core('GET', `/agents/${id}`);
const isPaused = id => agentOf(id).status === 'paused';
const pauseOf = async id => ((await limitsView()).pauses || []).find(p => p.agentId === id) || null;
const runsOf = id => { const r = core('GET', `/companies/${companyId}/heartbeat-runs?agentId=${encodeURIComponent(id)}&limit=200`); return Array.isArray(r) ? r : r?.items || []; };
// 画面の持ち主の「再開」と同じ順: 本体の resume → notify の /limit/resume
async function resumeAgents(ids) {
  for (const id of ids) core('POST', `/agents/${id}/resume`, {}, { allow: true });
  return api('POST', `${NB}/limit/resume?${q}`, { agentIds: ids });
}
async function waitFor(fn, ms, what) {
  const end = Date.now() + ms;
  for (;;) { const v = await fn(); if (v) return v; if (Date.now() > end) throw new Error(`待ちきれない: ${what}`); await sleep(1000); }
}
const openOffice = async () => { await page.goto(`${BASE}/${prefix}/office`); await page.waitForSelector('[data-office="root"] [data-people] li', { timeout: 60000 }); };
const openInbox = async () => { await openOffice(); await page.click('[data-open="inbox"]'); await page.waitForSelector('[data-panel="inbox"]', { timeout: 30000 }); };

// ---- 準備 ----
await waitUp();
// 前提: 差し替え口は container の中（loopback）から開き、外（host から公開の port）からは閉じている（シナリオ 11 の半分）
const hk = await hook({ clear: true });
assert.equal(hk.s, 200, `差し替え口が開かない（${hk.s}）。container を -e ${TEST_HOOK_ENV}=1 で起こす（この file の先頭の注釈）`);
const outside = await ctx.request.post(`${BASE}/setup/api/test/ai-limits`, { data: { clear: true }, headers: { origin: BASE } });
assert.equal(outside.status(), 404, '11: loopback でない呼び手には、ログインしていても 404');
log('11 (loopback only) ok');

dx(['exec', C, 'mkdir', '-p', STUB_DIR, `${STUB_DIR}/codex-home`]);
dx(['cp', STUB_SRC, `${C}:${STUB}`]);
assert.match(dx(['exec', C, STUB, '--version']), /\b2\.\d+\.\d+\b/, 'stub が --version に答える');
// codex の担当の資格の置き場（CODEX_HOME を明示した担当は本体の管理の外になり、この偽物で起動する）
writeJson(`${STUB_DIR}/codex-home/auth.json`, { OPENAI_API_KEY: null, tokens: { e2e: 'placeholder' } });

await setLimits(defaultAiLimits());
const agents0 = core('GET', `/companies/${companyId}/agents`);
const startPaused = new Set(agents0.filter(a => a.status === 'paused').map(a => a.id));
const made = [], issues = [];
const secretOf = name => core('POST', `/companies/${companyId}/secrets`, { name: `Limits E2E ${name} ${RUN}`, key: `LIMITS_E2E_${name}_${RUN}`.toUpperCase().replace(/[^A-Z0-9_]/g, '_'), value: `e2e-placeholder-${name}` }).id;
const approveIfNeeded = a => { if (a.status === 'pending_approval') core('POST', `/agents/${a.id}/approve`, {}); return a; };
function claudeAgent(name, secretId, cfgName, env = {}) {
  const a = approveIfNeeded(core('POST', `/companies/${companyId}/agents`, { name: `${name} ${RUN}`, title: 'Limits E2E', role: 'general', adapterType: 'claude_local',
    adapterConfig: { engine: 'cli', command: STUB, env: { ...(secretId ? { CLAUDE_CODE_OAUTH_TOKEN: { type: 'secret_ref', secretId } } : {}), AIO_STUB_CONFIG: { type: 'plain', value: `${STUB_DIR}/${cfgName}.json` }, ...env } } }));
  made.push(a.id); return a.id;
}
function codexAgent(name, { stub = false } = {}) {
  const adapterConfig = stub ? { engine: 'cli', command: STUB, env: { CODEX_HOME: { type: 'plain', value: `${STUB_DIR}/codex-home` }, AIO_STUB_CONFIG: { type: 'plain', value: `${STUB_DIR}/codex.json` } } } : { engine: 'cli' };
  const a = approveIfNeeded(core('POST', `/companies/${companyId}/agents`, { name: `${name} ${RUN}`, title: 'Limits E2E', role: 'general', adapterType: 'codex_local', adapterConfig }));
  made.push(a.id); return a.id;
}
function assign(agentId, title) { const i = core('POST', `/companies/${companyId}/issues`, { title: `${title} ${RUN}`, status: 'todo', assigneeAgentId: agentId }); issues.push(i.id); return i; }
const closeIssue = i => core('PATCH', `/issues/${i.id}`, { status: 'done' }, { allow: true });
const TERMINAL = new Set(['succeeded', 'failed', 'cancelled', 'timed_out', 'interrupted']);
// その担当の、since より後に作られた最初の run が終わるまで待つ
// その課題の run だけを見る（本体の run の一覧の応答の contextSnapshot.issueId・@paperclipai/server 2026.1001.0 の heartbeat.js の list が SQL の列 contextIssueId を入れ替える）。作った直後の起こしが遅れて来た run を課題の run と取り違えて課題を閉じると、
// 課題の run は始まる前に本体が continuation_task_ownership_changed で止め、段の形（追加料金など）を一度も読まない（2026-11-21 amd64 の日本語の 4 で落ちた）
const ofIssue = (r, issue) => { const id = typeof issue === 'string' ? issue : issue?.id; if (!id) throw new Error('課題の id が無い'); return r.contextSnapshot?.issueId === id; };
async function firstRunDone(agentId, sinceMs, issue, ms = 180000) {
  return waitFor(() => { const rs = runsOf(agentId).filter(r => ofIssue(r, issue) && Date.parse(r.createdAt) >= sinceMs - 2000).sort((a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt)); return rs[0] && TERMINAL.has(rs[0].status) ? rs[0] : null; }, ms, `run の終わり ${agentId}`);
}
async function firstRunRunning(agentId, sinceMs, issue, ms = 180000) {
  return waitFor(() => { const r = runsOf(agentId).filter(x => ofIssue(x, issue) && Date.parse(x.createdAt) >= sinceMs - 2000).sort((a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt))[0]; if (r && TERMINAL.has(r.status)) throw new Error(`run が走る前に終わった: ${r.status} ${r.errorCode} ${String(r.error || '').slice(0, 200)}`); return r?.status === 'running' && r.startedAt ? r : null; }, ms, `run の始まり ${agentId}`);
}
// 担当に run が 1 本も走っていない（次の形に替える前に、前の形の run が残らない）
const settle = async ids => { await waitFor(() => ids.every(id => !runsOf(id).some(r => r.status === 'running' || r.status === 'queued')), 120000, 'run が終わる'); };
// 課題を割り当てて 1 本の run を回し、終わったら課題を閉じる（後の起こしで同じ形の run を増やさない）
// 担当を作った直後の起こしの run が終わるまで待つ。その run が次の段の run より後に始まると、見回りは新しい方（使用率の数の無いふつうの成功の event）を
// 選び、段の値（81% など）を読まない（2026-11-21 amd64 の 3 で落ちた）。起こしが来ない担当もあるので、20 秒たって run が 1 本も無ければ待たない。
// 担当を作る行の直後には必ずこれを呼ぶ（test/limits-e2e-order.test.mjs が確かめる）
async function afterCreate(ids) {
  const t0 = Date.now();
  await waitFor(() => ids.every(id => { const rs = runsOf(id); return rs.length ? rs.every(r => TERMINAL.has(r.status)) : Date.now() - t0 > 20000; }), 180000, '作った直後の run が終わる');
}
async function oneRun(agentId, title) {
  const t0 = Date.now(); const i = assign(agentId, title);
  const r = await firstRunDone(agentId, t0, i); closeIssue(i); await settle([agentId]); return r;
}
const nearOf = async prefixKey => {
  const all = await ofKind('ai_limit_near'), hit = all.filter(x => String(x.originId).startsWith(prefixKey));
  if (hit.length !== 1) log(`知らせの key ${prefixKey} が ${hit.length} 件（ある key: ${JSON.stringify(all.map(x => x.originId))}）`); // 落ちた時に何が出ていたかを残す
  return hit;
};
// 知らせが 1 件出るのを、見回りを 3 回まで回し直して待つ（2026-11-25 公開の CI run 45481600278 amd64 の 3「5 時間の窓」で一覧が空・同じ commit の arm64 は通過）。
// 1 回目で出ない原因の候補（独立レビュー 34 回目 P3-1）: forceRound が run の途中で始まった回を新しい回と数える試しの競合か、
// 後の run（event の無い失敗）を選んだ回が readError を送り、notify が Claude の知らせを一度外して次の回で出し直す製品の揺れ。
// 起動係は読んだ run を readRunIds に入れて読み直さないので、「ログが遅れて次の回で出る」形ではない。回し直しが要った時は rounds.json の notify の記録を残す。
// 0 件を確かめる所（79% など）には使わない
const nearSoon = async (prefixKey, label) => {
  for (let i = 1; ; i++) {
    const hit = await nearOf(prefixKey);
    if (hit.length === 1 || i > 3) return hit;
    try { const rec = JSON.parse(dx(['exec', C, 'cat', '/data/aioffice/rounds.json'])); log(`${label}: ${i} 回目で知らせが無い・見回りの記録 ${JSON.stringify(rec.plugins?.['aioffice.notify'] || {}).slice(0, 300)}`); } catch { /* 手がかりだけ */ }
    await forceRound(`${label} の読み直し ${i}`);
  }
};

// 担当を作るときは stub をふつうの成功にしておく（作った直後の起こしで上限の失敗を先に出さない）
for (const s of ['s2', 's3', 's4', 's4b', 's5', 's7', 's9', 's12', 's12b', 'k10']) stubCfg(s, { mode: 'success' });
stubCfg('codex', { mode: 'sleep', runSeconds: 900 });

// ======== 1. ChatGPT（差し替え口で quota-windows を流す）========
const RW = iso(futureHour(72)), R5 = iso(futureHour(3));
const quota = ({ h5 = 10, week = 10, credits = '$250.80 remaining', source = 'codex-wham' } = {}) => [{ provider: 'openai', ok: true, source, windows: [{ label: '5h limit', usedPercent: h5, resetsAt: R5 }, { label: 'Weekly limit', usedPercent: week, resetsAt: RW }, { label: 'Credits', usedPercent: null, resetsAt: null, valueLabel: credits }] }];
const o1 = codexAgent('Limits ChatGPT 1'), o2 = codexAgent('Limits ChatGPT 2');
await setHook({ quotaWindows: quota({ week: 79 }) }); await forceRound('1: 79%');
const wkey = `openai:week:${RW.slice(0, 13)}`;
assert.equal((await nearOf(wkey)).length, 0, '1: 79% では知らせない');
await setHook({ quotaWindows: quota({ week: 81 }) }); await forceRound('1: 81%');
assert.equal((await nearSoon(wkey, '1: 81%')).length, 1, '1: 81% で知らせ 1 件');
assert.ok(!isPaused(o1) && !isPaused(o2), '1: 81% では止めない');
await setHook({ quotaWindows: quota({ week: 96 }) }); await forceRound('1: 96%');
assert.ok(isPaused(o1) && isPaused(o2), '1: 96% で ChatGPT の担当を止める');
assert.equal((await pauseOf(o1))?.reason, 'pct');
assert.equal((await nearOf(wkey)).length, 1, '1: 知らせは 1 件のまま');
await openOffice(); await page.waitForSelector('[data-banner="ai_limit_paused"]', { timeout: 60000 }); await shot('chatgpt-banner');
// 追加料金の枠: 同じ source で Credits が減ったら知らせて止める（追加料金の扱いの既定は never）
await setHook({ quotaWindows: quota({ week: 50 }) }); await resumeAgents([o1, o2]); await forceRound('1: 戻した');
assert.ok(!isPaused(o1) && !(await pauseOf(o1)), '1: 戻した後は記録が閉じる');
await setHook({ quotaWindows: quota({ week: 50, credits: '$249.10 remaining' }) }); await forceRound('1: Credits の減り');
const credits = await ofKind('ai_credits_spent');
assert.ok(credits.some(x => x.title.includes('$250.80') && x.title.includes('$249.10')), '1: 追加料金の知らせに前と今の残り');
assert.ok(isPaused(o1) && isPaused(o2), '1: 追加料金の扱いが never（既定）なので止める');
assert.equal((await pauseOf(o1))?.reason, 'credits');
// source を wham から RPC に替えた回は比べない（止めない）
await resumeAgents([o1, o2]); await forceRound('1: 戻した 2');
await setHook({ quotaWindows: quota({ week: 50, credits: '$24910.00 remaining', source: 'codex-rpc' }) }); await forceRound('1: source の入れ替わり');
assert.ok(!isPaused(o1) && !isPaused(o2), '1: source が替わった回は止めない');
log('1 ok');

// ======== 1b. 追加料金の扱いを画面で替えると、5 時間の窓の 97% で止めるかが変わる ========
// 持ち主の画面（AI の契約の欄）で 3 つから選んで保存する。stop は 5 時間の窓を知らせだけ、never（既定）は 95% で止める
async function chooseSpend(mode) {
  await openOffice(); await page.click('[data-open="connect"]');
  await page.waitForSelector(`[data-limits-spend-mode="${mode}"]`, { timeout: 60000 });
  await page.check(`[data-limits-spend-mode="${mode}"]`);
  const warn = await page.$('[data-limits-spend-warn]');
  assert.equal(!!warn, mode === 'allow', `1b: ${mode} の時だけ、お金が上限なく出ていく注意を出す`);
  if (warn) assert.equal(await warn.textContent(), D.limits_spend_allow_warn);
  await page.click('[data-limits-save]');
  await page.waitForSelector('[data-limits-result="limits_saved"]', { timeout: 30000 });
  assert.equal((await api('GET', `${BASE}/setup/api/ai-limits`)).aiLimits.spend, mode, `1b: 起動係に ${mode} が残る`);
}
const h5key = `openai:h5:${R5.slice(0, 13)}`;
await chooseSpend('allow'); await shot('spend-allow');
await chooseSpend('stop');
await setHook({ quotaWindows: quota({ h5: 97, week: 50, credits: '$24910.00 remaining', source: 'codex-rpc' }) }); await forceRound('1b: stop で 5 時間 97%');
assert.equal((await nearSoon(h5key, '1b: 5 時間 97%')).length, 1, '1b: 5 時間 97% は知らせる');
assert.ok(!isPaused(o1) && !isPaused(o2), '1b: stop では 5 時間の窓で止めない');
await chooseSpend('never');
await forceRound('1b: never で 5 時間 97%');
assert.ok(isPaused(o1) && isPaused(o2), '1b: never に替えた次の見回りで、同じ 97% で止める');
const p1b = await pauseOf(o1);
assert.deepEqual([p1b?.reason, p1b?.untilAt], ['pct', R5], '1b: 理由は % で、期限は 5 時間の窓の resetsAt');
await shot('spend-never-paused');
// ここは人の再開で戻し、5 時間の窓が下がった後の見回りで止め直さないことだけを確かめる。
// 窓のリセット後に自動で戻す（96% なら止めたまま・50% なら戻す）のは unit（plugin-notify-limits-worker.test.mjs）で確かめる
await setHook({ quotaWindows: quota({ week: 50, credits: '$24910.00 remaining', source: 'codex-rpc' }) }); await resumeAgents([o1, o2]); await forceRound('1b: 人が再開した');
assert.ok(!isPaused(o1) && !isPaused(o2), '1b: 人が再開した後、5 時間の窓が下がった見回りで止め直さない');
log('1b ok');

// ======== 2. Claude の上限の失敗（同じ token の 2 人）========
const R2 = futureHour(48);
const sec2 = secretOf('s2');
const a2 = claudeAgent('Limits Claude A', sec2, 's2'), b2 = claudeAgent('Limits Claude B', sec2, 's2');
await afterCreate([a2, b2]);
await forceRound('2: 同じ契約の一覧'); // event の処理が同じ契約の担当を知るのは /tick で写した一覧から
stubCfg('s2', { mode: 'rejected', resetsAt: R2 });
const t2 = Date.now(); const iss2 = assign(a2, 'Limits E2E weekly limit');
const failed2 = await firstRunDone(a2, t2, iss2);
assert.equal(failed2.status, 'failed', `2: run は失敗で終わる（${failed2.status}）`);
assert.equal(failed2.errorCode, 'provider_quota', `2: run の errorCode が provider_quota でない（${failed2.errorCode}・${String(failed2.error || '').slice(0, 200)}）`);
const fin2 = Date.parse(failed2.finishedAt);
await waitFor(() => isPaused(a2) && isPaused(b2), 300000, '2: 2 人とも paused');
const g5 = (Date.now() - fin2) / 1000;
log(`2: run の終わりから 2 人とも paused まで ${g5.toFixed(1)} 秒`);
assert.ok(g5 <= G5_SEC, `2: ${G5_SEC} 秒以内に止まる（${g5.toFixed(1)} 秒）`);
const agentComments = () => { const c = core('GET', `/issues/${iss2.id}/comments`); return (Array.isArray(c) ? c : c?.items || []).filter(x => x.authorAgentId).length; };
const comments0 = agentComments();
// 70 秒以上待って本体の再試行（P1: automation の 4 本は全部 30 秒後の再試行）の時刻を越え、その間に on_demand・コメント・割り当ての起こしを送る
const nudges = { on_demand: [], comment: 0, assignment: null };
for (let i = 0; i < 5; i++) {
  for (const id of [a2, b2]) nudges.on_demand.push(core('POST', `/agents/${id}/wakeup`, { source: 'on_demand', reason: `limits e2e ${i}`, payload: { issueId: iss2.id } }, { allow: true }).s);
  core('POST', `/issues/${iss2.id}/comments`, { body: `Limits E2E nudge ${i}` }); nudges.comment++;
  if (i === 2) nudges.assignment = assign(b2, 'Limits E2E assignment while paused').id;
  await sleep(12000);
}
while (Date.now() - fin2 < 75000) await sleep(2000);
const after2 = [...runsOf(a2), ...runsOf(b2)].filter(r => Date.parse(r.createdAt) > fin2 - 1000 && r.id !== failed2.id);
const started2 = after2.filter(r => r.startedAt && Date.parse(r.startedAt) > fin2);
log(`2: 起こし on_demand=${JSON.stringify(nudges.on_demand)} comment=${nudges.comment}・止めた後にできた run の行 ${after2.length}（startedAt なし ${after2.length - started2.length}）`);
assert.deepEqual(started2.map(r => `${r.id}:${r.invocationSource ?? r.source ?? ''}`), [], '2: 失敗の後に始まった run は 0 本（再試行・on_demand・コメント・割り当て）');
assert.equal(agentComments(), comments0, '2: 担当のコメントが増えない');
await forceRound('2: ログの resetsAt');
for (const id of [a2, b2]) assert.equal((await pauseOf(id))?.untilAt, iso(R2), '2: 止め続ける期限はログの resetsAt');
// 画面: 帯・受信箱の再開・担当の欄
await openOffice(); await page.waitForSelector('[data-banner="ai_limit_paused"]', { timeout: 60000 }); await shot('claude-banner');
await page.click('[data-banner="ai_limit_paused"]');
await page.waitForSelector(`[data-limit-resume="${a2}"]`, { timeout: 30000 });
assert.ok(Number(await page.getAttribute(`[data-limit-resume="${a2}"]`, 'data-limit-group')) >= 2, '2: 再開は同じ契約の 2 人をまとめる');
await shot('inbox-paused');
await openOffice(); await page.click(`[data-people] [data-agent="${a2}"] button`);
await page.waitForSelector('[data-panel="agent"] [data-agent-limit]', { timeout: 30000 });
assert.equal(await page.getAttribute('[data-panel="agent"] [data-agent-limit]', 'data-agent-limit'), iso(R2), '2: 担当の欄に期限');
assert.ok((await page.textContent('[data-panel="agent"] [data-agent-limit]')).includes(D.agent_limit_paused));
await shot('agent-paused');
log('2 ok');

// ======== 3. Claude の使用率（stub の rate_limit_event を本物のログの口で読む）========
const sec3 = secretOf('s3');
const a3 = claudeAgent('Limits Claude C', sec3, 's3'), b3 = claudeAgent('Limits Claude D', sec3, 's3');
await afterCreate([a3, b3]);
await forceRound('3: 同じ契約の一覧');
const R3 = futureHour(50), R3w = futureHour(51), R3h = futureHour(2);
stubCfg('s3', { mode: 'allowed', utilization: 0.81, resetsAt: R3 }); const run3 = await oneRun(a3, 'Limits E2E usage 81'); await forceRound('3: 81%');
// 落ちた時に、読んだはずの run とその後に始まった Claude の run を残す（2026-11-22 amd64 で 0 件・原因を分けるため）
if ((await nearOf(`anthropic:week:${hourKey(R3)}`)).length !== 1) { // 1 回目で無い時に手がかりを先に残す（回し直して出た時も原因を分けられる・独立レビュー 34 回目 P3-2）
  try {
  const ev = id => JSON.stringify(core('GET', `/heartbeat-runs/${id}/log`, null, { allow: true }).j || '').includes('rate_limit_event');
  log(`3: 段の run ${run3.id} ${run3.status} start=${run3.startedAt} end=${run3.finishedAt} ログの event=${ev(run3.id)}`);
  for (const id of [a3, b3]) for (const r of runsOf(id).slice(0, 5)) log(`3: ${id === a3 ? 'a3' : 'b3'} の run ${r.id} ${r.status} start=${r.startedAt} end=${r.finishedAt} event=${ev(r.id)}`);
  const rec = (() => { try { return JSON.parse(dx(['exec', C, 'cat', '/data/aioffice/rounds.json'])); } catch { return {}; } })();
  log(`3: 見回りの記録 ${JSON.stringify(rec.plugins?.['aioffice.notify'] || {}).slice(0, 400)}`);
  } catch (e) { log(`3: 手がかりを読めなかった ${String(e?.message || e).slice(0, 200)}`); } // 調べの失敗で下の判定の文を置き換えない
}
assert.equal((await nearSoon(`anthropic:week:${hourKey(R3)}`, '3: 81%')).length, 1, '3: 81% で知らせ 1 件');
assert.ok(!isPaused(a3) && !isPaused(b3), '3: 81% では止めない');
stubCfg('s3', { mode: 'allowed_warning', utilization: 0.5, resetsAt: R3w }); await oneRun(a3, 'Limits E2E allowed_warning'); await forceRound('3: allowed_warning');
assert.equal((await nearSoon(`anthropic:week:${hourKey(R3w)}`, '3: allowed_warning')).length, 1, '3: allowed_warning は % に関係なく「近い」');
assert.ok(!isPaused(a3), '3: allowed_warning では止めない');
// 5 時間の窓の知らせだけを見る段は、追加料金の扱いを stop にして回す（never の 95% の止めは 1b で確かめた）
await setLimits({ spend: 'stop' });
stubCfg('s3', { mode: 'allowed', utilization: 0.1, fiveHour: 0.97, fiveHourResetsAt: R3h, resetsAt: R3 }); await oneRun(a3, 'Limits E2E five hour'); await forceRound('3: 5 時間 97%');
assert.equal((await nearSoon(`anthropic:h5:${hourKey(R3h)}`, '3: 5 時間 97%')).length, 1, '3: 5 時間の窓は知らせる');
assert.ok(!isPaused(a3) && !isPaused(b3), '3: stop では 5 時間の窓で止めない');
stubCfg('s3', { mode: 'allowed', utilization: 0.96, resetsAt: R3 }); await oneRun(a3, 'Limits E2E usage 96'); await forceRound('3: 96%');
assert.ok(isPaused(a3) && isPaused(b3), '3: 96% で同じ token の 2 人を止める');
for (const id of [a3, b3]) { const p = await pauseOf(id); assert.equal(p?.reason, 'pct'); assert.equal(p?.untilAt, iso(R3), '3: 期限は resetsAt'); }
await setLimits({ spend: 'never' });
// 画面: AI の契約の欄に Claude の週の使用率
await openOffice(); await page.click('[data-open="connect"]');
await page.waitForSelector('[data-limits-pct="anthropic:week"]', { timeout: 60000 });
assert.match(await page.textContent('[data-limits-pct="anthropic:week"]'), /96%/, '3: AI の契約の欄に 96%');
assert.notEqual(await page.getAttribute('[data-limits-usage="anthropic"] [data-limits-read-at]', 'data-limits-read-at'), 'none', '3: 読んだ時刻');
await page.$eval('[data-limits-usage="anthropic"]', el => el.scrollIntoView());
await shot('ai-usage');
log('3 ok');

// ======== 4. Claude の追加料金・読めない形 ========
const sec4 = secretOf('s4');
const a4 = claudeAgent('Limits Claude E', sec4, 's4'), b4 = claudeAgent('Limits Claude F', sec4, 's4');
const c4 = claudeAgent('Limits Claude G', secretOf('s4b'), 's4b');
await afterCreate([a4, b4, c4]);
await forceRound('4: 同じ契約の一覧');
stubCfg('s4', { mode: 'overage', utilization: 0.3, resetsAt: futureHour(52) });
const ov4 = await oneRun(a4, 'Limits E2E overage'); await forceRound('4: 追加料金');
// 知らせの originId は、起動係が渡した追加料金の run（同じ担当の、一番新しい run）。e2e の run（ov4）が終わると本体が同じ担当の次の run（automation）を
// 続けて始め、その run も追加料金で動くので、ov4 そのものとは限らない。同じ契約の担当（E・F）の run であることを確かめる
const runIds4 = new Set([ov4.id, ...runsOf(a4).map(r => r.id), ...runsOf(b4).map(r => r.id)]);
const ovNotes4 = (await ofKind('ai_overage_started')).filter(x => runIds4.has(x.originId));
assert.equal(ovNotes4.length, 1, `4: 追加料金の知らせが同じ契約の run に 1 件（${ovNotes4.length} 件）`);
assert.ok(isPaused(a4) && isPaused(b4), '4: 追加料金の扱いが never なので同じ token の 2 人を止める');
assert.equal((await pauseOf(a4))?.reason, 'overage');
await forceRound('4: 自動では戻らない');
assert.ok(isPaused(a4) && isPaused(b4), '4: 追加料金で止めた担当は自動では戻らない');
for (const [mode, label] of [['no_event', '行が無い'], ['unknown_status', '知らない status']]) {
  stubCfg('s4b', { mode, utilization: 0.99, resetsAt: futureHour(53) }); await oneRun(c4, `Limits E2E ${mode}`); await forceRound(`4: ${label}`);
  assert.ok((await ofKind('ai_quota_unreadable')).some(x => x.originId === 'anthropic'), `4: ${label}の形で「読めません」`);
  assert.ok(!isPaused(c4), `4: ${label}の形では止めない`);
  await openOffice(); await page.waitForSelector('[data-banner="ai_quota_unreadable"]', { timeout: 60000 }); await shot(`unreadable-${mode}`);
}
log('4 ok');

// ======== 12. 追加料金の印が出た走っている run の取り消し ========
const sec12 = secretOf('s12');
const a12 = claudeAgent('Limits Claude H', sec12, 's12'), b12 = claudeAgent('Limits Claude I', sec12, 's12');
const c12 = claudeAgent('Limits Claude J', secretOf('s12b'), 's12b');
await afterCreate([a12, b12, c12]);
await forceRound('12: 同じ契約の一覧');
stubCfg('s12', { mode: 'overage', utilization: 0.2, resetsAt: futureHour(54), runSeconds: 900 });
const hasEvent = runId => { const l = core('GET', `/heartbeat-runs/${runId}/log`, null, { allow: true }); return JSON.stringify(l.j || '').includes('rate_limit_event'); };
let t12 = Date.now(); const i12 = assign(a12, 'Limits E2E long overage');
const run12 = await firstRunRunning(a12, t12, i12);
await waitFor(() => hasEvent(run12.id), 60000, '12: ログに rate_limit_event');
await forceRound('12: 走っている run を読む');
await waitFor(() => core('GET', `/heartbeat-runs/${run12.id}`).status === 'cancelled', 60000, '12: 追加料金の run が取り消される');
// 起動係は run を先に取り消し、担当を止めるのはその後の notify（同じ回の後ろ）なので、取り消しを見た直後には止まっていないことがある
await waitFor(() => isPaused(a12) && isPaused(b12), 60000, '12: 同じ token の担当を止める');
// 取り消しと止めるの間に本体が同じ担当の次の run を始めると、知らせは新しい run に替わる。替わっても、取り消した run は本文に残る
// 落ちた時に、出ていた追加料金の知らせ・同じ担当の run・起動係の上限の記録を残す（2026-11-24 arm64 で取り消しと止めは通り、知らせに id が無かった・原因を分けるため）
const diag12 = async e => {
  try {
    for (const x of await ofKind('ai_overage_started')) log(`12: 知らせ origin=${x.originId} body=${String(x.body || '').slice(0, 300)}`);
    for (const r of runsOf(a12).slice(0, 5)) log(`12: a12 の run ${r.id} ${r.status} start=${r.startedAt} end=${r.finishedAt}`);
    const st = (() => { try { return JSON.parse(dx(['exec', C, 'cat', '/data/aioffice/state.json'])); } catch { return {}; } })();
    const rt = st.aiLimitsRun?.[companyId] || {};
    log(`12: 起動係の記録 cancelled=${JSON.stringify(rt.cancelled || []).slice(-200)} claudeUnsent=${JSON.stringify(rt.claudeUnsent || [])} last=${JSON.stringify(rt.claudeLast || {}).slice(0, 300)}`);
  } catch (e2) { log(`12: 手がかりを読めなかった ${String(e2?.message || e2).slice(0, 200)}`); } // 調べの失敗で下の判定の文を置き換えない
  throw e;
};
await waitFor(async () => (await ofKind('ai_overage_started')).some(x => String(x.body || '').includes(run12.id)), 60000, '12: 知らせに取り消した run').catch(diag12);
const ovN = (await ofKind('ai_overage_started')).find(x => String(x.body || '').includes(run12.id));
assert.ok(ovN, '12: 知らせに取り消した run');
closeIssue(i12);
// 対照: 追加料金の扱いを allow（追加料金で続けてよい）にすると取り消さない
await setLimits({ spend: 'allow' });
stubCfg('s12b', { mode: 'overage', utilization: 0.2, resetsAt: futureHour(54), runSeconds: 900 });
t12 = Date.now(); const i12b = assign(c12, 'Limits E2E long overage control');
const run12b = await firstRunRunning(c12, t12, i12b);
await waitFor(() => hasEvent(run12b.id), 60000, '12: 対照のログに rate_limit_event');
await forceRound('12: 対照');
await sleep(5000);
assert.equal(core('GET', `/heartbeat-runs/${run12b.id}`).status, 'running', '12: allow では取り消さない');
assert.ok(!isPaused(c12), '12: allow では止めない');
core('POST', `/heartbeat-runs/${run12b.id}/cancel`, {}); closeIssue(i12b);
await setLimits({ spend: 'never' });
// ChatGPT: Credits が同じ source で減った回に、走っている codex の run を取り消す
const o3 = codexAgent('Limits ChatGPT 3', { stub: true });
await forceRound('12: codex の担当');
let t12c = Date.now(); const i12c = assign(o3, 'Limits E2E codex long run');
const run12c = await firstRunRunning(o3, t12c, i12c);
await setHook({ quotaWindows: quota({ week: 50, credits: '$24800.00 remaining', source: 'codex-rpc' }) }); await forceRound('12: Credits の減り');
await waitFor(() => core('GET', `/heartbeat-runs/${run12c.id}`).status === 'cancelled', 60000, '12: codex の run が取り消される');
// 2026-11-21 arm64 で、取り消しは forceRound の回の中で起きたのに知らせに id が無く落ちた。取り消した回の /tick が上限の処理を飛ばす・失敗すると、
// 起動係が id を 1 回しか載せず失われていた（起動係を直し、commit まで載せ続ける）。知らせは次の回で出ることがあるので、Claude の側と同じく出るまで待つ
// 落ちた時に、出ていた Credits の知らせと起動係の記録を残す（2026-11-25 arm64 で取り消しは通り、知らせに id が無かった）
const diag12c = async e => {
  try {
    for (const x of await ofKind('ai_credits_spent')) log(`12c: 知らせ origin=${x.originId} title=${String(x.title || '').slice(0, 120)} body=${String(x.body || '').slice(0, 300)}`);
    const st = (() => { try { return JSON.parse(dx(['exec', C, 'cat', '/data/aioffice/state.json'])); } catch { return {}; } })();
    const rt = st.aiLimitsRun?.[companyId] || {};
    log(`12c: 起動係の記録 creditsUnsent=${JSON.stringify(rt.creditsUnsent || [])} creditsBase=${JSON.stringify(rt.creditsBase || null)} cancelled=${JSON.stringify(rt.cancelled || []).slice(-200)}`);
  } catch (e2) { log(`12c: 手がかりを読めなかった ${String(e2?.message || e2).slice(0, 200)}`); }
  throw e;
};
await waitFor(async () => (await ofKind('ai_credits_spent')).some(x => String(x.body || '').includes(run12c.id)), 150000, '12: 知らせに取り消した codex の run').catch(diag12c); // 後の回に届く取り消しを待つ（見回りの間隔より長く・独立レビュー 31 回目 P3-7）
closeIssue(i12c);
// ChatGPT の対照（allow）
await setLimits({ spend: 'allow' });
await resumeAgents([o3]); await forceRound('12: codex を戻した');
t12c = Date.now(); const i12d = assign(o3, 'Limits E2E codex long run control');
const run12d = await firstRunRunning(o3, t12c, i12d);
await setHook({ quotaWindows: quota({ week: 50, credits: '$24700.00 remaining', source: 'codex-rpc' }) }); await forceRound('12: codex の対照');
await sleep(5000);
assert.equal(core('GET', `/heartbeat-runs/${run12d.id}`).status, 'running', '12: ChatGPT も allow では取り消さない');
core('POST', `/heartbeat-runs/${run12d.id}/cancel`, {}); closeIssue(i12d);
await setLimits({ spend: 'never' });
log('12 ok');

// ======== 5. event の落ち（notify を止めた間の失敗を見回りで拾う）========
const sec5 = secretOf('s5');
const a5 = claudeAgent('Limits Claude K', sec5, 's5'), b5 = claudeAgent('Limits Claude L', sec5, 's5');
await afterCreate([a5, b5]);
await forceRound('5: 同じ契約の一覧'); // この回の後 5 分は次の見回りが来ないので、止めている間の失敗は次の回で読まれる
cli(['disable', 'aioffice.notify']);
stubCfg('s5', { mode: 'rejected', resetsAt: futureHour(55) });
const t5 = Date.now(); const i5 = assign(a5, 'Limits E2E event dropped');
const failed5 = await firstRunDone(a5, t5, i5);
assert.equal(failed5.errorCode, 'provider_quota', `5: provider_quota（${failed5.errorCode}）`);
stubCfg('s5', { mode: 'success' }); // 再試行が上限の失敗の event を出し直さない（見回りの補いの経路だけで止まることを見る）
assert.ok(!isPaused(a5), '5: notify を止めている間は止まらない');
cli(['enable', 'aioffice.notify']);
const en5 = Date.now();
await forceRound('5: notify を戻した');
await waitFor(() => isPaused(a5) && isPaused(b5), 300000 - (Date.now() - en5), '5: 見回りで 2 人とも止まる');
log(`5: notify を戻してから止まるまで ${((Date.now() - en5) / 1000).toFixed(1)} 秒`);
assert.ok(await pauseOf(a5), '5: 記録がある');
closeIssue(i5);
log('5 ok');

// ======== 6. 画面を開き直し、起動係を起動し直しても帯と知らせが残る ========
await openOffice(); await page.waitForSelector('[data-banner="ai_limit_paused"]', { timeout: 60000 }); await shot('reload');
dx(['restart', C], { timeout: 180000 });
await waitUp();
await setHook({ quotaWindows: quota({ week: 50, credits: '$24700.00 remaining', source: 'codex-rpc' }) }); // 差し替えは起動係の memory にだけある
if ((await ctx.request.get(`${BASE}/setup/api/ai-limits`)).status() === 401) await login();
await openOffice(); await page.waitForSelector('[data-banner="ai_limit_paused"]', { timeout: 60000 });
await forceRound('6: 起動し直した後');
await openInbox(); await page.waitForSelector(`[data-notice="agent_paused_limit"]`, { timeout: 60000 });
assert.ok((await ofKind('agent_paused_limit')).some(x => x.originId === a2), '6: 起動し直しても止めた知らせが残る');
await shot('restart');
log('6 ok');

// ======== 7. 再開（自動で戻る・画面の再開・flag OFF の後の人の再開）========
// 自動で戻る: 期限（ログの resetsAt）を過ぎたら戻し、「再開しました」の知らせに課題を出す
const a7 = claudeAgent('Limits Claude M', secretOf('s7'), 's7');
await afterCreate([a7]);
await forceRound('7: 同じ契約の一覧');
const R7 = Math.floor(Date.now() / 1000) + 150;
stubCfg('s7', { mode: 'rejected', resetsAt: R7 });
const t7 = Date.now(); const i7 = assign(a7, 'Limits E2E auto resume');
await firstRunDone(a7, t7, i7);
await waitFor(() => isPaused(a7), 120000, '7: 止まる');
stubCfg('s7', { mode: 'success' });
await forceRound('7: 期限をログの値に');
assert.equal((await pauseOf(a7))?.untilAt, iso(R7));
while (Date.now() < R7 * 1000 + 5000) await sleep(2000);
await forceRound('7: 期限を過ぎた');
assert.ok(!isPaused(a7), '7: 期限を過ぎたら自動で戻す');
const back = (await ofKind('agent_resumed_limit')).find(x => x.originId === a7);
assert.ok(back && String(back.body || '').includes(i7.identifier), '7: 再開の知らせに課題');
await openInbox(); await page.waitForSelector('[data-notice="agent_resumed_limit"]', { timeout: 60000 }); await shot('auto-resumed');
closeIssue(i7);
// 画面の「再開」: S5 の組だけを残して、ほかの組を受信箱のボタンで戻す。
// 戻した担当に止めていた間の起こしが届いても止め直しにならないよう、先に stub をふつうの成功にし、課題を閉じる
for (const s of ['s2', 's3', 's4', 's4b', 's12', 's12b']) stubCfg(s, { mode: 'success' });
stubCfg('codex', { mode: 'sleep', runSeconds: 1 });
for (const id of issues) core('PATCH', `/issues/${id}`, { status: 'done' }, { allow: true });
for (let k = 0; k < 20; k++) {
  await openInbox();
  const ids = await page.$$eval('[data-limit-resume]', els => els.map(e => e.getAttribute('data-limit-resume')));
  const pick = ids.find(id => id !== a5 && id !== b5);
  if (!pick) break;
  await page.click(`[data-limit-resume="${pick}"]`);
  await page.waitForSelector('[data-limit-resume-result]', { timeout: 60000 });
  assert.equal(await page.getAttribute('[data-limit-resume-result]', 'data-limit-resume-result'), 'limit_resumed', `7: 再開の結果（${pick}）`);
  // ボタンは担当ごとに出る。同じ組（a2・b2）のどちらを押しても、その 1 回で 2 人とも戻る（先に b2 が選ばれると a2 のボタンは消え、撮り損ねていた）
  if (pick === a2 || pick === b2) { assert.ok(!isPaused(a2) && !isPaused(b2), '7: まとめて止めた 2 人とも 1 回の再開で戻る'); await shot('resume-done'); }
}
assert.ok(!isPaused(a2) && !isPaused(b2) && !isPaused(a3) && !isPaused(a4), '7: 画面の再開で戻る');
// flag を OFF にした後に人が本体で再開しても、記録が閉じて帯が消える
await setLimits({ guard: false }); await forceRound('7: flag OFF');
for (const id of [a5, b5]) core('POST', `/agents/${id}/resume`, {});
await forceRound('7: 人の再開');
assert.equal(((await limitsView()).pauses || []).length, 0, '7: 記録が全部閉じる');
await openOffice(); await page.waitForSelector('[data-banners]', { timeout: 60000 });
await assertNoBanner('ai_limit_paused', '7: 帯が消える');
await shot('flag-off-resumed');
log('7 ok');

// ======== 9. 対照（flag OFF）: 守りが無いと本体の再試行の run が実際に始まる ========
const sec9 = secretOf('s9');
const a9 = claudeAgent('Limits Claude N', sec9, 's9'), b9 = claudeAgent('Limits Claude O', sec9, 's9');
await afterCreate([a9, b9]);
await forceRound('9: 同じ契約の一覧（flag OFF のまま）');
stubCfg('s9', { mode: 'rejected', resetsAt: futureHour(56) });
const t9 = Date.now(); const i9 = assign(a9, 'Limits E2E control flag off');
const failed9 = await firstRunDone(a9, t9, i9);
assert.equal(failed9.errorCode, 'provider_quota', `9: provider_quota（${failed9.errorCode}）`);
const fin9 = Date.parse(failed9.finishedAt);
await waitFor(() => runsOf(a9).some(r => r.startedAt && Date.parse(r.startedAt) > fin9), 120000, '9: 失敗の後に run が始まる');
assert.ok(!isPaused(a9), '9: flag OFF では止まらない');
log(`9: 失敗の後に始まった run ${runsOf(a9).filter(r => r.startedAt && Date.parse(r.startedAt) > fin9).length} 本`);
stubCfg('s9', { mode: 'success' }); closeIssue(i9);
await setLimits({ guard: true });
await settle([a9, b9]);
log('9 ok');

// ======== 10. API キーの担当で予算が無い時の帯 ========
const k10 = claudeAgent('Limits API key', null, 'k10', { ANTHROPIC_API_KEY: { type: 'plain', value: 'e2e-placeholder-not-a-key' } });
await afterCreate([k10]);
await forceRound('10: 予算なし');
assert.ok((await ofKind('budget_unset')).length >= 1, '10: budget_unset の知らせ');
await openOffice(); await page.waitForSelector('[data-banner="budget_unset"]', { timeout: 60000 }); await shot('budget-unset');
core('POST', `/companies/${companyId}/budgets/policies`, { scopeType: 'agent', scopeId: k10, amount: 500 });
await forceRound('10: 予算あり');
assert.equal((await ofKind('budget_unset')).length, 0, '10: 予算を決めると消える');
await openOffice(); await page.waitForSelector('[data-banners]', { timeout: 60000 });
await assertNoBanner('budget_unset', '10: 帯が消える');
log('10 ok');

// ======== 11. 配る image に stub が無い・env の無い container では差し替え口が 404 ========
const image = dx(['inspect', '-f', '{{.Config.Image}}', C]).trim();
const found = dx(['run', '--rm', '--entrypoint', 'sh', image, '-c', "find /opt /usr/local /home /srv /tmp -name 'claude-quota-cli*' 2>/dev/null || true"]).trim();
assert.equal(found, '', `11: 配る image に stub が入っている: ${found}`);
const PLAIN = `${C}-limits-plain`;
try { dx(['rm', '-fv', PLAIN], { stdio: 'ignore' }); } catch { /* 無い */ }
dx(['run', '-d', '--name', PLAIN, '--network', 'none', image]);
try {
  let status = 0;
  for (let i = 0; i < 90 && !status; i++) {
    try { status = JSON.parse(dx(['exec', PLAIN, 'node', '--input-type=module', '-e', `const r=await fetch('http://127.0.0.1:3100/setup/api/test/ai-limits',{method:'POST',headers:{host:'localhost:3100','content-type':'application/json'},body:'{}'});console.log(JSON.stringify(r.status))`]).trim()); }
    catch { await sleep(2000); }
  }
  assert.equal(status, 404, '11: env の無い container では差し替え口が 404');
} finally { dx(['rm', '-fv', PLAIN]); }
log('11 ok');

// ======== 片付け（後ろの CI の段は会社 1 社・担当が元の数であることを確かめる）========
for (const id of made) for (const r of runsOf(id).filter(x => x.status === 'running' || x.status === 'queued')) core('POST', `/heartbeat-runs/${r.id}/cancel`, {}, { allow: true });
core('POST', `/companies/${companyId}/budgets/policies`, { scopeType: 'agent', scopeId: k10, amount: 500, isActive: false }, { allow: true }); // 消す担当の予算は外す
for (const id of issues) core('PATCH', `/issues/${id}`, { status: 'done' }, { allow: true });
// 本体は、費用の記録（cost_events）が付いた run を持つ担当を消せない（DELETE が外部キーの制約で 500・本体の不具合）。その担当は退職（terminate）にする
for (const id of made) {
  const r = core('DELETE', `/agents/${id}`, null, { allow: true });
  if (r.s < 400) continue;
  const t = core('POST', `/agents/${id}/terminate`, {}, { allow: true });
  assert.ok(t.s < 400, `担当を消す ${id} → ${r.s}・退職 → ${t.s} ${JSON.stringify(t.j).slice(0, 200)}`);
}
// 上限の守りが止めた元の担当（ChatGPT の契約の担当は秘書・デザインも同じ契約）を戻す
const nowPaused = core('GET', `/companies/${companyId}/agents`).filter(a => a.status === 'paused' && !startPaused.has(a.id)).map(a => a.id);
if (nowPaused.length) await resumeAgents(nowPaused);
await setLimits(defaultAiLimits());
await setHook({ clear: true });
await forceRound('片付け');
const agents1 = core('GET', `/companies/${companyId}/agents`).filter(a => a.status !== 'terminated');
assert.deepEqual(agents1.map(a => a.id).sort(), agents0.filter(a => a.status !== 'terminated').map(a => a.id).sort(), '退職していない担当は元の顔ぶれに戻る');
assert.deepEqual(agents1.filter(a => a.status === 'paused').map(a => a.id).sort(), [...startPaused].sort(), '元の担当は止まっていない');
assert.deepEqual(core('GET', '/companies').map(c => c.id), [companyId], '会社は 1 社のまま');
node(`(await import('node:fs')).rmSync(process.argv[1],{recursive:true,force:true})`, STUB_DIR);

assert.deepEqual(errors, [], '画面の JavaScript の誤り');
await browser.close();
log('all ok');
