// office の画面の絵（plugins/office/src/scene）: 描く・席・当たり判定・配置の大きさ
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createScene, ROOM_IDS } from '../plugins/office/src/scene/index.mjs';

const sceneDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../plugins/office/src/scene');

// 呼ばれた命令を記録するだけの 2D context（本物の CanvasRenderingContext2D に無い命令を呼んだら投げる）
const METHODS = ['fillRect', 'strokeRect', 'clearRect', 'fillText', 'strokeText', 'beginPath', 'closePath', 'moveTo', 'lineTo', 'arc', 'ellipse', 'rect',
  'fill', 'stroke', 'save', 'restore', 'translate', 'scale', 'rotate', 'setTransform', 'drawImage', 'clip', 'quadraticCurveTo', 'bezierCurveTo'];
function fakeCtx() {
  const calls = [], props = {};
  const ctx = new Proxy({}, {
    get(_, k) {
      if (k === 'calls') return calls;
      if (k === 'measureText') return s => ({ width: String(s).length * 7 });
      if (METHODS.includes(k)) return (...a) => { calls.push([k, a]); };
      if (k in props) return props[k];
      if (typeof k === 'string' && /^[a-z]/.test(k)) throw new Error(`2D context に無い物を読んだ: ${k}`);
      return undefined;
    },
    set(_, k, v) { props[k] = v; return true; },
  });
  return ctx;
}

const LABELS = {
  room: { ceo: 'L-room-ceo', office: 'L-room-office', design: 'L-room-design', lounge: 'L-room-lounge', library: 'L-room-library' },
  status: { running: 'L-st-running', idle: 'L-st-idle', paused: 'L-st-paused', error: 'L-st-error' },
};
const AGENTS = [
  { id: 'a-sec', name: 'Sec Name', role: 'general', status: 'running', templateKey: 'secretary' },
  { id: 'a-des', name: 'Design Name', role: 'designer', status: 'idle', templateKey: 'design' },
  ...Array.from({ length: 5 }, (_, i) => ({ id: `a-w${i}`, name: `Worker ${i}`, role: 'general', status: ['running', 'idle', 'paused', 'error', 'unknown-x'][i], templateKey: 'general' })),
];

test('draw: 投げずに描き、fillText の文字は labels と担当の名前だけ', () => {
  for (const [w, h] of [[360, 300], [1600, 900], [500, 1000]]) {
    for (const lang of ['en', 'ja']) {
      const s = createScene({ width: w, height: h }).seat(AGENTS);
      const ctx = fakeCtx();
      s.tick(0); s.tick(16); s.draw(ctx, { lang, now: 1000, labels: LABELS });
      const texts = ctx.calls.filter(c => c[0] === 'fillText').map(c => c[1][0]);
      const allowed = new Set([...Object.values(LABELS.room), ...Object.values(LABELS.status), ...AGENTS.map(a => a.name)]);
      assert.ok(texts.length >= 4 + AGENTS.length, `${w}x${h}: 部屋の名札と担当の名前が描かれる (${texts.length})`);
      assert.deepEqual(texts.filter(t => !allowed.has(t)), [], `${w}x${h}: labels と名前の外の文字が無い`);
      for (const id of ROOM_IDS) assert.ok(texts.includes(LABELS.room[id]), `部屋 ${id} の名札`);
      for (const a of AGENTS) assert.ok(texts.includes(a.name), `担当 ${a.name} の名前`);
      assert.ok(ctx.calls.filter(c => c[0] === 'fillRect').length > 500, '絵が描かれる');
    }
  }
});

test('draw: labels が無くても投げず、文字を描かない（直書きの文字が無い）', () => {
  const s = createScene({ width: 800, height: 600 }).seat(AGENTS.map(a => ({ ...a, name: undefined })));
  const ctx = fakeCtx();
  s.draw(ctx, { now: 0 });
  assert.deepEqual(ctx.calls.filter(c => c[0] === 'fillText'), []);
});

test('draw: 状態ごとに印の形が違う（色だけに頼らない）', () => {
  const shapeOf = status => {
    // 名前も labels も無い担当 1 人: 印は最後に描かれる物（最後の save から後）
    const s = createScene({ width: 1600, height: 900 }).seat([{ id: 'x', status, templateKey: 'general' }]);
    const ctx = fakeCtx(); s.draw(ctx, { now: 0, labels: {} });
    const last = ctx.calls.map(c => c[0]).lastIndexOf('save'), seg = ctx.calls.slice(last);
    return ['arc', 'lineTo', 'fillRect', 'moveTo'].map(k => seg.filter(c => c[0] === k).length).join(',');
  };
  const shapes = ['running', 'idle', 'paused', 'error', 'other'].map(shapeOf);
  assert.equal(new Set(shapes).size, shapes.length, `形がすべて違う: ${shapes.join(' / ')}`);
});

test('seat: 秘書は秘書の机・デザインはデザイン部・ほかは執務室・足りなければ休憩室', () => {
  const s = createScene({ width: 1600, height: 900 }).seat(AGENTS);
  const by = Object.fromEntries(s.agents().map(a => [a.id, a]));
  assert.equal(by['a-sec'].place, 'secretary');
  assert.equal(by['a-des'].place, 'design');
  for (let i = 0; i < 5; i++) assert.equal(by[`a-w${i}`].place, 'office');
  // 執務室の机は 6。8 人の担当なら 2 人は休憩室。デザインの担当 5 人なら 1 人は休憩室
  const many = [...Array.from({ length: 8 }, (_, i) => ({ id: `g${i}`, name: `G${i}`, status: 'idle', templateKey: 'general' })),
    ...Array.from({ length: 5 }, (_, i) => ({ id: `d${i}`, name: `D${i}`, status: 'idle', templateKey: 'design' }))];
  const s2 = createScene({ width: 1600, height: 900 }).seat(many), places = s2.agents().map(a => a.place);
  assert.equal(places.filter(p => p === 'office').length, 6);
  assert.equal(places.filter(p => p === 'design').length, 4);
  assert.equal(places.filter(p => p === 'lounge').length, 3);
  const lounge = s2.rooms().find(r => r.id === 'lounge');
  for (const a of s2.agents().filter(a => a.place === 'lounge')) assert.ok(a.x >= lounge.x && a.x < lounge.x + lounge.w && a.y >= lounge.y && a.y < lounge.y + lounge.h, '休憩室の中に立つ');
  // 秘書が 2 人なら、2 人目は執務室の机
  const s3 = createScene({ width: 1600, height: 900 }).seat([{ id: 's1', templateKey: 'secretary' }, { id: 's2', templateKey: 'secretary' }]);
  assert.deepEqual(s3.agents().map(a => a.place).sort(), ['office', 'secretary']);
});

test('seat: 並びを変えても同じ人は同じ席（新しい scene でも、同じ scene で呼び直しても）', () => {
  const key = s => Object.fromEntries(s.agents().map(a => [a.id, `${a.place}:${a.index}`]));
  const a = key(createScene({ width: 1200, height: 800 }).seat(AGENTS));
  const b = key(createScene({ width: 1200, height: 800 }).seat([...AGENTS].reverse()));
  assert.deepEqual(a, b);
  const s = createScene({ width: 1200, height: 800 }).seat(AGENTS);
  const before = key(s);
  s.seat([{ id: 'a-0new', name: 'New', templateKey: 'general' }, ...[...AGENTS].reverse()]); // id の順で前に来る人が増えても
  const after = key(s);
  for (const id of Object.keys(before)) assert.equal(after[id], before[id], `${id} は同じ席`);
  // 配置の形が変わっても同じ席
  s.layout({ width: 400, height: 900 });
  assert.deepEqual(key(s), after);
  // 居なくなった人は消える
  s.seat(AGENTS.slice(0, 2));
  assert.deepEqual(Object.keys(key(s)).sort(), ['a-des', 'a-sec']);
});

test('hit: 部屋の中で room の id、担当の位置で agent の id、外で null', () => {
  for (const [w, h] of [[360, 300], [1600, 900], [500, 1000]]) {
    const s = createScene({ width: w, height: h }).seat(AGENTS);
    for (const r of s.rooms()) {
      // 部屋の右下の隅の近く（担当の居ない所）
      assert.deepEqual(s.hit(r.x + r.w - 2, r.y + r.h - 2), { type: 'room', id: r.id }, `${w}x${h} ${r.id}`);
    }
    for (const a of s.agents()) assert.deepEqual(s.hit(a.x, a.y - s.tile * 0.5), { type: 'agent', id: a.id }, `${w}x${h} ${a.id}`);
    assert.equal(s.hit(-5, -5), null);
    assert.equal(s.hit(w + 10, h + 10), null);
    const [r0] = s.rooms();
    assert.equal(s.hit(r0.x - 1, r0.y - 1), null, '部屋の外の廊下');
  }
});

test('layout: 小さい窓と大きい窓で、部屋が窓に収まり重ならない', () => {
  for (const [w, h] of [[360, 300], [1600, 900], [320, 700], [2560, 1440]]) {
    const s = createScene({ width: 100, height: 100 }).layout({ width: w, height: h });
    const rs = s.rooms();
    assert.deepEqual(rs.map(r => r.id).sort(), [...ROOM_IDS].sort());
    for (const r of rs) assert.ok(r.x >= 0 && r.y >= 0 && r.x + r.w <= w + 1e-6 && r.y + r.h <= h + 1e-6, `${w}x${h} ${r.id} が窓の中`);
    for (let i = 0; i < rs.length; i++) for (let j = i + 1; j < rs.length; j++) {
      const a = rs[i], b = rs[j], overlap = a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;
      assert.ok(!overlap, `${w}x${h} ${a.id} と ${b.id} が重ならない`);
    }
  }
});

test('tick: 休憩室の人が歩き、休憩室の外に出ない', () => {
  const many = Array.from({ length: 9 }, (_, i) => ({ id: `g${i}`, name: `G${i}`, status: 'idle', templateKey: 'general' }));
  const s = createScene({ width: 1600, height: 900 }).seat(many);
  const lounge = s.rooms().find(r => r.id === 'lounge');
  const start = s.agents().filter(a => a.place === 'lounge').map(a => [a.x, a.y].join());
  let moved = false;
  for (let t = 0; t <= 30000; t += 50) {
    s.tick(t);
    const now = s.agents().filter(a => a.place === 'lounge');
    for (const a of now) assert.ok(a.x >= lounge.x && a.x <= lounge.x + lounge.w && a.y >= lounge.y && a.y <= lounge.y + lounge.h);
    if (now.map(a => [a.x, a.y].join()).join('|') !== start.join('|')) moved = true;
  }
  assert.ok(moved, '30 秒のうちに誰かが歩く');
});

test('見た目: pack は 7 つのコードの絵だけ・id で安定・柴犬が無い', () => {
  const ids = Array.from({ length: 200 }, (_, i) => ({ id: `agent-${i}` }));
  const s1 = createScene({ width: 1600, height: 900 }).seat(ids), s2 = createScene({ width: 800, height: 600 }).seat([...ids].reverse());
  const p1 = Object.fromEntries(s1.agents().map(a => [a.id, a.packId])), p2 = Object.fromEntries(s2.agents().map(a => [a.id, a.packId]));
  assert.deepEqual(p1, p2);
  assert.deepEqual([...new Set(Object.values(p1))].sort(), ['cat', 'fine-bear', 'fine-cat', 'fine-human', 'fine-penguin', 'fine-rabbit', 'robot']);
  for (const f of readdirSync(sceneDir)) {
    const t = readFileSync(path.join(sceneDir, f), 'utf8');
    assert.ok(!/shiba|document\.|window\./.test(t), `${f}: 柴犬・DOM を使わない`);
  }
});
