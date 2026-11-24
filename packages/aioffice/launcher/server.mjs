// 起動係（launcher）: container の入口。日英の wizard を出し、済んだら本体（Paperclip）へ中継する
// 仕様: docs/design/2026-11-15-public-package.md。依存なしの node
// 環境変数: AIOFFICE_PORT（3100。本体が PORT を読むので別の名前にする）・AIOFFICE_DATA（/data/aioffice）・PAPERCLIP_URL（http://127.0.0.1:3101）・CODEX_HOME（/data/codex-home）・CODEX_BIN（codex）
import http from 'node:http';
import net from 'node:net';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseHosts } from './lib/core-env.mjs';
import { hostAllowed, originAllowed, schemeOf, baseOf, frontOf, readCookie, cookieValid, issueCookie, hashPassword, checkPassword, passwordProblem } from './lib/guard.mjs';
import { openStore, volumeMounted } from './lib/state.mjs';
import { createCodexLogin } from './lib/codex-login.mjs';
import { createConnectors } from './lib/connectors.mjs';
import { createClaudeLogin } from './lib/claude-login.mjs';
import { createAiInstaller } from './lib/ai-install.mjs';
import { aiChoices, aiBin, aiHome, deskAdapterConfig, swapAdapterConfig, catalogEntry, AI_CATALOG } from './lib/ai-catalog.mjs';
import { createDeviceLogin } from './lib/device-login.mjs';
import { createPaperclip, writeInstructions } from './lib/paperclip.mjs';
import { TEMPLATES, templateText } from './lib/templates.mjs';
import { syncCaseFormat } from './lib/case-format.mjs';
import { DICT, pickLang } from './lib/i18n.mjs';
import { createGate, WRITE_METHODS } from './lib/gate.mjs';
// isLoopback は下の Slack の物（127.0.0.0/8・::1）を、試験の口（TEST_HOOK_PATH）にも使う
import { normalizeAiLimits, mergeAiLimits, TEST_HOOK_PATH, testHooksEnabled } from './lib/limits.mjs';
import { slackUrlOk, destFingerprint, MASKED_DEST } from './lib/slack-url.mjs';
import { createMailer } from './lib/mail.mjs';
import { maskAddr } from './lib/mail-core.mjs';
import crypto from 'node:crypto';
import { coreAccess, forwardHeaders, normPath } from './lib/access.mjs';
import { peopleIndex, peopleRows, setBoss, relayConfig, sameJson } from './lib/people.mjs';
import { backupDone, migrationStep } from './lib/migrate.mjs';

// Slack の照合の口（/setup/internal/slack-nonce）は loopback からだけ受ける（同じ container の知らせの plugin の worker・S1）
export const isLoopback = a => typeof a === 'string' && (/^127\.\d+\.\d+\.\d+$/.test(a) || a === '::1' || /^::ffff:127\.\d+\.\d+\.\d+$/.test(a));
export const SLACK_NONCE_MS = 2 * 60_000;
// 知らせの plugin の worker は照合の口を、いつもこの port で叩く（本体は worker に起動係の port を渡さない・worker の nonceUrl）。
// 起動係が別の port で動いている時は、空いたこの port で担当が「有効」と答えられるので、Slack の保存と ON（nonce の発行）を断る（実装 r1 の 3）
export const SLACK_LAUNCHER_PORT = 3100;
const COMPANY_ID = /^[A-Za-z0-9-]{1,64}$/;
export const MAIL_ROUND_HOOK = 'POST /setup/api/test/mail-round';
const okCode = (v, dflt) => (typeof v === 'string' && /^[a-z_]{1,40}$/.test(v) ? v : dflt);

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC = path.join(HERE, 'public');
const STATIC = { '/setup/': ['setup.html', 'text/html; charset=utf-8'], '/setup/setup.js': ['setup.js', 'text/javascript; charset=utf-8'], '/setup/setup.css': ['setup.css', 'text/css; charset=utf-8'], '/setup/folder-pick.js': ['folder-pick.js', 'text/javascript; charset=utf-8'] };
const MAX_BODY = 16 * 1024;
// フォルダの欄の口だけは本文を 2.5MB まで読む（1 回 20 件・JSON で 2MB まで・ほかの口は 16KB のまま・フォルダの欄の範囲 作り方 5）
const FOLDER_PATH = 'POST /setup/api/library/folder';
export const FOLDER_LIMITS = { body: 2.5 * 1024 * 1024, docs: 20, bytes: 2 * 1024 * 1024 };
const isJson = ct => /^application\/json\s*(;|$)/i.test(String(ct || ''));
// 本体の応答の access-control-* は落とす（本体の版上げで CORS を返し始めても、手元の別の port のページから読ませない・範囲の保証 8）
// 時刻帯はブラウザの Intl の値（例 Asia/Tokyo）。読めない値は捨てる
export function validTimeZone(tz) { if (typeof tz !== 'string' || !tz || tz.length > 64) return null; try { new Intl.DateTimeFormat('en', { timeZone: tz }); return tz; } catch { return null; } }
export const dropCors = h => Object.fromEntries(Object.entries(h).filter(([k]) => !k.toLowerCase().startsWith('access-control-')));

// pluginStatus: 本体に入れた plugin の状態を返す関数（lib/plugins.mjs の記録）。office の画面の key は aioffice.office
// roundsStatus: 見回りの遅れ（lib/rounds.mjs の status）。gate: 本体へ中継する書き込みの関所（lib/gate.mjs・同時 6 本）
// limitOverrides: 見回りの値の試験用の差し替え（lib/limits.mjs の createLimitOverrides）。testHooks: その口を開けるか（CI だけが付ける env の時だけ true）
export function createLauncher({ roleWriter = null, relayMailKeep = 5000, dataDir, paperclipUrl, codexHome, codexBin = 'codex', hosts = process.env.AIOFFICE_HOSTS || '', fetchFn = fetch, rawFetchFn = fetch, boardKey = null, restartCore = () => {}, claimInfo = () => null, clearClaim = () => {}, runBackup = null, spawnFn, aiSpawnFn, aiExists, claudeTmpRoot, pluginStatus = () => ({}), roundsStatus = () => ({}), gate = createGate(), limitOverrides = null, testHooks = testHooksEnabled(), port = SLACK_LAUNCHER_PORT, mailDeps = {} } = {}) {
  const store = openStore(dataDir);
  const lanHosts = parseHosts(hosts); // ほかの PC から入る住所（名前:port）。本体の許可（core-env）と同じ物から作る
  // 新しく入れた office（前の版の wizard の跡が無い）は、最初の起動で v = 2 の印を書く（移し替えにしない・設計 2.4）
  if (boardKey && store.get().v !== 2 && !store.get().owner && !store.get().companyId) store.update(x => { x.v = 2; });
  // つないだ AI は「使う AI」（aiSelected）に足す（和集合）。オフィスの欄でつないだ AI も wizard でつないだ物と同じに扱う（範囲 2026-11-18 F2）
  const addSelected = type => store.update(x => { x.aiSelected = [...new Set([...(x.aiSelected || []), type])]; });
  let connectors = null; // 下で作る（サインインが済んだら覚えた連携の結果を消す）
  const codex = createCodexLogin({ codexBin, codexHome, ...(spawnFn ? { spawnFn } : {}), onDone: () => { addSelected('codex_local'); syncKeyRefs('codex_local'); connectors?.reset(); } });
  // 起動係から plugin の持ち主だけの口を呼んで owner_only で断られた時（plugin が入った直後で、設定に持ち主がまだ無い）は、
  // 設定をそろえてから 1 回だけやり直す（設計 docs/design/2026-11-23-public-office-multi-user.md 2.2b）
  let retrySyncAt = 0;
  const ownerRetryFetch = async (url, init) => {
    const r = await fetchFn(url, init);
    if (r.status !== 403 || !String(url).includes('/api/plugins/') || /\/config(\?|$)/.test(String(url))) return r;
    const body = await r.clone().json().catch(() => null);
    if (body?.error !== 'owner_only' || !boardKey) return r;
    if (Date.now() - retrySyncAt < 60_000) return r; // そろえ直しは 60 秒に 1 回まで（そろわないまま毎回まるごと回さない・2 回目のレビュー 低 6）
    retrySyncAt = Date.now();
    await syncRelay().catch(() => {});
    return fetchFn(url, init);
  };
  const pc = createPaperclip({ base: paperclipUrl, fetchFn: ownerRetryFetch });
  // 連携の有無（v1 は Codex だけ・状態の語だけを返す。範囲 docs/review/2026-11-22-notify-via-ai-connectors-scope.md 作り方 1）
  connectors = createConnectors({ codexBin, codexHome, ...(spawnFn ? { spawnFn } : {}), hasCodex: () => { try { return fs.statSync(path.join(codexHome, 'auth.json')).size > 0; } catch { return false; } }, loginBusy: () => { const v = codex.view(); return !!v.running || v.state === 'starting' || v.state === 'waiting'; } }); // 逆向き（一覧の最中にサインインを始める）は止めない。一覧は 30 秒で切れ、受け入れる限界（再レビュー P3-b）
  // メールで届ける係（範囲 docs/review/2026-11-19-mail-notify-scope.md）。見回り（lib/rounds.mjs）が round を呼ぶ。mailDeps は試験だけが渡す
  const mail = createMailer({ store, notifyRoute: pc.notifyRoute, companyOk: async cid => { try { await pc.company(cid); return true; } catch { return false; } }, log: m => console.log(m), ...mailDeps });
  // 選んだ AI の CLI を入れる・Claude の契約をつなぐ（範囲: docs/review/2026-11-17-wizard-ai-choice-scope.md）
  const installer = createAiInstaller({ ...(aiSpawnFn ? { spawnFn: aiSpawnFn } : {}), ...(aiExists ? { exists: aiExists } : {}), ...(aiSpawnFn ? { mkdir: () => {} } : {}) });
  const claude = createClaudeLogin({
    claudeBin: aiBin('claude_local'), ...(aiSpawnFn ? { spawnFn: aiSpawnFn } : {}), ...(claudeTmpRoot ? { tmpRoot: claudeTmpRoot } : {}),
    hasToken: () => !!store.get().ais?.claude_local?.secretId,
    // token は会社の秘密にだけ置く。key は毎回別にして、やり直しで前の秘密とぶつからないようにする
    saveToken: async token => {
      const s = store.get(); if (!s.companyId) throw new Error('company_first');
      // つなぎ直しは同じ秘密の値を替える（作ってある Claude の担当は同じ秘密を指したまま新しい値を使う）
      const had = s.ais?.claude_local?.secretId;
      let id = null;
      if (had) { try { await pc.rotateSecret(had, token); id = had; } catch (e) { if (e.status !== 404) throw e; } } // 本体で消されていたら作り直す
      if (!id) {
        const stamp = Date.now();
        const sec = await pc.createSecret(s.companyId, { name: `Claude Code OAuth token ${stamp}`, key: `CLAUDE_CODE_OAUTH_TOKEN_${stamp}`, value: token });
        id = sec.id;
        store.update(x => { x.ais = { ...x.ais, claude_local: { ...(x.ais?.claude_local || {}), secretId: id } }; }); // API の鍵の秘密（keySecretId）を消さない
      }
      addSelected('claude_local');
      // 前の秘密が本体で消されて作り直した時だけ: 消えた秘密（had）を指していた Claude の担当を、新しい秘密へ付け替える（独立レビュー r3 の A・r4 の A'）。
      // 参照の無い担当・API の鍵で動く担当・別の秘密を指す担当には触らない。初めてつなぐ時（had が無い）は何もしない。
      // 付け替えの失敗でつなぐこと自体は失敗にしない（担当ごとに記録を残す。欄で Claude の担当を保存し直すと付け替える）
      if (had && id !== had) {
        let list = [];
        try { list = await pc.agents(s.companyId) || []; } catch (e) { console.log(`aioffice: could not list agents to relink the Claude token: ${e.status || e.message}`); }
        for (const a of list) {
          if (a.adapterType !== 'claude_local' || claudeRef(a) !== had) continue;
          try { await relinkClaude(a, id); } catch (e) { console.log(`aioffice: could not relink the Claude token for agent ${a.id}: ${e.status || e.message}`); }
        }
      }
      // 契約（token）でつないだので、前に API の鍵で作った Claude の担当から鍵の参照を外す（付け替えの後に 1 本ずつ・env は丸ごと送るので同時に走らせない）
      await syncKeyRefs('claude_local');
    },
  });
  // API の鍵を会社の秘密に入れる。入れ直しは同じ秘密の値を替える（担当は同じ秘密を指したまま）。本体で消されていたら作り直し、
  // 消えた秘密を指していた、その AI の担当の env の参照だけを付け替える（Claude の token と同じ形・独立レビュー r3 の A）
  function saveKey(e, key) { return once(`key:${e.type}`, () => saveKeyNow(e, key)); } // 同時の 2 本で秘密を 2 つ作らない
  async function saveKeyNow(e, key) {
    const s = store.get();
    const had = s.ais?.[e.type]?.keySecretId;
    let id = null;
    if (had) { try { await pc.rotateSecret(had, key); id = had; } catch (err) { if (err.status !== 404) throw err; } }
    if (!id) {
      const stamp = Date.now();
      id = (await pc.createSecret(s.companyId, { name: `${e.name.en} API key ${stamp}`, key: `${e.keyEnv}_${stamp}`, value: key })).id;
      store.update(x => { x.ais = { ...x.ais, [e.type]: { ...(x.ais?.[e.type] || {}), keySecretId: id } }; });
    }
    addSelected(e.type);
    await syncKeyRefs(e.type, { had });
  }
  // その AI の担当の env の鍵の参照を直す。触るのは wizard が渡した鍵の秘密（ours）か、消えた前の秘密（had）を指す担当だけ
  // （参照の無い担当・手で入れた鍵・別の秘密を指す担当には触らない＝独立レビュー r4 の A' の約束）。
  // 契約でつないである → ours を指す担当から鍵の参照を外す（鍵があると従量の課金を使う CLI がある）。Claude は token の秘密を指させる。
  // 契約でつないでいない → had を指す担当を ours に付け替える。失敗は担当ごとに記録して続ける
  // AI ごとに 1 本ずつ順に回す（鍵の保存とサインインの完了が同時に来ても、古い一覧から env を丸ごと送り合って外した参照を戻さない）。
  // 後から来た呼び出しも捨てずに、前の分が終わってから新しい状態で回す。失敗は中で記録するので鎖は切れない
  const syncChains = new Map();
  function syncKeyRefs(type, opts) {
    const next = (syncChains.get(type) || Promise.resolve()).then(() => syncKeyRefsNow(type, opts)).catch(err => console.log(`aioffice: could not update the API key refs: ${err?.status || err?.message || 'error'}`));
    syncChains.set(type, next);
    return next;
  }
  async function syncKeyRefsNow(type, { had = null } = {}) {
    const e = catalogEntry(type), s = store.get();
    const ours = s.ais?.[type]?.keySecretId;
    if (!e?.keyEnv || !s.companyId || !ours) return;
    const login = loginConnected(type);
    if (!login && (!had || had === ours)) return;
    let list = [];
    try { list = await pc.agents(s.companyId) || []; } catch (err) { console.log(`aioffice: could not list agents to update the API key: ${err.status || err.message}`); return; }
    for (const a of list) {
      if (a.adapterType !== type) continue;
      const cur = envRef(a, e.keyEnv);
      const refs = login ? (cur === ours ? { [e.keyEnv]: null, ...(type === 'claude_local' ? { CLAUDE_CODE_OAUTH_TOKEN: s.ais?.claude_local?.secretId } : {}) } : null)
        : (cur === had ? { [e.keyEnv]: ours } : null);
      if (!refs) continue;
      try { await setEnvRefs(a, refs); } catch (err) { console.log(`aioffice: could not update the API key for agent ${a.id}: ${err.status || err.message}`); }
    }
  }
  const envRef = (a, k) => { const v = a?.adapterConfig?.env?.[k]; return v && typeof v === 'object' && v.type === 'secret_ref' ? v.secretId : null; };
  // env の決めた key だけを替える（値が null なら外す）。本体は env を丸ごと替えるので今の env を送り、文字の伏せ字の key は送らない
  function setEnvRefs(a, refs) {
    const cur = a?.adapterConfig?.env && typeof a.adapterConfig.env === 'object' ? a.adapterConfig.env : {};
    const env = Object.fromEntries(Object.entries(cur).filter(([, v]) => v !== '***REDACTED***'));
    for (const [k, id] of Object.entries(refs)) { if (id) env[k] = { type: 'secret_ref', secretId: id }; else delete env[k]; }
    return pc.updateAgent(a.id, { adapterConfig: { env } });
  }
  // Claude の担当が指す token の秘密（secret_ref は本体が伏せ字にしないので一覧の値で比べられる）と、その付け替え（種類は同じなので env の参照だけを替える）
  function claudeRef(a) { const v = a?.adapterConfig?.env?.CLAUDE_CODE_OAUTH_TOKEN; return v && typeof v === 'object' && v.type === 'secret_ref' ? v.secretId : null; }
  // 付け替えは env の CLAUDE_CODE_OAUTH_TOKEN だけ。command・engine・API の鍵・ほかの env には触らない（種類が同じなので本体は今の設定に重ねる。
  // env は丸ごと替わるので今の env を送る: 伏せ字の値は本体が元へ戻す・文字の伏せ字の key は送らない＝ B と同じ）
  function relinkClaude(a, secretId) {
    const cur = a?.adapterConfig?.env && typeof a.adapterConfig.env === 'object' ? a.adapterConfig.env : {};
    const env = Object.fromEntries(Object.entries(cur).filter(([, v]) => v !== '***REDACTED***'));
    env.CLAUDE_CODE_OAUTH_TOKEN = { type: 'secret_ref', secretId };
    return pc.updateAgent(a.id, { adapterConfig: { env } });
  }
  // Codex・Claude 以外の AI の契約のつなぎ（device code・ブラウザで許可）。表の connect の命令を PTY で回す（all-ai-v1 m04）。
  // つないだら状態の file に印（ais[type].connected）を置く。資格は CLI が /data/aitools/<type>/home に書くので、container を作り直しても残る
  const logins = new Map(AI_CATALOG.filter(e => e.include && e.connect).map(e => [e.type, createDeviceLogin({
    type: e.type, bin: aiBin(e.type), args: e.connect.args, url: e.connect.url, wantCode: e.login === 'device', home: aiHome(e.type), homeEnv: e.homeEnv,
    ...(aiSpawnFn ? { spawnFn: aiSpawnFn, mkdir: () => {} } : {}),
    isConnected: () => !!store.get().ais?.[e.type]?.connected,
    onDone: t => { store.update(x => { x.ais = { ...x.ais, [t]: { ...(x.ais?.[t] || {}), connected: true } }; }); addSelected(t); syncKeyRefs(t); },
  })]));
  // AI ごとの「契約でつないだか」。Codex は auth.json、Claude は token の秘密、ほかは状態の file の印
  const loginConnected = type => type === 'codex_local' ? codex.connected() : type === 'claude_local' ? !!store.get().ais?.claude_local?.secretId : !!store.get().ais?.[type]?.connected;
  // つないだか: 契約か API の鍵のどちらか
  const connected = type => loginConnected(type) || !!store.get().ais?.[type]?.keySecretId;
  // 担当に渡す API の鍵の秘密。契約でつないである AI には渡さない（CLI は鍵があると契約より鍵を使い、従量の課金になる物がある）
  const keyFor = type => loginConnected(type) ? null : (store.get().ais?.[type]?.keySecretId || null);
  const LOGIN_READY = new Set(AI_CATALOG.filter(e => e.include && (e.type === 'codex_local' || e.type === 'claude_local' || e.connect || e.keyEnv)).map(e => e.type));
  // 起動の時に 1 回: 前からつないである AI（置いてある auth.json・保存してある Claude の秘密）も「使う AI」に足す（和集合・独立レビュー r2 の 6）
  for (const type of LOGIN_READY) if (connected(type) && !(store.get().aiSelected || []).includes(type)) addSelected(type);
  const aiRow = c => ({ ...c, install: c.selectable ? installer.view(c.type) : null, connected: c.selectable && connected(c.type), loginReady: LOGIN_READY.has(c.type), keyReady: !!(c.selectable && catalogEntry(c.type)?.keyEnv), viaKey: !!(c.selectable && !loginConnected(c.type) && store.get().ais?.[c.type]?.keySecretId) });
  async function aiList() {
    let adapters; try { adapters = await pc.adapters(); } catch { adapters = AI_CATALOG.filter(e => e.include).map(e => ({ type: e.type })); } // 本体が答えない時は表で出す
    return aiChoices(Array.isArray(adapters) ? adapters : []).map(aiRow);
  }
  // 担当に使う AI。選んだ AI の中のつないだ物だけ。指定が無ければ最初に選んだ AI
  const pickAi = want => { const sel = store.get().aiSelected || []; if (want && sel.includes(want)) return want; return sel[0] || 'codex_local'; };
  const target = new URL(paperclipUrl);
  const fails = []; // 合言葉の失敗の時刻（10 分で 10 回まで）

  // 持ち主かどうか（設計 2.2）。要求の入口で identify が req.aio に決める。
  // boardKey を渡さない起動（前の版と同じ形の試験）と、移し替えの段は、今の合言葉の cookie（aio_owner）で決める
  const legacyAuthed = req => cookieValid(store.secret, store.get().generation, readCookie(req.headers.cookie));
  const authed = req => (req.aio ? !!req.aio.owner : legacyAuthed(req));
  // 段（設計 2.1 の表）: ready・preclaim（持ち主がまだいない）・migrating（前の版の office）・keyless（鍵が無い・401・403）
  let keyBad = false, health = { at: 0, v: null };
  async function coreHealth() {
    if (Date.now() - health.at < 5000) return health.v;
    try { const r = await rawFetchFn(new URL('/api/health', paperclipUrl)); health = { at: Date.now(), v: r.ok ? await r.json() : null }; } catch { health = { at: Date.now(), v: null }; }
    return health.v;
  }
  async function stage() {
    if (!boardKey) return 'legacy';
    const s = store.get();
    if (s.v !== 2 && (s.owner || s.companyId)) return 'migrating';
    if (boardKey.has() && !keyBad) return 'ready';
    const h = await coreHealth();
    if (!h) return 'starting'; // 本体がまだ起きていない（段の表に無いので本体への中継は断る）
    return h.bootstrapStatus === 'bootstrap_pending' ? 'preclaim' : 'keyless';
  }
  // 本体の session の持ち主か: ブラウザの cookie だけを付けて（鍵は付けない）本体の cli-auth/me に聞く。同じ cookie は 5 秒覚える
  const meCache = new Map();
  const sessionCookie = req => String(req.headers.cookie || '').split(';').map(x => x.trim()).filter(x => x && !/^aio_/.test(x)).join('; ');
  async function coreMe(cookie, { fresh = false } = {}) {
    if (!cookie) return null;
    const hit = meCache.get(cookie); if (!fresh && hit && Date.now() - hit.at < 5000) return hit.v;
    let v = null, sure = false;
    try { const r = await rawFetchFn(new URL('/api/cli-auth/me', paperclipUrl), { headers: { cookie } }); if (r.ok) v = await r.json(); sure = r.ok || r.status === 401 || r.status === 403; } catch { /* 本体が起きていない */ }
    if (meCache.size > 500) meCache.clear();
    // 本体が起き直す途中の失敗（つながらない・5xx）は覚えない（起きた直後の持ち主を 5 秒間「持ち主でない」にしない）
    if (sure) meCache.set(cookie, { at: Date.now(), v }); else meCache.delete(cookie);
    return v;
  }
  async function identify(req) {
    const st = await stage();
    if (st === 'legacy') return null;
    const claimCookie = claimCookieValid(req);
    if (st === 'migrating') return { stage: st, owner: legacyAuthed(req), ownerCookie: legacyAuthed(req), claimCookie };
    const me = await coreMe(sessionCookie(req));
    const session = me?.source === 'session';
    // 本体の instance admin になった人（最初の持ち主・reset-owner で作り直した持ち主）は持ち主の一覧に足す（plugin の ownerUserIds の元・設計 2.2b・2.8）
    // admin でなくなった人（本体の画面で外した・reset-owner の前の持ち主）は外す（独立レビュー 4）。毎分の syncRelay が本体の admin の一覧から作り直す
    if (session && me.isInstanceAdmin === true && me.userId && !(store.get().ownerUserIds || []).includes(me.userId)) { store.update(x => { x.ownerUserIds = [...new Set([...(x.ownerUserIds || []), me.userId])]; }); syncedCompanies.clear(); }
    if (session && me.isInstanceAdmin === false && me.userId && (store.get().ownerUserIds || []).includes(me.userId)) { store.update(x => { x.ownerUserIds = (x.ownerUserIds || []).filter(u => u !== me.userId); if (x.ownerUserId === me.userId) x.ownerUserId = null; x.formerOwners = [...new Set([...(x.formerOwners || []), me.userId])].slice(-50); }); syncedCompanies.clear(); }
    return { stage: st, owner: session && me.isInstanceAdmin === true, member: session && Array.isArray(me.companyIds) && me.companyIds.length > 0, userId: session ? me.userId : null, claimCookie, ownerCookie: false };
  }
  // claim の前の使い捨ての code（設計 2.3）: 起動のたびに作り直し、/data/aioffice/claim-code（0600）に置いてログに 1 行出す。合った人に 30 分の cookie を出す
  const claimFile = path.join(dataDir, 'claim-code');
  const CLAIM_COOKIE = 'aio_claim';
  if (boardKey && store.get().v === 2 && !boardKey.has()) {
    const code = crypto.randomBytes(6).toString('base64url').toUpperCase().replace(/[^A-Z0-9]/g, 'X').slice(0, 8);
    fs.writeFileSync(claimFile, code + '\n', { mode: 0o600 });
    console.log(`aioffice: first-owner code: ${code} (wizard の最初の段で入れる・持ち主がいれば使わない)`);
  }
  // aioffice-reset-owner の招待（token の sha256 と期限）。token そのものは置かない。期限の内だけ返す
  function resetInvite() {
    try {
      const j = JSON.parse(fs.readFileSync(path.join(dataDir, 'reset-invite'), 'utf8'));
      return typeof j.hash === 'string' && /^[0-9a-f]{64}$/.test(j.hash) && Number(j.exp) > Date.now() ? j : null;
    } catch { return null; }
  }
  function resetInviteMatches(token) {
    const j = resetInvite(); if (!j) return false;
    const h = crypto.createHash('sha256').update(token).digest('hex');
    return crypto.timingSafeEqual(Buffer.from(j.hash), Buffer.from(h));
  }
  // code の cookie は、出した「回」に結び付ける（codex の最終確認 P1）: reset-owner の招待が生きていればその招待の hash、
  // 無ければ今の claim の code の hash。reset-owner が新しい招待を出すと、前の回（最初の持ち主の code・前の reset）の cookie は効かない
  function claimEpoch() {
    const r = resetInvite(); if (r) return `r:${r.hash}`;
    try { return `c:${crypto.createHash('sha256').update(fs.readFileSync(claimFile, 'utf8').trim()).digest('hex')}`; } catch { return ''; }
  }
  const claimSig = (exp, epoch) => crypto.createHmac('sha256', store.secret).update(`claim:${exp}:${epoch}`).digest('base64url');
  const claimCookieHeader = () => { const exp = String(Date.now() + 30 * 60_000); return `${CLAIM_COOKIE}=${exp}.${claimSig(exp, claimEpoch())}; HttpOnly; SameSite=Strict; Path=/; Max-Age=1800`; };
  function claimCookieValid(req) {
    const v = String(req.headers.cookie || '').split(';').map(x => x.trim()).find(x => x.startsWith(`${CLAIM_COOKIE}=`))?.slice(CLAIM_COOKIE.length + 1);
    const [exp, sig] = String(v || '').split('.');
    if (!exp || !sig || Number(exp) < Date.now()) return false;
    const epoch = claimEpoch(); if (!epoch) return false;
    const want = claimSig(exp, epoch);
    return sig.length === want.length && crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(want));
  }
  const claimTries = [];
  // 移し替え（設計 2.4）: 段は事実から決める。backup は本体が起きていれば起動係が回す（1 つずつ）。token が期限切れなら本体を 1 回起こし直す
  const mig = { running: false, error: null };
  async function migrationView(req) {
    const me = await coreMe(sessionCookie(req));
    let claim = claimInfo();
    if (claim) {
      try {
        const r = await rawFetchFn(new URL(`/api/board-claim/${encodeURIComponent(claim.token)}?code=${encodeURIComponent(claim.code)}`, paperclipUrl));
        const j = r.ok ? await r.json().catch(() => null) : null;
        if (r.status === 404 || j?.status === 'claimed') { clearClaim(); claim = null; }
        else if (j?.status === 'expired') { clearClaim(); claim = null; restartCore(); }
      } catch { /* 本体が起きていない */ }
    }
    const view = { step: migrationStep({ hasKey: !!boardKey?.has(), sessionAdmin: me?.source === 'session' && me.isInstanceAdmin === true, backupOk: backupDone(store.get().migrationBackup), claim }), backupRunning: mig.running, error: mig.error };
    if (view.step === 'backup' && !mig.running && runBackup && (await coreHealth())) {
      mig.running = true; mig.error = null; view.backupRunning = true;
      // DB の backup の隣に、移し替えの前の起動係の state も写す（aioffice-restore が両方を戻す・設計 2.4 の戻し方）
      runBackup().then(mark => { if (mark && backupDone(mark)) { try { fs.copyFileSync(path.join(dataDir, 'state.json'), `${mark.backupFile}.aioffice-state.json`); fs.chmodSync(`${mark.backupFile}.aioffice-state.json`, 0o600); } catch { /* state が無い（まれ）: DB だけ戻せる */ } store.update(x => { x.migrationBackup = mark; }); } else mig.error = 'backup_failed'; }, () => { mig.error = 'backup_failed'; }).finally(() => { mig.running = false; });
    }
    return view;
  }
  // 人の表（全部の会社の members から）と、relay の設定を会社ごとに書く（変わった時だけ・設計 2.5）
  async function peopleNow() {
    const cos = await pc.companies(); const byCo = {};
    for (const c of Array.isArray(cos) ? cos : []) { try { const r = await pc.members(c.id); byCo[c.id] = Array.isArray(r) ? r : r?.members || []; } catch { byCo[c.id] = []; } }
    return { index: peopleIndex(byCo), companies: Object.keys(byCo), byCo };
  }
  // 会社の人の役を変える。本体の API は自分の役と同じ役の人の役を変えさせないので、DB で書ける時（container の中）はそちらを使う（lib/member-roles.mjs）
  const setRole = (c, memberId, role) => (roleWriter ? roleWriter(c, memberId, role) : pc.setMemberRole(c, memberId, role));
  // 持ち主（instance admin）を全部の会社に owner の役で入れる。本体は admin でも会社の人でなければ会社の口を断る
  // （reset-owner で作り直した持ち主・後から admin にした人・2026-11-24 実測）。足りない時だけ書く。変えたら true
  async function ensureOwnerMemberships(owners, byCo) {
    let changed = false;
    const cids = Object.keys(byCo);
    for (const uid of owners) {
      if (uid === 'local-board') continue;
      const missing = cids.filter(c => !(byCo[c] || []).some(m => m.principalType === 'user' && m.principalId === uid && m.status === 'active'));
      if (missing.length) {
        const mine = cids.filter(c => !missing.includes(c));
        try { await pc.setCompanyAccess(uid, [...mine, ...missing]); changed = true; } catch (e) { console.log(`aioffice: could not add the owner to a company: ${e.status || e.message}`); continue; }
      }
    }
    if (changed) meCache.clear(); // 持ち主の会社の人の印が変わった（本体の答えの覚えを捨てる）
    if (changed) for (const c of cids) { try { const r = await pc.members(c); byCo[c] = Array.isArray(r) ? r : r?.members || []; } catch { /* 次の分 */ } }
    for (const uid of owners) {
      if (uid === 'local-board') continue;
      for (const c of cids) {
        const m = (byCo[c] || []).find(x => x.principalType === 'user' && x.principalId === uid && x.status === 'active');
        // DB で上げるのは、本体の一覧で instance admin と確かめた人だけ（一覧の 50 人に出ず覚えていただけの人は上げない・4 回目のレビュー 低 2）
        if (m && m.membershipRole !== 'owner' && m.id && confirmedAdmins?.has(uid)) { try { await setRole(c, m.id, 'owner'); m.membershipRole = 'owner'; changed = true; } catch (e) { console.log(`aioffice: could not make the owner an owner of a company: ${e.status || e.message}`); } }
      }
    }
    // admin でなくなった前の持ち主（reset-owner の前の持ち主・本体の画面で外した人）は、会社の owner の役から operator に下げる（2 回目のレビュー 中 5）。
    // 下げるのは「前の持ち主」に覚えた人だけ（持ち主が本体の画面で会社の owner にした人は下げない・3 回目のレビュー 低 1）。
    // 持ち主が 1 人もいない間（reset の直後・本体の一覧が読めない）は下げない
    const real = owners.filter(u => u !== 'local-board');
    const former = new Set(store.get().formerOwners || []);
    if (real.length && former.size) {
      for (const c of cids) {
        // その会社で今の持ち主の誰かが owner の役の時だけ下げる（会社に owner の役の人が 0 人の間を作らない・4 回目のレビュー 低 1）
        if (!(byCo[c] || []).some(x => x.principalType === 'user' && x.status === 'active' && x.membershipRole === 'owner' && real.includes(x.principalId))) continue;
        for (const m of byCo[c] || []) {
          if (m.principalType === 'user' && m.status === 'active' && m.membershipRole === 'owner' && m.id && m.principalId !== 'local-board' && former.has(m.principalId) && !real.includes(m.principalId)) {
            try { await setRole(c, m.id, 'operator'); changed = true; } catch (e) { console.log(`aioffice: could not change a former owner's role: ${e.status || e.message}`); }
          }
        }
      }
    }
    return changed;
  }
  // plugin の会社ごとの設定をそろえる（変わった時だけ書く）: 全部の plugin に持ち主の ownerUserIds（設計 2.2b・2.7）、relay に人と承認の列（2.5）
  const OWNER_PLUGINS = ['aioffice.library', 'aioffice.notify', 'aioffice.secretary', 'aioffice.design', 'aioffice.relay'];
  // 会社ごとに、持ち主を書き終えた時の「入れ終わった plugin の組」。組が変わったら（後から plugin が入り終えた）書き直す。
  // 入れ始めていない plugin を数えずに「書き終えた」と覚えると、後から入った plugin に持ち主が書かれない（2026-11-24 e2e の notify の owner_only）
  const syncedCompanies = new Map();
  const readyKey = () => OWNER_PLUGINS.filter(k => pluginStatus()[k]?.status === 'ready').join(',');
  const preSyncAt = new Map(); // plugin の口の前にそろえた時刻（会社ごと）
  // plugin の設定は丸ごと置き換えなので、読んでから書くまでを plugin と会社ごとの 1 本の順番待ちに入れる（設計 2.8・独立レビュー 3）
  // fn(今の設定) が次の設定を返す。null なら書かない。返り値は fn の返り値か、書いたかどうか
  const configChains = new Map();
  function withPluginConfig(key, cid, fn) {
    const k = `${key}:${cid}`;
    const run = (configChains.get(k) || Promise.resolve()).catch(() => {}).then(async () => {
      let row = null; try { row = await pc.pluginConfig(key, cid); } catch (e) { if (e.status !== 404) throw e; }
      const cur = row?.configJson || {};
      const next = await fn(cur);
      if (!next || sameJson(cur, next)) return false;
      await pc.setPluginConfig(key, cid, next);
      return true;
    });
    configChains.set(k, run);
    return run;
  }
  // 持ち主の一覧: 本体の instance admin（/api/admin/users）から作り直す。読めない時は覚えている一覧（独立レビュー 4）
  // 限界: 本体の一覧は最大 50 人。51 人目より後の admin は、その人がログインした時に足す（identify）
  async function currentOwners() {
    const s = store.get();
    try {
      const users = await pc.adminUsers();
      if (Array.isArray(users)) {
        const admins = users.filter(u => u?.isInstanceAdmin === true && u.id).map(u => u.id);
        confirmedAdmins = new Set(admins);
        const keep = users.length >= 50 ? (s.ownerUserIds || []).filter(id => !users.some(u => u.id === id)) : [];
        const list = [...new Set([...admins, ...keep])];
        // admin を外れた人は「前の持ち主」に覚える（会社の owner の役から下げる相手は、この人たちだけ・3 回目のレビュー 低 1）。admin に戻った人は外す
        const gone = (s.ownerUserIds || []).filter(id => id !== 'local-board' && !list.includes(id));
        if (!sameJson(list, s.ownerUserIds || []) || (s.formerOwners || []).some(id => list.includes(id))) store.update(x => {
          x.ownerUserIds = list; if (x.ownerUserId && !list.includes(x.ownerUserId)) x.ownerUserId = list[0] || null;
          x.formerOwners = [...new Set([...(x.formerOwners || []), ...gone])].filter(id => !list.includes(id)).slice(-50);
        });
        return list;
      }
    } catch { /* 覚えている一覧で続ける */ }
    return [...new Set([s.ownerUserId, ...(s.ownerUserIds || [])].filter(Boolean))];
  }
  let lastSyncFail = 0;
  let confirmedAdmins = null; // 本体の一覧で instance admin と確かめた人（DB で会社の owner に上げてよい人）
  async function syncRelay({ force = false } = {}) {
    if (!boardKey || !boardKey.has() || keyBad) return { skipped: true };
    if (!force && lastSyncFail && Date.now() - lastSyncFail < 30_000) return { skipped: 'recent_failure' }; // 失敗の直後は持ち主の要求ごとに回さない（独立レビュー 8）
    const owners = [...new Set([...(await currentOwners()), 'local-board'])];
    const s = store.get(); // currentOwners が ownerUserId を替えた後の state を読む（古い持ち主で defaultRequester を書かない・2 回目のレビュー 低 11）
    const ready = OWNER_PLUGINS.filter(k => pluginStatus()[k]?.status === 'ready'); // 入れる途中は設定の口が 404。次の分の見回りで書く
    if (!ready.length) return { skipped: 'plugins_not_ready' };
    let { index, companies, byCo } = await peopleNow();
    if (await ensureOwnerMemberships(owners, byCo)) ({ index, companies } = await peopleNow());
    const relay = relayConfig({ index, people: s.people, ownerUserId: s.ownerUserId });
    let wrote = 0; const failed = new Set();
    try {
      for (const key of ready) {
        for (const cid of companies) {
          try {
            const did = await withPluginConfig(key, cid, cur => {
              const next = { ...cur, ownerUserIds: owners, ...(key === 'aioffice.relay' ? relay : {}) };
              if (key === 'aioffice.relay' && !relay.defaultRequester) delete next.defaultRequester;
              return next;
            });
            if (did) wrote += 1;
          } catch (e) { if (e.status === 404) { failed.add(cid); continue; } throw e; }
        }
      }
    } catch (e) { lastSyncFail = Date.now(); throw e; }
    if (failed.size) lastSyncFail = Date.now(); else lastSyncFail = 0;
    for (const cid of companies) if (!failed.has(cid)) syncedCompanies.set(cid, ready.join(','));
    return { wrote };
  }
  // 鍵がまだ使えるか（見回りが毎分呼ぶ・設計 2.3）。401・403・admin でない時は keyBad にし、true を返す（呼び手が本体を scheduler を止めて起こし直す）
  let hadKey = !!boardKey?.has();
  const migratingNow = () => { const s = store.get(); return s.v !== 2 && !!(s.owner || s.companyId); };
  async function checkKey() {
    if (!boardKey || keyBad) return false;
    // 動いている間に鍵の file が消えた（aioffice-reset-owner など）も、断られたのと同じに扱う（設計 2.3・保証 7）
    if (!boardKey.has()) { if (hadKey) { hadKey = false; keyBad = true; console.log('aioffice: launcher key removed; stopping agents until the owner recreates it'); return true; } return false; }
    hadKey = true;
    let r; try { r = await rawFetchFn(new URL('/api/cli-auth/me', paperclipUrl), { headers: { authorization: `Bearer ${boardKey.token()}` } }); } catch { return false; } // 本体が起きていないだけ
    if (r.status >= 500) return false;
    const j = r.ok ? await r.json().catch(() => null) : null;
    if (r.ok && j?.isInstanceAdmin) return false;
    keyBad = true;
    console.log(`aioffice: launcher key rejected (${r.status}); stopping agents until the owner recreates it`);
    return true;
  }
  const send = (res, status, body, headers = {}) => { const json = typeof body !== 'string'; res.writeHead(status, { 'content-type': json ? 'application/json; charset=utf-8' : 'text/plain; charset=utf-8', 'cache-control': 'no-store', ...headers }); res.end(json ? JSON.stringify(body) : body); };
  const readBody = (req, max = MAX_BODY) => new Promise((resolve, reject) => {
    let n = 0; const chunks = [];
    // 上限を超えたら読むのをやめて 413 を返す。接続は切らずに残りを読み捨てる（切ると 413 の応答が届かない・codex P2-1）
    let over = false;
    req.on('data', c => { if (over) return; n += c.length; if (n > max) { over = true; chunks.length = 0; reject(Object.assign(new Error('too_large'), { status: 413 })); } else chunks.push(c); });
    req.on('end', () => { if (over) return; let v; try { v = chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {}; } catch { v = undefined; } if (v && typeof v === 'object' && !Array.isArray(v)) resolve(v); else reject(Object.assign(new Error('bad_json'), { status: 400 })); }); // 中身はオブジェクトだけ（null・配列・数は 400）
    req.on('error', reject);
  });
  const text = (v, max) => (typeof v === 'string' ? v.replace(/[\u0000-\u001f\u007f]/g, '').trim() : '').slice(0, max);

  function publicState(req) {
    const s = store.get(), lang = pickLang(s.lang), ok = authed(req);
    const st = req.aio?.stage || 'legacy';
    const hasOwner = st === 'legacy' || st === 'migrating' ? !!s.owner : st !== 'preclaim';
    const base = { lang, langSet: !!s.lang, hasOwner, authed: ok, done: s.done, stage: st, member: !!req.aio?.member, claimCode: !!req.aio?.claimCookie, resetPending: !!resetInvite(), keyReady: st === 'ready', volume: volumeMounted(path.dirname(dataDir)) };
    // 返す中身は 3 つ（設計 2.2 の表・独立レビュー 7）: 持ち主（authed）は全部・会社の人（member）は会社の名前まで・その他は基本の欄だけ。
    // ログインのある形では、持ち主がまだいない段（preclaim）でも、sign-in していない人に会社・担当・メールの伏せた住所を返さない
    const v2 = st !== 'legacy' && st !== 'migrating';
    if (v2 ? !ok : hasOwner && !ok) {
      if (v2 && req.aio?.member && s.companyId) return { ...base, company: { id: s.companyId, name: s.companyName, prefix: s.companyPrefix } };
      return base;
    }
    const office = pluginStatus()['aioffice.office'], library = pluginStatus()['aioffice.library'];
    return { ...base, agentsDone: !!s.agentsDone, library: library ? library.status : 'pending', timeZone: s.timeZone || null, rounds: roundsStatus(), company: s.companyId ? { id: s.companyId, name: s.companyName, prefix: s.companyPrefix } : null, secretaryId: s.secretaryId, office: office ? office.status : 'pending', agents: s.agents, codex: codex.view(), ai: { chosen: !!s.aiChosen, selected: s.aiSelected || [], agentAi: s.agentAi || {}, claude: claude.view(), names: Object.fromEntries((s.aiSelected || []).map(t => [t, catalogEntry(t)?.name?.[lang] || t])) },
      slack: Object.fromEntries(Object.entries(s.slack || {}).map(([cid, v]) => [cid, { savedAt: v?.savedAt || null }])), // 保存した日時だけ（URL も指紋も出さない・S3）
      mail: Object.fromEntries(Object.entries(s.mail || {}).map(([cid, v]) => [cid, { savedAt: v?.savedAt || null, masked: maskAddr(v?.addr) }])), // 伏せたアドレスと保存した日時だけ（アプリ パスワードも指紋も出さない・M3）
      noInstructions: s.noInstructions || [], templates: Object.entries(TEMPLATES).filter(([, t]) => !t.required).map(([id, t]) => ({ id, name: t.name[lang], title: t.title[lang], added: !!s.agents[id] })) };
  }

  // 担当づくり（作る → 役の指示書を書く → 揃える）と、判断の書き方を揃える処理は 1 本の列で順に回す。
  // 重なると、揃える処理が役の指示書を書く前の中身で全文を書き戻し、役の本文が消えうる（実装レビュー P3-1）
  let caseChain = Promise.resolve();
  const serial = fn => { const p = caseChain.then(fn, fn); caseChain = p.catch(() => {}); return p; };
  const createDesk = (...args) => serial(() => createDeskNow(...args));
  async function createDeskNow(id, name, aiType = 'codex_local') {
    const s = store.get(), lang = pickLang(s.lang), t = TEMPLATES[id];
    // Codex は前の版と同じ形（engine cli）。ほかの AI は表の既定で、Claude は env で token の秘密を指す（割り当て直しと同じ関数）
    const key = keyFor(aiType);
    const adapterConfig = deskAdapterConfig(aiType, { claudeSecretId: s.ais?.claude_local?.secretId, keySecretId: key });
    const agent = await pc.createAgent(s.companyId, { name: name || t.name[lang], title: t.title[lang], adapterType: aiType, adapterConfig });
    // 鍵の参照つきで作った時は、作っている間に契約でつながっていたら外す（その時の鎖は一覧に無いこの担当を見ていない・独立レビュー r5 の P3）
    if (key) await syncKeyRefs(aiType);
    store.update(x => { x.agentAi = { ...(x.agentAi || {}), [id]: aiType }; });
    let ok = false; try { ok = writeInstructions(agent, templateText(id, lang)); } catch (e) { console.log(`aioffice: could not write instructions for ${id}: ${e.code || e.message}`); }
    if (!ok) store.update(x => { x.noInstructions = [...new Set([...(x.noInstructions || []), id])]; }); // 完了の画面で知らせる // 担当はできているので、覚えずにやり直して 2 人目を作ることはしない
    await runCaseSync(); // 判断の書き方を、足した担当を含む全部の AI の担当に揃える（失敗しても担当づくりは止めない）
    return agent.id;
  }

  // 判断の書き方（templates/case-format.*.md）を会社の全部の AI の担当の指示書に揃える（範囲 docs/review/2026-11-25-case-format-in-public-scope.md）。
  // 起動の後に 1 回（見回りの毎分が、成功するまで呼ぶ）と、担当を足した時。同じ本文の担当には書かない。成功で true
  const syncCase = () => serial(runCaseSync);
  async function runCaseSync() {
    try { const r = await syncCaseFormat(pc, { lang: pickLang(store.get().lang), log: m => console.log(m) }); if (r.insert || r.replace || r.failed) console.log(`aioffice: case-format insert ${r.insert} replace ${r.replace} same ${r.same} failed ${r.failed}`); return r.failed === 0; }
    catch (e) { console.log(`aioffice: case-format sync failed: ${String(e?.message || e).slice(0, 200)}`); return false; }
  }

  const running = new Map(); // 段ごとに、作っている途中の Promise を 1 つだけ持つ
  const once = (key, fn) => { if (!running.has(key)) running.set(key, Promise.resolve().then(fn).finally(() => running.delete(key))); return running.get(key); };

  // ---- Slack の宛先（docs/review/2026-11-18-slack-notify-scope.md 作り方 3・S1・S3） ----
  // nonce は memory にだけ置く（ファイルにもログにも書かない）。一度だけ使え、2 分で切れ、会社と見本の hash に結ぶ
  const nonces = new Map();
  const sweepNonces = () => { const t = Date.now(); for (const [k, v] of nonces) if (v.exp <= t) nonces.delete(k); };
  const slackOf = cid => store.get().slack?.[cid] || null;
  const slackPortOk = Number(port) === SLACK_LAUNCHER_PORT; // port は listen に渡す数（呼ぶ側が渡す）
  // 「開く」の先: 持ち主が今使っている起動係の住所（Host は hostAllowed で確かめ済み）と、その会社の prefix
  async function officeUrlFor(req, cid) {
    const s = store.get();
    let prefix = cid === s.companyId ? s.companyPrefix : null;
    if (!prefix) { const c = await pc.company(cid); prefix = c?.issuePrefix || null; }
    if (!prefix) throw Object.assign(new Error('company_prefix'), { status: 409 });
    return `${baseOf(req.headers.host, lanHosts)}/${encodeURIComponent(prefix)}/office`;
  }
  const slackErr = (e, dflt = 'slack_failed') => [e?.status && e.status < 500 ? e.status : 502, { error: okCode(e?.body?.error, dflt) }];
  async function saveSlack(cid, url) {
    // 秘密の口で 4xx を起こさない（P8）。ログインのある形の本体は、知らない会社に 404 でなく 403 を返す（会社の権限を先に見る・2026-11-24 公開の CI の slack の 11）
    // 403 は起動係の資格の権限の不足でも起きうるので、本体の status をログに 1 行残す（原因を調べられるように・独立レビュー 22 回目 P3-1）
    try { await pc.company(cid); } catch (e) { if (e.status === 403) console.log('aioffice: slack save: the office returned 403 for the company (unknown company or missing access)'); return [e.status === 404 || e.status === 403 ? 404 : 502, { error: 'company_unknown', status: Number(e.status) || null }]; }
    const had = slackOf(cid)?.secretId;
    let id = null;
    try {
      // 入れ直しは同じ秘密の値を替える（本体で消されていたら作り直す）。値は秘密の口にだけ渡す（本体の plugin の口の body に載せない・S3）
      if (had) { try { await pc.rotateSecret(had, url); id = had; } catch (e) { if (e.status !== 404) throw e; } }
      if (!id) { const stamp = Date.now(); id = (await pc.createSecret(cid, { name: `Slack webhook ${stamp}`, key: `SLACK_WEBHOOK_${stamp}`, value: url })).id; }
      // 設定の保存は丸ごと置き換えなので、今の設定（stuckIdleMin など）を残して slack.webhook だけを替える
      await withPluginConfig('aioffice.notify', cid, cur => ({ ...cur, slack: { webhook: { type: 'secret_ref', secretId: id } } }));
    } catch (e) { return [e.status && e.status < 500 ? 409 : 502, { error: 'slack_save_failed', status: Number(e.status) || null }]; }
    const savedAt = new Date().toISOString();
    // 持ち主が保存した宛先の指紋を覚える（URL は置かない）。本体の口で秘密や参照を替えても、ここは替わらない（r2 の 1）
    store.update(x => { x.slack = { ...(x.slack || {}), [cid]: { fp: destFingerprint(url), secretId: id, savedAt } }; });
    return [200, { ok: true, saved: { masked: MASKED_DEST, savedAt } }];
  }
  async function removeSlack(cid) {
    const had = slackOf(cid);
    try { await pc.notifyRoute('POST', 'slack/off', cid); } catch { /* plugin が無い・止まっている。設定から外せば送れない */ }
    try {
      await withPluginConfig('aioffice.notify', cid, cur => { if (!cur.slack) return null; const { slack: _drop, ...rest } = cur; return rest; });
    } catch (e) { return [502, { error: 'slack_save_failed', status: Number(e.status) || null }]; }
    if (had?.secretId) { try { await pc.deleteSecret(had.secretId); } catch { /* 消せなくても参照は外した */ } }
    store.update(x => { const m = { ...(x.slack || {}) }; delete m[cid]; x.slack = m; });
    return [200, { ok: true, saved: null }];
  }
  // 照合の口: loopback だけ・cookie なし。nonce を照らして消し、会社の覚えた指紋を答えに入れる（S1・r3 の 2）
  async function slackNonce(req, res) {
    if (req.method !== 'POST' || !isLoopback(req.socket?.remoteAddress)) return send(res, 403, { ok: false });
    let b; try { b = await readBody(req); } catch { return send(res, 400, { ok: false }); }
    const v = typeof b.nonce === 'string' ? nonces.get(b.nonce) : null;
    if (v) nonces.delete(b.nonce); // 一度だけ
    sweepNonces(); // 古い物の片付け（期限の判定は下の exp の比べ 1 か所）
    const fp = v ? slackOf(v.companyId)?.fp : null;
    if (!v || v.exp <= Date.now() || v.companyId !== b.companyId || v.previewHash !== b.previewHash || !fp) return send(res, 403, { ok: false });
    return send(res, 200, { ok: true, fp });
  }
  // 「この指紋は持ち主が保存した宛先か」の口: loopback だけ・cookie なし。答えは真偽だけ（覚えた指紋は返さない）。
  // 知らせの plugin が「宛先が変わった」で OFF にする時、持ち主が自分で保存し直した物なら失敗でなく案内にするために使う（実装 r3 の P3-3）
  async function slackSaved(req, res) {
    if (req.method !== 'POST' || !isLoopback(req.socket?.remoteAddress)) return send(res, 403, { ok: false });
    let b; try { b = await readBody(req); } catch { return send(res, 400, { ok: false }); }
    if (typeof b.companyId !== 'string' || typeof b.fp !== 'string' || !/^[0-9a-f]{16}$/.test(b.fp)) return send(res, 400, { ok: false });
    const fp = slackOf(b.companyId)?.fp;
    return send(res, 200, { ok: true, same: !!fp && fp === b.fp });
  }

  const api = {
    'GET /setup/api/connectors': async req => [200, await connectors.get({ fresh: new URL(req.url, 'http://x').searchParams.get('fresh') === '1' })],
    'GET /setup/api/state': async req => {
      if (req.aio?.stage === 'migrating' && authed(req)) return [200, { ...publicState(req), migration: await migrationView(req) }];
      const s = store.get(); // 前の版で作った会社は prefix を記録していない。読める時に本体から写す
      if (s.companyId && !s.companyPrefix && authed(req)) { try { const c = await pc.company(s.companyId); if (c?.issuePrefix) store.update(x => { x.companyPrefix = c.issuePrefix; }); } catch { /* 本体がまだ起きていない */ } }
      return [200, publicState(req)];
    },
    'GET /setup/api/i18n': async () => [200, DICT],
    'POST /setup/api/lang': async (req, b) => { const st = req.aio?.stage; if ((st && st !== 'legacy' && st !== 'migrating' ? st !== 'preclaim' : !!store.get().owner) && !authed(req)) return [401, { error: 'login_required' }]; store.update(s => { s.lang = pickLang(b.lang); const tz = validTimeZone(b.timeZone); if (tz) s.timeZone = tz; }); return [200, publicState(req)]; },
    // 合言葉の口は、前の版と同じ形（boardKey 無し）と移し替えの段だけ（合言葉の無い古い office は、移し替えの前に合言葉を決める・設計 2.4）
    'POST /setup/api/owner': async (req, b, res) => {
      if (req.aio && req.aio.stage !== 'migrating') return [409, { error: 'owner_exists' }];
      if (store.get().owner) return [409, { error: 'owner_exists' }]; // 持ち主の登録は 1 回だけ
      const bad = passwordProblem(b.password); if (bad) return [400, { error: bad }];
      store.update(s => { s.owner = hashPassword(b.password); s.generation += 1; });
      res.setHeader('set-cookie', issueCookie(store.secret, store.get().generation)); return [200, { ok: true }];
    },
    'POST /setup/api/login': async (req, b, res) => {
      if (req.aio && req.aio.stage !== 'migrating') return [409, { error: 'use_account' }]; // 新しい形は本体のアカウントで sign-in する
      const now = Date.now(); while (fails.length && now - fails[0] > 600000) fails.shift();
      if (fails.length >= 10) return [429, { error: 'too_many' }];
      if (!checkPassword(String(b.password ?? ''), store.get().owner)) { fails.push(now); return [401, { error: 'password_wrong' }]; }
      res.setHeader('set-cookie', issueCookie(store.secret, store.get().generation)); return [200, { ok: true }];
    },
    // 最初の持ち主の code（設計 2.3）: 合えば 30 分の cookie を出す。10 分で 10 回まで
    'POST /setup/api/claim-code': async (req, b, res) => {
      if (req.aio?.stage !== 'preclaim') return [409, { error: 'owner_exists' }];
      // reset-owner の招待が生きている間は、最初の持ち主の code では入れない（今回の招待を開いた人だけ・codex の最終確認 P1）
      if (resetInvite()) return [409, { error: 'reset_in_progress' }];
      const now = Date.now(); while (claimTries.length && now - claimTries[0] > 600000) claimTries.shift();
      if (claimTries.length >= 10) return [429, { error: 'too_many' }];
      let want = ''; try { want = fs.readFileSync(claimFile, 'utf8').trim(); } catch { /* 無い */ }
      const got = String(b.code ?? '').trim().toUpperCase();
      if (!want || got.length !== want.length || !crypto.timingSafeEqual(Buffer.from(got), Buffer.from(want))) { claimTries.push(now); return [401, { error: 'code_wrong' }]; }
      res.setHeader('set-cookie', claimCookieHeader());
      return [200, { ok: true }];
    },
    // 起動係の鍵を作る・作り直す（設計 2.3）: 本体の session の持ち主だけ。起動係がそのブラウザの cookie で本体に鍵を作らせ、0600 に置く（鍵はブラウザに乗らない）
    'POST /setup/api/launcher-key': async req => {
      if (!boardKey) return [404, { error: 'not_found' }];
      const cookie = sessionCookie(req);
      const me = await coreMe(cookie, { fresh: true }); // claim の直後なので覚えた答え（claim の前）を使わない
      health.at = 0;
      if (!(me?.source === 'session' && me.isInstanceAdmin === true)) return [403, { error: 'owner_only' }];
      const r = await rawFetchFn(new URL('/api/board-api-keys', paperclipUrl), { method: 'POST', headers: { cookie, origin: 'http://localhost:3100', 'content-type': 'application/json' }, body: JSON.stringify({ name: 'aioffice-launcher', expiresAt: null }) });
      if (!r.ok) return [502, { error: 'key_failed' }];
      const k = await r.json(); const token = k?.token || k?.key;
      if (!token) return [502, { error: 'key_failed' }];
      const check = await rawFetchFn(new URL('/api/cli-auth/me', paperclipUrl), { headers: { authorization: `Bearer ${token}` } });
      const cj = check.ok ? await check.json() : null;
      if (!cj?.isInstanceAdmin) return [502, { error: 'key_not_admin' }];
      const prev = boardKey.id();
      const prevOwner = store.get().ownerUserId || null;
      boardKey.write({ token, id: k.id || null });
      keyBad = false; hadKey = true;
      if (me.userId) store.update(x => { x.ownerUserId = me.userId; }); // relay の defaultRequester（設計 2.5）
      if (prev && prev !== k.id) { try { await rawFetchFn(new URL(`/api/board-api-keys/${encodeURIComponent(prev)}`, paperclipUrl), { method: 'DELETE', headers: { authorization: `Bearer ${token}` } }); } catch { /* 取り消せなくても新しい鍵で動く */ } }
      try { fs.unlinkSync(claimFile); } catch { /* 無い */ }
      // 持ち主が鍵を作り直した = reset-owner の回は済んだ。招待の印を残すと、期限までの間 code と bootstrap の claim が閉じたままになる（11 回目のレビュー P3-2）
      // 前の持ち主の鍵の作り直しが reset-owner の途中（招待を書いた後・admin を外す前）に重なった時は消さない。消すのは別の人が持ち主になった時だけ（12 回目のレビュー P3-A）
      if (!prevOwner || prevOwner !== me.userId) { try { fs.unlinkSync(path.join(dataDir, 'reset-invite')); } catch { /* 無い */ } }
      // 新しく入れた office はここで v = 2 にそろえる。移し替えの office は、付け替えの段（設計 2.4 の 5）が済むまで v を上げない（合言葉と v は同じ 1 回の書き込みで片付ける）
      if (!migratingNow()) store.update(x => { x.v = 2; });
      restartCore(); // scheduler を戻して起こし直す（plugin の照合も起こし直しの中で回る）
      // 本体が起き直すまで待ってから答える（直後の会社の作成が「まだ起動中」にならない）。60 秒で切り上げる
      for (let i = 0; i < 40; i++) { await new Promise(r => setTimeout(r, 1500)); health.at = 0; const me2 = await coreMe(cookie, { fresh: true }); if (me2?.isInstanceAdmin) break; }
      return [200, { ok: true }];
    },
    // 人（設計 2.5・持ち主だけ）: 一覧・肩書き・上の人・確かめたメール・招く
    'GET /setup/api/people': async () => { const { index } = await peopleNow(); return [200, { people: peopleRows({ index, people: store.get().people }) }]; },
    'POST /setup/api/people': async (req, b) => {
      const { index } = await peopleNow();
      const userId = String(b.userId || '');
      if (!index[userId]) return [404, { error: 'person_unknown' }];
      let people = store.get().people || {};
      if ('boss' in b) { const r = setBoss(people, userId, b.boss ? String(b.boss) : null, index); if (r.error) return [400, { error: r.error }]; people = r.people; }
      const cur = { ...(people[userId] || {}) };
      if (typeof b.title === 'string') cur.title = b.title.trim().slice(0, 80);
      // 知らせのメールは、本人が sign-up で書いた email を持ち主が「確かめた」時だけ（別の住所は書かせない）
      if (b.mailConfirmed === true) { cur.mail = index[userId].email; cur.mailConfirmed = true; }
      if (b.mailConfirmed === false) { delete cur.mail; cur.mailConfirmed = false; }
      people = { ...people, [userId]: cur };
      store.update(x => { x.people = people; });
      await syncRelay({ force: true }).catch(e => console.log(`aioffice: plugin config sync failed: ${String(e?.message || e).slice(0, 200)}`));
      return [200, { people: peopleRows({ index, people }) }];
    },
    'POST /setup/api/people/invite': async (req, b) => {
      const cid = COMPANY_ID.test(String(b.companyId || '')) ? b.companyId : store.get().companyId;
      if (!cid) return [409, { error: 'company_first' }];
      const inv = await pc.createInvite(cid);
      // 招待の URL は、持ち主が今開いている起動係の住所（Host は確かめ済み）と token から組み立てる。本体は自分の PUBLIC_URL（localhost）で返すので、ほかの PC の人に渡せない（設計 2.1・独立レビュー 1）
      const token = String(inv?.token || inv?.inviteUrl || '').match(/(?:^|\/invite\/)([A-Za-z0-9_-]{8,200})(?:[?#].*)?$/)?.[1];
      return token ? [200, { inviteUrl: `${baseOf(req.headers.host, lanHosts)}/invite/${token}`, expiresAt: inv.expiresAt || null }] : [502, { error: 'invite_failed' }];
    },
    // 移し替えの段 3: 合言葉で入った持ち主が本体のアカウントを作った後、起動係が拾った token と code で引き継ぐ（token はブラウザに渡さない）
    'POST /setup/api/migrate/claim': async req => {
      if (req.aio?.stage !== 'migrating') return [409, { error: 'not_migrating' }];
      if (!backupDone(store.get().migrationBackup)) return [409, { error: 'backup_first' }]; // backup が済むまで claim に進まない（設計 2.4 段 2・独立レビュー 2）
      const claim = claimInfo(); if (!claim) return [409, { error: 'claim_missing' }];
      const r = await rawFetchFn(new URL(`/api/board-claim/${encodeURIComponent(claim.token)}/claim`, paperclipUrl), { method: 'POST', headers: { cookie: sessionCookie(req), origin: 'http://localhost:3100', 'content-type': 'application/json' }, body: JSON.stringify({ code: claim.code }) });
      if (!r.ok) return [r.status === 401 ? 401 : 502, { error: r.status === 401 ? 'use_account' : 'claim_failed' }];
      clearClaim();
      return [200, { ok: true }];
    },
    // 移し替えの段 5・6: local-board の課題を持ち主に付け替え（選んだ時）、合言葉の消去と v = 2 を 1 回で書き、本体を scheduler を戻して起こし直す
    'POST /setup/api/migrate/finish': async (req, b) => {
      if (req.aio?.stage !== 'migrating') return [409, { error: 'not_migrating' }];
      if (!boardKey?.has()) return [409, { error: 'launcher_key_missing' }];
      health.at = 0; if (!(await coreHealth())) return [503, { error: 'not_ready' }]; // 鍵を作った後の起こし直しの途中
      const cookie = sessionCookie(req); const me = await coreMe(cookie, { fresh: true });
      if (!(me?.source === 'session' && me.isInstanceAdmin === true && me.userId)) return [403, { error: 'owner_only' }];
      let moved = 0;
      if (b.relink !== false) {
        for (const c of await pc.companies()) {
          // 持ち主（local-board）に割り当てた課題を、ページを最後まで読んでから付け替える（読みながら変えると区切りがずれる・独立レビュー 10）
          const items = [];
          for (let offset = 0; offset < 100_000;) {
            const list = await pc.issues(c.id, `assigneeUserId=local-board&limit=100&offset=${offset}`); const page = Array.isArray(list) ? list : list?.items || [];
            items.push(...page); if (page.length < 100) break; offset += page.length;
          }
          for (const i of items) if (i.assigneeUserId === 'local-board' && !i.assigneeAgentId && !['done', 'cancelled'].includes(i.status)) { await pc.updateIssue(i.id, { assigneeUserId: me.userId }); moved += 1; }
        }
      }
      store.update(x => { x.owner = null; x.generation += 1; x.v = 2; x.ownerUserId = me.userId; });
      restartCore();
      return [200, { ok: true, moved }];
    },
    'POST /setup/api/company': async (req, b) => {
      const name = text(b.name, 80); if (!name) return [400, { error: 'name_required' }];
      await once('company', async () => { if (!store.get().companyId) { const c = await pc.createCompany(name); store.update(s => { s.companyId = c.id; s.companyName = name; s.companyPrefix = c.issuePrefix || null; }); } }); // あれば使う・無ければ作る
      await syncRelay({ force: true }).catch(e => console.log(`aioffice: plugin config sync failed: ${String(e?.message || e).slice(0, 200)}`)); // 新しい会社の plugin に持ち主を書く（書くまで持ち主だけの口は断られる）
      return [200, publicState(req)];
    },
    'POST /setup/api/secretary': async (req, b) => {
      if (!store.get().companyId) return [409, { error: 'company_first' }];
      await once('secretary', async () => { if (!store.get().secretaryId) { const id = await createDesk('secretary', text(b.name, 60), pickAi(b.ai)); store.update(s => { s.secretaryId = id; }); } });
      return [200, publicState(req)];
    },
    // AI の段: 一覧・入れる・つなぐ・code を渡す・取り消す・選ぶ（type は body で渡す）
    'GET /setup/api/ai': async () => [200, { ais: await aiList(), claude: claude.view(), codex: codex.view(), logins: Object.fromEntries([...logins].map(([t, l]) => [t, l.view()])) }],
    'POST /setup/api/ai/install': async (req, b) => { const e = catalogEntry(b.type); if (!e?.include) return [400, { error: 'ai_unknown' }]; return [200, installer.start(b.type)]; },
    'POST /setup/api/ai/start': async (req, b) => {
      if (!store.get().companyId) return [409, { error: 'company_first' }];
      if (b.type === 'codex_local') return [200, ['idle'].includes(codex.view().state) ? codex.start() : codex.restart()];
      if (b.type === 'claude_local') { if (!installer.installed('claude_local')) return [409, { error: 'ai_install_first' }]; return [200, claude.start()]; }
      if (logins.has(b.type)) { if (!installer.installed(b.type)) return [409, { error: 'ai_install_first' }]; return [200, logins.get(b.type).start()]; }
      return [409, { error: catalogEntry(b.type)?.include ? 'ai_connect_not_ready' : 'ai_unknown' }];
    },
    'POST /setup/api/ai/code': async (req, b) => { if (b.type !== 'claude_local') return [400, { error: 'ai_unknown' }]; const v = claude.submit(b.code); return [v.error === 'bad_code' || v.error === 'not_waiting' ? 400 : 200, v.error === 'bad_code' ? { ...v, error: 'ai_bad_code' } : v.error === 'not_waiting' ? { ...v, error: 'ai_not_waiting' } : v]; },
    'POST /setup/api/ai/cancel': async (req, b) => b.type === 'claude_local' ? [200, claude.cancel()] : b.type === 'codex_local' ? [200, codex.cancel()] : logins.has(b.type) ? [200, logins.get(b.type).cancel()] : [400, { error: 'ai_unknown' }],
    // API の鍵でつなぐ（表に keyEnv がある AI）。鍵は会社の秘密にだけ入れ、応答・状態の file・記録に出さない
    'POST /setup/api/ai/key': async (req, b) => {
      if (!store.get().companyId) return [409, { error: 'company_first' }];
      const e = catalogEntry(b.type);
      if (!e?.include || !e.keyEnv) return [400, { error: 'ai_unknown' }];
      if (!installer.installed(e.type)) return [409, { error: 'ai_install_first' }];
      const key = typeof b.key === 'string' ? b.key.trim() : '';
      if (!/^[\x21-\x7e]{8,512}$/.test(key)) return [400, { error: 'ai_bad_key' }];
      try { await saveKey(e, key); } catch (err) { console.log(`aioffice: could not save the API key for ${e.type}: ${err?.status || 'error'}`); return [502, { error: 'ai_key_save_failed' }]; }
      return [200, { ok: true }];
    },
    // つないだ AI で本体の test-environment を回す（担当を作る前に確かめる口）
    'POST /setup/api/ai/check': async (req, b) => { const s = store.get(); if (!s.companyId) return [409, { error: 'company_first' }]; if (!catalogEntry(b.type)?.include) return [400, { error: 'ai_unknown' }]; try { return [200, { ok: true, result: await pc.testEnvironment(s.companyId, b.type) }]; } catch (e) { return [200, { ok: false, status: e.status || null }]; } },
    'POST /setup/api/ai/choose': async (req, b) => {
      const want = Array.isArray(b.types) ? b.types.filter(t => catalogEntry(t)?.include) : [];
      const ok = want.filter(connected);
      // つないだ AI が無くても「あとでつなぐ」で先へ進める（前の版の Codex の段と同じ）。その時は Codex で担当を作る
      if (!ok.length && b.later !== true) return [400, { error: 'ai_none' }];
      store.update(s => { s.aiChosen = true; s.aiSelected = ok.length ? ok : ['codex_local']; });
      return [200, publicState(req)];
    },
    'POST /setup/api/codex/start': async () => [200, codex.start()],
    'POST /setup/api/codex/restart': async () => [200, codex.restart()],
    'POST /setup/api/codex/cancel': async () => [200, codex.cancel()],
    'POST /setup/api/codex/check': async () => { const s = store.get(); if (!s.companyId) return [409, { error: 'company_first' }]; try { return [200, { ok: true, result: await pc.testEnvironment(s.companyId) }]; } catch (e) { return [200, { ok: false, status: e.status || null }]; } },
    'POST /setup/api/agents': async (req, b) => {
      if (!store.get().secretaryId) return [409, { error: 'secretary_first' }];
      for (const id of Array.isArray(b.ids) ? b.ids : []) {
        if (!Object.hasOwn(TEMPLATES, id) || TEMPLATES[id].required || store.get().agents[id]) continue;
        await once(`agent:${id}`, async () => { if (store.get().agents[id]) return; const aid = await createDesk(id, undefined, pickAi(b.ai?.[id])); store.update(s => { s.agents = { ...s.agents, [id]: aid }; }); });
      }
      if (b.done === true) store.update(s => { s.agentsDone = true; }); // 次はフォルダの段（読み込み直しても戻る）
      return [200, publicState(req)];
    },
    // 社員ごとの AI（オフィスの「AI の契約」の欄）。対象は会社の全担当で、今の AI は本体の adapterType から読む（範囲 2026-11-18 F1）
    'GET /setup/api/agents/ai': async () => {
      const s = store.get(); if (!s.companyId) return [409, { error: 'company_first' }];
      const list = await pc.agents(s.companyId);
      return [200, { agents: (Array.isArray(list) ? list : []).map(a => ({ id: a.id, name: a.name, title: a.title ?? null, adapterType: a.adapterType ?? null })) }];
    },
    // 割り当ての保存: { assign: { <agentId>: <type> } }。本体の PATCH /api/agents/:id に adapterType と、AI の key だけを入れ替えた adapterConfig を送る。
    // つないでいない AI へは替えない（400）。同時に 1 本だけ。返り値は担当ごとの { ok, why }
    'POST /setup/api/agents/ai': async (req, b) => {
      const s = store.get(); if (!s.companyId) return [409, { error: 'company_first' }];
      const assign = b.assign;
      if (!assign || typeof assign !== 'object' || Array.isArray(assign)) return [400, { error: 'assign_bad' }];
      const pairs = Object.entries(assign);
      if (!pairs.length || pairs.length > 100 || pairs.some(([id, type]) => !id || id.length > 100 || typeof type !== 'string')) return [400, { error: 'assign_bad' }];
      for (const [, type] of pairs) {
        if (!catalogEntry(type)?.include) return [400, { error: 'ai_unknown', type }];
        if (!connected(type)) return [400, { error: 'ai_not_connected', type }];
      }
      if (running.has('agents-ai')) return [409, { error: 'assign_busy' }];
      const results = await once('agents-ai', async () => {
        const now = store.get(), byId = new Map((await pc.agents(now.companyId) || []).map(a => [a.id, a]));
        const template = Object.fromEntries([...(now.secretaryId ? [[now.secretaryId, 'secretary']] : []), ...Object.entries(now.agents || {}).map(([k, id]) => [id, k])]);
        const out = {};
        for (const [id, type] of pairs) {
          const a = byId.get(id);
          if (!a) { out[id] = { ok: false, why: 'agent_unknown' }; continue; }
          // 同じ種類なら本体を呼ばない（Claude の token は秘密の rotate で値だけ替わり、参照は同じまま）。
          // ただし Claude の担当が secret_ref で今の秘密と違う秘密を指していたら、参照だけを付け替える（持ち主がこの欄で Claude を選んで保存した時・独立レビュー r3 の A・r4 の A'）
          if (a.adapterType === type) {
            const sid = now.ais?.claude_local?.secretId;
            const ref = type === 'claude_local' ? claudeRef(a) : null;
            if (!sid || !ref || ref === sid) { out[id] = { ok: true, why: 'same' }; continue; } // 参照の無い担当（API の鍵など）は same
            try { await relinkClaude(a, sid); await syncKeyRefs('claude_local'); out[id] = { ok: true, why: 'relinked' }; } catch (e) { out[id] = { ok: false, why: e.status ? `paperclip_${e.status}` : 'failed' }; }
            continue;
          }
          try {
            const key = keyFor(type);
            await pc.updateAgent(id, { adapterType: type, adapterConfig: swapAdapterConfig(a.adapterConfig, deskAdapterConfig(type, { claudeSecretId: now.ais?.claude_local?.secretId, keySecretId: key })) });
            out[id] = { ok: true, why: null };
            if (key) await syncKeyRefs(type); // 鍵の参照つきで替えた担当も、その間に契約でつながっていたら外す（r5 の P3）
            if (template[id]) store.update(x => { x.agentAi = { ...(x.agentAi || {}), [template[id]]: type }; });
          } catch (e) { out[id] = { ok: false, why: e.status ? `paperclip_${e.status}` : 'failed' }; }
        }
        return out;
      });
      return [200, { results }];
    },
    // フォルダの欄: wizard の会社の図書室の口へ 1 件ずつ順に渡す（図書室の表には書かない。上限と秘密を伏せる決まりは図書室の口が守る）
    [FOLDER_PATH]: async (req, b) => {
      const s = store.get();
      if (!s.companyId) return [409, { error: 'company_first' }];
      const lib = pluginStatus()['aioffice.library'];
      if (!lib || lib.status !== 'ready') return [409, { error: lib?.status === 'failed' ? 'library_unavailable' : 'library_pending' }];
      const docs = b.docs;
      if (!Array.isArray(docs) || !docs.length || docs.some(d => !d || typeof d.name !== 'string' || typeof d.text !== 'string')) return [400, { error: 'bad_docs' }];
      if (docs.length > FOLDER_LIMITS.docs || Buffer.byteLength(JSON.stringify(docs)) > FOLDER_LIMITS.bytes) return [413, { error: 'too_large' }];
      if (running.has('folder')) return [409, { error: 'folder_busy' }]; // 同時に 1 本だけ（本体への同時の書き込みを増やさない）
      const results = await once('folder', async () => {
        const out = [];
        for (const d of docs) {
          try { const r = await pc.libraryPut(s.companyId, d.name, d.text); out.push({ name: d.name, ok: true, stored: r?.name || d.name }); }
          catch (e) { const code = String(e.body?.error || ''); out.push({ name: d.name, ok: false, why: code.startsWith('library_doc_') ? code : 'library_failed' }); }
        }
        return out;
      });
      return [200, { results }];
    },
    // AI の使用量の上限（範囲 docs/review/2026-11-18-ai-usage-limit-scope.md 7 の 1・G1・G8）。値は state.json に残し、見回りで notify へ渡す（5 分以内に効く）
    // 読む時は、会社ごとに最後に読めた Claude の使用率と読んだ時刻も返す（「AI の契約」の欄）
    'GET /setup/api/ai-limits': async () => {
      const s = store.get();
      const claude = Object.fromEntries(Object.entries(s.aiLimitsRun || {}).map(([cid, r]) => [cid, r?.claudeLast ? { observedAt: r.claudeLast.observedAt ?? null, status: r.claudeLast.status ?? null, unifiedWindows: r.claudeLast.unifiedWindows ?? {}, isUsingOverage: r.claudeLast.isUsingOverage ?? null, overageStatus: r.claudeLast.overageStatus ?? null } : null]));
      return [200, { aiLimits: normalizeAiLimits(s.aiLimits), claude }];
    },
    'POST /setup/api/ai-limits': async (req, b) => {
      const m = mergeAiLimits(store.get().aiLimits, b);
      if (m.error) return [400, { error: m.error }];
      store.update(x => { x.aiLimits = m.value; });
      return [200, { aiLimits: m.value }];
    },
    // Slack の宛先の保存・消す（URL を受けるのはこの口だけ。返事は伏せた形と日時だけ・body はログに書かない）
    'POST /setup/api/slack': async (req, b) => {
      const cid = COMPANY_ID.test(String(b.companyId || '')) ? b.companyId : null;
      if (!cid) return [400, { error: 'company_bad' }];
      if (b.remove !== true && !slackPortOk) return [409, { error: 'slack_port' }]; // 消すのは送らない側なので通す
      if (b.remove !== true && !slackUrlOk(b.url)) return [400, { error: 'slack_url_bad' }]; // 形の合わない URL は保存せず本体にも渡さない（S3）
      if (running.has(`slack:${cid}`)) return [409, { error: 'slack_busy' }];
      return once(`slack:${cid}`, () => (b.remove === true ? removeSlack(cid) : saveSlack(cid, b.url)));
    },
    // 見本: 言語と office の URL を起動係が足して知らせの plugin へ（confirm と同じ作り方にする）
    'GET /setup/api/slack/preview': async req => {
      const u = new URL(req.url, 'http://x'), cid = u.searchParams.get('companyId') || '';
      if (!COMPANY_ID.test(cid)) return [400, { error: 'company_bad' }];
      if (!slackOf(cid)?.fp) return [409, { error: 'slack_no_dest' }];
      const kinds = u.searchParams.get('kinds') || '', form = u.searchParams.get('form') || '';
      if (!/^[a-z_,]{1,100}$/.test(kinds) || !/^[a-z]{1,20}$/.test(form)) return [400, { error: 'slack_bad_choice' }];
      try { return [200, await pc.notifyRoute('GET', 'slack/preview', cid, { query: { kinds, form, lang: pickLang(store.get().lang), officeUrl: await officeUrlFor(req, cid) } })]; }
      catch (e) { return slackErr(e); }
    },
    // ON にする: 一度だけの nonce を作り、言語と office の URL を足して worker の confirm へ。nonce と指紋は body・返事に出さない
    'POST /setup/api/slack/confirm': async (req, b) => {
      const cid = COMPANY_ID.test(String(b.companyId || '')) ? b.companyId : null;
      if (!cid) return [400, { error: 'company_bad' }];
      if (!slackPortOk) return [409, { error: 'slack_port' }]; // nonce を作らない
      if (!slackOf(cid)?.fp) return [409, { error: 'slack_no_dest' }]; // 持ち主が保存した宛先の無い会社は断る
      const kinds = Array.isArray(b.kinds) ? b.kinds.filter(k => typeof k === 'string' && /^[a-z_]{1,30}$/.test(k)).slice(0, 10) : [];
      if (!kinds.length || typeof b.form !== 'string' || typeof b.previewHash !== 'string' || !/^[0-9a-f]{32}$/.test(b.previewHash)) return [400, { error: 'slack_bad_choice' }];
      sweepNonces();
      const nonce = crypto.randomBytes(32).toString('hex');
      nonces.set(nonce, { companyId: cid, previewHash: b.previewHash, exp: Date.now() + SLACK_NONCE_MS });
      try {
        const r = await pc.notifyRoute('POST', 'slack/confirm', cid, { body: { nonce, kinds, form: b.form, previewHash: b.previewHash, lang: pickLang(store.get().lang), officeUrl: await officeUrlFor(req, cid) } });
        return [200, { on: r?.on === true, onAt: r?.onAt || null }];
      } catch (e) { return slackErr(e); } finally { nonces.delete(nonce); }
    },
    // ---- メールで届ける（範囲 docs/review/2026-11-19-mail-notify-scope.md）。アドレスとアプリ パスワードを受けるのは保存の口だけ。返事は伏せた形だけ ----
    'GET /setup/api/mail': async req => {
      const cid = new URL(req.url, 'http://x').searchParams.get('companyId') || '';
      if (!COMPANY_ID.test(cid)) return [400, { error: 'company_bad' }];
      return [200, await mail.view(cid)];
    },
    'POST /setup/api/mail': async (req, b) => {
      const cid = COMPANY_ID.test(String(b.companyId || '')) ? b.companyId : null;
      if (!cid) return [400, { error: 'company_bad' }];
      if (running.has(`mail:${cid}`)) return [409, { error: 'mail_busy' }];
      return once(`mail:${cid}`, async () => (b.remove === true ? mail.remove(cid) : mail.save(cid, { addr: b.addr, pw: b.pw })));
    },
    'GET /setup/api/mail/preview': async req => {
      const u = new URL(req.url, 'http://x'), cid = u.searchParams.get('companyId') || '';
      if (!COMPANY_ID.test(cid)) return [400, { error: 'company_bad' }];
      const kinds = u.searchParams.get('kinds') || '', form = u.searchParams.get('form') || '';
      if (!/^[a-z_,]{1,100}$/.test(kinds) || !/^[a-z]{1,20}$/.test(form)) return [400, { error: 'mail_bad_choice' }];
      try { return await mail.preview(cid, { kinds, form, lang: pickLang(store.get().lang), officeUrl: await officeUrlFor(req, cid) }); }
      catch (e) { return [e?.status && e.status < 500 ? e.status : 502, { error: 'mail_failed' }]; }
    },
    // ON にする: cookie を確かめたこの口だけ（見回りにも plugin にも ON にする道は無い・M1）
    'POST /setup/api/mail/confirm': async (req, b) => {
      const cid = COMPANY_ID.test(String(b.companyId || '')) ? b.companyId : null;
      if (!cid) return [400, { error: 'company_bad' }];
      const kinds = Array.isArray(b.kinds) ? b.kinds.filter(k => typeof k === 'string' && /^[a-z_]{1,30}$/.test(k)).slice(0, 10) : [];
      try { return mail.confirm(cid, { kinds, form: b.form, previewHash: b.previewHash, lang: pickLang(store.get().lang), officeUrl: await officeUrlFor(req, cid) }); }
      catch (e) { return [e?.status && e.status < 500 ? e.status : 502, { error: 'mail_failed' }]; }
    },
    'POST /setup/api/mail/off': async (req, b) => { const cid = COMPANY_ID.test(String(b.companyId || '')) ? b.companyId : null; return cid ? mail.off(cid) : [400, { error: 'company_bad' }]; },
    'POST /setup/api/mail/test': async (req, b) => { const cid = COMPANY_ID.test(String(b.companyId || '')) ? b.companyId : null; return cid ? mail.test(cid) : [400, { error: 'company_bad' }]; },
    'POST /setup/api/finish': async req => { const s = store.get(); if (!s.companyId || !s.secretaryId) return [409, { error: 'not_ready' }]; store.update(x => { x.done = true; }); return [200, publicState(req)]; },
  };
  // ログイン後に / を開いたらオフィスへ（範囲 2026-11-18 G4・F3）。次の全部の時だけ: GET・path がちょうど /・query 無し・accept に text/html・
  // wizard 済み・ログイン済み（呼ぶ前に確かめる）・office の plugin が ready・会社の prefix あり。それ以外は今どおり本体へ中継（Dashboard は /<prefix>/dashboard）
  const officeHome = (req, s) => {
    if (req.method !== 'GET' || req.url !== '/' || !/\btext\/html\b/i.test(String(req.headers.accept || ''))) return null;
    if (!s.done || !s.companyPrefix || pluginStatus()['aioffice.office']?.status !== 'ready') return null;
    return `/${encodeURIComponent(s.companyPrefix)}/office`;
  };
  const OPEN = new Set(['GET /setup/api/state', 'GET /setup/api/i18n', 'POST /setup/api/lang', 'POST /setup/api/owner', 'POST /setup/api/login', 'POST /setup/api/claim-code', 'POST /setup/api/launcher-key']); // cookie が無くても通す口（中で更に確かめる）

  // 書き込みは関所を通す（本体は同時の書き込みが十数本を超えると止まる・実測 23）。待ちが 60 秒を超えたら 503
  async function proxy(req, res) {
    if (WRITE_METHODS.has(req.method)) {
      // 待っている間にブラウザが切ったら列から抜ける。枠を得た時に既に切れていれば中継せずにすぐ返す（枠を漏らさない）
      const ac = new AbortController();
      const gone = () => ac.abort();
      req.on('close', gone); res.on('close', gone);
      let release;
      try { release = await gate.acquire({ signal: ac.signal }); }
      catch (e) { req.off('close', gone); res.off('close', gone); if (e.message === 'gate_aborted' || res.destroyed) return; return send(res, 503, { error: 'busy' }, { 'retry-after': '5' }); }
      req.off('close', gone);
      if (res.destroyed || res.writableEnded || req.destroyed && !req.complete) { release(); return; }
      res.on('close', release); res.on('finish', release);
    }
    const headers = req.aio ? forwardHeaders(req.headers, { targetHost: target.host, clientHost: frontOf(req.headers.host, lanHosts)?.slice('https://'.length) || req.headers.host, remoteAddress: req.socket?.remoteAddress, proto: schemeOf(req.headers.host, lanHosts) }) : { ...req.headers, host: target.host };
    // 会社の人になる・sign-in と sign-out・招待の accept の後は、その cookie の本体の答えの覚え（5 秒）を捨てる。
    // 捨てないと、accept の直後の要求が accept の前の「会社 0 件」の答えを使い、招かれた人が数秒「会社の人でない」になる（2026-11-24 e2e）
    // 照らすのは正規化した path（/API/… や // の形でも同じに扱う・2 回目のレビュー 低 9）。bootstrap の claim と board-claim は呼んだ人が admin になる
    const np = normPath(req.url) || '';
    const changesMe = req.method !== 'GET' && /^\/api\/(?:invites\/[^/]+\/accept|auth\/|bootstrap\/claim$|board-claim\/[^/]+\/claim$)/.test(np);
    const changesOthers = req.method !== 'GET' && /^\/api\/(?:join-requests\/|admin\/users\/|companies\/[^/]+\/(?:members|join-requests))/.test(np); // 別の人の役が変わる: 誰の cookie か分からないので全部捨てる
    const up = http.request({ host: target.hostname, port: target.port, method: req.method, path: req.url, headers }, r => { if (changesMe) meCache.delete(sessionCookie(req)); if (changesOthers) meCache.clear(); res.writeHead(r.statusCode, dropCors(r.headers)); r.pipe(res); r.on('error', () => res.destroy()); });
    up.on('error', () => { if (!res.headersSent) send(res, 502, DICT[pickLang(store.get().lang)].not_ready); else res.destroy(); });
    up.setTimeout(15 * 60 * 1000, () => up.destroy()); // 何も流れない接続は 15 分で切る（SSE は本体が keep-alive を流す）
    res.on('close', () => { if (!res.writableFinished) up.destroy(); }); // ブラウザが切ったら本体への接続も切る（SSE を読み込み直すたびに溜まらない）
    req.on('error', () => up.destroy()); res.on('error', () => up.destroy());
    req.pipe(up);
  }

  const server = http.createServer((req, res) => {
    handle(req, res).catch(() => { if (!res.headersSent) send(res, 500, { error: 'internal' }); else res.destroy(); }); // どんな要求でも process を落とさない
  });
  // 使っていない接続を閉じるまでの時間。Node の既定の 5 秒だと、前段（cloudflared は 90 秒使い回す）や手元の道具が閉じた直後の接続を使い回し、
  // 要求が「other side closed」で落ちた（2026-11-24 の reset の e2e）。前段より長くする
  server.keepAliveTimeout = 125_000;
  server.headersTimeout = 130_000;
  async function handle(req, res) {
    const host = req.headers.host;
    // 絶対形の request-target（POST http://localhost:3100/api/…）は path の照らしをすり抜けるので断る（独立レビュー 5 回目 低 3）
    if (typeof req.url !== 'string' || !req.url.startsWith('/')) return send(res, 400, 'bad request');
    let url; try { url = new URL(req.url, 'http://x'); } catch { return send(res, 400, 'bad request'); } // 例: GET //[
    // 移し替えが済むまでは、手元の住所だけ（LAN の名前を開けると、合言葉を先に決められる・設計 2.4・独立レビュー 5 回目 低 4）
    if (!hostAllowed(host, migratingNow() ? [] : lanHosts)) {
      // 移し替えの間は手元の住所だけ。許した住所から来た人には、どこで続けるかを出す（独立レビュー 6 回目 P3-1）
      if (migratingNow() && hostAllowed(host, lanHosts)) return send(res, 403, 'The office is moving to the login version. Finish it on the office computer at http://localhost:3100/ . / ログインのある形への移し替えの途中です。オフィスの PC で http://localhost:3100/ を開いて済ませてください。');
      return send(res, 403, 'forbidden host');
    }
    if (!originAllowed({ method: req.method, host, origin: req.headers.origin, extra: lanHosts })) return send(res, 403, 'forbidden origin');
    req.aio = await identify(req);
    if (req.method === 'GET' && STATIC[url.pathname]) { const [f, type] = STATIC[url.pathname]; res.writeHead(200, { 'content-type': type, 'cache-control': 'no-store', 'x-frame-options': 'DENY' }); return fs.createReadStream(path.join(PUBLIC, f)).on('error', () => res.destroy()).pipe(res); }
    if (req.method === 'GET' && url.pathname === '/setup') return send(res, 302, '', { location: '/setup/' });
    const key = `${req.method} ${url.pathname}`;
    if (url.pathname === '/setup/internal/slack-nonce') return slackNonce(req, res); // loopback だけ（中で確かめる）
    if (url.pathname === '/setup/internal/slack-saved') return slackSaved(req, res); // loopback だけ（中で確かめる）
    if (url.pathname.startsWith('/setup/api/')) {
      // 試験用の差し替え口: CI だけの env が設定され、呼び手が loopback の時だけ。それ以外は知らない口と同じ 404（ログインの前に返す）
      if (key === TEST_HOOK_PATH) {
        if (!testHooks || !limitOverrides || !isLoopback(req.socket?.remoteAddress)) return send(res, 404, { error: 'not_found' });
        if (!authed(req)) return send(res, 401, { error: 'login_required' });
        try { const body = await readBody(req, 1024 * 1024); return send(res, 200, limitOverrides.set(body)); }
        catch (e) { return send(res, e.status && e.status < 500 ? e.status : 400, { error: e.message }); }
      }
      // メールの見回りを今すぐ 1 回流す口（e2e のためだけ）。差し替え口と同じ条件: CI だけの env・loopback・cookie。それ以外は知らない口と同じ 404。
      // 配る起動には env が無いので、外から「送れ」と頼む口は無い（範囲 docs/review/2026-11-19-mail-notify-scope.md r2「送る形」）
      if (key === MAIL_ROUND_HOOK) {
        if (!testHooks || !isLoopback(req.socket?.remoteAddress)) return send(res, 404, { error: 'not_found' });
        if (!authed(req)) return send(res, 401, { error: 'login_required' });
        try { const list = await pc.companies(); return send(res, 200, { round: await mail.round((Array.isArray(list) ? list : list?.items || []).map(c => ({ id: c.id }))) }); }
        catch (e) { return send(res, e.status && e.status < 500 ? e.status : 502, { error: 'mail_failed' }); }
      }
      const fn = api[key]; if (!fn) return send(res, 404, { error: 'not_found' });
      // sign-in した member（持ち主でない人）は 403、sign-in していない人は 401（設計 6 の e2e 2・独立レビュー 12）
      if (!OPEN.has(key) && !authed(req)) return req.aio?.member ? send(res, 403, { error: 'owner_only' }) : send(res, 401, { error: 'login_required' });
      if (key === FOLDER_PATH && !isJson(req.headers['content-type'])) return send(res, 415, { error: 'json_only' }); // login の後・本文を読む前
      try { const body = req.method === 'POST' ? await readBody(req, key === FOLDER_PATH ? FOLDER_LIMITS.body : MAX_BODY) : {}; const [status, out] = await fn(req, body, res); return send(res, status, out); }
      catch (e) { return send(res, e.status && e.status < 500 ? e.status : 502, { error: e.message }); }
    }
    const s = store.get();
    if (!req.aio) { // 前の版と同じ形（boardKey 無し）
      if (!s.done || !authed(req)) return req.method === 'GET' ? send(res, 302, '', { location: '/setup/' }) : send(res, s.done ? 401 : 409, { error: s.done ? 'login_required' : 'setup_not_done' });
      const office = officeHome(req, s); if (office) return send(res, 302, '', { location: office });
      return proxy(req, res);
    }
    // ログインのある形: 段の表で照らし、通る物は本体の session と権限に任せる（設計 2.1・2.2）
    // まだ使える段でない・sign-in していない人（会社の member でも持ち主でもない）が入口を開いたら、wizard のサインインへ（サインインの後にオフィスへ戻す）
    if (req.method === 'GET' && url.pathname === '/' && (!s.done || req.aio.stage !== 'ready' || !(req.aio.owner || req.aio.member))) return send(res, 302, '', { location: '/setup/' });
    // aioffice-reset-owner が出した招待（token の hash を reset-invite に置く）を鍵の無い段で開いた人に、code の cookie を出す（設計 2.8・独立レビュー 5）
    if ((req.aio.stage === 'keyless' || req.aio.stage === 'preclaim') && req.method === 'GET' && !req.aio.claimCookie) {
      const t = url.pathname.match(/^\/invite\/([A-Za-z0-9_-]{8,200})$/)?.[1];
      if (t && resetInviteMatches(t)) { res.setHeader('set-cookie', claimCookieHeader()); req.aio = { ...req.aio, claimCookie: true }; }
    }
    const a = coreAccess({ method: req.method, url: req.url, state: { ...req.aio, resetPending: !!resetInvite() } });
    if (a === 'bad') return send(res, 400, 'bad request');
    if (a === 'deny') return send(res, 503, { error: 'launcher_key_missing' }, { 'retry-after': '30' });
    if (req.aio.member) { const office = officeHome(req, s); if (office) return send(res, 302, '', { location: office }); }
    // 持ち主が plugin の口を呼んだ時、その会社の plugin に持ち主をまだ書いていなければ、中継の前に書く（後から作った会社でもすぐ通る・設計 2.2b）
    // まだ持ち主を書いていない会社は、plugin の口の前に 1 回そろえる。そろわない会社（plugin が failed のまま等）でも、会社ごとに 60 秒に 1 回まで（2 回目のレビュー 低 6）
    if (req.aio.owner && url.pathname.startsWith('/api/plugins/')) {
      const cid = url.searchParams.get('companyId');
      // 入れ終わった plugin の組が前にそろえた時から変わったら、60 秒を待たずにそろえる（入れた直後の plugin に持ち主が無く断られる・2026-11-24 e2e）
      const readyNow = readyKey(), last = preSyncAt.get(cid);
      if (cid && syncedCompanies.get(cid) !== readyNow && (!last || last.ready !== readyNow || Date.now() - last.at > 60_000)) { preSyncAt.set(cid, { at: Date.now(), ready: readyNow }); if (preSyncAt.size > 200) preSyncAt.clear(); await syncRelay({ force: !last || last.ready !== readyNow }).catch(() => {}); }
    }
    return proxy(req, res);
  }

  server.on('upgrade', (req, socket, head) => { // WebSocket も同じ守りを通してから本体へ
    socket.on('error', () => socket.destroy()); // upgrade の socket は http server の error の受け手から外れる。受け手が無いと EPIPE で process ごと落ちる
    const host = req.headers.host, s = store.get();
    const deny = code => { socket.end(`HTTP/1.1 ${code} Forbidden\r\nconnection: close\r\n\r\n`); socket.destroySoon?.(); };
    if (typeof req.url !== 'string' || !req.url.startsWith('/')) return deny(400);
    if (!hostAllowed(host, migratingNow() ? [] : lanHosts) || !originAllowed({ method: 'GET', host, origin: req.headers.origin, upgrade: true, extra: lanHosts })) return deny(403);
    const go = hdrs => {
    const up = net.connect(Number(target.port), target.hostname, () => {
      const lines = [`${req.method} ${req.url} HTTP/1.1`, ...Object.entries(hdrs).flatMap(([k, v]) => (Array.isArray(v) ? v : [v]).map(x => `${k}: ${x}`))];
      up.write(`${lines.join('\r\n')}\r\n\r\n`); if (head?.length) up.write(head); up.pipe(socket); socket.pipe(up);
    });
    up.on('error', () => socket.destroy()); socket.on('error', () => up.destroy());
    };
    if (!boardKey) { if (!s.done || !authed(req)) return deny(401); return go({ ...req.headers, host: target.host }); }
    identify(req).then(aio => {
      req.aio = aio;
      if (coreAccess({ method: 'GET', url: req.url, state: aio }) !== 'pass' || aio.stage !== 'ready') return deny(503);
      if (!(aio.owner || aio.member)) return deny(401); // session の無い WebSocket は本体へつながない（本体は答えずに持ったままにする）
      go(forwardHeaders(req.headers, { targetHost: target.host, clientHost: frontOf(req.headers.host, lanHosts)?.slice('https://'.length) || req.headers.host, remoteAddress: req.socket?.remoteAddress, proto: schemeOf(req.headers.host, lanHosts) }));
    }, () => deny(503));
  });
  server.on('close', () => { codex.stop(); claude.stop(); for (const l of logins.values()) l.stop(); });
  // 移し替えの間（v が 2 でなく前の版の跡がある）は、鍵があっても担当を止めておく（設計 2.4）
  // 回覧が人に届いた時のメール（設計 2.6）: 持ち主のメールの知らせが ON の会社で、ON にした後に回覧が人に割り当てた課題を 1 回ずつ。
  // 送り先は持ち主が確かめた住所（people[userId].mail・mailConfirmed）だけ。確かめた住所が無い人には送らない（人の欄に「メール未確認」）
  async function relayMail() {
    if (!boardKey || !boardKey.has() || keyBad) return { skipped: true };
    const s = store.get(), out = {};
    for (const cid of Object.keys(s.mail || {})) {
      const st = mail.mailOf(cid); if (!st?.on || !st.onAt) continue;
      const rm = s.relayMail?.[cid] || {};
      const since = rm.since && Date.parse(rm.since) > Date.parse(st.onAt) ? rm.since : st.onAt;
      const startedAt = new Date().toISOString();
      // 回覧の課題だけを 500 件ずつ、最後のページまで読む（1 ページで切ると、外の課題にメールが届かない・独立レビュー 5 回目 低 7）
      // 並びは課題の id（変わらない）。更新の順で読むと、読む間に更新された課題が末尾へ動いて列が詰まり、読み落としに気づけなかった（16 回目のレビュー P2・ADR-0162 で方式を替えた）
      let raw = [], whole = true;
      try {
        // 次のページは前のページの最後の id より後（本体の afterId・offset を使わない）。読む間に課題が消えても増えても列はずれないので、読み落としに気づく確かめが要らない
        // （offset で 50 件重ねる形は、消えた件数・空のページ・末尾へ動く課題で読み落としに気づけない兄弟が続いた・16〜17 回目のレビュー P2・ADR-0162 で方式を替えた）
        const seen = new Set();
        let after = null;
        for (let page = 0; ; page++) {
          if (page >= 20) { whole = false; break; } // 1 回の見回りで 1 万件まで。残りは since を進めずに次の分
          const list = await pc.issues(cid, `updatedSince=${encodeURIComponent(since)}&originKindPrefix=${encodeURIComponent('plugin:aioffice.relay')}&sortField=id&sortDir=asc&limit=500${after ? `&afterId=${encodeURIComponent(after)}` : ''}`);
          const got = Array.isArray(list) ? list : list?.items || [];
          for (const i of got) if (i?.id && !seen.has(i.id)) { seen.add(i.id); raw.push(i); }
          if (got.length < 500) break;
          after = got[got.length - 1]?.id;
          if (!after) { whole = false; break; }
        }
      } catch { continue; }
      const items = raw.filter(i => String(i.originKind || '').startsWith('plugin:aioffice.relay')
        && typeof i.assigneeUserId === 'string' && i.assigneeUserId && i.assigneeUserId !== 'local-board' && !['done', 'cancelled'].includes(i.status));
      // 印は「課題:答えの口（interaction）」。戻りの段は同じ課題に新しい答えの口ができるので、その段でもう 1 通送る（2 回目のレビュー 中 3）
      // 送った印は「課題:答えの口 → 答えの口を作った時刻」。件数だけで捨てると、更新で読み直した未回答の口に 2 度送った（codex の最終確認 P2）。
      // 課題が閉じたのを見たら、その課題の印を外す。上限を超えた分は古い物から外し、外した中で一番新しい作成時刻を horizon に残して、それより前に作られた口には送らない
      // 印の形は公開したどの版でもこの形だけ（時刻の無い配列の形は、公開前の途中の版にしか無い・12 回目のレビュー P3-3）。時刻の無い印は持たない
      const sent = new Map(Array.isArray(rm.sent) ? [] : Object.entries(rm.sent || {}).map(([k, v]) => [k, Number(v)]).filter(([, v]) => Number.isFinite(v) && v > 0));
      let horizon = Number(rm.horizon) || 0;
      const closed = new Set(raw.filter(i => ['done', 'cancelled'].includes(i?.status)).map(i => i.id));
      if (closed.size) for (const k of [...sent.keys()]) if (closed.has(k.split(':')[0])) sent.delete(k);
      const tries = { ...(rm.tries || {}) }; let n = 0, done = whole;
      const now = Date.now();
      // まだ送っていない口（送り直しを待つ・止めた後で手を付けていない）の一番古い作成時刻。horizon はこれより前までしか進めない（codex の確かめ直し P2）
      let unsentMin = Infinity, blind = false, stop = false;
      for (const i of items) {
        const p = store.get().people?.[i.assigneeUserId];
        if (!(p?.mailConfirmed === true && p.mail)) continue;
        let open; try { open = (await pc.interactions(i.id) || []).filter(x => x?.status === 'pending' && x.addresseeUserId === i.assigneeUserId && Date.parse(x.createdAt) >= Date.parse(st.onAt)); } catch { done = false; blind = true; continue; } // ON にした後にできた答えの口だけ。読めなかった回は、まだ送っていない口が分からないので印を外さない
        for (const x of open) {
          const key = `${i.id}:${x.id}`, xAt = Date.parse(x.createdAt) || 0;
          if (sent.has(key) || (horizon && xAt && xAt <= horizon)) continue;
          if (stop || (tries[key]?.next && now < tries[key].next)) { done = false; unsentMin = Math.min(unsentMin, xAt); continue; }
          // 課題の URL は、持ち主がメールの欄で決めた office の URL の住所から組み立てる（本体の返す URL を使わない・設計 2.1）
          let issueUrl = null; try { const prefix = String(i.identifier || '').split('-')[0]; if (prefix && i.identifier) issueUrl = `${new URL(st.officeUrl).origin}/${encodeURIComponent(prefix)}/issues/${encodeURIComponent(i.identifier)}`; } catch { /* 無し */ }
          const r = await mail.sendPerson(cid, { to: p.mail, title: `${i.identifier || ''} ${i.title || ''}`.trim(), key, issueUrl });
          if (['sent', 'maybe', 'drop', 'to_bad'].includes(r)) { sent.set(key, xAt); delete tries[key]; if (r === 'sent' || r === 'maybe') n += 1; continue; }
          done = false;
          if (r !== 'retry' || (tries[key]?.n || 0) + 1 < 3) unsentMin = Math.min(unsentMin, xAt);
          if (r === 'retry') { // 宛先の 1 通の一時的な失敗: 間を空けて 3 回まで。越えたらやめて次の 1 通へ
            const t = (tries[key]?.n || 0) + 1;
            if (t >= 3) { sent.set(key, xAt); delete tries[key]; } else tries[key] = { n: t, next: now + t * 10 * 60_000 };
            continue;
          }
          stop = true; // つながらない・OFF・上限: その会社の送りは次の分に。残りの口は送らずに読み、まだ送っていない口の時刻だけを知る
        }
      }
      // 課題の一覧を全部読めなかった回（whole = false）も、読めなかった課題のまだ送っていない口が分からないので外さない（15 回目のレビュー P2）
      if (sent.size > relayMailKeep && !blind && whole) {
        // 外すのは、まだ送っていない一番古い口より前に作られた口の印だけ（それより後の印は上限を超えても残す。次の回で外す）
        const drop = [...sent.entries()].filter(([, at]) => at < unsentMin).sort((a, b) => a[1] - b[1]).slice(0, sent.size - relayMailKeep);
        for (const [k, at] of drop) { sent.delete(k); horizon = Math.max(horizon, at); }
      }
      store.update(x => { x.relayMail = { ...(x.relayMail || {}), [cid]: { since: done ? startedAt : since, sent: Object.fromEntries(sent), horizon, tries: Object.fromEntries(Object.entries(tries).slice(-100)) } }; });
      out[cid] = n;
    }
    return out;
  }
  return { server, store, codex, mail, checkKey, syncRelay, relayMail, syncCase, keyless: () => !boardKey || !boardKey.has() || keyBad || migratingNow() };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const port = Number(process.env.AIOFFICE_PORT || 3100);
  const { server } = createLauncher({
    dataDir: process.env.AIOFFICE_DATA || '/data/aioffice',
    paperclipUrl: process.env.PAPERCLIP_URL || 'http://127.0.0.1:3101',
    codexHome: process.env.CODEX_HOME || '/data/codex-home',
    codexBin: process.env.CODEX_BIN || 'codex',
    port, // Slack の口は、この数が worker の叩く port と同じ時だけ動く
  });
  server.listen(port, '0.0.0.0', () => console.log(`aioffice launcher: listening on ${port}`)); // container の中では 0.0.0.0。外へは docker の -p 127.0.0.1:… で手元だけに出す
}
