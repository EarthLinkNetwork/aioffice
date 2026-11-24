// 秘書の画面（タスクボードの「秘書」の表示）。上に「いま決めてほしい件」を件カードで、下に「進めている件」を 1 行ずつ出す。
// 設計: docs/design/2026-11-24-secretary-conversation-kanban.md §4.1・§4.2。モック: docs/mocks/secretary-board.html の「秘書」
// 件カードは 件の名前 → 概要 → 決めてほしい事 → 私なら → なぜなら → ボタン。どの件も課題で、札を押すと件のページ（担当との会話）が開く
import { createElement as h, useEffect, useMemo, useRef, useState } from 'react';
import { DICT } from '../../office/src/i18n.mjs';
import { Button, Link } from '../../office/src/controls.mjs';
import { headingTable, pickCase, excerptOf, proposalsOf, doComment, deskSplit, laterAfter, DESK_STEP, goPatch, goDone, isOpenAsk, canDrop, dropPatch, dropDone } from './case-lib.mjs';

const TABLE = headingTable(DICT);
const LATER_KEY = 'aioffice.board.later';
const CARD_ROWS = ['summary', 'ask', 'rec', 'why'];
const readLater = () => { try { return laterAfter(JSON.parse(globalThis.localStorage?.getItem(LATER_KEY) || '{}')); } catch { return {}; } };
const writeLater = v => { try { globalThis.localStorage?.setItem(LATER_KEY, JSON.stringify(v)); } catch { /* 覚えられなくても動く */ } };

export const DESK_CSS = `
.aiod-h { font-size: 13px; color: var(--aio-muted); font-weight: 600; margin: 22px 0 10px; }
.aiod-card { background: var(--aio-card); border: 1px solid var(--aio-line); border-radius: 14px; padding: 14px 16px; margin: 0 0 16px; max-width: 780px; }
.aiod-top { display: flex; justify-content: space-between; gap: 12px; align-items: flex-start; }
.aiod-title { font-size: 16px; font-weight: 700; line-height: 1.45; overflow-wrap: anywhere; }
.aiod-card .aioc-box { border: 0; padding: 0; margin: 10px 0 4px; background: transparent; }
.aiod-acts { display: flex; gap: 14px; flex-wrap: wrap; align-items: center; margin-top: 12px; }
.aiod-acts .aio-btn { padding-top: 6px; padding-bottom: 6px; }
.aiod-prop { border-top: 1px solid var(--aio-line); padding: 12px 0; display: grid; gap: 6px; justify-items: start; }
.aiod-prop:first-child { border-top: 0; }
.aiod-prop-t { font-weight: 700; overflow-wrap: anywhere; }
.aiod-prop-e { font-size: 12.5px; overflow-wrap: anywhere; }
.aiod-line { display: flex; gap: 10px; align-items: baseline; padding: 7px 0; border-top: 1px solid var(--aio-line); max-width: 780px; }
.aiod-line:first-of-type { border-top: 0; }
`;

export function DeskView({ api, t, rows, agents, hrefOf, openCase, onChanged }) {
  const [later, setLater] = useState(readLater);
  const [shown, setShown] = useState(DESK_STEP);
  const [cases, setCases] = useState({});   // 課題の id → { kase（件の中身・無ければ null）, at（読んだ時の課題の更新時刻） }
  const [busyId, setBusyId] = useState(null);
  const [errId, setErrId] = useState(null);
  const [dropId, setDropId] = useState(null); // 「取り下げる」を 1 回押した件（もう 1 回押すと取り下げる）
  const [dropErr, setDropErr] = useState(null);
  const gone = useRef(new Set()); // 取り下げが通った件（一覧の読み直しが効かなかった時に、同じ件をもう一度取り下げさせない）
  const reading = useRef(new Set());
  const split = useMemo(() => deskSplit(rows, later), [rows, later]);
  const visible = split.decide.slice(0, shown);
  // 「止まっている」の件のうち、担当が件の形で書いた物（持ち主の番）だけを足す
  const heldShown = split.held.filter(r => cases[r.id]?.open);
  const heldReading = split.held.some(r => !cases[r.id]);
  const toRead = [...visible, ...split.held];
  const agentName = id => (agents || []).find(a => String(a.id) === String(id))?.name || t('board_no_agent');

  // 見えている件だけ、コメントを読んで件の中身を取り出す。課題が更新されたら読み直す。
  // 読みの結果は、途中で一覧が変わっても捨てない（捨てると、読み中の印だけが残って「読み込み中」のままになる）
  const mounted = useRef(true);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  useEffect(() => {
    for (const r of toRead) {
      const at = String(r.issue.updatedAt || '');
      if (cases[r.id]?.at === at || reading.current.has(r.id)) continue;
      reading.current.add(r.id);
      const put = (cs, okAt, failed = false) => { reading.current.delete(r.id); if (mounted.current) setCases(m => ({ ...m, [r.id]: (k => ({ kase: k, open: isOpenAsk(k, cs), props: proposalsOf(r.issue, cs), text: excerptOf(r.issue, cs), at: okAt, failed }))(pickCase(r.issue, cs, TABLE)) })); };
      // 読めなかった時は本文だけで出し、次に一覧が変わった時にまた読む（at を覚えない）
      api.comments(r.id).then(cs => put(Array.isArray(cs) ? cs : cs?.items || [], at), () => put([], null, true));
    }
  }, [api, toRead.map(r => `${r.id}@${r.issue.updatedAt}`).join('|')]);

  const snooze = id => { setDropId(null); const v = laterAfter(later, id); setLater(v); writeLater(v); };
  const unsnooze = () => { setLater({}); writeLater({}); };
  // 推奨で進める: 持ち主の一言と未着手に戻す更新を 1 回で送る（件のページの同じボタンと同じ動き）
  async function go(r, body = t('case_go_comment'), key = r.id) {
    if (busyId) return;
    setBusyId(key); setErrId(null); setDropId(null);
    try { if (!goDone(await api.patchIssue(r.id, goPatch(body)))) throw new Error('not moved'); await onChanged?.(); }
    catch { setErrId(r.id); }
    finally { setBusyId(null); }
  }

  // 取り下げる: 取り消しと持ち主の一言を 1 回の更新で送る。
  // 取り消した後に別でコメントを書くと、本体が「閉じた件への人のコメント」として件を未着手に戻し、担当を起こす
  async function drop(r) {
    if (busyId) return;
    setBusyId(`drop:${r.id}`); setDropErr(null);
    try { if (!dropDone(await api.patchIssue(r.id, dropPatch(t('desk_drop_comment'))))) throw new Error('not cancelled'); gone.current.add(r.id); setDropId(null); await onChanged?.(); }
    catch { setDropErr(r.id); }
    finally { setBusyId(null); }
  }

  const row = (k, v) => h('div', { key: k, className: `aioc-row aioc-row-${k}` }, h('div', { className: 'aioc-k' }, t(`case_h_${k}`)), h('div', { className: 'aioc-v' }, v));
  const card = r => {
    const c = cases[r.id], kase = c?.kase;
    return h('article', { key: r.id, className: 'aiod-card', 'data-desk-card': r.id },
      h('div', { className: 'aiod-top' },
        h(Link, { className: 'aiod-title aiob-title', href: hrefOf(r.issue), onClick: openCase(r.id) }, r.issue.title),
        h('span', { className: 'aioc-st' }, t(r.column === 'blocked' ? 'board_col_blocked' : 'board_col_review'))),
      h('div', { className: 'aiob-meta' }, h('span', { className: 'aiob-muted' }, t('board_agents'), ' ', r.agentId ? agentName(r.agentId) : t('board_no_agent'))),
      !c ? h('p', { className: 'aiob-muted' }, t('loading'))
        // 秘書の見回りの提案は、1 つずつ（題 → 中身 → 根拠 → これを進める）で出す
        : c.props ? h('div', { 'data-desk-shape': 'proposals' }, ...c.props.map((x, i) => h('div', { key: i, className: 'aiod-prop', 'data-desk-prop': `${r.id}:${i + 1}` },
          h('div', { className: 'aiod-prop-t' }, `${i + 1}. ${x.title}`),
          // 決めてほしい事のある提案は、件カードの形（概要 → 決めてほしい事 → 私なら → なぜなら）で出す。古い形の提案は中身だけ
          (x.ask || x.recommend || x.why) ? h('div', { className: 'aioc-box', style: { width: '100%' } }, ...[['summary', x.detail], ['ask', x.ask], ['rec', x.recommend], ['why', x.why]].filter(([, v]) => v).map(([k, v]) => row(k, v)))
            : x.detail ? h('div', { className: 'aioc-v' }, x.detail) : null,
          x.evidence.length ? h('div', { className: 'aiob-muted aiod-prop-e' }, t('case_h_evidence'), ': ', x.evidence.join(' / ')) : null,
          // 決めてほしい事だけで推奨の無い提案は、進めるボタンを出さない（何を進めるかが決まっていない。開いて話す）
          x.ask && !x.recommend ? null : h(Button, { kind: 'tab', small: true, busy: busyId === `${r.id}:${i + 1}`, disabled: !!busyId, onClick: () => go(r, doComment(t('desk_do_comment'), i + 1, x.title), `${r.id}:${i + 1}`), 'data-desk-do': `${r.id}:${i + 1}` }, x.recommend ? t('case_go') : t('desk_do')))))
        : kase ? h('div', { className: 'aioc-box', 'data-desk-shape': kase.from }, ...CARD_ROWS.filter(k => kase[k]).map(k => row(k, kase[k])))
          : c.text ? h('div', { className: 'aioc-box', 'data-desk-shape': 'text' }, row('summary', c.text))
            : h('p', { className: 'aiob-muted', 'data-desk-shape': 'none' }, t('case_no_shape')),
      errId === r.id ? h('p', { className: 'aiob-err', role: 'alert' }, t('case_err_go')) : null,
      dropErr === r.id ? h('p', { className: 'aiob-err', role: 'alert' }, t('desk_err_drop')) : null,
      h('div', { className: 'aiod-acts' },
        kase?.rec ? h(Button, { kind: 'primary', busy: busyId === r.id, disabled: !!busyId, onClick: () => go(r), 'data-desk-go': r.id }, t('case_go')) : null,
        h(Link, { kind: kase?.rec ? 'link' : 'button', href: hrefOf(r.issue), onClick: openCase(r.id), 'data-desk-open': r.id }, t('desk_open')),
        h(Button, { kind: 'linkish', onClick: () => snooze(r.id), 'data-desk-later': r.id }, t('desk_later')),
        // 取り下げは 2 回押す（1 回の押し間違いで件を消さない）。2 回目のボタンは 1 回目と別の位置に出す（ダブルクリックで通さない）
        !canDrop(r, c) || gone.current.has(r.id) ? null : dropId === r.id
          ? [h(Button, { key: 'n', kind: 'linkish', disabled: !!busyId, onClick: () => setDropId(null), 'data-desk-drop-no': r.id }, t('desk_drop_no')),
            h(Button, { key: 'y', kind: 'secondary', busy: busyId === `drop:${r.id}`, disabled: !!busyId, onClick: () => drop(r), 'data-desk-drop-yes': r.id }, t('desk_drop_yes'))]
          : h(Button, { kind: 'linkish', disabled: !!busyId, onClick: () => { setDropId(r.id); setDropErr(null); }, 'data-desk-drop': r.id }, t('desk_drop'))));
  };

  const nDecide = split.decide.length + heldShown.length;
  return h('div', { 'data-board-desk': String(nDecide), 'data-desk-reading': heldReading ? '1' : '0' },
    h('div', { className: 'aiod-h' }, t('desk_decide'), ' ', nDecide),
    nDecide ? [...visible, ...heldShown].map(card) : h('p', { className: 'aiob-muted' }, t(heldReading ? 'loading' : 'desk_none')),
    split.decide.length > shown ? h(Button, { kind: 'linkish', onClick: () => setShown(n => n + DESK_STEP) }, t('board_more'), split.decide.length - shown) : null,
    split.later.length ? h('p', { className: 'aiob-muted', 'data-desk-later-count': String(split.later.length) }, t('desk_later_n'), split.later.length, ' ', h(Button, { kind: 'linkish', onClick: unsnooze }, t('desk_later_undo'))) : null,
    h('div', { className: 'aiod-h' }, t('desk_going'), ' ', split.going.length),
    split.going.length ? split.going.slice(0, 30).map(r => h('div', { key: r.id, className: 'aiod-line', 'data-desk-going': r.id },
      h(Link, { className: 'aiob-title', href: hrefOf(r.issue), onClick: openCase(r.id) }, r.issue.title),
      h('span', { className: 'aiob-muted' }, r.agentId ? agentName(r.agentId) : t('board_no_agent'))))
      : h('p', { className: 'aiob-muted' }, t('desk_going_none')));
}
