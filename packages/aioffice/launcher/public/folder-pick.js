// フォルダの欄の絞り込みと分け方（wizard と図書室の部屋で同じ物を使う・依存なしの ES module）
// 範囲: docs/review/2026-11-17-wizard-folder-scope.md（作り方 3・4・5・9）
export const FOLDER = { docBytes: 200 * 1024, nameMax: 200, batchDocs: 20, batchBytes: 2 * 1024 * 1024, sep: ' › ' };

// 1 件の相対の道（webkitRelativePath。無ければ file の名前）を見て、送るかどうかと名前を決める
// why: type（.md・.txt 以外）・hidden（選んだフォルダ自身を除く . で始まる部分か node_modules）・name（200 字超・制御文字）
export function classify(relPath) {
  const parts = String(relPath || '').split('/').filter(p => p !== '');
  const base = parts[parts.length - 1] || '';
  if (!/\.(md|txt)$/i.test(base)) return { why: 'type' };
  if (parts.slice(1).some(p => p.startsWith('.') || p === 'node_modules')) return { why: 'hidden' };
  const name = parts.join(FOLDER.sep);
  if (!name || name.length > FOLDER.nameMax || /[\x00-\x1f\x7f\\]/.test(name)) return { why: 'name' };
  return { name };
}

// 選んだ物の一覧 [{ path, file }] → 送る物 [{ name, file }] と、送らない物の理由ごとの数
// 同じ名前（大文字小文字の違いも）に潰れる物は 2 件目から送らない（why: dup）
export function planFolder(entries) {
  const take = [], skipped = { type: 0, hidden: 0, name: 0, dup: 0, size: 0 }, seen = new Set();
  for (const e of entries || []) {
    const c = classify(e.path);
    if (c.why) { skipped[c.why] += 1; continue; }
    const key = c.name.toLowerCase();
    if (seen.has(key)) { skipped.dup += 1; continue; }
    seen.add(key); take.push({ name: c.name, file: e.file });
  }
  return { take, skipped };
}

// 読み込んだ文字列の大きさ（図書室と同じく UTF-8 のバイト数）
export const utf8Bytes = text => new TextEncoder().encode(String(text)).length;

// 読み込んだ物 [{ name, text }] を、1 回 20 件・JSON に直した長さで 2MB までの束に分ける。200KB を超える物は外す
export function toBatches(docs) {
  const batches = [], tooBig = [];
  let cur = [], curBytes = 2;
  for (const d of docs || []) {
    if (utf8Bytes(d.text) > FOLDER.docBytes) { tooBig.push(d.name); continue; }
    const len = utf8Bytes(JSON.stringify(d)) + 1;
    if (cur.length && (cur.length >= FOLDER.batchDocs || curBytes + len > FOLDER.batchBytes)) { batches.push(cur); cur = []; curBytes = 2; }
    cur.push({ name: d.name, text: d.text }); curBytes += len;
  }
  if (cur.length) batches.push(cur);
  return { batches, tooBig };
}

// 束ごとの結果 [{ name, ok, why }] を数える（置いた数と、図書室が断った理由ごとの数）
export function tally(results) {
  const out = { put: 0, refused: {} };
  for (const r of results || []) { if (r.ok) out.put += 1; else out.refused[r.why || 'library_failed'] = (out.refused[r.why || 'library_failed'] || 0) + 1; }
  return out;
}
