// 起動係のメールの係の試験（lib/mail.mjs と server.mjs の口・見回りの組み込み）。範囲: docs/review/2026-11-19-mail-notify-scope.md の r2「確かめ方」と r3 の 1〜4・9・10・12・13
// 本体・知らせの plugin は偽物、受け口は偽の受け口（test/e2e/mail-fake.mjs）。本物の Gmail には 1 度も触れない
import test from 'node:test';
import assert from 'node:assert/strict';
import tls from 'node:tls';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { createFakeSmtp } from './e2e/mail-fake.mjs';
import { createMailer, MAIL_LIMITS } from '../packages/aioffice/launcher/lib/mail.mjs';
import { sendGmail, messageIdFor } from '../packages/aioffice/launcher/lib/smtp.mjs';
import { mailPreviewHash, mailFingerprint, nextUtcMidnight, utcDay, htmlFromText, MAIL_FORMAT_VERSION } from '../packages/aioffice/launcher/lib/mail-core.mjs';
import { openStore } from '../packages/aioffice/launcher/lib/state.mjs';
import { createRounds } from '../packages/aioffice/launcher/lib/rounds.mjs';
import { createLauncher } from '../packages/aioffice/launcher/server.mjs';
import { hashPassword, issueCookie } from '../packages/aioffice/launcher/lib/guard.mjs';
import { mailMessage, mailPreviewMessages, testMail } from '../plugins/notify/src/mail.mjs';
import { noticeKey } from '../plugins/notify/src/lib.mjs';

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'aio-lmail-'));
const certDir = tmp();
execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', `${certDir}/k.pem`, '-out', `${certDir}/c.pem`, '-subj', '/CN=smtp.gmail.com', '-days', '2'], { stdio: 'ignore' });
const KEY = fs.readFileSync(`${certDir}/k.pem`), CERT = fs.readFileSync(`${certDir}/c.pem`);

const ADDR = 'owner.test@gmail.com', PW = 'qwertyuiopasdfgh', ADDR_B = 'second.test@gmail.com', PW_B = 'zxcvbnmlkjhgfdsa';
const OFFICE = 'http://localhost:3100/ACM/office';
const T0 = Date.parse('2026-11-19T09:00:00Z');
const iso = ms => new Date(ms).toISOString();
const hex32 = s => noticeKey('t', s);

// 偽の知らせの plugin: 取り出し待ちの行を会社ごとに持ち、呼び出しと結果を全部覚える
function fakeNotify() {
  const f = { calls: [], results: [], rows: {}, failPending: false, failResult: false, formatVersion: MAIL_FORMAT_VERSION };
  f.route = async (method, p, cid, { query = {}, body } = {}) => {
    f.calls.push({ method, p, cid, query, body });
    if (p === 'mail/pending') { if (f.failPending) throw new Error('down'); return { v: 1, formatVersion: f.formatVersion, rows: f.rows[cid] || [] }; }
    if (p === 'mail/result') { if (f.failResult) throw new Error('down'); f.results.push({ cid, ...body }); return { v: 1 }; }
    if (p === 'mail/preview') { const c = { kinds: query.kinds.split(','), form: query.form, lang: query.lang, officeUrl: query.officeUrl }; return { v: 1, formatVersion: f.formatVersion, messages: mailPreviewMessages({ ...c, notices: [] }), test: testMail(c.lang, c.officeUrl) }; }
    if (p === 'mail') return { v: 1, waiting: (f.rows[cid] || []).length };
    throw new Error(`unknown ${p}`);
  };
  f.pendingCalls = () => f.calls.filter(c => c.p === 'mail/pending');
  return f;
}
const mkRow = (kind, title, createdAt, over = {}) => ({ id: hex32(`${kind}${title}${createdAt}`), kind, createdAt: iso(createdAt), attempts: 0, ...mailMessage({ type: 'notice', lang: 'en', form: 'titles', kind, items: [{ kind, title }] }, OFFICE), ...over });
const digestRow = (createdAt, n = 2) => ({ id: hex32(`digest${createdAt}`), kind: 'digest', createdAt: iso(createdAt), attempts: 0, ...mailMessage({ type: 'digest', lang: 'en', form: 'titles', slot: 'am', items: Array.from({ length: n }, (_, i) => ({ kind: 'approval', title: `d${i}` })) }, OFFICE) });

async function rig({ start = T0 + 60_000 } = {}) {
  const dir = tmp(), store = openStore(path.join(dir, 'aioffice')), notify = fakeNotify(), fake = createFakeSmtp({ key: KEY, cert: CERT });
  const port = await fake.listen();
  let clock = start; const logs = [], connects = [], peek = [];
  const connect = opts => { connects.push(opts); return tls.connect({ host: '127.0.0.1', port, servername: opts.servername, ca: CERT, checkServerIdentity: () => undefined, minVersion: opts.minVersion, rejectUnauthorized: opts.rejectUnauthorized }); };
  const m = createMailer({ store, notifyRoute: notify.route, companyOk: async cid => !/^nope/.test(cid), now: () => clock, send: (args, seam) => sendGmail({ ...args, before: async () => { await args.before(); peek.push({ events: [...fake.state.events], inflight: store.get().mail?.c1?.inflight ?? null }); } }, seam), sendSeam: { connect, env: {} }, log: l => logs.push(l) });
  const r = {
    dir, store, notify, fake, m, logs, connects, peek, stateFile: path.join(dir, 'aioffice', 'state.json'),
    get clock() { return clock; }, set clock(v) { clock = v; }, tick: ms => { clock += ms; },
    st: cid => store.get().mail?.[cid],
    // 保存して、見本の hash を作って ON にする（画面の「この形で ON にする」と同じ道）
    async on(cid, { addr = ADDR, pw = PW, kinds = ['approval', 'digest'], form = 'titles', lang = 'en' } = {}) {
      assert.equal((await m.save(cid, { addr, pw }))[0], 200);
      const hash = mailPreviewHash({ fp: mailFingerprint({ addr, pw }), kinds, form, lang, officeUrl: OFFICE });
      const [s, b] = m.confirm(cid, { kinds, form, previewHash: hash, lang, officeUrl: OFFICE }); assert.equal(s, 200, JSON.stringify(b));
      return b.onAt;
    },
    round: (cids = ['c1']) => m.round(cids.map(id => ({ id }))),
    close: () => fake.close(),
  };
  return r;
}
const everywhere = r => [JSON.stringify(r.logs), JSON.stringify(r.notify.calls), JSON.stringify(r.notify.results)].join('\n');

test('保存: 形の合わないアドレス・パスワードは断り、state に何も残さず、返事に入力の文字を返さない', async () => {
  const r = await rig();
  try {
    for (const addr of ['bad', 'a@gmail.com\nBcc: x@y.test', 'a@gmail.com,b@gmail.com', 'a@gmail.com;b@gmail.com', '"x" <a@gmail.com>', 'a b@gmail.com', '']) { const [s, b] = await r.m.save('c1', { addr, pw: PW }); assert.equal(s, 400); assert.equal(b.error, 'mail_addr_bad'); assert.ok(!JSON.stringify(b).includes(PW)); }
    for (const pw of ['short', 'UPPERCASEPASSWRD', 'qwertyuiopasdfg1', 'qwertyuiopasdfghj', '', null, 5]) { const [s, b] = await r.m.save('c1', { addr: ADDR, pw }); assert.equal(s, 400); assert.equal(b.error, 'mail_pass_bad'); assert.ok(!JSON.stringify(b).includes(ADDR)); }
    assert.equal((await r.m.save('nope1', { addr: ADDR, pw: PW }))[0], 404, '知らない会社');
    assert.equal(r.st('c1'), undefined); assert.equal(r.fake.state.connections, 0);
    const [s, b] = await r.m.save('c1', { addr: `  ${ADDR} `, pw: 'qwer tyui opas dfgh' }); // 前後の空白・パスワードの空白は許す
    assert.equal(s, 200); assert.deepEqual(Object.keys(b.saved).sort(), ['masked', 'savedAt']); assert.equal(b.saved.masked, 'o***@gmail.com');
    assert.equal(r.st('c1').pw, PW); assert.equal(r.st('c1').addr, ADDR);
    const view = JSON.stringify(await r.m.view('c1'));
    assert.ok(!view.includes(PW) && !view.includes(ADDR) && !view.includes('owner.test') && view.includes('o***@gmail.com'), view);
    assert.equal(fs.statSync(r.stateFile).mode & 0o777, 0o600, 'アドレスとパスワードの置き場は mode 600');
  } finally { await r.close(); }
});

test('OFF・未保存・保存し直し・hash 違い・指紋違いの時は、接続を開かず notify にも聞かない（偽の tls 接続 0 回）', async () => {
  const r = await rig(); r.notify.rows.c1 = [mkRow('approval', 'a', T0 + 1000)];
  try {
    await r.round(); assert.equal(r.connects.length, 0, '未保存'); assert.equal(r.notify.pendingCalls().length, 0);
    await r.m.save('c1', { addr: ADDR, pw: PW }); await r.round(); assert.equal(r.connects.length, 0, '保存しただけ（ON にしていない）'); assert.equal(r.notify.pendingCalls().length, 0);
    await r.on('c1'); r.m.off('c1'); await r.round(); assert.equal(r.connects.length, 0, 'OFF'); assert.equal(r.notify.pendingCalls().length, 0);
    await r.on('c1'); r.store.update(x => { x.mail.c1.hash = 'f'.repeat(32); }); await r.round(); assert.equal(r.connects.length, 0, 'hash 違い'); assert.equal(r.notify.pendingCalls().length, 0);
    assert.equal((await r.m.view('c1')).stale, true, '欄に「見本を見直して」');
    await r.on('c1'); r.store.update(x => { x.mail.c1.fp = 'e'.repeat(16); }); await r.round(); assert.equal(r.connects.length, 0, '指紋違い');
    await r.on('c1'); r.store.update(x => { x.mail.c1.pw = 'abcdefghijklmnop'; }); await r.round(); assert.equal(r.connects.length, 0, '保存の後に中身だけが替わった（指紋と合わない）');
    // 保存し直したら OFF（パスワードだけ替えても・アドレスだけ替えても）
    await r.on('c1'); await r.m.save('c1', { addr: ADDR, pw: PW_B }); assert.equal(r.st('c1').on, false); assert.equal(r.st('c1').offReason, 'resaved'); await r.round(); assert.equal(r.connects.length, 0, 'パスワードを保存し直した');
    await r.on('c1'); await r.m.save('c1', { addr: ADDR_B, pw: PW }); assert.equal(r.st('c1').on, false, 'アドレスを保存し直した'); await r.round(); assert.equal(r.connects.length, 0);
    r.m.remove('c1'); await r.round(); assert.equal(r.connects.length, 0, '消した'); assert.equal(r.st('c1'), undefined);
    assert.equal(r.fake.state.connections, 0); assert.equal(r.notify.pendingCalls().length, 0);
  } finally { await r.close(); }
});

test('confirm: 見本の hash が合う時だけ ON・古い見本・知らない言語・office の URL・未保存は断る', async () => {
  const r = await rig();
  try {
    assert.equal(r.m.confirm('c1', { kinds: ['digest'], form: 'titles', previewHash: 'a'.repeat(32), lang: 'en', officeUrl: OFFICE })[1].error, 'mail_no_dest', '未保存');
    await r.m.save('c1', { addr: ADDR, pw: PW });
    const fp = mailFingerprint({ addr: ADDR, pw: PW }), good = mailPreviewHash({ fp, kinds: ['digest'], form: 'titles', lang: 'en', officeUrl: OFFICE });
    assert.equal(r.m.confirm('c1', { kinds: ['digest'], form: 'titles', previewHash: mailPreviewHash({ fp, kinds: ['digest', 'approval'], form: 'titles', lang: 'en', officeUrl: OFFICE }), lang: 'en', officeUrl: OFFICE })[1].error, 'mail_preview_stale', '種類を変えた後の古い見本');
    assert.equal(r.m.confirm('c1', { kinds: ['digest'], form: 'counts', previewHash: good, lang: 'en', officeUrl: OFFICE })[1].error, 'mail_preview_stale');
    for (const over of [{ lang: 'fr' }, { officeUrl: 'javascript:1' }, { previewHash: 'zz' }, { kinds: ['nope'] }, { form: 'x' }]) assert.equal(r.m.confirm('c1', { kinds: ['digest'], form: 'titles', previewHash: good, lang: 'en', officeUrl: OFFICE, ...over })[0], 400, JSON.stringify(over));
    assert.equal(r.st('c1').on, false);
    assert.equal(r.m.confirm('c1', { kinds: ['digest'], form: 'titles', previewHash: good, lang: 'en', officeUrl: OFFICE })[0], 200);
    assert.equal(r.st('c1').on, true); assert.equal(r.st('c1').onAt, iso(r.clock));
  } finally { await r.close(); }
});

test('送り: ON の会社だけ・notify へは onAt と選びだけを渡し（宛先とパスワードは渡さない）・From と To は同じ 1 つ・RCPT は 1 つ・結果を返す', async () => {
  const r = await rig(); const onAt = await r.on('c1'); r.tick(5000);
  r.notify.rows.c1 = [mkRow('approval', 'Price list', r.clock - 1000), digestRow(r.clock - 500)];
  try {
    const out = await r.round();
    assert.deepEqual(out.c1, { sent: 2, skippedBad: 0 });
    const q = r.notify.pendingCalls()[0].query; assert.deepEqual(q, { onAt, kinds: 'digest,approval', form: 'titles', lang: 'en', officeUrl: OFFICE, limit: '3' });
    assert.equal(r.fake.state.got.length, 2); assert.equal(r.fake.state.connections, 2);
    for (const g of r.fake.state.got) { assert.deepEqual(g.cmds.filter(c => c.startsWith('RCPT')), [`RCPT TO:<${ADDR}>`]); assert.equal(g.authUser, ADDR); assert.match(g.data, new RegExp(`^From: <${ADDR.replace('.', '\\.')}>\\r\\nTo: <${ADDR.replace('.', '\\.')}>\\r\\n`)); assert.ok(!/^(Cc|Bcc|Reply-To):/im.test(g.data.split('\r\n\r\n')[0])); }
    assert.equal(r.fake.state.got[0].data.match(/^Message-ID: (.*)$/m)[1], messageIdFor('c1', r.notify.rows.c1[0].id));
    assert.deepEqual(r.notify.results.map(x => [x.id, x.result, x.code]), r.notify.rows.c1.map(x => [x.id, 'sent', 'ok']));
    const st = r.st('c1'); assert.equal(st.day.n, 2); assert.equal(st.day.date, utcDay(r.clock)); assert.equal(st.hour.n, 1, '1 時間の数に入るのはすぐの知らせだけ'); assert.equal(st.lastOkAt, iso(r.clock)); assert.deepEqual(st.inflight, {});
    const all = everywhere(r); assert.ok(!all.includes(PW) && !all.includes(ADDR), 'notify への呼び出し・結果・ログにアドレスとパスワードが無い');
    // 同じ行を notify が返し続けても、結果が sent なら notify が出さない（ここでは偽なので出る）。送りは行ごとに 1 回ずつ
    r.notify.rows.c1 = [];
    await r.round(); assert.equal(r.fake.state.got.length, 2);
  } finally { await r.close(); }
});

test('枠: 1 回の見回りで 3 通・1 時間 20 通（超えた分は overflow の結果で notify に返す）・1 日 50 通', async () => {
  const r = await rig(); await r.on('c1'); r.tick(5000);
  try {
    r.notify.rows.c1 = Array.from({ length: 5 }, (_, i) => mkRow('approval', `n${i}`, r.clock - 1000 + i));
    assert.equal((await r.round()).c1.sent, 3, '1 回に 3 通まで'); assert.equal(r.fake.state.got.length, 3);
    // 1 時間 20 通: すぐの知らせは overflow・まとめは通る
    r.fake.reset(); r.notify.results.length = 0; r.store.update(x => { x.mail.c1.hour = { start: r.clock - 1000, n: MAIL_LIMITS.perHour }; });
    r.notify.rows.c1 = [mkRow('approval', 'over', r.clock - 100), digestRow(r.clock - 50)];
    const out = await r.round(); assert.equal(out.c1.sent, 1); assert.equal(r.fake.state.got.length, 1); assert.match(r.fake.state.got[0].data, /Subject: \[AI Office\] Morning summary/);
    assert.deepEqual(r.notify.results.map(x => x.result), ['overflow', 'sent']); assert.equal(r.notify.results[0].code, 'hour_limit');
    // 1 時間たつと数え直す
    r.tick(3600_000 + 1); r.fake.reset(); r.notify.rows.c1 = [mkRow('approval', 'again', r.clock - 100)]; assert.equal((await r.round()).c1.sent, 1);
    // 1 日 50 通: 49 の時に 1 通・その次は notify にも聞かない・UTC の日が変わると数え直す
    r.fake.reset(); r.store.update(x => { x.mail.c1.day = { date: utcDay(r.clock), n: 49 }; x.mail.c1.hour = null; });
    r.notify.rows.c1 = [mkRow('approval', 'a50', r.clock - 100), mkRow('approval', 'a51', r.clock - 99)];
    assert.equal((await r.round()).c1.sent, 1); assert.equal(r.fake.state.got.length, 1, '50 通目で止まる'); assert.equal(r.st('c1').day.n, 50);
    const calls = r.notify.pendingCalls().length;
    assert.deepEqual((await r.round()).c1, { skip: 'day_full' }); assert.equal(r.notify.pendingCalls().length, calls, '上限の日は notify にも聞かない'); assert.equal(r.fake.state.got.length, 1);
    r.clock = nextUtcMidnight(r.clock) + 1000; r.notify.rows.c1 = [mkRow('approval', 'next day', r.clock - 100)]; assert.equal((await r.round()).c1.sent, 1, '翌日は数え直す');
  } finally { await r.close(); }
});

test('答えの表: 535 は OFF（auth_failed）・550 5.1.1 は OFF（rejected）・5.4.5 は今日は送らず翌日に再開・4xx はやり直し・5.6.x はその 1 通だけ捨てて ON のまま', async () => {
  const r = await rig(); await r.on('c1'); r.tick(5000);
  const row = (t, extra = 0) => mkRow('approval', t, r.clock - 1000 + extra);
  try {
    // 535
    r.fake.setMode({ auth: '535-5.7.8 Username and Password not accepted\r\n535 5.7.8 https://support.google.com/mail/?p=BadCredentials secret-text' });
    r.notify.rows.c1 = [row('a1'), row('a2', 1)];
    await r.round(); let st = r.st('c1');
    assert.equal(st.on, false); assert.equal(st.offReason, 'dead'); assert.equal(st.offCode, 'auth_failed'); assert.equal(st.lastFail.status, 535); assert.equal(st.lastFail.ext, '5.7.8');
    assert.equal(r.fake.state.connections, 1, 'OFF にしたら残りは送らない'); assert.deepEqual(r.notify.results.map(x => [x.result, x.code, x.ext]), [['dead', 'auth_failed', '5.7.8']]);
    await r.round(); assert.equal(r.fake.state.connections, 1, '止まった後は接続しない');
    let v = await r.m.view('c1'); assert.deepEqual([v.on, v.offReason, v.offCode], [false, 'dead', 'auth_failed']); assert.ok(!JSON.stringify(v).includes('secret-text'), '答えの本文を画面に出さない');
    assert.ok(r.logs.some(l => /mail dead auth_failed 535 5\.7\.8/.test(l)) && !r.logs.join('\n').includes('secret-text'), 'ログは code と印だけ');
    // 550 5.1.1
    await r.on('c1'); r.tick(5000); r.fake.reset(); r.notify.results.length = 0; r.fake.setMode({ rcpt: '550 5.1.1 no such user secret-rcpt' }); r.notify.rows.c1 = [row('b1')];
    await r.round(); st = r.st('c1'); assert.deepEqual([st.on, st.offReason, st.offCode], [false, 'dead', 'rejected']);
    // 5.4.5: 今日は送らない
    await r.on('c1'); r.tick(5000); r.fake.reset(); r.notify.results.length = 0; r.fake.setMode({ end: '550 5.4.5 Daily user sending limit exceeded. secret-day' }); r.notify.rows.c1 = [row('c1'), row('c2', 1)];
    await r.round(); st = r.st('c1'); assert.equal(st.on, true, '上限は OFF にしない'); assert.equal(st.dayBlockedUntil, nextUtcMidnight(r.clock)); assert.equal(r.fake.state.connections, 1);
    assert.deepEqual(r.notify.results.map(x => [x.result, x.code, x.ext]), [['hold', 'day_limit', '5.4.5']]);
    const calls = r.notify.pendingCalls().length; await r.round(); assert.equal(r.notify.pendingCalls().length, calls, 'その日は notify にも聞かない'); assert.equal((await r.m.view('c1')).dayBlocked, true);
    r.fake.setMode({}); r.clock = nextUtcMidnight(r.clock) + 1; r.notify.rows.c1 = [mkRow('approval', 'tomorrow', r.clock - 100)]; assert.equal((await r.round()).c1.sent, 1, '翌日の 0 時（UTC）に再開');
    // 421 → やり直し（OFF にしない・結果は retry）
    r.fake.reset(); r.notify.results.length = 0; r.fake.setMode({ greeting: '421 4.7.0 try later secret-421' }); r.notify.rows.c1 = [mkRow('approval', 'r1', r.clock - 100)];
    await r.round(); st = r.st('c1'); assert.equal(st.on, true); assert.equal(st.failStreak, 1); assert.deepEqual(r.notify.results.map(x => [x.result, x.code, x.ext]), [['retry', 'temp', '4.7.0']]);
    // 5.6.1 → その 1 通だけ捨てて、次の行は送る
    r.fake.reset(); r.notify.results.length = 0; r.fake.setMode({ end: '552 5.6.1 message content rejected secret-content' }); r.notify.rows.c1 = [mkRow('approval', 'x1', r.clock - 100), mkRow('approval', 'x2', r.clock - 99)];
    await r.round(); assert.equal(r.st('c1').on, true); assert.deepEqual(r.notify.results.map(x => x.result), ['drop', 'drop']); assert.equal(r.fake.state.connections, 2, '続けて次の行へ');
    // 成功すると続けての失敗の数が戻る
    r.fake.reset(); r.fake.setMode({}); r.notify.rows.c1 = [mkRow('approval', 'ok1', r.clock - 100)]; await r.round(); assert.equal(r.st('c1').failStreak, 0);
    const all = everywhere(r) + JSON.stringify(await r.m.view('c1')); for (const s of [PW, ADDR, 'secret-text', 'secret-rcpt', 'secret-day', 'secret-421', 'secret-content']) assert.ok(!all.includes(s), `${s} がログ・結果・画面に出ない`);
  } finally { await r.close(); }
});

test('偽の notify が悪い物を返す表: 改行入りの件名・長すぎる本文・別の href・古い createdAt・選んでいない種類 → 送らずに数え、bad の結果を返す', async () => {
  const r = await rig(); await r.on('c1', { kinds: ['approval'] }); r.tick(5000);
  const good = () => mkRow('approval', 'good', r.clock - 1000);
  const bads = {
    subject_ctl: { ...good(), subject: '[AI Office] Approval waiting\r\nBcc: attacker@example.com' },
    subject_form: { ...good(), subject: 'Hello from AI' },
    subject_prefix: { ...good(), subject: '[AI Office] Approval waiting now with extra' },
    text_long: { ...good(), text: 'x'.repeat(8001) }, html_long: { ...good(), html: `<a href="${OFFICE}">x</a>${'y'.repeat(20_000)}` },
    href_other: { ...good(), html: good().html.replace(OFFICE, 'https://evil.example/login') },
    href_two: { ...good(), html: good().html.replace('</body>', '<a href="https://evil.example/">x</a></body>') },
    before_on: { ...good(), createdAt: iso(T0 - 1) },
    created_bad: { ...good(), createdAt: 'yesterday' },
    kind_off: mkRow('decision', 'not selected', r.clock - 1000),
    kind_unknown: { ...good(), kind: 'run_failed' },
    img: { ...good(), html: good().html.replace('</body>', '<img src="https://evil.example/t.gif"></body>') },
  };
  try {
    for (const [why, row] of Object.entries(bads)) {
      r.notify.rows.c1 = [row]; const before = r.fake.state.connections, nBad = r.st('c1').badCount || 0;
      const out = await r.round(); assert.equal(out.c1.skippedBad, 1, why); assert.equal(r.fake.state.connections, before, `${why}: 送らない`); assert.equal(r.st('c1').badCount, nBad + 1, why);
      assert.deepEqual(r.notify.results.at(-1), { cid: 'c1', id: row.id, result: 'bad', code: 'bad_mail' }, why);
    }
    // id が形に合わない物は結果も返さない（notify の表に無い id を作らせない）
    const nRes = r.notify.results.length; r.notify.rows.c1 = [{ ...good(), id: 'x\nBcc: y' }, null, 5, { ...good(), id: undefined }]; await r.round(); assert.equal(r.notify.results.length, nRes + 0 + 0, '形の悪い id には結果を返さない'); assert.equal(r.fake.state.connections, 0);
    const v = await r.m.view('c1'); assert.ok(v.badCount > 0, '欄・帯に「送らなかった文があります」');
    // 良い行は通る
    r.notify.rows.c1 = [good()]; assert.equal((await r.round()).c1.sent, 1);
    // notify の答えの形が悪い・版が違う・届かない
    r.notify.formatVersion = 99; assert.deepEqual((await r.round()).c1, { skip: 'notify_bad_answer' }); r.notify.formatVersion = MAIL_FORMAT_VERSION;
    r.notify.failPending = true; assert.deepEqual((await r.round()).c1, { skip: 'notify_unreachable' }); r.notify.failPending = false;
    assert.equal(r.fake.state.connections, 1);
  } finally { await r.close(); }
});

test('二重送り: DATA の後で切れたら「送ったかもしれない」として 1 回だけ再送し、同じ Message-ID・もう 1 回切れたら送らずに閉じる', async () => {
  const r = await rig(); await r.on('c1'); r.tick(5000);
  const row = mkRow('approval', 'dup', r.clock - 1000); r.notify.rows.c1 = [row];
  try {
    r.fake.setMode({ cut: 'end' });
    await r.round(); assert.equal(r.fake.state.got.length, 1); assert.equal(r.st('c1').inflight[row.id].n, 1, '送り中の記録が残る');
    assert.deepEqual(r.notify.results.map(x => x.result), ['retry']);
    await r.round(); assert.equal(r.fake.state.got.length, 2, '1 回だけ再送'); assert.equal(r.st('c1').inflight[row.id].n, 2);
    const ids = r.fake.state.got.map(g => g.data.match(/^Message-ID: (.*)$/m)[1]); assert.equal(ids[0], ids[1], '同じ Message-ID（受け手が見分けられる）');
    await r.round(); assert.equal(r.fake.state.got.length, 2, '3 回目は送らない'); assert.deepEqual(r.st('c1').inflight, {});
    assert.deepEqual(r.notify.results.at(-1), { cid: 'c1', id: row.id, result: 'sent', code: 'maybe' }, '送ったかもしれない物として閉じる');
    // 正常に終わると記録は残らない・DATA の前に書かれる（送りの途中の state を見る）
    r.fake.setMode({}); r.notify.rows.c1 = [mkRow('approval', 'fine', r.clock - 900)]; await r.round(); assert.deepEqual(r.st('c1').inflight, {});
  } finally { await r.close(); }
  const r2 = await rig(); await r2.on('c1'); r2.tick(5000);
  try { // 送り中の記録は DATA の前（RCPT の後）に書かれる（送りの途中で state と受け口の手順を覗く）
    r2.notify.rows.c1 = [mkRow('approval', 'order', r2.clock - 1000)];
    await r2.round();
    assert.equal(r2.peek.length, 1);
    assert.deepEqual(r2.peek[0].events, ['EHLO', 'AUTH', 'MAIL', 'RCPT'], 'DATA の前');
    assert.equal(r2.peek[0].inflight[r2.notify.rows.c1[0].id].n, 1);
  } finally { await r2.close(); }
});

test('結果が notify に届かなかった時は state に残し、次の見回りの最初に出し直す', async () => {
  const r = await rig(); await r.on('c1'); r.tick(5000);
  const row = mkRow('approval', 'unrep', r.clock - 1000); r.notify.rows.c1 = [row];
  try {
    r.notify.failResult = true; await r.round(); assert.equal(r.fake.state.got.length, 1); assert.equal(r.st('c1').unreported.length, 1); assert.equal(r.notify.results.length, 0);
    // 結果を返せないうちは、notify が同じ行を返し続けても、その会社の回をやめて二重に送らない（P2-3）
    const nCalls = r.notify.calls.length; assert.deepEqual((await r.round()).c1, { skip: 'unreported' }); assert.equal(r.fake.state.got.length, 1, '同じ行を 2 回送らない');
    assert.ok(!r.notify.calls.slice(nCalls).some(c => c.p === 'mail/pending'), '取りにも行かない'); assert.equal(r.st('c1').unreported.length, 1);
    r.notify.failResult = false; r.notify.rows.c1 = []; const n0 = r.notify.calls.length; await r.round();
    assert.deepEqual(r.notify.results.map(x => [x.id, x.result]), [[row.id, 'sent']]); assert.deepEqual(r.st('c1').unreported, []);
    assert.deepEqual(r.notify.calls.slice(n0).map(c => c.p), ['mail/result', 'mail/pending'], '出し直しが先');
  } finally { await r.close(); }
});

test('試しの 1 通: ON の時だけ・1 分に 1 回・会社の題が無い・日の数に入る・認証で失敗すると OFF', async () => {
  const r = await rig();
  try {
    await r.m.save('c1', { addr: ADDR, pw: PW }); assert.deepEqual(await r.m.test('c1'), [409, { error: 'mail_off' }]); assert.equal(r.fake.state.connections, 0, 'OFF の時は接続しない');
    await r.on('c1'); const [s, b] = await r.m.test('c1'); assert.equal(s, 200); assert.equal(b.result, 'ok');
    assert.equal(r.fake.state.got.length, 1); assert.match(r.fake.state.got[0].data, /Subject: \[AI Office\] Test message/); assert.equal(r.st('c1').day.n, 1);
    assert.equal((await r.m.test('c1'))[0], 429, '1 分に 1 回'); r.tick(61_000);
    r.fake.setMode({ auth: '535 5.7.8 nope secret-test' }); const f = await r.m.test('c1'); assert.deepEqual(f[1], { v: 1, result: 'auth_failed' });
    assert.equal(r.st('c1').on, false); assert.equal(r.st('c1').offCode, 'auth_failed');
    assert.ok(!JSON.stringify(f).includes('secret-test'));
    assert.equal(r.notify.results.length, 0, '試しは notify の結果に載せない');
  } finally { await r.close(); }
});

test('会社ごと: ON の会社だけに送り、会社 B の知らせ・B の宛先は A の送りに混ざらない・保存していない会社へは聞きにも行かない', async () => {
  const r = await rig(); await r.on('cA'); r.tick(5000); // A: ON
  await r.m.save('cB', { addr: ADDR_B, pw: PW_B }); // B: 保存だけ（OFF）
  r.notify.rows.cA = [mkRow('approval', 'A-notice', r.clock - 1000)]; r.notify.rows.cB = [mkRow('approval', 'B-notice', r.clock - 1000)]; r.notify.rows.cC = [mkRow('approval', 'C-notice', r.clock - 1000)];
  try {
    const out = await r.round(['cA', 'cB', 'cC']);
    assert.deepEqual(Object.keys(out), ['cA', 'cB', 'cC']); assert.equal(out.cA.sent, 1); assert.equal(out.cB.off, true); assert.equal(out.cC.off, true);
    assert.deepEqual(r.notify.pendingCalls().map(c => c.cid), ['cA']); assert.equal(r.fake.state.got.length, 1);
    assert.equal(r.fake.state.got[0].authUser, ADDR); assert.ok(!r.fake.state.got.some(g => g.data.includes('B-notice') || g.authUser === ADDR_B));
    // B を ON にすると B の宛先・B の知らせだけが B へ
    await r.on('cB', { addr: ADDR_B, pw: PW_B }); r.tick(1000); r.notify.rows.cA = []; r.notify.rows.cB = [mkRow('approval', 'B-notice2', r.clock - 500)]; r.fake.reset();
    await r.round(['cA', 'cB']); assert.equal(r.fake.state.got.length, 1); assert.equal(r.fake.state.got[0].authUser, ADDR_B); assert.deepEqual(r.fake.state.got[0].cmds.filter(c => c.startsWith('RCPT')), [`RCPT TO:<${ADDR_B}>`]);
    // A の OFF は B に影響しない
    r.m.off('cA'); assert.equal(r.st('cB').on, true);
  } finally { await r.close(); }
});

test('持ち主を作り直す（reset-owner）とメールの設定が全部消える（OFF・パスワードも）', async () => {
  const r = await rig();
  try {
    await r.on('c1'); assert.ok(r.st('c1').pw);
    r.store.resetOwner(); assert.deepEqual(r.store.get().mail, {}); assert.ok(!fs.readFileSync(r.stateFile, 'utf8').includes(PW), 'state にパスワードが残らない');
    await r.round(); assert.equal(r.fake.state.connections, 0);
    const bin = fs.readFileSync(new URL('../packages/aioffice/bin/aioffice-reset-owner.mjs', import.meta.url), 'utf8'); assert.match(bin, /resetOwner\(\)/);
  } finally { await r.close(); }
});

test('見回りに組み込む: 送りの後に round を呼び、記録に残すのは決まった印と数だけ・メールの失敗は見回りの遅れにしない・mail が無ければ今まで通り', async () => {
  const dir = tmp(); const calls = [];
  const fetchFn = async (url, init = {}) => { const u = new URL(url); calls.push(u.pathname); if (u.pathname === '/api/companies') return { ok: true, status: 200, json: async () => [{ id: 'c1' }, { id: 'c2' }] }; return { ok: true, status: 200, json: async () => ({ v: 1, off: true }) }; };
  const mk = (mail, d = dir) => createRounds({ pcUrl: 'http://127.0.0.1:1', dataDir: d, getState: () => ({ done: true, lang: 'en' }), installed: () => ['aioffice.notify'], fetchFn, now: () => T0, everyMs: 0, mail });
  const mailStub = { round: async cs => ({ c1: { sent: 2, off: false, skip: null }, c2: { off: true, addr: 'LEAK@example.com', skip: 'Bad Value!' } }) };
  const rec = await mk(mailStub).runOnce();
  assert.deepEqual(rec.mail, { c1: { at: iso(T0), off: false, sent: 2, skip: null }, c2: { at: iso(T0), off: true, sent: 0, skip: null } });
  assert.ok(!JSON.stringify(rec).includes('LEAK'), '記録に宛先が入らない');
  const iDeliver = calls.lastIndexOf('/api/plugins/aioffice.notify/api/deliver'); assert.ok(iDeliver > 0);
  const rec2 = await mk({ round: async () => { throw new Error('mail down'); } }, tmp()).runOnce(); assert.equal(rec2.plugins['aioffice.notify'].lastError, null, 'メールの失敗は見回りの遅れに数えない'); assert.equal(rec2.mail?.c1, undefined);
  const rec3 = await mk(null, tmp()).runOnce(); assert.equal(rec3.mail, undefined);
  assert.ok(!JSON.stringify(JSON.parse(fs.readFileSync(path.join(dir, 'rounds.json'), 'utf8'))).includes('@'), 'rounds.json にアドレスが無い');
});

// ---- server.mjs の口（cookie・返事・state）----
function fakeCore() {
  const calls = [];
  const srv = http.createServer((req, res) => {
    let b = ''; req.on('data', c => { b += c; }); req.on('end', () => {
      const u = new URL(req.url, 'http://x'); calls.push({ method: req.method, path: u.pathname, query: Object.fromEntries(u.searchParams), body: b });
      const json = (s, o) => { res.writeHead(s, { 'content-type': 'application/json' }); res.end(JSON.stringify(o)); };
      if (u.pathname === '/api/companies') return json(200, [{ id: 'c1' }]);
      if (u.pathname === '/api/companies/c1') return json(200, { id: 'c1', issuePrefix: 'ACM' });
      if (u.pathname === '/api/plugins/aioffice.notify/api/mail/preview') { const q = Object.fromEntries(u.searchParams); return json(200, { v: 1, formatVersion: MAIL_FORMAT_VERSION, messages: mailPreviewMessages({ kinds: q.kinds.split(','), form: q.form, lang: q.lang, officeUrl: q.officeUrl, notices: [] }), test: testMail(q.lang, q.officeUrl) }); }
      if (u.pathname === '/api/plugins/aioffice.notify/api/mail') return json(200, { v: 1, waiting: 0 });
      return json(404, { error: 'nope' });
    });
  });
  return { srv, calls };
}
const listen = srv => new Promise(r => srv.listen(0, '127.0.0.1', () => r(srv.address().port)));
function req(port, method, p, { body, cookie } = {}) {
  return new Promise((resolve, reject) => {
    const headers = { host: `127.0.0.1:${port}`, origin: `http://127.0.0.1:${port}` }; if (cookie) headers.cookie = cookie;
    const data = body == null ? null : JSON.stringify(body); if (data != null) { headers['content-type'] = 'application/json'; headers['content-length'] = Buffer.byteLength(data); }
    const r = http.request({ host: '127.0.0.1', port, method, path: p, headers }, res => { let t = ''; res.on('data', c => { t += c; }); res.on('end', () => { let j = null; try { j = JSON.parse(t); } catch { /* 文字 */ } resolve({ status: res.statusCode, json: j, text: t }); }); });
    r.on('error', reject); if (data != null) r.write(data); r.end();
  });
}
test('起動係の口: cookie なしは 401・返事と /state は伏せた形だけ・見本に html は無く hash が付く・ON → 試し → OFF', async () => {
  const dir = tmp(), core = fakeCore(), pcPort = await listen(core.srv), fake = createFakeSmtp({ key: KEY, cert: CERT }), smtpPort = await fake.listen();
  const connect = opts => tls.connect({ host: '127.0.0.1', port: smtpPort, servername: opts.servername, ca: CERT, checkServerIdentity: () => undefined, rejectUnauthorized: opts.rejectUnauthorized });
  const logs = []; const orig = console.log; console.log = (...a) => { logs.push(a.join(' ')); };
  const { server, store } = createLauncher({ dataDir: path.join(dir, 'aioffice'), paperclipUrl: `http://127.0.0.1:${pcPort}`, codexHome: path.join(dir, 'codex-home'), mailDeps: { sendSeam: { connect, env: {} } } });
  store.update(s => { s.owner = hashPassword('long enough'); s.generation = 1; s.lang = 'en'; s.companyId = 'c1'; s.companyPrefix = 'ACM'; s.secretaryId = 'a1'; s.done = true; });
  const port = await listen(server), cookie = issueCookie(store.secret, 1).split(';')[0];
  try {
    for (const [m, p] of [['GET', '/setup/api/mail?companyId=c1'], ['POST', '/setup/api/mail'], ['GET', '/setup/api/mail/preview?companyId=c1&kinds=digest&form=titles'], ['POST', '/setup/api/mail/confirm'], ['POST', '/setup/api/mail/off'], ['POST', '/setup/api/mail/test']])
      assert.equal((await req(port, m, p, { body: m === 'POST' ? { companyId: 'c1' } : undefined })).status, 401, `${m} ${p}: cookie なし`);
    assert.equal((await req(port, 'POST', '/setup/api/mail', { body: { companyId: 'c1', addr: 'bad', pw: PW }, cookie })).status, 400);
    assert.equal((await req(port, 'POST', '/setup/api/mail', { body: { companyId: '../x', addr: ADDR, pw: PW }, cookie })).status, 400);
    const sv = await req(port, 'POST', '/setup/api/mail', { body: { companyId: 'c1', addr: ADDR, pw: PW }, cookie });
    assert.equal(sv.status, 200); assert.equal(sv.json.saved.masked, 'o***@gmail.com'); assert.ok(!sv.text.includes(PW) && !sv.text.includes(ADDR));
    const st = await req(port, 'GET', '/setup/api/state', { cookie }); assert.deepEqual(st.json.mail.c1, { savedAt: sv.json.saved.savedAt, masked: 'o***@gmail.com' }); assert.ok(!st.text.includes(PW) && !st.text.includes(ADDR));
    const gv = await req(port, 'GET', '/setup/api/mail?companyId=c1', { cookie }); assert.equal(gv.json.saved, true); assert.equal(gv.json.on, false); assert.ok(!gv.text.includes(PW) && !gv.text.includes(ADDR));
    const pv = await req(port, 'GET', '/setup/api/mail/preview?companyId=c1&kinds=digest,approval&form=titles', { cookie });
    assert.equal(pv.status, 200); assert.match(pv.json.hash, /^[0-9a-f]{32}$/); assert.equal(pv.json.messages.length, 2); assert.deepEqual(Object.keys(pv.json.messages[0]).sort(), ['kind', 'subject', 'text']);
    assert.ok(pv.json.messages[0].text.includes(`http://127.0.0.1:${port}/ACM/office`), '開く先は持ち主が使っている起動係の住所');
    assert.equal((await req(port, 'POST', '/setup/api/mail/confirm', { body: { companyId: 'c1', kinds: ['digest', 'approval'], form: 'counts', previewHash: pv.json.hash }, cookie })).status, 409, '見本の後に形を変えると断る');
    assert.equal((await req(port, 'POST', '/setup/api/mail/test', { body: { companyId: 'c1' }, cookie })).status, 409, 'OFF の時の試しは断る');
    const on = await req(port, 'POST', '/setup/api/mail/confirm', { body: { companyId: 'c1', kinds: ['digest', 'approval'], form: 'titles', previewHash: pv.json.hash }, cookie });
    assert.equal(on.status, 200); assert.equal(on.json.on, true);
    const te = await req(port, 'POST', '/setup/api/mail/test', { body: { companyId: 'c1' }, cookie }); assert.deepEqual(te.json, { v: 1, result: 'ok' }); assert.equal(fake.state.got.length, 1);
    assert.equal((await req(port, 'POST', '/setup/api/mail/off', { body: { companyId: 'c1' }, cookie })).json.on, false); assert.equal((await req(port, 'GET', '/setup/api/mail?companyId=c1', { cookie })).json.on, false);
    for (const c of core.calls) assert.ok(!c.body.includes(PW) && !JSON.stringify(c).includes(ADDR), `本体の口に宛先・パスワードを渡さない: ${c.path}`);
    assert.ok(!logs.join('\n').includes(PW) && !logs.join('\n').includes(ADDR), '起動係のログにアドレスとパスワードが無い');
    const rm = await req(port, 'POST', '/setup/api/mail', { body: { companyId: 'c1', remove: true }, cookie }); assert.equal(rm.status, 200); assert.equal(store.get().mail.c1, undefined);
  } finally { console.log = orig; server.close(); core.srv.close(); await fake.close(); }
});

test('e2e 用の「見回りを今 1 回流す」口: CI だけの env・loopback・cookie が揃う時だけ。それ以外は 404 か 401（外から「送れ」と頼む口は無い）', async () => {
  for (const hooks of [false, true]) {
    const dir = tmp(), core = fakeCore(), pcPort = await listen(core.srv);
    const { server, store } = createLauncher({ dataDir: path.join(dir, 'aioffice'), paperclipUrl: `http://127.0.0.1:${pcPort}`, codexHome: path.join(dir, 'codex-home'), testHooks: hooks });
    store.update(s => { s.owner = hashPassword('long enough'); s.generation = 1; s.lang = 'en'; s.companyId = 'c1'; s.companyPrefix = 'ACM'; s.secretaryId = 'a1'; s.done = true; });
    const port = await listen(server), cookie = issueCookie(store.secret, 1).split(';')[0];
    try {
      const anon = await req(port, 'POST', '/setup/api/test/mail-round', { body: {} });
      const owner = await req(port, 'POST', '/setup/api/test/mail-round', { body: {}, cookie });
      if (!hooks) { assert.equal(anon.status, 404); assert.equal(owner.status, 404, '配る起動（env なし）では持ち主の cookie があっても 404'); }
      else { assert.equal(anon.status, 401); assert.equal(owner.status, 200); assert.deepEqual(owner.json, { round: { c1: { off: true } } }); }
    } finally { server.close(); core.srv.close(); }
  }
  const start = fs.readFileSync(new URL('../packages/aioffice/bin/aioffice-start.mjs', import.meta.url), 'utf8');
  assert.ok(!/test\/mail-round|MAIL_ROUND/.test(start));
});

test('配る物: Dockerfile は mail-core.mjs を plugin の build に写し、起動は mail を見回りに渡す', () => {
  const docker = fs.readFileSync(new URL('../packages/aioffice/Dockerfile', import.meta.url), 'utf8');
  assert.match(docker, /COPY packages\/aioffice\/launcher\/lib\/mail-core\.mjs \/src\/packages\/aioffice\/launcher\/lib\/mail-core\.mjs/);
  assert.ok(!/--add-host|NODE_EXTRA_CA_CERTS|AIOFFICE_CI_MAIL_TEST/.test(docker), '配る物に試験の設定が無い');
  const start = fs.readFileSync(new URL('../packages/aioffice/bin/aioffice-start.mjs', import.meta.url), 'utf8');
  assert.match(start, /const launcher = createLauncher\(/); assert.match(start, /const \{ server, store, mail \} = launcher;/); assert.match(start, /limits, mail \}\);/);
});

test('「送り中」の記録は id ごと: 別の行の送りで上書きされず、行ごとに再送は 1 回まで（P3-1）', async () => {
  const r = await rig(); await r.on('c1'); r.tick(5000);
  const a = mkRow('approval', 'rowA', r.clock - 1000), b = mkRow('approval', 'rowB', r.clock - 900);
  try {
    r.fake.setMode({ cut: 'end' }); r.notify.rows.c1 = [a, b];
    await r.round(); // 先頭の 1 行で失敗して止まる
    assert.equal(r.st('c1').inflight[a.id].n, 1);
    r.notify.rows.c1 = [b]; await r.round(); // 別の行の送りが入っても a の記録は消えない
    assert.equal(r.st('c1').inflight[a.id].n, 1); assert.equal(r.st('c1').inflight[b.id].n, 1);
    r.notify.rows.c1 = [a]; await r.round(); assert.equal(r.st('c1').inflight[a.id].n, 2, 'a の再送は 2 回目として数える');
    const n = r.fake.state.got.length; r.notify.rows.c1 = [a]; await r.round(); assert.equal(r.fake.state.got.length, n, 'a は 3 回目を送らない');
    assert.deepEqual(r.notify.results.at(-1), { cid: 'c1', id: a.id, result: 'sent', code: 'maybe' });
  } finally { await r.close(); }
});

test('DATA の前に gate と onAt を照らし直す: 接続の後に OFF・保存し直し・ON のし直しがあれば、DATA に進まず送り中の記録も書かない（P3-2）', async () => {
  for (const act of ['off', 'resave', 'reon']) {
    const r = await rig(); await r.on('c1'); r.tick(5000);
    const row = mkRow('approval', `race-${act}`, r.clock - 1000); r.notify.rows.c1 = [row];
    const base = r.m;
    // 送りの途中（RCPT の後）で state を替える: fake の RCPT の答えの前に割り込む
    r.fake.server.once('secureConnection', sock => sock.on('data', d => { if (/RCPT TO/.test(String(d))) { if (act === 'off') base.off('c1'); if (act === 'resave') r.store.update(x => { x.mail = { ...x.mail, c1: { ...x.mail.c1, fp: 'e'.repeat(16) } }; }); if (act === 'reon') r.store.update(x => { x.mail = { ...x.mail, c1: { ...x.mail.c1, onAt: iso(r.clock + 1) } }; }); } }));
    try {
      await r.round();
      assert.ok(!r.fake.state.events.includes('DATA'), `${act}: DATA に進まない`); assert.equal(r.fake.state.got.length, 0);
      assert.deepEqual(r.st('c1').inflight || {}, {}, `${act}: 送り中の記録を書かない`);
      assert.equal(r.notify.results.length, 0, `${act}: 失敗の結果にも数えない`);
    } finally { await r.close(); }
  }
});

test('試しの 1 通の行は notify の id・kind で上書きされない（P3-4）', async () => {
  const r = await rig(); await r.on('c1');
  const orig = r.notify.route;
  r.notify.route = async (m, p, cid, o) => { const x = await orig(m, p, cid, o); return p === 'mail/preview' ? { ...x, test: { ...x.test, id: 'f'.repeat(32), kind: 'approval' } } : x; };
  const seen = [];
  const m2 = createMailer({ store: r.store, notifyRoute: r.notify.route, now: () => r.clock, send: async a => { seen.push(a); return { ok: true, code: 250 }; }, log: () => {} });
  try {
    assert.equal((await m2.test('c1'))[1].result, 'ok');
    assert.match(seen[0].messageId, /^<[0-9a-f]{24}@aioffice\.local>$/); assert.equal(seen[0].messageId, messageIdFor('c1', `test:${r.clock}`), 'id は test:… のまま（notify の id に替わらない）');
    assert.equal(r.notify.results.length, 0, '試しは notify の結果に載せない');
  } finally { await r.close(); }
});

test('HTML は text から作り直した物と同じ時だけ通す: 抜け道 4 つ（table background・style url・video poster・meta refresh）と余計なタグは送らない（P2-2）', async () => {
  const r = await rig(); await r.on('c1', { kinds: ['approval'] }); r.tick(5000);
  const good = () => mkRow('approval', 'good', r.clock - 1000);
  const inject = frag => ({ ...good(), html: good().html.replace('<p>', frag + '<p>') });
  const evil = {
    table_bg: inject('<table background="https://evil.example/t.gif"><tr><td>x</td></tr></table>'),
    style_url: inject('<div style="background:url(https://evil.example/t.gif)">x</div>'),
    video_poster: inject('<video poster="https://evil.example/t.gif"></video>'),
    meta_refresh: inject('<meta http-equiv="refresh" content="0;url=https://evil.example/">'),
    extra_p: inject('<p>hidden</p>'),
  };
  try {
    for (const [why, row] of Object.entries(evil)) {
      r.notify.rows.c1 = [row]; const before = r.fake.state.connections;
      assert.equal((await r.round()).c1.skippedBad, 1, why); assert.equal(r.fake.state.connections, before, `${why}: 送らない`);
      assert.equal(r.notify.results.at(-1).result, 'bad', why);
    }
    r.notify.rows.c1 = [good()]; assert.equal((await r.round()).c1.sent, 1);
    const sent = r.fake.state.got.at(-1).data; const b = sent.match(/boundary="([^"]+)"/)[1];
    const html = Buffer.from(sent.split(`--${b}`)[2].split('\r\n\r\n')[1].replace(/\r\n/g, ''), 'base64').toString('utf8');
    assert.equal(html, htmlFromText(good().text, { lang: 'en', officeUrl: OFFICE }), '送る HTML は起動係が作った物');
  } finally { await r.close(); }
});

test('題に href・src=・onboarding=・<script> を含む正しい知らせは送られる（HTML では escape された形）（P3-a）', async () => {
  const r = await rig(); await r.on('c1', { kinds: ['approval'] }); r.tick(5000);
  const title = 'Fix href and src=x onboarding=1 <script>alert(1)</script> in docs';
  const row = mkRow('approval', title, r.clock - 1000); r.notify.rows.c1 = [row];
  try {
    assert.equal((await r.round()).c1.sent, 1); assert.equal(r.st('c1').badCount || 0, 0);
    const sent = r.fake.state.got[0].data, b = sent.match(/boundary="([^"]+)"/)[1];
    const html = Buffer.from(sent.split(`--${b}`)[2].split('\r\n\r\n')[1].replace(/\r\n/g, ''), 'base64').toString('utf8');
    assert.ok(html.includes('&lt;script&gt;') && !html.includes('<script>') && html.includes('onboarding=1'));
    assert.equal((html.match(/<a /g) || []).length, 1);
  } finally { await r.close(); }
});

test('結果の返し先が 4xx を返し続けても、残さず捨てて会社は止まらない。5xx・届かないは残す（P3-b）', async () => {
  const r = await rig(); await r.on('c1'); r.tick(5000);
  try {
    r.notify.failResult = true; r.notify.resultStatus = 400;
    const orig = r.notify.route; r.notify.route = async (m, p, c, o) => { if (p === 'mail/result' && r.notify.failResult) { r.notify.calls.push({ p }); throw Object.assign(new Error('x'), { status: r.notify.resultStatus }); } return orig(m, p, c, o); };
    const mailer = createMailer({ store: r.store, notifyRoute: r.notify.route, now: () => r.clock, send: sendGmail, sendSeam: { connect: r.connects.push.bind(r.connects) && (o => tls.connect({ host: '127.0.0.1', port: r.fake.server.address().port, servername: o.servername, ca: CERT, checkServerIdentity: () => undefined })), env: {} }, log: l => r.logs.push(l) });
    r.notify.rows.c1 = [mkRow('approval', 'g4', r.clock - 1000)];
    await mailer.round([{ id: 'c1' }]); assert.deepEqual(r.st('c1').unreported || [], [], '4xx は残さない'); assert.ok(r.logs.some(l => /result dropped 400/.test(l)));
    r.notify.rows.c1 = [mkRow('approval', 'g5', r.clock - 900)]; r.notify.resultStatus = 503;
    await mailer.round([{ id: 'c1' }]); assert.equal(r.st('c1').unreported.length, 1, '5xx は残す');
    r.notify.resultStatus = 404; r.notify.rows.c1 = [];
    await mailer.round([{ id: 'c1' }]); assert.deepEqual(r.st('c1').unreported, [], '出し直しで 4xx になれば捨てる（止まり続けない）');
    r.notify.rows.c1 = [mkRow('approval', 'g6', r.clock - 800)]; r.notify.failResult = false; assert.equal((await mailer.round([{ id: 'c1' }])).c1.sent, 1, '会社は止まっていない');
  } finally { await r.close(); }
});

test('出し直しと pending の取りにも締め切りがあり、切れたら残りは次の回へ（P3-c）', async () => {
  const r = await rig(); await r.on('c1'); r.tick(5000);
  try {
    r.store.update(x => { x.mail = { ...x.mail, c1: { ...x.mail.c1, unreported: Array.from({ length: 20 }, (_, i) => ({ id: hex32(`u${i}`), result: 'sent', code: 'ok' })) } }; });
    const orig = r.notify.route; let n = 0;
    r.notify.route = async (m, p, c, o) => { if (p === 'mail/result') { n++; r.clock += 20_000; } return orig(m, p, c, o); }; // 1 回呼ぶごとに 20 秒かかる
    const mailer = createMailer({ store: r.store, notifyRoute: r.notify.route, now: () => r.clock, send: async () => { throw new Error('送らない'); }, log: () => {} });
    const out = await mailer.round([{ id: 'c1' }], { budgetMs: 60_000 });
    assert.ok(n <= 5, `20 件を全部は呼ばない（${n}）`); assert.equal(out.c1.skip, 'deadline'); assert.ok(r.st('c1').unreported.length >= 15, '残りは次の回へ');
    assert.equal(r.notify.pendingCalls().length, 0, '時間が無ければ pending を取りに行かない');
  } finally { await r.close(); }
});

test('本文の write 中の timeout は「送ったかもしれない」として記録を残す（P3-d）', async () => {
  const r = await rig(); await r.on('c1'); r.tick(5000);
  const row = mkRow('approval', 'body-timeout', r.clock - 1000); r.notify.rows.c1 = [row];
  const mailer = createMailer({ store: r.store, notifyRoute: r.notify.route, now: () => r.clock, send: async a => { await a.before(); return { ok: false, tag: 'timeout', code: null, ext: null, stage: 'data_body' }; }, log: () => {} });
  try {
    await mailer.round([{ id: 'c1' }]);
    assert.equal(r.st('c1').inflight[row.id].n, 1, '記録が残る'); assert.equal(r.notify.results.at(-1).result, 'retry');
    await mailer.round([{ id: 'c1' }]); assert.equal(r.st('c1').inflight[row.id].n, 2, '次の回は 2 回目として数える');
  } finally { await r.close(); }
});

test('試しの 1 通が DATA の前の照らし直しで止まると、結果は off（failed でない）（P3-e）', async () => {
  const r = await rig(); await r.on('c1');
  const mailer = createMailer({ store: r.store, notifyRoute: r.notify.route, now: () => r.clock, send: async () => ({ ok: false, tag: 'off', code: null, ext: null, stage: 'data' }), log: () => {} });
  try {
    assert.deepEqual((await mailer.test('c1'))[1], { v: 1, result: 'off' }); assert.equal(r.st('c1').lastTest.result, 'off'); assert.equal(r.st('c1').on, true);
    assert.equal(r.notify.results.length, 0);
  } finally { await r.close(); }
});

test('試験の CA の env だけがある起動は、やり直さず OFF にして test_ca_env を残し、欄と帯に直し方を出す', async () => {
  const r = await rig(); await r.on('c1'); r.tick(5000);
  const mailer = createMailer({ store: r.store, notifyRoute: r.notify.route, now: () => r.clock, send: (a, s) => sendGmail(a, { ...s, env: { NODE_EXTRA_CA_CERTS: '/x.pem' } }), log: () => {} });
  r.notify.rows.c1 = [mkRow('approval', 'ca-env', r.clock - 1000)];
  try {
    await mailer.round([{ id: 'c1' }]);
    const st = r.st('c1'); assert.deepEqual([st.on, st.offReason, st.offCode], [false, 'dead', 'test_ca_env']); assert.equal(r.fake.state.connections, 0);
    const { bannerItems } = await import('../plugins/office/src/api.mjs'); const { DICT } = await import('../plugins/office/src/i18n.mjs');
    const v = await mailer.view('c1'); assert.deepEqual(bannerItems({ mail: v }).map(b => b.key), ['mail_ca_env']);
    for (const l of ['en', 'ja']) { assert.match(DICT[l].mail_reason_test_ca_env, /NODE_EXTRA_CA_CERTS/); assert.match(DICT[l].banner_mail_ca_env, /NODE_EXTRA_CA_CERTS/); }
    assert.match(DICT.en.mail_test_fail, /Reason: \{code\}/); assert.match(DICT.ja.mail_test_fail, /理由: \{code\}/);
  } finally { await r.close(); }
});
