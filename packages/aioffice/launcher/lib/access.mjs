// 起動係の中継の判定（設計 docs/design/2026-11-23-public-office-multi-user.md 2.1・2.2・2.3）
// - 照らす前に path を正規化する（decode・\ を / に・// を 1 つに・. と .. を解く・小文字・末尾の / を外す）。本体の Express は大文字・小文字と末尾の / を区別しない
// - 照らし方は「許す物を名指しする」形だけ（断る物を並べない）
// - 起動係の鍵が無い間は段ごとの白リスト（claim の前・移し替え・鍵が無い）。scheduler の flag は人の操作での担当の起こしを止めないので、
//   人の操作そのものを本体に届けない。claim の前の sign-up と bootstrap の claim は使い捨ての code の cookie、移し替えは今の合言葉の cookie が要る
// - 鍵がある時（ready）は本体に任せる（本体が session と権限で断る）

// 正規化した path を返す。decode できない・制御文字・NUL を含む path は null（断る）
export function normPath(raw) {
  let p = String(raw || '').split('?')[0].split('#')[0];
  for (let i = 0; i < 3; i++) { // 二重の encode（%252F）も解く
    let d; try { d = decodeURIComponent(p); } catch { return null; }
    if (d === p) break;
    p = d;
  }
  if (/[\x00-\x1f\x7f]/.test(p)) return null;
  p = p.replace(/\\/g, '/');
  const out = [];
  for (const seg of p.split('/')) {
    if (seg === '' || seg === '.') continue;
    if (seg === '..') { out.pop(); continue; }
    out.push(seg);
  }
  return ('/' + out.join('/')).toLowerCase();
}

// 段ごとの白リスト（設計 2.1 の表・本体の API の経路で書く）。どの段も画面の静的なファイル（GET）と /api/health は通す
const STATIC = [/^\/assets\//, /^\/favicon[^/]*$/, /^\/[^/]+\.(?:js|css|png|svg|ico|woff2?|webmanifest|json)$/];
const PAGES = new Set(['/', '/auth', '/login', '/sign-in', '/sign-up']);
const SIGN_IN = new Set(['POST /api/auth/sign-in/email', 'GET /api/auth/get-session', 'POST /api/auth/sign-out']);
// aioffice-reset-owner の招待（起動係が token の hash と合う画面を開いた人に code の cookie を出す）: その画面・招待の読み出し・accept
const RESET_INVITE = k => /^GET \/invite\/[^/]+$/.test(k) || /^GET \/api\/invites\/[^/]+(?:\/onboarding)?$/.test(k) || /^POST \/api\/invites\/[^/]+\/accept$/.test(k);
const TABLE = {
  // claim の前（新しく入れた office・reset-owner で admin を外した office）: code の cookie がある時だけ sign-up・bootstrap の claim・reset-owner の招待
  preclaim: (k, p, c) => SIGN_IN.has(k) || (c.claimCookie && (k === 'POST /api/auth/sign-up/email' || k === 'POST /api/bootstrap/claim' || RESET_INVITE(k))),
  // 移し替え: 合言葉の cookie がある時だけ sign-up・sign-in・board-claim
  migrating: (k, p, c) => c.ownerCookie && (SIGN_IN.has(k) || k === 'POST /api/auth/sign-up/email'
    || /^GET \/api\/board-claim\/[^/]+$/.test(k) || /^POST \/api\/board-claim\/[^/]+\/claim$/.test(k) || /^GET \/board-claim\/[^/]+$/.test(k)),
  // 鍵が無い・401・403: sign-in（持ち主が sign-in して鍵を作り直す）。aioffice-reset-owner の招待を開いた人（code の cookie）だけ、
  // その招待の画面・sign-up・accept（持ち主を作り直す道・設計 2.8・独立レビュー 5）
  keyless: (k, p, c) => SIGN_IN.has(k) || (c.claimCookie && (k === 'POST /api/auth/sign-up/email' || RESET_INVITE(k))),
};

// 本体への中継を許すか。返り値: 'pass' | 'deny'（段の表に無い・503 で断る）| 'bad'（path が読めない）
// state: { stage: 'ready' | 'preclaim' | 'migrating' | 'keyless', claimCookie, ownerCookie }
export function coreAccess({ method, url, state }) {
  const p = normPath(url);
  if (p == null) return 'bad';
  const st = state || {};
  const stage = st.stage || 'ready';
  const m = String(method || 'GET').toUpperCase();
  // 最初の持ち主を取る口（本体は admin が 0 人なら session のある誰でも admin にする）は、どの段でも「claim の前・code の cookie」の時だけ。
  // ready の段でも本体に任せない: reset-owner が admin を外した直後、起動係が段の変化に気づく前に、招いた人や LAN の誰かが取れた（独立レビュー 2 回目 高 1）
  // reset-owner の招待が生きている間は閉じる（新しい持ち主は今回の招待の accept で入る・codex の最終確認 P1）
  if (m === 'POST' && p === '/api/bootstrap/claim') return stage === 'preclaim' && st.claimCookie && !st.resetPending ? 'pass' : 'deny';
  if (stage === 'ready') return 'pass';
  if ((m === 'GET' || m === 'HEAD') && (PAGES.has(p) || STATIC.some(r => r.test(p)) || p === '/api/health')) return 'pass';
  const k = `${m === 'HEAD' ? 'GET' : m} ${p}`;
  const allow = TABLE[stage];
  if (!allow) return 'deny';
  return allow(k, p, st) ? 'pass' : 'deny';
}

// 本体へ渡す header を作る。ブラウザが付けた x-forwarded-* と authorization を捨て、起動係が確かめた Host・scheme・相手の IP で付け直す
// proto は起動係が決める（AIOFFICE_HOSTS に https:// で書いた前段の住所だけ https。ブラウザの header は信じない）
export function forwardHeaders(reqHeaders, { targetHost, clientHost, remoteAddress, proto = 'http' }) {
  const h = {};
  for (const [k, v] of Object.entries(reqHeaders || {})) {
    const lk = k.toLowerCase();
    if (lk.startsWith('x-forwarded-') || lk === 'forwarded' || lk === 'x-real-ip' || lk === 'authorization') continue;
    h[k] = v;
  }
  h.host = targetHost;
  h['x-forwarded-host'] = String(clientHost || '').replace(/^\[::1\]/i, 'localhost');
  h['x-forwarded-proto'] = proto === 'https' ? 'https' : 'http';
  if (remoteAddress) h['x-forwarded-for'] = String(remoteAddress).replace(/^::ffff:/, '');
  return h;
}
