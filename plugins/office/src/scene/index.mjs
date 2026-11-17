// office の画面の「絵」: 1 つのオフィスの配置図（社長室・執務室・デザイン部・休憩室）と、机に座る担当を canvas の 2D に描く。
// 依存なし・DOM に触らない。画面に出る文字は draw の labels と担当の name だけから取る（ここに表示用の文字列を書かない）。
import { C, painter, room, desk, plant, shelf, board, easel, sofa, table, vending, rug } from './env.mjs';
import { drawChar } from './chars.mjs';
import { PACKS, lookOf, hashId } from './packs.mjs';

export const ROOM_IDS = ['ceo', 'office', 'design', 'lounge', 'library'];
export const STATUS_KINDS = ['running', 'idle', 'paused', 'error'];

// ---- 配置図（マスの単位）。横長の窓は 2 列、縦長の窓は縦に積む。大きい方の 1 マスが取れる形を選ぶ ----
const ARRANGE = {
  wide: { cols: 36, rows: 18, rooms: { ceo: [1, 1, 9, 7], lounge: [1, 9, 9, 8], office: [11, 1, 16, 9], design: [11, 11, 16, 6], library: [28, 1, 7, 16] } },
  tall: { cols: 18, rows: 38, rooms: { ceo: [1, 1, 8, 7], lounge: [10, 1, 7, 7], office: [1, 9, 16, 12], design: [1, 22, 16, 7], library: [1, 30, 16, 7] } },
};
// 机は部屋の左上からのマス。数は配置の形によらず同じ（形を変えても同じ人は同じ机）
const SECRETARY_DESK = [1, 2.4, 2];
const OFFICE_DESKS = [[5, 2.4], [8, 2.4], [11, 2.4], [5, 5.4], [8, 5.4], [11, 5.4]].map(([x, y]) => [x, y, 2]);
const DESIGN_DESKS = [[2, 2.4], [5, 2.4], [8, 2.4], [11, 2.4]].map(([x, y]) => [x, y, 2]);
const SEAT_DY = 0.55; // 机の上の端から足もとまで（机が下半身を隠す）
const seatX = d => d.x + d.w * 0.36; // 机の左寄りに座る（右の端に画面）

const inRect = (r, x, y) => x >= r.x && x < r.x + r.w && y >= r.y && y < r.y + r.h;
// 場所と回数で決まる 0〜1 の数（歩く先・待つ時間）
const rand = (id, n) => (hashId(`${id}#${n}`) % 10007) / 10007;

export function createScene({ width = 800, height = 600 } = {}) {
  let W = 0, Hh = 0, S = 16, ox = 0, oy = 0, rooms = [], seats = null, spots = [];
  const people = new Map(); // id → { agent, look, place: 'secretary'|'office'|'design'|'lounge', index }
  const walkers = new Map(); // 休憩室の人の今の位置（マス）
  let lastNow = null;

  function layout({ width: w, height: h } = {}) {
    W = Math.max(1, Number(w) || 1); Hh = Math.max(1, Number(h) || 1);
    const pick = Object.values(ARRANGE).map(a => ({ a, s: Math.min(W / a.cols, Hh / a.rows) })).sort((p, q) => q.s - p.s)[0];
    const A = pick.a; S = pick.s; ox = (W - A.cols * S) / 2; oy = (Hh - A.rows * S) / 2;
    rooms = ROOM_IDS.map(id => { const [x, y, rw, rh] = A.rooms[id]; return { id, x, y, w: rw, h: rh }; });
    const R = Object.fromEntries(rooms.map(r => [r.id, r]));
    const at = (r, [x, y, dw]) => ({ x: r.x + x, y: r.y + y, w: dw });
    seats = { secretary: [at(R.office, SECRETARY_DESK)], office: OFFICE_DESKS.map(d => at(R.office, d)), design: DESIGN_DESKS.map(d => at(R.design, d)), ceo: at(R.ceo, [R.ceo.w / 2 - 1.5, 2.4, 3]) };
    const L = R.lounge; spots = [];
    for (let y = L.y + 3.5; y <= L.y + L.h - 1; y += 2) for (let x = L.x + 1.5; x <= L.x + L.w - 1.5; x += 2.8) spots.push({ x, y }); // 名札が重ならない間隔
    walkers.clear(); lastNow = null; // 形が変わったら休憩室の人は持ち場に戻す
    return scene;
  }

  // ---- 席の割り当て（id で安定）。前の席が今も合っていればそのまま、新しい人は id の順に空いた机へ ----
  const wants = a => (a.templateKey === 'secretary' ? ['secretary', 'office'] : a.templateKey === 'design' ? ['design'] : ['office']);
  function seat(agents = []) {
    const list = [], seen = new Set();
    for (const a of Array.isArray(agents) ? agents : []) { const id = a && a.id != null ? String(a.id) : ''; if (!id || seen.has(id)) continue; seen.add(id); list.push({ ...a, id }); }
    for (const id of [...people.keys()]) if (!seen.has(id)) { people.delete(id); walkers.delete(id); }
    const cap = { secretary: 1, office: OFFICE_DESKS.length, design: DESIGN_DESKS.length };
    const used = { secretary: new Set(), office: new Set(), design: new Set(), lounge: new Set() };
    const next = new Map();
    for (const a of list) { // 前の机をそのまま使う
      const p = people.get(a.id);
      if (p && p.place !== 'lounge' && wants(a).includes(p.place) && !used[p.place].has(p.index)) { used[p.place].add(p.index); next.set(a.id, { place: p.place, index: p.index }); }
    }
    const rest = list.filter(a => !next.has(a.id)).sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
    for (const a of rest) {
      for (const place of wants(a)) { for (let i = 0; i < cap[place]; i++) if (!used[place].has(i)) { used[place].add(i); next.set(a.id, { place, index: i }); break; } if (next.has(a.id)) break; }
    }
    const lounge = rest.filter(a => !next.has(a.id)); // 机が足りない人は休憩室に立つ（前の立ち位置を優先）
    for (const a of lounge) { const p = people.get(a.id); if (p && p.place === 'lounge' && !used.lounge.has(p.index)) { used.lounge.add(p.index); next.set(a.id, { place: 'lounge', index: p.index }); } }
    let k = 0;
    for (const a of lounge) { if (next.has(a.id)) continue; while (used.lounge.has(k)) k++; used.lounge.add(k); next.set(a.id, { place: 'lounge', index: k }); }
    for (const a of list) {
      const n = next.get(a.id), prev = people.get(a.id);
      if (!prev || prev.place !== n.place || prev.index !== n.index) walkers.delete(a.id);
      people.set(a.id, { agent: a, look: prev?.look || lookOf(a.id), ...n });
    }
    return scene;
  }

  // ---- 今の位置（マス）。机の人は机の後ろ、休憩室の人は歩いている所 ----
  const homeSpot = i => { // 持ち場の数を超えた人は少しずらして立つ
    if (!spots.length) return { x: 0, y: 0 };
    const b = spots[i % spots.length], k = Math.floor(i / spots.length), L = rooms.find(r => r.id === 'lounge');
    return { x: Math.min(L.x + L.w - 0.6, b.x + 0.5 * k), y: Math.min(L.y + L.h - 0.3, b.y + 0.3 * k) };
  };
  function walkerOf(id, p) {
    let w = walkers.get(id);
    if (!w) { const h = homeSpot(p.index); w = { x: h.x, y: h.y, tx: h.x, ty: h.y, wait: 0, n: 0, face: 1, walking: false }; walkers.set(id, w); }
    return w;
  }
  function placed() {
    const out = [];
    for (const [id, p] of people) {
      if (p.place === 'lounge') { const w = walkerOf(id, p); out.push({ id, p, x: w.x, y: w.y, face: w.face, walking: w.walking, desk: null }); continue; }
      const d = seats[p.place][p.index];
      out.push({ id, p, x: seatX(d), y: d.y + SEAT_DY, face: 1, walking: false, desk: d });
    }
    return out;
  }

  // ---- 動き: 休憩室の人は空いた所へ歩いては待つ。止めても（tick を呼ばなくても）描ける ----
  function tick(now) {
    const t = Number(now) || 0, dt = lastNow == null ? 0 : Math.min(0.25, Math.max(0, (t - lastNow) / 1000)); lastNow = t;
    for (const [id, p] of people) if (p.place === 'lounge') walkerOf(id, p); // 先に全員の位置を作る（行き先の重なりを見るため）
    for (const [id, p] of people) {
      if (p.place !== 'lounge' || !spots.length) continue;
      const w = walkerOf(id, p);
      const dx = w.tx - w.x, dy = w.ty - w.y, dist = Math.hypot(dx, dy), v = 1.6 * dt; // 1 秒に 1.6 マス
      if (dist > 0.01) { w.walking = true; if (Math.abs(dx) > 0.01) w.face = dx < 0 ? -1 : 1; if (dist <= v) { w.x = w.tx; w.y = w.ty; } else { w.x += (dx / dist) * v; w.y += (dy / dist) * v; } continue; }
      w.walking = false;
      if (w.wait === 0) { w.wait = t + 2000 + rand(id, w.n++) * 4000; continue; }
      if (t < w.wait) continue;
      const taken = new Set([...walkers].filter(([o]) => o !== id).map(([, o]) => `${o.tx},${o.ty}`)); // ほかの人が居る所・向かう所へは行かない（重ならない）
      const home = homeSpot(p.index), free = spots.filter(q => !taken.has(`${q.x},${q.y}`));
      const go = rand(id, w.n++) < 0.4 || !free.length ? home : free[Math.floor(rand(id, w.n++) * free.length)];
      if (taken.has(`${go.x},${go.y}`)) { w.wait = 0; continue; } // 持ち場がふさがっていれば次の回に
      w.tx = go.x; w.ty = go.y; w.wait = 0;
    }
    return scene;
  }

  // ---- 状態の印（頭の上・色と形の両方で見分ける） ----
  const MARK = { running: '#2e9d57', idle: '#8a97a6', paused: '#e0a020', error: '#d93a3a', other: '#7b6f8f' };
  function mark(ctx, status, x, y, r) {
    const kind = STATUS_KINDS.includes(status) ? status : 'other', c = MARK[kind];
    ctx.save(); ctx.lineWidth = Math.max(1, r * 0.25); ctx.strokeStyle = '#ffffff'; ctx.fillStyle = c;
    ctx.beginPath();
    if (kind === 'running') ctx.arc(x, y, r, 0, Math.PI * 2); // 丸の中に ▶
    if (kind === 'idle') ctx.arc(x, y, r, 0, Math.PI * 2); // 輪（中は白）
    if (kind === 'paused') { ctx.moveTo(x - r, y - r); ctx.lineTo(x + r, y - r); ctx.lineTo(x + r, y + r); ctx.lineTo(x - r, y + r); ctx.closePath(); } // 四角の中に ‖
    if (kind === 'error') { ctx.moveTo(x, y - r * 1.15); ctx.lineTo(x + r * 1.15, y + r * 0.9); ctx.lineTo(x - r * 1.15, y + r * 0.9); ctx.closePath(); } // 三角の中に !
    if (kind === 'other') { ctx.moveTo(x, y - r); ctx.lineTo(x + r, y); ctx.lineTo(x, y + r); ctx.lineTo(x - r, y); ctx.closePath(); } // ひし形
    ctx.fill(); ctx.stroke();
    ctx.fillStyle = '#ffffff';
    if (kind === 'running') { ctx.beginPath(); ctx.moveTo(x - r * 0.35, y - r * 0.5); ctx.lineTo(x + r * 0.55, y); ctx.lineTo(x - r * 0.35, y + r * 0.5); ctx.closePath(); ctx.fill(); }
    if (kind === 'idle') { ctx.beginPath(); ctx.arc(x, y, r * 0.5, 0, Math.PI * 2); ctx.fill(); }
    if (kind === 'paused') { ctx.fillRect(x - r * 0.5, y - r * 0.55, r * 0.3, r * 1.1); ctx.fillRect(x + r * 0.2, y - r * 0.55, r * 0.3, r * 1.1); }
    if (kind === 'error') { ctx.fillRect(x - r * 0.12, y - r * 0.45, r * 0.24, r * 0.75); ctx.fillRect(x - r * 0.12, y + r * 0.42, r * 0.24, r * 0.22); }
    ctx.restore();
  }

  // ---- 名札（文字は labels か担当の name だけ） ----
  function tag(ctx, text, x, y, fs, bg, fg, align, maxW) {
    if (typeof text !== 'string' || !text) return;
    const pad = fs * 0.35, full = typeof ctx.measureText === 'function' ? ctx.measureText(text).width : text.length * fs * 0.6;
    const tw = Math.max(fs, Math.min(full, maxW - pad * 2)), left = align === 'left' ? x : x - tw / 2 - pad, h = fs * 1.4;
    ctx.fillStyle = bg; ctx.fillRect(left, y, tw + pad * 2, h);
    ctx.save(); ctx.beginPath(); ctx.rect(left, y, tw + pad * 2, h); ctx.clip(); // 長い名前は札の幅で切って見せる（文字列はそのまま渡す）
    ctx.fillStyle = fg; ctx.textAlign = 'left'; ctx.textBaseline = 'middle'; ctx.fillText(text, left + pad, y + fs * 0.72);
    ctx.restore();
  }

  const POSE = { running: 'work', idle: 'wait', paused: 'sleep', error: 'error' };
  function draw(ctx, { lang = 'en', now = Date.now(), labels = {} } = {}) {
    const R = painter(ctx, S, ox, oy), px = x => ox + x * S, py = y => oy + y * S;
    const roomL = labels.room || {}, statusL = labels.status || {};
    const fam = lang === 'ja' ? '"Hiragino Sans","Noto Sans JP",sans-serif' : 'system-ui,sans-serif';
    ctx.fillStyle = C.bg; ctx.fillRect(0, 0, W, Hh);
    R(C.hall, 0.5, 0.5, (W - 2 * ox) / S - 1, (Hh - 2 * oy) / S - 1); // 廊下
    for (const r of rooms) room(R, r, S);

    // 床に置く物（人より先）
    const Rm = Object.fromEntries(rooms.map(r => [r.id, r]));
    rug(R, Rm.ceo.x + 1, Rm.ceo.y + 3.6, Rm.ceo.w - 2, Rm.ceo.h - 4.4);
    rug(R, Rm.lounge.x + 1, Rm.lounge.y + 2.3, Rm.lounge.w - 2, 1.2);

    // 奥から手前へ（y の小さい順）。机は座った人の後に描く
    const items = [];
    const furn = (z, fn) => items.push({ z, fn });
    furn(Rm.ceo.y + 1.6, () => { shelf(R, Rm.ceo.x + 0.5, Rm.ceo.y + 0.3, 2); plant(R, Rm.ceo.x + Rm.ceo.w - 1.4, Rm.ceo.y + 0.9); });
    furn(Rm.office.y + 1.4, () => { shelf(R, Rm.office.x + Rm.office.w - 3.2, Rm.office.y + 0.2, 2.6); board(R, Rm.office.x + 4.5, Rm.office.y + 0.15, 2.2); plant(R, Rm.office.x + 0.3, Rm.office.y + Rm.office.h - 1.4); });
    furn(Rm.design.y + 1.6, () => { easel(R, Rm.design.x + Rm.design.w - 2, Rm.design.y + 0.6); plant(R, Rm.design.x + 0.3, Rm.design.y + Rm.design.h - 1.3); });
    furn(Rm.lounge.y + 2.2, () => { sofa(R, Rm.lounge.x + 1, Rm.lounge.y + 1.1, 3); vending(R, Rm.lounge.x + Rm.lounge.w - 1.6, Rm.lounge.y + 0.5); });
    furn(Rm.lounge.y + 3.0, () => table(R, Rm.lounge.x + 1.6, Rm.lounge.y + 2.5, 1.8));
    furn(Rm.lounge.y + Rm.lounge.h - 0.3, () => plant(R, Rm.lounge.x + Rm.lounge.w - 1.4, Rm.lounge.y + Rm.lounge.h - 1.3));

    const busy = new Set();
    const pl = placed();
    for (const a of pl) if (a.desk && a.p.agent.status === 'running') busy.add(a.desk);
    // 持ち主（社長室・名前は出さない）
    const ceoD = seats.ceo;
    const ownerH = PACKS['fine-human'].height * S;
    furn(ceoD.y + SEAT_DY, () => drawChar(ctx, { pack: PACKS['fine-human'], px: px(seatX(ceoD)), py: py(ceoD.y + SEAT_DY), H: ownerH, now, anim: 'idle', col: PACKS['fine-human'].colors[0], isBoss: true, pose: 'boss', face: 1, idx: 5, lift: 0 }));
    furn(ceoD.y + SEAT_DY + 0.05, () => desk(R, ceoD.x, ceoD.y, ceoD.w, false, 'ceo'));

    for (const kind of ['secretary', 'office', 'design']) for (const d of seats[kind]) { furn(d.y + SEAT_DY + 0.05, () => desk(R, d.x, d.y, d.w, busy.has(d), kind === 'design' ? 'design' : 'office')); }
    for (const a of pl) {
      const ag = a.p.agent, look = a.p.look, st = ag.status;
      const anim = a.walking ? 'walk' : a.desk && st === 'running' ? 'think' : 'idle';
      const pose = a.desk ? POSE[st] || 'wait' : st === 'paused' ? 'sleep' : st === 'error' ? 'error' : 'stand';
      furn(a.y, () => drawChar(ctx, { pack: look.pack, px: px(a.x), py: py(a.y), H: look.pack.height * S, now, anim, col: look.col, isBoss: false, pose, face: a.face, idx: look.idx, lift: 0 }));
    }
    items.sort((p, q) => p.z - q.z).forEach(it => it.fn());

    // 名札と印は最後（家具に隠れない）
    const fs = Math.max(7, Math.min(15, S * 0.42));
    ctx.font = `${Math.round(fs)}px ${fam}`;
    const sfs = Math.max(7, fs * 0.85);
    for (const a of pl) {
      const ag = a.p.agent, H = a.p.look.pack.height * S, x = px(a.x), y = py(a.y);
      mark(ctx, ag.status, x, y - H - S * 0.15, Math.max(4, S * 0.2));
      ctx.font = `${Math.round(fs)}px ${fam}`;
      tag(ctx, typeof ag.name === 'string' ? ag.name : '', x, y + S * 0.12, fs, '#000000aa', '#ffffff', 'center', S * 2.8);
      if (S >= 24 && typeof statusL[ag.status] === 'string') { ctx.font = `${Math.round(sfs)}px ${fam}`; tag(ctx, statusL[ag.status], x, y + S * 0.12 + fs * 1.5, sfs, MARK[ag.status] || MARK.other, '#ffffff', 'center', S * 2.8); }
    }
    // 部屋の名札は担当の印より上に描く（左上の机の人の印が名札の字を隠さない）
    ctx.font = `${Math.round(fs)}px ${fam}`;
    for (const r of rooms) tag(ctx, roomL[r.id], px(r.x) + S * 0.3, py(r.y) + S * 1.05, fs, C.labelBg, C.label, 'left', (r.w - 0.6) * S);
    return scene;
  }

  // ---- 当たり判定（px）。手前の担当から先に見て、次に部屋 ----
  function hit(x, y) {
    const pl = placed().sort((p, q) => q.y - p.y);
    for (const a of pl) {
      const H = a.p.look.pack.height * S, cx = ox + a.x * S, cy = oy + a.y * S;
      if (x >= cx - S * 0.5 && x <= cx + S * 0.5 && y >= cy - H - S * 0.45 && y <= cy + S * 0.15) return { type: 'agent', id: a.id };
    }
    const gx = (x - ox) / S, gy = (y - oy) / S;
    for (const r of rooms) if (inRect(r, gx, gy)) return { type: 'room', id: r.id };
    return null;
  }

  // ---- 親と試験のための読み出し（px） ----
  const roomsPx = () => rooms.map(r => ({ id: r.id, x: ox + r.x * S, y: oy + r.y * S, w: r.w * S, h: r.h * S }));
  const agentsPx = () => placed().map(a => ({ id: a.id, place: a.p.place, index: a.p.index, x: ox + a.x * S, y: oy + a.y * S, packId: a.p.look.packId }));

  const scene = { layout, seat, draw, hit, tick, rooms: roomsPx, agents: agentsPx, get tile() { return S; } };
  layout({ width, height });
  return scene;
}
