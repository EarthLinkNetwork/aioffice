// 起動係の鍵（本体の board の鍵・持ち主の名義）の置き場と、本体への呼び出しに鍵を付ける fetch
// 設計 docs/design/2026-11-23-public-office-multi-user.md 2.3:
// - 置き場は /data/aioffice/board-key.json（0600）。中身は { token, id }。ログ・画面・知らせ・ブラウザに出さない
// - 本体への呼び出し（paperclip・rounds・limits・plugins）は、どれもこの fetch を通す（1 か所で付け、付け忘れの口を作らない）
// - ブラウザからの中継（server.mjs の proxy）はこの fetch を使わない（人の session のまま本体に任せる）
import fs from 'node:fs';
import path from 'node:path';

export const KEY_FILE = 'board-key.json';

export function createBoardKey({ dataDir }) {
  const file = path.join(dataDir, KEY_FILE);
  let cache = null; let cachedMtime = -1;
  function read() {
    let st;
    try { st = fs.statSync(file); } catch { cache = null; cachedMtime = -1; return null; }
    if (st.mtimeMs === cachedMtime) return cache;
    try {
      const j = JSON.parse(fs.readFileSync(file, 'utf8'));
      cache = j && typeof j.token === 'string' && j.token ? { token: j.token, id: typeof j.id === 'string' ? j.id : null } : null;
    } catch { cache = null; }
    cachedMtime = st.mtimeMs;
    return cache;
  }
  function write({ token, id = null }) {
    if (typeof token !== 'string' || !token) throw new Error('board key: token が空');
    fs.mkdirSync(dataDir, { recursive: true, mode: 0o700 });
    const tmp = `${file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify({ token, id }), { mode: 0o600 });
    fs.chmodSync(tmp, 0o600);
    fs.renameSync(tmp, file);
    cachedMtime = -1;
  }
  function clear() { try { fs.unlinkSync(file); } catch { /* 無い */ } cache = null; cachedMtime = -1; }
  return { read, write, clear, has: () => !!read(), token: () => read()?.token || null, id: () => read()?.id || null, file };
}

// 鍵があれば Authorization: Bearer を付ける fetch。呼び手が付けた authorization は上書きする（本体へは起動係の名義だけで行く）
export function authedFetch(fetchFn, boardKey) {
  return (url, init = {}) => {
    const t = boardKey.token();
    if (!t) return fetchFn(url, init);
    const h = new Headers(init.headers || {});
    h.set('authorization', `Bearer ${t}`);
    return fetchFn(url, { ...init, headers: Object.fromEntries(h.entries()) });
  };
}

// plugin の CLI に渡す env（鍵があれば PAPERCLIP_API_KEY）
export function cliEnv(boardKey, base = process.env) {
  const t = boardKey.token();
  const env = { ...base };
  delete env.PAPERCLIP_API_KEY;
  if (t) env.PAPERCLIP_API_KEY = t;
  return env;
}
