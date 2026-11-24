// 今ある office の移し替え（設計 docs/design/2026-11-23-public-office-multi-user.md 2.4）
// - 本体の標準出力から board-claim の URL（token と code）を拾う。その行はログに写さない（資格のため）
// - claim の前に本体の db:backup を --json で回し、成功の backupFile と sizeBytes だけを印にする
// - 段は記録でなく事実から決める（鍵 → session の admin → backup の印 → token の順）
import fs from 'node:fs';

const ANSI = /\x1b\[[0-9;]*[A-Za-z]/g;
const CLAIM = /\/board-claim\/([A-Za-z0-9_-]{8,200})\?code=([A-Za-z0-9_-]{4,200})/;
// claim の URL の頭から、途中まででも（token・code が切れていても）。長さは CLAIM と同じ上限まで
const PART = /^\/board-claim\/[A-Za-z0-9_-]{0,200}(?:\?(?:c(?:o(?:d(?:e(?:=[A-Za-z0-9_-]{0,200})?)?)?)?)?)?/;

// URL の形でない行（本体の要求のログ「GET /api/board-claim/<token>」・JSON の中の「"code":"…"」など）にも token と code を写さない（2026-11-24 e2e）
// 本体の claim の token は 48 字・code は 24 字の hex（board-claim.js の randomBytes）。拾った後は、その値そのものもどの行でも伏せる
const maskWith = (line, found) => {
  let out = line
    .replace(/(board-claim(?:\/|%2f|\\\/))[A-Za-z0-9_-]{8,200}/gi, '$1(not shown)')
    .replace(/([?&]code=)[A-Za-z0-9_-]{4,200}/gi, '$1(not shown)')
    .replace(/(["']code["']\s*:\s*["'])[0-9a-f]{24}(?=["'])/gi, '$1(not shown)');
  for (const v of [found?.token, found?.code]) if (v && v.length >= 8) out = out.split(v).join('(not shown)');
  return out;
};

// 本体の出力を行に分け、claim の URL の行は拾って写さない。write は写す先（行ごと・改行つき）
export function createClaimWatcher(write) {
  let buf = '', found = null;
  function feed(chunk) {
    buf += String(chunk);
    let i;
    while ((i = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, i + 1); buf = buf.slice(i + 1);
      const m = line.replace(ANSI, '').match(CLAIM);
      if (m) { found = { token: m[1], code: m[2], at: Date.now() }; write('aioffice: board claim URL captured (not shown)\n'); continue; }
      write(maskWith(line, found));
    }
    // 改行の無い長い出力も、claim の URL を拾って伏せてから写す（独立レビュー 9）。切る所に claim の URL が掛かっていれば、その URL の頭で切り、
    // 続きと合わせて次に照らす（境目をまたいだ URL の頭を写さない・短く切れた code を拾わない・2 回目のレビュー 低 7）。URL の長さに上限があるので buf は伸び続けない
    if (buf.length > 64 * 1024) {
      const clean = buf.replace(ANSI, '');
      let cut = clean.length - 512;
      const at = /\/board-claim\//g; let o;
      while ((o = at.exec(clean)) && o.index < cut) {
        const part = clean.slice(o.index).match(PART);
        if (o.index + part[0].length >= cut) { cut = o.index; break; }
      }
      const head = clean.slice(0, cut);
      for (const m of head.matchAll(new RegExp(CLAIM.source, 'g'))) found = { token: m[1], code: m[2], at: Date.now() };
      write(maskWith(head.replace(new RegExp(PART.source.slice(1), 'g'), '/board-claim/(not shown)'), found)); buf = clean.slice(cut);
    }
  }
  return { feed, current: () => found, clear: () => { found = null; } };
}

// db:backup --json の出力（最後の JSON の行）から backupFile と sizeBytes を読む。読めなければ null
export function parseBackup(out) {
  const lines = String(out || '').replace(ANSI, '').split('\n').map(s => s.trim()).filter(Boolean).reverse();
  for (const l of lines) {
    if (!l.startsWith('{')) continue;
    try { const j = JSON.parse(l); if (typeof j.backupFile === 'string' && Number.isInteger(j.sizeBytes) && j.sizeBytes > 0) return { backupFile: j.backupFile, sizeBytes: j.sizeBytes }; } catch { /* 次の行 */ }
  }
  // 複数行の JSON（整形して出す版）も読む
  try { const s = String(out).replace(ANSI, ''); const j = JSON.parse(s.slice(s.indexOf('{'), s.lastIndexOf('}') + 1)); if (typeof j.backupFile === 'string' && Number.isInteger(j.sizeBytes) && j.sizeBytes > 0) return { backupFile: j.backupFile, sizeBytes: j.sizeBytes }; } catch { /* 読めない */ }
  return null;
}

// 印の file があり、大きさが同じ時だけ backup が済んだとみなす（途中で止まった file は印が無いので数えない）
export function backupDone(mark, statFn = p => fs.statSync(p)) {
  if (!mark?.backupFile || !Number.isInteger(mark.sizeBytes)) return false;
  try { return statFn(mark.backupFile).size === mark.sizeBytes; } catch { return false; }
}

// 移し替えの段（上から順に照らす）: finish（鍵がある）・key（session の admin）・backup（印が無い）・claim（token がある）・lost（token が無い）
export function migrationStep({ hasKey, sessionAdmin, backupOk, claim }) {
  if (hasKey) return 'finish';
  if (sessionAdmin) return 'key';
  if (!backupOk) return 'backup';
  if (claim) return 'claim';
  return 'lost';
}
