// 部屋と家具の絵（床・壁・机・本棚・ソファなど）。座標は配置図のマス（tile）で受け取り、S（1 マスの px）と原点で px にする。
// 文字は描かない（名札は index.mjs が labels から描く）。DOM には触らない。

// 色（元の chibi-office の theme の色を写した物）
export const C = {
  bg: '#f8f2e7', hall: '#efe4d2', wall: '#f5ead6', wallTop: '#c9a57a', wallLine: '#8a6a4c', wainscot: '#c7a27a',
  wood: '#d2a878', woodDark: '#94704c', woodLight: '#e6c59c', metal: '#b3aea6', screen: '#33302c', screenOn: '#ffe2a8',
  sofa: '#8fae8b', sofaDark: '#6b8a68', plant: '#6ea25c', pot: '#d39a6a', paper: '#fffdf6', rug: '#d9b48a', chair: '#a07a56',
  accent: '#e8a85c', vending: '#6c8fb0', gold: '#f2c94c', gold2: '#c9972e', window: '#bfe0f5', cloud: '#ffffff',
  books: ['#c8604d', '#8fae8b', '#e8a85c', '#6c8fb0', '#d99aa5', '#a7835b'],
  floor: { ceo: '#e3c9a4', office: '#efe3cf', design: '#e3ecef', lounge: '#eadcc4' },
  floorLine: { ceo: '#d4b48a', office: '#e2d3ba', design: '#d2dde2', lounge: '#dccaa9' },
  label: '#fffaf0', labelBg: '#5b4636', text: '#3e3226',
};

// 描く道具: tile の座標の四角を px で塗る
export function painter(ctx, S, ox, oy) {
  return (c, x, y, w, h) => { ctx.fillStyle = c; ctx.fillRect(ox + x * S, oy + y * S, w * S, h * S); };
}

// 床と壁（上の壁は窓つき・下の壁に入口の切れ目）
export function room(R, r, S) {
  const t = 1 / 16; // 細い線の太さ（マス）
  R(C.floor[r.id], r.x, r.y, r.w, r.h);
  for (let x = r.x + 1; x < r.x + r.w; x++) R(C.floorLine[r.id], x, r.y + 1, t, r.h - 1); // 床板の目地
  for (let y = r.y + 2; y < r.y + r.h; y++) R(C.floorLine[r.id], r.x, y, r.w, t);
  R(C.wall, r.x, r.y, r.w, 1); R(C.wainscot, r.x, r.y + 0.7, r.w, 0.3); R(C.wallTop, r.x, r.y, r.w, 0.18);
  for (let x = r.x + 1.5; x + 1.4 < r.x + r.w - 0.5; x += 3) { R(C.wallLine, x - t, r.y + 0.22, 1.2 + 2 * t, 0.42 + t); R(C.window, x, r.y + 0.25, 1.2, 0.4); R(C.cloud, x + 0.2, r.y + 0.32, 0.4, 0.1); R(C.wallLine, x + 0.6 - t / 2, r.y + 0.25, t, 0.4); }
  const L = 0.12; // 縁の壁
  R(C.wallLine, r.x, r.y, r.w, L); R(C.wallLine, r.x, r.y, L, r.h); R(C.wallLine, r.x + r.w - L, r.y, L, r.h);
  const door = r.x + Math.floor(r.w / 2) - 0.5; // 下の壁の真ん中が入口
  R(C.wallLine, r.x, r.y + r.h - L, door - r.x, L); R(C.wallLine, door + 1.5, r.y + r.h - L, r.x + r.w - door - 1.5, L);
}

// 机（幅 w マス）。画面は担当が作業中なら明るい。キャラクターの後に描き、座った人の下半身を隠す
export function desk(R, x, y, w, on, kind) {
  const t = 1 / 16;
  R('#00000022', x + 0.1, y + 0.95, w, 0.12); // 影
  R(C.woodDark, x, y + 0.42, w, 0.58); R(kind === 'ceo' ? C.woodDark : C.wood, x, y + 0.25, w, 0.25); R(C.woodLight, x, y + 0.25, w, t);
  if (kind === 'ceo') { R(C.gold2, x, y + 0.5, w, 0.06); R(C.gold, x + w / 2 - 0.3, y + 0.62, 0.6, 0.18); }
  if (kind === 'design') { R(C.paper, x + w - 1.35, y + 0.05, 0.7, 0.32); R('#e57373', x + w - 1.25, y + 0.12, 0.15, 0.1); R('#64b5f6', x + w - 1.05, y + 0.18, 0.2, 0.1); R('#81c784', x + w - 1.2, y + 0.25, 0.25, 0.06); }
  const mx = x + w - 0.72; // 画面は机の右の端（座った人の顔を隠さない。人は SEAT_X の所）
  R(C.metal, mx + 0.28, y + 0.12, 0.1, 0.15); R(C.metal, mx, y - 0.3, 0.64, 0.46); R(on ? C.screenOn : C.screen, mx + 0.05, y - 0.25, 0.54, 0.36);
  if (on) { R('#00000030', mx + 0.1, y - 0.18, 0.3, 0.05); R('#00000030', mx + 0.1, y - 0.08, 0.38, 0.05); }
}

export function plant(R, x, y) { R(C.pot, x + 0.25, y + 0.55, 0.5, 0.45); R('#00000022', x + 0.25, y + 0.9, 0.5, 0.1); R(C.plant, x + 0.1, y + 0.1, 0.8, 0.5); R('#8cc07a', x + 0.3, y, 0.4, 0.3); R('#55834a', x + 0.15, y + 0.4, 0.7, 0.15); }
export function shelf(R, x, y, w) {
  R(C.woodDark, x, y, w, 1.3); R(C.wood, x + 0.08, y + 0.08, w - 0.16, 1.14);
  for (let row = 0; row < 2; row++) { R(C.woodDark, x, y + 0.6 * (row + 1), w, 0.06); for (let i = 0; i * 0.22 < w - 0.3; i++) R(C.books[(i + row * 3) % C.books.length], x + 0.12 + i * 0.22, y + 0.2 + row * 0.6, 0.18, 0.4); }
}
export function board(R, x, y, w) { R(C.metal, x, y, w, 0.9); R('#ffffff', x + 0.08, y + 0.08, w - 0.16, 0.74); R('#64b5f6', x + 0.3, y + 0.25, w * 0.4, 0.06); R('#e57373', x + 0.3, y + 0.45, w * 0.3, 0.06); R('#81c784', x + w * 0.6, y + 0.3, 0.3, 0.3); }
export function easel(R, x, y) { R(C.woodDark, x + 0.15, y + 0.4, 0.08, 1); R(C.woodDark, x + 0.75, y + 0.4, 0.08, 1); R(C.paper, x, y, 1, 0.8); R('#f6b26b', x + 0.15, y + 0.15, 0.35, 0.3); R('#8fd3f4', x + 0.45, y + 0.35, 0.4, 0.3); R('#c3a6ff', x + 0.2, y + 0.5, 0.2, 0.15); }
export function sofa(R, x, y, w) { R(C.sofaDark, x, y, w, 1); R(C.sofa, x + 0.15, y + 0.1, w - 0.3, 0.5); R(C.sofa, x, y + 0.55, w, 0.45); R(C.sofaDark, x + w / 2 - 0.03, y + 0.15, 0.06, 0.4); R('#00000022', x, y + 1, w, 0.1); }
export function table(R, x, y, w) { R('#00000022', x + 0.1, y + 0.55, w, 0.12); R(C.woodDark, x, y + 0.2, w, 0.4); R(C.woodLight, x, y, w, 0.3); R('#ffffff', x + w / 2 - 0.15, y + 0.02, 0.3, 0.18); R('#8a5a3a', x + w / 2 - 0.1, y + 0.04, 0.2, 0.06); }
export function vending(R, x, y) { R(C.vending, x, y, 1, 1.6); R('#dbe7f3', x + 0.1, y + 0.15, 0.55, 0.9); for (let i = 0; i < 3; i++) R(C.books[i * 2], x + 0.15 + i * 0.17, y + 0.3, 0.12, 0.2); R('#33302c', x + 0.75, y + 0.4, 0.15, 0.3); R('#33302c', x + 0.15, y + 1.25, 0.6, 0.15); }
export function rug(R, x, y, w, h) { R(C.rug, x, y, w, h); R('#e7c9a2', x + 0.15, y + 0.15, w - 0.3, h - 0.3); }
