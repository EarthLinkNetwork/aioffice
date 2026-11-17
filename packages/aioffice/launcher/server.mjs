// 起動係（launcher）: container の入口。日英の wizard を出し、済んだら本体（Paperclip）へ中継する
// 仕様: docs/design/2026-11-15-public-package.md。依存なしの node
// 環境変数: AIOFFICE_PORT（3100。本体が PORT を読むので別の名前にする）・AIOFFICE_DATA（/data/aioffice）・PAPERCLIP_URL（http://127.0.0.1:3101）・CODEX_HOME（/data/codex-home）・CODEX_BIN（codex）
import http from 'node:http';
import net from 'node:net';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { hostAllowed, originAllowed, readCookie, cookieValid, issueCookie, hashPassword, checkPassword, passwordProblem } from './lib/guard.mjs';
import { openStore, volumeMounted } from './lib/state.mjs';
import { createCodexLogin } from './lib/codex-login.mjs';
import { createConnectors } from './lib/connectors.mjs';
import { createClaudeLogin } from './lib/claude-login.mjs';
import { createAiInstaller } from './lib/ai-install.mjs';
import { aiChoices, aiBin, aiHome, deskAdapterConfig, swapAdapterConfig, catalogEntry, AI_CATALOG } from './lib/ai-catalog.mjs';
import { createDeviceLogin } from './lib/device-login.mjs';
import { createPaperclip, writeInstructions } from './lib/paperclip.mjs';
import { TEMPLATES, templateText } from './lib/templates.mjs';
import { DICT, pickLang } from './lib/i18n.mjs';
import { createGate, WRITE_METHODS } from './lib/gate.mjs';
// isLoopback は下の Slack の物（127.0.0.0/8・::1）を、試験の口（TEST_HOOK_PATH）にも使う
import { normalizeAiLimits, mergeAiLimits, TEST_HOOK_PATH, testHooksEnabled } from './lib/limits.mjs';
import { slackUrlOk, destFingerprint, MASKED_DEST } from './lib/slack-url.mjs';
import { createMailer } from './lib/mail.mjs';
import { maskAddr } from './lib/mail-core.mjs';
import crypto from 'node:crypto';

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
export function createLauncher({ dataDir, paperclipUrl, codexHome, codexBin = 'codex', fetchFn = fetch, spawnFn, aiSpawnFn, aiExists, claudeTmpRoot, pluginStatus = () => ({}), roundsStatus = () => ({}), gate = createGate(), limitOverrides = null, testHooks = testHooksEnabled(), port = SLACK_LAUNCHER_PORT, mailDeps = {} } = {}) {
  const store = openStore(dataDir);
  // つないだ AI は「使う AI」（aiSelected）に足す（和集合）。オフィスの欄でつないだ AI も wizard でつないだ物と同じに扱う（範囲 2026-11-18 F2）
  const addSelected = type => store.update(x => { x.aiSelected = [...new Set([...(x.aiSelected || []), type])]; });
  let connectors = null; // 下で作る（サインインが済んだら覚えた連携の結果を消す）
  const codex = createCodexLogin({ codexBin, codexHome, ...(spawnFn ? { spawnFn } : {}), onDone: () => { addSelected('codex_local'); syncKeyRefs('codex_local'); connectors?.reset(); } });
  const pc = createPaperclip({ base: paperclipUrl, fetchFn });
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

  const authed = req => cookieValid(store.secret, store.get().generation, readCookie(req.headers.cookie));
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
    const base = { lang, langSet: !!s.lang, hasOwner: !!s.owner, authed: ok, done: s.done, volume: volumeMounted(path.dirname(dataDir)) };
    if (s.owner && !ok) return base;
    const office = pluginStatus()['aioffice.office'], library = pluginStatus()['aioffice.library'];
    return { ...base, agentsDone: !!s.agentsDone, library: library ? library.status : 'pending', timeZone: s.timeZone || null, rounds: roundsStatus(), company: s.companyId ? { id: s.companyId, name: s.companyName, prefix: s.companyPrefix } : null, secretaryId: s.secretaryId, office: office ? office.status : 'pending', agents: s.agents, codex: codex.view(), ai: { chosen: !!s.aiChosen, selected: s.aiSelected || [], agentAi: s.agentAi || {}, claude: claude.view(), names: Object.fromEntries((s.aiSelected || []).map(t => [t, catalogEntry(t)?.name?.[lang] || t])) },
      slack: Object.fromEntries(Object.entries(s.slack || {}).map(([cid, v]) => [cid, { savedAt: v?.savedAt || null }])), // 保存した日時だけ（URL も指紋も出さない・S3）
      mail: Object.fromEntries(Object.entries(s.mail || {}).map(([cid, v]) => [cid, { savedAt: v?.savedAt || null, masked: maskAddr(v?.addr) }])), // 伏せたアドレスと保存した日時だけ（アプリ パスワードも指紋も出さない・M3）
      noInstructions: s.noInstructions || [], templates: Object.entries(TEMPLATES).filter(([, t]) => !t.required).map(([id, t]) => ({ id, name: t.name[lang], title: t.title[lang], added: !!s.agents[id] })) };
  }

  async function createDesk(id, name, aiType = 'codex_local') {
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
    return agent.id;
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
    return `http://${req.headers.host}/${encodeURIComponent(prefix)}/office`;
  }
  const slackErr = (e, dflt = 'slack_failed') => [e?.status && e.status < 500 ? e.status : 502, { error: okCode(e?.body?.error, dflt) }];
  async function saveSlack(cid, url) {
    try { await pc.company(cid); } catch (e) { return [e.status === 404 ? 404 : 502, { error: 'company_unknown' }]; } // 秘密の口で 4xx を起こさない（P8）
    const had = slackOf(cid)?.secretId;
    let id = null;
    try {
      // 入れ直しは同じ秘密の値を替える（本体で消されていたら作り直す）。値は秘密の口にだけ渡す（本体の plugin の口の body に載せない・S3）
      if (had) { try { await pc.rotateSecret(had, url); id = had; } catch (e) { if (e.status !== 404) throw e; } }
      if (!id) { const stamp = Date.now(); id = (await pc.createSecret(cid, { name: `Slack webhook ${stamp}`, key: `SLACK_WEBHOOK_${stamp}`, value: url })).id; }
      // 設定の保存は丸ごと置き換えなので、今の設定（stuckIdleMin など）を残して slack.webhook だけを替える
      const row = await pc.pluginConfig('aioffice.notify', cid);
      await pc.setPluginConfig('aioffice.notify', cid, { ...(row?.configJson || {}), slack: { webhook: { type: 'secret_ref', secretId: id } } });
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
      const row = await pc.pluginConfig('aioffice.notify', cid);
      if (row?.configJson?.slack) { const { slack: _drop, ...rest } = row.configJson; await pc.setPluginConfig('aioffice.notify', cid, rest); }
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
      const s = store.get(); // 前の版で作った会社は prefix を記録していない。読める時に本体から写す
      if (s.companyId && !s.companyPrefix && authed(req)) { try { const c = await pc.company(s.companyId); if (c?.issuePrefix) store.update(x => { x.companyPrefix = c.issuePrefix; }); } catch { /* 本体がまだ起きていない */ } }
      return [200, publicState(req)];
    },
    'GET /setup/api/i18n': async () => [200, DICT],
    'POST /setup/api/lang': async (req, b) => { if (store.get().owner && !authed(req)) return [401, { error: 'login_required' }]; store.update(s => { s.lang = pickLang(b.lang); const tz = validTimeZone(b.timeZone); if (tz) s.timeZone = tz; }); return [200, publicState(req)]; },
    'POST /setup/api/owner': async (req, b, res) => {
      if (store.get().owner) return [409, { error: 'owner_exists' }]; // 持ち主の登録は 1 回だけ
      const bad = passwordProblem(b.password); if (bad) return [400, { error: bad }];
      store.update(s => { s.owner = hashPassword(b.password); s.generation += 1; });
      res.setHeader('set-cookie', issueCookie(store.secret, store.get().generation)); return [200, { ok: true }];
    },
    'POST /setup/api/login': async (req, b, res) => {
      const now = Date.now(); while (fails.length && now - fails[0] > 600000) fails.shift();
      if (fails.length >= 10) return [429, { error: 'too_many' }];
      if (!checkPassword(String(b.password ?? ''), store.get().owner)) { fails.push(now); return [401, { error: 'password_wrong' }]; }
      res.setHeader('set-cookie', issueCookie(store.secret, store.get().generation)); return [200, { ok: true }];
    },
    'POST /setup/api/company': async (req, b) => {
      const name = text(b.name, 80); if (!name) return [400, { error: 'name_required' }];
      await once('company', async () => { if (!store.get().companyId) { const c = await pc.createCompany(name); store.update(s => { s.companyId = c.id; s.companyName = name; s.companyPrefix = c.issuePrefix || null; }); } }); // あれば使う・無ければ作る
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
  const OPEN = new Set(['GET /setup/api/state', 'GET /setup/api/i18n', 'POST /setup/api/lang', 'POST /setup/api/owner', 'POST /setup/api/login']); // cookie が無くても通す口（中で更に確かめる）

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
    const headers = { ...req.headers, host: target.host };
    const up = http.request({ host: target.hostname, port: target.port, method: req.method, path: req.url, headers }, r => { res.writeHead(r.statusCode, dropCors(r.headers)); r.pipe(res); r.on('error', () => res.destroy()); });
    up.on('error', () => { if (!res.headersSent) send(res, 502, DICT[pickLang(store.get().lang)].not_ready); else res.destroy(); });
    up.setTimeout(15 * 60 * 1000, () => up.destroy()); // 何も流れない接続は 15 分で切る（SSE は本体が keep-alive を流す）
    res.on('close', () => { if (!res.writableFinished) up.destroy(); }); // ブラウザが切ったら本体への接続も切る（SSE を読み込み直すたびに溜まらない）
    req.on('error', () => up.destroy()); res.on('error', () => up.destroy());
    req.pipe(up);
  }

  const server = http.createServer((req, res) => {
    handle(req, res).catch(() => { if (!res.headersSent) send(res, 500, { error: 'internal' }); else res.destroy(); }); // どんな要求でも process を落とさない
  });
  async function handle(req, res) {
    const host = req.headers.host;
    let url; try { url = new URL(req.url, 'http://x'); } catch { return send(res, 400, 'bad request'); } // 例: GET //[
    if (!hostAllowed(host)) return send(res, 403, 'forbidden host');
    if (!originAllowed({ method: req.method, host, origin: req.headers.origin })) return send(res, 403, 'forbidden origin');
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
      if (!OPEN.has(key) && !authed(req)) return send(res, 401, { error: 'login_required' });
      if (key === FOLDER_PATH && !isJson(req.headers['content-type'])) return send(res, 415, { error: 'json_only' }); // login の後・本文を読む前
      try { const body = req.method === 'POST' ? await readBody(req, key === FOLDER_PATH ? FOLDER_LIMITS.body : MAX_BODY) : {}; const [status, out] = await fn(req, body, res); return send(res, status, out); }
      catch (e) { return send(res, e.status && e.status < 500 ? e.status : 502, { error: e.message }); }
    }
    const s = store.get();
    if (!s.done || !authed(req)) return req.method === 'GET' ? send(res, 302, '', { location: '/setup/' }) : send(res, s.done ? 401 : 409, { error: s.done ? 'login_required' : 'setup_not_done' });
    const office = officeHome(req, s); if (office) return send(res, 302, '', { location: office });
    return proxy(req, res);
  }

  server.on('upgrade', (req, socket, head) => { // WebSocket も同じ守りを通してから本体へ
    socket.on('error', () => socket.destroy()); // upgrade の socket は http server の error の受け手から外れる。受け手が無いと EPIPE で process ごと落ちる
    const host = req.headers.host, s = store.get();
    const deny = code => { socket.end(`HTTP/1.1 ${code} Forbidden\r\nconnection: close\r\n\r\n`); socket.destroySoon?.(); };
    if (!hostAllowed(host) || !originAllowed({ method: 'GET', host, origin: req.headers.origin, upgrade: true })) return deny(403);
    if (!s.done || !authed(req)) return deny(401);
    const up = net.connect(Number(target.port), target.hostname, () => {
      const lines = [`${req.method} ${req.url} HTTP/1.1`, ...Object.entries({ ...req.headers, host: target.host }).flatMap(([k, v]) => (Array.isArray(v) ? v : [v]).map(x => `${k}: ${x}`))];
      up.write(`${lines.join('\r\n')}\r\n\r\n`); if (head?.length) up.write(head); up.pipe(socket); socket.pipe(up);
    });
    up.on('error', () => socket.destroy()); socket.on('error', () => up.destroy());
  });
  server.on('close', () => { codex.stop(); claude.stop(); for (const l of logins.values()) l.stop(); });
  return { server, store, codex, mail };
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
