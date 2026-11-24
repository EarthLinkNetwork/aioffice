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
import { createBoardKey, authedFetch, cliEnv } from '../launcher/lib/board-key.mjs';
import { coreEnv } from '../launcher/lib/core-env.mjs';
import { createClaimWatcher, parseBackup } from '../launcher/lib/migrate.mjs';
import { createRoleWriter } from '../launcher/lib/member-roles.mjs';

// 本体の出力は行ごとに写し、board-claim の URL の行だけ拾って写さない（移し替えの段 1・設計 2.4）
const outWatch = createClaimWatcher(l => process.stdout.write(l)), errWatch = createClaimWatcher(l => process.stderr.write(l));
const claimInfo = () => { const a = outWatch.current(), b = errWatch.current(); return a && b ? (a.at >= b.at ? a : b) : a || b; };
const clearClaim = () => { outWatch.clear(); errWatch.clear(); };
// 移し替えの段 2: claim の前の backup（--json の backupFile と sizeBytes だけを印にする）
function runBackup() {
  return new Promise(resolve => {
    const env = coreEnv({ base: process.env, port: PC_PORT, codexHome: CODEX_HOME, hosts: process.env.AIOFFICE_HOSTS, keyless: true });
    const p = spawn(PC_BIN, ['db:backup', '-d', `${DATA}/paperclip`, '--filename-prefix', 'aioffice-before-auth', '--json'], { env, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = ''; p.stdout.on('data', c => { out += c; }); p.stderr.on('data', c => process.stderr.write(c));
    p.on('error', () => resolve(null));
    p.on('exit', code => { const mark = code === 0 ? parseBackup(out) : null; console.log(`aioffice: backup before migration ${mark ? `ok (${mark.sizeBytes} bytes)` : `failed (${code})`}`); resolve(mark); });
  });
}

const DATA = process.env.AIOFFICE_DATA_ROOT || '/data';
const PC_PORT = Number(process.env.AIOFFICE_PAPERCLIP_PORT || 3101);
const PORT = Number(process.env.AIOFFICE_PORT || 3100);
const CODEX_HOME = `${DATA}/codex-home`;
const PC_BIN = process.env.AIOFFICE_PAPERCLIP_BIN || 'paperclipai';
const STOP_WAIT_MS = 50_000;
const PLUGINS_DIR = process.env.AIOFFICE_PLUGINS_DIR || '/opt/aioffice/plugins'; // image に焼き込んだ plugin（office・design・notify）

for (const d of ['paperclip', 'aioffice', 'codex-home']) fs.mkdirSync(`${DATA}/${d}`, { recursive: true, mode: 0o700 });
// 起動係の鍵（本体の board の鍵・持ち主の名義）。本体への呼び出しは、どれも鍵を付ける fetch を通す（設計 docs/design/2026-11-23-public-office-multi-user.md 2.3）
const boardKey = createBoardKey({ dataDir: `${DATA}/aioffice` });
const pcFetch = authedFetch(fetch, boardKey);

let child = null, stopping = false, delay = 2000, restartTimer = null;
// 本体を起こすたびに、焼き込んだ plugin が入っていて ready かを照合する（入っていない・中身が変わった時だけ入れる・失敗しても止めない）
const plugins = createPluginInstaller({ pcUrl: `http://127.0.0.1:${PC_PORT}`, dataDir: `${DATA}/aioffice`, pluginsDir: PLUGINS_DIR, pcBin: PC_BIN, paperclipDataDir: `${DATA}/paperclip`, fetchFn: pcFetch, cliEnv: () => cliEnv(boardKey) });
function startPaperclip() {
  // ログインのある形（authenticated）で起こす。起動係の鍵が無い間は担当の自動の起こしを止める（設計 2.1）
  const env = coreEnv({ base: process.env, port: PC_PORT, codexHome: CODEX_HOME, hosts: process.env.AIOFFICE_HOSTS, keyless: launcher ? launcher.keyless() : !boardKey.has() });
  const startedAt = Date.now();
  // 初回は onboard（ログインなしの mode・loopback の既定を受け入れ、そのまま本体を起こす・段 1 の実測 3）。設定ができた後は run
  const first = !fs.existsSync(`${DATA}/paperclip/instances/default/config.json`);
  const args = first ? ['onboard', '--yes', '--no-install-service', '-d', `${DATA}/paperclip`] : ['run', '-d', `${DATA}/paperclip`];
  clearClaim(); // 起こし直す前の token は使えない
  child = spawn(PC_BIN, args, { env, stdio: ['ignore', 'pipe', 'pipe'] });
  child.stdout.on('data', outWatch.feed); child.stderr.on('data', errWatch.feed);
  console.log(`aioffice: paperclip ${args[0]} (pid ${child.pid}, port ${PC_PORT})`);
  // 起動係の鍵が無い間は本体の plugin の口を呼べない（401）。照合は鍵ができた後の起こし直しで回す（failed を記録しない）
  if (boardKey.has()) plugins.ensure().then(r => { for (const [k, v] of Object.entries(r)) console.log(`aioffice: plugin ${k} ${v.status}${v.error ? ` (${v.error})` : ''}`); }, e => console.log(`aioffice: plugin check failed: ${e?.message || e}`));
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
const launcher = createLauncher({ roleWriter: createRoleWriter({ dataRoot: DATA }), fetchFn: pcFetch, rawFetchFn: fetch, boardKey, restartCore: () => restartPaperclip(), claimInfo, clearClaim, runBackup, limitOverrides, dataDir: `${DATA}/aioffice`, paperclipUrl: `http://127.0.0.1:${PC_PORT}`, codexHome: CODEX_HOME, codexBin: process.env.CODEX_BIN || 'codex', pluginStatus: () => plugins.readRecord(), roundsStatus: () => rounds?.status() || {} });
const { server, store, mail } = launcher;
// 本体を起こし直す（鍵ができた・鍵が断られた時）。今の本体を止めると exit の受け手が env を作り直して起こす（鍵の有無で scheduler が変わる・設計 2.1）
function restartPaperclip() {
  if (!child) return;
  console.log('aioffice: restarting paperclip (launcher key changed)');
  delay = 2000;
  child.kill('SIGTERM');
}
// 見回りの係: 毎分起き、5 分ごとに会社ごとに知らせ・図書室の見回りの口を呼ぶ（plugin の job は会社の物を読めない・範囲の文書の実測 1・16・17）
// AI の使用量の上限の値は、見回りで会社ごとに本体を読んで知らせの /tick に渡す（範囲 docs/review/2026-11-18-ai-usage-limit-scope.md 7 の 2）
const limits = createLimitsCollector({ fetchFn: pcFetch, pcUrl: `http://127.0.0.1:${PC_PORT}`, getState: () => store.get(), updateState: fn => store.update(fn), overrides: limitOverrides });
rounds = createRounds({ fetchFn: pcFetch, pcUrl: `http://127.0.0.1:${PC_PORT}`, dataDir: `${DATA}/aioffice`, getState: () => store.get(), installed: () => Object.keys(plugins.readRecord()), ready: () => Object.entries(plugins.readRecord()).filter(([, v]) => v.status === 'ready').map(([k]) => k), limits, mail });
let relayMailBusy = false;
let caseSynced = false, caseBusy = false, caseTries = 0; // 判断の書き方を揃えるのは起動の後に成功するまで（範囲 docs/review/2026-11-25-case-format-in-public-scope.md）
const roundsTimer = setInterval(() => {
  // 鍵が断られたら（401・403・admin でない）、見回りを止め、本体を scheduler を止めて起こし直す（設計 2.3・保証 7）
  launcher.checkKey().then(bad => { if (bad) restartPaperclip(); }, () => {});
  if (launcher.keyless()) return;
  // 人と承認の列を relay の設定へ（変わった時だけ書く・設計 2.5）。招かれた人が accept した後も次の分で載る
  // 続けて、回覧が人に届いた時のメール（設計 2.6）。前の分の送りが残っていれば重ねない
  launcher.syncRelay().catch(e => console.log(`aioffice: plugin config sync failed: ${String(e?.message || e).slice(0, 200)}`))
    .then(() => { if (relayMailBusy) return; relayMailBusy = true; return launcher.relayMail().catch(e => console.log(`aioffice: relay mail failed: ${String(e?.message || e).slice(0, 200)}`)).finally(() => { relayMailBusy = false; }); });
  rounds.maybeRun().catch(e => console.log(`aioffice: rounds failed: ${e?.message || e}`));
  // 失敗し続ける時は 10 回で止め、次の起動か担当を足した時に回す（毎分の全部の読み直しを終わらせる・実装レビュー P3-3）
  if (!caseSynced && !caseBusy && caseTries < 10 && store.get().done) { caseBusy = true; caseTries++; launcher.syncCase().then(ok => { caseSynced = ok; if (!ok && caseTries >= 10) console.log('aioffice: case-format sync gave up until the next start'); }).finally(() => { caseBusy = false; }); }
}, 60_000);
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
