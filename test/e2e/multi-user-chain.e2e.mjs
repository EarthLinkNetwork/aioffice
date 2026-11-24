// まっさらな container で、ログインのある形の office に 3 人（持ち主・課長 A・担当 B）を入れ、多段の承認（B → A → 持ち主 → A → B）を通す
// 設計 docs/design/2026-11-23-public-office-multi-user.md 2.3・2.5 と、受け入れ台帳 issue-parity-approval-chain-v1 の m10
// 使い方: node test/e2e/multi-user-chain.e2e.mjs <container の名前> <起動係の URL>（container は image をまっさらな volume で起こした直後）
// 持ち主・A・B の操作はすべて起動係の中継（ブラウザと同じ道）で行う。担当の鍵の呼び出しだけ container の中の本体へ（中継は authorization を捨てる・2.2）
import assert from 'node:assert/strict';
import { dockerSync } from './docker.mjs';

const NAME = process.argv[2] || 'aioffice', B = process.argv[3] || 'http://127.0.0.1:3100';
const sleep = ms => new Promise(r => setTimeout(r, ms));
const dexec = (...a) => String(dockerSync(['exec', NAME, ...a], { encoding: 'utf8' }));
function who() {
  const jar = {};
  return async (m, p, b) => {
    const h = { origin: B, 'content-type': 'application/json' };
    if (Object.keys(jar).length) h.cookie = Object.entries(jar).map(([k, v]) => `${k}=${v}`).join('; ');
    const r = await fetch(B + p, { method: m, headers: h, body: b ? JSON.stringify(b) : undefined, redirect: 'manual' });
    for (const c of r.headers.getSetCookie()) { const [kv] = c.split(';'); const i = kv.indexOf('='); jar[kv.slice(0, i)] = kv.slice(i + 1); }
    const t = await r.text(); let j = null; try { j = JSON.parse(t); } catch { j = t.slice(0, 300); }
    return { status: r.status, body: j };
  };
}
const list = b => (Array.isArray(b) ? b : b?.items || b?.members || []);
const step = (n, s) => console.log(`段 ${n}: ${s}`);

async function waitStage(want, ms = 240_000) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) { try { const r = await (await fetch(`${B}/setup/api/state`)).json(); if (r.stage === want) return; } catch { /* 起動中 */ } await sleep(3000); }
  throw new Error(`段が ${want} にならない`);
}

const own = who(), a = who(), b = who();
const PW = { own: 'Owner-pass-12345', a: 'Kacho-pass-12345', b: 'Tanto-pass-12345' };

await waitStage('preclaim');
step(1, 'claim の前: code が無ければ sign-up も会社の読み出しも本体に届かない');
assert.equal((await b('POST', '/api/auth/sign-up/email', { name: 'x', email: 'x@example.test', password: PW.b })).status, 503);
assert.equal((await b('GET', '/api/companies')).status, 503);

step(2, '持ち主: docker の中の code・アカウント・claim・起動係の鍵');
const code = dexec('cat', '/data/aioffice/claim-code').trim();
assert.equal((await own('POST', '/setup/api/claim-code', { code })).status, 200);
assert.equal((await own('POST', '/api/auth/sign-up/email', { name: '持ち主', email: 'own@example.test', password: PW.own })).status, 200);
assert.equal((await own('POST', '/api/bootstrap/claim', {})).status, 200);
const key = await own('POST', '/setup/api/launcher-key');
assert.equal(key.status, 200, JSON.stringify(key.body));
await waitStage('ready');
await sleep(5000);
for (let i = 0; i < 60; i++) { if ((await own('GET', '/api/companies')).status === 200) break; await sleep(3000); } // 起こし直しの後に本体が戻るまで
assert.equal(dexec('stat', '-c', '%a', '/data/aioffice/board-key.json').trim(), '600');

step(3, '持ち主: 言語と会社（起動係の鍵で本体に作る）');
assert.equal((await own('POST', '/setup/api/lang', { lang: 'ja', timeZone: 'Asia/Tokyo' })).status, 200);
assert.equal((await own('POST', '/setup/api/company', { name: '試しの会社' })).status, 200);
const cid = list((await own('GET', '/api/companies')).body)[0].id;

step(4, '持ち主が 2 人を招き、A と B が sign-up して accept する');
for (const [p, name, email, pw] of [[a, '課長A', 'a@example.test', PW.a], [b, '担当B', 'b@example.test', PW.b]]) {
  const inv = await own('POST', '/setup/api/people/invite', { companyId: cid });
  assert.equal(inv.status, 200, JSON.stringify(inv.body));
  const token = inv.body.inviteUrl.match(/invite\/([^/?#]+)/)[1];
  assert.equal((await p('POST', '/api/auth/sign-up/email', { name, email, password: pw })).status, 200);
  const acc = await p('POST', `/api/invites/${token}/accept`, { requestType: 'human' });
  assert.ok([200, 201, 202].includes(acc.status), JSON.stringify(acc.body));
}
assert.equal((await b('GET', '/setup/api/people')).status, 403, '招かれた人は人の欄を変えられない');
// 招かれた人は、起動係の持ち主の口をどれも呼べない（独立レビュー: people と launcher-key の 2 つだけでなく、設定の口を並べて照らす）
for (const [m, p, body] of [['POST', '/setup/api/slack', { companyId: cid, url: 'https://hooks.slack.com/services/T0/B0/x' }], ['GET', '/setup/api/mail'], ['POST', '/setup/api/ai-limits', { spend: 'never' }], ['POST', '/setup/api/agents', { ids: [] }], ['POST', '/setup/api/company', { name: 'x' }], ['POST', '/setup/api/people/invite', { companyId: cid }], ['GET', '/setup/api/ai'], ['POST', '/setup/api/migrate/finish', {}]]) {
  assert.equal((await b(m, p, body)).status, 403, `招かれた人は ${m} ${p} を呼べない`);
}
assert.equal((await b('POST', '/setup/api/launcher-key')).status, 403, '招かれた人は起動係の鍵を作れない');

step(5, '持ち主が上の人を決める（B → A → 持ち主）・輪は断る');
const rows = (await own('GET', '/setup/api/people')).body.people;
const id = n => rows.find(r => r.name === n).userId;
const [O, A, Bu] = [id('持ち主'), id('課長A'), id('担当B')];
assert.equal((await own('POST', '/setup/api/people', { userId: Bu, boss: A, title: '担当' })).status, 200);
assert.equal((await own('POST', '/setup/api/people', { userId: A, boss: O, title: '課長', mailConfirmed: true })).status, 200);
assert.equal((await own('POST', '/setup/api/people', { userId: O, boss: Bu })).body.error, 'boss_loop');
// relay が本体に入り終わる前の保存は、起動係の毎分の見回りが後で書く（最長 1 分と少し待つ）
let cfg = {};
for (let i = 0; i < 40; i++) { cfg = (await own('GET', `/api/plugins/aioffice.relay/config?companyId=${cid}`)).body?.configJson || {}; if (cfg.approvers?.[A]) break; await sleep(3000); }
assert.deepEqual(cfg.approvers, { [Bu]: A, [A]: O });
assert.equal(cfg.defaultRequester, O);
assert.deepEqual(cfg.ownerUserIds, [O, 'local-board'], '起動係が持ち主を plugin の設定に書く');

step('5b', '招かれた人は plugin の持ち主だけの口を呼べない・member の口は呼べる（設計 2.2b）');
for (let i = 0; i < 40; i++) { if ((await own('GET', `/api/plugins/aioffice.notify/api/settings?companyId=${cid}`)).status === 200) break; await sleep(3000); }
assert.equal((await own('GET', `/api/plugins/aioffice.notify/api/settings?companyId=${cid}`)).status, 200);
assert.equal((await b('GET', `/api/plugins/aioffice.notify/api/settings?companyId=${cid}`)).status, 403);
assert.equal((await b('POST', `/api/plugins/aioffice.relay/api/tick?companyId=${cid}`, {})).status, 403);
assert.equal((await b('POST', `/api/plugins/aioffice.library/api/tick?companyId=${cid}`, {})).status, 403);
// 設計 2.2b が名指しした持ち主の口（独立レビュー: 照らしていない守り）
for (const p of ['aioffice.notify/api/tick', 'aioffice.notify/api/deliver', 'aioffice.notify/api/limit/resume', 'aioffice.library/api/documents']) {
  assert.equal((await b('POST', `/api/plugins/${p}?companyId=${cid}`, {})).status, 403, `招かれた人は ${p} を呼べない`);
}
assert.equal((await b('GET', `/api/plugins/aioffice.notify/api/notices?companyId=${cid}`)).status, 200);

step(6, 'B が課題を作り、担当がその課題から承認を回す（宛先を書かない＝上の人の列）');
const x = (await b('POST', `/api/companies/${cid}/issues`, { title: '[試験] 交通費の承認', status: 'todo' })).body;
assert.ok(x?.id, JSON.stringify(x));
const ag = (await own('POST', `/api/companies/${cid}/agents`, { name: '試しの担当', role: 'general', adapterType: 'codex_local', adapterConfig: { engine: 'cli' } })).body;
const ak = (await own('POST', `/api/agents/${ag.id}/keys`, { name: 'e2e' })).body;
const req = JSON.parse(dexec('node', '-e', `fetch('http://127.0.0.1:3101' + ${JSON.stringify('/api/plugins/aioffice.relay/api/v1/issues/:issueId/requests'.replace(':issueId', x.id))},{method:'POST',headers:{authorization:'Bearer '+process.env.K,'content-type':'application/json'},body:JSON.stringify({kind:'approval',title:'交通費 3,200 円の承認',body:'試験です'})}).then(r=>r.text()).then(t=>console.log(JSON.stringify({s:0,t})))`.replace('process.env.K', JSON.stringify(ak.token))));
const reqBody = JSON.parse(req.t);
assert.ok(reqBody.requestId, req.t);
await own('DELETE', `/api/agents/${ag.id}/keys/${ak.id}`);

const tick = async () => assert.equal((await own('POST', `/api/plugins/aioffice.relay/api/tick?companyId=${cid}`, {})).status, 200);
async function myStep(p, userId) {
  // 答えを読む回と次の人に届ける回は別の tick（relay の worker）。届くまで 4 回まで回す
  let ys = [];
  for (let i = 0; i < 4 && ys.length === 0; i++) {
    await tick();
    ys = list((await own('GET', `/api/companies/${cid}/issues?originKind=plugin%3Aaioffice.relay`)).body).filter(i => i.originId?.startsWith(reqBody.requestId) && i.assigneeUserId === userId && i.status !== 'done' && i.status !== 'cancelled' && i.status !== 'blocked');
  }
  assert.equal(ys.length, 1, `宛先の課題が 1 つ（${userId}）`);
  const its = list((await p('GET', `/api/issues/${ys[0].id}/interactions`)).body).filter(i => i.status === 'pending');
  assert.equal(its.length, 1);
  return { y: ys[0], it: its[0] };
}
step(7, 'A に課題と承認の口ができ、A の受信箱（attention）に出る・B と持ち主は答えられない');
let s = await myStep(a, A);
const att = (await a('GET', `/api/companies/${cid}/attention`));
assert.equal(att.status, 200);
assert.ok(JSON.stringify(att.body).includes(s.y.id), 'A の attention に出る');
assert.notEqual((await b('POST', `/api/issues/${s.y.id}/interactions/${s.it.id}/accept`, {})).status, 200, 'B は答えられない');
assert.equal((await a('POST', `/api/issues/${s.y.id}/interactions/${s.it.id}/accept`, { reason: '妥当です' })).status, 200);
step(8, '持ち主に回り、持ち主が承認する');
s = await myStep(own, O);
assert.equal((await own('POST', `/api/issues/${s.y.id}/interactions/${s.it.id}/accept`, { reason: '承認' })).status, 200);
step(9, 'A に戻りの確かめが来て、A が確かめる');
s = await myStep(a, A);
assert.equal((await a('POST', `/api/issues/${s.y.id}/interactions/${s.it.id}/accept`, {})).status, 200);
step(10, '元の課題に結果が戻る');
await tick(); await tick();
const xc = list((await b('GET', `/api/issues/${x.id}/comments`)).body).map(c => c.body || '').join('\n');
assert.match(xc, /承認/, '元の課題に結果の comment');
const xs = (await b('GET', `/api/issues/${x.id}`)).body;
console.log('元の課題', xs.identifier, xs.status);
console.log('ok: 3 人の多段の承認（B → A → 持ち主 → A → B）が、ログインのある形のまっさらな office で通った');

// 11. 画面: 持ち主の office に「人」の欄があり招待の URL が出る・招かれた人の office には出ない（PLAYWRIGHT_MODULE がある時だけ）
if (process.env.PLAYWRIGHT_MODULE) {
  step(11, '画面: 人の欄は持ち主だけ');
  const { chromium } = await import(process.env.PLAYWRIGHT_MODULE);
  const browser = await chromium.launch();
  const prefix = list((await own('GET', '/api/companies')).body)[0].issuePrefix;
  // B に割り当てた課題を 1 つ作る（受信箱の「自分宛て」: B には出て、持ち主には出ない・2 回目のレビュー 高 2）
  const forB = await own('POST', `/api/companies/${cid}/issues`, { title: '[試験] B に回った件', status: 'todo', assigneeUserId: Bu });
  assert.ok(forB.body?.id, JSON.stringify(forB.body));
  const office = async (email, pw) => {
    const ctx = await browser.newContext({ baseURL: B }); const page = await ctx.newPage();
    const r = await page.request.post('/api/auth/sign-in/email', { data: { email, password: pw }, headers: { origin: B } });
    assert.equal(r.status(), 200);
    await page.goto(`/${encodeURIComponent(prefix)}/office`); await page.waitForSelector('[data-open="inbox"]', { timeout: 120_000 });
    return page;
  };
  const po = await office('own@example.test', PW.own);
  // ログイン中の人（get-session）を読み終えると部屋の名前が替わる。読み終える前の既定の名前を読まないよう、替わるまで待つ
  await po.locator('[data-room="ceo"]', { hasText: /持ち主 の部屋/ }).first().waitFor({ timeout: 60_000 }).catch(() => {});
  assert.match(await po.locator('[data-room="ceo"]').first().innerText(), /持ち主 の部屋/, '持ち主の部屋はログイン中の人の名前「{name} の部屋」（既定の「持ち主の部屋」と区別する・設計 2.7）');
  await po.click('[data-open="inbox"]');
  await po.waitForSelector('[data-inbox-scope="mine"]');
  assert.equal(await po.locator('[data-scope="all"]').count(), 1, '受信箱に自分宛て・全部の切り替え');
  assert.equal(await po.locator(`[data-my-issue="${forB.body.id}"]`).count(), 0, 'B に割り当てた課題は持ち主の「自分宛て」に出ない');
  await po.click('[data-close]');
  await po.click('[data-open="staff"]');
  await po.waitForSelector('[data-person]');
  assert.equal(await po.locator('[data-staff-trust]').count(), 1, '招くのは信頼できる人だけ・http の注意');
  assert.equal(await po.locator('[data-person]').count(), 3, '3 人が並ぶ');
  await po.click('[data-staff-invite]');
  assert.match(await po.locator('[data-staff-invite-url]').innerText(), /\/invite\//);
  const pb = await office('b@example.test', PW.b);
  assert.equal(await pb.locator('[data-open="staff"]').count(), 0, '招かれた人には人の欄が出ない');
  await pb.click('[data-open="inbox"]');
  await pb.waitForSelector(`[data-my-issue="${forB.body.id}"]`, { timeout: 60_000 });
  assert.equal(await pb.locator('[data-approval], [data-decision]').count(), 0, '招かれた人の「自分宛て」に持ち主宛ての承認と判断は出ない');
  await browser.close();
  console.log('ok: 画面の人の欄');
}
