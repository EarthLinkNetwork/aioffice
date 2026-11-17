// Claude の契約のつなぎ。Anthropic 公式の `claude setup-token` を PTY で回し、利用者が貼った code を渡し、
// 出た token を Paperclip の会社の秘密に入れる（Paperclip の画面の Connect と同じ流れ。sandbox の提供元が要らない形）
// 範囲: docs/review/2026-11-17-wizard-ai-choice-scope.md の作り方 4・保証 4
// 状態: idle → starting → waiting（URL を画面に出し code を待つ）→ submitting（code を渡した）→ done | failed | expired | cancelled
// - token は状態・応答・ログに載せない。受け取ったら saveToken に渡すだけで、手元の変数も捨てる
// - 使い捨ての dir を cwd と HOME にし、`script` の出力先は /dev/null（./typescript に端末の出力を書かせない）。終わったら dir を消す
// - 端末の幅を広げ、URL と token が折り返されないようにする
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const ANSI = /\x1b\[[0-9;?]*[A-Za-z]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g;
// 後ろに空白か ESC か BEL が来た時だけ一致にする（PTY の出力が途中で分かれて届いても、切れた URL や token を拾わない）
const URL_RE = /https:\/\/(?:claude\.com|claude\.ai)\/[^\s"'<>\x1b\x07]*oauth\/authorize\?[^\s"'<>\x1b\x07]+(?=[\s\x1b\x07])/;
const TOKEN_RE = /\bsk-ant-oat\d{2}-[A-Za-z0-9_-]{20,}(?=[\s\x1b\x07])/;
const ACTIVE = ['starting', 'waiting', 'submitting', 'saving'];
// 子 process に渡す env（launcher の env を全部は渡さない）
const PASS_ENV = ['PATH', 'LANG', 'LC_ALL', 'TZ', 'NODE_EXTRA_CA_CERTS', 'SSL_CERT_FILE', 'HTTPS_PROXY', 'HTTP_PROXY', 'NO_PROXY', 'https_proxy', 'http_proxy', 'no_proxy'];
const CODE_RE = /^[A-Za-z0-9_#.-]{8,512}$/;
const TTL_MS = 15 * 60 * 1000;
// code を渡してから答え（token か断り）が無いまま待つ上限
const SUBMIT_WAIT_MS = 90 * 1000;
// claude が code を断った時の文（空白を抜いて照らす。2026-11-18 に arm64 の container で実測:
// 「OAuth error: That code wasn't accepted. … Press Enter to retry.」を出して入力待ちに戻り、wizard が「確かめています」のまま止まった）
const REJECT_RE = /OAutherror|wasn'?taccepted|PressEntertoretry/i;
export const parseReject = text => REJECT_RE.test(clean(text).replace(/\s+/g, ''));
const KILL_WAIT_MS = 5000;

export const clean = text => String(text).replace(ANSI, '');
export const parseUrl = text => (String(text).match(/\x1b\]8;;/) ? clean(String(text).replace(/\x1b\]8;;[^\x07\x1b]*(?:\x07|\x1b\\)/g, ' ')) : clean(text)).match(URL_RE)?.[0] || null;
// 色の印のすぐ後に文字が続いても token に混ぜないよう、印は空白に置き換えてから照らす
export const parseToken = text => String(text).replace(ANSI, ' ').match(TOKEN_RE)?.[0] || null;

// PTY を作る `script` に渡す命令。幅を広げてから setup-token を起こし、記録の file は /dev/null
export function setupTokenArgs(claudeBin) {
  const q = s => `'${String(s).replace(/'/g, `'\\''`)}'`;
  return ['-qfc', `stty cols 1000 rows 50 2>/dev/null; exec ${q(claudeBin)} setup-token`, '/dev/null'];
}

// 止まった理由の手がかり（token・URL・code の形の物は伏せる）。利用者の画面には出さず、launcher の記録にだけ出す
export const tailForLog = text => clean(text).replace(/sk-ant-[A-Za-z0-9_-]+/g, '<token>').replace(/https:\/\/\S+/g, '<url>').replace(/[A-Za-z0-9_#.-]{24,}/g, '<long>').replace(/\s+/g, ' ').trim().slice(-400);

export function createClaudeLogin({ claudeBin, saveToken, scriptBin = 'script', log = m => console.error(`[claude-login] ${m}`), exitGraceMs = 1000, enterDelayMs = 400, ttlMs = TTL_MS, submitWaitMs = SUBMIT_WAIT_MS, now = () => Date.now(), spawnFn = spawn, tmpRoot = os.tmpdir(), hasToken = () => false, killWaitMs = KILL_WAIT_MS } = {}) {
  let st = { state: hasToken() ? 'done' : 'idle', url: null, expiresAt: null, error: null };
  let child = null, timer = null, submitTimer = null, gen = 0, work = null, sinceSubmit = '';
  // 前に落ちた launcher が残した使い捨ての dir を消す（中に token が残っているかもしれない）
  try { for (const n of fs.readdirSync(tmpRoot)) if (n.startsWith('claude-login-')) fs.rmSync(path.join(tmpRoot, n), { recursive: true, force: true }); } catch { /* 読めなければそのまま */ }

  const cleanup = () => { if (work) { try { fs.rmSync(work, { recursive: true, force: true }); } catch { /* 消せなくても次で作り直す */ } work = null; } };
  const kill = c => { const t = setTimeout(() => { try { c.kill('SIGKILL'); } catch { /* 終わっている */ } }, killWaitMs); c.once('exit', () => clearTimeout(t)); try { c.kill('SIGTERM'); } catch { /* 終わっている */ } };
  const stop = () => { clearTimeout(timer); timer = null; clearTimeout(submitTimer); submitTimer = null; if (child) { const c = child; child = null; kill(c); } cleanup(); };
  let lastOut = '';
  const fail = (my, error) => { if (my !== gen) return; try { log(`failed: ${error} | ${tailForLog(lastOut)}`); } catch { /* 記録できなくても止める */ } stop(); st = { state: 'failed', url: null, expiresAt: null, error }; };

  function start() {
    if (ACTIVE.includes(st.state)) return view();
    stop();
    const my = ++gen;
    work = fs.mkdtempSync(path.join(tmpRoot, 'claude-login-'));
    fs.chmodSync(work, 0o700);
    st = { state: 'starting', url: null, expiresAt: null, error: null };
    let buf = '';
    let me;
    try {
      me = spawnFn(scriptBin, setupTokenArgs(claudeBin), { cwd: work, env: { ...Object.fromEntries(PASS_ENV.filter(k => process.env[k]).map(k => [k, process.env[k]])), HOME: work, COLUMNS: '1000', LINES: '50', TERM: 'xterm-256color', NO_COLOR: '1', BROWSER: 'none' }, stdio: ['pipe', 'pipe', 'pipe'] });
    } catch (e) { fail(my, e?.code === 'ENOENT' ? 'script_missing' : 'spawn_failed'); return view(); }
    child = me;
    const onData = d => {
      if (my !== gen) return;
      buf = (buf + d.toString()).slice(-16000);
      lastOut = buf;
      if (st.state === 'starting') {
        const url = parseUrl(buf);
        if (url) st = { ...st, state: 'waiting', url, expiresAt: now() + ttlMs };
      }
      if (st.state === 'submitting') {
        sinceSubmit = (sinceSubmit + d.toString()).slice(-16000);
        // 断られたら止める（claude は入力待ちに戻るので、ここで止めないと待ち続ける）。code を送った後の出力だけを見る
        if (parseReject(sinceSubmit)) { fail(my, 'code_rejected'); return; }
        takeToken();
      }
    };
    // token が出ていれば秘密に入れる（データの知らせからも、process の終わりからも呼ぶ）
    const takeToken = () => {
      if (my !== gen || st.state !== 'submitting') return false;
      const token = parseToken(buf + '\n'); // 終わりの直前に出た token は後ろに改行が来ないことがある
      if (!token) return false;
      clearTimeout(submitTimer); submitTimer = null;
      buf = ''; lastOut = '';
      st = { ...st, state: 'saving' };
      Promise.resolve().then(() => saveToken(token)).then(
        () => { if (my !== gen) return; stop(); st = { state: 'done', url: null, expiresAt: null, error: null }; },
        e => { try { log(`save_failed: ${e?.status || ''} ${String(e?.message || '').replace(/sk-ant-[A-Za-z0-9_-]+/g, '<token>').slice(0, 200)}`); } catch { /* 記録できなくても止める */ } fail(my, 'save_failed'); });
      return true;
    };
    me.stdout?.on('data', onData); me.stderr?.on('data', onData);
    me.on('error', e => fail(my, e?.code === 'ENOENT' ? 'script_missing' : 'spawn_failed'));
    // claude は token を出してすぐ終わる。exit の知らせは最後の出力より先に来ることがあるので、出力が閉じるのを待ってから決める
    // （2026-11-18 利用者の実機で「つなげませんでした」になった件の候補。close か猶予の後に token を探し直す）
    let ended = false;
    const finish = () => {
      if (ended) return; ended = true;
      if (child === me) child = null;
      if (my !== gen) return;
      if (takeToken()) return;
      if (['done', 'saving', 'cancelled', 'expired', 'failed'].includes(st.state)) return;
      fail(my, st.state === 'submitting' ? 'login_failed' : 'no_url');
    };
    me.on('close', finish);
    me.on('exit', () => { setTimeout(finish, exitGraceMs); });
    timer = setTimeout(() => { if (my !== gen) return; stop(); st = { ...st, state: 'expired', url: null }; }, ttlMs);
    return view();
  }

  // 利用者がブラウザで得た code を渡す。形の違う物は渡さない
  function submit(code) {
    const c = String(code ?? '').trim();
    if (st.state !== 'waiting' || !child) return { ...view(), error: 'not_waiting' };
    if (!CODE_RE.test(c)) return { ...view(), error: 'bad_code' };
    st = { ...st, state: 'submitting' };
    sinceSubmit = '';
    const my = gen;
    submitTimer = setTimeout(() => { if (my === gen && st.state === 'submitting') fail(my, 'login_timeout'); }, submitWaitMs);
    // code と Enter は分けて送る。まとめて書くと、長い code（本物は 90 文字ほど）を claude が貼り付けと受け取り、Enter が送信として効かない
    // （2026-11-18 に arm64 の container で実測: 130 文字をまとめて送ると無反応・分けると確かめに進む。利用者の実機は login_timeout で止まった）
    try { child.stdin.write(c); } catch { fail(gen, 'write_failed'); return view(); }
    const me = child;
    setTimeout(() => { if (my !== gen || st.state !== 'submitting' || child !== me) return; try { me.stdin.write('\r'); } catch { fail(my, 'write_failed'); } }, enterDelayMs);
    return view();
  }

  function cancel() { if (st.state === 'done' || st.state === 'saving') return view(); gen++; stop(); st = { state: 'cancelled', url: null, expiresAt: null, error: null }; return view(); }
  function view() { return { state: st.state === 'saving' ? 'submitting' : st.state, url: st.url, error: st.error, remainingMs: st.expiresAt ? Math.max(0, st.expiresAt - now()) : null }; }
  return { start, submit, cancel, view, stop };
}
