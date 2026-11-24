// Gmail の送り口の偽の受け口（unit と e2e の CI だけ。配る image には入れない）。範囲 docs/review/2026-11-19-mail-notify-scope.md r2「確かめ方」・r3 の 13
// - TLS の 465 で、SMTP の手順（EHLO・AUTH PLAIN・MAIL FROM・RCPT TO・DATA・QUIT）を受け、受けた物（コマンド・本文の全体）を全部覚える
// - mode で答えを替える: { greeting, ehlo, auth, mail, rcpt, data, end }（文字の答え・複数行は \r\n で足す）・cut: 'end'（DATA の後に答えずに切る）・delayMs
// - unit は createFakeSmtp を import して手元で立てる。e2e は node mail-fake.mjs で container の中に立てる（465 と、手元の操作の口 3299）
import tls from 'node:tls';
import http from 'node:http';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const DEFAULT_MODE = () => ({ delayMs: 0 });

export function createFakeSmtp({ key, cert }) {
  const state = { got: [], connections: 0, commands: [], mode: DEFAULT_MODE(), events: [] };
  const server = tls.createServer({ key, cert }, sock => {
    state.connections++;
    sock.setEncoding('utf8');
    sock.on('error', () => {});
    const mode = () => state.mode;
    const say = (k, dflt) => { const text = mode()[k] ?? dflt; const go = () => { if (!sock.destroyed) sock.write(`${text}\r\n`); }; if (mode().delayMs) setTimeout(go, mode().delayMs); else go(); };
    const cur = { cmds: [], authUser: null, authPass: null, data: '' };
    let buf = '', inData = false;
    say('greeting', '220 smtp.gmail.com ESMTP fake');
    const finishMessage = () => { state.got.push({ cmds: [...cur.cmds], authUser: cur.authUser, authPass: cur.authPass, data: cur.data }); state.events.push('data_end'); };
    const pump = () => {
      for (;;) {
        if (inData) {
          const i = buf.indexOf('\r\n.\r\n');
          if (i < 0) return;
          cur.data = buf.slice(0, i + 2).replace(/(^|\r\n)\.\./g, '$1.');
          buf = buf.slice(i + 5); inData = false; finishMessage();
          if (mode().cut === 'end') { sock.destroy(); return; }
          say('end', '250 2.0.0 OK 1234567 fake');
          continue;
        }
        const j = buf.indexOf('\r\n'); if (j < 0) return;
        const line = buf.slice(0, j); buf = buf.slice(j + 2);
        cur.cmds.push(line.startsWith('AUTH PLAIN ') ? 'AUTH PLAIN <secret>' : line);
        state.commands.push(line.startsWith('AUTH PLAIN ') ? 'AUTH PLAIN <secret>' : line);
        state.events.push(line.split(' ')[0].toUpperCase());
        if (/^EHLO /i.test(line)) say('ehlo', '250-smtp.gmail.com at your service\r\n250-SIZE 35882577\r\n250-8BITMIME\r\n250 AUTH LOGIN PLAIN XOAUTH2');
        else if (/^AUTH PLAIN /i.test(line)) {
          const raw = Buffer.from(line.slice(11), 'base64').toString('utf8').split('\u0000'); cur.authUser = raw[1] ?? null; cur.authPass = raw[2] ?? null;
          say('auth', '235 2.7.0 Accepted');
        } else if (/^MAIL FROM:/i.test(line)) say('mail', '250 2.1.0 OK');
        else if (/^RCPT TO:/i.test(line)) say('rcpt', '250 2.1.5 OK');
        else if (/^DATA$/i.test(line)) { if ((mode().data ?? '354').toString().startsWith('354')) inData = true; say('data', '354 Go ahead'); }
        else if (/^QUIT$/i.test(line)) { say('quit', '221 2.0.0 closing connection'); setTimeout(() => sock.end(), 5); }
        else say('other', '502 5.5.1 Unrecognized command');
      }
    };
    sock.on('data', d => { buf += d; pump(); });
  });
  return {
    server, state,
    listen: (port = 0, host = '127.0.0.1') => new Promise(r => server.listen(port, host, () => r(server.address().port))),
    close: () => new Promise(r => { server.close(() => r()); server.closeAllConnections?.(); }),
    setMode: m => { state.mode = { ...DEFAULT_MODE(), ...m }; },
    reset: () => { state.got.length = 0; state.commands.length = 0; state.events.length = 0; state.connections = 0; state.mode = DEFAULT_MODE(); },
  };
}

// e2e: container の中で直に起こす（465 の TLS と、手元の操作の口 3299）
if (process.argv[1] && process.argv[1] === fileURLToPath(import.meta.url)) {
  const DIR = process.env.MAIL_FAKE_CA_DIR || '/ca';
  const fake = createFakeSmtp({ key: readFileSync(`${DIR}/leaf.key`), cert: readFileSync(`${DIR}/leaf.pem`) });
  await fake.listen(465, '0.0.0.0'); console.log('mail-fake: tls 465');
  const read = req => new Promise(r => { let b = ''; req.on('data', c => { b += c; }); req.on('end', () => r(b)); });
  http.createServer(async (req, res) => {
    const u = new URL(req.url, 'http://x');
    const json = (s, o) => { res.writeHead(s, { 'content-type': 'application/json' }); res.end(JSON.stringify(o)); };
    if (req.method === 'GET' && u.pathname === '/got') return json(200, { connections: fake.state.connections, got: fake.state.got, commands: fake.state.commands });
    if (req.method === 'POST' && u.pathname === '/mode') { const b = JSON.parse((await read(req)) || '{}'); fake.setMode(b); return json(200, fake.state.mode); }
    if (req.method === 'POST' && u.pathname === '/reset') { fake.reset(); return json(200, { ok: true }); }
    return json(404, { error: 'nope' });
  }).listen(3299, '0.0.0.0', () => console.log('mail-fake: control 3299'));
}
