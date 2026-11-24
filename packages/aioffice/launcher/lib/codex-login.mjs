// AI の契約のつなぎ（Codex の device login）を 1 本だけの状態機械として持つ
// 待機 idle → code 発行 waiting（URL と code を画面に出す）→ 成功 done／期限切れ expired／失敗 failed／取り消し cancelled
// - 二度押しには、動いている process の URL と code をそのまま返す（2 本目を起こさない）
// - 「やり直す」は前の process を止め、終わったのを確かめてから新しく始める
// - 子 process の出力は URL と code だけを取り、ほかの行は捨てる（docker logs に流さない）
// - ログインは共有の CODEX_HOME 1 か所に置く。本体は各担当の codex-home へ auth.json を symlink で配る（段 2 の実測 8）
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const ANSI = /\x1b\[[0-9;]*[A-Za-z]/g;
const URL_RE = /https:\/\/auth\.openai\.com\/\S+/;
const CODE_RE = /\b[A-Z0-9]{4}-[A-Z0-9]{4,6}\b/;
const TTL_MS = 15 * 60 * 1000;
const KILL_WAIT_MS = 5000;
const GIVE_UP_MS = 15000;

export function parseDeviceOutput(text) {
  const t = String(text).replace(ANSI, '');
  return { url: t.match(URL_RE)?.[0] || null, code: t.match(CODE_RE)?.[0] || null };
}

export function createCodexLogin({ codexBin = 'codex', codexHome, ttlMs = TTL_MS, now = () => Date.now(), spawnFn = spawn, killWaitMs = KILL_WAIT_MS, giveUpMs = GIVE_UP_MS, onDone = () => {} } = {}) {
  let st = { state: 'idle', url: null, code: null, expiresAt: null, error: null };
  let child = null, timer = null, gen = 0;
  let dying = Promise.resolve(); // 止めた process が本当に終わるまでの Promise。次の process はこれを待ってから起こす（同じ CODEX_HOME で 2 本動かさない）
  const hasAuth = () => { try { return fs.statSync(path.join(codexHome, 'auth.json')).size > 0; } catch { return false; } };
  if (hasAuth()) st = { ...st, state: 'done' };

  // SIGTERM を送り、exit の知らせが来た時だけ解く（時間切れや送信の失敗を「終わった」と見なさない）。5 秒で終わらなければ SIGKILL
  const killAndWait = c => new Promise(resolve => {
    const t1 = setTimeout(() => { try { c.kill('SIGKILL'); } catch { /* 知らせを待つ */ } }, killWaitMs);
    c.once('exit', () => { clearTimeout(t1); resolve(); });
    try { c.kill('SIGTERM'); } catch { /* 知らせを待つ */ }
  });
  const stop = () => {
    clearTimeout(timer); timer = null;
    if (child) { const c = child; child = null; const prev = dying; dying = Promise.all([prev, killAndWait(c)]).then(() => {}); }
  };

  function spawnNow(my) {
    if (my !== gen) return; // 待っている間に取り消された・やり直された
    let buf = '';
    child = spawnFn(codexBin, ['login', '--device-auth'], { env: { ...process.env, CODEX_HOME: codexHome, NO_COLOR: '1' }, stdio: ['ignore', 'pipe', 'pipe'] });
    const me = child;
    const onData = d => {
      if (my !== gen) return;
      buf = (buf + d.toString()).slice(-8000);
      const { url, code } = parseDeviceOutput(buf);
      if (url && code && st.state === 'starting') st = { ...st, state: 'waiting', url, code, expiresAt: now() + ttlMs };
    };
    me.stdout.on('data', onData); me.stderr.on('data', onData);
    me.on('error', e => { if (child === me) child = null; if (my !== gen) return; clearTimeout(timer); timer = null; st = { ...st, state: 'failed', error: e.code === 'ENOENT' ? 'codex_missing' : 'spawn_failed' }; }); // 失敗を 15 分後の期限切れで上書きしない
    me.on('exit', codeNum => {
      if (child === me) child = null;
      if (my !== gen) return; clearTimeout(timer);
      if (st.state === 'cancelled' || st.state === 'expired') return;
      st = codeNum === 0 && hasAuth() ? { state: 'done', url: null, code: null, expiresAt: null, error: null } : { ...st, state: 'failed', error: 'login_failed' };
      if (st.state === 'done') { try { onDone(); } catch { /* 知らせの失敗でログインの結果を変えない */ } } // つないだ AI を起動係が「使う AI」に足す（範囲 2026-11-18 F2）
    });
    timer = setTimeout(() => { if (my !== gen) return; st = { ...st, state: 'expired' }; stop(); }, ttlMs);
  }

  function start() {
    if (st.state === 'waiting' || st.state === 'starting') return view(); // 二度押し: 今の code を返す
    stop();
    const my = ++gen;
    fs.mkdirSync(codexHome, { recursive: true, mode: 0o700 });
    st = { state: 'starting', url: null, code: null, expiresAt: null, error: null };
    // 前の process の終わりの知らせが長く来なければ、次を起こさず失敗にする（2 本目を起こさない。押し直すと同じ終わりを待つ）
    const giveUp = setTimeout(() => { if (my === gen && st.state === 'starting' && !child) st = { ...st, state: 'failed', error: 'stop_timeout' }; }, giveUpMs);
    dying.then(() => { clearTimeout(giveUp); if (my === gen && st.state === 'starting') spawnNow(my); }).catch(e => { // 前の process が終わってから起こす。spawn がその場で投げても（E2BIG・ENOMEM など）process を落とさない
      if (my !== gen) return; child = null; clearTimeout(timer); timer = null;
      st = { ...st, state: 'failed', error: e?.code === 'ENOENT' ? 'codex_missing' : 'spawn_failed' };
    });
    return view();
  }

  function cancel() { if (st.state === 'done') return view(); gen++; stop(); st = { state: 'cancelled', url: null, code: null, expiresAt: null, error: null }; return view(); }
  function restart() { cancel(); return start(); }
  function view() { return { ...st, remainingMs: st.expiresAt ? Math.max(0, st.expiresAt - now()) : null, running: !!child }; }
  // つないであるか: ログインの成功か、資格の file（auth.json）が置いてあるか（起動の後に置かれた物も読む）
  const connected = () => st.state === 'done' || hasAuth();
  return { start, cancel, restart, view, stop, connected };
}
