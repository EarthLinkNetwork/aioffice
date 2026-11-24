// 図書室の意味の近さの検索に使う Ollama を、container の中の loopback だけで動かし、落ちたら起こし直す
// 範囲: 開発元の記録 docs/review/2026-11-17-library-embedding-scope.md（作り方 3〜5）
// - nice 10 で起こす（本体と画面の応答を先にする）。model は image に焼き込んだ物だけを読み、網には取りに行かない
// - 見つからない・AIOFFICE_LIBRARY_SEMANTIC=off の時は起こさない（図書室は語だけの検索で動く）
import { spawn as nodeSpawn } from 'node:child_process';
import fs from 'node:fs';

// 起動係の環境変数は渡さない（本体や wizard の値を Ollama に見せない）。要る物だけ
export function ollamaEnv(base, { modelsDir, port = 11434 } = {}) {
  return {
    PATH: base.PATH || '/usr/local/bin:/usr/bin:/bin',
    HOME: base.HOME || '/home/node',
    ...(base.TZ ? { TZ: base.TZ } : {}),
    OLLAMA_HOST: `127.0.0.1:${port}`,
    OLLAMA_MODELS: modelsDir,
    OLLAMA_KEEP_ALIVE: '-1',       // model を降ろさない（読み直しに数秒かかる）
    OLLAMA_NOPRUNE: '1',           // 焼き込んだ model を消さない
    OLLAMA_NUM_PARALLEL: '1',      // 同時に 1 本（問いは今の 1 行の後ろに並ぶ）
    OLLAMA_MAX_LOADED_MODELS: '1',
    OLLAMA_NO_CLOUD: '1',
  };
}

export function createOllama({ bin = '/opt/aioffice/ollama/bin/ollama', modelsDir = '/opt/aioffice/models', env = process.env, spawn = nodeSpawn, exists = p => fs.existsSync(p), setTimer = setTimeout, clearTimer = clearTimeout, now = Date.now, log = console.log } = {}) {
  const st = { enabled: env.AIOFFICE_LIBRARY_SEMANTIC !== 'off' && exists(bin), child: null, stopping: false, delay: 2000, restarts: 0, timer: null, waiters: [] };
  function start() {
    if (!st.enabled || st.stopping) return;
    const startedAt = now();
    const c = spawn('nice', ['-n', '10', bin, 'serve'], { env: ollamaEnv(env, { modelsDir }), stdio: ['ignore', 'ignore', 'inherit'] });
    st.child = c;
    log(`aioffice: ollama serve (pid ${c.pid})`);
    // spawn の失敗（EACCES・EAGAIN）で起動係ごと落とさない。exit が来ない時もここから起こし直す
    c.on('error', e => {
      log(`aioffice: ollama spawn failed: ${e?.code || e?.message || e}`);
      if (st.child === c) { st.child = null; const w = st.waiters.splice(0); w.forEach(f => f()); if (!st.stopping) { st.timer = setTimer(start, st.delay); st.delay = Math.min(st.delay * 2, 60_000); } }
    });
    c.on('exit', (code, sig) => {
      if (st.child !== c) return;
      st.child = null;
      const w = st.waiters.splice(0); w.forEach(f => f());
      if (st.stopping) return;
      if (now() - startedAt > 60_000) st.delay = 2000;
      st.restarts++;
      log(`aioffice: ollama exited (${code ?? sig}); restarting in ${st.delay / 1000}s`);
      st.timer = setTimer(start, st.delay); st.delay = Math.min(st.delay * 2, 60_000);
    });
  }
  return {
    st, start,
    enabled: () => st.enabled,
    // SIGTERM を送り、終わるのを待つ（waitMs を過ぎたら SIGKILL）。範囲 作り方 6
    stop(waitMs = 10_000) {
      st.stopping = true; clearTimer(st.timer);
      const c = st.child; if (!c) return Promise.resolve();
      return new Promise(res => {
        const k = setTimer(() => { try { c.kill('SIGKILL'); } catch {} res(); }, waitMs);
        st.waiters.push(() => { clearTimer(k); res(); });
        c.kill('SIGTERM');
      });
    },
  };
}
