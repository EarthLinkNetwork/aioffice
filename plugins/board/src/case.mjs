// タスクのページ（タスクボードの札を押した先・/:会社の prefix/board?case=<課題の id>）。
// 形は会話の画面の標準（docs/design/2026-11-25-chat-screen-standard.md・番号は表の番号）とモック docs/mocks/case-subtasks.html:
// 上（戻る・題・決めてほしい事・タブ）と下（入力欄）を固定し、真ん中だけがスクロールする。タブは 会話 / サブタスク / 概要。
// 会話は課題のコメント（開いている人の名義で書く）。担当の書いた文は HTML として解釈せず、Markdown は React の要素で組み立てる（3-3）
import { createElement as h, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { DICT } from '../../office/src/i18n.mjs';
import { Button, Link } from '../../office/src/controls.mjs';
import { columnOf, findRejectLabel, safeColor } from './board-lib.mjs';
import {
  SECTIONS, headingTable, pickCase, chatItems, checkSay, hideJson, goPatch, goDone,
  FIRST_MESSAGES, startIndex, subtaskTree, enterSends, attachSplit, withAttachNote, splitIdeas,
  checkResult, childDonePatch, parentNote, mdBlocks, mdInline, hhmm, dayKey, dayLabel, firstUnread, fitHeight,
} from './case-lib.mjs';

const REFRESH_MS = 15000;
const TABLE = headingTable(DICT);
const REJECT_NAMES = [DICT.en.board_label_returned, DICT.ja.board_label_returned];
const TAG_COLOR = '#5c574f';
const NARROW = '(max-width: 640px)';
const TOUCH = '(pointer: coarse)';
const NEAR_PX = { mobile: 80, pc: 120 }; // 2-2
const LINES = { mobile: 6, pc: 12 };      // 3-2
const LINE_EM = 1.65;
const COPIED_MS = 1500;                   // 4-1
const NOTE_MS = 4000;
const READ_KEY = 'aioffice.case.read'; // 2-1: 既読の時刻は端末にだけ持つ（標準 §7）。1 つの鍵に {課題の id: 時刻} の表で持つ
const READ_MAX = 500;                  // 表は新しい順に 500 個まで（開いた課題の数だけ増え続けない）

export const CASE_CSS = `
.aioc { display: flex; flex-direction: column; min-height: 320px; max-width: 820px; position: relative; border: 1px solid var(--aio-line); border-radius: 12px; overflow: hidden; }
.aioc-head { flex: 0 0 auto; padding: 10px 14px 0; background: var(--aio-card); border-bottom: 1px solid var(--aio-line); }
.aioc-mid { flex: 1 1 auto; min-height: 0; overflow-y: auto; padding: 12px 14px 16px; overscroll-behavior: contain; overflow-anchor: none; }
.aioc-foot { flex: 0 0 auto; padding: 8px 12px calc(8px + env(safe-area-inset-bottom)); background: var(--aio-card); border-top: 1px solid var(--aio-line); }
.aioc h1 { font-size: 17px; line-height: 1.4; margin: 0; overflow-wrap: anywhere; flex: 1; min-width: 0; }
.aioc-top { display: flex; justify-content: space-between; gap: 10px; align-items: flex-start; margin: 8px 0 4px; }
.aioc-st { font-size: 12px; padding: 2px 10px; border-radius: 99px; border: 1px solid var(--aio-line); white-space: nowrap; }
.aioc-back { display: flex; align-items: center; gap: 8px; width: 100%; min-height: 44px; border: 0; border-radius: 12px; padding: 10px 14px; background: var(--aio-accent); color: var(--aio-accent-fg); font: inherit; font-weight: 600; text-align: left; text-decoration: none; cursor: pointer; box-shadow: 0 1px 2px rgba(0,0,0,.15); box-sizing: border-box; }
.aioc-back span { white-space: nowrap; flex: 0 0 auto; }
.aioc-back b { font-weight: 400; opacity: .9; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; min-width: 0; }
.aioc-back-low { margin-top: 22px; }
.aioc-ask1 { margin: 6px 0 0; padding: 7px 12px; border-radius: 10px; background: color-mix(in srgb, var(--aio-warn) 14%, transparent); font-size: 13.5px; overflow-wrap: anywhere; }
.aioc-ask1 b { color: var(--aio-warn); margin-right: 6px; }
.aioc-ask1 button { border: 0; background: none; padding: 0; min-height: 44px; color: var(--aio-link, var(--aio-accent)); font: inherit; cursor: pointer; white-space: nowrap; }
.aioc-tabs { display: flex; gap: 2px; margin: 8px -4px 0; padding: 4px; }
.aioc-tabs button { flex: 1; min-height: 44px; border: 0; border-radius: 8px; background: transparent; color: var(--aio-muted); font: inherit; font-size: 14px; white-space: nowrap; cursor: pointer; }
.aioc-tabs button[aria-selected="true"] { background: var(--aio-hover); color: var(--aio-fg); font-weight: 600; }
.aioc-n { font-size: 11.5px; border: 1px solid var(--aio-line); border-radius: 99px; padding: 0 6px; margin-left: 4px; }
.aioc-box { background: var(--aio-card); border: 1px solid var(--aio-line); border-radius: 12px; padding: 4px 16px; margin: 0 0 14px; }
.aioc-row { display: grid; grid-template-columns: 8em 1fr; gap: 12px; padding: 10px 0; border-top: 1px solid var(--aio-line); }
.aioc-row:first-child { border-top: 0; }
.aioc-k { color: var(--aio-muted); font-size: 12.5px; padding-top: 2px; }
.aioc-v { white-space: pre-wrap; overflow-wrap: anywhere; }
.aioc-row-ask .aioc-v, .aioc-row-rec .aioc-v { font-weight: 600; }
.aioc-meta { display: flex; gap: 10px; flex-wrap: wrap; align-items: center; margin: 0 0 12px; }
.aioc-meta .aio-link { display: inline-flex; align-items: center; min-height: 44px; } /* 5-7 */
.aioc-acts { display: flex; gap: 8px; flex-wrap: wrap; margin: 4px 0 12px; }
.aioc-older { display: block; min-height: 44px; margin: 0 auto 10px; border: 1px solid var(--aio-line); background: var(--aio-card); color: var(--aio-link, var(--aio-accent)); border-radius: 99px; padding: 6px 16px; font: inherit; font-size: 13px; cursor: pointer; }
.aioc-day { text-align: center; margin: 12px 0 6px; }
.aioc-day span { font-size: 11.5px; color: var(--aio-muted); border: 1px solid var(--aio-line); border-radius: 99px; padding: 1px 10px; }
.aioc-unread { display: flex; align-items: center; gap: 8px; margin: 12px 0 4px; color: var(--aio-err); font-size: 12px; font-weight: 600; }
.aioc-unread::before, .aioc-unread::after { content: ""; flex: 1; border-top: 1px solid var(--aio-err); }
.aioc-msg { margin: 8px 0; width: fit-content; max-width: 88%; }
.aioc-msg-me { margin-left: auto; }
.aioc-who { display: block; font-size: 11.5px; color: var(--aio-muted); margin: 0 4px 2px; }
.aioc-bub { position: relative; background: var(--aio-card); border: 1px solid var(--aio-line); border-radius: 14px; padding: 8px 12px; overflow-wrap: anywhere; line-height: ${LINE_EM}; }
.aioc-msg-me .aioc-bub { background: var(--aio-accent); color: var(--aio-accent-fg); border-color: var(--aio-accent); }
.aioc-bub > :first-child { margin-top: 0; } .aioc-bub > :last-child { margin-bottom: 0; }
.aioc-bub p { margin: 0 0 6px; white-space: pre-wrap; }
.aioc-bub h4 { font-size: 14px; margin: 8px 0 4px; }
.aioc-bub ul, .aioc-bub ol { margin: 0 0 6px; padding-left: 1.4em; }
.aioc-bub blockquote { margin: 0 0 6px; padding-left: 10px; border-left: 3px solid var(--aio-line); white-space: pre-wrap; }
.aioc-bub pre { margin: 0 0 6px; padding: 8px; border-radius: 8px; background: var(--aio-hover); white-space: pre-wrap; overflow-wrap: anywhere; font-size: 13px; }
.aioc-bub code { font-size: .92em; background: var(--aio-hover); border-radius: 4px; padding: 0 3px; }
.aioc-msg-me .aioc-bub code, .aioc-msg-me .aioc-bub pre { background: rgba(255,255,255,.18); }
.aioc-tbl { display: grid; gap: 0; margin: 0 0 6px; border: 1px solid var(--aio-line); border-radius: 8px; font-size: 13px; }
.aioc-tbl div { padding: 4px 8px; border-top: 1px solid var(--aio-line); overflow-wrap: anywhere; }
.aioc-tbl .aioc-th { font-weight: 600; border-top: 0; }
.aioc-time { font-size: 11px; color: var(--aio-muted); margin: 0 4px; white-space: nowrap; }
.aioc-cut { overflow: hidden; }
.aioc-long::after { content: ""; position: absolute; left: 0; right: 0; bottom: 0; height: 2.4em; background: linear-gradient(transparent, var(--aio-card)); }
.aioc-msg-me .aioc-long::after { background: linear-gradient(transparent, var(--aio-accent)); }
.aioc-ops { display: flex; gap: 4px; align-items: center; margin: 2px 0 0; }
.aioc-msg-me .aioc-ops { justify-content: flex-end; }
.aioc-ops button, .aioc-chips button { position: relative; border: 0; background: none; color: var(--aio-muted); font: inherit; font-size: 12px; padding: 4px 8px; min-height: 28px; min-width: 28px; border-radius: 6px; cursor: pointer; }
.aioc-ops button::before { content: ""; position: absolute; inset: -8px -2px; } /* 5-7: 押せる範囲は 44px */
.aioc-chips button::before { content: ""; position: absolute; inset: -8px; }
.aioc-ops button:hover { background: var(--aio-hover); }
.aioc-ops .aioc-xp { color: var(--aio-link, var(--aio-accent)); font-weight: 600; }
@media (hover: hover) and (pointer: fine) { .aioc-ops .aioc-cp { opacity: 0; } .aioc-msg:hover .aioc-cp, .aioc-cp:focus-visible { opacity: 1; } } /* 4-1: マウスの時だけ乗せた時に出す */
.aioc-split { border: 1px dashed var(--aio-accent); border-radius: 12px; padding: 10px 12px; margin: 8px 0; max-width: 88%; }
.aioc-split-i { display: flex; gap: 8px; align-items: center; padding: 5px 0; flex-wrap: wrap; }
.aioc-split-i span { flex: 1; min-width: 10em; overflow-wrap: anywhere; }
.aioc-jump { position: absolute; right: 16px; z-index: 3; min-height: 44px; border: 0; border-radius: 99px; padding: 8px 16px; background: var(--aio-fg); color: var(--aio-card); font: inherit; font-size: 13px; cursor: pointer; box-shadow: 0 2px 8px rgba(0,0,0,.25); }
.aioc-subs { background: var(--aio-card); border: 1px solid var(--aio-line); border-radius: 12px; overflow: hidden; }
.aioc-s { display: flex; gap: 10px; align-items: center; flex-wrap: wrap; min-height: 44px; padding: 10px 14px; border-top: 1px solid var(--aio-line); color: inherit; text-decoration: none; box-sizing: border-box; }
.aioc-s:first-child { border-top: 0; }
.aioc-s:hover { background: var(--aio-hover); }
.aioc-s .aioc-st-t { flex: 1 1 14em; min-width: 0; overflow-wrap: anywhere; font-weight: 600; }
.aioc-s-done .aioc-st-t { text-decoration: line-through; color: var(--aio-muted); font-weight: 400; }
.aioc-s small { color: var(--aio-muted); font-size: 12px; white-space: nowrap; }
.aioc-below { color: var(--aio-link, var(--aio-accent)); font-size: 12px; white-space: nowrap; }
.aioc-prog { height: 6px; border-radius: 99px; background: var(--aio-hover); overflow: hidden; margin: 2px 0 10px; }
.aioc-prog i { display: block; height: 100%; background: var(--aio-ok); }
.aioc-add { display: flex; gap: 8px; flex-wrap: wrap; padding: 10px 14px; border-top: 1px solid var(--aio-line); }
.aioc-add input, .aioc-add select, .aioc-res input { flex: 1 1 10em; min-width: 0; min-height: 44px; padding: 8px 10px; border: 1px solid var(--aio-line); border-radius: 10px; background: var(--aio-card); color: var(--aio-fg); font: inherit; box-sizing: border-box; }
.aioc-add select { flex: 0 0 9em; }
.aioc-res { display: flex; gap: 8px; flex-wrap: wrap; margin-top: 10px; }
.aioc-chips { display: flex; gap: 6px; flex-wrap: wrap; margin-bottom: 6px; }
.aioc-chips span { display: inline-flex; align-items: center; gap: 2px; font-size: 12px; border: 1px solid var(--aio-line); border-radius: 8px; padding: 2px 2px 2px 8px; max-width: 100%; }
.aioc-chips em { font-style: normal; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; min-width: 0; }
.aioc-comp { display: flex; gap: 8px; align-items: flex-end; }
.aioc-comp textarea { flex: 1; min-width: 0; resize: none; min-height: 44px; max-height: 200px; overflow-y: auto; padding: 10px 12px; border: 1px solid var(--aio-line); border-radius: 12px; background: var(--aio-card); color: var(--aio-fg); font: inherit; line-height: 1.5; box-sizing: border-box; }
.aioc-mobile .aioc-comp textarea { max-height: 120px; }
.aioc .aio-btn { min-height: 44px; } /* 5-7: タスクのページの中のボタンは小さい物も 44px */
.aioc-ic { flex: 0 0 44px; width: 44px; height: 44px; border: 1px solid var(--aio-line); border-radius: 12px; background: var(--aio-card); color: var(--aio-fg); font-size: 20px; cursor: pointer; }
.aioc-stop { flex: 0 0 auto; min-height: 44px; border: 1px solid var(--aio-err); border-radius: 10px; background: var(--aio-card); color: var(--aio-err); padding: 0 14px; font: inherit; font-weight: 600; cursor: pointer; }
.aioc-hint { font-size: 11.5px; color: var(--aio-muted); margin-top: 4px; }
.aioc-menu { position: absolute; left: 12px; z-index: 4; min-width: 12em; padding: 4px; background: var(--aio-card); border: 1px solid var(--aio-line); border-radius: 12px; box-shadow: 0 6px 20px rgba(0,0,0,.18); }
.aioc-menu button { display: block; width: 100%; min-height: 44px; text-align: left; border: 0; background: none; padding: 10px 12px; border-radius: 8px; color: var(--aio-fg); font: inherit; cursor: pointer; }
.aioc-menu button:hover { background: var(--aio-hover); }
.aioc-dropzone { position: absolute; inset: 0; z-index: 5; display: flex; align-items: center; justify-content: center; border: 3px dashed var(--aio-accent); border-radius: 12px; background: color-mix(in srgb, var(--aio-card) 85%, transparent); color: var(--aio-accent); font-weight: 600; pointer-events: none; }
.aioc-note { margin-top: 18px; color: var(--aio-muted); font-size: 12.5px; }
@media (max-width: 640px) { .aioc-row { grid-template-columns: 1fr; gap: 2px; } .aioc h1 { font-size: 16px; } }
`;

function useMedia(q) {
  const mq = useMemo(() => (typeof window !== 'undefined' && window.matchMedia ? window.matchMedia(q) : null), [q]);
  const [on, setOn] = useState(!!mq?.matches);
  useEffect(() => { if (!mq) return undefined; const f = () => setOn(mq.matches); mq.addEventListener('change', f); return () => mq.removeEventListener('change', f); }, [mq]);
  return on;
}
const fill = (tpl, vars) => String(tpl).replace(/\{(\w+)\}/g, (m, k) => (k in vars ? String(vars[k]) : m));
const store = {
  get: k => { try { return window.localStorage.getItem(k); } catch { return null; } },
  set: (k, v) => { try { window.localStorage.setItem(k, v); } catch { /* 残せなくても画面は動く */ } },
};
async function copyText(text) {
  try { if (navigator.clipboard?.writeText) { await navigator.clipboard.writeText(text); return true; } } catch { /* 下の写し方へ */ }
  try { const ta = document.createElement('textarea'); ta.value = text; ta.style.position = 'fixed'; ta.style.opacity = '0'; document.body.appendChild(ta); ta.select(); const ok = document.execCommand('copy'); ta.remove(); return ok; } catch { return false; }
}
const readTable = () => { try { const v = JSON.parse(store.get(READ_KEY) || '{}'); return v && typeof v === 'object' && !Array.isArray(v) ? v : {}; } catch { return {}; } };
const readAt = id => { const v = readTable()[id]; return typeof v === 'string' ? v : null; };
function saveRead(id, at) {
  const tbl = { ...readTable(), [id]: at };
  const keep = Object.entries(tbl).filter(([, v]) => typeof v === 'string').sort((a, b) => (a[1] < b[1] ? 1 : -1)).slice(0, READ_MAX);
  store.set(READ_KEY, JSON.stringify(Object.fromEntries(keep)));
}
const hasFiles = e => [...(e?.dataTransfer?.types || [])].includes('Files');

// 3-3: Markdown の塊を React の要素で描く（文字は全部文字のまま）
const inline = text => mdInline(text).map((s, i) => (s.t === 'b' ? h('b', { key: i }, s.v) : s.t === 'code' ? h('code', { key: i }, s.v) : s.v));
function Md({ text }) {
  return mdBlocks(text).map((b, i) => {
    if (b.type === 'code') return h('pre', { key: i }, b.text);
    if (b.type === 'h') return h('h4', { key: i }, inline(b.text));
    if (b.type === 'ul' || b.type === 'ol') return h(b.type, { key: i }, b.items.map((x, j) => h('li', { key: j }, inline(x))));
    if (b.type === 'quote') return h('blockquote', { key: i }, inline(b.text));
    if (b.type === 'table') {
      const n = Math.max(...b.rows.map(r => r.length));
      return h('div', { key: i, className: 'aioc-tbl', style: { gridTemplateColumns: `repeat(${n}, minmax(0, 1fr))` } },
        b.rows.flatMap((r, ri) => Array.from({ length: n }, (_, ci) => h('div', { key: `${ri}-${ci}`, className: ri ? '' : 'aioc-th' }, inline(r[ci] || '')))));
    }
    return h('p', { key: i }, inline(b.text));
  });
}

export function CasePage({ api, t, issueId, companyId, companyPrefix, agents, labels, backHref, onBack, hrefOf, goCase }) {
  const narrow = useMedia(NARROW), touch = useMedia(TOUCH);
  const mobile = narrow || touch;
  const [issue, setIssue] = useState(null);
  const [comments, setComments] = useState([]);
  const [parent, setParent] = useState(null);
  const [tree, setTree] = useState(null);
  const [loadError, setLoadError] = useState(false);
  const [error, setError] = useState(null);
  const [note, setNote] = useState(null);
  const [text, setText] = useState('');
  const [files, setFiles] = useState([]);
  const [busy, setBusy] = useState(false);
  const [sendingSay, setSendingSay] = useState(false);
  const [tab, setTab] = useState('talk');
  const [startId, setStartId] = useState(null);
  const [divider, setDivider] = useState(null);
  const [open, setOpen] = useState(() => new Set());
  const [longIds, setLongIds] = useState(() => new Set());
  const [copied, setCopied] = useState('');
  const [unseen, setUnseen] = useState(0);
  const [menu, setMenu] = useState(false);
  const [dragging, setDragging] = useState(false);
  const [newSub, setNewSub] = useState({ title: '', owner: '' });
  const [result, setResult] = useState('');
  const [owed, setOwed] = useState(null); // 子は完了にしたが、親に書けなかった決まった事（押し直しで親に書く）
  const [height, setHeight] = useState(0);
  const [myId, setMyId] = useState('');
  const [meDone, setMeDone] = useState(false);
  const [phase, setPhase] = useState(''); // 送る途中の段: upload（止められる）・comment（止めない）
  const seq = useRef(0), sending = useRef(false), abortRef = useRef(null), uploadedRef = useRef([]), filesRef = useRef([]);
  const rootRef = useRef(null), midRef = useRef(null), footRef = useRef(null), taRef = useRef(null), menuRef = useRef(null), attachBtnRef = useRef(null);
  const fileRef = useRef(null), photoRef = useRef(null), camRef = useRef(null);
  const nearRef = useRef(true), userScroll = useRef(false), seenCount = useRef(-1), forceBottom = useRef(false), keepFrom = useRef(null), opened = useRef(false);
  filesRef.current = files;
  useEffect(() => { let on = true; api.me().then(s => { if (on) { setMyId(String(s?.user?.id || '')); setMeDone(true); } }, () => { if (on) setMeDone(true); }); return () => { on = false; }; }, [api]);

  const load = useCallback(async () => {
    const my = ++seq.current;
    try {
      const [i, cs] = await Promise.all([api.issue(issueId), api.comments(issueId)]);
      if (my !== seq.current) return;
      if (!i || String(i.id) !== String(issueId)) { setLoadError(true); return; }
      setIssue(i); setComments(Array.isArray(cs) ? cs : cs?.items || []); setLoadError(false);
      const cid = companyId || i.companyId;
      // 親とサブタスクは読めなくても、会話は出す
      const [p, d] = await Promise.all([i.parentId ? api.issue(i.parentId).catch(() => null) : null, cid && api.subtasks ? api.subtasks(cid, i.id).catch(() => null) : null]);
      if (my !== seq.current) return;
      setParent(p && String(p.id) === String(i.parentId) ? p : null);
      if (d) setTree(subtaskTree(i.id, d));
    } catch { if (my === seq.current) setLoadError(true); }
  }, [api, issueId, companyId]);
  useEffect(() => {
    setIssue(null); setComments([]); setParent(null); setTree(null); setError(null); setNote(null); setText(''); setFiles([]); setTab('talk');
    setStartId(null); setDivider(null); setOpen(new Set()); setUnseen(0); setResult(''); setOwed(null); setMenu(false);
    seenCount.current = -1; nearRef.current = true; opened.current = false; uploadedRef.current = [];
    load(); const id = setInterval(load, REFRESH_MS); return () => { seq.current++; clearInterval(id); abortRef.current?.abort(); };
  }, [load]);
  useEffect(() => { if (!note) return undefined; const id = setTimeout(() => setNote(null), NOTE_MS); return () => clearTimeout(id); }, [note]);

  // 1-1: 画面の残りの高さを、このページの高さにする（上と下を固定し、真ん中だけをスクロールさせる）。
  // 本体の携帯の下のメニューのように、画面の下に固定された外の物があれば、その上端までにする（入力欄を隠さない）。
  // そのメニューはスクロールで出たり隠れたりするので、スクロールの時と 1 秒ごとに測り直す
  useLayoutEffect(() => {
    if (typeof window === 'undefined') return undefined;
    const fit = () => {
      const root = rootRef.current, viewH = window.visualViewport?.height || window.innerHeight;
      const covers = [];
      if (document.elementsFromPoint) {
        for (const x of [8, window.innerWidth / 2, window.innerWidth - 8]) {
          for (const el of document.elementsFromPoint(x, viewH - 2)) {
            if (root?.contains(el)) continue;
            for (let e = el; e && e !== document.body; e = e.parentElement) {
              const pos = getComputedStyle(e).position;
              if (pos === 'fixed' || pos === 'sticky') { covers.push(e.getBoundingClientRect().top); break; }
            }
          }
        }
      }
      setHeight(fitHeight({ viewH, top: root?.getBoundingClientRect().top ?? 0, covers }));
    };
    fit();
    const id = setInterval(fit, 1000);
    window.addEventListener('resize', fit); window.addEventListener('scroll', fit, { passive: true }); window.visualViewport?.addEventListener('resize', fit);
    return () => { clearInterval(id); window.removeEventListener('resize', fit); window.removeEventListener('scroll', fit); window.visualViewport?.removeEventListener('resize', fit); };
  }, [issue == null]);

  const reject = useMemo(() => findRejectLabel(labels, REJECT_NAMES), [labels]);
  const kase = useMemo(() => (issue ? pickCase(issue, comments, TABLE) : null), [issue, comments]);
  const chat = useMemo(() => chatItems(comments, myId), [comments, myId]);
  // サブタスクの一覧を読めるまでは案を出さない（同じ題の子を 2 つ作らない）
  const ideas = useMemo(() => (tree ? splitIdeas(kase?.split).filter(x => !tree.kids.some(k => String(k.issue.title).trim() === x)) : []), [kase, tree]);
  const agentName = id => (agents || []).find(a => String(a.id) === String(id))?.name || t('case_agent');

  // 2-1・3-1: 開いた時に、既読の時刻から未読の区切りと表示の始まりを決める（開いている間は動かさない）
  useEffect(() => {
    // 自分の id が分かるまで決めない（自分の発言を他の人として数えて、区切りを付けない）
    if (opened.current || !issue || !meDone) return;
    opened.current = true;
    const div = firstUnread(chat, readAt(issueId));
    setDivider(div);
    const di = div ? chat.findIndex(m => m.id === div) : -1;
    const base = Math.max(0, chat.length - FIRST_MESSAGES);
    const s = di >= 0 ? Math.min(base, di) : base;
    setStartId(chat[s]?.id || null);
  }, [issue, chat, myId, meDone]);
  const from = startIndex(chat, startId);
  const visible = chat.slice(from);

  const mid = () => midRef.current;
  const near = () => { const m = mid(); return !m || m.scrollHeight - m.scrollTop - m.clientHeight < (mobile ? NEAR_PX.mobile : NEAR_PX.pc); };
  const markRead = () => { const last = chat[chat.length - 1]; if (last?.at && String(last.at) > String(readAt(issueId) || '')) saveRead(issueId, String(last.at)); };
  const toBottom = () => { const m = mid(); if (m) m.scrollTop = m.scrollHeight; nearRef.current = true; userScroll.current = false; setUnseen(0); markRead(); };
  // 2-1・2-2・2-3・2-4: 開いた時は未読の区切りか一番下へ、送った時は一番下へ。新しい発言は一番下の近くにいる時だけ付いて行き、上を読んでいる時は数を出す
  useLayoutEffect(() => {
    if (tab !== 'talk' || !issue || !opened.current) return;
    if (keepFrom.current) { const m = mid(); if (m) m.scrollTop = m.scrollHeight - keepFrom.current.h + keepFrom.current.y; keepFrom.current = null; return; }
    const before = seenCount.current; seenCount.current = chat.length;
    if (before < 0 && divider) {
      const m = mid(), el = m?.querySelector('[data-case-unread]');
      if (m && el) { m.scrollTop = Math.max(0, m.scrollTop + el.getBoundingClientRect().top - m.getBoundingClientRect().top - 8); nearRef.current = near(); if (nearRef.current) markRead(); return; }
    }
    if (before < 0 || forceBottom.current || nearRef.current) { forceBottom.current = false; toBottom(); return; }
    if (chat.length > before) setUnseen(u => u + chat.length - before);
  }, [chat.length, startId, tab, issue == null, divider]);
  // 3-2: 描いた後の高さで、携帯 6 行・PC 12 行を超える発言だけを切る（切る高さと同じ式で測る）
  useLayoutEffect(() => {
    const m = mid(); if (!m) return;
    const next = new Set();
    for (const el of m.querySelectorAll('[data-case-bub]')) {
      const fs = parseFloat(getComputedStyle(el).fontSize) || 15, lim = fs * LINE_EM * (mobile ? LINES.mobile : LINES.pc) + 16;
      if (el.scrollHeight > lim + 2) next.add(el.getAttribute('data-case-bub'));
    }
    if (next.size !== longIds.size || [...next].some(x => !longIds.has(x))) setLongIds(next);
  });
  // 5-1: 入力欄は文に合わせて伸ばす（PC 200px・携帯 120px まで）
  useLayoutEffect(() => { const ta = taRef.current; if (!ta) return; ta.style.height = 'auto'; ta.style.height = `${Math.min(ta.scrollHeight, mobile ? 120 : 200)}px`; }, [text, mobile, tab]);
  // 添付のメニューは、外を押すと閉じる
  useEffect(() => {
    if (!menu) return undefined;
    const off = e => { if (!menuRef.current?.contains(e.target) && !attachBtnRef.current?.contains(e.target)) setMenu(false); };
    document.addEventListener('pointerdown', off); return () => document.removeEventListener('pointerdown', off);
  }, [menu]);

  function addFiles(list) {
    const { ok, ng } = attachSplit(filesRef.current, [...(list || [])]);
    if (ok.length) setFiles(f => [...f, ...ok]);
    if (ng.length) setError({ key: `case_err_attach_${ng[0].why}`, vars: { name: ng[0].name } });
  }
  // 5-5: ページのどこに落としても添付にする（枠の外に落としてもブラウザがファイルを開いてページを離れない）
  useEffect(() => {
    if (typeof window === 'undefined') return undefined;
    const over = e => { if (!hasFiles(e)) return; e.preventDefault(); setDragging(true); };
    const leave = e => { if (!e.relatedTarget) setDragging(false); };
    const drop = e => { if (!hasFiles(e)) return; e.preventDefault(); setDragging(false); addFiles(e.dataTransfer.files); };
    window.addEventListener('dragover', over); window.addEventListener('dragleave', leave); window.addEventListener('drop', drop);
    return () => { window.removeEventListener('dragover', over); window.removeEventListener('dragleave', leave); window.removeEventListener('drop', drop); };
  }, []);

  async function send() {
    if (sending.current) return; // 連打・Enter の重ね打ちで 2 回送らない
    const raw = text.trim(), list = filesRef.current;
    if (!raw && !list.length && !uploadedRef.current.length) return;
    const c = raw ? checkSay(raw) : { ok: true, body: '' };
    if (!c.ok) { if (c.why === 'long') setError({ key: 'case_err_long' }); return; }
    const ac = typeof AbortController !== 'undefined' ? new AbortController() : null;
    abortRef.current = ac; sending.current = true; setBusy(true); setSendingSay(true); setPhase('upload'); setError(null);
    try {
      // 添付を先に 1 つずつ送り、送れた物は欄から外す（送り直しで同じ添付を重ねない）。全部送れた後に名前つきの発言を書く
      for (const f of list) {
        try { await api.upload(companyId || issue.companyId, issueId, f, { signal: ac?.signal }); }
        catch (e) { if (ac?.signal.aborted) throw e; setError({ key: 'case_err_upload' }); return; }
        uploadedRef.current = [...uploadedRef.current, f.name];
        setFiles(cur => cur.filter(x => x !== f));
      }
      // 発言は止めない（本体に届いた後に止めたと見なして送り直すと、同じ発言が 2 つになる）
      if (ac?.signal.aborted) throw new Error('stopped');
      setPhase('comment');
      await api.addComment(issueId, withAttachNote(c.body, uploadedRef.current, t('case_attached')));
      uploadedRef.current = [];
      // 送っている間に打ち足した文は消さない
      setText(cur => (cur.trim() === raw ? '' : cur));
      forceBottom.current = true; setTab('talk'); await load();
    } catch {
      if (ac?.signal.aborted) setNote('case_stopped'); else setError({ key: 'case_err_send' });
    } finally { abortRef.current = null; sending.current = false; setBusy(false); setSendingSay(false); setPhase(''); }
  }
  // 5-6: 送っている間は「止める」で残りを送らない（送り終えた添付は課題に残る）
  function stop() { abortRef.current?.abort(); }
  // 推奨で進める: 持ち主の一言と未着手に戻す更新を 1 回で送る（別々に送ると担当が 2 回起きる）
  async function go() {
    if (sending.current) return;
    sending.current = true; setBusy(true); setError(null);
    try { if (!goDone(await api.patchIssue(issueId, goPatch(t('case_go_comment'))))) throw new Error('not moved'); await load(); }
    catch { setError({ key: 'case_err_go' }); }
    finally { sending.current = false; setBusy(false); }
  }
  async function addSub(title, owner, fromForm) {
    const v = String(title || '').trim(); if (!v || sending.current) return;
    sending.current = true; setBusy(true); setError(null);
    try {
      await api.addChild(issueId, { title: v.slice(0, 200), assigneeAgentId: owner || undefined });
      if (fromForm) setNewSub(s => ({ ...s, title: '' }));
      setNote('case_sub_added'); await load();
    } catch { setError({ key: 'case_err_sub' }); }
    finally { sending.current = false; setBusy(false); }
  }
  // 完了にして親に返す: 子を完了にして決まった事を残し、親の会話に書く（親の担当が起きて、決まった事を受け取る）
  async function finish() {
    const c = checkResult(result); if (!c.ok || sending.current || !issue?.parentId) return;
    sending.current = true; setBusy(true); setError(null);
    try {
      const r = await api.patchIssue(issueId, childDonePatch(t('case_result_label'), c.body));
      if ((r?.issue || r)?.status !== 'done') throw new Error('not done');
      setOwed(c.body); setResult('');
      try { await api.addComment(issue.parentId, parentNote(t('case_parent_note'), issue.title, c.body)); }
      catch { setError({ key: 'case_err_result_parent' }); await load(); return; }
      setOwed(null);
      if (goCase) goCase(issue.parentId)(); else await load();
    } catch { setError({ key: 'case_err_result' }); }
    finally { sending.current = false; setBusy(false); }
  }
  // 親に書けなかった決まった事を、もう一度親に書く（子はもう完了なので PATCH はしない）
  async function retryParent() {
    if (!owed || sending.current || !issue?.parentId) return;
    sending.current = true; setBusy(true); setError(null);
    try { await api.addComment(issue.parentId, parentNote(t('case_parent_note'), issue.title, owed)); setOwed(null); if (goCase) goCase(issue.parentId)(); }
    catch { setError({ key: 'case_err_result_parent' }); }
    finally { sending.current = false; setBusy(false); }
  }
  async function copy(m) { if (await copyText(hideJson(m.body) || m.body)) { setCopied(m.id); setTimeout(() => setCopied(c => (c === m.id ? '' : c)), COPIED_MS); } }
  function older() { const m = mid(); if (m) keepFrom.current = { h: m.scrollHeight, y: m.scrollTop }; setStartId(chat[Math.max(0, from - FIRST_MESSAGES)]?.id || null); }
  function flip(id) { setOpen(s => { const n = new Set(s); n.has(id) ? n.delete(id) : n.add(id); return n; }); }
  // 2-5: 「読んでいる途中」と見なすのは、人が動かした時だけ（指・ホイール・キー・スクロールバー）。画面が動かした時は付いて行くのを止めない
  const touched = () => { userScroll.current = true; };
  function onScroll() {
    if (near()) { nearRef.current = true; if (unseen) setUnseen(0); markRead(); }
    else if (userScroll.current) nearRef.current = false;
  }

  const navTo = id => (goCase ? goCase(id) : undefined);
  const backBtn = low => (issue?.parentId
    ? h('a', { href: hrefOf ? hrefOf(issue.parentId) : backHref, onClick: navTo(issue.parentId), className: `aioc-back${low ? ' aioc-back-low' : ''}`, 'data-case-back': low ? 'low' : 'parent' },
      h('span', null, t('case_back_parent')), parent ? h('b', null, parent.title) : null)
    : h(Link, { href: backHref, onClick: onBack, className: `aioc-back${low ? ' aioc-back-low' : ''}`, 'data-case-back': low ? 'low' : '1' }, h('span', null, t('case_back'))));

  const frame = (...kids) => h('div', { ref: rootRef, className: `aioc ${mobile ? 'aioc-mobile' : 'aioc-pc'}`, 'data-case': issueId, style: height ? { height: `${height}px` } : undefined }, ...kids);
  if (loadError && !issue) return frame(h('div', { className: 'aioc-head' }, backBtn(false)), h('div', { className: 'aioc-mid' }, h('p', { className: 'aiob-err', role: 'alert' }, t('case_err_load'))));
  if (!issue) return frame(h('div', { className: 'aioc-head' }, backBtn(false)), h('div', { className: 'aioc-mid' }, h('p', { className: 'aiob-muted' }, t('loading'))));

  const col = columnOf(issue, { rejectLabelId: reject?.id }) || (issue.status === 'cancelled' ? 'cancelled' : 'done');
  const owner = issue.assigneeAgentId ? agentName(issue.assigneeAgentId) : t('board_no_agent');
  const tagIds = (issue.labelIds?.length ? issue.labelIds : (issue.labels || []).map(l => l.id)).map(String);
  const tags = tagIds.map(id => (labels || []).find(l => String(l.id) === id)).filter(Boolean);
  const row = (k, v) => h('div', { key: k, className: `aioc-row aioc-row-${k}` }, h('div', { className: 'aioc-k' }, t(`case_h_${k}`)), h('div', { className: 'aioc-v' }, v));
  const hostHref = `/${encodeURIComponent(companyPrefix || '')}/issues/${encodeURIComponent(issue.identifier || issue.id)}`;
  const statusText = s => (s === 'cancelled' ? t('case_st_cancelled') : t(`board_col_${s}`));
  const kidsN = tree?.kids.length || 0;
  const closed = issue.status === 'done' || issue.status === 'cancelled';
  const words = { today: t('case_today'), yesterday: t('case_yesterday'), date: t('case_date') };
  const now = Date.now();
  const lines = mobile ? LINES.mobile : LINES.pc;

  const msgs = [];
  visible.forEach((m, i) => {
    const prev = visible[i - 1];
    if (!prev || dayKey(prev.at) !== dayKey(m.at)) { const dl = dayLabel(m.at, now, words); if (dl) msgs.push(h('div', { key: `d-${m.id}`, className: 'aioc-day', 'data-case-day': '1' }, h('span', null, dl))); }
    if (m.id === divider) msgs.push(h('div', { key: 'unread', className: 'aioc-unread', 'data-case-unread': '1' }, t('case_unread')));
    const cut = !open.has(m.id), long = longIds.has(m.id);
    msgs.push(h('div', { key: m.id, className: `aioc-msg${m.who === 'me' ? ' aioc-msg-me' : ''}`, 'data-case-who': m.who },
      m.who === 'me' ? null : h('span', { className: 'aioc-who' }, m.who === 'agent' ? agentName(m.agentId) : t('case_person')),
      h('div', { className: `aioc-bub${cut ? ' aioc-cut' : ''}${cut && long ? ' aioc-long' : ''}`, 'data-case-bub': m.id, style: cut ? { maxHeight: `calc(${lines} * ${LINE_EM}em + 16px)` } : undefined },
        h(Md, { text: hideJson(m.body) || m.body })),
      h('div', { className: 'aioc-ops' },
        h('span', { className: 'aioc-time', 'data-case-time': '1' }, hhmm(m.at)),
        long ? h('button', { type: 'button', className: 'aioc-xp', onClick: () => flip(m.id), 'data-case-more': m.id }, open.has(m.id) ? t('case_less') : t('case_more')) : null,
        h('button', { type: 'button', className: 'aioc-cp', onClick: () => copy(m), 'aria-label': t('case_copy'), 'data-case-copy': m.id }, copied === m.id ? `✓ ${t('case_copied')}` : `⧉ ${t('case_copy')}`))));
  });

  const talk = h('div', { 'data-case-chat': String(chat.length) },
    from ? h('button', { type: 'button', className: 'aioc-older', onClick: older, 'data-case-older': String(from) }, fill(t('case_older'), { n: Math.min(from, FIRST_MESSAGES), left: from })) : null,
    msgs.length ? msgs : h('p', { className: 'aiob-muted' }, t('case_chat_none')),
    ideas.length && !closed ? h('div', { className: 'aioc-split', 'data-case-split': String(ideas.length) },
      h('small', { className: 'aiob-muted' }, owner, ': ', t('case_split_lead')),
      ...ideas.map(x => h('div', { key: x, className: 'aioc-split-i' }, h('span', null, x), h(Button, { kind: 'primary', small: true, busy, onClick: () => addSub(x, issue.assigneeAgentId, false) }, t('case_split_take'))))) : null,
    owed && issue.parentId ? h('div', { className: 'aioc-res' }, h(Button, { kind: 'primary', busy, onClick: retryParent, 'data-case-retry': '1' }, t('case_result_retry'))) : null,
    issue.parentId && !closed ? h('div', { className: 'aioc-res' },
      h('input', { value: result, placeholder: t('case_result_ph'), 'aria-label': t('case_result_ph'), maxLength: 1000, onChange: e => setResult(e.target.value), 'data-case-result': '1' }),
      h(Button, { busy, disabled: !result.trim(), onClick: finish, 'data-case-finish': '1' }, t('case_result_btn'))) : null);

  const subs = h('div', { 'data-case-subs': String(kidsN) },
    kidsN ? h('div', null,
      h('div', { className: 'aiob-muted' }, fill(t('case_subs_count'), { n: kidsN, done: tree.done }), tree.all > kidsN ? fill(t('case_subs_all'), { all: tree.all }) : '', ' ', t('case_subs_deeper')),
      h('div', { className: 'aioc-prog' }, h('i', { style: { width: `${Math.round((tree.done / kidsN) * 100)}%` } }))) : null,
    h('div', { className: 'aioc-subs' },
      ...(kidsN ? tree.kids.map(({ issue: k, below, belowDone }) => h('a', {
        key: k.id, href: hrefOf ? hrefOf(k.id) : backHref, onClick: navTo(k.id), className: `aioc-s${k.status === 'done' ? ' aioc-s-done' : ''}`, 'data-case-sub': k.id },
        h('span', { className: 'aioc-st-t' }, k.title),
        below ? h('span', { className: 'aioc-below' }, fill(t('case_sub_below'), { n: below, done: belowDone })) : null,
        h('small', null, k.assigneeAgentId ? agentName(k.assigneeAgentId) : t('board_no_agent')),
        h('span', { className: 'aioc-st' }, statusText(columnOf(k, { rejectLabelId: reject?.id }) || (k.status === 'cancelled' ? 'cancelled' : 'done')))))
        : [h('div', { key: 'none', className: 'aioc-s' }, h('span', { className: 'aiob-muted' }, tree ? t('case_subs_none') : t('loading')))]),
      h('div', { className: 'aioc-add' },
        h('input', { value: newSub.title, placeholder: t('case_sub_add'), 'aria-label': t('case_sub_add'), maxLength: 200, 'data-case-sub-title': '1',
          onChange: e => setNewSub(s => ({ ...s, title: e.target.value })), onKeyDown: e => { if (e.key === 'Enter' && !e.isComposing && e.keyCode !== 229) addSub(newSub.title, newSub.owner, true); } }),
        h('select', { value: newSub.owner, 'aria-label': t('case_sub_owner'), 'data-case-sub-owner': '1', onChange: e => setNewSub(s => ({ ...s, owner: e.target.value })) },
          h('option', { value: '' }, t('board_no_agent')), ...(agents || []).map(a => h('option', { key: a.id, value: a.id }, a.name))),
        h(Button, { busy, disabled: !newSub.title.trim(), onClick: () => addSub(newSub.title, newSub.owner, true), 'data-case-sub-add': '1' }, t('case_sub_add_btn')))));

  const body = h('div', null,
    h('div', { className: 'aioc-meta' }, h('span', { className: 'aiob-muted' }, t('board_agents'), ' ', owner),
      ...tags.map(l => h('span', { key: l.id, className: 'aiob-tag' }, h('span', { className: 'aiob-dot', style: { background: safeColor(l.color, TAG_COLOR) }, 'aria-hidden': 'true' }), l.name)),
      h(Link, { href: hostHref, className: 'aiob-muted' }, t('case_open_host'))),
    kase
      ? h('div', { className: 'aioc-box', 'data-case-shape': kase.from }, ...SECTIONS.filter(k => kase[k] && k !== 'split').map(k => row(k, kase[k])),
        // 課題の本文から作った物は、節に拾わなかった文を隠さないよう、本文の全文も下に出す
        kase.from === 'description' && issue.description ? h('div', { key: 'body', className: 'aioc-row' }, h('div', { className: 'aioc-k' }, t('case_body')), h('div', { className: 'aioc-v' }, issue.description)) : null)
      : h('div', null, h('p', { className: 'aiob-muted' }, t('case_no_shape')),
        issue.description ? h('div', { className: 'aioc-box' }, h('div', { className: 'aioc-row' }, h('div', { className: 'aioc-k' }, t('case_body')), h('div', { className: 'aioc-v' }, issue.description))) : null),
    kase?.rec && col === 'review' ? h('div', { className: 'aioc-acts' }, h(Button, { kind: 'primary', busy, onClick: go, 'data-case-go': '1' }, t('case_go'))) : null,
    h('p', { className: 'aioc-note' }, t('case_note')));

  const TABS = ['talk', 'subs', 'body'];
  const tabKey = e => { const i = TABS.indexOf(tab), d = e.key === 'ArrowRight' ? 1 : e.key === 'ArrowLeft' ? -1 : 0; if (!d) return; e.preventDefault(); setTab(TABS[(i + d + TABS.length) % TABS.length]); };
  const tabBtn = (k, label, n) => h('button', { type: 'button', role: 'tab', 'aria-selected': tab === k ? 'true' : 'false', tabIndex: tab === k ? 0 : -1, onClick: () => setTab(k), 'data-case-tab': k }, label, n ? h('span', { className: 'aioc-n' }, n) : null);
  const footH = footRef.current?.offsetHeight || 64;
  const err = error ? fill(t(error.key), error.vars || {}) : null;

  return frame(
    h('div', { className: 'aioc-head' },
      backBtn(false),
      h('div', { className: 'aioc-top' }, h('h1', null, issue.title), h('span', { className: 'aioc-st', 'data-case-status': col }, statusText(col))),
      kase?.ask && !closed ? h('div', { className: 'aioc-ask1', 'data-case-ask': '1' }, h('b', null, t('case_h_ask')), kase.ask.split('\n')[0].slice(0, 200), ' ',
        h('button', { type: 'button', onClick: () => setTab('body') }, t('case_ask_peek'))) : null,
      h('div', { className: 'aioc-tabs', role: 'tablist', onKeyDown: tabKey },
        tabBtn('talk', t('case_tab_talk'), chat.length || ''), tabBtn('subs', t('case_tab_subs'), kidsN ? `${tree.done}/${kidsN}` : ''), tabBtn('body', t('case_tab_body'), ''))),
    h('div', { className: 'aioc-mid', ref: midRef, 'data-case-mid': tab, onScroll, onTouchStart: touched, onWheel: touched, onPointerDown: touched, onKeyDown: touched },
      tab === 'talk' ? talk : tab === 'subs' ? subs : body,
      backBtn(true)),
    unseen && tab === 'talk' ? h('button', { type: 'button', className: 'aioc-jump', style: { bottom: `${footH + 10}px` }, onClick: toBottom, 'data-case-jump': String(unseen) }, `${t('case_jump')}${unseen}`) : null,
    menu ? h('div', { ref: menuRef, className: 'aioc-menu', style: { bottom: `${footH + 6}px` }, 'data-case-menu': '1' },
      h('button', { type: 'button', onClick: () => { setMenu(false); photoRef.current?.click(); } }, '🖼 ', t('case_attach_photo')),
      h('button', { type: 'button', onClick: () => { setMenu(false); fileRef.current?.click(); } }, '📄 ', t('case_attach_file')),
      touch ? h('button', { type: 'button', onClick: () => { setMenu(false); camRef.current?.click(); } }, '📷 ', t('case_attach_camera')) : null) : null,
    dragging ? h('div', { className: 'aioc-dropzone', 'data-case-drop': '1' }, t('case_drop')) : null,
    h('div', { className: 'aioc-foot', ref: footRef },
      err ? h('p', { className: 'aiob-err', role: 'alert', 'data-case-err': '1' }, err) : note ? h('p', { className: 'aiob-muted', role: 'status', 'data-case-note': note }, t(note)) : null,
      files.length ? h('div', { className: 'aioc-chips', 'data-case-files': String(files.length) }, ...files.map((f, i) => h('span', { key: `${f.name}-${i}` }, h('em', null, '📎 ', f.name),
        h('button', { type: 'button', 'aria-label': t('case_attach_remove'), disabled: sendingSay, onClick: () => setFiles(fs => fs.filter((_, j) => j !== i)) }, '×')))) : null,
      h('div', { className: 'aioc-comp' },
        h('button', { ref: attachBtnRef, type: 'button', className: 'aioc-ic', 'aria-label': t('case_attach'), 'aria-expanded': menu ? 'true' : 'false', onClick: () => setMenu(v => !v), 'data-case-attach': '1' }, '＋'),
        h('textarea', { ref: taRef, value: text, rows: 1, placeholder: `${owner} — ${t('case_say')}`, 'aria-label': t('case_say'), 'data-case-say': '1',
          onChange: e => setText(e.target.value),
          onKeyDown: e => { if (enterSends(e, touch) || (e.key === 'Enter' && (e.metaKey || e.ctrlKey))) { e.preventDefault(); send(); } },
          // 文と画像を一緒に貼った時は、文はそのまま入れ、画像だけを添付にする
          onPaste: e => { const fs = e.clipboardData?.files; if (!fs?.length) return; if (!String(e.clipboardData.getData('text/plain') || '').trim()) e.preventDefault(); addFiles(fs); } }),
        sendingSay && phase === 'upload'
          ? h('button', { type: 'button', className: 'aioc-stop', onClick: stop, 'data-case-stop': '1' }, t('case_stop'))
          : h(Button, { kind: 'primary', busy, disabled: !text.trim() && !files.length && !uploadedRef.current.length, onClick: send, 'data-case-send': '1' }, t('case_send'))),
      h('div', { className: 'aioc-hint' }, touch ? t('case_hint_touch') : t('case_hint_pc')),
      h('input', { ref: photoRef, type: 'file', accept: 'image/*', multiple: true, hidden: true, onChange: e => { addFiles(e.target.files); e.target.value = ''; } }),
      h('input', { ref: fileRef, type: 'file', multiple: true, hidden: true, onChange: e => { addFiles(e.target.files); e.target.value = ''; } }),
      h('input', { ref: camRef, type: 'file', accept: 'image/*', capture: 'environment', hidden: true, onChange: e => { addFiles(e.target.files); e.target.value = ''; } })));
}
