// オフィスの画面の部品: ボタン（Button）とリンク（Link）と見た目（OFFICE_CSS）。オフィスの a と button は全部ここを通す
// （範囲: docs/review/2026-11-18-office-ai-panel-ux-scope.md の G2・G3・F6。test/office-lint.test.mjs が生の a・button を断る）
// - ボタン: hover・押した時・キーボードの focus の見た目を持つ。onClick が Promise を返したら、押した直後から終わるまで
//   aria-busy・押せない・「処理中…」（busyText）にする。結果の文は呼ぶ側が欄の中に出す
// - リンク: 色と下線。外へ開く物は safeHref を通し、新しいタブ・noopener noreferrer・「↗」。kind 'button' はボタンの形のリンク
// 色は CSS の変数（本体の --card・--border・--foreground など）を先に使い、直書きは fallback だけ。暗い画面（本体の .dark）は別の値
import { createElement as h, useEffect, useRef, useState } from 'react';
import { safeHref } from './api.mjs';

export const OFFICE_CSS = `
.aio { --aio-fg: var(--foreground, #1f1d1a); --aio-card: var(--card, #fffdf8); --aio-line: var(--border, #d9d2c4); --aio-muted: var(--muted-foreground, #5c574f);
  --aio-accent: #1a5fb4; --aio-accent-fg: #ffffff; --aio-link: #1a5fb4; --aio-ok: #1b6e2d; --aio-err: #b3261e; --aio-warn: #8a5a00;
  --aio-hover: rgba(0, 0, 0, .06); --aio-ring: #1a5fb4; }
.dark .aio, [data-theme="dark"] .aio, .aio.aio-dark { --aio-accent: #8ab4f8; --aio-accent-fg: #0d1b2e; --aio-link: #9cc2ff; --aio-ok: #81c995; --aio-err: #f28b82; --aio-warn: #fdd663;
  --aio-hover: rgba(255, 255, 255, .08); --aio-ring: #9cc2ff; }
.aio-btn { display: inline-flex; align-items: center; justify-content: center; gap: 6px; min-height: 32px; padding: 6px 14px; border-radius: 8px;
  border: 1px solid var(--aio-line); background: var(--aio-card); color: var(--aio-fg); font: inherit; font-weight: 600; line-height: 1.3; cursor: pointer;
  text-decoration: none; transition: background-color .12s, border-color .12s, box-shadow .12s, transform .05s; }
.aio-btn:hover:not(:disabled) { background: var(--aio-hover); border-color: var(--aio-muted); }
.aio-btn:active:not(:disabled) { transform: translateY(1px); box-shadow: inset 0 2px 4px rgba(0, 0, 0, .18); }
.aio-btn:focus-visible, .aio-link:focus-visible, .aio-nav:focus-visible, .aio-select:focus-visible, .aio-textarea:focus-visible { outline: 3px solid var(--aio-ring); outline-offset: 2px; }
.aio-btn:disabled { opacity: .55; cursor: not-allowed; }
.aio-btn[aria-busy="true"] { opacity: .85; cursor: progress; }
.aio-btn-primary { background: var(--aio-accent); border-color: var(--aio-accent); color: var(--aio-accent-fg); }
.aio-btn-primary:hover:not(:disabled) { background: var(--aio-accent); border-color: var(--aio-accent); filter: brightness(1.12); }
.aio-btn-ghost { border-color: transparent; background: transparent; font-weight: 400; justify-content: flex-start; text-align: left; padding: 4px 8px; min-height: 28px; }
.aio-btn-tab[aria-pressed="true"] { background: var(--aio-hover); border-color: var(--aio-accent); box-shadow: inset 0 -3px 0 var(--aio-accent); }
.aio-btn-ghost[aria-pressed="true"] { background: var(--aio-hover); font-weight: 600; }
.aio-btn-small { min-height: 28px; padding: 3px 10px; font-size: 13px; }
.aio-btn-linkish { border: none; background: none; padding: 0; min-height: 0; color: var(--aio-link); text-decoration: underline; text-underline-offset: 2px; font-weight: 500; }
.aio-btn-linkish:hover:not(:disabled) { background: none; text-decoration-thickness: 2px; }
.aio-btn-banner { display: flex; width: 100%; justify-content: flex-start; text-align: left; margin: 0 0 6px; background: #fff3cd; border-color: #e7c66b; color: #3a2a00; font-weight: 600; }
.aio-btn-banner:hover:not(:disabled) { background: #ffe9a8; border-color: #c9a33f; }
.aio-banner { margin: 0 0 6px; padding: 7px 12px; border-radius: 8px; border: 1px solid #f0b4ae; background: #fde2e1; color: #4a1410; font-weight: 600; }
.aio-btn-alert { background: #b3261e; border-color: #8c1d18; color: #ffffff; }
.aio-btn-alert:hover:not(:disabled) { background: #8c1d18; border-color: #6e1611; }
.aio-banner-info { border-color: #a8c7fa; background: #e8f0fe; color: #0b2a5b; }
.aio-spin { width: 12px; height: 12px; border: 2px solid currentColor; border-right-color: transparent; border-radius: 50%; animation: aio-spin .7s linear infinite; flex: none; }
@keyframes aio-spin { to { transform: rotate(360deg); } }
.aio-link { color: var(--aio-link); text-decoration: underline; text-decoration-thickness: 1px; text-underline-offset: 2px; cursor: pointer; overflow-wrap: anywhere; }
.aio-link:hover { text-decoration-thickness: 2px; }
.aio-ext { margin-left: 3px; font-size: .9em; text-decoration: none; display: inline-block; }
.aio-nav { display: flex; align-items: center; gap: 8px; padding: 6px 10px; border-radius: 6px; color: inherit; text-decoration: none; font: inherit; }
.aio-nav:hover { background: rgba(127, 127, 127, .14); }
.aio-muted { color: var(--aio-muted); }
.aio-ok { color: var(--aio-ok); }
.aio-err { color: var(--aio-err); }
.aio-section-title { font-size: 15px; margin: 20px 0 4px; }
.aio-help { color: var(--aio-muted); font-size: 13px; margin: 0 0 10px; }
.aio-ai-row { border: 1px solid var(--aio-line); border-radius: 10px; padding: 12px 14px; margin: 10px 0; background: var(--aio-card); }
.aio-ai-head { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; }
.aio-ai-name { flex: 1 1 140px; font-weight: 700; }
.aio-ai-body { display: flex; flex-direction: column; gap: 8px; border-top: 1px dashed var(--aio-line); padding-top: 12px; margin-top: 12px; }
.aio-ai-body p { margin: 0; }
.aio-dot { width: 10px; height: 10px; border-radius: 50%; flex: none; background: var(--aio-muted); }
.aio-dot[data-tone="ok"] { background: var(--aio-ok); }
.aio-dot[data-tone="busy"] { background: var(--aio-accent); }
.aio-dot[data-tone="warn"] { background: var(--aio-warn); }
.aio-dot[data-tone="err"] { background: var(--aio-err); }
.aio-badge { display: inline-flex; align-items: center; gap: 6px; font-size: 12px; font-weight: 600; padding: 2px 9px; border-radius: 99px; border: 1px solid currentColor; color: var(--aio-muted); white-space: nowrap; }
.aio-badge[data-tone="ok"] { color: var(--aio-ok); }
.aio-badge[data-tone="busy"] { color: var(--aio-link); }
.aio-badge[data-tone="warn"] { color: var(--aio-warn); }
.aio-badge[data-tone="err"] { color: var(--aio-err); }
.aio-code { font: 700 24px/1.3 ui-monospace, Menlo, monospace; letter-spacing: 3px; padding: 6px 12px; border: 1px dashed var(--aio-line); border-radius: 8px; user-select: all; }
.aio-code-line { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; }
.aio-textarea { width: 100%; box-sizing: border-box; font: 14px/1.5 ui-monospace, Menlo, monospace; padding: 10px 12px; border: 1px solid var(--aio-line); border-radius: 8px;
  background: transparent; color: inherit; resize: vertical; word-break: break-all; }
.aio-label { font-weight: 600; font-size: 14px; }
.aio-actions { display: flex; gap: 8px; justify-content: flex-end; flex-wrap: wrap; }
.aio-assign-row { display: grid; grid-template-columns: 1fr auto; gap: 4px 12px; align-items: center; padding: 10px 0; border-bottom: 1px solid var(--aio-line); }
.aio-assign-row > p { grid-column: 1 / -1; margin: 0; font-size: 13px; }
.aio-select { font: inherit; padding: 6px 10px; border-radius: 8px; border: 1px solid var(--aio-line); background: var(--aio-card); color: var(--aio-fg); max-width: 200px; }
.aio-result { margin: 10px 0 0; padding: 8px 12px; border-radius: 8px; border: 1px solid currentColor; font-size: 14px; font-weight: 600; }
.aio-result[data-tone="ok"] { color: var(--aio-ok); }
.aio-result[data-tone="err"] { color: var(--aio-err); }
`;

const KIND = { primary: 'aio-btn aio-btn-primary', secondary: 'aio-btn', ghost: 'aio-btn aio-btn-ghost', tab: 'aio-btn aio-btn-tab', linkish: 'aio-btn aio-btn-linkish', banner: 'aio-btn aio-btn-banner', alert: 'aio-btn aio-btn-banner aio-btn-alert' };
const cx = (...a) => a.filter(Boolean).join(' ');

// ボタン。onClick が Promise を返したら、終わるまで処理中（aria-busy・押せない・busyText）。busy を渡すと外から処理中にできる（送信のボタンなど）
export function Button({ kind = 'secondary', small = false, onClick, disabled = false, busy = false, busyText, pressed, className, type = 'button', children, ...rest }) {
  const [own, setOwn] = useState(false);
  const alive = useRef(true);
  useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);
  const working = !!busy || own;
  const click = e => {
    if (working || disabled || !onClick) return undefined;
    const r = onClick(e);
    if (r && typeof r.then === 'function') {
      setOwn(true);
      return Promise.resolve(r).catch(() => {}).finally(() => { if (alive.current) setOwn(false); }); // 失敗の文は呼ぶ側が欄に出す
    }
    return undefined;
  };
  const kids = working ? [h('span', { key: 'spin', className: 'aio-spin', 'aria-hidden': 'true' }), busyText ?? children] : [children];
  return h('button', {
    ...rest, type, className: cx(KIND[kind] || KIND.secondary, small ? 'aio-btn-small' : null, className), onClick: click, disabled: disabled || working,
    'aria-busy': working ? 'true' : undefined, 'aria-pressed': pressed === undefined ? undefined : (pressed ? 'true' : 'false'),
  }, ...kids);
}

// 中のリンク: / から始まり、ブラウザが同じ origin に解く path だけ（//x・/\x のように別の host に解く物は断る・独立レビュー r2 の 3）
export function sameOriginPath(raw, origin = globalThis.location?.origin || 'http://localhost') {
  const s = String(raw ?? '');
  if (!s.startsWith('/') || /[\u0000-\u001f\u007f]/.test(s)) return null;
  try { return new URL(s, origin).origin === origin ? s : null; } catch { return null; }
}

// リンク。external は http(s) だけ（safeHref）で新しいタブ・「↗」。中のリンクは / から始まる path だけ（// は外なので断る）。使えない href は文字だけ出す
export function Link({ href, external = false, kind = 'link', className, children, ...rest }) {
  const raw = String(href ?? '');
  const safe = external ? safeHref(raw) : sameOriginPath(raw);
  if (!safe) return h('span', { className }, children);
  const cls = kind === 'button' ? 'aio-btn aio-btn-primary' : kind === 'nav' ? 'aio-nav' : 'aio-link';
  return h('a', { ...rest, href: safe, className: cx(cls, className), ...(external ? { target: '_blank', rel: 'noopener noreferrer' } : {}) },
    children, external ? h('span', { className: 'aio-ext', 'aria-hidden': 'true' }, '↗') : null);
}

// 状態の印（色の点と badge）。tone は ok・busy・warn・err・muted
export function Status({ tone = 'muted', text, ...rest }) {
  return h('span', { ...rest, className: 'aio-badge', 'data-tone': tone },
    tone === 'busy' ? h('span', { className: 'aio-spin', 'aria-hidden': 'true' }) : h('span', { className: 'aio-dot', 'data-tone': tone, 'aria-hidden': 'true' }), text);
}
