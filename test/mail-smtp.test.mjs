// 起動係の SMTP の書き手の試験（lib/smtp.mjs）。範囲: docs/review/2026-11-19-mail-notify-scope.md の r2「確かめ方」と r3 の 5〜11・13
// 偽の受け口（test/e2e/mail-fake.mjs）を手元に立てる。本物の Gmail には 1 度も触れない
import test from 'node:test';
import assert from 'node:assert/strict';
import tls from 'node:tls';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { createFakeSmtp } from './e2e/mail-fake.mjs';
import { sendGmail, classifySmtp, buildMime, encodeSubject, dotStuff, b64Lines, messageIdFor, SMTP, MAIL_TEST_ENV } from '../packages/aioffice/launcher/lib/smtp.mjs';

// 試験用の自己署名の証明書（実行のたびに作る・repo に鍵を置かない）
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aio-mail-cert-'));
execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', `${dir}/k.pem`, '-out', `${dir}/c.pem`, '-subj', '/CN=smtp.gmail.com', '-days', '2'], { stdio: 'ignore' });
const KEY = fs.readFileSync(`${dir}/k.pem`), CERT = fs.readFileSync(`${dir}/c.pem`);

const ADDR = 'owner.test@gmail.com', PW = 'abcdefghijklmnop';
const OK_ENV = {}; // NODE_EXTRA_CA_CERTS の無い env
// 偽の受け口へ向ける connect。sendGmail が渡す接続の設定は記録し、行き先だけを手元の port に替える
async function rig(mode = {}) {
  const fake = createFakeSmtp({ key: KEY, cert: CERT });
  const port = await fake.listen();
  fake.setMode(mode);
  const calls = [];
  const connect = opts => { calls.push(opts); return tls.connect({ host: '127.0.0.1', port, servername: opts.servername, ca: CERT, checkServerIdentity: () => undefined, minVersion: opts.minVersion, rejectUnauthorized: opts.rejectUnauthorized }); };
  return { fake, calls, seam: { connect, env: OK_ENV }, close: () => fake.close() };
}
const MAIL = { addr: ADDR, pw: PW, subject: '[AI Office] Morning summary: 2 waiting', text: 'line1\n.dot line\nline3', html: '<p>hi</p>', messageId: messageIdFor('co1', 'k1') };
const sendWith = async (mode, over = {}, seamOver = {}) => { const r = await rig(mode); try { const res = await sendGmail({ ...MAIL, ...over }, { ...r.seam, ...seamOver }); return { res, fake: r.fake, calls: r.calls }; } finally { await r.close(); } };

test('手順: 接続 → EHLO（決まった名前）→ AUTH PLAIN → MAIL FROM → RCPT TO（1 つ）→ DATA → 本文 → QUIT の順', async () => {
  const { res, fake, calls } = await sendWith({});
  assert.deepEqual(res, { ok: true, code: 250 });
  assert.deepEqual(fake.state.commands, ['EHLO aioffice.local', 'AUTH PLAIN <secret>', `MAIL FROM:<${ADDR}>`, `RCPT TO:<${ADDR}>`, 'DATA', 'QUIT'].filter(Boolean));
  assert.equal(fake.state.commands.filter(c => c.startsWith('RCPT')).length, 1, 'RCPT TO は 1 つ');
  assert.deepEqual(fake.state.events, ['EHLO', 'AUTH', 'MAIL', 'RCPT', 'DATA', 'data_end', 'QUIT']);
  const g = fake.state.got[0];
  assert.equal(g.authUser, ADDR); assert.equal(g.authPass, PW, 'AUTH PLAIN は \\0 アドレス \\0 パスワード');
  // 接続の設定（r3 の 8）: 相手は定数・SNI・証明書を確かめる・TLS 1.2 以上
  assert.equal(calls.length, 1);
  assert.deepEqual({ host: calls[0].host, port: calls[0].port, servername: calls[0].servername, rejectUnauthorized: calls[0].rejectUnauthorized, minVersion: calls[0].minVersion }, { host: 'smtp.gmail.com', port: 465, servername: 'smtp.gmail.com', rejectUnauthorized: true, minVersion: 'TLSv1.2' });
  assert.deepEqual([SMTP.host, SMTP.port, SMTP.ehlo], ['smtp.gmail.com', 465, 'aioffice.local']);
});

test('本文: ヘッダーは決めた物だけ・From と To は同じ 1 つ・Cc/Bcc/Reply-To なし・全部 CRLF・base64 は 76 字・復号すると元の文', async () => {
  const { fake } = await sendWith({});
  const raw = fake.state.got[0].data;
  assert.ok(!/(^|[^\r])\n/.test(raw), '改行は全部 CRLF');
  const [head, ...rest] = raw.split('\r\n\r\n');
  const names = head.replace(/\r\n[ \t]/g, ' ').split('\r\n').map(l => l.split(':')[0]);
  assert.deepEqual(names.sort(), ['Content-Type', 'Date', 'From', 'MIME-Version', 'Message-ID', 'Subject', 'To'].sort());
  assert.match(head, new RegExp(`^From: <${ADDR.replace('.', '\\.')}>$`, 'm')); assert.match(head, new RegExp(`^To: <${ADDR.replace('.', '\\.')}>$`, 'm'));
  assert.ok(!/^(cc|bcc|reply-to):/im.test(head));
  assert.match(head, /^Message-ID: <[0-9a-f]{24}@aioffice\.local>$/m);
  assert.equal(head.match(/^Message-ID: (.*)$/m)[1], messageIdFor('co1', 'k1'));
  const boundary = head.match(/boundary="([^"]+)"/)[1];
  const parts = raw.split(`--${boundary}`).slice(1, -1);
  assert.equal(parts.length, 2); assert.match(parts[0], /Content-Type: text\/plain; charset=UTF-8/); assert.match(parts[1], /Content-Type: text\/html; charset=UTF-8/);
  const dec = p => Buffer.from(p.split('\r\n\r\n')[1].replace(/\r\n/g, ''), 'base64').toString('utf8');
  assert.equal(dec(parts[0]), MAIL.text.replace(/\n/g, '\r\n')); assert.equal(dec(parts[1]), MAIL.html);
  for (const p of parts) for (const l of p.split('\r\n\r\n')[1].split('\r\n')) assert.ok(l.length <= 76, `base64 の行は 76 字まで（${l.length}）`);
  assert.ok(raw.endsWith(`--${boundary}--\r\n`));
});

test('multipart の境目は毎回乱数・Message-ID は会社と知らせから決まる値（会社が違えば別）', () => {
  const a = buildMime({ ...MAIL, date: new Date(0) }), b = buildMime({ ...MAIL, date: new Date(0) });
  assert.notEqual(a.match(/boundary="([^"]+)"/)[1], b.match(/boundary="([^"]+)"/)[1]);
  assert.equal(messageIdFor('co1', 'k1'), messageIdFor('co1', 'k1')); assert.notEqual(messageIdFor('co1', 'k1'), messageIdFor('co2', 'k1')); assert.notEqual(messageIdFor('co1', 'k1'), messageIdFor('co1', 'k2'));
});

test('行頭の . は 2 つにし、受け口は 1 つに戻す（SMTP の決まり）・base64 の本文では起きない', () => {
  assert.equal(dotStuff('a\r\n.b\r\n..c\r\n'), 'a\r\n..b\r\n...c\r\n'); assert.equal(dotStuff('.x'), '..x'); assert.equal(dotStuff('a.b'), 'a.b');
  assert.ok(!/(^|\r\n)\./.test(b64Lines('.\n.\n.'.repeat(500))), 'base64 の行は . で始まらない');
});

test('件名の RFC 2047: ASCII はそのまま・日本語の長い件名は B 方式で 1 語 75 字以内・文字の途中で切らず・折り返しは空白で始まる', () => {
  assert.equal(encodeSubject('[AI Office] Morning summary: 2 waiting'), '[AI Office] Morning summary: 2 waiting');
  const long = `[AI Office] ${'朝のまとめ: 待っている物 12 件・承認待ち・判断待ち・止まった課題'.repeat(3)}😀`;
  const enc = encodeSubject(long);
  const words = enc.split('\r\n ');
  assert.ok(words.length > 3, '長いので何語かに分かれる');
  const folded = `Subject: ${enc}`.split('\r\n');
  for (const l of folded) assert.ok(l.length <= 78, `ヘッダーの 1 行は 78 字以内（${l.length}）`);
  for (const w of words) { assert.match(w, /^=\?UTF-8\?B\?[A-Za-z0-9+/=]+\?=$/); assert.ok(w.length <= 75, `1 語は 75 字以内（${w.length}）`); }
  const decoded = words.map(w => Buffer.from(w.slice(10, -2), 'base64').toString('utf8'));
  for (const d of decoded) assert.ok(!d.includes('�'), '文字の途中で切っていない');
  assert.equal(decoded.join(''), long);
  assert.ok(!/[\r\n]/.test(encodeSubject('a\r\nBcc: x@example.com')), '件名の改行は落とす（ヘッダーを足せない）');
});

test('日本語の件名で送ると、受け口の側で復号した件名が元と同じ', async () => {
  const subject = '[AI Office] 朝のまとめ: 待っている物 3 件';
  const { fake } = await sendWith({}, { subject });
  const head = fake.state.got[0].data.split('\r\n\r\n')[0].replace(/\r\n[ \t]/g, ' ');
  const v = head.match(/^Subject: (.*)$/m)[1];
  assert.equal(v.split(' ').map(w => Buffer.from(w.slice(10, -2), 'base64').toString('utf8')).join(''), subject);
});

// ---- 答えの表（r3 の 5）----
test('答えの表: 拡張コードで先に分ける', () => {
  const cls = (code, ext) => classifySmtp({ ok: false, tag: 'reply', code, ext });
  const table = [
    [535, '5.7.8', 'dead', 'auth_failed'], [535, null, 'dead', 'auth_failed'], [534, '5.7.9', 'dead', 'auth_failed'], [530, '5.7.0', 'dead', 'auth_failed'], [554, '5.7.14', 'dead', 'auth_failed'],
    [550, '5.4.5', 'day', 'day_limit'], [452, '5.4.5', 'day', 'day_limit'],
    [550, '5.1.1', 'dead', 'rejected'], [553, '5.1.3', 'dead', 'rejected'], [550, null, 'dead', 'rejected'],
    [552, '5.6.1', 'drop', 'content'], [554, '5.6.0', 'drop', 'content'], [554, '5.7.0', 'drop', 'content'],
    [421, '4.7.0', 'retry', 'temp'], [450, '4.2.1', 'retry', 'temp'], [451, '4.3.0', 'retry', 'temp'], [454, '4.7.0', 'retry', 'temp'],
    [599, '5.9.9', 'retry', 'unknown'], [550, '5.7.1', 'retry', 'unknown'], [552, '5.2.2', 'retry', 'unknown'],
  ];
  for (const [code, ext, action, tag] of table) { const c = cls(code, ext); assert.equal(c.action, action, `${code} ${ext}`); assert.equal(c.tag, tag, `${code} ${ext}`); }
  assert.deepEqual(classifySmtp({ ok: true, code: 250 }), { action: 'sent', tag: 'ok' });
  // 表に無い番号は 3 桁と拡張コードを残してやり直し
  assert.deepEqual(classifySmtp({ ok: false, tag: 'reply', code: 599, ext: '5.9.9' }), { action: 'retry', tag: 'unknown', code: 599, ext: '5.9.9' });
  for (const tag of ['timeout', 'tls', 'network', 'protocol']) assert.deepEqual(classifySmtp({ ok: false, tag, code: null }), { action: 'retry', tag, code: null, ext: null });
  assert.equal(classifySmtp({ ok: false, tag: 'weird', code: null }).tag, 'network');
});

test('偽の受け口が各段で返した答えは、code と拡張コードと段の印だけになる（答えの本文は戻り値に入らない）', async () => {
  const cases = [
    [{ auth: '535-5.7.8 Username and Password not accepted. For more information, go to\r\n535 5.7.8 https://support.google.com/mail/?p=BadCredentials secret-text-auth' }, { code: 535, ext: '5.7.8', stage: 'auth', seen: ['EHLO', 'AUTH'] }],
    [{ rcpt: '550 5.1.1 The email account that you tried to reach does not exist secret-text-rcpt' }, { code: 550, ext: '5.1.1', stage: 'rcpt', seen: ['EHLO', 'AUTH', 'MAIL', 'RCPT'] }],
    [{ end: '550 5.4.5 Daily user sending limit exceeded secret-text-end' }, { code: 550, ext: '5.4.5', stage: 'data_end', seen: ['EHLO', 'AUTH', 'MAIL', 'RCPT', 'DATA', 'data_end'] }],
    [{ greeting: '421 4.3.2 service not available secret-text-greeting' }, { code: 421, ext: '4.3.2', stage: 'greeting', seen: [] }],
    [{ mail: '553 5.1.7 bad sender secret-text-mail' }, { code: 553, ext: '5.1.7', stage: 'mail', seen: ['EHLO', 'AUTH', 'MAIL'] }],
    [{ data: '554 5.7.0 no secret-text-data' }, { code: 554, ext: '5.7.0', stage: 'data', seen: ['EHLO', 'AUTH', 'MAIL', 'RCPT', 'DATA'] }],
  ];
  for (const [mode, want] of cases) {
    const { res, fake } = await sendWith(mode);
    assert.equal(res.ok, false); assert.equal(res.code, want.code); assert.equal(res.ext, want.ext); assert.equal(res.stage, want.stage);
    assert.deepEqual(fake.state.events.filter(e => e !== 'QUIT'), want.seen, `${want.stage}: 受け口が見た手順`);
    const s = JSON.stringify(res);
    assert.ok(!s.includes('secret-text') && !s.includes(PW) && !s.includes(ADDR), `戻り値に答えの本文・パスワード・アドレスが無い: ${s}`);
  }
});

test('250- の複数行は最後まで読む・答えが 1 つの write に複数行でも、2 つの write に分かれても同じ', async () => {
  const { res } = await sendWith({ ehlo: '250-a\r\n250-b\r\n250-c\r\n250 AUTH PLAIN' });
  assert.equal(res.ok, true);
});

test('DATA の後で切れる: ok でなく、code なし・段は data_end（届いたかもしれない）・DATA の前に before が 1 回だけ呼ばれる', async () => {
  const r = await rig({ cut: 'end' });
  const order = [];
  try {
    const res = await sendGmail({ ...MAIL, before: async () => { order.push(`before@${r.fake.state.events.join(',')}`); } }, r.seam);
    assert.equal(res.ok, false); assert.equal(res.code, null); assert.equal(res.stage, 'data_end'); assert.equal(res.tag, 'network');
    assert.deepEqual(order, ['before@EHLO,AUTH,MAIL,RCPT'], 'RCPT の後・DATA の前に 1 回');
    assert.equal(r.fake.state.got.length, 1, '受け口は本文を 1 通受けた');
    assert.deepEqual(classifySmtp(res), { action: 'retry', tag: 'network', code: null, ext: null });
  } finally { await r.close(); }
});

test('待ち: 段の待ち・全体の待ちを超えたら destroy して timeout', async () => {
  const t0 = Date.now();
  const { res } = await sendWith({ delayMs: 400 }, {}, { stepMs: 80, totalMs: 5000 });
  assert.equal(res.ok, false); assert.equal(res.tag, 'timeout'); assert.equal(res.code, null);
  assert.ok(Date.now() - t0 < 3000, '待ち続けない');
  const r2 = await sendWith({ delayMs: 60 }, {}, { stepMs: 1000, totalMs: 150 }); // 1 段は短くても全体で超える
  assert.equal(r2.res.tag, 'timeout');
});

test('答えが 4KB を超える・改行の無い長い行は protocol で止める', async () => {
  const { res } = await sendWith({ greeting: `220 ${'x'.repeat(6000)}` }, {}, { stepMs: 500 });
  assert.equal(res.ok, false); assert.equal(res.tag, 'protocol');
});

test('証明書を確かめる: 試験用の CA を渡さない接続は tls で失敗し、手順は 1 つも進まない', async () => {
  const fake = createFakeSmtp({ key: KEY, cert: CERT }); const port = await fake.listen();
  try {
    // rejectUnauthorized: true のまま CA を渡さない（本物の起動と同じ）
    const res = await sendGmail(MAIL, { env: OK_ENV, connect: opts => tls.connect({ host: '127.0.0.1', port, servername: opts.servername, rejectUnauthorized: opts.rejectUnauthorized, minVersion: opts.minVersion }) });
    assert.equal(res.ok, false); assert.equal(res.tag, 'tls'); assert.equal(res.code, null);
    assert.deepEqual(fake.state.commands, [], 'AUTH を送らない（パスワードを渡さない）');
    assert.deepEqual(classifySmtp(res).action, 'retry');
  } finally { await fake.close(); }
});

test('NODE_EXTRA_CA_CERTS がある起動は、試験の印の env が無い限りメールを断る（接続を開かない）', async () => {
  let opened = 0;
  const connect = () => { opened++; throw new Error('開いてはいけない'); };
  const a = await sendGmail(MAIL, { connect, env: { NODE_EXTRA_CA_CERTS: '/ca/ca.pem' } });
  assert.equal(a.ok, false); assert.equal(a.tag, 'test_ca_env'); assert.equal(opened, 0);
  const b = await sendGmail(MAIL, { connect, env: { NODE_EXTRA_CA_CERTS: '/ca/ca.pem', [MAIL_TEST_ENV]: '0' } });
  assert.equal(b.tag, 'test_ca_env'); assert.equal(opened, 0); assert.deepEqual(classifySmtp(b), { action: 'dead', tag: 'test_ca_env', code: null, ext: null });
  const r = await rig({}); // 試験の印があれば通る
  try { const c = await sendGmail(MAIL, { ...r.seam, env: { NODE_EXTRA_CA_CERTS: '/ca/ca.pem', [MAIL_TEST_ENV]: '1' } }); assert.equal(c.ok, true); } finally { await r.close(); }
});

test('接続できない（port が閉じている）は network・秘密を戻り値に入れない', async () => {
  const res = await sendGmail(MAIL, { env: OK_ENV, connect: opts => tls.connect({ host: '127.0.0.1', port: 1, servername: opts.servername }) });
  assert.equal(res.ok, false); assert.ok(['network', 'tls'].includes(res.tag));
  assert.ok(!JSON.stringify(res).includes(PW));
});

// ---- lint（r3 の 11・M2）: 接続を開く所は 1 か所だけ ----
const strip = s => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:'"`\\])\/\/.*$/gm, '$1');
const read = rel => fs.readFileSync(new URL(`../${rel}`, import.meta.url), 'utf8');
const walk = d => fs.readdirSync(new URL(`../${d}/`, import.meta.url), { withFileTypes: true }).flatMap(e => (e.isDirectory() ? (e.name === 'node_modules' || e.name === 'dist' ? [] : walk(`${d}/${e.name}`)) : [`${d}/${e.name}`]));

test('lint: tls.connect は sendGmail の中の 1 か所だけ・net.connect は今の中継（server.mjs）の 1 か所だけ', () => {
  const files = ['packages', 'plugins'].flatMap(walk).filter(f => /\.(mjs|js)$/.test(f) && !f.includes('/public/') && !f.includes('/dist/'));
  const tlsAt = files.flatMap(f => [...strip(read(f)).matchAll(/\btls\.connect\b/g)].map(() => f));
  assert.deepEqual(tlsAt.filter(f => f.endsWith('.mjs')), ['packages/aioffice/launcher/lib/smtp.mjs'], 'tls.connect はここだけ');
  const smtp = strip(read('packages/aioffice/launcher/lib/smtp.mjs'));
  const at = smtp.search(/\btls\.connect\b/), fnAt = smtp.lastIndexOf('export async function sendGmail', at);
  assert.ok(fnAt > 0 && at - fnAt < 900, 'sendGmail の中');
  assert.ok(!/\bnet\.connect\b|createConnection|\bnet\.Socket/.test(smtp));
  const netAt = files.flatMap(f => [...strip(read(f)).matchAll(/\bnet\.connect\b|\bnet\.createConnection\b|\btls\.createConnection\b|new net\.Socket|new tls\.TLSSocket/g)].map(() => f));
  assert.deepEqual(netAt, ['packages/aioffice/launcher/server.mjs'], 'net.connect は今の中継の 1 か所');
});

test('lint: 起動係の mail.mjs は接続を自分で開かない（sendGmail を呼ぶだけ）', () => {
  const m = strip(read('packages/aioffice/launcher/lib/mail.mjs'));
  assert.ok(!/from\s*['"](?:node:)?(?:net|tls|http|https|dgram)['"]/.test(m)); assert.ok(!/\.connect\(/.test(m));
  assert.equal([...m.matchAll(/\bsend\(\{/g)].length, 1, '送る呼び出しは sendChecked の 1 か所');
});

test('lint: 知らせの plugin の src に SMTP・TLS 接続・送り口の語が無い（送るのは起動係だけ）', () => {
  const files = fs.readdirSync(new URL('../plugins/notify/src/', import.meta.url)).filter(f => f.endsWith('.mjs'));
  assert.ok(files.includes('mail.mjs') && files.includes('mail-worker.mjs'));
  for (const f of files) {
    const s = read(`plugins/notify/src/${f}`); // 注釈も含めて全文
    assert.ok(!/smtp|tls\.connect|net\.connect|createConnection|nodemailer|AUTH PLAIN|smtp\.gmail|app.?password/i.test(s), `${f} に送り口の語`);
  }
  for (const f of ['mail.mjs', 'mail-worker.mjs']) {
    const s = strip(read(`plugins/notify/src/${f}`));
    assert.ok(!/\bfetch\(|\.http\./.test(s) && !/from\s*['"](?:node:)?(?:net|tls|http|https|dgram|child_process)['"]/.test(s), `${f} は網の口を持たない`);
  }
});

test('複数行の答え: code は最後の行の物・行ごとに code が違えば protocol（250- の後の 550 を成功と読まない）（P3-3）', async () => {
  const a = await sendWith({ ehlo: '250-a\r\n550 5.7.1 denied' });
  assert.equal(a.res.ok, false); assert.equal(a.res.tag, 'protocol'); assert.equal(a.res.code, null);
  const b = await sendWith({ end: '250-queued\r\n550 5.4.5 limit' });
  assert.equal(b.res.ok, false); assert.equal(b.res.tag, 'protocol');
  const c = await sendWith({ ehlo: '250-a\r\n250-b\r\n250 c' }); assert.equal(c.res.ok, true);
  const d = await sendWith({ auth: '535-5.7.8 x\r\n535 5.7.8 y' }); assert.equal(d.res.code, 535); assert.equal(d.res.ext, '5.7.8');
});

test('write が詰まっても 1 通全体の締め切りで timeout になり、socket を壊す（P2-1）', async () => {
  const r = await rig({});
  let stalled = false;
  const connect = opts => {
    const s = r.seam.connect(opts); const w = s.write.bind(s);
    s.write = (d, cb) => { if (stalled) return true; if (/^DATA/.test(String(d))) { stalled = false; const ok = w(d, cb); return ok; } if (/^From:/.test(String(d))) { stalled = true; return true; } return w(d, cb); }; // 本文の write は callback を呼ばない
    return s;
  };
  const t0 = Date.now();
  try {
    const res = await sendGmail(MAIL, { env: OK_ENV, connect, totalMs: 400, stepMs: 300 });
    assert.equal(res.ok, false); assert.equal(res.tag, 'timeout'); assert.equal(res.code, null); assert.equal(res.stage, 'data_body', '本文の write 中の timeout');
    assert.ok(Date.now() - t0 < 3000, '十数分止まらない');
  } finally { await r.close(); }
});
