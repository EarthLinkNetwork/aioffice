// QR の中身 aioffice://bind?code=<code> を読む（plugin mobile の src/bind-link.mjs の bindLinkOf が作る形）。
// サインインの戻り（aioffice://auth…）など、ほかの URL は null。試験は public/test/mobile-bind-link.test.mjs
export const BIND_CODE_RE = /^[A-Z0-9-]{4,40}$/;

export function parseBindLink(url: string | null | undefined): string | null {
  const m = /^aioffice:\/\/bind\/?\?(.*)$/i.exec(String(url ?? '').trim());
  if (!m) return null;
  for (const kv of m[1].split('&')) {
    const [k, v = ''] = kv.split('=');
    if (k !== 'code') continue;
    let code: string;
    try { code = decodeURIComponent(v).trim().toUpperCase(); } catch { return null; }
    return BIND_CODE_RE.test(code) ? code : null;
  }
  return null;
}
