// タスクボードの画面（/:会社の prefix/board）。office の plugin とは別の plugin（aioffice.board）なので、オフィスの画面がどの plugin でも足せる。
// 部品・文言・API の口は office の src を使う（build で 1 本に詰まる）。リストと Kanban を切り替え、ラベル・担当・すぐ絞るのチップで絞る。
// 設計: docs/design/2026-11-24-secretary-conversation-kanban.md §6。モック: docs/mocks/secretary-board.html（承認 2026-11-24）
// 計算は board-lib.mjs。画面の文字は i18n.mjs の board_* だけ。JSX を使わず createElement で書く
import { createElement as h, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useHostContext, usePluginData } from '@paperclipai/plugin-sdk/ui';
import { translator, pickLang, DICT } from '../../office/src/i18n.mjs';
import { createApi } from '../../office/src/api.mjs';
import { Button, Link, OFFICE_CSS } from '../../office/src/controls.mjs';
import { BOARD_ROUTE } from './manifest.mjs';
import { CasePage, CASE_CSS } from './case.mjs';
import { DeskView, DESK_CSS } from './desk.mjs';
import { caseIdFrom, caseHref } from './case-lib.mjs';
import { COLUMNS, COLUMN_FOLD, LIST_FOLD, DONE_DAYS, moveRefusal, serverRefusal, browserLang, QUICK_KEYS, boardRows, applyFilter, byColumn, facetCounts, findRejectLabel, movePatch, newFilter, toggleFilter, filterSize, checkNewLabel, safeColor, shownColumn, isIssueShape } from './board-lib.mjs';

const REFRESH_MS = 15000;
const LOAD_STUCK_MS = 60000; // 読みがこれより長く終わらない時は、次の定期の読みを通す（応答の返らない接続で、以後ずっと読まなくなるのを防ぐ）
const NARROW = '(max-width: 640px)';
const REJECT_COLOR = '#b3261e', NEW_LABEL_COLOR = '#5c574f';
const REJECT_NAMES = [DICT.en.board_label_returned, DICT.ja.board_label_returned];

export const BOARD_CSS = `
.aiob { color: var(--aio-fg); padding: 16px; max-width: 1280px; margin: 0 auto; font-size: 14px; line-height: 1.6; }
.aiob h1 { font-size: 18px; margin: 0; }
.aiob-head { display: flex; align-items: center; gap: 12px; flex-wrap: wrap; margin-bottom: 14px; }
.aiob-grow { margin-left: auto; display: flex; gap: 6px; align-items: center; }
.aiob-bar { display: flex; gap: 6px; align-items: center; flex-wrap: wrap; margin-bottom: 8px; }
.aiob-lbl { font-size: 12px; color: var(--aio-muted); flex: 0 0 4.5em; }
.aio .aiob-chip { min-height: 0; gap: 6px; border-radius: 99px; padding: 4px 11px; font-size: 12.5px; font-weight: 400; white-space: nowrap; }
.aiob-card:focus-visible, .aiob-input:focus-visible { outline: 3px solid var(--aio-ring); outline-offset: 2px; }
.aio .aiob-chip[aria-pressed="true"] { background: var(--aio-accent); border-color: var(--aio-accent); color: var(--aio-accent-fg); }
.aio .aiob-chip-add { border-style: dashed; color: var(--aio-muted); }
.aiob-n { opacity: .7; font-variant-numeric: tabular-nums; }
.aiob-dot { width: 8px; height: 8px; border-radius: 50%; display: inline-block; }
.aiob-input { border: 1px solid var(--aio-accent); border-radius: 99px; padding: 4px 11px; font: inherit; font-size: 12.5px; width: 11em; background: var(--aio-card); color: var(--aio-fg); }
.aiob-muted { color: var(--aio-muted); font-size: 12.5px; }
.aiob-err { color: var(--aio-err); font-size: 13px; margin: 6px 0; }
.aiob-cols { display: flex; gap: 10px; align-items: stretch; margin-top: 12px; }
.aiob-lane { flex: 1 1 0; min-width: 0; }
.aiob-lane-empty { flex: 0 0 56px; }
.aiob-lane-over { background: color-mix(in srgb, var(--aio-accent) 8%, transparent); border-radius: 12px; }
.aiob-col { background: var(--aio-card); border: 1px solid var(--aio-line); border-radius: 12px; padding: 10px; }
.aiob-col-empty { padding: 10px 4px; }
.aiob-col-empty .aiob-colh { writing-mode: vertical-rl; margin: 0 auto; justify-content: flex-start; gap: 6px; }
.aiob-col-over { outline: 2px dashed var(--aio-accent); }
.aiob-colh { font-size: 12.5px; color: var(--aio-muted); display: flex; justify-content: space-between; margin-bottom: 8px; font-weight: 600; }
.aiob-card { border: 1px solid var(--aio-line); border-radius: 10px; padding: 8px 10px; margin-bottom: 8px; background: var(--background, var(--aio-card)); cursor: grab; }
.aiob-card:hover { border-color: var(--aio-accent); }
.aiob-card[aria-busy="true"] { opacity: .6; }
.aiob-title { color: inherit; text-decoration: none; display: block; overflow-wrap: anywhere; }
.aiob-title:hover { text-decoration: underline; }
.aiob-meta { display: flex; gap: 6px; flex-wrap: wrap; margin-top: 4px; align-items: center; }
.aiob-tag { font-size: 11.5px; padding: 1px 7px; border-radius: 5px; border: 1px solid var(--aio-line); white-space: nowrap; display: inline-flex; gap: 4px; align-items: center; }
.aiob-move { margin-left: auto; border: 1px solid var(--aio-line); background: var(--aio-card); color: var(--aio-fg); border-radius: 8px; font: inherit; font-size: 12px; padding: 2px 4px; }
.aiob-table { width: 100%; border-collapse: collapse; margin-top: 12px; background: var(--aio-card); border: 1px solid var(--aio-line); }
.aiob-table td, .aiob-table th { padding: 8px 10px; border-bottom: 1px solid var(--aio-line); text-align: left; font-size: 13.5px; vertical-align: top; }
.aiob-table th { color: var(--aio-muted); font-weight: 500; font-size: 12px; }
.aiob-mtop { display: flex; align-items: center; gap: 10px; }
.aiob-mact { display: flex; gap: 6px; flex-wrap: wrap; margin-top: 8px; }
.aiob-mcols { display: flex; gap: 6px; overflow-x: auto; margin: 12px 0; padding-bottom: 2px; }
.aiob-shade { position: fixed; inset: 0; background: rgba(0, 0, 0, .35); z-index: 40; }
.aiob-sheet { position: fixed; left: 0; right: 0; bottom: 0; background: var(--aio-card); border-radius: 18px 18px 0 0; padding: 16px 16px 24px; z-index: 41; max-height: 78vh; overflow: auto; }
.aiob-sheet-h { display: flex; justify-content: space-between; align-items: center; margin-bottom: 6px; font-size: 16px; font-weight: 600; }
.aiob-sheet-g { padding: 12px 0; border-top: 1px solid var(--aio-line); }
.aiob-sheet-t { font-size: 12.5px; color: var(--aio-muted); margin-bottom: 8px; }
.aiob-sheet-c { display: flex; flex-wrap: wrap; gap: 8px; }
.aio .aiob-sheet-c .aiob-chip { padding: 7px 13px; font-size: 13.5px; }
`;

function useNarrow() {
  const mq = useMemo(() => (typeof window !== 'undefined' && window.matchMedia ? window.matchMedia(NARROW) : null), []);
  const [narrow, setNarrow] = useState(!!mq?.matches);
  useEffect(() => { if (!mq) return undefined; const on = () => setNarrow(mq.matches); mq.addEventListener('change', on); return () => mq.removeEventListener('change', on); }, [mq]);
  return narrow;
}
// 表示の切り替えは人ごとの好みなので browser に覚える（読めない・書けない時は既定のまま動く）
const VIEW_KEY = 'aioffice.board.view';
// 初めて開いた時は「秘書」（いま決めてほしい件）を出す
const VIEWS = ['desk', 'kanban', 'list'];
const readView = () => { try { const v = globalThis.localStorage?.getItem(VIEW_KEY); return VIEWS.includes(v) ? v : 'desk'; } catch { return 'desk'; } };
const writeView = v => { try { globalThis.localStorage?.setItem(VIEW_KEY, v); } catch { /* 覚えられなくても動く */ } };

function Chip({ on, count, color, onClick, children, add = false, ...rest }) {
  return h(Button, { className: add ? 'aiob-chip aiob-chip-add' : 'aiob-chip', pressed: add ? undefined : !!on, onClick, ...rest },
    color ? h('span', { className: 'aiob-dot', style: { background: safeColor(color, NEW_LABEL_COLOR) }, 'aria-hidden': 'true' }) : null,
    children, count === undefined ? null : h('span', { className: 'aiob-n' }, count));
}

export function BoardPage() {
  const { companyId, companyPrefix } = useHostContext();
  const api = useMemo(() => createApi(), []);
  const [lang, setLang] = useState(() => browserLang(typeof navigator === 'undefined' ? null : navigator));
  useEffect(() => { let on = true; api.launcherState().then(s => { if (on && s?.lang) setLang(pickLang(s.lang)); }, () => {}); return () => { on = false; }; }, [api]);
  const t = translator(lang);
  const narrow = useNarrow();
  // 札を押すと件のページ（?case=）。戻るボタン・← で一覧に戻れるよう、URL に持つ
  const here = () => (typeof window !== 'undefined' ? window.location : { pathname: '', search: '' });
  const [caseId, setCaseId] = useState(() => caseIdFrom(here().search));
  useEffect(() => { if (typeof window === 'undefined') return undefined; const on = () => setCaseId(caseIdFrom(window.location.search)); window.addEventListener('popstate', on); return () => window.removeEventListener('popstate', on); }, []);
  const inCase = useRef(false), pushed = useRef(false);
  inCase.current = !!caseId;
  const goCase = id => e => {
    if (e && (e.metaKey || e.ctrlKey || e.shiftKey || e.button)) return; // 新しいタブで開く操作はそのまま
    e?.preventDefault?.();
    // 一覧から入った件を「← 戻る」で閉じる時は、履歴を 1 つ戻す（browser の戻るで件にまた入らない）
    if (!id && pushed.current) { pushed.current = false; window.history.back(); return; }
    try { window.history.pushState({}, '', caseHref(window.location.pathname, id)); pushed.current = !!id; } catch { /* 履歴に積めなくても開く */ }
    setCaseId(id); window.scrollTo?.(0, 0);
  };
  const agentsQ = usePluginData('agents', { companyId });

  const [issues, setIssues] = useState(null);
  const [labels, setLabels] = useState([]);
  const [filter, setFilter] = useState(newFilter);
  const [routines, setRoutines] = useState(false); // 定期実行が作った課題も出すか（既定は出さない）
  const [listAll, setListAll] = useState(false);
  const [mcol, setMcol] = useState(null);
  // 読み込みの失敗と操作の失敗は別に持つ（読み直しが通った時に、動かせなかった・足せなかったの文まで消さない）
  const [loadError, setLoadError] = useState(null);
  const [error, setError] = useState(null);
  const [busyId, setBusyId] = useState(null);
  const seq = useRef(0), moving = useRef(0), loading = useRef(false), loadStarted = useRef(0);
  const load = useCallback(async (force = false) => {
    if (!companyId) return;
    // 前の読みが終わっていない間の定期の読みは飛ばす（15 秒より遅い時に、結果を毎回捨てて読み込み中のままになる）
    if (loading.current && !force && Date.now() - loadStarted.current < LOAD_STUCK_MS) return;
    loading.current = true; loadStarted.current = Date.now();
    const my = ++seq.current;
    try {
      const since = new Date(Date.now() - DONE_DAYS * 86400000).toISOString();
      const [is, ls] = await Promise.all([api.boardIssues(companyId, since, { routines }), api.labels(companyId)]);
      // 動かしている最中の読み直しは捨てる（古い状態で札が元の列へ戻って見えるのを防ぐ）
      if (my === seq.current && !moving.current) { setIssues(is); setLabels(Array.isArray(ls) ? ls : ls?.items || []); setLoadError(null); }
    } catch { if (my === seq.current) setLoadError('board_err_load'); }
    finally { if (my === seq.current) loading.current = false; }
  }, [api, companyId, routines]);
  // 会社が変わったら、前の会社のラベル・絞り込み・エラーを持ち越さない
  useEffect(() => { setLabels([]); setFilter(newFilter()); setError(null); setMcol(null); }, [companyId]);
  // 読む範囲（会社・定期の実行を出すか）が変わったら読み直す。絞り込みは消さない。件のページを開いている間は、全件の定期の読みを休む
  useEffect(() => {
    setIssues(null); setLoadError(null);
    load(true); const id = setInterval(() => { if (!inCase.current) load(); }, REFRESH_MS);
    return () => { seq.current++; loading.current = false; clearInterval(id); };
  }, [load]);

  const wasCase = useRef(false);
  useEffect(() => { if (wasCase.current && !caseId) load(true); wasCase.current = !!caseId; }, [caseId, load]); // 件のページから戻ったら、すぐ読み直す
  const [view, setView] = useState(readView);
  const [sheet, setSheet] = useState(false);
  const [openCols, setOpenCols] = useState(() => new Set());
  const [adding, setAdding] = useState(false);
  const [over, setOver] = useState(null);
  const pickView = v => { setView(v); writeView(v); };
  const tog = (kind, value) => setFilter(f => toggleFilter(f, kind, value));

  const reject = useMemo(() => findRejectLabel(labels, REJECT_NAMES), [labels]);
  const all = useMemo(() => boardRows(issues, { rejectLabelId: reject?.id }), [issues, reject]);
  const rows = useMemo(() => applyFilter(all, filter), [all, filter]);
  const cols = useMemo(() => byColumn(rows), [rows]);
  const counts = useMemo(() => facetCounts(all, filter), [all, filter]);
  const agents = agentsQ?.data || [];
  const agentName = id => agents.find(a => String(a.id) === id)?.name || t('board_no_agent');
  const agentIds = useMemo(() => [...new Set(all.map(r => r.agentId))], [all]);
  const labelById = useMemo(() => Object.fromEntries(labels.map(l => [String(l.id), l])), [labels]);
  const active = filterSize(filter);

  async function move(id, to) {
    const row = all.find(r => r.id === id);
    if (!row || row.column === to || busyId) return;
    const refused = moveRefusal(row.issue, to);
    if (refused) { setError(`board_err_${refused}`); return; }
    setBusyId(id); setError(null); moving.current += 1;
    try {
      let rid = reject?.id || null;
      if (to === 'back' && !rid) { // 差し戻しのラベルが無い会社では、最初に動かした時に作る
        const made = await api.createLabel(companyId, t('board_label_returned'), REJECT_COLOR);
        if (!made?.id) throw new Error('label was not created');
        rid = made.id;
        setLabels(ls => [...ls, made]);
      }
      // ラベルを変える動きは、送る直前の課題から作る（labelIds は全部の置き換えなので、古い手元の並びで他の人が足したラベルを消さない）
      const touchesLabels = to === 'back' || row.column === 'back';
      let base = row.issue;
      if (touchesLabels) { base = await api.issue(row.issue.id); if (!isIssueShape(base, row.issue.id)) throw new Error('unexpected issue shape'); }
      const patch = movePatch(base, to, { rejectLabelId: rid });
      if (patch) {
        const saved = await api.patchIssue(row.issue.id, patch);
        // 本体が返した課題で置き換える（返らない時は送った変更を重ねる）
        setIssues(is => (is || []).map(i => (String(i.id) === id ? { ...i, ...patch, ...(saved && saved.id ? saved : {}), ...(patch.labelIds ? { labelIds: patch.labelIds, labels: undefined } : {}) } : i)));
      }
    } catch (e) { const why = serverRefusal(e); setError(why ? `board_err_${why}` : 'board_err_move'); }
    finally { moving.current -= 1; setBusyId(null); load(true); }
  }
  // Enter で足した直後に、欄が消える時の blur でもう 1 回呼ばれる。足している間の 2 回目は捨てる（同じラベルが 2 つできた）
  // Escape でやめた時も欄が消える時の blur が来るので、やめた印を立てて捨てる
  const addingNow = useRef(false), addCancelled = useRef(false);
  async function addLabel(raw) {
    if (addCancelled.current) { addCancelled.current = false; return; }
    if (addingNow.current) return;
    addingNow.current = true;
    setAdding(false);
    try {
      const c = checkNewLabel(raw, labels, REJECT_NAMES);
      if (!c.ok) { if (c.why !== 'empty') setError(`board_err_label_${c.why}`); return; }
      const made = await api.createLabel(companyId, c.name, NEW_LABEL_COLOR);
      if (made?.id) setLabels(ls => (ls.some(l => String(l.id) === String(made.id)) ? ls : [...ls, made]));
      setError(null);
    } catch { setError('board_err_label'); }
    finally { addingNow.current = false; }
  }

  const boardPath = `/${encodeURIComponent(companyPrefix || '')}/${BOARD_ROUTE}`;
  const issueHref = i => caseHref(boardPath, i.id);
  const tags = r => r.labelIds.map(id => labelById[id]).filter(Boolean).map(l => h('span', { key: l.id, className: 'aiob-tag' }, h('span', { className: 'aiob-dot', style: { background: safeColor(l.color, NEW_LABEL_COLOR) }, 'aria-hidden': 'true' }), l.name));
  const card = r => h('div', {
    key: r.id, className: 'aiob-card', 'data-board-card': r.id, 'aria-busy': busyId === r.id ? 'true' : undefined,
    draggable: !narrow, onDragStart: e => { e.dataTransfer.setData('text/plain', r.id); e.dataTransfer.effectAllowed = 'move'; },
  },
    h(Link, { className: 'aiob-title', href: issueHref(r.issue), onClick: goCase(r.id), draggable: false }, r.issue.title),
    h('div', { className: 'aiob-meta' }, ...tags(r), h('span', { className: 'aiob-muted' }, agentName(r.agentId)),
      narrow ? h('select', { className: 'aiob-move', 'aria-label': t('board_move'), value: r.column, disabled: !!busyId, onChange: e => move(r.id, e.target.value) },
        ...COLUMNS.filter(c => c === r.column || !moveRefusal(r.issue, c)).map(c => h('option', { key: c, value: c }, t(`board_col_${c}`)))) : null));

  const quickChips = [...QUICK_KEYS.map(k => h(Chip, { key: k, on: filter.quick.has(k), count: counts.quick[k], onClick: () => tog('quick', k) }, t(`board_quick_${k}`))),
    h(Chip, { key: 'routines', on: routines, 'data-board-routines': '1', onClick: () => setRoutines(v => !v) }, t('board_routines'))];
  const labelChips = labels.map(l => h(Chip, { key: l.id, on: filter.labels.has(String(l.id)), count: counts.labels[String(l.id)] || 0, color: l.color, onClick: () => tog('labels', String(l.id)) }, l.name));
  const agentChips = agentIds.map(id => h(Chip, { key: id || 'none', on: filter.agents.has(id), count: counts.agents[id] || 0, onClick: () => tog('agents', id) }, agentName(id)));
  const addChip = adding
    ? h('input', { className: 'aiob-input', autoFocus: true, maxLength: 60, placeholder: t('board_label_new'), 'aria-label': t('board_label_new'), 'data-board-newlabel': '1',
      onKeyDown: e => { if (e.key === 'Enter' && !e.nativeEvent?.isComposing && e.keyCode !== 229) addLabel(e.currentTarget.value); if (e.key === 'Escape') { addCancelled.current = true; setAdding(false); } }, onBlur: e => addLabel(e.currentTarget.value) })
    : h(Chip, { add: true, 'data-board-addlabel': '1', onClick: () => { addCancelled.current = false; setAdding(true); } }, t('board_label_add'));
  const viewSeg = h('div', { className: 'aiob-grow', role: 'group', 'aria-label': t('board_view') },
    h(Button, { kind: 'tab', small: true, pressed: view === 'desk', onClick: () => pickView('desk'), 'data-board-view': 'desk' }, t('board_view_desk')),
    h(Button, { kind: 'tab', small: true, pressed: view === 'kanban', onClick: () => pickView('kanban'), 'data-board-view': 'kanban' }, t('board_view_kanban')),
    h(Button, { kind: 'tab', small: true, pressed: view === 'list', onClick: () => pickView('list'), 'data-board-view': 'list' }, t('board_view_list')));
  const clear = active ? h(Chip, { add: true, onClick: () => setFilter(newFilter()) }, t('board_clear')) : null;
  const countText = h('span', { className: 'aiob-muted', 'data-board-count': String(rows.length) }, rows.length, t('board_count'), all.length, t('board_count_all'));

  let head;
  if (narrow) {
    const activeChips = [
      ...[...filter.quick].map(k => ['quick', k, t(`board_quick_${k}`)]),
      ...[...filter.labels].map(id => ['labels', id, labelById[id]?.name || id]),
      ...[...filter.agents].map(id => ['agents', id, agentName(id)]),
    ];
    head = h('div', null,
      h('div', { className: 'aiob-mtop' },
        h(Button, { kind: active ? 'primary' : 'secondary', small: true, onClick: () => setSheet(true), 'data-board-filter': '1' }, t('board_filter'), active ? h('span', { className: 'aiob-n' }, active) : null),
        h('span', { className: 'aiob-muted' }, rows.length, t('board_items')), viewSeg),
      activeChips.length ? h('div', { className: 'aiob-mact' }, ...activeChips.map(([k, v, name]) => h(Chip, { key: `${k}:${v}`, on: true, onClick: () => tog(k, v) }, name, h('span', { 'aria-hidden': 'true' }, t('board_x'))))) : null,
      sheet ? h('div', null,
        h('div', { className: 'aiob-shade', onClick: () => setSheet(false) }),
        h('div', { className: 'aiob-sheet', role: 'dialog', 'aria-label': t('board_filter') },
          h('div', { className: 'aiob-sheet-h' }, h('span', null, t('board_filter')), h(Button, { kind: 'primary', small: true, onClick: () => setSheet(false) }, rows.length, t('board_show'))),
          h('div', { className: 'aiob-sheet-g' }, h('div', { className: 'aiob-sheet-t' }, t('board_quick')), h('div', { className: 'aiob-sheet-c' }, ...quickChips)),
          h('div', { className: 'aiob-sheet-g' }, h('div', { className: 'aiob-sheet-t' }, t('board_labels')), h('div', { className: 'aiob-sheet-c' }, ...labelChips, addChip)),
          h('div', { className: 'aiob-sheet-g' }, h('div', { className: 'aiob-sheet-t' }, t('board_agents')), h('div', { className: 'aiob-sheet-c' }, ...agentChips)),
          clear)) : null);
  } else {
    head = h('div', null,
      h('div', { className: 'aiob-bar' }, h('span', { className: 'aiob-lbl' }, t('board_quick')), ...quickChips, viewSeg),
      h('div', { className: 'aiob-bar' }, h('span', { className: 'aiob-lbl' }, t('board_labels')), ...labelChips, addChip),
      h('div', { className: 'aiob-bar' }, h('span', { className: 'aiob-lbl' }, t('board_agents')), ...agentChips),
      h('div', { className: 'aiob-bar' }, countText, clear));
  }

  let body;
  if (issues === null) body = h('p', { className: 'aiob-muted' }, t('loading'));
  else if (view === 'desk') {
    body = h(DeskView, { api, t, rows, agents, hrefOf: issueHref, openCase: goCase, onChanged: () => load(true) });
  } else if (view === 'list') {
    body = h('table', { className: 'aiob-table', 'data-board-list': '1' },
      h('thead', null, h('tr', null, h('th', null, t('board_th_title')), h('th', null, t('board_th_status')), narrow ? null : h('th', null, t('board_labels')), narrow ? null : h('th', null, t('board_agents')))),
      h('tbody', null, ...COLUMNS.flatMap(c => cols[c]).slice(0, listAll ? undefined : LIST_FOLD).map(r => h('tr', { key: r.id },
        h('td', null, h(Link, { className: 'aiob-title', href: issueHref(r.issue), onClick: goCase(r.id) }, r.issue.title), narrow ? h('span', { className: 'aiob-muted' }, agentName(r.agentId)) : null),
        h('td', null, t(`board_col_${r.column}`)),
        narrow ? null : h('td', null, h('div', { className: 'aiob-meta' }, ...tags(r))),
        narrow ? null : h('td', null, agentName(r.agentId))))),
      !listAll && rows.length > LIST_FOLD ? h('tfoot', null, h('tr', null, h('td', { colSpan: narrow ? 2 : 4 }, h(Button, { kind: 'linkish', onClick: () => setListAll(true) }, t('board_more'), rows.length - LIST_FOLD)))) : null);
  } else if (narrow) { // 携帯: 列を 1 つずつ出す
    const shown = shownColumn(mcol, cols);
    body = h('div', null,
      h('div', { className: 'aiob-mcols' }, ...COLUMNS.map(c => h(Chip, { key: c, on: c === shown, count: cols[c].length, onClick: () => setMcol(c) }, t(`board_col_${c}`)))),
      cols[shown].length ? cols[shown].map(card) : h('p', { className: 'aiob-muted' }, t('board_empty')));
  } else {
    body = h('div', { className: 'aiob-cols', 'data-board-kanban': '1' }, ...COLUMNS.map(c => {
      const list = cols[c], lim = openCols.has(c) ? list.length : COLUMN_FOLD;
      const drop = {
        onDragOver: e => { e.preventDefault(); e.dataTransfer.dropEffect = 'move'; if (over !== c) setOver(c); },
        onDragLeave: e => { if (e.currentTarget.contains(e.relatedTarget)) return; setOver(o => (o === c ? null : o)); }, // 帯の中の子へ移っただけの時は消さない
        onDrop: e => { e.preventDefault(); setOver(null); move(e.dataTransfer.getData('text/plain'), c); },
      };
      const cls = `aiob-col${list.length ? '' : ' aiob-col-empty'}${over === c ? ' aiob-col-over' : ''}`;
      // 落とす操作は、列の箱でなく縦いっぱいの帯で受ける（長い列の下の方からでも、横の列の位置へ落とせる）。見た目の箱は件の分だけの高さのまま
      return h('div', { key: c, className: `aiob-lane${list.length ? '' : ' aiob-lane-empty'}${over === c ? ' aiob-lane-over' : ''}`, 'data-board-lane': c, ...drop }, h('section', { className: cls, 'data-board-col': c, 'aria-label': t(`board_col_${c}`) },
        h('div', { className: 'aiob-colh' }, h('span', null, t(`board_col_${c}`)), h('span', null, list.length)),
        ...list.slice(0, lim).map(card),
        list.length > lim ? h(Button, { kind: 'linkish', onClick: () => setOpenCols(s => new Set([...s, c])) }, t('board_more'), list.length - lim) : null));
    }));
  }

  if (caseId) return h('div', { className: 'aio aiob', 'data-board': 'case' }, h('style', null, OFFICE_CSS + BOARD_CSS + CASE_CSS),
    h(CasePage, { api, t, issueId: caseId, companyId, companyPrefix, agents, labels, backHref: boardPath, onBack: goCase(null), hrefOf: id => caseHref(boardPath, id), goCase }));
  return h('div', { className: 'aio aiob', 'data-board': '1' }, h('style', null, OFFICE_CSS + BOARD_CSS + CASE_CSS + DESK_CSS),
    h('div', { className: 'aiob-head' }, h('h1', null, t('board_title'))),
    head,
    loadError ? h('p', { className: 'aiob-err', role: 'alert', 'data-board-loaderr': '1' }, t(loadError)) : null,
    error ? h('p', { className: 'aiob-err', role: 'alert', 'data-board-err': '1' }, t(error), h(Button, { kind: 'linkish', onClick: () => setError(null) }, t('board_x'))) : null,
    body);
}

// 本体の横の一覧の入口
export function BoardSidebarLink({ context }) {
  const prefix = context?.companyPrefix || '';
  const [lang, setLang] = useState(() => browserLang(typeof navigator === 'undefined' ? null : navigator));
  useEffect(() => { let on = true; createApi().launcherState().then(s => { if (on && s?.lang) setLang(pickLang(s.lang)); }, () => {}); return () => { on = false; }; }, []);
  if (!prefix) return null;
  const t = translator(lang);
  return h('div', { className: 'aio', 'data-board-sidebar': '1' }, h('style', null, OFFICE_CSS),
    h(Link, { kind: 'nav', href: `/${encodeURIComponent(prefix)}/${BOARD_ROUTE}`, 'data-board-nav': '1' },
      h('span', { 'aria-hidden': 'true', style: { display: 'inline-block', width: 10, height: 10, borderRadius: 3, border: '2px solid var(--aio-accent)' } }), t('sidebar_board')));
}
