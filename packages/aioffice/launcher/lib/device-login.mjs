// Codex・Claude 以外の AI の契約のつなぎ（device code と、ブラウザで許可する形）。表（ai-catalog.mjs）の connect の命令を PTY で起こし、
// 出た URL と code を画面に出し、CLI が 0 で終わったら「つないだ」にする。資格は CLI が自分の置き場（/data/aitools/<type>/home）に書く
// 範囲: docs/review/2026-11-17-wizard-ai-choice-scope.md の作り方 4「それ以外」（all-ai-v1 m04）
// 状態: idle → starting → waiting（URL と、device なら code を出す）→ done | failed | expired | cancelled
// - 1 つの AI に process は 1 本だけ。二度押しは今の URL と code を返す。やり直しは前の process が終わってから起こす
// - 子 process の出力は URL と code だけを取り、ほかは捨てる（launcher の記録にも流さない）
// - `script` の出力先は /dev/null（端末の記録の file を書かせない）。`-e` で CLI の終わりの番号を返させる
// - 渡す env は絞る（launcher の env を全部は渡さない）。ブラウザは開かせない
import { spawn } from 'node:child_process';
import fs from 'node:fs';

const ANSI = /\x1b\[[0-9;?]*[A-Za-z]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g;
// device code の形（実測: grok TEXA-9YKN・kimi E9AZ-0HG9・OpenAI T25Y-E4D4D）。URL の中の物と取り違えないよう、URL を抜いた文から拾う。
// URL と同じく後ろに空白が来た時だけ（PTY の出力が code の途中で分かれて届いた時に、切れた code を出さない・独立レビュー）
const CODE_RE = /\b[A-Z0-9]{4}-[A-Z0-9]{4,6}(?=\s)/;
const PASS_ENV = ['PATH', 'LANG', 'LC_ALL', 'TZ', 'NODE_EXTRA_CA_CERTS', 'SSL_CERT_FILE', 'HTTPS_PROXY', 'HTTP_PROXY', 'NO_PROXY', 'https_proxy', 'http_proxy', 'no_proxy'];
const TTL_MS = 15 * 60 * 1000;
const KILL_WAIT_MS = 5000;
const GIVE_UP_MS = 15000;

export const clean = text => String(text).replace(ANSI, ' ');
// timer で launcher の process を生かし続けない（server が動いている間は server が生かす・試験が終われる）
const later = (fn, ms) => { const t = setTimeout(fn, ms); t.unref?.(); return t; };
const esc = s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
// URL は表の url で始まる物だけ（別の URL の中に埋まった物は拾わない）。後ろに空白・ESC・BEL が来た時だけ一致にする（出力が途中で分かれて届いても、切れた URL を拾わない）
export function parseLogin(text, { url, code: wantCode }) {
  const raw = String(text);
  const t = clean(raw);
  const m = t.match(new RegExp(`(?<=^|[\\s"'<>(])${esc(url)}[^\\s"'<>]*(?=\\s)`)); // 前が行の初めか区切りの時だけ（別の URL の途中の物を拾わない）
  const u = m ? m[0] : null;
  if (!wantCode) return { url: u, code: null };
  const c = t.replace(/https:\/\/\S+/g, ' ').match(CODE_RE);
  return { url: u, code: c ? c[0] : null };
}

// PTY を作る `script` に渡す命令。幅を広げ（URL を折り返させない・cursor は 192 字）、CLI を起こす
export function loginArgs(bin, args) {
  const q = s => `'${String(s).replace(/'/g, `'\\''`)}'`;
  return ['-qefc', `stty cols 1000 rows 50 2>/dev/null; exec ${[bin, ...args].map(q).join(' ')}`, '/dev/null'];
}

export function createDeviceLogin({ type, bin, args, url, wantCode, home, homeEnv, scriptBin = 'script', ttlMs = TTL_MS, now = () => Date.now(), spawnFn = spawn, killWaitMs = KILL_WAIT_MS, giveUpMs = GIVE_UP_MS, isConnected = () => false, onDone = () => {}, mkdir = p => fs.mkdirSync(p, { recursive: true, mode: 0o700 }) }) {
  let st = { state: isConnected() ? 'done' : 'idle', url: null, code: null, expiresAt: null, error: null };
  let child = null, timer = null, gen = 0;
  let dying = Promise.resolve(); // 止めた process が本当に終わるまで。次はこれを待ってから起こす（同じ置き場で 2 本動かさない）

  const killAndWait = c => new Promise(resolve => {
    const t1 = later(() => { try { c.kill('SIGKILL'); } catch { /* 知らせを待つ */ } }, killWaitMs);
    c.once('exit', () => { clearTimeout(t1); resolve(); });
    try { c.kill('SIGTERM'); } catch { /* 知らせを待つ */ }
  });
  const stop = () => {
    clearTimeout(timer); timer = null;
    if (child) { const c = child; child = null; const prev = dying; dying = Promise.all([prev, killAndWait(c)]).then(() => {}); }
  };
  const env = () => ({
    ...Object.fromEntries(PASS_ENV.filter(k => process.env[k]).map(k => [k, process.env[k]])),
    HOME: home, ...(homeEnv && homeEnv !== 'HOME' ? { [homeEnv]: home } : {}),
    COLUMNS: '1000', LINES: '50', TERM: 'xterm-256color', NO_COLOR: '1', BROWSER: 'none', NO_OPEN_BROWSER: '1',
  });

  function spawnNow(my) {
    if (my !== gen) return;
    let buf = '';
    let me;
    try { me = spawnFn(scriptBin, loginArgs(bin, args), { cwd: home, env: env(), stdio: ['pipe', 'pipe', 'pipe'] }); }
    catch (e) { st = { ...st, state: 'failed', error: e?.code === 'ENOENT' ? 'script_missing' : 'spawn_failed' }; return; }
    child = me;
    const onData = d => {
      if (my !== gen) return;
      buf = (buf + d.toString()).slice(-16000);
      if (st.state !== 'starting') return;
      const p = parseLogin(buf, { url, code: wantCode });
      if (p.url && (!wantCode || p.code)) st = { ...st, state: 'waiting', url: p.url, code: p.code, expiresAt: now() + ttlMs };
    };
    me.stdout?.on('data', onData); me.stderr?.on('data', onData);
    me.on('error', e => { if (child === me) child = null; if (my !== gen) return; clearTimeout(timer); timer = null; st = { ...st, state: 'failed', error: e?.code === 'ENOENT' ? 'script_missing' : 'spawn_failed' }; });
    me.on('exit', codeNum => {
      if (child === me) child = null;
      if (my !== gen) return; clearTimeout(timer); timer = null;
      if (['cancelled', 'expired', 'failed'].includes(st.state)) return;
      // done は URL を出して待った後に 0 で終わった時だけ。URL を出す前の 0 は、命令の形が変わった等で「つないでいないのに つないだ」と
      // 出さないよう失敗にする（つないだ後は状態の file で done を持つので、つなぎ直しの時にしか起きない）
      if (codeNum === 0 && st.state === 'waiting') {
        st = { state: 'done', url: null, code: null, expiresAt: null, error: null };
        try { onDone(type); } catch { /* 知らせの失敗でつなぎの結果を変えない */ }
        return;
      }
      st = { ...st, state: 'failed', url: null, code: null, error: st.state === 'waiting' ? 'login_failed' : 'no_url' };
    });
    timer = later(() => { if (my !== gen) return; st = { ...st, state: 'expired', url: null, code: null }; stop(); }, ttlMs);
  }

  function start() {
    if (st.state === 'waiting' || st.state === 'starting') return view(); // 二度押し: 今の URL と code を返す
    stop();
    const my = ++gen;
    try { mkdir(home); } catch { st = { state: 'failed', url: null, code: null, expiresAt: null, error: 'home_failed' }; return view(); }
    st = { state: 'starting', url: null, code: null, expiresAt: null, error: null };
    const giveUp = later(() => { if (my === gen && st.state === 'starting' && !child) st = { ...st, state: 'failed', error: 'stop_timeout' }; }, giveUpMs);
    dying.then(() => { clearTimeout(giveUp); if (my === gen && st.state === 'starting') spawnNow(my); });
    return view();
  }
  function cancel() { if (st.state === 'done') return view(); gen++; stop(); st = { state: 'cancelled', url: null, code: null, expiresAt: null, error: null }; return view(); }
  function view() { return { type, state: st.state, url: st.url, code: st.code, error: st.error, remainingMs: st.expiresAt ? Math.max(0, st.expiresAt - now()) : null }; }
  return { start, cancel, view, stop };
}
