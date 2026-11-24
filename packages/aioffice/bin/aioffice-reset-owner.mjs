#!/usr/bin/env node
// パスワードを忘れた時の戻し方: docker exec aioffice aioffice-reset-owner
// 設計 docs/design/2026-11-23-public-office-multi-user.md 2.8:
// - 本体の `paperclipai auth bootstrap-ceo --force` で、持ち主（instance admin）を作り直す招待を出し、http://localhost:3100/invite/<token> を表示する
//   本体の CLI は env でなく config.json の deploymentMode を読む（onboard が書いた local_trusted のままだと何も作らない・2026-11-24 実測）。
//   deploymentMode だけを authenticated に替えた config の写しを container の中の一時の場所（0700）に作って渡し、終わったら消す
// - 本体は bootstrap_ceo の招待を、admin が 1 人もいない時しか受けない（--force でも・2026-11-24 実測）。招待を作れた後に、本体の DB の
//   instance admin の役を外す。前の持ち主の名義の起動係の鍵は admin でなくなるので、起動係が 1 分以内に鍵の無い段にして担当を止める
// - 鍵が無い段でも招待を開けるよう、token の sha256 と期限を /data/aioffice/reset-invite（0600）に置く。起動係はそれと合う招待の画面を開いた人だけに sign-up と accept を通す
// - 会社・担当・AI のつなぎ・メールと Slack の設定は残す。前の持ち主のアカウントは会社の人として残る。会社の owner の役は、新しい持ち主ができた後に
//   起動係が毎分の見回りで operator に下げる（launcher/server.mjs の ensureOwnerMemberships）
// - 前の版（合言葉の形）で移し替えの前なら、今までどおり合言葉を消す
import { spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openStore } from '../launcher/lib/state.mjs';
import { parseHosts } from '../launcher/lib/core-env.mjs';

const DATA = process.env.AIOFFICE_DATA_ROOT || '/data';
const store = openStore(`${DATA}/aioffice`);
const s = store.get();
if (s.v !== 2 && (s.owner || s.companyId)) {
  store.resetOwner();
  console.log('The owner password was removed. Open the office in your browser and choose a new password.');
  console.log('持ち主の合言葉を消しました。ブラウザでオフィスを開き、新しい合言葉を決めてください。');
  process.exit(0);
}
const fail = () => {
  console.error('Could not create the owner invite. Make sure the office is running, then try again.');
  console.error('持ち主の招待を作れませんでした。オフィスが動いていることを確かめて、もう一度回してください。');
  process.exit(1);
};
const EXPIRES_HOURS = 24;
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'aio-reset-'));
let out = '';
try {
  const cfg = JSON.parse(fs.readFileSync(`${DATA}/paperclip/instances/default/config.json`, 'utf8'));
  cfg.server = { ...(cfg.server || {}), deploymentMode: 'authenticated' };
  fs.writeFileSync(path.join(tmp, 'config.json'), JSON.stringify(cfg), { mode: 0o600 });
  const r = spawnSync(process.env.AIOFFICE_PAPERCLIP_BIN || 'paperclipai',
    ['auth', 'bootstrap-ceo', '--force', '-c', path.join(tmp, 'config.json'), '--base-url', 'http://localhost:3100', '--expires-hours', String(EXPIRES_HOURS)],
    { encoding: 'utf8', timeout: 120_000 });
  if (r.status !== 0) fail();
  out = `${r.stdout || ''}\n${r.stderr || ''}`.replace(/\x1b\[[0-9;]*[A-Za-z]/g, '');
} catch { fail(); } finally { fs.rmSync(tmp, { recursive: true, force: true }); }
const token = out.match(/\/invite\/([A-Za-z0-9_-]{8,200})/)?.[1];
if (!token) fail();
fs.writeFileSync(`${DATA}/aioffice/reset-invite`, JSON.stringify({ hash: crypto.createHash('sha256').update(token).digest('hex'), exp: Date.now() + EXPIRES_HOURS * 3600 * 1000 }), { mode: 0o600 });
// admin を外す前に起動係の鍵の file を外し、起動係をその場で鍵の無い段にする（本体への中継が白リストになり、担当も止まる）。
// 外した後の admin が 0 人の間に、招いた人や LAN の誰かが本体の bootstrap の claim で持ち主を取る道を閉じる（独立レビュー 2 回目 高 1）。
// 新しい持ち主が sign-in して鍵を作り直す（wizard の段・普段の段に戻る）
// 消す前に鍵の id だけを読み、下で本体の DB の鍵も取り消す（file を消すだけだと、前の持ち主の名義の鍵が container の中で使え続ける・独立レビュー 5 回目 低 5）
let oldKeyId = null;
try { const k = JSON.parse(fs.readFileSync(`${DATA}/aioffice/board-key.json`, 'utf8')); if (typeof k?.id === 'string' && /^[0-9a-f-]{36}$/i.test(k.id)) oldKeyId = k.id; } catch { /* 無い */ }
fs.rmSync(`${DATA}/aioffice/board-key.json`, { force: true });
// 前の admin の役を外す（本体の DB の住所は本体の CLI と同じ形）。外せなければ招待は使えないので、失敗で終える
try {
  const port = JSON.parse(fs.readFileSync(`${DATA}/paperclip/instances/default/config.json`, 'utf8')).database?.embeddedPostgresPort;
  const { createDb } = await import(process.env.AIOFFICE_DB_LIB || '/opt/aioffice/runtime/node_modules/@paperclipai/db/dist/index.js');
  const db = createDb(`postgres://paperclip:paperclip@127.0.0.1:${port}/paperclip`);
  try {
    // 鍵の取り消しの失敗で admin を外す処理まで止めない（鍵の file は消してあるので、起動係からはもう使わない・6 回目のレビュー 低 3）
    if (oldKeyId) { try { await db.$client`update board_api_keys set revoked_at = now() where id = ${oldKeyId} and revoked_at is null`; } catch { console.error('Could not revoke the old launcher key. / 前の起動係の鍵を取り消せませんでした。'); } }
    await db.$client`delete from instance_user_roles where role = 'instance_admin'`;
  } finally { await db.$client.end?.({ timeout: 5 }).catch(() => {}); }
} catch {
  fs.rmSync(`${DATA}/aioffice/reset-invite`, { force: true });
  // 鍵の file は消した後なので、オフィスは AI 社員を止めた段のまま。前の持ち主が sign-in すれば鍵を作り直して戻せる（3 回目のレビュー 低 2）
  console.error('The owner was not changed. The AI employees are paused until the current owner signs in at http://localhost:3100/ and the office makes a new key.');
  console.error('持ち主は替わっていません。今の持ち主が http://localhost:3100/ で sign-in し、オフィスが鍵を作り直すまで、AI 社員は止まります。');
  fail();
}
const url = `http://localhost:3100/invite/${token}`;
console.log(`Open this URL in your browser and create a new owner account (it works for ${EXPIRES_HOURS} hours):\n  ${url}`);
console.log(`ブラウザでこの URL を開き、新しい持ち主のアカウントを作ってください（${EXPIRES_HOURS} 時間使えます）:\n  ${url}`);
// Cloudflare Tunnel など https の前段の住所（AIOFFICE_HOSTS の https://名前）でも同じ招待を開ける（独立レビュー 6 回目 P3-3）
let fronts = [];
try { fronts = parseHosts(process.env.AIOFFICE_HOSTS || '').filter(h => h.startsWith('https://')); } catch { /* 書き方の誤りは起動係が止める */ }
for (const f of fronts) console.log(`  ${f}/invite/${token}`);
console.log('Until then, the AI employees are paused. / それまで、AI 社員は止まります。');
