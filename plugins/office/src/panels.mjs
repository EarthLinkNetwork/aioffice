// office の画面の欄（担当の一覧・部屋の説明・受信箱・仕事の掲示・課題・記録・担当の仕事・AI の契約のつなぎ・デザインの依頼）。
// 画面に出す文字は辞書の key（t）からだけ引く。AI の書いた文は RichText で text としてだけ出す（innerHTML を使わない・範囲の保証 4）
import { createElement as h, useEffect, useRef, useState } from 'react';
import { ABOUT } from './i18n.mjs';
import { safeHref, decidableHere, statusKey, inboxNotices, semanticDown, askRunner, folderToLibrary, limitGroup, resumeLimitGroup, usageRows, limitsBody, limitsForm, LIMIT_SPEND_MODES } from './api.mjs';
import { Button, Link, Status } from './controls.mjs';

export { Button, Link } from './controls.mjs';

const URL_RE = /(https?:\/\/[^\s<>"')\]]+)/g;
// 色は CSS の変数（controls.mjs の OFFICE_CSS の --aio-*）を先に使い、直書きは fallback だけ
const S = {
  panel: { position: 'absolute', right: 12, top: 12, bottom: 12, width: 'min(460px, calc(100% - 24px))', overflow: 'auto', background: 'var(--aio-card, #fffdf8)', color: 'var(--aio-fg, #2d241a)', border: '1px solid var(--aio-line, rgba(0,0,0,.15))', borderRadius: 12, padding: '18px 20px', boxShadow: '0 10px 32px rgba(0,0,0,.22)', font: '14px/1.6 system-ui, sans-serif', zIndex: 5 },
  head: { display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 8, margin: '0 0 12px', paddingBottom: 10, borderBottom: '1px solid var(--aio-line, rgba(0,0,0,.12))' },
  h2: { margin: 0, fontSize: 18 }, h3: { margin: '16px 0 6px', fontSize: 14 },
  item: { border: '1px solid var(--aio-line, rgba(0,0,0,.12))', borderRadius: 10, padding: 12, margin: '10px 0' },
  muted: { color: 'var(--aio-muted, #5c574f)', fontSize: 12 }, err: { color: 'var(--aio-err, #b3261e)' }, ok: { color: 'var(--aio-ok, #1b6e2d)', fontWeight: 600 },
  input: { width: '100%', boxSizing: 'border-box', padding: '7px 10px', borderRadius: 8, border: '1px solid var(--aio-line, rgba(0,0,0,.25))', font: 'inherit', background: 'transparent', color: 'inherit' },
  row: { display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center', marginTop: 8 },
};
const DOT = { running: '#2e7d32', idle: '#9e9e9e', paused: '#f9a825', error: '#c62828', other: '#607d8b' };

// AI の書いた文: text のまま・http(s) の URL だけ link（新しいタブ・↗）
export function RichText({ text, max = 4000 }) {
  const s = String(text ?? '').slice(0, max);
  const parts = s.split(URL_RE).map((p, i) => { if (i % 2 === 0) return p; return safeHref(p) ? h(Link, { key: i, href: p, external: true }, p) : p; });
  return h('div', { style: { whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' } }, ...parts);
}

// 欄の枠。「× 閉じる」でオフィスに戻ることが分かる形にする（範囲 2026-11-18 G4）
export function Panel({ title, t, onClose, children, id }) {
  return h('section', { style: S.panel, role: 'dialog', 'aria-label': title, 'data-panel': id },
    h('div', { style: S.head }, h('h2', { style: S.h2 }, title), h(Button, { small: true, onClick: onClose, 'data-close': '1', title: t('close_hint'), 'aria-label': t('close_hint') }, t('close'))),
    children);
}

const When = ({ at }) => (at ? h('span', { style: S.muted }, new Date(at).toLocaleString()) : null);
const Loading = ({ t, q }) => (q?.error ? h('p', { style: S.err }, t('error_load')) : h('p', { style: S.muted }, t('loading')));

export function PeopleList({ agents, t, onPick, selected = null }) {
  return h('nav', { 'aria-label': t('people_title'), 'data-people': '1', style: { font: '13px/1.4 system-ui, sans-serif' } },
    h('h3', { style: { ...S.h3, marginTop: 0 } }, t('people_title')),
    !agents?.length ? h('p', { style: S.muted }, t('people_none'))
      : h('ul', { style: { listStyle: 'none', margin: 0, padding: 0 } }, ...agents.map(a => {
        const k = statusKey(a.status);
        return h('li', { key: a.id, 'data-agent': a.id, 'data-status': k },
          h(Button, { kind: 'ghost', style: { width: '100%' }, pressed: selected === a.id, onClick: () => onPick(a.id) },
            h('span', { 'aria-hidden': 'true', style: { display: 'inline-block', width: 9, height: 9, borderRadius: 5, background: DOT[k], flex: 'none' } }),
            h('span', null, a.name, ' ', h('span', { style: S.muted }, t(`status_${k}`)))));
      })));
}

export function AboutPanel({ room, t, onClose, children }) {
  const [title, items] = ABOUT[room];
  return h(Panel, { title: t(title), t, onClose, id: `about-${room}` },
    h('ul', { 'data-about': room, style: { paddingLeft: 18 } }, ...items.map(k => h('li', { key: k }, t(k)))), children);
}

// 受信箱: 承認（承認する・断る・一言）と判断（選択肢から 1 つ・入力欄のある物は本体の判断の画面へ）
// AI の上限（範囲 docs/review/2026-11-18-ai-usage-limit-scope.md G6・G7b・G9a・7 の 7）:
// - 止めた担当の知らせ（agent_paused_limit）は読んでも消えず、一番上に出す。notify の記録がある担当には「再開」（まとめて止めた担当を全員・本体の resume → notify の /limit/resume）
// - 予算が未設定（budget_unset）には本体の予算の画面へのつながり
// - 追加料金の減り（ai_credits_spent）の前と今の残りは notify が題に入れる（「$前 → $今」）
const STAYS = n => n.kind === 'agent_paused_limit';
// slack: 「Slack に届ける」の欄（知らせの欄の上に置く・plugins/office/src/slack.mjs）
export function InboxPanel({ api, t, approvals, decisions, notices = { data: null }, limits = null, companyId, prefix, reload, onClose, connectors = null, slack = null, mail = null }) {
  const [done, setDone] = useState({}), [note, setNote] = useState({}), [err, setErr] = useState({}), [kept, setKept] = useState({});
  const [resumeRes, setResumeRes] = useState(null);
  // 再開: 押した直後から処理中（Button が Promise の間）。結果の文は知らせが消えても欄の上に残す
  const resume = async ids => {
    setResumeRes(null);
    try {
      const r = await resumeLimitGroup({ api, companyId, agentIds: ids, limits });
      setResumeRes(r.failed.length ? { tone: 'err', key: 'limit_resume_failed', n: r.failed.length } : r.stillPaused.length ? { tone: 'err', key: 'limit_resume_still', n: r.stillPaused.length } : r.changed.length ? { tone: 'err', key: 'limit_resume_changed', n: r.changed.length } : { tone: 'ok', key: 'limit_resumed', n: r.resumed.length });
    } catch { setResumeRes({ tone: 'err', key: 'limit_resume_failed', n: ids.length }); }
    reload();
  };
  // 押した件は読み直しで「保留中」の一覧から消えるので、欄を閉じるまで結果つきで残す
  const act = async (key, fn, label, item) => {
    setKept(k => ({ ...k, [key]: item }));
    setErr(e => ({ ...e, [key]: null }));
    try { await fn(); setDone(d => ({ ...d, [key]: label })); }
    catch (e) { if (e.status === 409) setDone(d => ({ ...d, [key]: 'decided_done' })); else setErr(x => ({ ...x, [key]: t('error_load') })); }
    reload();
  };
  const keep = (list, kind) => { const ids = new Set(list.map(x => x.id)); return [...list, ...Object.entries(kept).filter(([k, x]) => k.startsWith(kind) && done[k] && !ids.has(x.id)).map(([, x]) => x)]; };
  const ap = keep(approvals.data || [], 'a:'), de = keep(decisions.data || [], 'd:');
  return h(Panel, { title: t('inbox_title'), t, onClose, id: 'inbox' },
    (!approvals.data && !decisions.data) ? h(Loading, { t, q: approvals.error ? approvals : decisions })
      : (!ap.length && !de.length && !Object.keys(done).length && !inboxNotices(notices.data).some(n => !n.readAt || STAYS(n))) ? h('p', { 'data-inbox-empty': '1' }, t('inbox_empty')) : null,
    resumeRes ? h('p', { className: 'aio-result', 'data-tone': resumeRes.tone, role: 'status', 'data-limit-resume-result': resumeRes.key }, t(resumeRes.key).replace('{n}', String(resumeRes.n))) : null,
    ap.length ? h('h3', { style: S.h3 }, t('inbox_approvals')) : null,
    ...ap.map(a => {
      const k = `a:${a.id}`;
      return h('div', { key: a.id, style: S.item, 'data-approval': a.id },
        h('strong', null, h(RichText, { text: a.payload?.title || a.type, max: 300 })),
        a.payload?.summary ? h(RichText, { text: a.payload.summary }) : null,
        h('div', { style: S.muted }, `${t('approval_type')}: `, a.type, ' · ', h(When, { at: a.createdAt })),
        done[k] ? h('p', { style: S.ok, 'data-done': done[k] }, t(done[k])) : h('div', null,
          h('input', { style: { ...S.input, marginTop: 6 }, placeholder: t('note_placeholder'), value: note[k] || '', onChange: e => setNote(n => ({ ...n, [k]: e.target.value })), 'data-note': a.id }),
          h('div', { style: S.row },
            h(Button, { kind: 'primary', busyText: t('busy'), 'data-approve': a.id, onClick: () => act(k, () => api.approve(a.id, note[k]), 'decided_approved', a) }, t('approve')),
            h(Button, { busyText: t('busy'), 'data-reject': a.id, onClick: () => act(k, () => api.reject(a.id, note[k]), 'decided_rejected', a) }, t('reject')))),
        err[k] ? h('p', { style: S.err }, err[k]) : null);
    }),
    de.length ? h('h3', { style: S.h3 }, t('inbox_decisions')) : null,
    ...de.map(d => {
      const k = `d:${d.id}`;
      return h('div', { key: d.id, style: S.item, 'data-decision': d.id },
        h('strong', null, h(RichText, { text: d.title, max: 300 })),
        d.body ? h(RichText, { text: d.body }) : null,
        h(When, { at: d.createdAt }),
        done[k] ? h('p', { style: S.ok, 'data-done': done[k] }, t(done[k]))
          : decidableHere(d) ? h('div', { style: S.row }, ...(d.options || []).map(o => h(Button, { key: o.id, busyText: t('busy'), 'data-option': o.id, onClick: () => act(k, () => api.decide(d.id, o.id), 'decided_done', d) }, h(RichText, { text: o.label, max: 120 }))))
            : h('p', null, t('decision_inputs'), ' ', prefix ? h(Link, { href: `/${encodeURIComponent(prefix)}/decisions` }, t('open_full')) : null),
        err[k] ? h('p', { style: S.err }, err[k]) : null);
    }),
    connectors, // AI の連携（個人向けの基本の道）を会社向けの道（Slack・メール）の上に置く（裁定 L1295655c）
    slack,
    mail,
    // 知らせ（知らせの plugin・未読を先に）。読みましたで既読にする
    inboxNotices(notices.data).length ? h('h3', { style: S.h3 }, t('inbox_notices')) : null,
    // 並び: 止めた担当（読んでも消えない）→ 未読 → 既読
    ...[...inboxNotices(notices.data)].sort((a, b) => (STAYS(a) ? 0 : a.readAt ? 2 : 1) - (STAYS(b) ? 0 : b.readAt ? 2 : 1)).map(n => {
      const k = `n:${n.key}`;
      const group = STAYS(n) ? limitGroup(limits, n.originId) : null;
      return h('div', { key: n.key, style: { ...S.item, opacity: n.readAt && !STAYS(n) ? 0.6 : 1, ...(STAYS(n) ? { borderColor: 'var(--aio-err, #b3261e)' } : {}) }, 'data-notice': n.kind, 'data-notice-key': n.key },
        h('strong', null, h(RichText, { text: n.title, max: 200 })), ' ', h(When, { at: n.createdAt }),
        n.body ? h('div', { style: S.muted, 'data-notice-body': '1' }, h(RichText, { text: n.body, max: 2000 })) : null,
        group ? h('div', { style: S.row },
          h(Button, { kind: 'primary', small: true, busyText: t('busy'), 'data-limit-resume': n.originId, 'data-limit-group': group.length, onClick: () => resume(group) }, t('limit_resume').replace('{n}', String(group.length))),
          h('span', { style: S.muted }, t('limit_resume_help'))) : null,
        n.kind === 'budget_unset' && prefix ? h('p', { style: { margin: '6px 0 0' } }, h(Link, { href: `/${encodeURIComponent(prefix)}/budgets`, 'data-budget-link': '1' }, t('budget_open'))) : null,
        n.readAt || done[k] ? h('p', { style: S.muted, 'data-notice-read': '1' }, t('notice_read_done'))
          : h('div', { style: S.row }, h(Button, { small: true, busyText: t('busy'), 'data-read': n.key, onClick: () => act(k, () => api.noticeRead(companyId, n.key), 'notice_read_done', n) }, t('notice_read'))),
        err[k] ? h('p', { style: S.err }, err[k]) : null);
    }));
}

const IssueRow = ({ i, onIssue }) => h('li', { key: i.id, 'data-issue': i.id },
  h(Button, { kind: 'linkish', style: { textAlign: 'left' }, onClick: () => onIssue(i.id) }, i.identifier ? `${i.identifier} ` : '', i.title));

export function TasksPanel({ tasks, t, onIssue, onClose }) {
  const d = tasks.data;
  return h(Panel, { title: t('tasks_title'), t, onClose, id: 'tasks' },
    !d ? h(Loading, { t, q: tasks }) : h('div', null,
      ...[['tasks_blocked', d.blocked || []], ['tasks_doing', d.doing], ['tasks_next', d.next]].map(([k, list]) => h('div', { key: k },
        h('h3', { style: S.h3 }, t(k)),
        list.length ? h('ul', { style: { paddingLeft: 18 } }, ...list.map(i => h(IssueRow, { key: i.id, i, onIssue }))) : h('p', { style: S.muted }, t('tasks_empty'))))));
}

export function IssuePanel({ issue, t, prefix, onClose }) {
  const d = issue.data;
  return h(Panel, { title: d ? `${d.identifier || ''} ${d.title}`.trim() : t('loading'), t, onClose, id: 'issue' },
    !d ? (issue.loading || issue.error ? h(Loading, { t, q: issue }) : h('p', { style: S.err, 'data-issue-missing': '1' }, t('error_load'))) : h('div', null,
      d.description ? h(RichText, { text: d.description }) : null,
      h('h3', { style: S.h3 }, t('issue_comments')),
      d.comments.length ? d.comments.map(c => h('div', { key: c.id, style: S.item }, h(When, { at: c.createdAt }), h(RichText, { text: c.body }))) : h('p', { style: S.muted }, t('issue_none')),
      prefix ? h('p', null, h(Link, { href: `/${encodeURIComponent(prefix)}/issues/${encodeURIComponent(d.identifier || d.id)}` }, t('issue_open'))) : null));
}

export function LogPanel({ activity, agents, t, onClose }) {
  const names = Object.fromEntries((agents || []).map(a => [a.id, a.name]));
  const list = activity.data || [];
  return h(Panel, { title: t('log_title'), t, onClose, id: 'log' },
    !activity.data ? h(Loading, { t, q: activity }) : !list.length ? h('p', { style: S.muted }, t('log_empty'))
      : h('ul', { style: { paddingLeft: 18 } }, ...list.map(e => h('li', { key: e.id, 'data-activity': e.id },
        h(When, { at: e.createdAt }), ' ', names[e.agentId] || names[e.actorId] || e.actorType, ': ', h('code', null, e.action)))));
}

// limitPause: notify の記録（{ reason, untilAt }・無ければ null）。あれば「AI の上限で停止中（〜まで）」を出す（範囲 7 の 7）
export function AgentPanel({ agent, work, t, limitPause = null, onIssue, onClose }) {
  const d = work.data;
  return h(Panel, { title: agent?.name || '', t, onClose, id: 'agent' },
    agent ? h('p', { style: S.muted }, agent.title || agent.role || '', ' · ', t(`status_${statusKey(agent.status)}`)) : null,
    limitPause ? h('p', { style: { ...S.err, fontWeight: 600 }, 'data-agent-limit': limitPause.untilAt || 'manual' }, t('agent_limit_paused'), ' ',
      limitPause.untilAt ? t('limit_until').replace('{at}', new Date(limitPause.untilAt).toLocaleString()) : t('limit_until_manual')) : null,
    !d ? h(Loading, { t, q: work }) : h('div', null,
      h('h3', { style: S.h3 }, t('agent_now')),
      d.now.length ? h('ul', { style: { paddingLeft: 18 } }, ...d.now.map(i => h(IssueRow, { key: i.id, i, onIssue }))) : h('p', { style: S.muted }, t('agent_nothing')),
      h('h3', { style: S.h3 }, t('agent_recent')),
      d.recent.length ? h('ul', { style: { paddingLeft: 18 } }, ...d.recent.map(i => h(IssueRow, { key: i.id, i, onIssue }))) : h('p', { style: S.muted }, t('agent_nothing'))));
}

const mins = ms => `${Math.floor(ms / 60000)}:${String(Math.floor(ms / 1000) % 60).padStart(2, '0')}`;

// AI の契約の欄（範囲: docs/review/2026-11-18-office-ai-panel-ux-scope.md G1・F1・F8・F9）。wizard の AI の段と同じ中身:
// AI の一覧（状態の印つき）・ダウンロード・つなぐ・Claude の code の欄（文字数つき）・ChatGPT の code（写すボタンつき）・社員ごとの AI の割り当て。
// 起動係の口（/setup/api/ai…・/setup/api/agents/ai）をそのまま呼ぶ。ここでつないだ AI は起動係が「使う AI」に足す（F2）
// - ダウンロードやサインインが動いている間は 2 秒ごとに読み直す。貼りかけの code（draft）は欄の state に持つので、読み直しで消えない（F9）
// - 欄を閉じる・別の欄に切り替える（＝この欄が消える）時、待っている Claude のサインインを取り消す（F8）
const MOVING = ['starting', 'waiting', 'submitting'];
const AI_NAME_KEY = { codex_local: 'ai_chatgpt', claude_local: 'ai_claude' };
// 起動係の error の code → 欄の文の key（知らない code は ai_r_failed）
export const AI_ERRORS = { ai_bad_code: 'ai_r_bad_code', ai_not_waiting: 'ai_r_not_waiting', ai_install_first: 'ai_r_install_first', company_first: 'ai_r_company_first', ai_not_connected: 'ai_r_not_connected', assign_busy: 'ai_r_assign_busy', ai_unknown: 'ai_r_unknown', ai_connect_not_ready: 'ai_r_not_ready' };
export const FAIL_KEY = { code_rejected: 'ai_code_rejected', login_timeout: 'ai_login_timeout', codex_missing: 'ai_codex_missing' };
export const aiErrorKey = e => AI_ERRORS[String(e?.body?.error || '')] || 'ai_r_failed';
// 担当ごとの保存の失敗の理由（起動係の why）→ 文の key。知らない理由は汎用の文（独立レビュー r2 の 5）
// paperclip_422 は本体が種類を替えられないと断った（担当の AI の接続が新しい種類に合わない・待っても通らない・独立レビュー r3 の E）
export const ASSIGN_WHY = { agent_unknown: 'assign_why_agent_unknown', paperclip_422: 'assign_why_incompatible', failed: 'assign_why_failed' };
export const assignWhyKey = why => ASSIGN_WHY[why] || (/^paperclip_\d+$/.test(String(why || '')) ? 'assign_why_paperclip' : 'assign_why_failed');
// AI ごとのつなぎの途中か（ダウンロード中・サインインの途中）
const loginOf = (list, type) => (type === 'codex_local' ? list?.codex : type === 'claude_local' ? list?.claude : null);
export const aiBusy = (list, a) => a.install?.status === 'running' || MOVING.includes(loginOf(list, a.type)?.state);
export const aiMoving = list => !!list && ((list.ais || []).some(a => a.install?.status === 'running') || MOVING.includes(list.codex?.state) || MOVING.includes(list.claude?.state));

// 「AI の契約」の欄の上限の節（範囲 docs/review/2026-11-18-ai-usage-limit-scope.md G1・G2a・G8・G9b・7 の 1・7 の 7）:
// 契約ごとの直近の使用率（週・5 時間）と読んだ時刻（notify の limits）・知らせる %・止める %（空は止めない）・追加料金の扱い（3 つから選ぶ・Q4）・守りのスイッチ（flag aiLimitGuard）。
// 保存は起動係の POST /setup/api/ai-limits（持ち主の cookie）。次の見回り（5 分以内）から効く
const LIMIT_PROVIDERS = [['openai', 'ai_chatgpt'], ['anthropic', 'ai_claude']];
const LIMIT_SAVE_ERRORS = { ai_limits_warn_over_stop: 'limits_warn_over_stop', ai_limits_bad: 'limits_bad_pct' };
export function LimitsSection({ api, t, limits = null }) {
  const [form, setForm] = useState(null), [loadErr, setLoadErr] = useState(false), [res, setRes] = useState(null);
  const alive = useRef(true);
  useEffect(() => { alive.current = true; api.aiLimits().then(r => { if (alive.current) setForm(limitsForm(r?.aiLimits)); }, () => { if (alive.current) setLoadErr(true); }); return () => { alive.current = false; }; }, []); // eslint-disable-line react-hooks/exhaustive-deps
  const setPath = (p, w, f) => e => { const v = e.target.value; setForm(x => ({ ...x, [p]: { ...x[p], [w]: { ...x[p][w], [f]: v } } })); };
  const save = async () => {
    setRes(null);
    const b = limitsBody(form);
    if (b.error) { setRes({ tone: 'err', key: b.error }); return; }
    try { const r = await api.saveAiLimits(b.body); if (alive.current) { setForm(limitsForm(r?.aiLimits ?? b.body)); setRes({ tone: 'ok', key: 'limits_saved' }); } }
    catch (e) { if (alive.current) setRes({ tone: 'err', key: LIMIT_SAVE_ERRORS[String(e?.body?.error || '')] || 'limits_save_failed' }); }
  };
  const winLabel = { week: t('limits_w_week'), h5: t('limits_w_h5') };
  const usage = p => {
    const v = limits?.[p === 'anthropic' ? 'claude' : p] || null; // notify の画面の値では Claude は claude
    const rows = usageRows(v);
    return h('div', { 'data-limits-usage': p },
      h('p', { style: { margin: '4px 0' } }, ...rows.flatMap((r, i) => [i ? ' · ' : '', h('span', { key: r.kind, 'data-limits-pct': `${p}:${r.kind}` }, `${winLabel[r.kind]} `, r.usedPercent == null ? t('limits_no_value') : `${r.usedPercent}%`)])),
      h('p', { className: 'aio-muted', style: { margin: 0, fontSize: 13 }, 'data-limits-read-at': v?.observedAt || 'none' }, t('limits_read_at'), ' ', v?.observedAt ? new Date(v.observedAt).toLocaleString() : t('limits_not_read')),
      v?.unreadable ? h('p', { className: 'aio-err', 'data-limits-unreadable': p }, t(`limits_unreadable_${p}`)) : null,
      p === 'anthropic' && limits?.overageEnabled ? h('p', { className: 'aio-muted', 'data-limits-overage-enabled': '1' }, t('limits_overage_enabled')) : null);
  };
  const num = (p, w, f, label) => h('label', { style: { display: 'flex', flexDirection: 'column', gap: 2, fontSize: 13 } }, label,
    h('input', { type: 'number', min: 1, max: 100, step: 1, inputMode: 'numeric', style: { ...S.input, width: 90 }, value: form[p][w][f], onChange: setPath(p, w, f), 'data-limits-input': `${p}.${w}.${f}` }));
  return h('div', { 'data-limits': '1' },
    h('h3', { className: 'aio-section-title' }, t('limits_title')),
    h('p', { className: 'aio-help' }, t('limits_help')),
    ...LIMIT_PROVIDERS.map(([p, nameKey]) => h('div', { key: p, className: 'aio-ai-row', 'data-limits-provider': p },
      h('div', { className: 'aio-ai-head' }, h('span', { className: 'aio-ai-name' }, t(nameKey))),
      usage(p),
      form ? h('div', { className: 'aio-ai-body' },
        ...['week', 'h5'].map(w => h('div', { key: w, style: S.row }, h('strong', { style: { minWidth: 90 } }, winLabel[w]), num(p, w, 'warnPct', t('limits_warn')), num(p, w, 'stopPct', t('limits_stop'))))) : null)),
    !form ? h('p', { className: loadErr ? 'aio-err' : 'aio-muted' }, t(loadErr ? 'error_load' : 'loading')) : h('div', null,
      h('p', { className: 'aio-muted', style: { fontSize: 13 } }, t('limits_stop_empty_hint')),
      // 追加料金の扱い（AI オフィス（起動係）で 1 つ・全部の会社と両方の契約に効く）。allow は上限なくお金が出ていくことを赤で書く
      h('fieldset', { 'data-limits-spend': '1', style: { border: 0, padding: 0, margin: '8px 0' } },
        h('legend', null, h('strong', null, t('limits_spend_title'))),
        h('p', { className: 'aio-muted', style: { fontSize: 13, margin: '2px 0' }, 'data-limits-spend-scope': '1' }, t('limits_spend_scope')),
        ...LIMIT_SPEND_MODES.map(m => h('label', { key: m, style: { display: 'block', margin: '4px 0' } },
          h('input', { type: 'radio', name: 'aio-limits-spend', value: m, checked: form.spend === m, onChange: () => setForm(x => ({ ...x, spend: m })), 'data-limits-spend-mode': m }), ' ',
          h('strong', null, t(`limits_spend_${m}`)), ' ', h('span', { className: 'aio-muted' }, t(`limits_spend_${m}_help`)))),
        form.spend === 'allow' ? h('p', { className: 'aio-err', 'data-limits-spend-warn': '1' }, t('limits_spend_allow_warn')) : null),
      h('label', { style: S.row }, h('input', { type: 'checkbox', checked: !!form.guard, onChange: e => { const v = e.target.checked; setForm(x => ({ ...x, guard: v })); }, 'data-limits-guard': '1' }), h('strong', null, t('limits_guard'))),
      h('p', { className: 'aio-help' }, t('limits_guard_help')),
      h('div', { className: 'aio-actions' }, h(Button, { kind: 'primary', busyText: t('saving'), 'data-limits-save': '1', onClick: save }, t('limits_save')))),
    res ? h('p', { className: 'aio-result', 'data-tone': res.tone, role: 'status', 'data-limits-result': res.key }, t(res.key)) : null);
}

export function ConnectPanel({ api, launcher, t, lang = 'en', limits = null, onClose, setTimer = setTimeout, clearTimer = clearTimeout, copyText = s => navigator.clipboard.writeText(s) }) {
  const [list, setList] = useState(null), [listErr, setListErr] = useState(false);
  const [agents, setAgents] = useState(null), [agentsErr, setAgentsErr] = useState(false);
  const [tick, setTick] = useState(0), [more, setMore] = useState(null), [retried, setRetried] = useState({});
  const [draft, setDraft] = useState(''), [choice, setChoice] = useState({}), [assignRes, setAssignRes] = useState({}), [result, setResult] = useState(null);
  const claudeState = useRef(null), alive = useRef(true);
  claudeState.current = list?.claude?.state || null;
  const has = !!launcher;
  // 読むたびに tick を進める（失敗しても次の 2 秒を掛け直す・独立レビュー r2 の 4）
  // 読み直しには順番の番号を付け、最後に始めた読み直しの応答だけを使う（古い応答が新しい一覧を上書きしない・独立レビュー r4）
  const seq = useRef({ list: 0, agents: 0 });
  const load = async () => {
    const my = ++seq.current.list;
    try { const r = await api.aiList(); if (alive.current && my === seq.current.list) { setList(r); setListErr(false); } } catch { if (alive.current && my === seq.current.list) setListErr(true); }
    if (alive.current && my === seq.current.list) setTick(n => n + 1);
  };
  const loadAgents = async () => {
    const my = ++seq.current.agents;
    try { const r = await api.agentsAi(); if (alive.current && my === seq.current.agents) { setAgents(r.agents || []); setAgentsErr(false); } } catch { if (alive.current && my === seq.current.agents) setAgentsErr(true); }
  };
  useEffect(() => { alive.current = true; if (has) { load(); loadAgents(); } }, [has]); // eslint-disable-line react-hooks/exhaustive-deps
  // 動いている間は 2 秒ごとに読み直す（読むたびに tick が進むので、読めても読めなくても次の 2 秒を掛け直す）
  useEffect(() => { if (!aiMoving(list)) return undefined; const id = setTimer(load, 2000); return () => clearTimer(id); }, [tick]); // eslint-disable-line react-hooks/exhaustive-deps
  // code の欄が消えたら（つながった・取り消した・期限切れ）下書きを捨てる
  useEffect(() => { if (draft && !['waiting', 'submitting'].includes(list?.claude?.state)) setDraft(''); }, [list]); // eslint-disable-line react-hooks/exhaustive-deps
  // 欄が消える時: 待っている Claude のサインインを取り消す（F8）
  useEffect(() => () => { alive.current = false; if (['starting', 'waiting'].includes(claudeState.current)) api.aiCancel('claude_local').catch(() => {}); }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // 押した操作: 終わるまで Button が「処理中」。終わると欄の中に結果の文（できた・できなかった）を出し、一覧を読み直す。
  // 読み直しは待たない: 待つと、結果の文が出た後も読み直しが返るまでボタンが処理中のまま残る（e2e wiz8 の en で起きた）。
  // 結果の文と処理中を外すのは同じ描画に入る
  const act = (okKey, fn) => async () => {
    setResult(null);
    try { await fn(); if (alive.current && okKey) setResult({ tone: 'ok', key: okKey }); }
    catch (e) { if (alive.current) setResult({ tone: 'err', key: aiErrorKey(e) }); }
    load();
  };
  const nameOf = a => (AI_NAME_KEY[a.type] ? t(AI_NAME_KEY[a.type]) : (a.name?.[lang] || a.name?.en || a.type));
  const failNote = c => (c?.state === 'failed' ? h('p', { className: 'aio-err', 'data-ai-error': c.error || 'failed' }, t(FAIL_KEY[c.error] || 'ai_failed'))
    : c?.state === 'expired' ? h('p', { className: 'aio-err', 'data-ai-error': 'expired' }, t('ai_expired')) : null);
  const left = ms => `${t('ai_time_left')} ${mins(ms || 0)}`;

  // AI ごとの 1 行: 1 行目に状態の印・名前・状態の badge・ボタン。つなぐ途中の部品（リンク・code・欄）は下の段に縦に並べる（wizard の .ai-row と同じ形）
  const connectView = a => {
    if (a.type === 'codex_local') {
      const c = list.codex || {};
      if (c.state === 'starting') return { tone: 'busy', badge: 'ai_s_starting' };
      if (c.state === 'waiting') {
        return { tone: 'warn', badge: 'ai_s_waiting', body: [
          h('p', { key: 'o' }, t('ai_codex_open')),
          h('p', { key: 'l' }, h(Link, { href: c.url, external: true, kind: 'button', 'data-codex-url': '1' }, t('ai_open_signin'))),
          h('p', { key: 'c' }, t('ai_codex_enter')),
          h('div', { key: 'code', className: 'aio-code-line' }, h('span', { className: 'aio-code', 'data-codex-code': '1' }, c.code),
            h(Button, { small: true, 'data-codex-copy': '1', busyText: t('busy'), onClick: act('ai_r_copied', () => copyText(String(c.code || ''))) }, t('ai_copy'))),
          h('p', { key: 'w', className: 'aio-muted' }, t('ai_codex_waiting'), ' · ', left(c.remainingMs)),
          h('div', { key: 'a', className: 'aio-actions' }, h(Button, { 'data-ai-cancel': a.type, busyText: t('busy'), onClick: act('ai_r_cancelled', () => api.aiCancel(a.type)) }, t('ai_cancel'))),
        ] };
      }
      return { tone: c.state === 'failed' || c.state === 'expired' ? 'err' : 'muted', badge: 'ai_s_not_connected', body: [failNote(c)],
        action: h(Button, { kind: 'primary', 'data-ai-connect': a.type, 'data-codex-start': '1', busyText: t('busy'), onClick: act(null, () => api.aiStart(a.type)) }, c.state === 'failed' || c.state === 'expired' ? t('ai_retry') : t('ai_connect')) };
    }
    const c = list.claude || {};
    if (c.state === 'starting') return { tone: 'busy', badge: 'ai_s_starting' };
    if (c.state === 'waiting' || c.state === 'submitting') {
      const sending = c.state === 'submitting', count = draft.trim().length;
      return { tone: sending ? 'busy' : 'warn', badge: sending ? 'ai_s_checking' : 'ai_s_waiting', body: [
        h('p', { key: 'o' }, t('ai_claude_open')),
        h('p', { key: 'l' }, h(Link, { href: c.url, external: true, kind: 'button', 'data-ai-url': a.type }, t('ai_open_signin'))),
        h('label', { key: 'lb', className: 'aio-label', htmlFor: 'aio-ai-code' }, t('ai_paste_code')),
        h('textarea', { key: 'ta', id: 'aio-ai-code', className: 'aio-textarea', rows: 3, autoComplete: 'off', spellCheck: false, value: draft, disabled: sending, onChange: e => setDraft(e.target.value), 'data-ai-code': a.type }),
        h('p', { key: 'n', className: 'aio-muted', 'data-ai-code-count': a.type }, t('ai_code_count').replace('{n}', String(count))),
        sending ? h('p', { key: 's', className: 'aio-muted' }, t('ai_checking_note')) : null,
        c.remainingMs ? h('p', { key: 'r', className: 'aio-muted' }, left(c.remainingMs)) : null,
        h('div', { key: 'a', className: 'aio-actions' },
          h(Button, { 'data-ai-cancel': a.type, busyText: t('busy'), onClick: act('ai_r_cancelled', () => api.aiCancel(a.type)) }, t('ai_cancel')),
          h(Button, { kind: 'primary', 'data-ai-send': a.type, busy: sending, disabled: !count, busyText: t('ai_sending'), onClick: act('ai_r_code_sent', () => api.aiCode(a.type, draft)) }, t('ai_send_code'))),
      ] };
    }
    return { tone: c.state === 'failed' || c.state === 'expired' ? 'err' : 'muted', badge: 'ai_s_not_connected', body: [failNote(c)],
      action: h(Button, { kind: 'primary', 'data-ai-connect': a.type, busyText: t('busy'), onClick: act(null, () => api.aiStart(a.type)) }, c.state === 'failed' || c.state === 'expired' ? t('ai_retry') : t('ai_connect')) };
  };
  const row = a => {
    if (!a.selectable) {
      return h('div', { key: a.type, className: 'aio-ai-row', 'data-ai': a.type, 'data-ai-state': 'unknown' },
        h('div', { className: 'aio-ai-head' }, h('span', { className: 'aio-ai-name' }, nameOf(a)), h(Status, { tone: 'muted', text: t('ai_s_unknown') })));
    }
    const inst = a.install?.status || 'pending';
    let v;
    // つないだ AI: 「つなぎ直す」で同じ code の流れをもう一度（ChatGPT は起動係が restart、Claude は start で token の秘密を rotate・独立レビュー r2 の 7）。
    // つなぎ直しの途中は、つなぐ途中の形（code の欄など）を出す
    if (a.connected && a.loginReady && MOVING.includes(loginOf(list, a.type)?.state)) v = connectView(a);
    else if (a.connected) {
      // 失敗の文は、この欄でつなぎ直しを押した後の失敗だけ（前の失敗の記録は、つながっている行に出さない・独立レビュー r3 の D）
      v = { tone: 'ok', badge: 'ai_s_connected', body: a.loginReady && retried[a.type] ? [failNote(loginOf(list, a.type))] : [],
        action: a.loginReady ? h(Button, { small: true, 'data-ai-reconnect': a.type, busyText: t('busy'), onClick: act(null, () => { setRetried(r => ({ ...r, [a.type]: true })); return api.aiStart(a.type); }) }, t('ai_reconnect')) : null };
    }
    else if (inst === 'running') v = { tone: 'busy', badge: 'ai_s_downloading' };
    else if (inst !== 'done') {
      v = { tone: inst === 'failed' ? 'err' : 'muted', badge: inst === 'failed' ? 'ai_s_download_failed' : 'ai_s_not_downloaded',
        action: h(Button, { kind: 'primary', 'data-ai-install': a.type, busyText: t('busy'), onClick: act('ai_r_download_started', () => api.aiInstall(a.type)) }, t('ai_download')) };
    } else if (!a.loginReady) v = { tone: 'muted', badge: 'ai_s_not_ready' };
    else v = connectView(a);
    const state = v.badge === 'ai_s_connected' ? 'connected' : (v.badge || '').replace(/^ai_s_/, '');
    const body = (v.body || []).filter(Boolean);
    return h('div', { key: a.type, className: 'aio-ai-row', 'data-ai': a.type, 'data-ai-state': state },
      h('div', { className: 'aio-ai-head' },
        h('span', { className: 'aio-ai-name' }, nameOf(a)),
        h(Status, { tone: v.tone, text: t(v.badge), ...(v.badge === 'ai_s_connected' ? { 'data-ai-connected': a.type } : {}) }),
        v.action || null),
      body.length ? h('div', { className: 'aio-ai-body' }, ...body) : null);
  };

  // 社員ごとの AI の割り当て（F1）。選べるのはつないだ AI だけ。今の AI がつないでいない物なら、その行は選べない形で残す
  const connectedTypes = (list?.ais || []).filter(a => a.selectable && a.connected).map(a => a.type);
  const label = type => { const a = (list?.ais || []).find(x => x.type === type); return a ? nameOf(a) : (AI_NAME_KEY[type] ? t(AI_NAME_KEY[type]) : String(type || '')); };
  const changed = Object.entries(choice).filter(([id, type]) => { const a = (agents || []).find(x => x.id === id); return a && type && type !== a.adapterType; });
  const save = async () => {
    setResult(null);
    try {
      const r = await api.assignAi(Object.fromEntries(changed));
      if (!alive.current) return;
      setAssignRes(r.results || {});
      const bad = Object.values(r.results || {}).filter(x => !x.ok).length;
      setResult({ tone: bad ? 'err' : 'ok', key: bad ? 'assign_r_partial' : 'assign_r_saved' });
      setChoice({});
    } catch (e) { if (alive.current) setResult({ tone: 'err', key: aiErrorKey(e) }); }
    loadAgents(); // 待たない（act と同じ理由）
  };
  const assignRow = a => {
    const cur = choice[a.id] || a.adapterType || '';
    const opts = [...connectedTypes];
    const extra = cur && !opts.includes(cur) ? cur : null;
    const res = assignRes[a.id];
    const aria = `${t('assign_ai_for')} ${a.name}`;
    return h('div', { key: a.id, className: 'aio-assign-row', 'data-assign-agent': a.id },
      h('div', null, h('strong', null, a.name), a.title ? h('div', { className: 'aio-muted', style: { fontSize: 13 } }, a.title) : null),
      h('select', { className: 'aio-select', value: cur, disabled: !opts.length, 'aria-label': aria, onChange: e => setChoice(c => ({ ...c, [a.id]: e.target.value })), 'data-assign': a.id },
        extra ? h('option', { key: extra, value: extra, disabled: true }, `${label(extra)} · ${t('assign_not_connected')}`) : null,
        ...opts.map(type => h('option', { key: type, value: type }, label(type)))),
      res ? h('p', { className: res.ok ? 'aio-ok' : 'aio-err', 'data-assign-result': res.ok ? 'ok' : (res.why || 'failed') }, res.ok ? t('assign_r_row_ok') : `${t('assign_r_row_failed')}: ${t(assignWhyKey(res.why))}`) : null);
  };

  // 並び（独立レビュー r2 の 8）: (1) 社員ごとの AI (2) つないだ AI と、つなぐ途中の AI (3) まだつないでいない AI は「ほかの AI をつなぐ（n）」の開閉の中。
  // 開閉の既定は閉じる。つないだ AI が 1 つも無い時だけ開く
  const ais = list?.ais || [];
  const main = ais.filter(a => a.selectable && (a.connected || aiBusy(list, a)));
  const others = ais.filter(a => !main.includes(a));
  const open = more ?? !connectedTypes.length;
  const assignSection = [
    h('h3', { key: 'at', className: 'aio-section-title', style: { marginTop: 4 } }, t('assign_title')),
    h('p', { key: 'ah', className: 'aio-help' }, t('assign_help')),
    !agents ? h('p', { key: 'al', className: agentsErr ? 'aio-err' : 'aio-muted' }, t(agentsErr ? 'error_load' : 'loading'))
      : !agents.length ? h('p', { key: 'al', className: 'aio-muted' }, t('assign_none'))
        : h('div', { key: 'al', 'data-assign-list': '1' },
          list && !connectedTypes.length ? h('p', { className: 'aio-muted', 'data-assign-need': '1' }, t('assign_need_ai')) : null,
          ...agents.map(assignRow),
          h('p', { className: 'aio-muted', style: { fontSize: 13 } }, t('assign_next_run')),
          h('div', { className: 'aio-actions', style: { marginTop: 8 } },
            h(Button, { kind: 'primary', 'data-assign-save': '1', disabled: !changed.length, busyText: t('saving'), onClick: save }, t('assign_save')))),
  ];
  return h(Panel, { title: t('connect_title'), t, onClose, id: 'connect' },
    launcher === undefined ? h('p', { style: S.muted }, t('loading')) : !launcher ? h('p', null, t('connect_package_only')) : h('div', { 'data-ai-panel': '1' },
      h('p', { className: 'aio-help' }, t('ai_panel_help')),
      ...assignSection,
      h('h3', { className: 'aio-section-title' }, t('ai_list_title')),
      !list ? h('p', { className: listErr ? 'aio-err' : 'aio-muted' }, t(listErr ? 'error_load' : 'loading')) : h('div', { 'data-ai-list': '1' },
        main.length ? h('div', { 'data-ai-main': '1' }, ...main.map(row)) : h('p', { className: 'aio-muted', 'data-ai-none': '1' }, t('ai_none_connected')),
        others.length ? h(Button, { kind: 'ghost', 'aria-expanded': open ? 'true' : 'false', 'aria-controls': 'aio-ai-others', 'data-ai-more': others.length, style: { marginTop: 6, fontWeight: 600 }, onClick: () => setMore(!open) },
          h('span', { 'aria-hidden': 'true' }, open ? '▾' : '▸'), t('ai_more').replace('{n}', String(others.length))) : null,
        others.length && open ? h('div', { id: 'aio-ai-others', 'data-ai-others': '1' }, ...others.map(row)) : null),
      result ? h('p', { className: 'aio-result', 'data-tone': result.tone, role: 'status', 'data-ai-result': result.key }, t(result.key)) : null,
      api.aiLimits ? h(LimitsSection, { api, t, limits }) : null));
}

// デザイン部の依頼の欄。担当は起動係の state の雛形 design の id で見分ける（名前で探さない・範囲の保証 5）
export function DesignForm({ api, companyId, launcher, lang, t, reloadLauncher, onIssue }) {
  const [kind, setKind] = useState('logo'), [name, setName] = useState(''), [brief, setBrief] = useState('');
  const [busy, setBusy] = useState(false), [msg, setMsg] = useState(null);
  if (launcher === undefined) return h('p', { style: S.muted }, t('loading'));
  if (!launcher) return h('p', { 'data-design': 'package-only' }, t('design_package_only'));
  const agentId = launcher.agents?.design;
  if (!agentId) {
    return h('div', { 'data-design': 'no-agent' }, h('p', null, t('design_no_agent_help')),
      h(Button, { kind: 'primary', busy, busyText: t('busy'), 'data-design-add': '1', onClick: async () => { setBusy(true); try { await api.addAgents(['design']); } catch { setMsg({ err: 'design_failed' }); } setBusy(false); reloadLauncher(); } }, t('design_add_agent')),
      msg?.err ? h('p', { style: S.err }, t(msg.err)) : null);
  }
  const send = async () => {
    setBusy(true); setMsg(null);
    try {
      const r = await api.designRequest(companyId, { kind, name, brief, agentId, lang });
      setMsg({ ok: r.already ? 'design_already' : 'design_sent', issue: r.issue });
    } catch (e) { setMsg({ err: typeof e.body?.error === 'string' && e.body.error.startsWith('design_') ? e.body.error : 'design_failed' }); }
    setBusy(false);
  };
  return h('form', { 'data-design': 'form', onSubmit: e => { e.preventDefault(); if (!busy) send(); } },
    h('h3', { style: S.h3 }, t('design_title')),
    h('div', { role: 'radiogroup', 'aria-label': t('design_kind'), style: S.row }, ...['logo', 'flyer'].map(k => h('label', { key: k },
      h('input', { type: 'radio', name: 'aio-design-kind', value: k, checked: kind === k, onChange: () => setKind(k), 'data-design-kind': k }), ' ', t(`design_${k}`)))),
    h('label', { style: { display: 'block', marginTop: 8 } }, kind === 'logo' ? t('design_name') : t('design_flyer_title'),
      h('input', { style: S.input, value: name, maxLength: 80, onChange: e => setName(e.target.value), 'data-design-name': '1' })),
    h('label', { style: { display: 'block', marginTop: 8 } }, t('design_brief'),
      h('textarea', { style: { ...S.input, minHeight: 70 }, value: brief, maxLength: 2000, onChange: e => setBrief(e.target.value), 'data-design-brief': '1' })),
    h('div', { style: S.row }, h(Button, { type: 'submit', kind: 'primary', busy, busyText: t('busy'), 'data-design-send': '1' }, t('design_send'))),
    msg?.err ? h('p', { style: S.err, 'data-design-error': msg.err }, t(msg.err)) : null,
    msg?.ok ? h('p', { style: S.ok, 'data-design-result': msg.ok }, t(msg.ok), ' ',
      h(Button, { kind: 'linkish', onClick: () => onIssue(msg.issue.id) }, msg.issue.identifier || t('issue_open'))) : null);
}

// 図書室の欄（範囲の保証 12・13・16）: 所蔵の数・最後に読んだ時刻（30 時間より古いと赤）・探す・文書を置く・外す。
// 検索の抜き出しは AI や人の書いた文なので RichText で text としてだけ出す
const LIB_STALE_MS = 30 * 3600e3;
// 聞く（開発元の記録 docs/review/2026-11-17-library-ask-scope.md 作り方 7・10〜12）: 押す前に枠の文を常に出し、返事を 3 秒おきに 3 分まで問う。
// 答えは AI の文なので RichText で text としてだけ出す
export function AskBox({ api, companyId, t, lang, onIssue, setTimer = setTimeout, clearTimer = clearTimeout, now = Date.now }) {
  const [q, setQ] = useState(''), [busy, setBusy] = useState(false), [res, setRes] = useState(null);
  // 問いごとの番号を持つ係。古い問いの返事は捨て、部屋を閉じたら止める（実装レビュー P2-2・api.mjs の askRunner）
  const runner = useRef(null);
  if (!runner.current) runner.current = askRunner({ fetchAnswer: id => api.libraryAskAnswer(companyId, id), onUpdate: p => setRes(x => ({ ...x, ...p })), setTimer, clearTimer, now });
  useEffect(() => () => runner.current.stop(), []);
  const ask = async () => {
    if (!q.trim() || busy) return;
    const g = runner.current.next();
    setBusy(true); setRes(null);
    try {
      const r = await api.libraryAsk(companyId, q.trim(), lang);
      if (!runner.current.isCurrent(g)) return;
      if (!r.found) setRes({ notFound: true });
      else { setRes({ already: r.already, stale: r.stale, issue: r.issue, state: 'waiting' }); runner.current.follow(r.issue, g); }
    } catch (e) {
      const code = String(e.body?.error || '');
      if (runner.current.isCurrent(g)) setRes({ err: ASK_ERRORS.includes(code) ? code : 'library_failed' });
    } finally { setBusy(false); }
  };
  const issueLink = res?.issue && onIssue ? h(Button, { kind: 'linkish', onClick: () => onIssue(res.issue.id), 'data-library-ask-issue': '1' }, res.identifier || res.issue.identifier || t('issue_open')) : null;
  const setupLink = h(Link, { href: '/setup/', 'data-library-ask-setup': '1' }, t('library_ask_open_setup'));
  return h('div', { 'data-library-ask': 'box' },
    h('h3', { style: S.h3 }, t('library_ask')),
    h('form', { style: S.row, onSubmit: e => { e.preventDefault(); ask(); } },
      h('input', { style: { ...S.input, flex: 1 }, value: q, maxLength: 300, 'aria-label': t('library_ask'), placeholder: t('library_ask_ph'), onChange: e => setQ(e.target.value), 'data-library-ask-q': '1' }),
      h(Button, { type: 'submit', busy, busyText: t('busy'), 'data-library-ask-go': '1' }, t('library_ask_go'))),
    h('p', { style: S.muted, 'data-library-ask-quota': '1' }, t('library_ask_quota')),
    res?.err ? h('p', { style: S.err, 'data-library-ask-error': res.err }, t(res.err), res.err === 'library_no_secretary' ? [' ', setupLink] : null) : null,
    res?.notFound ? h('p', { style: S.muted, 'data-library-ask-state': 'not_found' }, t('library_ask_not_found')) : null,
    res?.issue && res.state !== 'failed' ? h('p', { style: S.muted, 'data-library-ask-used': res.already ? 'already' : 'new' }, t(res.already ? 'library_ask_already' : 'library_ask_used')) : null,
    res?.stale?.identifier ? h('p', { style: S.muted }, t('library_ask_stale'), ' ', res.stale.identifier) : null,
    res?.state === 'handed_to' ? h('p', { style: S.muted, 'data-library-ask-state': 'handed_to' }, t('library_ask_handed'), res.handedTo ? ` (${res.handedTo})` : '') : null,
    res?.state === 'failed' ? h('p', { style: S.err, 'data-library-ask-state': 'failed' }, t('library_ask_failed'), ' ', setupLink, ' ', issueLink) : null,
    res?.state === 'closed' ? h('p', { style: S.muted, 'data-library-ask-state': 'closed' }, t('library_ask_closed'), ' ', issueLink) : null,
    res?.state === 'answered' ? h('div', { 'data-library-ask-state': 'answered' }, h('p', { style: S.muted }, t('library_ask_answer'), ' ', issueLink), h('div', { style: { whiteSpace: 'pre-wrap' } }, h(RichText, { text: res.answer || '', max: 4000 }))) : null,
    res?.issue && (res.state === 'waiting' || (res.state === 'handed_to' && res.timedOut)) ? h('p', { style: S.muted, 'data-library-ask-state': res.timedOut ? 'timed_out' : 'waiting' }, t(res.timedOut ? 'library_ask_waiting_long' : 'library_ask_waiting'), ' ', issueLink) : null);
}
export const ASK_ERRORS = ['library_secretary_pending', 'library_no_secretary', 'library_ask_busy', 'library_ask_bad_question'];
export function LibraryPanel({ api, companyId, t, lang, onIssue }) {
  const [status, setStatus] = useState(null), [docs, setDocs] = useState(null), [q, setQ] = useState(''), [hits, setHits] = useState(null), [msg, setMsg] = useState(null), [busy, setBusy] = useState(false), [folder, setFolder] = useState(null);
  const companyRef = useRef(companyId); companyRef.current = companyId;
  const load = () => { api.libraryStatus(companyId).then(setStatus, () => setMsg({ err: 'library_failed' })); api.libraryDocs(companyId).then(r => setDocs(r.documents || []), () => {}); };
  useEffect(load, [companyId]); // eslint-disable-line react-hooks/exhaustive-deps
  const search = async () => { if (!q.trim()) return; setBusy(true); try { setHits((await api.librarySearch(companyId, q)).results || []); } catch { setMsg({ err: 'library_failed' }); } setBusy(false); };
  const put = async file => {
    if (!file) return;
    setMsg(null);
    if (!/\.(md|txt)$/i.test(file.name)) { setMsg({ err: 'library_doc_type' }); return; }
    if (file.size > 200 * 1024) { setMsg({ err: 'library_doc_size' }); return; }
    setBusy(true);
    try { const r = await api.libraryPut(companyId, file.name, await file.text()); setMsg({ ok: 'library_added', name: r.name }); load(); }
    catch (e) { const code = String(e.body?.error || ''); setMsg({ err: code.startsWith('library_doc_') ? code : 'library_failed' }); }
    setBusy(false);
  };
  // フォルダ選び: 部屋の会社の図書室の口へ 1 件ずつ順に置く（起動係の口は使わない・フォルダの欄の範囲 作り方 6・保証 6）
  const putFolder = async files => {
    const list = [...(files || [])]; if (!list.length) return;
    const started = companyId, same = () => companyRef.current === started; // 途中で会社を替えたら結果を出さない（置き先は始めた会社のまま・実装レビュー P3-4）
    setMsg(null); setBusy(true);
    try {
      const r = await folderToLibrary({ api, companyId: started, files: list, onProgress: p => { if (same()) setFolder({ progress: p }); } });
      if (same()) { setFolder(r); load(); }
    } catch { if (same()) { setMsg({ err: 'library_failed' }); setFolder(null); } }
    setBusy(false);
  };
  const remove = async name => { setBusy(true); try { await api.libraryRemove(companyId, name); load(); } catch { setMsg({ err: 'library_failed' }); } setBusy(false); };
  const last = status?.lastIngestAt ? Date.parse(status.lastIngestAt) : null;
  const stale = !status ? false : (last === null || Date.now() - last > LIB_STALE_MS);
  return h('div', { 'data-library': 'panel' },
    h('h3', { style: S.h3 }, t('library_status')),
    status ? h('p', { 'data-library-status': '1' },
      `${status.chunks} ${t('library_chunks')} · ${status.docs} ${t('library_docs')} · ${t('library_briefs')} ${status.briefs} · ${t('library_last')}: `,
      last ? h(When, { at: status.lastIngestAt }) : t('library_never')) : h('p', { style: S.muted }, t('loading')),
    // 一度も読めていない時も赤く出す（入れた時から起動係が見回りを呼べていない場合・独立レビュー P3-8）
    stale ? h('p', { style: S.err, 'data-library-stale': status?.lastIngestAt ? 'old' : 'never' }, t(status?.lastIngestAt ? 'library_stale' : 'library_never_read')) : null,
    status?.lastFailed ? h('p', { style: S.err, 'data-library-failed': status.lastFailed }, t('library_failed_n'), ' ', String(status.lastFailed)) : null,
    // 意味の近さの検索が 30 分続けて使えない時は帯で知らせる（言葉の一致の検索は動く・範囲 2026-11-17 作り方 15・保証 7）
    semanticDown(status?.semantic) ? h('p', { style: S.err, 'data-library-semantic': 'down' }, t('library_semantic_down')) : null,
    status?.semantic?.ok && status.semantic.backlog > 0 ? h('p', { style: S.muted, 'data-library-semantic-backlog': status.semantic.backlog }, t('library_semantic_backlog'), ' ', String(status.semantic.backlog)) : null,
    h('form', { 'data-library-search': 'form', style: S.row, onSubmit: e => { e.preventDefault(); if (!busy) search(); } },
      h('input', { style: { ...S.input, flex: 1 }, value: q, maxLength: 300, 'aria-label': t('library_search'), placeholder: t('library_search'), onChange: e => setQ(e.target.value), 'data-library-q': '1' }),
      h(Button, { type: 'submit', busy, busyText: t('busy'), 'data-library-go': '1' }, t('library_search_go'))),
    hits ? (hits.length ? h('ul', { style: { paddingLeft: 18 }, 'data-library-hits': hits.length },
      ...hits.map(x => h('li', { key: x.id, 'data-library-hit': x.srcId, style: { margin: '6px 0' } },
        h('strong', null, h(RichText, { text: x.title, max: 120 })), ' ', h('span', { style: S.muted }, `(${t(`library_kind_${x.kind}`)}${x.date ? ` · ${String(x.date).slice(0, 10)}` : ''})`),
        h('div', { style: S.muted }, h(RichText, { text: x.text, max: 240 })))))
      : h('p', { style: S.muted, 'data-library-hits': '0' }, t('library_no_hits'))) : null,
    h(AskBox, { key: companyId, api, companyId, t, lang, onIssue }), // 会社を替えたら描き直す（古い会社で問い続けない・再レビュー P3-3）
    h('h3', { style: S.h3 }, t('library_files')),
    h('label', { style: { display: 'block' } }, t('library_add'), ' ',
      h('input', { type: 'file', accept: '.md,.txt,text/markdown,text/plain', disabled: busy, 'data-library-file': '1', onChange: e => { put(e.target.files?.[0]); e.target.value = ''; } })),
    h('label', { style: { display: 'block', marginTop: 6 } }, t('library_folder'), ' ',
      h('input', { type: 'file', webkitdirectory: '', directory: '', multiple: true, disabled: busy, 'data-library-folder': '1', onChange: e => { putFolder(e.target.files); e.target.value = ''; } })),
    h('p', { style: S.muted }, t('library_folder_overwrite')),
    folder?.progress ? h('p', { style: S.muted, 'data-library-folder-progress': folder.progress }, t('library_folder_progress'), ' ', folder.progress) : null,
    folder?.done ? h('div', { 'data-library-folder-done': folder.done.put },
      h('p', { style: S.ok }, t('library_folder_done'), ' ', String(folder.done.put)),
      (() => {
        const rows = [...Object.entries(folder.skipped).filter(([, n]) => n > 0).map(([k, n]) => [`library_folder_why_${k}`, n]), ...Object.entries(folder.done.refused)];
        return rows.length ? h('div', null, h('p', { style: S.muted }, t('library_folder_skipped')), h('ul', { style: { paddingLeft: 18 } }, ...rows.map(([k, n]) => h('li', { key: k, 'data-library-folder-why': k }, `${t(k)}: ${n}`)))) : null;
      })()) : null,
    msg?.err ? h('p', { style: S.err, 'data-library-error': msg.err }, t(msg.err)) : null,
    msg?.ok ? h('p', { style: S.ok, 'data-library-added': msg.name }, t(msg.ok), ': ', msg.name) : null,
    docs && docs.length ? h('ul', { style: { paddingLeft: 18 }, 'data-library-docs': docs.length }, ...docs.map(d => h('li', { key: d.name, 'data-library-doc': d.name },
      d.name, ' ', h(Button, { small: true, disabled: busy, busyText: t('busy'), 'data-library-remove': d.name, onClick: () => remove(d.name) }, t('library_remove')))))
      : h('p', { style: S.muted }, t('library_files_none')));
}
