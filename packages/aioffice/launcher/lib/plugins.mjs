// image に焼き込んだ plugin（/opt/aioffice/plugins/<name>）を本体に入れる（範囲 docs/review/2026-11-15-office-plugin-scope.md の保証 1）。
// - 本体の health が通ってから、plugin の一覧を読む
// - 入っていなければ `plugin install --local`、BUILD_ID が記録と違う・状態が ready でなければ `plugin upgrade`、置き場が違えば外して入れ直す
// - 入れた後に ready を確かめ、結果を <dataDir>/plugins.json に記録する（起動係が wizard の完了の画面に出す）
// 網には取りに行かない（--local の置き場は image の中）。失敗しても起動は止めない
import fs from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';

export function readBundled(pluginsDir) {
  if (!fs.existsSync(pluginsDir)) return [];
  return fs.readdirSync(pluginsDir, { withFileTypes: true }).filter(d => d.isDirectory()).flatMap(d => {
    const dir = path.join(pluginsDir, d.name);
    try {
      const buildId = fs.readFileSync(path.join(dir, 'BUILD_ID'), 'utf8').trim();
      const key = JSON.parse(fs.readFileSync(path.join(dir, 'PLUGIN_KEY'), 'utf8')).key;
      return buildId && key ? [{ name: d.name, dir, buildId, key }] : [];
    } catch { return []; }
  });
}

export const CAPABILITY_ESCALATION = /introduces new capabilities that require approval/i;

const runCliDefault = (bin, args) => new Promise(resolve => {
  execFile(bin, args, { timeout: 180_000, maxBuffer: 4 * 1024 * 1024 }, (err, stdout, stderr) => resolve({ ok: !err, out: String(stdout || '').slice(-2000), err: String(stderr || err?.message || '').slice(-2000) }));
});

// healthRounds: health を healthTries 回待って通らなければ failed を記録し、さらに待ち続ける回数（既定は無限・試験では小さくする）
export function createPluginInstaller({ pcUrl, dataDir, pluginsDir, pcBin = 'paperclipai', paperclipDataDir, fetchFn = fetch, runCli = runCliDefault, sleep = ms => new Promise(r => setTimeout(r, ms)), healthTries = 90, healthRounds = Infinity } = {}) {
  const recordFile = path.join(dataDir, 'plugins.json');
  const readRecord = () => { try { return JSON.parse(fs.readFileSync(recordFile, 'utf8')); } catch { return {}; } };
  const writeRecord = r => { fs.mkdirSync(dataDir, { recursive: true }); fs.writeFileSync(`${recordFile}.tmp`, JSON.stringify(r, null, 2)); fs.renameSync(`${recordFile}.tmp`, recordFile); };
  const getJson = async p => { const r = await fetchFn(new URL(p, pcUrl)); if (!r.ok) throw Object.assign(new Error(`GET ${p} → ${r.status}`), { status: r.status }); return r.json(); };

  async function waitHealth() {
    for (let i = 0; i < healthTries; i++) {
      try { const r = await fetchFn(new URL('/api/health', pcUrl)); if (r.ok) return true; } catch { /* 本体がまだ起きていない */ }
      await sleep(2000);
    }
    return false;
  }
  async function listInstalled() {
    const j = await getJson('/api/plugins');
    const items = Array.isArray(j) ? j : (j.items || []);
    return new Map(items.map(p => [p.pluginKey || p.key || p.id, p]));
  }

  let running = null, again = false;
  // 同じ時に 2 回呼ばれても同時には走らせない。走っている途中で呼ばれたら（本体が起こし直された時）、終わった後にもう 1 回照合する
  function ensure() {
    if (running) { again = true; return running; }
    running = (async () => { let r; do { again = false; r = await ensureOnce(); } while (again); return r; })().finally(() => { running = null; });
    return running;
  }
  async function ensureOnce() {
    const bundled = readBundled(pluginsDir);
    const record = readRecord();
    if (!bundled.length) return record;
    if (!(await waitHealth())) {
      // 約 3 分で起きなければ wizard に「入れられませんでした」を出し、裏で待ち続けて、起きたら照合する（初回の onboard が遅い機械）
      for (const b of bundled) record[b.key] = { ...record[b.key], status: 'failed', error: 'paperclip_not_ready', at: new Date().toISOString() };
      writeRecord(record);
      let up = false;
      for (let i = 1; i < healthRounds && !up; i++) up = await waitHealth();
      if (!up) return record;
    }
    let installed;
    try { installed = await listInstalled(); } catch (e) { for (const b of bundled) record[b.key] = { ...record[b.key], status: 'failed', error: 'list_failed', at: new Date().toISOString() }; writeRecord(record); return record; }
    for (const b of bundled) {
      const cur = installed.get(b.key);
      // 記録の BUILD_ID は ready を確かめた時にだけ書く。なので本体で ready・記録の BUILD_ID が同じなら、記録の状態（本体が遅くて failed を書いた後など）に依らず入れ直さない
      const same = cur && cur.status === 'ready' && record[b.key]?.buildId === b.buildId;
      if (same) { if (record[b.key].status !== 'ready') { record[b.key] = { buildId: b.buildId, status: 'ready', error: null, at: new Date().toISOString() }; writeRecord(record); } continue; }
      // --local は写しを作らず置き場を指す（packagePath）。同じ key を install し直すと 400 なので、入っていれば upgrade（2026-11-15 実測）
      const common = ['--api-base', pcUrl, '--json', ...(paperclipDataDir ? ['-d', paperclipDataDir] : [])];
      let r;
      if (cur && cur.packagePath && cur.packagePath !== b.dir) { // 置き場が違う（古い image の path）: 外して入れ直す
        await runCli(pcBin, ['plugin', 'uninstall', b.key, ...common]);
        r = await runCli(pcBin, ['plugin', 'install', '--local', b.dir, '--no-verify-target', ...common]);
      } else if (cur) {
        r = await runCli(pcBin, ['plugin', 'upgrade', b.key, ...common]);
        // 新しい版で capability が増えると、本体は upgrade を 400 で断る（承認待ちの状態にもならない）。同梱の plugin に限り、
        // --force を付けずに外して入れ直す（plugin の表と state は残る・2026-11-16 実測 15）。--force は state と設定を全部消すので付けない
        if (!r.ok && CAPABILITY_ESCALATION.test(`${r.err}\n${r.out}`)) {
          await runCli(pcBin, ['plugin', 'uninstall', b.key, ...common]);
          r = await runCli(pcBin, ['plugin', 'install', '--local', b.dir, '--no-verify-target', ...common]);
        }
      } else {
        r = await runCli(pcBin, ['plugin', 'install', '--local', b.dir, '--no-verify-target', ...common]);
      }
      // CLI が失敗した時は、本体の一覧が ready（前の版が動いている）でも failed にし、BUILD_ID は前のまま残す（次の起動でやり直す）
      let status = 'failed', error = r.ok ? null : 'install_failed';
      try { const after = (await listInstalled()).get(b.key); if (r.ok && after?.status === 'ready') status = 'ready'; else if (!error) error = `status_${after?.status || 'missing'}`; } catch { error = error || 'list_failed'; }
      record[b.key] = { buildId: status === 'ready' ? b.buildId : (record[b.key]?.buildId ?? null), status, error, at: new Date().toISOString(), ...(status === 'ready' ? {} : { detail: (r.err || r.out).slice(-500) }) };
      writeRecord(record);
    }
    return record;
  }
  return { ensure, readRecord };
}
