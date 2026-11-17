// スマホとつなぐ code を QR にする（通信しない・試験は test/mobile-bind-link.test.mjs）。
// QR の中身は aioffice://bind?code=<code>。iPhone の標準のカメラで読むとアプリが開き、「会社とつなぐ」に code が入る（送るのは本人が「つなぐ」を押した時）
// （アプリの側は apps/mobile/src/notify/bind-link.ts の parseBindLink）。
import qrcode from 'qrcode-generator';

export const BIND_LINK_SCHEME = 'aioffice';
export const CODE_RE = /^[A-Z0-9-]{4,40}$/;

export function bindLinkOf(code) {
  const c = String(code || '').trim().toUpperCase();
  if (!CODE_RE.test(c)) throw new Error('bind code の形が違う');
  return `${BIND_LINK_SCHEME}://bind?code=${encodeURIComponent(c)}`;
}

// 白地に黒の QR の SVG（文字列）。誤り訂正は M（画面の写りが少し悪くても読める）
export function qrSvgOf(text, { cell = 6, margin = 4 } = {}) {
  const q = qrcode(0, 'M');
  q.addData(String(text));
  q.make();
  const n = q.getModuleCount();
  const size = (n + margin * 2) * cell;
  let d = '';
  for (let r = 0; r < n; r++) for (let c = 0; c < n; c++) if (q.isDark(r, c)) d += `M${(c + margin) * cell} ${(r + margin) * cell}h${cell}v${cell}h-${cell}z`;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 ${size} ${size}" shape-rendering="crispEdges"><rect width="100%" height="100%" fill="#fff"/><path d="${d}" fill="#000"/></svg>`;
}

// <img src> に入れる形
export const qrDataUrlOf = text => `data:image/svg+xml;charset=utf-8,${encodeURIComponent(qrSvgOf(text))}`;
