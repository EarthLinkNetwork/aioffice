// 本物の Claude Code を、配る image の container の中で wizard の部品のまま動かす e2e
// 偽の process の unit では見つからなかった不具合（2026-11-18 に利用者の実機で 3 回止まった）を、image を作るたびに捕まえる:
//   1. 本物と同じ長さの code を送ると、claude が答えを返す（code と Enter をまとめて書くと貼り付け扱いで送信されない）
//   2. 断られたら code_rejected で止まる（「確かめています」のまま待たない）
//   3. ダウンロードした CLI が --version で動く（platform の本体の取り損ねを拾う）
// 使い方: AIO_CONTAINER=<名前> node test/e2e/ai-login-real.e2e.mjs
// サインインはしない（試しの code は必ず断られる）。秘密の値は扱わない
import { dockerSync } from './docker.mjs';

const NAME = process.env.AIO_CONTAINER || 'aioffice';
const INSTALL_WAIT_S = Number(process.env.AIO_INSTALL_WAIT_S || 1200);

// container の中で、launcher の部品を import して動かす script
const inner = `
import { createAiInstaller } from '/opt/aioffice/launcher/lib/ai-install.mjs';
import { aiBin } from '/opt/aioffice/launcher/lib/ai-catalog.mjs';
import { createClaudeLogin } from '/opt/aioffice/launcher/lib/claude-login.mjs';
const out = (k, v) => console.log(JSON.stringify({ k, v }));
const ins = createAiInstaller();
const t0 = Date.now();
ins.start('claude_local');
while (ins.view('claude_local').status === 'running') {
  if (Date.now() - t0 > ${INSTALL_WAIT_S} * 1000) { out('install', 'timeout'); process.exit(2); }
  await new Promise(r => setTimeout(r, 2000));
}
out('install', ins.view('claude_local'));
if (ins.view('claude_local').status !== 'done') process.exit(3);
const logs = [];
const l = createClaudeLogin({ claudeBin: aiBin('claude_local'), saveToken: () => out('token', 'unexpected'), log: m => logs.push(m) });
l.start();
const until = async (ok, ms) => { const end = Date.now() + ms; while (Date.now() < end) { if (ok(l.view())) return true; await new Promise(r => setTimeout(r, 250)); } return false; };
const waited = await until(v => v.state !== 'starting', 60000);
const v1 = l.view();
out('waiting', { state: v1.state, host: v1.url ? new URL(v1.url).host : null, hasState: v1.url ? new URL(v1.url).searchParams.has('state') : false, waited });
if (v1.state !== 'waiting') { out('logs', logs); process.exit(4); }
// 本物の code と同じ形・長さ（92 文字・'#' を 1 つ・'_' を含む）
const code = 'A'.repeat(48) + '_' + 'B'.repeat(10) + '#' + 'c'.repeat(32);
out('code_length', code.length);
const sentAt = Date.now();
l.submit(code);
await until(v => v.state !== 'submitting', 60000);
const v2 = l.view();
out('answer', { state: v2.state, error: v2.error, seconds: Math.round((Date.now() - sentAt) / 1000) });
l.stop();
process.exit(v2.state === 'failed' && v2.error === 'code_rejected' ? 0 : 5);
`;

const lines = [];
let code = 0;
try {
  const r = dockerSync(['exec', '-i', '-w', '/tmp', NAME, 'node', '--input-type=module', '-'], { input: inner, encoding: 'utf8', timeout: (INSTALL_WAIT_S + 180) * 1000 });
  lines.push(...r.split('\n'));
} catch (e) {
  code = e.status ?? 1;
  lines.push(...String(e.stdout || '').split('\n'), ...String(e.stderr || '').split('\n'));
}
const got = {};
for (const s of lines.filter(Boolean)) { try { const j = JSON.parse(s); got[j.k] = j.v; } catch { if (!/sk-ant/.test(s)) console.log(s.slice(0, 300)); } }
console.log(JSON.stringify(got, null, 2).replace(/sk-ant-[A-Za-z0-9_-]+/g, '<token>'));

const fail = m => { console.error(`✖ ${m}`); process.exit(1); };
if (got.install?.status !== 'done') fail(`Claude Code をダウンロードして --version で動かせなかった: ${JSON.stringify(got.install)}`);
if (got.waiting?.state !== 'waiting' || !/^(claude\.com|claude\.ai)$/.test(got.waiting?.host || '') || !got.waiting?.hasState) fail(`サインインの URL を出して code を待つ所まで進まなかった: ${JSON.stringify(got.waiting)}`);
if (got.answer?.state === 'submitting') fail('code を送っても claude が答えなかった（Enter が送信として効いていない）');
if (got.answer?.error !== 'code_rejected') fail(`試しの code の断りを拾って止まらなかった: ${JSON.stringify(got.answer)}`);
if (got.token) fail('試しの code で token を受け取った');
if (code !== 0) fail(`container の中の確かめが ${code} で終わった`);
console.log(`✔ 本物の Claude Code: ダウンロードして動く・URL を出して待つ・${got.code_length} 文字の code に ${got.answer.seconds} 秒で答えが返り、断りを拾って止まる`);
