// キャラクターの絵: 2 頭身の可愛い動物（ネコ・ウサギ・ペンギン・クマ）とちびキャラの人をドットで描く（fine の 5 つ）、
// と、四角で描く簡単なネコとロボット（simple の 2 つ）。
// 足もと (px, py) が原点、高さ H を 48 ドットとして描く。DOM には触らない。
// OffscreenCanvas がある所（ブラウザ）では、こまの絵を 1 回描いて取っておき毎こまは貼るだけ。無い所（node の試験）では毎回 ctx に直に描く。
const memo = new Map();
const rgb = c => { let s = String(c || '#888888').replace('#', ''); if (s.length <= 4) s = [...s].map(ch => ch + ch).join(''); return [0, 2, 4].map(i => parseInt(s.slice(i, i + 2), 16) || 0); };
const mix = (a, b, k) => { const key = `${a}|${b}|${k}`; let v = memo.get(key); if (v) return v; const A = rgb(a), B = rgb(b); v = '#' + A.map((x, i) => Math.round(x + (B[i] - x) * k).toString(16).padStart(2, '0')).join(''); memo.set(key, v); return v; };
const dk = (c, k = 0.2) => mix(c, '#000000', k), lt = (c, k = 0.2) => mix(c, '#ffffff', k);
const bright = c => { const [r, g, b] = rgb(c); return (r * 299 + g * 587 + b * 114) / 255000; };


const OX = 26, OY = 62, CW = 52, CH = 70; // こまの絵の大きさ（ドット）と原点
const ell = (q, c, cx, cy, rx, ry) => { for (let y = -ry; y <= ry; y++) { const t = (y + (y < 0 ? 0.5 : -0.5)) / ry, hw = Math.round(rx * Math.sqrt(Math.max(0, 1 - t * t))); if (hw > 0) q(c, cx - hw, cy + y, hw * 2, 1); } };
const oell = (q, c, ol, cx, cy, rx, ry) => { ell(q, ol, cx, cy, rx + 1, ry + 1); ell(q, c, cx, cy, rx, ry); }; // 縁どりつきの楕円
const orect = (q, c, ol, x, y, w, h) => { q(ol, x, y - 1, w, h + 2); q(ol, x - 1, y, w + 2, h); q(c, x, y, w, h); };

// ---- 顔（動物も人も同じ決まり）: 2×3 の点の目に光は 1 ドットだけ・目は低めに離して・ほっぺは淡い桃色・口は小さく ----
const EYE = '#3b2b2f', MOUTH = '#6a4448', DARK_EYE = '#2a1c22';
function face(q, o) { // o = { c: 顔の中心, ey: 目の上の行, eyes, mood, dark: 暗い毛（明るい顔の上に暗い目）, skin: ほっぺを混ぜる地の色, lx/rx: 目の左端, eh: 目の高さ, lash: まつ毛, blush: [左x, 右x, 行, 幅, 色] }
  const { c, ey } = o, lx = o.lx ?? c - 6, rx = o.rx ?? c + 5, eh = o.eh || 3, line = o.dark ? DARK_EYE : EYE, eye = line;
  const [bl, br, by, bw, bc] = o.blush || [c - 10, c + 7, ey + 4, 4, mix('#f59fb3', o.skin, 0.3)];
  q(bc, bl, by, bw, 2); q(bc, br, by, bw, 2); // ほっぺ
  if (o.mood === 'error') { // > <
    q(line, lx - 1, ey, 2, 1); q(line, lx + 1, ey + 1, 1, 1); q(line, lx - 1, ey + 2, 2, 1);
    q(line, rx + 1, ey, 2, 1); q(line, rx, ey + 1, 1, 1); q(line, rx + 1, ey + 2, 2, 1); return;
  }
  for (const x of [lx, rx]) {
    if (o.eyes === 'open') { q(eye, x, ey, 2, eh); q('#ffffff', x + 1, ey, 1, 1); if (o.lash) q(eye, x === lx ? x - 1 : x + 2, ey, 1, 1); } // 黒目に光は右上の 1 ドットだけ
    if (o.eyes === 'happy') { q(line, x, ey + 1, 2, 1); q(line, x - 1, ey + 2, 1, 1); q(line, x + 2, ey + 2, 1, 1); } // ^ ^
    if (o.eyes === 'closed' || o.eyes === 'blink') q(line, x - 1, ey + 2, 4, 1); // - -
  }
}
const sweat = (q, x, y) => { q('#6fb7e6', x, y, 1, 1); q('#6fb7e6', x - 1, y + 1, 3, 2); q('#6fb7e6', x, y + 3, 1, 1); q('#e3f4ff', x - 1, y + 1, 1, 1); }; // 小さな汗
// まるいめがね: 細い淡い枠（角は抜く）・短いブリッジ。目は枠の中に見える
const glasses = (q, lx, rx, ey, eh = 3) => { const fc = '#8a6f7a'; for (const x of [lx, rx]) { q(fc, x, ey - 1, 2, 1); q(fc, x, ey + eh, 2, 1); q(fc, x - 1, ey, 1, eh); q(fc, x + 2, ey, 1, eh); } q(fc, lx + 3, ey + 1, rx - lx - 4, 1); };

// k = { kind, col, acc, outfit, boss, legs, arms, eyes, tilt, mood, ... }。q(色, x, y, 幅, 高さ) は足もとからのドット
function paint(q, k) {
  if (k.kind === 'human') { human(q, k); return; }
  const col = k.col, dark = bright(col) < 0.32, ol = dark ? mix(col, '#120c1e', 0.5) : mix(dk(col, 0.42), '#4a2f4f', 0.3), light = lt(col, 0.45), shade = dk(col, 0.14), pink = '#f6a5c0', pg = k.kind === 'penguin'; // 縁は体の色の 2 段暗い色（黒くしない）
  const rim = dark ? lt(col, 0.28) : null; // 暗い体は内側に明るい縁（黒ネコが背景に溶けない）
  const fur = pg ? col : col, belly = pg ? '#fbfbf8' : bright(col) > 0.85 ? '#ffffff' : light;
  const hx = k.tilt, HY = -31, fx = 1; // 頭の中心（tilt で 1 ドット傾ける）・顔は向きの側へ 1 ドット

  // しっぽ（背中の側 = 左）
  if (k.kind === 'cat') { const pts = [[-7, -8], [-9, -9], [-11, -10], [-12, -12], [-13, -14], [-13, -16], [-13, -18], [-12, -20], [-11, -21]]; for (const [x, y] of pts) q(ol, x - 1, y - 1, 4, 4); for (const [x, y] of pts) q(fur, x, y, 2, 2); q(lt(fur, 0.3), -12, -20, 1, 1); }
  if (k.kind === 'rabbit') { oell(q, '#ffffff', ol, -8, -8, 3, 3); q('#f2f2f2', -9, -7, 3, 1); }
  if (k.kind === 'bear') oell(q, shade, ol, -8, -8, 2, 2);
  if (pg) { q(ol, -6, -5, 5, 3); q(fur, -5, -5, 3, 2); }

  // 足
  const footC = pg ? '#ffa726' : k.kind === 'cat' || k.kind === 'rabbit' ? (bright(col) > 0.8 ? '#f4f0ea' : lt(col, 0.2)) : dk(col, 0.1);
  const feet = k.legs === 'walkA' ? [[-6, -1, -1], [1, 0, 1]] : k.legs === 'walkB' ? [[-6, 0, -1], [1, -1, 1]] : k.legs === 'sit' ? [[-7, 0, 0], [2, 0, 0]] : [[-6, 0, 0], [1, 0, 0]];
  for (const [x, lift, dx] of feet) { const fy = -4 + lift; q(pg ? '#e65100' : ol, x + dx - 1, fy - 1, 7, 5); q(footC, x + dx, fy, 5, 3); q(lt(footC, 0.35), x + dx, fy, 3, 1); if (!pg) q(dk(footC, 0.15), x + dx + 1, fy + 2, 1, 1); }

  // 体
  orect(q, fur, ol, -7, -19, 14, 15); q(fur, -8, -17, 1, 11); q(fur, 7, -17, 1, 11); q(ol, -9, -17, 1, 11); q(ol, 8, -17, 1, 11);
  q(shade, -8, -7, 16, 3); q(lt(fur, 0.18), -6, -18, 3, 1);
  if (pg) { ell(q, belly, 1, -11, 6, 7); q(lt(belly, 0.5), -2, -16, 2, 1); }
  else if (k.outfit !== 'apron') { ell(q, belly, 1, -10, 4, 5); }
  const a = k.acc;
  if (k.outfit === 'tie') { q('#ffffff', -4, -19, 3, 2); q('#ffffff', 2, -19, 3, 2); q(dk(a, 0.3), -1, -19, 3, 2); q(a, -1, -17, 3, 6); q(a, 0, -11, 1, 2); q(lt(a, 0.35), -1, -17, 1, 4); }
  if (k.outfit === 'collar') { q(a, -7, -19, 15, 2); q(lt(a, 0.35), -7, -19, 15, 1); q(dk('#f2c94c', 0.35), -1, -18, 4, 4); q('#f2c94c', -1, -18, 3, 3); q('#fffde7', -1, -18, 1, 1); q(dk('#f2c94c', 0.5), 0, -16, 1, 1); } // 鈴の首輪
  if (k.outfit === 'bow') { for (let i = 0; i < 3; i++) { q(a, -5 + i, -19 + i - 1, 1, 5 - i * 2 + 2); q(a, 5 - i, -19 + i - 1, 1, 5 - i * 2 + 2); } q(dk(a, 0.3), -1, -18, 3, 3); q(lt(a, 0.4), -4, -19, 1, 1); } // 蝶ネクタイ
  if (k.outfit === 'scarf') { q(a, -7, -20, 15, 3); q(lt(a, 0.3), -7, -20, 15, 1); q('#ffffff', -3, -19, 1, 2); q('#ffffff', 2, -19, 1, 2); q(a, 3, -17, 3, 7); q('#ffffff', 3, -14, 3, 1); q(dk(a, 0.25), 3, -11, 3, 1); } // マフラー
  if (k.outfit === 'apron') { q(a, -5, -15, 11, 11); q(lt(a, 0.3), -5, -15, 11, 1); q(a, -4, -19, 1, 4); q(a, 4, -19, 1, 4); q(dk(a, 0.2), -2, -10, 5, 3); q(lt(a, 0.45), -2, -10, 5, 1); q(dk(a, 0.25), -5, -5, 11, 1); } // エプロンとポケット

  // 腕（前足・ひれ）
  const handC = pg ? fur : bright(col) > 0.85 ? '#ffffff' : lt(col, 0.25);
  const arm = (side, x, y, len = 6) => { if (pg) { q(ol, x - 1, y - 1, 4, len + 2); q(fur, x, y, 2, len); q(lt(fur, 0.2), x, y, 1, len - 2); return; } q(ol, x - 1, y - 1, 5, len + 1); q(fur, x, y, 3, len - 1); q(ol, x - 1, y + len - 2, 5, 4); q(handC, x, y + len - 2, 3, 2); };
  if (k.arms === 'down') { arm(-1, -10, -16); arm(1, 8, -16); }
  if (k.arms === 'swingA') { arm(-1, -10, -17); arm(1, 8, -15); }
  if (k.arms === 'swingB') { arm(-1, -10, -15); arm(1, 8, -17); }
  if (k.arms === 'typeA' || k.arms === 'typeB') { const up = k.arms === 'typeA' ? 1 : 0; q(ol, -7, -12 - up, 6, 4); q(handC, -6, -11 - up, 4, 2); q(ol, 2, -13 + up, 6, 4); q(handC, 3, -12 + up, 4, 2); q(fur, -8, -15, 2, 3); q(fur, 7, -15, 2, 3); } // 打っている手
  if (k.arms === 'up') { arm(-1, -11, -22, 6); arm(1, 9, -22, 6); }

  // 耳（頭の後ろ）
  if (k.kind === 'cat') for (const s of [-1, 1]) { const ex = hx + s * 8; for (let r = 0; r < 9; r++) { const w = 2 + Math.floor(r * 0.9); q(ol, ex - Math.ceil(w / 2) - 1, -50 + r, w + 2, 1); } for (let r = 0; r < 8; r++) { const w = 1 + Math.floor(r * 0.9); q(fur, ex - Math.ceil(w / 2), -49 + r, w, 1); if (r > 2) q(pink, ex - Math.ceil((w - 2) / 2), -48 + r, Math.max(1, w - 3), 1); } }
  if (k.kind === 'rabbit') { const flop = k.flop; for (const s of [-1, 1]) { const ex = hx + s * 5, top = -60; if (flop && s > 0) { orect(q, fur, ol, ex - 2, -50, 5, 8); orect(q, fur, ol, ex + 1, -51, 6, 4); q(pink, ex, -49, 2, 6); continue; }
      orect(q, fur, ol, ex - 2, top + 1, 5, 18); q(ol, ex - 1, top, 3, 1); q(pink, ex - 1, top + 3, 3, 14); q(lt(pink, 0.4), ex - 1, top + 3, 1, 6); } }
  if (k.kind === 'bear') for (const s of [-1, 1]) { oell(q, fur, ol, hx + s * 10, -42, 4, 4); ell(q, dk(fur, 0.25), hx + s * 10, -42, 2, 2); }

  // 頭
  oell(q, fur, ol, hx, HY, 14, 12); q(shade, hx - 11, HY + 9, 22, 2); q(lt(fur, 0.35), hx - 9, HY - 10, 5, 1); q(lt(fur, 0.35), hx - 11, HY - 8, 2, 2);
  if (rim) { q(rim, hx - 6, HY - 12, 9, 1); q(rim, hx - 10, HY - 10, 3, 1); q(rim, hx - 12, HY - 8, 1, 3); q(rim, hx - 14, HY - 4, 1, 6); }
  if (k.kind === 'cat' && k.tabby) for (const x of [-3, 0, 3]) q(dk(fur, 0.22), hx + x, HY - 12, 1, 3);
  if (pg) { ell(q, '#fbfbf8', hx + fx, HY + 3, 10, 8); ell(q, '#fbfbf8', hx + fx - 5, HY - 2, 5, 5); ell(q, '#fbfbf8', hx + fx + 5, HY - 2, 5, 5); q('#ffffff', hx + fx - 7, HY - 5, 2, 1); }
  if (k.boss) { const cy = HY - 13 - (k.kind === 'rabbit' ? 0 : 0); q('#8a6a1c', hx - 6, cy - 4, 13, 6); q('#f2c94c', hx - 5, cy - 3, 11, 4); for (const x of [-5, 0, 5]) { q('#8a6a1c', hx + x - 1, cy - 7, 3, 4); q('#f2c94c', hx + x, cy - 6, 1, 3); } q('#e53935', hx, cy - 2, 1, 2); q('#fff59d', hx - 4, cy - 3, 2, 1); } // 社長の小さな王冠

  // 顔（日本の可愛い: 小さな点の目・低めに離して・ほっぺ・小さな口）
  const c = hx + fx, ey = HY + 1, faceDark = dark && !pg;
  if (k.kind === 'bear') ell(q, lt(fur, 0.4), c, HY + 6, 5, 4); // 口のまわり
  const mask = faceDark ? lt(fur, 0.35) : null; // 暗い毛は顔の下半分を明るくして、目は暗いまま（光る目にしない）
  if (mask) { ell(q, mask, c, ey + 3, 10, 4); ell(q, mask, c, ey + 1, 8, 3); }
  face(q, { c, ey, eyes: k.eyes, mood: k.mood, dark: faceDark, skin: pg ? '#fbfbf8' : mask || fur });
  const my = ey + 4, mc = MOUTH;
  if (k.kind === 'cat') { q('#e98aa6', c - 1, my - 2, 3, 1); q('#e98aa6', c, my - 1, 1, 1); for (const [x, y] of [[-2, 0], [-1, 1], [0, 0], [1, 1], [2, 0]]) q(mc, c + x, my + y, 1, 1); // ω の口
    const wc = mix(ol, fur, 0.45); q(wc, hx - 15, my - 1, 3, 1); q(wc, hx - 15, my + 1, 3, 1); q(wc, hx + 14, my - 1, 3, 1); q(wc, hx + 14, my + 1, 3, 1); } // 短いひげ
  if (k.kind === 'rabbit') { q('#ef8fae', c - 1, my - 1, 3, 1); q(mc, c, my, 1, 1); q(mc, c - 1, my + 1, 1, 1); q(mc, c + 1, my + 1, 1, 1); } // ㅅ の口
  if (k.kind === 'bear') { q('#5a3d33', c - 1, my - 1, 3, 2); q('#8a6a5e', c - 1, my - 1, 1, 1); q(MOUTH, c, my + 1, 1, 1); q(MOUTH, c - 1, my + 2, 1, 1); q(MOUTH, c + 1, my + 2, 1, 1); }
  if (pg) { q('#e08a2e', c - 2, my - 1, 5, 1); q('#ffb74d', c - 1, my, 3, 1); } // 小さなくちばし
  if (k.mood === 'error') sweat(q, c + 12, HY - 8);
  // 1 人ずつの小物（めがね・リボン・花・ヘッドホン・ベレー帽・星のピン）。社長は王冠だけ
  const it = k.boss ? '' : k.item, ia = k.acc2 || a;
  if (it === 'glasses') glasses(q, c - 6, c + 5, ey);
  if (it === 'ribbon') { const rx = hx + 8, ry = HY - 10; q(dk(ia, 0.35), rx - 5, ry - 3, 4, 7); q(dk(ia, 0.35), rx + 2, ry - 3, 4, 7); q(ia, rx - 4, ry - 2, 3, 5); q(ia, rx + 2, ry - 2, 3, 5); q(lt(ia, 0.45), rx - 4, ry - 2, 1, 2); q(dk(ia, 0.45), rx - 1, ry - 1, 3, 3); q(lt(ia, 0.3), rx, ry - 1, 1, 1); q(ia, rx - 2, ry + 2, 2, 3); q(ia, rx + 1, ry + 2, 2, 3); }
  if (it === 'flower') { const fx0 = hx - 9, fy0 = HY - 9, pc = lt(ia, 0.25); for (const [dx, dy] of [[0, -3], [-3, 0], [3, 0], [-2, 2], [2, 2]]) { q(dk(pc, 0.3), fx0 + dx - 1, fy0 + dy - 1, 4, 4); q(pc, fx0 + dx, fy0 + dy, 2, 2); } q('#ffd54f', fx0, fy0, 2, 2); q('#fff8e1', fx0, fy0, 1, 1); q('#66bb6a', fx0 + 3, fy0 + 3, 3, 1); }
  if (it === 'phones') { const bc = '#4a4458'; for (let i = 0; i < 25; i++) { const t = (i / 24) * Math.PI, x = Math.round(hx - Math.cos(t) * 14), y = Math.round(HY - 4 - Math.sin(t) * 12); q(bc, x, y, 2, 2); } for (const s of [-1, 1]) { const cx0 = hx + s * 14 - (s < 0 ? 3 : 1); q(dk(ia, 0.4), cx0 - 1, HY - 6, 6, 10); q(ia, cx0, HY - 5, 4, 8); q(lt(ia, 0.4), cx0, HY - 5, 1, 4); } }
  if (it === 'beret') { const by = HY - 11; q(dk(ia, 0.4), hx - 10, by - 3, 18, 5); q(ia, hx - 9, by - 3, 16, 4); q(dk(ia, 0.4), hx - 8, by - 5, 13, 2); q(ia, hx - 7, by - 5, 11, 2); q(lt(ia, 0.35), hx - 6, by - 5, 6, 1); q(dk(ia, 0.5), hx - 1, by - 7, 2, 2); q(dk(ia, 0.25), hx - 9, by, 16, 1); }
  if (it === 'star') { const sx = hx + 9, sy = HY - 8, sc = '#ffd54f', sd = '#c99a1e'; q(sd, sx - 1, sy - 4, 3, 9); q(sd, sx - 4, sy - 1, 9, 3); q(sc, sx, sy - 3, 1, 7); q(sc, sx - 3, sy, 7, 1); q(sc, sx - 1, sy - 1, 3, 3); q('#fffde7', sx - 1, sy - 1, 1, 1); }
}

// ---- 人（2 頭身のちびキャラの社員）: 大きな丸い頭・髪型 6 種・服 6 種。顔は日本の可愛い（近めの点の目・低めの顔・小さな口・横の髪で顔を囲む） ----
const SKIN = '#ffe3d0', SKIN_OL = '#c98e7a', WHITE = '#fbf9f5', SHOE = '#6a5048';
function human(q, k) {
  const hair = k.col, darkHair = bright(hair) < 0.3, hol = dk(hair, 0.35), hl = darkHair ? mix(hair, '#8a9ad0', 0.35) : lt(hair, 0.25), a = k.acc, a2 = k.acc2 || a; // 縁どりは塗りの暗い色（黒へ寄せない）
  const hx = k.tilt, HY = -31, c = hx + 1, st = k.hair, of = k.boss ? 'boss' : k.outfit, girl = st === 'pony' || st === 'twin' || st === 'long';
  const top = of === 'shirt' || of === 'vest' ? WHITE : of === 'boss' ? '#2e3856' : a, tol = dk(top, 0.35);
  const pants = of === 'hoodie' ? '#5b739c' : of === 'suit' || of === 'blazer' ? dk(a, 0.3) : of === 'boss' ? '#2e3856' : '#4b5266', pol = dk(pants, 0.35);
  const bow = (x, y, col) => { q(dk(col, 0.3), x, y, 5, 3); q(col, x, y, 2, 2); q(col, x + 3, y, 2, 2); q(lt(col, 0.4), x, y, 1, 1); q(dk(col, 0.4), x + 2, y + 1, 1, 1); }; // 髪のリボン（5×3 まで）

  // 後ろの髪（体より奥）
  if (st === 'long') { orect(q, hair, hol, hx - 14, HY - 2, 28, 17); for (let x = -13; x < 14; x += 3) q(hol, hx + x, HY + 15, 1, 1); }
  if (st === 'pony') { oell(q, hair, hol, hx - 16, HY - 1, 3, 5); oell(q, hair, hol, hx - 17, HY + 6, 3, 4); q(hl, hx - 17, HY - 3, 1, 3); }
  if (st === 'twin') for (const s of [-1, 1]) { oell(q, hair, hol, hx + s * 16, HY + 4, 3, 8); q(hl, hx + s * 16 - 1, HY - 1, 1, 4); }

  // 足と腰（スカートか ズボン）: 脚は 3 ドット・靴は小さく
  const feet = k.legs === 'walkA' ? [[-6, -1, -1], [1, 0, 1]] : k.legs === 'walkB' ? [[-6, 0, -1], [1, -1, 1]] : k.legs === 'sit' ? [[-7, 0, 0], [2, 0, 0]] : [[-6, 0, 0], [1, 0, 0]];
  const skirt = of === 'vest';
  for (const [x, lift, dx] of feet) { const fy = -3 + lift, lx = x + dx + 1, lh = fy + 9;
    if (skirt) { q(SKIN, lx, -9, 3, lh); q(mix(SKIN, SKIN_OL, 0.45), lx + 2, -9, 1, lh); } else { q(pants, lx, -9, 3, lh); q(pol, lx + 2, -9, 1, lh); }
    q(SHOE, x + dx, fy, 5, 3); q(lt(SHOE, 0.3), x + dx + 1, fy, 2, 1); q(dk(SHOE, 0.2), x + dx, fy + 2, 5, 1); }
  if (skirt) { const sc = dk(a, 0.25), so = dk(sc, 0.35); for (let r = 0; r < 3; r++) { q(so, -7 - r, -11 + r, 14 + r * 2, 1); q(sc, -6 - r, -11 + r, 12 + r * 2, 1); } q(so, -9, -8, 18, 1); q(lt(sc, 0.2), -4, -10, 1, 2); q(lt(sc, 0.2), 3, -10, 1, 2); } // 短めのスカート（脚が見える）
  else orect(q, pants, pol, -6, -11, 12, 3);

  // 胴（服）
  orect(q, top, tol, -7, -18, 14, 8);
  if (of === 'shirt') { q('#e4ded4', -4, -18, 3, 1); q('#e4ded4', 2, -18, 3, 1); q(dk(a, 0.25), -1, -18, 2, 1); q(a, -1, -17, 2, 5); q(dk(a, 0.25), -1, -12, 2, 1); q('#e9e4dc', -6, -11, 12, 1); }
  if (of === 'cardigan') { q(WHITE, -2, -18, 4, 8); q(dk(a, 0.3), -3, -18, 1, 8); q(dk(a, 0.3), 2, -18, 1, 8); q(dk(a, 0.35), -4, -16, 1, 1); q(dk(a, 0.35), -4, -13, 1, 1); q(lt(a, 0.2), -6, -17, 2, 1); q(dk(a, 0.15), -7, -11, 14, 1); }
  if (of === 'blazer' || of === 'suit' || of === 'boss') { const tie = of === 'boss' ? '#c0392b' : of === 'suit' ? '#b04a52' : dk(a2, 0.1), lap = of === 'boss' ? '#4a5680' : dk(a, 0.25);
    q(WHITE, -2, -18, 4, 3); q(WHITE, -1, -15, 2, 1); q(tie, -1, -17, 2, 4); q(lap, -3, -18, 1, 5); q(lap, 2, -18, 1, 5); q(lap, -2, -14, 1, 1); q(lap, 1, -14, 1, 1); q(dk(top, 0.35), 0, -12, 1, 1);
    if (of === 'boss') { q('#ffffff', 3, -16, 2, 1); q('#b8901e', -6, -16, 2, 2); q('#f2c94c', -6, -16, 1, 1); } } // 社長: 胸の小さなバッジとポケットチーフ
  if (of === 'hoodie') { q(dk(a, 0.18), -6, -18, 12, 2); q(lt(a, 0.15), -5, -18, 10, 1); q(WHITE, -2, -16, 1, 3); q(WHITE, 1, -16, 1, 3); q(dk(a, 0.15), -4, -13, 8, 2); q(dk(a, 0.3), -4, -13, 8, 1); }
  if (of === 'vest') { const vc = a, vd = dk(a, 0.3); q(vc, -7, -17, 4, 7); q(vc, 3, -17, 4, 7); q(vc, -3, -14, 6, 4); q(vd, -3, -17, 1, 3); q(vd, 2, -17, 1, 3); q(vd, 0, -12, 1, 1); q('#d9606a', -2, -18, 4, 1); q('#b84a55', -1, -17, 2, 1); }

  // 腕: 3 ドットの袖を体に 1 ドット重ねる（外の縁どり列は無し）・手は 2×2 の小さな丸
  const sleeve = top, sd = dk(top, of === 'shirt' || of === 'vest' ? 0.12 : 0.18);
  const arm = (x, y, len = 6) => { const out = x < 0 ? x : x + 2, hxp = x < 0 ? x : x + 1; q(sleeve, x, y, 3, len - 2); q(sd, out, y + 1, 1, len - 3); q(sd, x, y + len - 3, 3, 1); q(SKIN, hxp, y + len - 2, 2, 2); q(SKIN_OL, hxp, y + len - 1, 2, 1); };
  if (k.arms === 'down') { arm(-9, -17); arm(7, -17); }
  if (k.arms === 'swingA') { arm(-9, -18); arm(7, -16); }
  if (k.arms === 'swingB') { arm(-9, -16); arm(7, -18); }
  if (k.arms === 'typeA' || k.arms === 'typeB') { const up = k.arms === 'typeA' ? 1 : 0; q(sleeve, -9, -17, 3, 3); q(sd, -9, -16, 1, 2); q(sleeve, 7, -17, 3, 3); q(sd, 9, -16, 1, 2); q(SKIN, -5, -13 - up, 2, 2); q(SKIN_OL, -5, -12 - up, 2, 1); q(SKIN, 3, -14 + up, 2, 2); q(SKIN_OL, 3, -13 + up, 2, 1); }
  if (k.arms === 'up') { arm(-10, -23); arm(8, -23); }

  // 頭: 肌の丸 → 髪のかぶり → 顔の窓（前髪のすぐ下から）→ 前髪 → 横の髪
  oell(q, SKIN, SKIN_OL, hx, HY + 1, 13, 11);
  const short = st === 'spiky' || st === 'side';
  oell(q, hair, hol, hx, HY - 3, 14, short ? 9 : 10);
  if (st === 'spiky') for (const x of [-9, -4, 1, 6]) { q(hol, hx + x, HY - 15, 2, 1); q(hol, hx + x - 1, HY - 14, 4, 2); q(hair, hx + x, HY - 14, 2, 3); }
  ell(q, SKIN, c, HY + 5, 10, 6); q(mix(SKIN, '#f2b9a0', 0.5), c - 6, HY + 11, 12, 1); // 顔とあごの影
  // 前髪（HY-4 から下へ 3〜4 行・目の 1 行上で終わる）
  q(hair, c - 10, HY - 4, 20, 3);
  if (st === 'bob') { q(hair, c - 10, HY - 1, 20, 2); q(SKIN, c - 4, HY, 1, 1); q(SKIN, c + 3, HY, 1, 1); q(hol, c - 10, HY + 1, 1, 1); q(hol, c + 9, HY + 1, 1, 1); } // まっすぐの前髪に小さな切れ目 2 つ
  if (girl) for (const x of [-9, -4, 1, 6]) { q(hair, c + x, HY - 1, 4, 1); q(hair, c + x + 1, HY, 2, 1); if (x === -4 || x === 1) q(hair, c + x + 1, HY + 1, 2, 1); } // 丸い毛先 4 つ
  if (st === 'spiky') for (const x of [-9, -5, -1, 3, 7]) { q(hair, c + x, HY - 1, 3, 1); q(hair, c + x + 1, HY, 1, 1); if (x === -5 || x === 3) q(hair, c + x + 1, HY + 1, 1, 1); } // とがった毛先
  if (st === 'side') { q(hair, c - 10, HY - 1, 15, 1); q(hair, c - 10, HY, 11, 1); q(hair, c - 10, HY + 1, 6, 1); q(hair, c + 6, HY - 1, 2, 1); } // 横に流した前髪
  // 横の髪（頬まで・外側に 1 ドットの縁）
  for (const s of [-1, 1]) { const x = s < 0 ? c - 11 : c + 10, oxl = s < 0 ? x - 1 : x + 2; q(hair, x, HY - 2, 2, 9); q(hol, oxl, HY - 2, 1, 9); q(hol, x + (s < 0 ? 0 : 1), HY + 7, 1, 1); q(hair, x + (s < 0 ? 1 : 0), HY + 7, 1, 1); }
  if (st === 'bob' || st === 'long') for (const s of [-1, 1]) { const x = s < 0 ? hx - 15 : hx + 12; q(hol, x, HY - 2, 4, st === 'long' ? 15 : 11); q(hair, x + (s < 0 ? 1 : 0), HY - 2, 3, st === 'long' ? 14 : 10); }
  // 髪のつや: 頭の丸みに沿った 1 本の弧
  q(hl, hx - 9, HY - 8, 1, 1); q(hl, hx - 8, HY - 9, 2, 1); q(hl, hx - 6, HY - 10, 6, 1); q(hl, hx, HY - 9, 1, 1);
  if (st === 'pony') bow(hx - 17, HY - 8, a2);
  if (st === 'twin') for (const s of [-1, 1]) bow(hx + s * 15 - 2, HY - 6, a2);

  // 顔: 目は近め・低め（女の子の髪型は 2×4 にまつ毛）・ほっぺは顔の内側・口は小さな線
  const ey = HY + 3, my = ey + 4, lx = c - 5, rx = c + 4, eh = girl ? 4 : 3;
  face(q, { c, ey, eyes: k.eyes, mood: k.mood, dark: false, skin: SKIN, lx, rx, eh, lash: girl, blush: [c - 8, c + 6, ey + 3, 3, mix('#f7b6c2', SKIN, 0.5)] });
  if (k.mood === 'error') { q('#c06a6a', c - 1, my + 1, 1, 1); q('#c06a6a', c, my, 1, 1); q('#c06a6a', c + 1, my + 1, 1, 1); sweat(q, c + 11, HY - 6); }
  else if (k.eyes === 'happy') { q('#c06a6a', c - 1, my, 3, 1); q('#f0a0a8', c, my + 1, 1, 1); }
  else q('#c06a6a', c - 1, my, 2, 1); // 小さな口
  if (k.item === 'glasses' && !k.boss) glasses(q, lx, rx, ey, eh);
  if (k.item === 'pin' && !k.boss) { q(dk(a2, 0.3), c + 5, HY - 3, 3, 2); q(a2, c + 5, HY - 3, 2, 1); } // 前髪のピン
}


// ---- こまの絵を取っておく（OffscreenCanvas がある所だけ） ----
const frames = new Map();
const OffCanvas = typeof globalThis.OffscreenCanvas === 'function' ? globalThis.OffscreenCanvas : null;
function frameOf(k, d) {
  const key = Object.values(k).join('|') + '|' + d; let cv = frames.get(key);
  if (!cv) {
    cv = new OffCanvas(Math.ceil(CW * d), Math.ceil(CH * d)); const g = cv.getContext('2d');
    paint((c, x, y, w, h) => { g.fillStyle = c; g.fillRect((OX + x) * d, (OY + y) * d, w * d, h * d); }, k);
    frames.set(key, cv); if (frames.size > 800) frames.delete(frames.keys().next().value);
  }
  return cv;
}

const OUTFIT = { cat: 'collar', rabbit: 'bow', penguin: 'scarf', bear: 'apron' };
const HAIRS = ['bob', 'pony', 'long', 'spiky', 'twin', 'side'], CLOTHES = ['shirt', 'cardigan', 'blazer', 'hoodie', 'vest', 'suit'], HUMAN_ITEMS = ['', '', 'glasses', '', 'pin', '', '']; // 人は髪型・服・小物の組み合わせで見分ける
const ITEMS = ['glasses', 'ribbon', 'phones', 'flower', 'beret', 'star']; // 1 人ずつ違う小物（見分けがつく）
const SEATED = new Set(['work', 'wait', 'sleep', 'error', 'boss']);

// fine の 5 つ。o = { pack, px, py, H, now, anim: 'walk'|'think'|'idle', col, isBoss, pose, face: 1|-1, idx, lift }
function drawFine(cx, o) {
  const { pack: pk, px, py, H, now, anim, col, isBoss, pose, face: faceDir, idx } = o, kind = pk.kind;
  const d = Math.max(0.25, Math.round(H / 48 * 4) / 4), t = now + idx * 977; // ドットの大きさは 1/4 px 刻み（取っておく絵の数を抑える）
  const step = Math.floor(t / 140) % 2, type = Math.floor(t / 130) % 2;
  const seated = SEATED.has(pose);
  const legs = anim === 'walk' ? (step ? 'walkA' : 'walkB') : seated ? 'sit' : 'stand';
  const arms = anim === 'walk' ? (step ? 'swingA' : 'swingB') : anim === 'think' && pose !== 'boss' ? (type ? 'typeA' : 'typeB') : 'down';
  const eyes = pose === 'sleep' ? 'closed' : Math.floor(t / 140) % 24 === 0 ? 'blink' : 'open';
  const tilt = anim === 'think' && Math.sin(t / 1400) > 0.55 ? 1 : 0;
  const i0 = Math.abs(Math.trunc(idx) || 0), accs = Array.isArray(pk.accents) && pk.accents.length ? pk.accents : [pk.accent];
  const k = { kind, col, acc: accs[i0 % accs.length], outfit: pk.outfit || OUTFIT[kind] || '', boss: isBoss ? 1 : 0, legs, arms, eyes, tilt, mood: pose === 'error' ? 'error' : 'normal', tabby: kind === 'cat' && i0 % 3 === 0 ? 1 : 0, flop: kind === 'rabbit' && i0 % 2 === 1 ? 1 : 0,
    item: ITEMS[i0 % ITEMS.length], acc2: accs[(i0 + 2) % accs.length] };
  if (kind === 'human') Object.assign(k, { outfit: CLOTHES[(i0 + Math.floor(i0 / 6)) % 6], hair: HAIRS[i0 % 6], item: HUMAN_ITEMS[i0 % 7] });
  const bob = anim === 'walk' ? step : anim === 'idle' && Math.sin(t / 650) > 0.2 ? 1 : 0, sway = anim === 'walk' && kind === 'penguin' ? (step ? 1 : -1) : 0;
  cx.save(); cx.translate(Math.round(px) + sway * d, Math.round(py) - (bob + (o.lift || 0)) * d); if (faceDir < 0) cx.scale(-1, 1);
  if (OffCanvas) cx.drawImage(frameOf(k, d), -OX * d, -OY * d);
  else paint((c, x, y, w, h) => { cx.fillStyle = c; cx.fillRect(x * d, y * d, w * d, h * d); }, k);
  cx.restore();
}

// simple の 2 つ（四角で描くネコとロボット）
function drawSimple(cx, o) {
  const { pack: pk, px, py, H, now, anim, col, isBoss, pose, face: faceDir, idx } = o, acc = pk.accent;
  const bob = anim === 'walk' ? Math.abs(Math.sin(now / 90)) * H * 0.05 : anim === 'think' ? Math.sin(now / 300) * H * 0.02 : 0;
  const u = H / 10, y0 = -bob;
  cx.save(); cx.translate(px, py); cx.scale(faceDir < 0 ? -1 : 1, 1);
  const box = (c, x, y, w, h) => { cx.fillStyle = c; cx.fillRect(x * u, y0 + y * u, w * u, h * u); };
  const tri = (a, b, c, d, e, f) => { cx.beginPath(); cx.moveTo(a * u, y0 + b * u); cx.lineTo(c * u, y0 + d * u); cx.lineTo(e * u, y0 + f * u); cx.closePath(); cx.fill(); };
  const legs = anim === 'walk' ? (Math.floor(now / 120) % 2 ? 1 : -1) : 0;
  if (pk.kind === 'robot') {
    box('#455a64', -1.6 + legs * 0.3, -1.6, 1.2, 1.6); box('#455a64', 0.4 - legs * 0.3, -1.6, 1.2, 1.6);
    box(col, -2.4, -5.4, 4.8, 3.9); box(acc, -1.4, -4.6, 2.8, 1.6); box(pose === 'error' ? '#ff5252' : '#b2ff59', -1.0, -4.2, 0.6, 0.6);
    box(col, -2.6, -9.6, 5.2, 4.0); box(acc, -1.9, -8.6, 3.8, 1.8);
    const blink = pose === 'sleep' || Math.floor(now / 2200 + idx) % 7 === 0; box('#18ffff', -1.4, -8.2, 0.9, blink ? 0.2 : 0.9); box('#18ffff', 0.5, -8.2, 0.9, blink ? 0.2 : 0.9);
    box(acc, -0.2, -10.6, 0.4, 1.0); cx.fillStyle = anim === 'think' ? '#ffeb3b' : '#ff7043'; cx.beginPath(); cx.arc(0, y0 - 10.8 * u, 0.5 * u, 0, Math.PI * 2); cx.fill();
    if (isBoss) box('#f2c94c', -1.6, -11.4, 3.2, 0.6);
  } else {
    box(col, -1.4 + legs * 0.3, -1.5, 1.0, 1.5); box(col, 0.4 - legs * 0.3, -1.5, 1.0, 1.5);
    box(col, -2.0, -5.0, 4.0, 3.7); box(isBoss ? '#c62828' : acc, -0.3, -4.6, 0.6, 2.6);
    box(col, 1.8, -3.4, 1.8, 0.6); box(col, 3.2, -4.6, 0.6, 1.6); // しっぽ
    box(col, -2.6, -9.2, 5.2, 4.4);
    cx.fillStyle = col; tri(-2.6, -9.0, -1.0, -9.0, -2.2, -11.0); tri(1.0, -9.0, 2.6, -9.0, 2.2, -11.0);
    cx.fillStyle = '#f8bbd0'; tri(-2.2, -9.1, -1.4, -9.1, -2.0, -10.2); tri(1.4, -9.1, 2.2, -9.1, 2.0, -10.2);
    const blink = pose === 'sleep' || Math.floor(now / 2600 + idx) % 6 === 0, eye = blink ? 0.2 : 0.8;
    box('#222', -1.6, -7.8, 0.8, eye); box('#222', 0.8, -7.8, 0.8, eye); box('#e57373', -0.3, -6.6, 0.6, 0.4); box('#0004', -2.6, -5.3, 5.2, 0.5);
  }
  cx.restore();
}

// 1 人を描く。pack は packs.mjs の PACKS の 1 つ
export function drawChar(cx, o) {
  if (o.pack.style === 'fine') drawFine(cx, o); else drawSimple(cx, o);
}
