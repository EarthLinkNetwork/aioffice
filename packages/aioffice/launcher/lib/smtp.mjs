// 持ち主の Gmail から、持ち主の Gmail へ 1 通送る（範囲 docs/review/2026-11-19-mail-notify-scope.md の r2「送る形」と r3 の 5〜10）。
// 依存なしの Node の tls で、決まった手順（EHLO・AUTH PLAIN・MAIL FROM・RCPT TO 1 つ・DATA・QUIT）を書く。
// - 接続を開く所は sendGmail の 1 か所だけ（lint の試験が数える・r3 の 11）。相手はコードの定数 smtp.gmail.com:465（暗黙の TLS・証明書を確かめる）
// - サーバーの答えの本文は外へ出さない。残すのは 3 桁の code・拡張コード（x.y.z）・決まった短い印だけ（M3・r3 の 5）
// - アプリ パスワードは AUTH の 1 行にだけ載り、error・戻り値・ログのどこにも入れない
import tls from 'node:tls';
import { createHash, randomBytes } from 'node:crypto';

export const SMTP = Object.freeze({ host: 'smtp.gmail.com', port: 465, ehlo: 'aioffice.local', stepMs: 10_000, totalMs: 30_000, maxReply: 4096 });
// 試験の CA（NODE_EXTRA_CA_CERTS）を渡した起動は、この印の env が無い限りメールを断る（r3 の 8。配る物には付けない）
export const MAIL_TEST_ENV = 'AIOFFICE_CI_MAIL_TEST';

// ---- 文の組み立て（r2・r3 の 6・7） ----
const CRLF = '\r\n';
const b64 = buf => Buffer.from(buf).toString('base64');
// UTF-8 の base64 を 76 字ごとに改行（行頭の . は起きない）
export const b64Lines = s => (b64(Buffer.from(String(s), 'utf8')).match(/.{1,76}/g) || ['']).join(CRLF);
const crlf = s => String(s).replace(/\r\n|\r|\n/g, CRLF);
// 行頭の . は 2 つにする（SMTP の決まり。base64 の本文では起きないが、決まりどおりに行う）
export const dotStuff = s => s.replace(/(^|\r\n)\./g, '$1..');

// 件名の RFC 2047（B 方式）: 1 語は 75 字以内・UTF-8 の文字の途中で切らない・語の間で行を折り返す。ASCII だけならそのまま
export function encodeSubject(subject) {
  const s = String(subject).replace(/[\r\n\u0000]/g, ' ');
  if (/^[\x20-\x7e]*$/.test(s)) return s;
  // 2 語目以降は base64 で 60 字 + 12 字 = 72 字（先頭の空白を足して 73 字）。1 語目は "Subject: "（9 字）と合わせて 78 字以内に収める（base64 56 字 + 12 字 = 68 字）
  const maxRaw = () => (words.length === 0 ? 42 : 45);
  const words = []; let cur = Buffer.alloc(0);
  for (const ch of s) { // for-of は文字（サロゲートペアも 1 つ）ごと
    const b = Buffer.from(ch, 'utf8');
    if (cur.length + b.length > maxRaw()) { words.push(cur); cur = Buffer.alloc(0); }
    cur = Buffer.concat([cur, b]);
  }
  if (cur.length) words.push(cur);
  return words.map(w => `=?UTF-8?B?${b64(w)}?=`).join(`${CRLF} `);
}

export const messageIdFor = (companyId, key) => `<${createHash('sha256').update(`${companyId}\n${key}`).digest('hex').slice(0, 24)}@aioffice.local>`;
const rfcDate = d => d.toUTCString().replace('GMT', '+0000');

// ヘッダーは From・To・Subject・Date・Message-ID・MIME のものだけ。宛先は 1 つ（From と同じ・Cc・Bcc・Reply-To は付けない）
export function buildMime({ addr, subject, text, html, messageId, date = new Date(), boundary = `=_aio_${randomBytes(12).toString('hex')}` }) {
  const head = [
    `From: <${addr}>`, `To: <${addr}>`, `Subject: ${encodeSubject(subject)}`, `Date: ${rfcDate(date)}`, `Message-ID: ${messageId}`,
    'MIME-Version: 1.0', `Content-Type: multipart/alternative; boundary="${boundary}"`,
  ].join(CRLF);
  const part = (type, body) => `--${boundary}${CRLF}Content-Type: ${type}; charset=UTF-8${CRLF}Content-Transfer-Encoding: base64${CRLF}${CRLF}${b64Lines(crlf(body))}${CRLF}`;
  return `${head}${CRLF}${CRLF}${part('text/plain', text)}${part('text/html', html)}--${boundary}--${CRLF}`;
}

// ---- 答えの読み（段ごとに待ち 10 秒・1 通全体で 30 秒・1 回の答えは 4KB まで・250- の複数行は最後まで） ----
const fail = (tag, extra = {}) => Object.assign(new Error(tag), { tag, ...extra });
const tagOfSocketError = e => {
  const c = String(e?.code || '');
  if (/^(ERR_TLS|ERR_SSL|CERT_|DEPTH_ZERO|SELF_SIGNED|UNABLE_TO_|ERR_OSSL)/.test(c) || /certificate|TLS|SSL/i.test(String(e?.message || ''))) return 'tls';
  return 'network';
};
function reader(sock, deadlineAt, stepMs) {
  let buf = '', error = null, closed = false, wake = null;
  const poke = () => { const w = wake; wake = null; if (w) w(); };
  sock.setEncoding('utf8');
  sock.on('data', d => { buf += d; poke(); });
  sock.on('error', e => { error ??= fail(tagOfSocketError(e)); poke(); });
  sock.on('close', () => { closed = true; poke(); });
  // 複数行の答えが終わっていれば { code, ext } を返す
  const parse = () => {
    const lines = buf.split(/\r?\n/);
    if (lines.length < 2) return null;
    const done = lines.findIndex((l, i) => i < lines.length - 1 && /^\d{3}(?: |$)/.test(l));
    if (done < 0) return null;
    const first = lines[0];
    // code は最後の行の物を使い、行ごとに code が違う答えは protocol（250- の後の 550 を成功と読まない）
    const body = lines.slice(0, done + 1);
    if (body.some(l => l.slice(0, 3) !== lines[done].slice(0, 3) || !/^\d{3}[ -]|^\d{3}$/.test(l))) throw fail('protocol');
    const code = Number(lines[done].slice(0, 3)), m = /^\d{3}[ -](\d\.\d{1,3}\.\d{1,3})\b/.exec(lines[done]) || /^\d{3}[ -](\d\.\d{1,3}\.\d{1,3})\b/.exec(first);
    buf = lines.slice(done + 1).join('\n');
    return { code, ext: m ? m[1] : null };
  };
  return {
    async reply() {
      const stepEnd = Math.min(Date.now() + stepMs, deadlineAt);
      for (;;) {
        if (buf.length > SMTP.maxReply) throw fail('protocol');
        const r = parse(); if (r) { if (!Number.isInteger(r.code) || r.code < 200 || r.code > 599) throw fail('protocol'); return r; }
        if (error) throw error;
        if (closed) throw fail('network');
        const left = stepEnd - Date.now();
        if (left <= 0) throw fail('timeout');
        await new Promise(res => { const t = setTimeout(() => { wake = null; res(); }, left); wake = () => { clearTimeout(t); res(); }; });
      }
    },
  };
}

// 1 通送る。throw しない。成功 { ok: true, code: 250 }・失敗 { ok: false, tag, code, ext, stage }（code・ext は答えがあった時だけ）
// args: { addr, pw, subject, text, html, messageId, before }。before は DATA の前に呼ぶ（起動係が「送り中」を書く・r3 の 10）
// seam は試験だけが渡す（connect・env・stepMs・totalMs）。配る起動は何も渡さない
export async function sendGmail({ addr, pw, subject, text, html, messageId, date, boundary, before }, seam = {}) {
  const env = seam.env || process.env;
  if (env.NODE_EXTRA_CA_CERTS && env[MAIL_TEST_ENV] !== '1') return { ok: false, tag: 'test_ca_env', code: null, ext: null, stage: 'connect' };
  const stepMs = seam.stepMs ?? SMTP.stepMs; // 待ちの短縮は試験だけ
  const deadlineAt = Date.now() + (seam.totalMs ?? SMTP.totalMs);
  let sock = null, stage = 'connect';
  const done = (r) => { try { sock?.destroy(); } catch { /* 閉じていた */ } return r; };
  try {
    const connect = seam.connect || tls.connect;
    sock = connect({ host: SMTP.host, port: SMTP.port, servername: SMTP.host, rejectUnauthorized: true, minVersion: 'TLSv1.2' });
    const rd = reader(sock, deadlineAt, stepMs);
    await new Promise((resolve, reject) => {
      const t = setTimeout(() => reject(fail('timeout')), Math.min(stepMs, deadlineAt - Date.now()));
      sock.once('secureConnect', () => { clearTimeout(t); resolve(); });
      sock.once('error', e => { clearTimeout(t); reject(fail(tagOfSocketError(e))); });
    });
    const expect = async (want, st) => { stage = st; const r = await rd.reply(); if (r.code !== want) throw fail('reply', { code: r.code, ext: r.ext }); return r; };
    // 書き込みも 1 通全体の締め切りとの競争にする（回線が黙って write が詰まっても見回りを塞がない）
    const cmd = line => new Promise((res, rej) => {
      const t = setTimeout(() => rej(fail('timeout')), Math.max(1, deadlineAt - Date.now()));
      sock.write(`${line}${CRLF}`, e => { clearTimeout(t); if (e) rej(fail('network')); else res(); });
    });
    await expect(220, 'greeting');
    await cmd(`EHLO ${SMTP.ehlo}`); await expect(250, 'ehlo');
    await cmd(`AUTH PLAIN ${b64(`\u0000${addr}\u0000${pw}`)}`); await expect(235, 'auth');
    await cmd(`MAIL FROM:<${addr}>`); await expect(250, 'mail');
    await cmd(`RCPT TO:<${addr}>`); await expect(250, 'rcpt');
    stage = 'data';
    if (typeof before === 'function') await before();
    await cmd('DATA'); await expect(354, 'data');
    stage = 'data_body'; // 本文を書き始めた後は、届いたかもしれない（記録を消さない）
    const mime = buildMime({ addr, subject, text, html, messageId, ...(date ? { date } : {}), ...(boundary ? { boundary } : {}) });
    await cmd(`${dotStuff(mime)}.`);
    await expect(250, 'data_end');
    try { await cmd('QUIT'); } catch { /* 送った後の QUIT の失敗は結果に影響しない */ }
    return done({ ok: true, code: 250 });
  } catch (e) {
    return done({ ok: false, tag: e?.tag || 'network', code: Number.isInteger(e?.code) ? e.code : null, ext: typeof e?.ext === 'string' ? e.ext : null, stage });
  }
}

// ---- 答えの扱いの表（r3 の 5）。拡張コード（x.y.z）で先に分ける ----
// action: sent | dead（OFF にする）| drop（その 1 通だけ捨てる・ON のまま）| day（今日は送らない）| retry（次の見回りでやり直す）
export function classifySmtp(r) {
  if (r?.ok) return { action: 'sent', tag: 'ok' };
  const code = Number.isInteger(r?.code) ? r.code : null, ext = typeof r?.ext === 'string' ? r.ext : '';
  if (r?.tag === 'test_ca_env') return { action: 'dead', tag: 'test_ca_env', code: null, ext: null }; // 起動の設定の誤り。やり直さず OFF にして、直し方を欄と帯に出す
  if (code == null) return { action: 'retry', tag: ['timeout', 'tls', 'network', 'protocol'].includes(r?.tag) ? r.tag : 'network', code: null, ext: null };
  const keep = { code, ext: ext || null };
  if (ext === '5.4.5') return { action: 'day', tag: 'day_limit', ...keep };
  if (code === 535 || code === 534 || code === 530 || (code >= 500 && /^5\.7\.(?:8|9|14)$/.test(ext))) return { action: 'dead', tag: 'auth_failed', ...keep };
  if ((code === 550 || code === 553) && (ext === '' || /^5\.1\.\d{1,3}$/.test(ext))) return { action: 'dead', tag: 'rejected', ...keep };
  if ((code === 552 || code === 554) && (/^5\.6\.\d{1,3}$/.test(ext) || ext === '5.7.0')) return { action: 'drop', tag: 'content', ...keep };
  if (code >= 400 && code < 500) return { action: 'retry', tag: 'temp', ...keep };
  return { action: 'retry', tag: 'unknown', ...keep }; // 表に無い番号: やり直し・3 桁と拡張コードを残す
}
