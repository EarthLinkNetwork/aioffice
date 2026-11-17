// 起動係の守り（仕様 docs/design/2026-11-15-public-package.md「起動係の守り」）
// 1. Host の許可の一覧（localhost・127.0.0.1・[::1] だけ）— DNS rebinding への守り
// 2. Origin の確かめ（状態を変える method と WebSocket の upgrade は、Origin が起動係の住所と scheme・host・port まで一致する時だけ）— CSRF への守り
// 3. 持ち主の cookie（HttpOnly・SameSite=Strict・HMAC で署名）と合言葉（scrypt）
import crypto from 'node:crypto';

const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]']);
const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);
export const COOKIE = 'aio_owner';
const COOKIE_DAYS = 30;

// Host の header を「名前」と「port」に分ける。[::1]:3100 のような IPv6 も扱う
export function splitHost(host) {
  if (typeof host !== 'string' || !host) return null;
  const m = host.match(/^(\[[^\]]+\]|[^:]+)(?::(\d+))?$/);
  return m ? { name: m[1].toLowerCase(), port: m[2] || null } : null;
}

export function hostAllowed(host) {
  const h = splitHost(host);
  return !!h && LOCAL_HOSTS.has(h.name);
}

// 状態を変える要求と WebSocket の upgrade は Origin を確かめる。
// Origin が無い要求（ブラウザでない手元の道具）は通す。ブラウザは別の所からの POST・WebSocket に必ず Origin を付けるので、CSRF はここで止まる
export function originAllowed({ method, host, origin, upgrade }) {
  if (SAFE_METHODS.has(method) && !upgrade) return true;
  if (origin == null || origin === '') return true;
  if (origin === 'null') return false;
  return origin === `http://${host}`;
}

export function hashPassword(password, salt = crypto.randomBytes(16).toString('hex')) {
  const hash = crypto.scryptSync(String(password), salt, 32).toString('hex');
  return { salt, hash };
}

export function checkPassword(password, owner) {
  if (!owner?.salt || !owner?.hash) return false;
  const { hash } = hashPassword(password, owner.salt);
  return crypto.timingSafeEqual(Buffer.from(hash, 'hex'), Buffer.from(owner.hash, 'hex'));
}

export function passwordProblem(password) {
  if (typeof password !== 'string') return 'password_required';
  if (password.length < 8) return 'password_short';
  if (password.length > 200) return 'password_long';
  return null;
}

const sign = (secret, v) => crypto.createHmac('sha256', secret).update(v).digest('hex');

// cookie の値 = 発行の時刻.世代.署名。世代は持ち主を登録し直すと上がり、古い cookie は通らなくなる
export function issueCookie(secret, generation, now = Date.now()) {
  const v = `${now}.${generation}`;
  return `${COOKIE}=${v}.${sign(secret, v)}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${COOKIE_DAYS * 86400}`;
}

export function readCookie(header, name = COOKIE) {
  for (const part of String(header || '').split(';')) {
    const i = part.indexOf('='); if (i < 0) continue;
    if (part.slice(0, i).trim() === name) return part.slice(i + 1).trim();
  }
  return null;
}

export function cookieValid(secret, generation, value, now = Date.now()) {
  if (!value) return false;
  const m = value.match(/^(\d+)\.(\d+)\.([0-9a-f]{64})$/); if (!m) return false;
  const [, at, gen, sig] = m;
  if (Number(gen) !== generation) return false;
  if (now - Number(at) > COOKIE_DAYS * 86400 * 1000 || Number(at) > now + 60000) return false;
  const want = sign(secret, `${at}.${gen}`);
  return crypto.timingSafeEqual(Buffer.from(sig, 'hex'), Buffer.from(want, 'hex'));
}
