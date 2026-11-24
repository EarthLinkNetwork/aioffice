// 本体（Paperclip）を呼ぶ fetch に、設定の hostHeaders（header の名前 → 値。値は秘密から解いたもの）を足す。
// 本体が認証の proxy（例: 会社の入口の service token が要る proxy）の後ろにある時に使う。
// 既に付いている header（判断の key の authorization・content-type）は上書きしない。認証や cookie に関わる名前は受けない。
const REFUSED = new Set(['authorization', 'cookie', 'host', 'content-type', 'content-length']);

export const allowedHostHeaderName = name => /^[A-Za-z0-9-]{1,64}$/.test(String(name)) && !REFUSED.has(String(name).toLowerCase());

// fetch: 元の fetch。getHeaders: () => Promise<Record<string,string>>（覚えた値でよい）。
// refresh: () => boolean（覚えた header の値を捨てる。捨てられない時＝間隔の内は false）。
// proxy に断られた形（302・ログインへの転送）で、header を付けていた時だけ、捨てて 1 回だけ解き直して呼び直す。
// 401・403 は本体が判断の鍵を断る時にも返るので、捨てない（期限切れの鍵で毎回解き直して上限に当たらないため）。
export const PROXY_REJECT = new Set([302]);
export function makeHostFetch({ fetch, getHeaders, refresh = null }) {
  const once = async (url, init) => {
    const extra = (await getHeaders()) || {};
    const headers = { ...(init.headers || {}) };
    const have = new Set(Object.keys(headers).map(k => k.toLowerCase()));
    let added = 0;
    for (const [k, v] of Object.entries(extra)) {
      if (!allowedHostHeaderName(k) || have.has(k.toLowerCase()) || typeof v !== 'string' || !v) continue;
      headers[k] = v; added++;
    }
    return { res: await fetch(url, { ...init, headers }), added };
  };
  return async (url, init = {}) => {
    const first = await once(url, init);
    if (!refresh || first.added === 0 || !PROXY_REJECT.has(first.res?.status)) return first.res;
    if (!refresh()) return first.res;
    return (await once(url, init)).res;
  };
}
