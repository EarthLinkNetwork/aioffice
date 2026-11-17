// wizard で選んだ AI の CLI を、選んだ時に /data/aitools/<type> へ入れる（image には入れない）
// 範囲: docs/review/2026-11-17-wizard-ai-choice-scope.md の作り方 2・3、保証 3・6
// 状態は AI ごとに pending → running → done | failed。同じ AI を 2 回同時には入れない
// 入れ終わったら CLI を `--version` で実際に動かして確かめる。npm は optional の依存（platform ごとの本体）の取得に失敗しても
// 成功で終わることがある（2026-11-17 に arm64 の image で Claude Code の linux-arm64 が入らず動かなかった）。動かなければ 1 回だけ入れ直す。
// 確かめが通った時だけ置き場に印（VERIFIED）を書き、「入っている」はこの印で決める（コマンドの file があるだけでは done にしない）
import { spawn } from 'node:child_process';
import { mkdirSync, existsSync, writeFileSync } from 'node:fs';
import { AI_ROOT, aiBin, aiHome, catalogEntry } from './ai-catalog.mjs';

// 入れる命令を作る（試験で中身を固定する）。npm は版を固定した package、script は公式の URL を HOME と入れる先を volume に向けて流す
export function installCommand(type) {
  const e = catalogEntry(type);
  if (!e || !e.include) throw new Error(`not selectable: ${type}`);
  const dir = `${AI_ROOT}/${type}`;
  const home = aiHome(type);
  if (e.install.kind === 'image') return null;
  if (e.install.kind === 'npm') {
    return { cmd: 'npm', args: ['install', '--prefix', dir, '--no-fund', '--no-audit', '--omit=dev', e.install.spec], env: { HOME: home, npm_config_cache: `${dir}/.npm` } };
  }
  if (e.install.kind === 'script') {
    // 公式の install の script を、HOME を volume に向けて流す（script は HOME の下に入れる）
    return { cmd: 'sh', args: ['-c', 'curl -fsSL "$AI_INSTALL_URL" | bash'], env: { HOME: home, AI_INSTALL_URL: e.install.url } };
  }
  throw new Error(`unknown install kind: ${e.install.kind}`);
}

export const VERIFIED = 'VERIFIED';
export const verifiedPath = type => `${AI_ROOT}/${type}/${VERIFIED}`;

export function createAiInstaller({ spawnFn = spawn, exists = existsSync, mkdir = p => mkdirSync(p, { recursive: true }), mark = (p, v) => writeFileSync(p, v), maxLog = 4000, retries = 1 } = {}) {
  const jobs = new Map();
  const installed = type => {
    const e = catalogEntry(type);
    if (!e || !e.include) return false;
    return e.install.kind === 'image' ? true : exists(verifiedPath(type));
  };
  const view = type => {
    const j = jobs.get(type);
    if (j) return { type, status: j.status, error: j.error || null };
    return { type, status: installed(type) ? 'done' : 'pending', error: null };
  };
  const start = type => {
    const e = catalogEntry(type);
    if (!e || !e.include) return { type, status: 'failed', error: 'not_selectable' };
    const cur = view(type);
    if (cur.status === 'running' || cur.status === 'done') return cur;
    const c = installCommand(type);
    mkdir(aiHome(type));
    const job = { status: 'running', log: '' };
    jobs.set(type, job);
    const env = { ...process.env, ...c.env, NO_COLOR: '1' };
    // 出力は失敗の理由を見るためだけに末尾を残す（画面には出さない）
    const keep = d => { job.log = (job.log + d).slice(-maxLog); };
    const run = (cmd, args, done) => {
      let child;
      try { child = spawnFn(cmd, args, { env, stdio: ['ignore', 'pipe', 'pipe'] }); } catch { done(-1, 'spawn_failed'); return; }
      let out = '';
      child.stdout?.on('data', d => { out += d; keep(d); });
      child.stderr?.on('data', keep);
      let ended = false;
      child.on('error', () => { if (!ended) { ended = true; done(-1, 'spawn_failed'); } });
      child.on('close', code => { if (!ended) { ended = true; done(code, null, out); } });
    };
    const fail = error => Object.assign(job, { status: 'failed', error });
    const attempt = left => run(c.cmd, c.args, (code, err) => {
      if (job.status !== 'running') return;
      if (err) return fail(err);
      if (code !== 0) return fail(`exit_${code}`);
      if (!exists(aiBin(type))) return fail('bin_missing');
      // 実際に動かして確かめる。動かなければ入れ直す（optional の依存の取り損ねを拾う）
      run(aiBin(type), ['--version'], (vcode, verr, vout) => {
        if (job.status !== 'running') return;
        if (!verr && vcode === 0) {
          try { mark(verifiedPath(type), String(vout || '').trim().slice(0, 200) || 'ok'); } catch { return fail('mark_failed'); }
          return Object.assign(job, { status: 'done' });
        }
        if (left > 0) return attempt(left - 1);
        fail('verify_failed');
      });
    });
    attempt(retries);
    return view(type);
  };
  return { start, view, installed };
}
