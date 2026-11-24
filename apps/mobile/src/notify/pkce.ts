// PKCE（RFC 7636・S256）。サインインの 1 回ごとに verifier を作り、token を受けたら捨てる。
// 乱数と sha256 は端末の部品（expo-crypto）か WebCrypto を渡す。
export type Pkce = { verifier: string; challenge: string };
export type PkceParts = { randomBytes(n: number): Promise<Uint8Array>; sha256(data: Uint8Array): Promise<Uint8Array> };

const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';
export function base64url(b: Uint8Array): string {
  let out = '';
  for (let i = 0; i < b.length; i += 3) {
    const n = (b[i] << 16) | ((b[i + 1] ?? 0) << 8) | (b[i + 2] ?? 0);
    out += ALPHABET[(n >> 18) & 63] + ALPHABET[(n >> 12) & 63];
    if (i + 1 < b.length) out += ALPHABET[(n >> 6) & 63];
    if (i + 2 < b.length) out += ALPHABET[n & 63];
  }
  return out;
}

export async function makePkce(parts: PkceParts): Promise<Pkce> {
  const verifier = base64url(await parts.randomBytes(32)); // 43 字
  const challenge = base64url(await parts.sha256(Uint8Array.from(verifier, ch => ch.charCodeAt(0))));
  return { verifier, challenge };
}

export const webPkceParts: PkceParts = {
  async randomBytes(n) { return globalThis.crypto.getRandomValues(new Uint8Array(n)); },
  async sha256(d) { return new Uint8Array(await globalThis.crypto.subtle.digest('SHA-256', d as BufferSource)); },
};
