#!/usr/bin/env node
// backup から戻す: docker exec aioffice aioffice-restore <backup の file>
// 設計 docs/design/2026-11-23-public-office-multi-user.md 2.4「戻し方」。本体の CLI に restore が無いので、本体の db の runDatabaseRestore を使う
// - 戻す先は container の中の本体の DB（embedded postgres・本体の CLI と同じ住所。本体が動いている間だけ届く）
// - 移し替えの backup なら、隣の <file>.aioffice-state.json（移し替えの前の起動係の state）も戻し、起動係の鍵を外す
// - 戻した後は container を起こし直す（前の版の image に戻すか、この版でもう一度移し替える）
// 引数を付けないと、backup の一覧を出す
import fs from 'node:fs';
import path from 'node:path';

const DATA = process.env.AIOFFICE_DATA_ROOT || '/data';
const INSTANCE = `${DATA}/paperclip/instances/default`;
const DB_LIB = process.env.AIOFFICE_DB_LIB || '/opt/aioffice/runtime/node_modules/@paperclipai/db/dist/index.js';
const say = (en, ja) => { console.log(en); console.log(ja); };

function backups() {
  const out = [];
  const walk = d => { let es = []; try { es = fs.readdirSync(d, { withFileTypes: true }); } catch { return; } for (const e of es) { const p = path.join(d, e.name); if (e.isDirectory()) walk(p); else if (/\.sql(\.gz)?$/.test(e.name)) out.push(p); } };
  walk(`${DATA}/paperclip`);
  return out.sort();
}

const file = process.argv[2];
if (!file) {
  const list = backups();
  say('Backups in this office (newest last):', 'このオフィスの backup（新しい物が下）:');
  for (const b of list) console.log(`  ${b}${fs.existsSync(`${b}.aioffice-state.json`) ? '  (before the login update / ログインの形に移す前)' : ''}`);
  say('Run again with the file: docker exec aioffice aioffice-restore <file>', 'file を付けてもう一度回します: docker exec aioffice aioffice-restore <file>');
  process.exit(list.length ? 0 : 1);
}
const real = path.resolve(file);
if (!real.startsWith(`${DATA}/paperclip/`) || !fs.existsSync(real)) {
  say('That file is not a backup of this office.', 'その file はこのオフィスの backup ではありません。');
  process.exit(2);
}
let port = null;
try { port = JSON.parse(fs.readFileSync(`${INSTANCE}/config.json`, 'utf8')).database?.embeddedPostgresPort; } catch { /* 下で断る */ }
if (!Number.isInteger(port)) { say('Could not find the office database. Make sure the office is running.', 'オフィスの DB が見つかりません。オフィスが動いていることを確かめてください。'); process.exit(1); }

const { runDatabaseRestore } = await import(DB_LIB);
try {
  await runDatabaseRestore({ connectionString: `postgres://paperclip:paperclip@127.0.0.1:${port}/paperclip`, backupFile: real, connectTimeoutSeconds: 15 });
} catch (e) {
  say(`Could not restore the database: ${String(e?.message || e).slice(0, 200)}`, 'DB を戻せませんでした。オフィスが動いていることを確かめて、もう一度回してください。');
  process.exit(1);
}
const stateCopy = `${real}.aioffice-state.json`;
if (fs.existsSync(stateCopy)) {
  const dir = `${DATA}/aioffice`;
  fs.copyFileSync(stateCopy, path.join(dir, 'state.json'));
  fs.chmodSync(path.join(dir, 'state.json'), 0o600);
  // 戻した DB には今の起動係の鍵が無い。鍵の file を外し、起こし直した時に移し替えからやり直す
  try { fs.rmSync(path.join(dir, 'board-key.json')); } catch { /* 無い */ }
}
say('Restored. Restart the office: docker restart aioffice (or start the earlier version of the image with the same volume).',
  '戻しました。オフィスを起こし直します: docker restart aioffice（または、同じ volume で前の版の image を起こします）。');
