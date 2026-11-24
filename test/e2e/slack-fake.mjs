// Slack の Incoming Webhook の偽の受け口（e2e の CI だけ。配る image には入れない）。範囲 docs/review/2026-11-18-slack-notify-scope.md「確かめ方」e2e
// - 443 で HTTPS（試験用の CA が署名した hooks.slack.com の証明書・/ca/leaf.pem と /ca/leaf.key）。受けた POST の path と body を全部覚える
// - 3199 で手元の操作の口（HTTP）: GET /got?path=… 受けた物・POST /mode 返す答えを替える・POST /reset 覚えた物を消す
// 使い方: node slack-fake.mjs（container の中で root。網は 198.18.0.0/24 の 198.18.0.10）
import https from 'node:https';
import http from 'node:http';
import { readFileSync } from 'node:fs';

const DIR = process.env.SLACK_FAKE_CA_DIR || '/ca';
const got = [];
let mode = { status: 200, body: 'ok', headers: {}, delayMs: 0 };
const read = req => new Promise(r => { let b = ''; req.on('data', c => { b += c; }); req.on('end', () => r(b)); });

https.createServer({ key: readFileSync(`${DIR}/leaf.key`), cert: readFileSync(`${DIR}/leaf.pem`) }, async (req, res) => {
  const raw = await read(req);
  let body = null; try { body = JSON.parse(raw); } catch { body = raw; }
  got.push({ method: req.method, path: req.url, body, at: Date.now() });
  const m = mode;
  const reply = () => { if (!res.destroyed) { res.writeHead(m.status, { 'content-type': 'text/plain', ...m.headers }); res.end(m.body); } };
  if (m.delayMs) setTimeout(reply, m.delayMs); else reply();
}).listen(443, '0.0.0.0', () => console.log('slack-fake: https 443'));

http.createServer(async (req, res) => {
  const u = new URL(req.url, 'http://x');
  const json = (s, o) => { res.writeHead(s, { 'content-type': 'application/json' }); res.end(JSON.stringify(o)); };
  if (req.method === 'GET' && u.pathname === '/got') { const p = u.searchParams.get('path'); return json(200, p ? got.filter(g => g.path === p) : got); }
  if (req.method === 'POST' && u.pathname === '/mode') { const b = JSON.parse((await read(req)) || '{}'); mode = { status: 200, body: 'ok', headers: {}, delayMs: 0, ...b }; return json(200, mode); }
  if (req.method === 'POST' && u.pathname === '/reset') { got.length = 0; mode = { status: 200, body: 'ok', headers: {}, delayMs: 0 }; return json(200, { ok: true }); }
  return json(404, { error: 'nope' });
}).listen(3199, '0.0.0.0', () => console.log('slack-fake: control 3199'));
