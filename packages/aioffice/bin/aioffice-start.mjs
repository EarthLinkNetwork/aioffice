#!/usr/bin/env node
// container の主の process（PID 1 は tini）。起動係（3100）をこの process で動かし、本体（Paperclip）を子の process（loopback の 3101）で動かす
// - 本体が落ちたら起こし直す（間隔は 2 秒から 60 秒まで延ばす）
// - docker stop の SIGTERM は本体へ渡し、組み込みの PostgreSQL が止まるのを待つ（RUN.txt の --stop-timeout 60 の内側の 50 秒）
// 置き場: /data/paperclip（本体）・/data/aioffice（wizard の状態）・/data/codex-home（AI の契約のつなぎ・全担当で共有）
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import { createLauncher } from '../launcher/server.mjs';
import { createPluginInstaller } from '../launcher/lib/plugins.mjs';
import { createRounds } from '../launcher/lib/rounds.mjs';
import { createOllama } from '../launcher/lib/ollama.mjs';
import { createLimitsCollector, createLimitOverrides, testHooksEnabled } from '../launcher/lib/limits.mjs';

const DATA = process.env.AIOFFICE_DATA_ROOT || '/data';
const PC_PORT = Number(process.env.AIOFFICE_PAPERCLIP_PORT || 3101);
const PORT = Number(process.env.AIOFFICE_PORT || 3100);
const CODEX_HOME = `${DATA}/codex-home`;
const PC_BIN = process.env.AIOFFICE_PAPERCLIP_BIN || 'paperclipai';
const STOP_WAIT_MS = 50_000;
const PLUGINS_DIR = process.env.AIOFFICE_PLUGINS_DIR || '/opt/aioffice/plugins'; // image に焼き込んだ plugin（office・design・notify）

for (const d of ['paperclip', 'aioffice', 'codex-home']) fs.mkdirSync(`${DATA}/${d}`, { recursive: true, mode: 0o700 });

let child = null, stopping = false, delay = 2000, restartTimer = null;
// 本体を起こすたびに、焼き込んだ plugin が入っていて ready かを照合する（入っていない・中身が変わった時だけ入れる・失敗しても止めない）
const plugins = createPluginInstaller({ pcUrl: `http://127.0.0.1:${PC_PORT}`, dataDir: `${DATA}/aioffice`, pluginsDir: PLUGINS_DIR, pcBin: PC_BIN, paperclipDataDir: `${DATA}/paperclip` });
function startPaperclip() {
  const env = { ...process.env, PORT: String(PC_PORT), HOST: '127.0.0.1', CODEX_HOME, PAPERCLIP_TELEMETRY_DISABLED: '1', DO_NOT_TRACK: '1', PAPERCLIP_UPDATE_CHECK: '0' };
  const startedAt = Date.now();
  // 初回は onboard（ログインなしの mode・loopback の既定を受け入れ、そのまま本体を起こす・段 1 の実測 3）。設定ができた後は run
  const first = !fs.existsSync(`${DATA}/paperclip/instances/default/config.json`);
  const args = first ? ['onboard', '--yes', '--no-install-service', '-d', `${DATA}/paperclip`] : ['run', '-d', `${DATA}/paperclip`];
  child = spawn(PC_BIN, args, { env, stdio: ['ignore', 'inherit', 'inherit'] });
  console.log(`aioffice: paperclip ${args[0]} (pid ${child.pid}, port ${PC_PORT})`);
  plugins.ensure().then(r => { for (const [k, v] of Object.entries(r)) console.log(`aioffice: plugin ${k} ${v.status}${v.error ? ` (${v.error})` : ''}`); }, e => console.log(`aioffice: plugin check failed: ${e?.message || e}`));
  child.on('exit', (code, sig) => {
    child = null;
    if (stopping) return;
    if (Date.now() - startedAt > 60_000) delay = 2000; // しばらく動いていたなら間隔を戻す
    console.log(`aioffice: paperclip exited (${code ?? sig}); restarting in ${delay / 1000}s`);
    restartTimer = setTimeout(startPaperclip, delay); delay = Math.min(delay * 2, 60_000);
  });
}

let rounds = null;
// 試験用の差し替えは CI だけが付ける env の時だけ作る（配る image には env を入れない）
const limitOverrides = testHooksEnabled() ? createLimitOverrides() : null;
const { server, store, mail } = createLauncher({ limitOverrides, dataDir: `${DATA}/aioffice`, paperclipUrl: `http://127.0.0.1:${PC_PORT}`, codexHome: CODEX_HOME, codexBin: process.env.CODEX_BIN || 'codex', pluginStatus: () => plugins.readRecord(), roundsStatus: () => rounds?.status() || {} });
// 見回りの係: 毎分起き、5 分ごとに会社ごとに知らせ・図書室の見回りの口を呼ぶ（plugin の job は会社の物を読めない・範囲の文書の実測 1・16・17）
// AI の使用量の上限の値は、見回りで会社ごとに本体を読んで知らせの /tick に渡す（範囲 docs/review/2026-11-18-ai-usage-limit-scope.md 7 の 2）
const limits = createLimitsCollector({ pcUrl: `http://127.0.0.1:${PC_PORT}`, getState: () => store.get(), updateState: fn => store.update(fn), overrides: limitOverrides });
rounds = createRounds({ pcUrl: `http://127.0.0.1:${PC_PORT}`, dataDir: `${DATA}/aioffice`, getState: () => store.get(), installed: () => Object.keys(plugins.readRecord()), ready: () => Object.entries(plugins.readRecord()).filter(([, v]) => v.status === 'ready').map(([k]) => k), limits, mail });
const roundsTimer = setInterval(() => { rounds.maybeRun().catch(e => console.log(`aioffice: rounds failed: ${e?.message || e}`)); }, 60_000);
server.listen(PORT, '0.0.0.0', () => console.log(`aioffice: open http://localhost:${PORT}/ in your browser`)); // 外へは docker の -p 127.0.0.1:… で手元だけに出す
startPaperclip();
// 図書室の意味の近さの検索の Ollama（image に入っていて、止めていない時だけ）
const ollama = createOllama();
ollama.start();

function shutdown(sig) {
  if (stopping) return; stopping = true; clearTimeout(restartTimer); clearInterval(roundsTimer);
  console.log(`aioffice: ${sig}, stopping`);
  server.close();
  const ollamaDone = ollama.stop();
  if (!child) { ollamaDone.then(() => process.exit(0)); return; }
  const c = child;
  c.once('exit', () => ollamaDone.then(() => process.exit(0)));
  c.kill('SIGTERM');
  setTimeout(() => { console.log('aioffice: paperclip did not stop in time'); c.kill('SIGKILL'); process.exit(1); }, STOP_WAIT_MS).unref();
}
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
