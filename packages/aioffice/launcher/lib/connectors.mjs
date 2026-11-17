// wizard でつないだ AI の連携（Gmail・Slack）の有無を読む（範囲 docs/review/2026-11-22-notify-via-ai-connectors-scope.md の作り方 1・2・10・開発元の記録）
// - v1 は Codex だけ。`codex plugin list` を共有の CODEX_HOME で 1 本だけ回し、出力は 1 行ずつ許し札（連携の名前 → 決まった状態の語）に照らして、ほかは捨てる
// - 生の出力・アカウント・URL は返さず、残さない。失敗は決まった印（`codex_missing`・`timeout`・`failed`）だけ。config.toml と auth.json は読まない
// - 結果は「目安」。担当の run の codex-home には連携が渡らないことがあるので、「この連携で届けます」は本物の 1 通の後にだけ出す（作り方 2）
// - 共有の home で token の更新を重ねないため（r1 P3-1・PR のレビュー B-2）: 一覧は欄を開いた時だけ・成功は ttl の間覚える・同時に 1 本・
//   読み直し（fresh）も前の実行から minGapMs は前の結果を返す・サインインの手続きの最中は回さない・止める時は SIGTERM の後に猶予を置いて SIGKILL
import { spawn } from 'node:child_process';

export const CONNECTORS = Object.freeze(['gmail', 'slack']);
const STATES = Object.freeze({ 'installed, enabled': 'enabled', 'installed, disabled': 'disabled', 'not installed': 'missing' });
const STATE_WORDS = '(installed, enabled|installed, disabled|not installed)';
const LINE_RE = new RegExp(`^(gmail|slack)@[A-Za-z0-9._-]+\\s+${STATE_WORDS}(?:\\s|$)`);
const ANY_RE = new RegExp(`^[A-Za-z0-9._-]+@[A-Za-z0-9._-]+\\s+${STATE_WORDS}(?:\\s|$)`); // 一覧の行の形（名前は残さない・数えるだけ）
export const TTL_MS = 10 * 60 * 1000;
export const FAIL_TTL_MS = 30 * 1000;
export const MIN_GAP_MS = 30 * 1000;
export const TIMEOUT_MS = 30 * 1000;
export const KILL_WAIT_MS = 5 * 1000;

// 出力から連携ごとの状態だけを取り出す。同じ連携が何行あっても「enabled」が 1 つあれば enabled（手元と remote の 2 つの marketplace に同じ名前が出る）
export function parsePluginList(text) {
  const out = Object.fromEntries(CONNECTORS.map(c => [c, 'missing']));
  let listed = 0;
  for (const raw of String(text || '').split(/\r?\n/)) {
    const line = raw.trim();
    if (ANY_RE.test(line)) listed++;
    const m = LINE_RE.exec(line);
    if (!m) continue;
    const st = STATES[m[2]];
    if (st === 'enabled' || out[m[1]] === 'missing') out[m[1]] = st;
  }
  // サインインの前は marketplace の一覧が空（「No marketplace plugins found.」）。連携が無いのではなく、分からない
  if (!listed) return Object.fromEntries(CONNECTORS.map(c => [c, 'unknown']));
  return out;
}

export function createConnectors({ codexBin = 'codex', codexHome, spawnFn = spawn, now = () => Date.now(), ttlMs = TTL_MS, failTtlMs = FAIL_TTL_MS, minGapMs = MIN_GAP_MS, timeoutMs = TIMEOUT_MS, killWaitMs = KILL_WAIT_MS, hasCodex = () => true, loginBusy = () => false } = {}) {
  let cached = null, running = null, lastRunAt = -Infinity;
  let prevClosed = Promise.resolve(); // 前の子が本当に終わるまで次を起こさない（時間切れの直後に共有の home で 2 本が重ならない・再レビュー P3-a）
  const run = () => new Promise(resolve => {
    let buf = '', done = false, child = null, killer = null;
    const finish = r => { if (done) return; done = true; clearTimeout(timer); resolve(r); };
    const timer = setTimeout(() => {
      finish({ error: 'timeout' });
      try { child?.kill('SIGTERM'); } catch { /* 下の SIGKILL に任せる */ }
      killer = setTimeout(() => { try { child?.kill('SIGKILL'); } catch { /* もう終わっている */ } }, killWaitMs);
      child?.once?.('close', () => clearTimeout(killer));
    }, timeoutMs);
    try {
      child = spawnFn(codexBin, ['plugin', 'list'], { env: { ...process.env, CODEX_HOME: codexHome, NO_COLOR: '1' }, stdio: ['ignore', 'pipe', 'ignore'] });
    } catch (e) { return finish({ error: e?.code === 'ENOENT' ? 'codex_missing' : 'failed' }); }
    prevClosed = new Promise(r => { const t = setTimeout(r, timeoutMs + killWaitMs + 1000); child.once('close', () => { clearTimeout(t); r(); }); child.once('error', () => { clearTimeout(t); r(); }); });
    child.stdout.on('data', d => { buf = (buf + d.toString()).slice(-200000); });
    child.on('error', e => finish({ error: e?.code === 'ENOENT' ? 'codex_missing' : 'failed' }));
    // 'exit' は stdout を読み終える前に来ることがある。'close'（stdio が閉じた後）で終える（PR のレビュー B-1）
    child.on('close', code => finish(code === 0 ? { states: parsePluginList(buf) } : { error: 'failed' }));
  });
  const reset = () => { cached = null; };
  async function get({ fresh = false } = {}) {
    if (!hasCodex()) { cached = null; return { codex: { state: 'not_connected', connectors: null, checkedAt: null }, claude: { state: 'unsupported' } }; }
    const t = now();
    if (cached) {
      const age = t - cached.at, ok = cached.value.codex.state === 'ok';
      if (age < (ok ? ttlMs : failTtlMs) && (!fresh || t - lastRunAt < minGapMs)) return cached.value;
    }
    if (loginBusy()) return { codex: { state: 'busy', connectors: null, checkedAt: null }, claude: { state: 'unsupported' } };
    if (!running) {
      lastRunAt = t;
      running = prevClosed.then(run).then(r => {
        const at = now();
        const value = {
          codex: r.error ? { state: 'error', error: r.error, connectors: null, checkedAt: new Date(at).toISOString() }
            : { state: 'ok', connectors: r.states, checkedAt: new Date(at).toISOString() },
          claude: { state: 'unsupported' }, // v1 は Codex だけ（r1 P1-4）
        };
        cached = { at, value };
        return value;
      }).finally(() => { running = null; });
    }
    return running;
  }
  return { get, reset };
}
