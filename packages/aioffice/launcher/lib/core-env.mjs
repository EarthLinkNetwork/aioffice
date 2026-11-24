// 本体（Paperclip）を起こす env。ログインのある形（authenticated・private・loopback）で起こす
// 設計 docs/design/2026-11-23-public-office-multi-user.md 2.1・1.1 の実測:
// - 秘密は env で渡さない（本体は instance の .env の PAPERCLIP_AGENT_JWT_SECRET を使う・実測 2）
// - BETTER_AUTH_TRUSTED_ORIGINS は手元の名前を port の wildcard で許す（docker の -p で 3100 以外に出しても通る・2026-11-23 実測）
// - LAN の住所は AIOFFICE_HOSTS の 1 つから、本体の PAPERCLIP_ALLOWED_HOSTNAMES・BETTER_AUTH_TRUSTED_ORIGINS と起動係の許可を作る（ずれない・実測 17）
// - 起動係の鍵が無い間は、担当の時間での起こしを止める（HEARTBEAT_SCHEDULER_ENABLED=false・実測 12。人の操作での起こしは中継で止める）
import { splitHost } from './guard.mjs';

const LOCAL_ORIGINS = ['http://localhost:*', 'http://127.0.0.1:*'];
const DROP = ['BETTER_AUTH_SECRET', 'PAPERCLIP_AGENT_JWT_SECRET', 'PAPERCLIP_API_KEY', 'HEARTBEAT_SCHEDULER_ENABLED', 'PAPERCLIP_ALLOWED_HOSTNAMES', 'BETTER_AUTH_TRUSTED_ORIGINS', 'PAPERCLIP_PUBLIC_URL', 'TRUST_PROXY'];

// AIOFFICE_HOSTS（"office.local:3100,192.168.1.20:3100"）を読む。名前と port がそろった物だけ。手元の名前は数えない（既定で許す）
export function parseHosts(raw) {
  const out = [];
  for (const part of String(raw || '').split(',').map(s => s.trim()).filter(Boolean)) {
    // https://名前[:port] は https の前段（Cloudflare Tunnel など）を通す住所。名前:port は LAN の http の住所
    const tls = /^https:\/\//i.test(part);
    const h = splitHost(part.toLowerCase().replace(/^https:\/\//, '').replace(/\/$/, ''));
    if (!h || (!tls && !h.port) || !/^(\[[0-9a-f:]+\]|[a-z0-9.-]+)$/.test(h.name)) throw new Error(`AIOFFICE_HOSTS の書き方が違います: ${part}（名前:port か https://名前）`);
    if (['localhost', '127.0.0.1', '[::1]'].includes(h.name)) continue;
    // ブラウザは https の既定の port（443）を Host に付けないので、:443 は外して覚える（独立レビュー 6 回目 P3-4）
    const host = tls ? `https://${h.name}${h.port && h.port !== '443' ? `:${h.port}` : ''}` : `${h.name}:${h.port}`;
    if (!out.includes(host)) out.push(host);
  }
  return out;
}

export function coreEnv({ base = process.env, port, codexHome, hosts = '', keyless = true }) {
  const lan = parseHosts(hosts);
  const env = { ...base };
  for (const k of DROP) delete env[k];
  Object.assign(env, {
    PORT: String(port), HOST: '127.0.0.1', CODEX_HOME: codexHome,
    PAPERCLIP_TELEMETRY_DISABLED: '1', DO_NOT_TRACK: '1', PAPERCLIP_UPDATE_CHECK: '0',
    PAPERCLIP_DEPLOYMENT_MODE: 'authenticated',
    PAPERCLIP_DEPLOYMENT_EXPOSURE: 'private',
    PAPERCLIP_PUBLIC_URL: 'http://localhost:3100',
    // 担当（run）に渡す本体の住所。無いと本体は PUBLIC_URL（起動係）を渡し、起動係が authorization を捨てるので担当の鍵が 401 になる（2026-11-24 実測・秘書の e2e）
    PAPERCLIP_API_URL: `http://127.0.0.1:${port}`,
    TRUST_PROXY: 'loopback',
    BETTER_AUTH_TRUSTED_ORIGINS: [...LOCAL_ORIGINS, ...lan.map(h => (h.startsWith('https://') ? h : `http://${h}`))].join(','),
  });
  if (lan.length) env.PAPERCLIP_ALLOWED_HOSTNAMES = [...new Set(lan.map(h => splitHost(h.replace(/^https:\/\//, '')).name.replace(/^\[|\]$/g, '')))].join(',');
  if (keyless) env.HEARTBEAT_SCHEDULER_ENABLED = 'false';
  return env;
}
