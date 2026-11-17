// 試験だけで使う小さな React の代わり（office の plugin の欄を node で描いて押すため。本物の React は本体が渡すので repo に入れない）。
// 使える物: createElement・useState・useRef・useMemo・useCallback・useEffect と、描いた木を調べる道具。
// 限界: 描き直しは毎回根から全部。部品の state は「親からの道（key か位置）」で持つ。context・portal・ref の DOM は無い
const same = (a, b) => Array.isArray(a) && Array.isArray(b) && a.length === b.length && a.every((v, i) => Object.is(v, b[i]));

export function createElement(type, props, ...children) {
  const p = { ...(props || {}) };
  const key = p.key ?? null; delete p.key;
  p.children = children.flat(Infinity);
  return { type, props: p, key };
}
export const Fragment = 'mini-fragment';

let cur = null;
const slot = init => { const i = cur.hi++; if (!(i in cur.hooks)) cur.hooks[i] = init(); return cur.hooks[i]; };
export function useState(init) {
  const inst = cur, s = slot(() => ({ v: typeof init === 'function' ? init() : init }));
  return [s.v, upd => { const nv = typeof upd === 'function' ? upd(s.v) : upd; if (Object.is(nv, s.v)) return; s.v = nv; if (inst.alive) inst.root.schedule(); }];
}
export const useRef = v => slot(() => ({ current: v }));
export function useMemo(fn, deps) { const s = slot(() => ({ deps: null, v: undefined, first: true })); if (s.first || !same(s.deps, deps)) { s.v = fn(); s.deps = deps; s.first = false; } return s.v; }
export const useCallback = (fn, deps) => useMemo(() => fn, deps);
export function useEffect(fn, deps) {
  const inst = cur, s = slot(() => ({ deps: null, cleanup: null, first: true }));
  if (s.first || !deps || !same(s.deps, deps)) {
    s.deps = deps; s.first = false;
    inst.pending.push(() => { if (s.cleanup) s.cleanup(); const c = fn(); s.cleanup = typeof c === 'function' ? c : null; });
  }
}
export default { createElement, useState, useRef, useMemo, useCallback, useEffect, Fragment };

// 描く。返り値の tree は { type, props, children } と文字の木。update(el) で別の要素に描き直す（null で全部外す）
export function render(element) {
  const insts = new Map();
  let el = element;
  const root = {
    tree: null, scheduled: false,
    schedule() { if (root.scheduled) return; root.scheduled = true; queueMicrotask(() => { root.scheduled = false; flush(); }); },
    update(next) { el = next; flush(); },
  };
  function flush() {
    const seen = new Set(), effects = [];
    const walk = (node, path) => {
      if (node == null || typeof node === 'boolean') return [];
      if (typeof node === 'string' || typeof node === 'number') return [String(node)];
      if (Array.isArray(node)) return node.flatMap((n, i) => walk(n, `${path}[${n?.key ?? i}]`));
      if (typeof node.type === 'function') {
        const key = `${path}:${node.type.name || 'anon'}`;
        let inst = insts.get(key);
        if (!inst) { inst = { hooks: [], root, alive: true }; insts.set(key, inst); }
        inst.hi = 0; inst.pending = [];
        seen.add(key);
        const prev = cur; cur = inst;
        let out; try { out = node.type(node.props); } finally { cur = prev; }
        effects.push(...inst.pending);
        return walk(out, `${key}>`);
      }
      if (node.type === Fragment) return walk(node.props.children, `${path}/f`);
      const { children, ...props } = node.props;
      const kids = (children || []).flatMap((c, i) => walk(c, `${path}/${node.type}.${c?.key ?? i}`));
      return [{ type: node.type, props, children: kids }];
    };
    const out = walk(el, 'r');
    for (const [key, inst] of insts) {
      if (seen.has(key)) continue;
      inst.alive = false; insts.delete(key);
      for (const s of inst.hooks) if (s && typeof s.cleanup === 'function') s.cleanup();
    }
    root.tree = out.length === 0 ? null : out.length === 1 ? out[0] : { type: '#root', props: {}, children: out };
    for (const e of effects) e();
  }
  flush();
  return root;
}

// 木を調べる道具
export const findAll = (node, pred, out = []) => { if (node && typeof node === 'object') { if (pred(node)) out.push(node); for (const c of node.children) findAll(c, pred, out); } return out; };
export const find = (node, pred) => findAll(node, pred)[0] || null;
export const byAttr = (node, name, value) => find(node, n => (value === undefined ? n.props[name] !== undefined : String(n.props[name]) === String(value)));
export const text = node => (typeof node === 'string' ? node : node ? node.children.map(text).join('') : '');
export const settle = async (n = 5) => { for (let i = 0; i < n; i += 1) await new Promise(r => setTimeout(r, 0)); };
