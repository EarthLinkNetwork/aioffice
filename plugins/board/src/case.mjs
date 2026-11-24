// 件のページ（タスクボードの札を押した先・/:会社の prefix/board?case=<課題の id>）。上に件の中身、下にその件の担当との会話。
// 設計: docs/design/2026-11-24-secretary-conversation-kanban.md §4.1。モック: docs/mocks/secretary-board.html の「件のページ」
// 会話は課題のコメント（開いている人の名義で書く）。担当の書いた文は文字のまま出す（HTML・markdown として解釈しない）
import { createElement as h, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { DICT } from '../../office/src/i18n.mjs';
import { Button, Link } from '../../office/src/controls.mjs';
import { columnOf, findRejectLabel, safeColor } from './board-lib.mjs';
import { SECTIONS, headingTable, pickCase, chatItems, checkSay, hideJson, goPatch, goDone } from './case-lib.mjs';

const REFRESH_MS = 15000;
const TABLE = headingTable(DICT);
const REJECT_NAMES = [DICT.en.board_label_returned, DICT.ja.board_label_returned];
const TAG_COLOR = '#5c574f';

export const CASE_CSS = `
.aioc { max-width: 780px; }
.aioc h1 { font-size: 19px; line-height: 1.4; margin: 0; overflow-wrap: anywhere; }
.aioc-top { display: flex; justify-content: space-between; gap: 12px; align-items: flex-start; margin: 12px 0 6px; }
.aioc-st { font-size: 12px; padding: 2px 10px; border-radius: 99px; border: 1px solid var(--aio-line); white-space: nowrap; }
.aioc-box { background: var(--aio-card); border: 1px solid var(--aio-line); border-radius: 12px; padding: 4px 16px; margin: 14px 0; }
.aioc-row { display: grid; grid-template-columns: 8em 1fr; gap: 12px; padding: 10px 0; border-top: 1px solid var(--aio-line); }
.aioc-row:first-child { border-top: 0; }
.aioc-k { color: var(--aio-muted); font-size: 12.5px; padding-top: 2px; }
.aioc-v { white-space: pre-wrap; overflow-wrap: anywhere; }
.aioc-row-ask .aioc-v, .aioc-row-rec .aioc-v { font-weight: 600; }
.aioc-h2 { font-size: 13px; color: var(--aio-muted); font-weight: 600; margin: 24px 0 8px; }
.aioc-bub { background: var(--aio-card); border: 1px solid var(--aio-line); border-radius: 12px; padding: 8px 12px; margin: 8px 0; width: fit-content; max-width: 88%; white-space: pre-wrap; overflow-wrap: anywhere; }
.aioc-bub-me { margin-left: auto; background: var(--aio-accent); color: var(--aio-accent-fg); border-color: var(--aio-accent); }
.aioc-who { display: block; font-size: 11.5px; opacity: .75; }
.aioc-form { display: flex; gap: 8px; margin-top: 12px; align-items: flex-end; }
.aioc-form textarea { flex: 1; min-width: 0; min-height: 44px; padding: 10px 12px; border: 1px solid var(--aio-line); border-radius: 10px; background: var(--aio-card); color: var(--aio-fg); font: inherit; resize: vertical; }
.aioc-acts { display: flex; gap: 8px; flex-wrap: wrap; margin: 4px 0 12px; }
@media (max-width: 640px) { .aioc-row { grid-template-columns: 1fr; gap: 2px; } }
`;

export function CasePage({ api, t, issueId, companyPrefix, agents, labels, backHref, onBack }) {
  const [issue, setIssue] = useState(null);
  const [comments, setComments] = useState([]);
  const [loadError, setLoadError] = useState(false);
  const [error, setError] = useState(null);
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const seq = useRef(0), sending = useRef(false);
  const [myId, setMyId] = useState('');
  useEffect(() => { let on = true; api.me().then(s => { if (on) setMyId(String(s?.user?.id || '')); }, () => {}); return () => { on = false; }; }, [api]);
  const load = useCallback(async () => {
    const my = ++seq.current;
    try {
      const [i, cs] = await Promise.all([api.issue(issueId), api.comments(issueId)]);
      if (my !== seq.current) return;
      if (!i || String(i.id) !== String(issueId)) { setLoadError(true); return; }
      setIssue(i); setComments(Array.isArray(cs) ? cs : cs?.items || []); setLoadError(false);
    } catch { if (my === seq.current) setLoadError(true); }
  }, [api, issueId]);
  useEffect(() => { setIssue(null); setComments([]); setError(null); setText(''); load(); const id = setInterval(load, REFRESH_MS); return () => { seq.current++; clearInterval(id); }; }, [load]);

  const reject = useMemo(() => findRejectLabel(labels, REJECT_NAMES), [labels]);
  const kase = useMemo(() => (issue ? pickCase(issue, comments, TABLE) : null), [issue, comments]);
  // 件の中身に使ったコメントも会話にそのまま出す（節に拾わなかった文を隠さない）
  const chat = useMemo(() => chatItems(comments, myId), [comments, myId]);
  const agentName = id => (agents || []).find(a => String(a.id) === String(id))?.name || t('case_agent');

  async function send() {
    const c = checkSay(text);
    if (!c.ok) { if (c.why === 'long') setError('case_err_long'); return; }
    if (sending.current) return; // 連打・Cmd+Enter の重ね打ちで 2 回送らない
    sending.current = true; setBusy(true); setError(null);
    // 送っている間に打ち足した文は消さない
    try { await api.addComment(issueId, c.body); setText(cur => (cur.trim() === c.body ? '' : cur)); await load(); }
    catch { setError('case_err_send'); }
    finally { sending.current = false; setBusy(false); }
  }
  // 推奨で進める: 持ち主の一言と未着手に戻す更新を 1 回で送る（別々に送ると担当が 2 回起きる）
  async function go() {
    if (sending.current) return;
    sending.current = true; setBusy(true); setError(null);
    try { if (!goDone(await api.patchIssue(issueId, goPatch(t('case_go_comment'))))) throw new Error('not moved'); await load(); }
    catch { setError('case_err_go'); }
    finally { sending.current = false; setBusy(false); }
  }

  const back = h(Link, { href: backHref, onClick: onBack, 'data-case-back': '1' }, t('case_back'));
  if (loadError && !issue) return h('div', { className: 'aioc', 'data-case': issueId }, back, h('p', { className: 'aiob-err', role: 'alert' }, t('case_err_load')));
  if (!issue) return h('div', { className: 'aioc', 'data-case': issueId }, back, h('p', { className: 'aiob-muted' }, t('loading')));

  const col = columnOf(issue, { rejectLabelId: reject?.id }) || (issue.status === 'cancelled' ? 'cancelled' : 'done');
  const owner = issue.assigneeAgentId ? agentName(issue.assigneeAgentId) : t('board_no_agent');
  const tagIds = (issue.labelIds?.length ? issue.labelIds : (issue.labels || []).map(l => l.id)).map(String);
  const tags = tagIds.map(id => (labels || []).find(l => String(l.id) === id)).filter(Boolean);
  const row = (k, v) => h('div', { key: k, className: `aioc-row aioc-row-${k}` }, h('div', { className: 'aioc-k' }, t(`case_h_${k}`)), h('div', { className: 'aioc-v' }, v));
  const hostHref = `/${encodeURIComponent(companyPrefix || '')}/issues/${encodeURIComponent(issue.identifier || issue.id)}`;

  return h('div', { className: 'aioc', 'data-case': issueId },
    back,
    h('div', { className: 'aioc-top' }, h('h1', null, issue.title), h('span', { className: 'aioc-st', 'data-case-status': col }, col === 'cancelled' ? t('case_st_cancelled') : t(`board_col_${col}`))),
    h('div', { className: 'aiob-meta' }, h('span', { className: 'aiob-muted' }, t('board_agents'), ' ', owner),
      ...tags.map(l => h('span', { key: l.id, className: 'aiob-tag' }, h('span', { className: 'aiob-dot', style: { background: safeColor(l.color, TAG_COLOR) }, 'aria-hidden': 'true' }), l.name)),
      h(Link, { href: hostHref, className: 'aiob-muted' }, t('case_open_host'))),
    kase
      ? h('div', { className: 'aioc-box', 'data-case-shape': kase.from }, ...SECTIONS.filter(k => kase[k]).map(k => row(k, kase[k])),
        // 課題の本文から作った件は、節に拾わなかった文を隠さないよう、本文の全文も下に出す
        kase.from === 'description' && issue.description ? h('div', { key: 'body', className: 'aioc-row' }, h('div', { className: 'aioc-k' }, t('case_body')), h('div', { className: 'aioc-v' }, issue.description)) : null)
      : h('div', null, h('p', { className: 'aiob-muted' }, t('case_no_shape')),
        issue.description ? h('div', { className: 'aioc-box' }, h('div', { className: 'aioc-row' }, h('div', { className: 'aioc-k' }, t('case_body')), h('div', { className: 'aioc-v' }, issue.description))) : null),
    kase?.rec && col === 'review' ? h('div', { className: 'aioc-acts' }, h(Button, { kind: 'primary', busy, onClick: go, 'data-case-go': '1' }, t('case_go'))) : null,
    h('div', { className: 'aioc-h2' }, t('case_chat'), owner),
    h('div', { 'data-case-chat': String(chat.length) },
      chat.length ? chat.map(m => h('div', { key: m.id, className: `aioc-bub${m.who === 'me' ? ' aioc-bub-me' : ''}`, 'data-case-who': m.who },
        h('span', { className: 'aioc-who' }, m.who === 'agent' ? agentName(m.agentId) : m.who === 'me' ? t('case_you') : t('case_person')), hideJson(m.body) || m.body))
        : h('p', { className: 'aiob-muted' }, t('case_chat_none'))),
    error ? h('p', { className: 'aiob-err', role: 'alert', 'data-case-err': '1' }, t(error)) : null,
    h('div', { className: 'aioc-form' },
      h('textarea', { value: text, rows: 2, placeholder: t('case_say'), 'aria-label': t('case_say'), 'data-case-say': '1', onChange: e => setText(e.target.value),
        onKeyDown: e => { if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) send(); } }),
      h(Button, { kind: 'primary', busy, disabled: !text.trim(), onClick: send, 'data-case-send': '1' }, t('case_send'))),
    h('p', { className: 'aiob-muted' }, t('case_note')));
}
