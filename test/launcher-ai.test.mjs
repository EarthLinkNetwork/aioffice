// wizard の AI の段の server の口の試験（偽の本体）。範囲: docs/review/2026-11-17-wizard-ai-choice-scope.md の作り方 4〜6・保証 1・4・7
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { createLauncher } from '../packages/aioffice/launcher/server.mjs';
import { swapAdapterConfig, deskAdapterConfig } from '../packages/aioffice/launcher/lib/ai-catalog.mjs';

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'aio-ai-'));
const TOKEN = 'sk-ant-oat01-' + 'B'.repeat(40);
const URL_ = 'https://claude.com/cai/oauth/authorize?code=true&client_id=x&state=y';

// 本体（Paperclip 2026.1001.0）の担当の設定の扱いを写す（routes/agents.js・redaction.js）:
// - 一覧は env の値を伏せ字（secret_ref はそのまま・文字と plain は { type: 'plain', value: '***REDACTED***' }）、auth・token・secret・password を含む key は '***REDACTED***'
// - PATCH は env の伏せ字を保存してある値に戻す（restoreRedactedAgentEnv）。種類が変わる時は、送らなかった種類によらない key（ADAPTER_AGNOSTIC_KEYS）と指示書の key だけを持ち越す。
//   種類が同じ時は今の設定に重ねる
const REDACTED = '***REDACTED***';
const AGNOSTIC = ['env', 'promptTemplate', 'instructionsFilePath', 'cwd', 'timeoutSec', 'graceSec', 'bootstrapPromptTemplate', 'paperclipSkillSync'];
const BUNDLE = ['instructionsBundleMode', 'instructionsRootPath', 'instructionsEntryFile', 'instructionsFilePath', 'agentsMdPath'];
const redactConfig = c => { if (!c || typeof c !== 'object') return c; const out = {}; for (const [k, v] of Object.entries(c)) { if (k === 'env' && v && typeof v === 'object') out.env = Object.fromEntries(Object.entries(v).map(([ek, ev]) => [ek, ev && typeof ev === 'object' && ev.type === 'secret_ref' ? ev : typeof ev === 'string' || (ev && ev.type === 'plain') ? { type: 'plain', value: REDACTED } : ev == null ? ev : REDACTED])); else out[k] = /auth|token|secret|password/i.test(k) ? REDACTED : v; } return out; };
function patchAgent(ag, body) {
  const existing = ag.adapterConfig || {}, changing = typeof body.adapterType === 'string' && body.adapterType !== ag.adapterType;
  if (body.adapterConfig) {
    let next = { ...body.adapterConfig };
    if (next.env && existing.env) next.env = Object.fromEntries(Object.entries(next.env).map(([k, v]) => [k, v && v.type === 'plain' && v.value === REDACTED && k in existing.env ? existing.env[k] : v]));
    if (changing) { for (const k of AGNOSTIC) if (next[k] === undefined && existing[k] !== undefined) next[k] = existing[k]; for (const k of BUNDLE) if (next[k] === undefined && existing[k] !== undefined) next[k] = existing[k]; }
    else next = { ...existing, ...next };
    ag.adapterConfig = next;
  }
  if (body.adapterType) ag.adapterType = body.adapterType;
  ag.patches = [...(ag.patches || []), body];
}
const agentsDelay = { ms: 0 }; // 担当の一覧の応答を遅らせる（同時の保存の試験）
const createDelay = { ms: 0 }; // 担当を作る応答を遅らせる（作っている最中は一覧に出ない・鎖の外の窓の試験）
function fakePaperclip(dir) {
  const calls = [], agents = [], secrets = [];
  const srv = http.createServer((req, res) => {
    let b = ''; req.on('data', c => { b += c; }); req.on('end', () => {
      const body = b ? JSON.parse(b) : null; calls.push({ method: req.method, url: req.url, body });
      const json = (s, o) => { res.writeHead(s, { 'content-type': 'application/json' }); res.end(JSON.stringify(o)); };
      if (req.method === 'POST' && req.url === '/api/companies') return json(201, { id: 'c1', name: body.name, issuePrefix: 'ACM' });
      if (req.method === 'GET' && req.url === '/api/adapters') return json(200, [{ type: 'codex_local' }, { type: 'claude_local' }, { type: 'grok_local' }, { type: 'gemini_local' }, { type: 'kimi_local' }, { type: 'muse_local', label: 'Muse' }, { type: 'process' }]);
      if (req.method === 'POST' && req.url === '/api/companies/c1/secrets') { const s = { id: `00000000-0000-4000-8000-00000000000${secrets.length + 1}`, name: body.name, key: body.key }; secrets.push({ ...s, value: body.value }); return json(201, s); }
      const rot = req.url.match(/^\/api\/secrets\/([^/]+)\/rotate$/);
      if (req.method === 'POST' && rot) { const s = secrets.find(x => x.id === rot[1]); if (!s) return json(404, { error: 'Secret not found' }); s.value = body.value; s.rotated = (s.rotated || 0) + 1; return json(200, { id: s.id }); }
      const te = req.url.match(/^\/api\/companies\/c1\/adapters\/([a-z_]+)\/test-environment$/);
      if (req.method === 'POST' && te) return json(200, { adapterType: te[1], status: 'pass' });
      if (req.method === 'GET' && req.url === '/api/companies/c1/agents') return setTimeout(() => json(200, agents.map(a => ({ ...a, adapterConfig: redactConfig(a.adapterConfig) }))), agentsDelay.ms); // 本体と同じく設定を伏せ字で返す
      const pa = req.url.match(/^\/api\/agents\/([^/]+)$/);
      if (req.method === 'PATCH' && pa) { const ag = agents.find(x => x.id === pa[1]); if (!ag) return json(404, { error: 'nope' }); if (ag.failPatch) return json(ag.failPatch === true ? 500 : ag.failPatch, { error: 'boom' }); patchAgent(ag, body); return json(200, { ...ag, adapterConfig: redactConfig(ag.adapterConfig) }); }
      if (req.method === 'POST' && req.url === '/api/companies/c1/agents') { const a = { id: `a${agents.length + 1}`, ...body, adapterConfig: { ...body.adapterConfig, instructionsFilePath: path.join(dir, `a${agents.length + 1}`, 'AGENTS.md') } }; return setTimeout(() => { agents.push(a); json(201, a); }, createDelay.ms); }
      return json(404, { error: 'nope' });
    });
  });
  return { srv, calls, agents, secrets };
}
// 偽の子 process（Claude の setup-token と、AI の CLI のダウンロード）
function fakeSpawn() {
  const procs = [];
  const fn = (cmd, args, opts) => {
    const c = new EventEmitter(); c.stdout = new EventEmitter(); c.stderr = new EventEmitter(); c.written = []; c.stdin = { write: d => c.written.push(d) }; c.kill = () => c.emit('exit', null);
    procs.push({ cmd, args, opts, c }); return c;
  };
  return { fn, procs };
}
const listen = srv => new Promise(r => srv.listen(0, '127.0.0.1', () => r(srv.address().port)));
function req(port, method, p, { body, cookie } = {}) {
  return new Promise((resolve, reject) => {
    const headers = { host: `127.0.0.1:${port}` }; if (cookie) headers.cookie = cookie;
    const data = body == null ? null : JSON.stringify(body); if (data) { headers['content-type'] = 'application/json'; headers['content-length'] = Buffer.byteLength(data); }
    const r = http.request({ host: '127.0.0.1', port, method, path: p, headers }, res => { let t = ''; res.on('data', c => { t += c; }); res.on('end', () => { let j = null; try { j = JSON.parse(t); } catch { /* 文字 */ } resolve({ status: res.statusCode, json: j, text: t, headers: res.headers }); }); });
    r.on('error', reject); if (data) r.write(data); r.end();
  });
}
const tick = () => new Promise(r => setImmediate(r));

async function setup() {
  const dir = tmp(), pc = fakePaperclip(dir), pcPort = await listen(pc.srv), sp = fakeSpawn(), cx = fakeSpawn();
  let installed = new Set();
  const L = createLauncher({ dataDir: path.join(dir, 'aioffice'), paperclipUrl: `http://127.0.0.1:${pcPort}`, codexHome: path.join(dir, 'codex-home'), spawnFn: cx.fn, aiSpawnFn: sp.fn, aiExists: p => installed.has(p), claudeTmpRoot: dir });
  const port = await listen(L.server);
  await req(port, 'POST', '/setup/api/lang', { body: { lang: 'ja' } });
  const o = await req(port, 'POST', '/setup/api/owner', { body: { password: 'long enough pw' } });
  const cookie = o.headers['set-cookie'][0].split(';')[0];
  await req(port, 'POST', '/setup/api/company', { body: { name: 'Example' }, cookie });
  return { dir, pc, sp, cx, L, port, cookie, install: p => installed.add(p), close: () => { L.server.close(); pc.srv.close(); } };
}

test('AI の一覧: 表にある AI を出し、表に無い AI（Muse）は「出るが選べない」、外す型は出さない', async () => {
  const x = await setup();
  try {
    const r = await req(x.port, 'GET', '/setup/api/ai', { cookie: x.cookie });
    assert.equal(r.status, 200);
    assert.deepEqual(r.json.ais.map(a => [a.type, a.selectable]), [['codex_local', true], ['claude_local', true], ['grok_local', true], ['gemini_local', true], ['kimi_local', true], ['muse_local', false]]);
    assert.equal(r.json.ais.find(a => a.type === 'claude_local').install.status, 'pending');
  } finally { x.close(); }
});

test('Claude: ダウンロード → つなぐ → code → token は会社の秘密にだけ入り、応答と状態の file に出ない → Claude の担当は token の秘密を指す', async () => {
  const x = await setup();
  try {
    assert.equal((await req(x.port, 'POST', '/setup/api/ai/start', { body: { type: 'claude_local' }, cookie: x.cookie })).json.error, 'ai_install_first');
    const ins = await req(x.port, 'POST', '/setup/api/ai/install', { body: { type: 'claude_local' }, cookie: x.cookie });
    assert.equal(ins.json.status, 'running');
    assert.deepEqual(x.sp.procs[0].args.slice(0, 3), ['install', '--prefix', '/data/aitools/claude_local']);
    x.install('/data/aitools/claude_local/node_modules/.bin/claude'); x.sp.procs[0].c.emit('close', 0);
    x.install('/data/aitools/claude_local/VERIFIED'); x.sp.procs[1].c.emit('close', 0); // --version が通る
    assert.equal((await req(x.port, 'POST', '/setup/api/ai/start', { body: { type: 'claude_local' }, cookie: x.cookie })).json.state, 'starting');
    const pty = x.sp.procs[2];
    assert.equal(pty.cmd, 'script');
    pty.c.stdout.emit('data', Buffer.from(`${URL_}\r\nPaste code here > `));
    const w = await req(x.port, 'GET', '/setup/api/ai', { cookie: x.cookie });
    assert.deepEqual([w.json.claude.state, w.json.claude.url], ['waiting', URL_]);
    assert.equal((await req(x.port, 'POST', '/setup/api/ai/code', { body: { type: 'claude_local', code: 'no good' }, cookie: x.cookie })).json.error, 'ai_bad_code');
    assert.equal((await req(x.port, 'POST', '/setup/api/ai/code', { body: { type: 'claude_local', code: 'abcdefgh1234#st' }, cookie: x.cookie })).status, 200);
    assert.deepEqual(pty.c.written, ['abcdefgh1234#st'], 'code だけを先に書く（Enter は少し後に別に送る）');
    await new Promise(r => setTimeout(r, 500));
    assert.deepEqual(pty.c.written, ['abcdefgh1234#st', '\r']);
    pty.c.stdout.emit('data', Buffer.from(`${TOKEN}\r\n`));
    for (let i = 0; i < 20 && !x.pc.secrets.length; i += 1) await new Promise(r => setTimeout(r, 10));
    await tick(); await tick();
    assert.equal(x.pc.secrets.length, 1);
    assert.equal(x.pc.secrets[0].value, TOKEN);
    assert.match(x.pc.secrets[0].key, /^CLAUDE_CODE_OAUTH_TOKEN_\d+$/);
    const list = await req(x.port, 'GET', '/setup/api/ai', { cookie: x.cookie });
    assert.equal(list.json.ais.find(a => a.type === 'claude_local').connected, true);
    assert.doesNotMatch(list.text, /sk-ant/);
    const st = await req(x.port, 'GET', '/setup/api/state', { cookie: x.cookie });
    assert.doesNotMatch(st.text, /sk-ant/);
    assert.doesNotMatch(fs.readFileSync(path.join(x.dir, 'aioffice', 'state.json'), 'utf8'), /sk-ant/);
    // 選ぶ: つないでいない AI（Codex）は選ばれない
    const ch = await req(x.port, 'POST', '/setup/api/ai/choose', { body: { types: ['claude_local', 'codex_local'] }, cookie: x.cookie });
    assert.deepEqual(ch.json.ai.selected, ['claude_local']);
    await req(x.port, 'POST', '/setup/api/secretary', { body: { name: 'Sec', ai: 'claude_local' }, cookie: x.cookie });
    const a = x.pc.agents[0];
    assert.equal(a.adapterType, 'claude_local');
    assert.equal(a.adapterConfig.engine, 'cli');
    assert.equal(a.adapterConfig.command, '/data/aitools/claude_local/node_modules/.bin/claude');
    assert.deepEqual(a.adapterConfig.env.CLAUDE_CODE_OAUTH_TOKEN, { type: 'secret_ref', secretId: x.pc.secrets[0].id });
  } finally { x.close(); }
});

test('つないだ AI が無い時は「あとでつなぐ」でだけ進め、その時の担当は前の版と同じ Codex（engine cli）', async () => {
  const x = await setup();
  try {
    assert.equal((await req(x.port, 'POST', '/setup/api/ai/choose', { body: { types: ['claude_local'] }, cookie: x.cookie })).json.error, 'ai_none');
    const ch = await req(x.port, 'POST', '/setup/api/ai/choose', { body: { types: [], later: true }, cookie: x.cookie });
    assert.deepEqual([ch.json.ai.chosen, ch.json.ai.selected], [true, ['codex_local']]);
    await req(x.port, 'POST', '/setup/api/secretary', { body: { name: 'Sec' }, cookie: x.cookie });
    await req(x.port, 'POST', '/setup/api/agents', { body: { ids: ['research'], ai: { research: 'claude_local' } }, cookie: x.cookie });
    assert.equal(x.pc.agents.length, 2, '秘書と調べもの係');
    for (const a of x.pc.agents) { assert.equal(a.adapterType, 'codex_local'); assert.deepEqual(a.adapterConfig.engine, 'cli'); }
  } finally { x.close(); }
});

test('ダウンロードしていない AI（Grok）のつなぎは ai_install_first で断り、表に無い AI は ai_unknown', async () => {
  const x = await setup();
  try {
    assert.equal((await req(x.port, 'POST', '/setup/api/ai/start', { body: { type: 'grok_local' }, cookie: x.cookie })).json.error, 'ai_install_first');
    assert.equal((await req(x.port, 'POST', '/setup/api/ai/install', { body: { type: 'muse_local' }, cookie: x.cookie })).json.error, 'ai_unknown');
    assert.equal((await req(x.port, 'POST', '/setup/api/ai/start', { body: { type: 'process' }, cookie: x.cookie })).json.error, 'ai_unknown');
  } finally { x.close(); }
});

test('AI の口は持ち主だけ', async () => {
  const x = await setup();
  try {
    assert.equal((await req(x.port, 'GET', '/setup/api/ai')).status, 401);
    assert.equal((await req(x.port, 'POST', '/setup/api/ai/install', { body: { type: 'claude_local' } })).status, 401);
  } finally { x.close(); }
});

test('つなぎ直しは同じ秘密の値を rotate で替え、秘密を増やさない（独立レビュー P2-4）', async () => {
  const x = await setup();
  try {
    x.install('/data/aitools/claude_local/VERIFIED');
    for (const tok of [TOKEN, TOKEN.replace(/B/g, 'C')]) {
      await req(x.port, 'POST', '/setup/api/ai/start', { body: { type: 'claude_local' }, cookie: x.cookie });
      const pty = x.sp.procs.at(-1);
      pty.c.stdout.emit('data', Buffer.from(`${URL_}\r\n`));
      await req(x.port, 'POST', '/setup/api/ai/code', { body: { type: 'claude_local', code: 'abcdefgh1234' }, cookie: x.cookie });
      pty.c.stdout.emit('data', Buffer.from(`${tok}\r\n`));
      for (let i = 0; i < 30 && (x.pc.secrets.length === 0 || (tok !== TOKEN && !x.pc.secrets[0].rotated)); i += 1) await new Promise(r => setTimeout(r, 10));
    }
    assert.equal(x.pc.secrets.length, 1);
    assert.equal(x.pc.secrets[0].rotated, 1);
    assert.equal(x.pc.secrets[0].value, TOKEN.replace(/B/g, 'C'));
  } finally { x.close(); }
});

test('test-environment の口は選んだ AI の型で本体を呼ぶ', async () => {
  const x = await setup();
  try {
    const r = await req(x.port, 'POST', '/setup/api/ai/check', { body: { type: 'claude_local' }, cookie: x.cookie });
    assert.deepEqual(r.json, { ok: true, result: { adapterType: 'claude_local', status: 'pass' } });
    assert.equal((await req(x.port, 'POST', '/setup/api/ai/cancel', { body: { type: 'muse_local' }, cookie: x.cookie })).json.error, 'ai_unknown');
  } finally { x.close(); }
});

// ---- オフィスの「AI の契約」の欄の口（範囲 docs/review/2026-11-18-office-ai-panel-ux-scope.md F1・F2） ----
// Claude を偽の PTY でつなぐ（ダウンロード済みにしてから）
async function connectClaude(x, tok = TOKEN) {
  x.install('/data/aitools/claude_local/VERIFIED');
  await req(x.port, 'POST', '/setup/api/ai/start', { body: { type: 'claude_local' }, cookie: x.cookie });
  const pty = x.sp.procs.at(-1);
  pty.c.stdout.emit('data', Buffer.from(`${URL_}\r\n`));
  await req(x.port, 'POST', '/setup/api/ai/code', { body: { type: 'claude_local', code: 'abcdefgh1234' }, cookie: x.cookie });
  pty.c.stdout.emit('data', Buffer.from(`${tok}\r\n`));
  for (let i = 0; i < 50; i += 1) { const v = await req(x.port, 'GET', '/setup/api/ai', { cookie: x.cookie }); if (v.json.claude.state === 'done') return; await new Promise(r => setTimeout(r, 10)); }
  throw new Error('Claude がつながらない');
}
const selected = async x => (await req(x.port, 'GET', '/setup/api/state', { cookie: x.cookie })).json.ai.selected;

test('F2: つないだ AI は起動係が「使う AI」に足す（和集合）。Claude の token の保存・ChatGPT のログインの成功の両方', async () => {
  const x = await setup();
  try {
    // wizard で ChatGPT 以外だけを選んだ会社と同じ形: 先に「あとで」で ['codex_local'] にしてから Claude をつなぐ
    await req(x.port, 'POST', '/setup/api/ai/choose', { body: { types: [], later: true }, cookie: x.cookie });
    assert.deepEqual(await selected(x), ['codex_local']);
    await connectClaude(x);
    assert.deepEqual(await selected(x), ['codex_local', 'claude_local'], 'Claude を足す（前の選択は消さない）');
    // つなぎ直し（rotate）でも 2 つ目を足さない
    await connectClaude(x, TOKEN.replace(/B/g, 'D'));
    assert.deepEqual(await selected(x), ['codex_local', 'claude_local']);
    // ChatGPT のログインの成功: auth.json ができて 0 で終わると足す（選ぶ前の会社でも）
    x.L.store.update(s => { s.aiSelected = ['claude_local']; });
    assert.equal((await req(x.port, 'POST', '/setup/api/ai/start', { body: { type: 'codex_local' }, cookie: x.cookie })).json.state, 'starting');
    for (let i = 0; i < 50 && !x.cx.procs.length; i += 1) await new Promise(r => setTimeout(r, 5));
    fs.mkdirSync(path.join(x.dir, 'codex-home'), { recursive: true });
    fs.writeFileSync(path.join(x.dir, 'codex-home', 'auth.json'), '{"tokens":{}}');
    x.cx.procs[0].c.emit('exit', 0);
    assert.deepEqual(await selected(x), ['claude_local', 'codex_local']);
  } finally { x.close(); }
});

test('F1: 社員ごとの AI の読み取りと保存（本体の adapterType から読み、AI の key だけを入れ替え、ほかは残す・担当ごとの結果）', async () => {
  const x = await setup();
  try {
    assert.equal((await req(x.port, 'GET', '/setup/api/agents/ai')).status, 401, '持ち主だけ');
    assert.equal((await req(x.port, 'POST', '/setup/api/agents/ai', { body: { assign: { a1: 'claude_local' } } })).status, 401);
    await req(x.port, 'POST', '/setup/api/ai/choose', { body: { types: [], later: true }, cookie: x.cookie });
    await req(x.port, 'POST', '/setup/api/secretary', { body: { name: 'Sec' }, cookie: x.cookie });
    await req(x.port, 'POST', '/setup/api/agents', { body: { ids: ['research'] }, cookie: x.cookie });
    const [sec, res] = x.pc.agents;
    res.adapterConfig = { ...res.adapterConfig, env: { FOO: 'keep', CODEX_HOME: '/old', OPENAI_API_KEY: 'x' }, model: 'm1', apiToken: 'tok-value', cwd: '/work' }; // AI の key（CODEX_HOME・OPENAI_API_KEY）・ほかの env（FOO）・前の種類の key（model・apiToken）・種類によらない key（cwd）
    x.pc.agents.push({ id: 'bad', name: 'Broken', adapterType: 'codex_local', adapterConfig: {}, failPatch: true });

    const list = await req(x.port, 'GET', '/setup/api/agents/ai', { cookie: x.cookie });
    assert.equal(list.status, 200);
    assert.deepEqual(list.json.agents.map(a => [a.id, a.adapterType]), [[sec.id, 'codex_local'], [res.id, 'codex_local'], ['bad', 'codex_local']], '会社の全担当・今の AI は本体の adapterType');
    assert.equal(JSON.stringify(list.json).includes('adapterConfig'), false, '設定（秘密の参照など）は返さない');

    // つないでいない AI へは替えない・表に無い・形の違う中身は断る
    assert.deepEqual((await req(x.port, 'POST', '/setup/api/agents/ai', { body: { assign: { [sec.id]: 'claude_local' } }, cookie: x.cookie })).json, { error: 'ai_not_connected', type: 'claude_local' });
    assert.equal((await req(x.port, 'POST', '/setup/api/agents/ai', { body: { assign: { [sec.id]: 'process' } }, cookie: x.cookie })).json.error, 'ai_unknown');
    for (const assign of [[], {}, 'x', { [sec.id]: 3 }]) assert.equal((await req(x.port, 'POST', '/setup/api/agents/ai', { body: { assign }, cookie: x.cookie })).json.error, 'assign_bad', JSON.stringify(assign));

    await connectClaude(x);
    const sid = x.pc.secrets[0].id;
    const r = await req(x.port, 'POST', '/setup/api/agents/ai', { body: { assign: { [sec.id]: 'claude_local', [res.id]: 'claude_local', bad: 'claude_local', nobody: 'claude_local' } }, cookie: x.cookie });
    assert.equal(r.status, 200);
    assert.deepEqual(r.json.results, { [sec.id]: { ok: true, why: null }, [res.id]: { ok: true, why: null }, bad: { ok: false, why: 'paperclip_500' }, nobody: { ok: false, why: 'agent_unknown' } }, '失敗した担当はその旨、ほかは保存');
    assert.equal(sec.adapterType, 'claude_local');
    assert.deepEqual(sec.adapterConfig, { instructionsFilePath: sec.adapterConfig.instructionsFilePath, ...deskAdapterConfig('claude_local', { claudeSecretId: sid }) }, '指示書の置き場は残し、Claude の設定と token の秘密の参照を付ける');
    assert.ok(sec.adapterConfig.instructionsFilePath);
    assert.deepEqual(res.adapterConfig.env, { FOO: 'keep', CLAUDE_CODE_OAUTH_TOKEN: { type: 'secret_ref', secretId: sid } }, 'env の AI の key だけを入れ替える');
    assert.equal(res.adapterConfig.model, undefined, '種類が変わると前の種類の key（model）は本体が捨てる');
    assert.equal(res.adapterConfig.cwd, '/work', '種類によらない key（cwd）は本体が持ち越す');
    const sent = res.patches[0].adapterConfig;
    assert.deepEqual(Object.keys(sent).sort(), ['command', 'engine', 'env'], '送るのは新しい AI の設定と env だけ（今の設定の丸ごと・伏せ字の key は送らない）');
    assert.deepEqual(sent.env.FOO, { type: 'plain', value: '***REDACTED***' }, 'env の伏せ字はそのまま送り返し、本体が元へ戻す');
    assert.equal(JSON.stringify(res.patches).includes('tok-value'), false);
    const st = (await req(x.port, 'GET', '/setup/api/state', { cookie: x.cookie })).json;
    assert.deepEqual([st.ai.agentAi.secretary, st.ai.agentAi.research], ['claude_local', 'claude_local'], '起動係の記録も替える');

    // 同じ AI への保存は本体を呼ばずに ok
    const before = x.pc.calls.filter(c => c.method === 'PATCH').length;
    assert.deepEqual((await req(x.port, 'POST', '/setup/api/agents/ai', { body: { assign: { [sec.id]: 'claude_local' } }, cookie: x.cookie })).json.results, { [sec.id]: { ok: true, why: 'same' } });
    assert.equal(x.pc.calls.filter(c => c.method === 'PATCH').length, before);

    // ChatGPT に戻す: auth.json があれば「つないだ」。Codex は前の版と同じ形（engine cli）で、command と Claude の token は外す
    fs.mkdirSync(path.join(x.dir, 'codex-home'), { recursive: true });
    fs.writeFileSync(path.join(x.dir, 'codex-home', 'auth.json'), '{"tokens":{}}');
    assert.equal((await req(x.port, 'GET', '/setup/api/ai', { cookie: x.cookie })).json.ais.find(a => a.type === 'codex_local').connected, true, '後から置いた auth.json も読む');
    assert.deepEqual((await req(x.port, 'POST', '/setup/api/agents/ai', { body: { assign: { [res.id]: 'codex_local' } }, cookie: x.cookie })).json.results, { [res.id]: { ok: true, why: null } });
    assert.equal(res.adapterType, 'codex_local');
    assert.deepEqual(res.adapterConfig, { instructionsFilePath: res.adapterConfig.instructionsFilePath, cwd: '/work', engine: 'cli', env: { FOO: 'keep' } });
  } finally { x.close(); }
});

test('F1: 割り当ての保存は同時に 1 本だけ（2 本目は assign_busy）', async () => {
  const x = await setup();
  try {
    await req(x.port, 'POST', '/setup/api/ai/choose', { body: { types: [], later: true }, cookie: x.cookie });
    await req(x.port, 'POST', '/setup/api/secretary', { body: { name: 'Sec' }, cookie: x.cookie });
    await connectClaude(x);
    const id = x.pc.agents[0].id;
    agentsDelay.ms = 200;
    const [a, b] = await Promise.all([1, 2].map(() => req(x.port, 'POST', '/setup/api/agents/ai', { body: { assign: { [id]: 'claude_local' } }, cookie: x.cookie })));
    assert.deepEqual([a.status, b.status].sort(), [200, 409]);
    assert.equal([a, b].find(v => v.status === 409).json.error, 'assign_busy');
  } finally { agentsDelay.ms = 0; x.close(); }
});

test('swapAdapterConfig: 新しい AI の設定と、今の env から AI の key を抜いて重ねた env だけを返す', () => {
  assert.deepEqual(swapAdapterConfig({ command: '/x/claude', engine: 'cli', instructionsFilePath: '/p', env: { CLAUDE_CODE_OAUTH_TOKEN: { type: 'secret_ref', secretId: 's' } } }, { engine: 'cli' }), { engine: 'cli', env: {} }, '今の設定は送らない・env は空でも送る（本体が前の env を持ち越さない）');
  assert.deepEqual(swapAdapterConfig(undefined, { command: 'c', env: { HOME: '/h' } }), { command: 'c', env: { HOME: '/h' } });
  assert.deepEqual(swapAdapterConfig({ env: { A: '1', GEMINI_API_KEY: 'k' } }, { engine: 'cli' }), { engine: 'cli', env: { A: '1' } });
});

test('起動の時に 1 回、前からつないである AI（置いてある auth.json）を「使う AI」に足す（独立レビュー r2 の 6）', async () => {
  const dir = tmp(), home = path.join(dir, 'codex-home');
  fs.mkdirSync(home, { recursive: true }); fs.writeFileSync(path.join(home, 'auth.json'), '{"tokens":{}}');
  const pc = fakePaperclip(dir), pcPort = await listen(pc.srv);
  const mk = () => createLauncher({ dataDir: path.join(dir, 'aioffice'), paperclipUrl: `http://127.0.0.1:${pcPort}`, codexHome: home, spawnFn: fakeSpawn().fn, aiSpawnFn: fakeSpawn().fn, aiExists: () => false, claudeTmpRoot: dir });
  const L = mk();
  try {
    assert.deepEqual(L.store.get().aiSelected, ['codex_local']);
    L.store.update(s => { s.aiSelected = ['claude_local']; });
    const L2 = mk();
    assert.deepEqual(L2.store.get().aiSelected, ['claude_local', 'codex_local'], '前の選択は消さずに足す');
    const L3 = mk();
    assert.deepEqual(L3.store.get().aiSelected, ['claude_local', 'codex_local'], '2 回目は増やさない');
  } finally { pc.srv.close(); }
});

test('本体で Claude の秘密が消された後: つなぎ直しで作った新しい秘密へ、前からいる Claude の担当の参照を付け替える・欄の保存でも付け替える（独立レビュー r3 の A）', async () => {
  const x = await setup();
  try {
    await req(x.port, 'POST', '/setup/api/ai/choose', { body: { types: [], later: true }, cookie: x.cookie });
    await req(x.port, 'POST', '/setup/api/secretary', { body: { name: 'Sec' }, cookie: x.cookie });
    await req(x.port, 'POST', '/setup/api/agents', { body: { ids: ['research'] }, cookie: x.cookie });
    await connectClaude(x);
    const [sec, res] = x.pc.agents, sid1 = x.pc.secrets[0].id;
    await req(x.port, 'POST', '/setup/api/agents/ai', { body: { assign: { [sec.id]: 'claude_local' } }, cookie: x.cookie });
    assert.equal(sec.adapterConfig.env.CLAUDE_CODE_OAUTH_TOKEN.secretId, sid1);
    // 本体で秘密が消された → つなぎ直すと rotate が 404 → 新しい秘密を作り、Claude の担当（sec）だけを付け替える
    x.pc.secrets[0] = { id: 'deleted' }; // 本体で消された（偽の本体の id は数で振るので、席は残す）
    const patchesBefore = x.pc.calls.filter(c => c.method === 'PATCH').length;
    await connectClaude(x, TOKEN.replace(/B/g, 'D'));
    const sid2 = x.L.store.get().ais.claude_local.secretId;
    assert.notEqual(sid2, sid1);
    assert.equal(sec.adapterType, 'claude_local');
    assert.deepEqual(sec.adapterConfig.env.CLAUDE_CODE_OAUTH_TOKEN, { type: 'secret_ref', secretId: sid2 }, '新しい秘密を指す');
    assert.ok(sec.adapterConfig.instructionsFilePath, '指示書の置き場は残る');
    const relink = x.pc.calls.filter(c => c.method === 'PATCH').slice(patchesBefore);
    assert.deepEqual(relink.map(c => [c.url, 'adapterType' in c.body]), [[`/api/agents/${sec.id}`, false]], 'Claude の担当だけ・種類は送らない');
    assert.equal(res.adapterType, 'codex_local');
    // 秘密が残っている時のつなぎ直し（rotate）は、参照が合っていれば何も PATCH しない
    const n = x.pc.calls.filter(c => c.method === 'PATCH').length;
    await connectClaude(x, TOKEN.replace(/B/g, 'E'));
    assert.equal(x.pc.calls.filter(c => c.method === 'PATCH').length, n);
    // 欄の保存: 同じ Claude でも、古い秘密を指していれば付け替える（why relinked）。合っていれば same
    sec.adapterConfig.env.CLAUDE_CODE_OAUTH_TOKEN = { type: 'secret_ref', secretId: sid1 };
    const r = await req(x.port, 'POST', '/setup/api/agents/ai', { body: { assign: { [sec.id]: 'claude_local' } }, cookie: x.cookie });
    assert.deepEqual(r.json.results, { [sec.id]: { ok: true, why: 'relinked' } });
    assert.equal(sec.adapterConfig.env.CLAUDE_CODE_OAUTH_TOKEN.secretId, sid2);
    assert.deepEqual((await req(x.port, 'POST', '/setup/api/agents/ai', { body: { assign: { [sec.id]: 'claude_local' } }, cookie: x.cookie })).json.results, { [sec.id]: { ok: true, why: 'same' } });
  } finally { x.close(); }
});

test('swapAdapterConfig: 本体が文字の伏せ字にした env の値は送らない（独立レビュー r3 の B）', () => {
  assert.deepEqual(swapAdapterConfig({ env: { A: { type: 'plain', value: '***REDACTED***' }, B: '***REDACTED***', S: { type: 'secret_ref', secretId: 's' } } }, { engine: 'cli' }),
    { engine: 'cli', env: { A: { type: 'plain', value: '***REDACTED***' }, S: { type: 'secret_ref', secretId: 's' } } });
});

test('付け替えるのは消えた秘密を指していた Claude の担当だけ・env の token の参照だけを替える・初めてつなぐ時は誰も付け替えない（独立レビュー r4 の A\'）', async () => {
  const x = await setup();
  try {
    await req(x.port, 'POST', '/setup/api/ai/choose', { body: { types: [], later: true }, cookie: x.cookie });
    await req(x.port, 'POST', '/setup/api/secretary', { body: { name: 'Sec' }, cookie: x.cookie });
    // 本体の画面で作った Claude の担当（参照の無い・自分の API の鍵・別の秘密・plain の token）
    const noref = { id: 'noref', name: 'NoRef', adapterType: 'claude_local', adapterConfig: { command: '/custom/claude' } };
    const apikey = { id: 'apikey', name: 'Key', adapterType: 'claude_local', adapterConfig: { command: '/custom/claude', env: { ANTHROPIC_API_KEY: 'sk-own' } } };
    const other = { id: 'other', name: 'Other', adapterType: 'claude_local', adapterConfig: { env: { CLAUDE_CODE_OAUTH_TOKEN: { type: 'secret_ref', secretId: 'someone-else' } } } };
    const plain = { id: 'plain', name: 'Plain', adapterType: 'claude_local', adapterConfig: { env: { CLAUDE_CODE_OAUTH_TOKEN: 'tok-plain' } } };
    x.pc.agents.push(noref, apikey, other, plain);
    const snap = () => JSON.stringify([noref, apikey, other, plain].map(a => a.adapterConfig));
    const before = snap(), patches = () => x.pc.calls.filter(c => c.method === 'PATCH').map(c => c.url);
    // 初めてつなぐ時は誰も付け替えない
    await connectClaude(x);
    assert.deepEqual(patches(), [], '初めてつなぐ時は PATCH しない');
    const sid1 = x.pc.secrets[0].id;
    const [sec] = x.pc.agents;
    await req(x.port, 'POST', '/setup/api/agents/ai', { body: { assign: { [sec.id]: 'claude_local' } }, cookie: x.cookie });
    sec.adapterConfig.command = '/my/claude'; sec.adapterConfig.env.FOO = 'keep'; sec.adapterConfig.env.ANTHROPIC_API_KEY = 'sk-sec';
    const n = patches().length;
    // 本体で秘密が消された → 作り直し → 消えた秘密（sid1）を指していた sec だけを付け替える
    x.pc.secrets[0] = { id: 'deleted' };
    await connectClaude(x, TOKEN.replace(/B/g, 'D'));
    const sid2 = x.L.store.get().ais.claude_local.secretId;
    assert.notEqual(sid2, sid1);
    assert.deepEqual(patches().slice(n), [`/api/agents/${sec.id}`], 'sec だけ');
    assert.deepEqual(x.pc.calls.filter(c => c.method === 'PATCH').at(-1).body, { adapterConfig: { env: {
      CLAUDE_CODE_OAUTH_TOKEN: { type: 'secret_ref', secretId: sid2 }, FOO: { type: 'plain', value: '***REDACTED***' }, ANTHROPIC_API_KEY: { type: 'plain', value: '***REDACTED***' } } } }, 'env だけを送り、token の参照のほかは伏せ字のまま送り返す');
    assert.equal(sec.adapterConfig.command, '/my/claude', 'command は替えない');
    assert.equal(sec.adapterConfig.engine, 'cli');
    assert.deepEqual(sec.adapterConfig.env, { CLAUDE_CODE_OAUTH_TOKEN: { type: 'secret_ref', secretId: sid2 }, FOO: 'keep', ANTHROPIC_API_KEY: 'sk-sec' }, 'ほかの env は残る');
    assert.equal(snap(), before, '参照の無い・API の鍵・別の秘密・plain の担当には触らない');
    // 欄の保存（同じ Claude）: 参照の無い担当・plain は same、secret_ref で違う秘密を指す担当は付け替える（token の参照だけ）
    const r = await req(x.port, 'POST', '/setup/api/agents/ai', { body: { assign: { noref: 'claude_local', apikey: 'claude_local', plain: 'claude_local', other: 'claude_local' } }, cookie: x.cookie });
    assert.deepEqual(r.json.results, { noref: { ok: true, why: 'same' }, apikey: { ok: true, why: 'same' }, plain: { ok: true, why: 'same' }, other: { ok: true, why: 'relinked' } });
    assert.deepEqual(other.adapterConfig, { env: { CLAUDE_CODE_OAUTH_TOKEN: { type: 'secret_ref', secretId: sid2 } } });
    assert.deepEqual([noref.adapterConfig, apikey.adapterConfig, plain.adapterConfig], JSON.parse(before).filter((_, i) => i !== 2));
  } finally { x.close(); }
});

// ---- all-ai-v1 m04: Codex・Claude 以外のつなぎ（device code・ブラウザで許可・API の鍵） ----
async function installAi(x, type, bin) {
  await req(x.port, 'POST', '/setup/api/ai/install', { body: { type }, cookie: x.cookie });
  const n = x.sp.procs.length;
  x.install(bin); x.sp.procs[n - 1].c.emit('close', 0);
  x.install(`/data/aitools/${type}/VERIFIED`); x.sp.procs[n].c.emit('close', 0);
}

test('m04 Grok: ダウンロード → つなぐ（PTY で grok login --device-auth）→ URL と code を出す → 0 で終われば つないだ → 担当は GROK_HOME を volume に向け、鍵は渡さない', async () => {
  const x = await setup();
  try {
    await installAi(x, 'grok_local', '/data/aitools/grok_local/node_modules/.bin/grok');
    assert.equal((await req(x.port, 'POST', '/setup/api/ai/start', { body: { type: 'grok_local' }, cookie: x.cookie })).json.state, 'starting');
    await tick(); await tick();
    const pty = x.sp.procs.at(-1);
    assert.equal(pty.cmd, 'script');
    assert.equal(pty.args[0], '-qefc');
    assert.match(pty.args[1], /exec '\/data\/aitools\/grok_local\/node_modules\/\.bin\/grok' 'login' '--device-auth'$/);
    assert.equal(pty.args[2], '/dev/null');
    assert.equal(pty.opts.env.GROK_HOME, '/data/aitools/grok_local/home');
    assert.equal(pty.opts.env.HOME, '/data/aitools/grok_local/home');
    // 2026-11-20 に実測した出力
    pty.c.stdout.emit('data', Buffer.from('To sign in, open this URL in your browser:\r\n  https://accounts.x.ai/oauth2/device?user_code=TEXA-9YKN\r\nConfirm this code in your browser:\r\n  TEXA-9YKN\r\nWaiting for authorization...\r\n'));
    const w = await req(x.port, 'GET', '/setup/api/ai', { cookie: x.cookie });
    assert.deepEqual([w.json.logins.grok_local.state, w.json.logins.grok_local.url, w.json.logins.grok_local.code], ['waiting', 'https://accounts.x.ai/oauth2/device?user_code=TEXA-9YKN', 'TEXA-9YKN']);
    assert.equal(w.json.ais.find(a => a.type === 'grok_local').connected, false);
    // 二度押しは 2 本目を起こさない
    const before = x.sp.procs.length;
    await req(x.port, 'POST', '/setup/api/ai/start', { body: { type: 'grok_local' }, cookie: x.cookie });
    assert.equal(x.sp.procs.length, before);
    pty.c.emit('exit', 0);
    const d = await req(x.port, 'GET', '/setup/api/ai', { cookie: x.cookie });
    assert.equal(d.json.logins.grok_local.state, 'done');
    assert.equal(d.json.ais.find(a => a.type === 'grok_local').connected, true);
    const ch = await req(x.port, 'POST', '/setup/api/ai/choose', { body: { types: ['grok_local'] }, cookie: x.cookie });
    assert.deepEqual(ch.json.ai.selected, ['grok_local']);
    await req(x.port, 'POST', '/setup/api/secretary', { body: { name: 'Sec', ai: 'grok_local' }, cookie: x.cookie });
    const a = x.pc.agents[0];
    assert.equal(a.adapterType, 'grok_local');
    assert.equal(a.adapterConfig.command, '/data/aitools/grok_local/node_modules/.bin/grok');
    assert.deepEqual(a.adapterConfig.env, { GROK_HOME: '/data/aitools/grok_local/home' });
  } finally { x.close(); }
});

test('m04 つなぎの失敗・取り消し: 0 以外で終われば failed、取り消せば cancelled で、どちらも つないだ にしない', async () => {
  const x = await setup();
  try {
    await installAi(x, 'kimi_local', '/data/aitools/kimi_local/node_modules/.bin/kimi');
    await req(x.port, 'POST', '/setup/api/ai/start', { body: { type: 'kimi_local' }, cookie: x.cookie });
    await tick(); await tick();
    const p1 = x.sp.procs.at(-1);
    p1.c.stdout.emit('data', Buffer.from('If the browser did not open, paste the URL above and enter code: E9AZ-0HG9\r\nOpening browser for Kimi device login: https://www.kimi.com/code/authorize_device?user_code=E9AZ-0HG9\r\n'));
    p1.c.emit('exit', 1);
    let v = (await req(x.port, 'GET', '/setup/api/ai', { cookie: x.cookie })).json;
    assert.deepEqual([v.logins.kimi_local.state, v.logins.kimi_local.error], ['failed', 'login_failed']);
    await req(x.port, 'POST', '/setup/api/ai/start', { body: { type: 'kimi_local' }, cookie: x.cookie });
    await tick(); await tick();
    assert.equal((await req(x.port, 'POST', '/setup/api/ai/cancel', { body: { type: 'kimi_local' }, cookie: x.cookie })).json.state, 'cancelled');
    v = (await req(x.port, 'GET', '/setup/api/ai', { cookie: x.cookie })).json;
    assert.equal(v.ais.find(a => a.type === 'kimi_local')?.connected ?? false, false);
  } finally { x.close(); }
});

test('m04 API の鍵（Gemini）: 鍵は会社の秘密にだけ入り、応答・状態の file に出ない → 担当は GEMINI_API_KEY で秘密を指す・入れ直しは rotate', async () => {
  const x = await setup();
  const KEY = 'AIzaSy' + 'Q'.repeat(33);
  try {
    assert.equal((await req(x.port, 'POST', '/setup/api/ai/key', { body: { type: 'gemini_local', key: KEY }, cookie: x.cookie })).json.error, 'ai_install_first');
    await installAi(x, 'gemini_local', '/data/aitools/gemini_local/node_modules/.bin/gemini');
    assert.equal((await req(x.port, 'POST', '/setup/api/ai/key', { body: { type: 'gemini_local', key: 'short' }, cookie: x.cookie })).json.error, 'ai_bad_key');
    assert.equal((await req(x.port, 'POST', '/setup/api/ai/key', { body: { type: 'gemini_local', key: 'has space inside' }, cookie: x.cookie })).json.error, 'ai_bad_key');
    assert.equal((await req(x.port, 'POST', '/setup/api/ai/key', { body: { type: 'grok_local', key: KEY }, cookie: x.cookie })).json.error, 'ai_unknown', 'Grok は鍵の欄が無い');
    const r = await req(x.port, 'POST', '/setup/api/ai/key', { body: { type: 'gemini_local', key: KEY }, cookie: x.cookie });
    assert.equal(r.status, 200);
    assert.equal(x.pc.secrets.length, 1);
    assert.equal(x.pc.secrets[0].value, KEY);
    assert.match(x.pc.secrets[0].key, /^GEMINI_API_KEY_\d+$/);
    const list = await req(x.port, 'GET', '/setup/api/ai', { cookie: x.cookie });
    const g = list.json.ais.find(a => a.type === 'gemini_local');
    assert.deepEqual([g.connected, g.viaKey], [true, true]);
    for (const t of [r.text, list.text, (await req(x.port, 'GET', '/setup/api/state', { cookie: x.cookie })).text, fs.readFileSync(path.join(x.dir, 'aioffice', 'state.json'), 'utf8')]) assert.ok(!t.includes(KEY), '鍵が出ていない');
    await req(x.port, 'POST', '/setup/api/ai/choose', { body: { types: ['gemini_local'] }, cookie: x.cookie });
    await req(x.port, 'POST', '/setup/api/secretary', { body: { name: 'Sec', ai: 'gemini_local' }, cookie: x.cookie });
    const a = x.pc.agents[0];
    assert.equal(a.adapterType, 'gemini_local');
    assert.deepEqual(a.adapterConfig.env, { GEMINI_CLI_HOME: '/data/aitools/gemini_local/home', GEMINI_API_KEY: { type: 'secret_ref', secretId: x.pc.secrets[0].id } });
    await req(x.port, 'POST', '/setup/api/ai/key', { body: { type: 'gemini_local', key: KEY + 'X' }, cookie: x.cookie });
    assert.deepEqual([x.pc.secrets.length, x.pc.secrets[0].rotated, x.pc.secrets[0].value], [1, 1, KEY + 'X']);
  } finally { x.close(); }
});

test('m04 契約でつないだ AI には API の鍵を渡さない（鍵があると従量の課金になる CLI がある）', async () => {
  const x = await setup();
  const KEY = 'key_' + 'K'.repeat(30);
  try {
    await installAi(x, 'kimi_local', '/data/aitools/kimi_local/node_modules/.bin/kimi');
    await req(x.port, 'POST', '/setup/api/ai/key', { body: { type: 'kimi_local', key: KEY }, cookie: x.cookie });
    await req(x.port, 'POST', '/setup/api/ai/start', { body: { type: 'kimi_local' }, cookie: x.cookie });
    await tick(); await tick();
    const pty = x.sp.procs.at(-1);
    pty.c.stdout.emit('data', Buffer.from('Opening browser for Kimi device login: https://www.kimi.com/code/authorize_device?user_code=E9AZ-0HG9\r\nenter code: E9AZ-0HG9\r\n'));
    pty.c.emit('exit', 0);
    const g = (await req(x.port, 'GET', '/setup/api/ai', { cookie: x.cookie })).json.ais;
    await req(x.port, 'POST', '/setup/api/ai/choose', { body: { types: ['kimi_local'] }, cookie: x.cookie });
    await req(x.port, 'POST', '/setup/api/secretary', { body: { name: 'Sec', ai: 'kimi_local' }, cookie: x.cookie });
    assert.deepEqual(x.pc.agents[0].adapterConfig.env, { KIMI_CODE_HOME: '/data/aitools/kimi_local/home' });
    assert.equal(g.find(a => a.type === 'kimi_local')?.viaKey ?? false, false);
  } finally { x.close(); }
});

const until = async f => { for (let i = 0; i < 100 && !f(); i += 1) await new Promise(r => setTimeout(r, 10)); };

test('m04 鍵で担当を作った後に契約でつないだら、その担当から鍵の参照を外す（従量の課金を使い続けない・独立レビュー）', async () => {
  const x = await setup();
  try {
    await installAi(x, 'kimi_local', '/data/aitools/kimi_local/node_modules/.bin/kimi');
    await req(x.port, 'POST', '/setup/api/ai/key', { body: { type: 'kimi_local', key: 'key_' + 'K'.repeat(30) }, cookie: x.cookie });
    await req(x.port, 'POST', '/setup/api/ai/choose', { body: { types: ['kimi_local'] }, cookie: x.cookie });
    await req(x.port, 'POST', '/setup/api/secretary', { body: { name: 'Sec', ai: 'kimi_local' }, cookie: x.cookie });
    const a = x.pc.agents[0];
    assert.deepEqual(a.adapterConfig.env.KIMI_MODEL_API_KEY, { type: 'secret_ref', secretId: x.pc.secrets[0].id });
    await req(x.port, 'POST', '/setup/api/ai/start', { body: { type: 'kimi_local' }, cookie: x.cookie });
    await tick(); await tick();
    const pty = x.sp.procs.at(-1);
    pty.c.stdout.emit('data', Buffer.from('Opening browser for Kimi device login: https://www.kimi.com/code/authorize_device?user_code=E9AZ-0HG9\r\nenter code: E9AZ-0HG9\r\n'));
    pty.c.emit('exit', 0);
    await until(() => !a.adapterConfig.env.KIMI_MODEL_API_KEY);
    assert.deepEqual(a.adapterConfig.env, { KIMI_CODE_HOME: '/data/aitools/kimi_local/home' }, '鍵の参照だけを外し、資格の置き場は残す');
  } finally { x.close(); }
});

test('m04 Claude を鍵で作った担当は、契約（token）でつないだら鍵の参照を外して token の秘密を指す', async () => {
  const x = await setup();
  try {
    await installAi(x, 'claude_local', '/data/aitools/claude_local/node_modules/.bin/claude');
    await req(x.port, 'POST', '/setup/api/ai/key', { body: { type: 'claude_local', key: 'sk-ant-api03-' + 'A'.repeat(30) }, cookie: x.cookie });
    await req(x.port, 'POST', '/setup/api/ai/choose', { body: { types: ['claude_local'] }, cookie: x.cookie });
    await req(x.port, 'POST', '/setup/api/secretary', { body: { name: 'Sec', ai: 'claude_local' }, cookie: x.cookie });
    const a = x.pc.agents[0];
    assert.equal(a.adapterConfig.env.ANTHROPIC_API_KEY.secretId, x.pc.secrets[0].id);
    assert.equal(a.adapterConfig.env.CLAUDE_CODE_OAUTH_TOKEN, undefined);
    await req(x.port, 'POST', '/setup/api/ai/start', { body: { type: 'claude_local' }, cookie: x.cookie });
    const pty = x.sp.procs.at(-1);
    pty.c.stdout.emit('data', Buffer.from(`${URL_}\r\nPaste code here > `));
    await req(x.port, 'POST', '/setup/api/ai/code', { body: { type: 'claude_local', code: 'abcdefgh1234#st' }, cookie: x.cookie });
    await new Promise(r => setTimeout(r, 500));
    pty.c.stdout.emit('data', Buffer.from(`${TOKEN}\r\n`));
    await until(() => a.adapterConfig.env.CLAUDE_CODE_OAUTH_TOKEN);
    await until(() => !a.adapterConfig.env.ANTHROPIC_API_KEY);
    assert.equal(a.adapterConfig.env.ANTHROPIC_API_KEY, undefined);
    assert.deepEqual(a.adapterConfig.env.CLAUDE_CODE_OAUTH_TOKEN, { type: 'secret_ref', secretId: x.pc.secrets[1].id });
  } finally { x.close(); }
});

test(`m04 鍵の参照は wizard が渡した秘密を指す担当だけを触る: 参照の無い担当（あとでつなぐの Codex）に鍵を足さない（r4 の A' の約束）`, async () => {
  const x = await setup();
  try {
    await req(x.port, 'POST', '/setup/api/ai/choose', { body: { types: [], later: true }, cookie: x.cookie });
    await req(x.port, 'POST', '/setup/api/secretary', { body: { name: 'Sec' }, cookie: x.cookie });
    const n = x.pc.calls.filter(c => c.method === 'PATCH').length;
    assert.equal((await req(x.port, 'POST', '/setup/api/ai/key', { body: { type: 'codex_local', key: 'sk-proj-' + 'P'.repeat(30) }, cookie: x.cookie })).status, 200);
    assert.equal(x.pc.calls.filter(c => c.method === 'PATCH').length, n);
    // 鍵を入れた後に作る担当は鍵を指す
    await req(x.port, 'POST', '/setup/api/agents', { body: { ids: ['research'], ai: { research: 'codex_local' } }, cookie: x.cookie });
    assert.deepEqual(x.pc.agents[1].adapterConfig.env, { OPENAI_API_KEY: { type: 'secret_ref', secretId: x.pc.secrets[0].id } });
  } finally { x.close(); }
});

test('m04 担当を作っている最中に契約のサインインが終わっても、作った後に鍵の参照を外す（鎖の外の窓・独立レビュー r5 の P3・user の裁定 Q1）', async () => {
  const x = await setup();
  try {
    await installAi(x, 'kimi_local', '/data/aitools/kimi_local/node_modules/.bin/kimi');
    await req(x.port, 'POST', '/setup/api/ai/key', { body: { type: 'kimi_local', key: 'key_' + 'K'.repeat(30) }, cookie: x.cookie });
    await req(x.port, 'POST', '/setup/api/ai/choose', { body: { types: ['kimi_local'] }, cookie: x.cookie });
    await req(x.port, 'POST', '/setup/api/ai/start', { body: { type: 'kimi_local' }, cookie: x.cookie });
    await tick(); await tick();
    const pty = x.sp.procs.at(-1);
    pty.c.stdout.emit('data', Buffer.from('Opening browser for Kimi device login: https://www.kimi.com/code/authorize_device?user_code=E9AZ-0HG9\r\nenter code: E9AZ-0HG9\r\n'));
    createDelay.ms = 300;
    // 鍵がある間に担当を作り始める（作る要求は鍵の参照つきで出る）
    const made = req(x.port, 'POST', '/setup/api/secretary', { body: { name: 'Sec', ai: 'kimi_local' }, cookie: x.cookie });
    await until(() => x.pc.calls.some(c => c.method === 'POST' && c.url === '/api/companies/c1/agents'));
    assert.deepEqual(x.pc.calls.findLast(c => c.method === 'POST' && c.url === '/api/companies/c1/agents').body.adapterConfig.env.KIMI_MODEL_API_KEY, { type: 'secret_ref', secretId: x.pc.secrets[0].id });
    // その最中にサインインが終わる（この時の一覧には作っている担当がまだ無い）
    pty.c.emit('exit', 0);
    await made;
    const a = x.pc.agents[0];
    await until(() => !a.adapterConfig.env.KIMI_MODEL_API_KEY);
    assert.deepEqual(a.adapterConfig.env, { KIMI_CODE_HOME: '/data/aitools/kimi_local/home' });
  } finally { createDelay.ms = 0; x.close(); }
});
