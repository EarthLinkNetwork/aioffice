// 秘書の気づきの plugin を、wizard の後の package で通す（範囲 docs/review/2026-11-21-secretary-awareness-scope.md（開発元の記録）保証 7）
// 使い方: AIO_CONTAINER=aioffice node test/e2e/secretary.e2e.mjs（container は AIOFFICE_CI_TEST_HOOKS=1 で起動してあること）
// 流れ: 起動係の見回りが秘書の口まで届く → 出来事 → 見回りの課題（秘書に・本文に出来事）→ 偽の秘書が提案の json を書いて done → 取り込みで提案 1 つずつの子の課題（確認待ち）
//       → 持ち主の返事のコメント → 次の回の本文の持ち主の反応の柵に入る → 2 社目に 1 社目の出来事が出ない
// 偽の秘書は test/e2e/stubs/secretary-stub.mjs（配る image に入れない・container の /tmp にだけ写す）。起動係の見回りの秘書（wizard の会社）と混ざらないよう、専用の会社を 2 つ作る
import assert from 'node:assert/strict';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dockerSync } from './docker.mjs';
import { deleteCompany } from './company-delete.mjs';

const CONTAINER = process.env.AIO_CONTAINER || 'aioffice';
const LANG = process.env.AIO_LANG === 'ja' ? 'ja' : 'en';
const RUN = Date.now().toString(36);
const HERE = path.dirname(fileURLToPath(import.meta.url));
const ORIGIN = 'plugin:aioffice.secretary:round';
const sleep = ms => new Promise(r => setTimeout(r, ms));
const log = (...a) => console.log('[secretary e2e]', ...a);
const dx = args => dockerSync(args, { encoding: 'utf8', timeout: 60000 });

// container の中から本体（127.0.0.1:3101）に直に頼む（持ち主の画面に無い準備と、見回りの口）
function core(method, p, body) {
  const js = "const K=await(async()=>{try{const f=await import('node:fs');return 'Bearer '+JSON.parse(f.readFileSync('/data/aioffice/board-key.json','utf8')).token}catch{return null}})();const r=await fetch('http://127.0.0.1:3101/api'+process.argv[1],{method:process.argv[2],headers:{'content-type':'application/json',...(K?{authorization:K}:{})},body:process.argv[3]||undefined});console.log(JSON.stringify({s:r.status,t:await r.text()}))";
  const out = dx(['exec', CONTAINER, 'node', '--input-type=module', '-e', js, p, method, body ? JSON.stringify(body) : '']);
  const { s, t } = JSON.parse(out.trim().split('\n').pop());
  let j = null; try { j = JSON.parse(t); } catch { j = null; }
  return { s, j, t };
}
const ok = (method, p, body) => { const r = core(method, p, body); if (r.s >= 400) throw new Error(`${method} ${p} → ${r.s} ${r.t.slice(0, 300)}`); return r.j; };
const list = x => (Array.isArray(x) ? x : x?.items || []);
const tick = (cid, secretaryAgentId, extra = {}) => {
  for (let i = 0; i < 60; i++) {
    const r = core('POST', `/plugins/aioffice.secretary/api/tick?companyId=${encodeURIComponent(cid)}`, { secretaryAgentId, lang: LANG, timeZone: 'UTC', ...extra });
    if (r.s === 409) { execFileSync('sleep', ['2']); continue; }
    // 本体に直に作った会社は、起動係の毎分の同期で plugin に持ち主が書かれるまで owner_only（設計 2.2b）
    if (r.s === 403 && /owner_only/.test(r.t)) { execFileSync('sleep', ['5']); continue; }
    assert.equal(r.s, 200, `tick → ${r.s} ${r.t.slice(0, 200)}`);
    return r.j;
  }
  throw new Error('tick がずっと 409');
};
const status = cid => ok('GET', `/plugins/aioffice.secretary/api/status?companyId=${encodeURIComponent(cid)}`);
const rounds = cid => list(ok('GET', `/companies/${cid}/issues?originKind=${encodeURIComponent(ORIGIN)}`)).filter(i => i.originKind === ORIGIN);
async function until(label, fn, ms = 180000) {
  const t0 = Date.now();
  for (;;) { const v = await fn(); if (v) return v; if (Date.now() - t0 > ms) throw new Error(`待ちきれない: ${label}`); await sleep(3000); }
}

// 1. plugin が入り、起動係の見回りが秘書の口まで届いている
const plugins = list(ok('GET', '/plugins'));
assert.equal(plugins.find(p => p.pluginKey === 'aioffice.secretary')?.status, 'ready', '秘書の plugin が ready');
await until('起動係の見回りが秘書の口に届く', () => { try { return JSON.parse(dx(['exec', CONTAINER, 'cat', '/data/aioffice/rounds.json'])).plugins?.['aioffice.secretary']?.lastOkAt; } catch { return null; } }, 7 * 60000);
log('plugin ready・起動係の見回りが届く');

// 2. 専用の会社 2 つと、偽の秘書（process 型）を作る
dx(['cp', path.join(HERE, 'stubs', 'secretary-stub.mjs'), `${CONTAINER}:/tmp/secretary-stub.mjs`]);
const company = name => ok('POST', '/companies', { name: `${name} ${RUN}` });
const A = company('Secretary E2E A'), B = company('Secretary E2E B');
const stub = cid => {
  const a = ok('POST', `/companies/${cid}/agents`, { name: `Secretary stub ${RUN}`, title: 'Secretary E2E', role: 'general', adapterType: 'process', adapterConfig: { command: 'node', args: ['/tmp/secretary-stub.mjs'], timeoutSec: 60 } });
  if (a.status === 'pending_approval') ok('POST', `/agents/${a.id}/approve`, {});
  return a.id;
};
const SA = stub(A.id), SB = stub(B.id);

// 3. 人の出来事 → 見回りの課題
const secretWord = `E2E-ONLY-A-${RUN}`;
const inv = ok('POST', `/companies/${A.id}/issues`, { title: `Invoice arrived ${secretWord}`, description: 'Payment due at month end.', status: 'backlog' });
const commentWord = `E2E-COMMENT-${RUN}`;
ok('POST', `/issues/${inv.id}/comments`, { body: `The vendor contact changed ${commentWord}` });
await sleep(4000); // 課題とコメントの event が両方表に入るのを待つ（event は待ち行列で 1 本ずつ入る）
const r1 = await until('出来事が表に入り、見回りができる', () => { const r = tick(A.id, SA); return r.created; }, 60000);
const round1 = ok('GET', `/issues/${r1.id}`);
assert.equal(round1.assigneeAgentId, SA, '見回りは秘書に');
assert.equal(round1.originKind, ORIGIN);
assert.match(round1.description, new RegExp(secretWord), '本文に出来事');
assert.match(round1.description, /=====SECRETARY-DATA-[0-9a-f]+=====/, '出来事は境界の中');
assert.match(round1.description, new RegExp(commentWord), '普通の課題への人のコメントも本文に入る（本体の実物の event の形・独立レビュー B1）');
log('見回り 1:', r1.identifier, r1.events, '件');

// 4. 偽の秘書が提案を書いて done → 取り込みで提案 1 つずつの子の課題（確認待ち）
await until('秘書が答える', () => ok('GET', `/issues/${r1.id}`).status === 'done', 180000);
const t2 = tick(A.id, SA);
assert.equal(t2.imported, 1, '取り込む');
assert.equal(ok('GET', `/issues/${r1.id}`).status, 'done', '見回りの課題は done のまま');
// 提案 1 つ = 子の課題 1 つ（確認待ち・親は見回りの課題・本文は件の形）。本物の本体が plugin からの parentId つきの作成を受ける事の確かめ
const kids = list(ok('GET', `/companies/${A.id}/issues?limit=200`)).filter(i => i.parentId === r1.id && i.originKind === 'plugin:aioffice.secretary:proposal');
assert.equal(kids.length, 1, '提案の課題が 1 つできる');
assert.equal(kids[0].status, 'in_review', '提案の課題は確認待ち');
assert.equal(kids[0].assigneeAgentId, SA, '担当は秘書');
assert.match(ok('GET', `/issues/${kids[0].id}`).description || '', /^## (Summary|概要)\n/, '本文は件の形');
const st1 = status(A.id);
assert.equal(st1.proposals, 1);
assert.equal(st1.violations, 0, '見回りの run は課題を作らない');
assert.equal(st1.errors, 0, st1.lastError || '');
log('取り込み: 提案の課題', kids[0].identifier, '・提案', st1.proposals);

// 5. 持ち主の返事 → 次の回の本文に入る（間隔の待ちは CI の試験の口で飛ばす）
const pref = `E2E-PREF-${RUN}`;
ok('POST', `/issues/${r1.id}/comments`, { body: `${pref}: useful, but skip invoices under 10k` });
ok('POST', `/companies/${A.id}/issues`, { title: `Second event ${RUN}`, status: 'backlog' });
const r3 = await until('次の回', () => tick(A.id, SA, { skipWait: true }).created, 60000);
const round2 = ok('GET', `/issues/${r3.id}`);
assert.match(round2.description, new RegExp(pref), '持ち主の返事が次の回の本文に入る');
await until('秘書が 2 回目に答える', () => ok('GET', `/issues/${r3.id}`).status === 'done', 180000);
const c2 = list(ok('GET', `/issues/${r3.id}/comments`)).find(c => c.authorAgentId === SA);
assert.match(String(c2?.body || ''), new RegExp(`saw ${pref}`), '秘書が返事を読めた');
log('反応が次の回に入る');

// 5b. 持ち主の返事は会社の図書室に入り、探せる（2 社目には出ない・保証 5・6）
const libSearch = (cid, q) => ok('GET', `/plugins/aioffice.library/api/search?companyId=${encodeURIComponent(cid)}&q=${encodeURIComponent(q)}`);
const libTick = cid => core('POST', `/plugins/aioffice.library/api/tick?companyId=${encodeURIComponent(cid)}`, { lang: LANG, timeZone: 'UTC' });
await until('返事が図書室に入る', () => { libTick(A.id); return (libSearch(A.id, pref).results || []).some(x => JSON.stringify(x).includes(pref)); }, 240000);
libTick(B.id);
assert.equal((libSearch(B.id, pref).results || []).some(x => JSON.stringify(x).includes(pref)), false, '返事は 2 社目の図書室に出ない');
log('返事が図書室に入る');

// 6. 2 社目に 1 社目の出来事が出ない
ok('POST', `/companies/${B.id}/issues`, { title: `B event ${RUN}`, status: 'backlog' });
const rb = await until('2 社目の見回り', () => tick(B.id, SB).created, 60000);
const roundB = ok('GET', `/issues/${rb.id}`);
assert.doesNotMatch(roundB.description, new RegExp(secretWord), '1 社目の出来事が 2 社目に出ない');
assert.doesNotMatch(roundB.description, new RegExp(pref), '1 社目の返事が 2 社目に出ない');
assert.equal(rounds(B.id).length, 1);
assert.equal(tick(B.id, SA).created, null, '別の会社の秘書は使わない');
log('2 社目に出ない');

await until('2 社目の秘書が答える（run の途中で会社を消さない）', () => ok('GET', `/issues/${rb.id}`).status === 'done', 180000);
// 片付け: 専用の会社の担当を止め、会社を消す（後ろの CI の段は会社が 1 社であることを確かめる・limits の e2e）
for (const id of [SA, SB]) core('POST', `/agents/${id}/pause`, {});
for (const co of [A, B]) deleteCompany((m, p) => { const r = core(m, p); return { status: r.s, text: r.t }; }, co.id);
assert.equal(list(ok('GET', '/companies')).filter(c => [A.id, B.id].includes(c.id)).length, 0, '専用の会社が残らない');
console.log(`ok ${LANG}: secretary e2e`);
