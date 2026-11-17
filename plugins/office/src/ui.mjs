// AI オフィスの画面（/:会社の prefix/office）。配置図の絵（scene）と担当の一覧、見出しのボタンから開く欄。
// React と SDK の UI は本体が渡す（build で外に出す）。JSX を使わず createElement で書く。範囲: docs/review/2026-11-15-office-plugin-scope.md の保証 3〜6
import { createElement as h, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useHostContext, usePluginData } from '@paperclipai/plugin-sdk/ui';
import { translator, pickLang, LANGS } from './i18n.mjs';
import { createApi, statusKey, bannerItems, bannerText, bannerLook, limitPauseOf, browserTimeZone } from './api.mjs';
import { createScene, ROOM_IDS, STATUS_KINDS } from './scene/index.mjs';
import { PeopleList, AboutPanel, InboxPanel, TasksPanel, IssuePanel, LogPanel, AgentPanel, ConnectPanel, DesignForm, LibraryPanel } from './panels.mjs';
import { Button, Link, OFFICE_CSS } from './controls.mjs';
import { SlackSection } from './slack.mjs';
import { MailSection } from './mail.mjs';
import { ConnectorsSection } from './connectors.mjs';
import { PAGE_ROUTE } from './manifest.mjs';

const REFRESH_MS = 15000;

// 同じ origin の /api・起動係の口を読む（15 秒ごとに読み直す）
// 読みごとに番号を付け、新しい読みが始まった後に返ってきた古い応答（会社を切り替える前の読みなど）は捨てる。
// 失敗の時は前のデータを残す（一時の失敗で画面の言語や欄が変わらない）。loaded は 1 回でも読めたか
function useFetched(fn, deps, every = REFRESH_MS) {
  const [state, setState] = useState({ data: null, error: null, loaded: false });
  const seq = useRef(0);
  const load = useCallback(async () => {
    const my = ++seq.current;
    try { const data = await fn(); if (my === seq.current) setState({ data, error: null, loaded: true }); }
    catch (error) { if (my === seq.current) setState(s => ({ ...s, error })); }
  }, deps); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    setState({ data: null, error: null, loaded: false }); load();
    const id = every ? setInterval(load, every) : null;
    return () => { seq.current++; if (id) clearInterval(id); };
  }, [load, every]);
  return { ...state, reload: load };
}
// worker のデータも、欄を開いている間は 15 秒ごとに読み直す
function useEvery(refresh) { useEffect(() => { const id = setInterval(() => refresh?.(), REFRESH_MS); return () => clearInterval(id); }, [refresh]); }

function IssueLoader({ companyId, issueId, ...rest }) {
  const issue = usePluginData('issue', { companyId, issueId });
  useEvery(issue.refresh);
  return h(IssuePanel, { issue, ...rest });
}
function AgentLoader({ companyId, agentId, ...rest }) {
  const work = usePluginData('agentWork', { companyId, agentId });
  useEvery(work.refresh);
  return h(AgentPanel, { work, ...rest });
}
function TasksLoader({ companyId, ...rest }) {
  const tasks = usePluginData('tasks', { companyId });
  useEvery(tasks.refresh);
  return h(TasksPanel, { tasks, ...rest });
}

function Scene({ agents, launcher, t, lang, onRoom, onAgent }) {
  const box = useRef(null), cv = useRef(null);
  const scene = useMemo(() => createScene({ width: 800, height: 600 }), []);
  const byTemplate = useMemo(() => ({ ...(launcher?.secretaryId ? { [launcher.secretaryId]: 'secretary' } : {}), ...Object.fromEntries(Object.entries(launcher?.agents || {}).map(([k, id]) => [id, k])) }), [launcher]);
  useEffect(() => {
    scene.seat((agents || []).map(a => ({ ...a, templateKey: byTemplate[a.id] || null, status: statusKey(a.status) })));
  }, [agents, byTemplate, scene]);
  const labels = useMemo(() => ({ room: Object.fromEntries(ROOM_IDS.map(r => [r, t(`room_${r}`)])), status: Object.fromEntries(STATUS_KINDS.map(s => [s, t(`status_${s}`)])) }), [t]);
  useEffect(() => {
    let raf = 0, dpr = 1;
    const size = () => {
      const el = box.current, c = cv.current; if (!el || !c) return;
      const r = el.getBoundingClientRect(); dpr = window.devicePixelRatio || 1;
      c.width = Math.round(r.width * dpr); c.height = Math.round(r.height * dpr);
      scene.layout({ width: r.width, height: r.height });
    };
    const frame = now => {
      const c = cv.current;
      if (c) { const g = c.getContext('2d'); g.setTransform(dpr, 0, 0, dpr, 0, 0); scene.tick(now); scene.draw(g, { lang, now, labels }); }
      raf = requestAnimationFrame(frame);
    };
    size(); const ro = new ResizeObserver(size); if (box.current) ro.observe(box.current);
    raf = requestAnimationFrame(frame);
    return () => { ro.disconnect(); cancelAnimationFrame(raf); };
  }, [scene, lang, labels]);
  const click = e => {
    const r = cv.current.getBoundingClientRect(), hit = scene.hit(e.clientX - r.left, e.clientY - r.top);
    if (hit?.type === 'agent') onAgent(hit.id); else if (hit?.type === 'room') onRoom(hit.id);
  };
  return h('div', { ref: box, style: { position: 'absolute', inset: 0 } },
    h('canvas', { ref: cv, 'data-office-canvas': '1', onClick: click, style: { width: '100%', height: '100%', display: 'block', cursor: 'pointer' } }));
}

export function OfficePage() {
  const { companyId, companyPrefix } = useHostContext();
  const api = useMemo(() => createApi(), []);
  // 起動係の無い所（本体だけ）では /setup/api/state が JSON でないので null（＝package の外）。読む前は undefined（欄は読み込み中）
  const launcherQ = useFetched(() => api.launcherState().catch(e => { if (e.status === 404) return null; throw e; }), [api]);
  const launcher = launcherQ.loaded ? launcherQ.data : undefined;
  const [langOverride, setLangOverride] = useState(null);
  const lang = pickLang(langOverride || launcher?.lang);
  const t = useMemo(() => translator(lang), [lang]);
  const prefix = companyPrefix || launcher?.company?.prefix || '';
  const agentsQ = usePluginData('agents', { companyId });
  const approvals = useFetched(() => api.approvals(companyId), [api, companyId]);
  const decisions = useFetched(() => api.decisions(companyId), [api, companyId]);
  const activity = useFetched(() => api.activity(companyId), [api, companyId]);
  // 知らせの plugin が無い所（404）は null で欄も帯の未読も出さない
  const notices = useFetched(() => api.notices(companyId).then(r => r?.notices || []).catch(e => { if (e.status === 404) return null; throw e; }), [api, companyId]);
  // AI の上限の画面の値（notify の /settings の limits: 止めた担当・直近の使用率・追加料金の設定）。notify が無い所（404）は null
  const limitsQ = useFetched(() => api.notifyLimits(companyId).then(r => r?.limits ?? null).catch(e => { if (e.status === 404) return null; throw e; }), [api, companyId]);
  const limits = limitsQ.data || null;
  // Slack に届けるの状態（知らせの plugin が無い所は 404 → null で欄も帯も出さない）
  const slackQ = useFetched(() => api.slackStatus(companyId).catch(e => { if (e.status === 404) return null; throw e; }), [api, companyId]);
  // メールで届けるの状態（起動係の口。起動係が無い所・知らせの plugin が無い所は 404 → null で欄も帯も出さない）
  const mailQ = useFetched(() => api.mailStatus(companyId).catch(e => { if (e.status === 404) return null; throw e; }), [api, companyId]);
  const [open, setOpen] = useState(null); // { kind, id }
  useEvery(agentsQ.refresh);
  const reloadInbox = useCallback(() => { approvals.reload(); decisions.reload(); activity.reload(); notices.reload(); limitsQ.reload(); agentsQ.refresh?.(); }, [approvals.reload, decisions.reload, activity.reload, notices.reload, limitsQ.reload, agentsQ.refresh]); // eslint-disable-line react-hooks/exhaustive-deps
  const agents = agentsQ.data || [];
  const close = () => setOpen(null);
  const onIssue = id => setOpen({ kind: 'issue', id });
  const pending = (approvals.data?.length || 0) + (decisions.data?.length || 0);
  // 起動係に時刻帯が無い（wizard を通らずに版上げで入った）時は、開いた時に 1 回ブラウザの時刻帯を残す
  const tzSent = useRef(false);
  useEffect(() => { if (launcher && !launcher.timeZone && !tzSent.current && browserTimeZone()) { tzSent.current = true; api.setLang(launcher.lang || lang).then(() => launcherQ.reload(), () => {}); } }, [launcher]); // eslint-disable-line react-hooks/exhaustive-deps
  const changeLang = async v => { setLangOverride(v); if (launcher) { try { await api.setLang(v); } catch { /* 保存できなくても画面は切り替える */ } launcherQ.reload(); } };

  if (!companyId) return h('p', null, t('loading'));
  // 見出しのボタン: 開いている欄のボタンは押された形（aria-pressed）。もう一度押すと閉じてオフィスに戻る
  const btn = (kind, label, extra) => h(Button, { key: kind, kind: 'tab', pressed: open?.kind === kind, 'data-open': kind, onClick: () => setOpen(o => (o?.kind === kind ? null : { kind })) }, label, extra);
  let panel = null;
  if (open?.kind === 'inbox') {
    const slack = h(SlackSection, { api, companyId, launcher, t, status: slackQ.loaded ? slackQ.data : undefined, focus: open.focus === 'slack', reload: () => { slackQ.reload(); launcherQ.reload(); notices.reload(); } });
    const mail = h(MailSection, { api, companyId, t, status: mailQ.loaded ? mailQ.data : undefined, focus: open.focus === 'mail', reload: () => { mailQ.reload(); notices.reload(); } });
    const connectors = h(ConnectorsSection, { api, t });
    panel = h(InboxPanel, { api, t, approvals, decisions, notices, limits, companyId, prefix, reload: reloadInbox, onClose: close, connectors, slack, mail });
  }
  else if (open?.kind === 'tasks') panel = h(TasksLoader, { companyId, t, onIssue, onClose: close });
  else if (open?.kind === 'log') panel = h(LogPanel, { activity, agents, t, onClose: close });
  // AI の契約の欄: 閉じる・切り替える（欄が消える）時に、待っている Claude のサインインを欄が取り消す（範囲 2026-11-18 F8）
  else if (open?.kind === 'connect') panel = h(ConnectPanel, { api, launcher, t, lang, limits, onClose: close });
  else if (open?.kind === 'issue') panel = h(IssueLoader, { key: open.id, companyId, issueId: open.id, t, prefix, onClose: close });
  else if (open?.kind === 'agent') panel = h(AgentLoader, { key: open.id, companyId, agentId: open.id, agent: agents.find(a => a.id === open.id), limitPause: limitPauseOf(limits, open.id), t, onIssue, onClose: close });
  else if (open?.kind === 'about') {
    panel = h(AboutPanel, { room: open.id, t, onClose: close },
      open.id === 'design' ? h(DesignForm, { api, companyId, launcher, lang, t, reloadLauncher: launcherQ.reload, onIssue }) : null,
      open.id === 'library' ? h(LibraryPanel, { api, companyId, t, lang, onIssue }) : null,
      open.id === 'ceo' ? h(Button, { kind: 'primary', 'data-open': 'inbox', onClick: () => setOpen({ kind: 'inbox' }), style: { marginTop: 8 } }, t('btn_inbox')) : null);
  }

  return h('div', { 'data-office': 'root', className: 'aio', lang, style: { display: 'flex', flexDirection: 'column', height: 'calc(100vh - 120px)', minHeight: 420, font: '14px/1.5 system-ui, sans-serif', color: 'var(--aio-fg)' } },
    h('style', null, OFFICE_CSS),
    h('header', { style: { display: 'flex', flexWrap: 'wrap', gap: 8, alignItems: 'center', padding: '8px 0 12px' } },
      h('h1', { style: { fontSize: 20, margin: '0 12px 0 0' } }, t('title')),
      btn('inbox', t('btn_inbox'), pending ? h('span', { 'data-inbox-count': pending, style: { marginLeft: 6, background: '#c62828', color: '#fff', borderRadius: 9, padding: '0 6px', fontSize: 12 } }, String(pending)) : null),
      btn('tasks', t('btn_tasks')), btn('log', t('btn_log')), btn('connect', t('btn_connect')),
      h('label', { style: { marginLeft: 'auto', display: 'flex', gap: 6, alignItems: 'center' } }, t('lang_label'),
        h('select', { value: lang, onChange: e => changeLang(e.target.value), 'data-lang': '1' }, ...LANGS.map(l => h('option', { key: l, value: l }, t(`lang_${l}`)))))),
    // 帯は常にある 1 つの入れ物に入れる（帯の数が変わっても後ろの欄の位置がずれず、受信箱などの状態が消えない）
    // 押せる帯（待っている件・AI の上限で止めた担当 → 受信箱・Slack に届いていない → 受信箱の Slack の欄）だけを Button にし、知らせるだけの帯は押せない形（role=alert・案内の色は role=status）にする
    h('div', { 'data-banners': '1' }, ...bannerItems({ pending, notices: notices.data, limits, launcher: launcherQ.error && launcherQ.error.status !== 404 ? 'down' : launcher, slack: slackQ.data, mail: mailQ.data }).map(b => {
      const text = bannerText(t, b), look = bannerLook(b.key);
      // 「Slack に届いていません」は押すと受信箱の Slack の欄に飛ぶ（S6）
      if (b.key === 'slack_failed') return h(Button, { key: b.key, kind: 'banner', 'data-banner': b.key, 'data-tone': look.tone, onClick: () => setOpen({ kind: 'inbox', focus: 'slack' }) }, text);
      // メールの帯も押すと受信箱のメールの欄に飛ぶ（M9）
      if (b.key === 'mail_failed' || b.key === 'mail_skipped' || b.key === 'mail_ca_env') return h(Button, { key: b.key, kind: 'banner', 'data-banner': b.key, 'data-tone': look.tone, onClick: () => setOpen({ kind: 'inbox', focus: 'mail' }) }, text);
      if (look.to) return h(Button, { key: b.key, kind: look.tone === 'alert' ? 'alert' : 'banner', 'data-banner': b.key, 'data-tone': look.tone, onClick: () => setOpen({ kind: look.to }) }, text);
      return h('div', { key: b.key, className: look.tone === 'info' ? 'aio-banner aio-banner-info' : 'aio-banner', role: look.tone === 'info' ? 'status' : 'alert', 'data-banner': b.key, 'data-tone': look.tone }, text);
    })),
    h('div', { style: { flex: 1, display: 'flex', gap: 12, minHeight: 0 } },
      h('div', { style: { position: 'relative', flex: 1, minWidth: 0, borderRadius: 10, overflow: 'hidden', background: '#e9dfc9' } },
        h(Scene, { agents, launcher, t, lang, onRoom: id => setOpen({ kind: 'about', id }), onAgent: id => setOpen({ kind: 'agent', id }) }),
        panel),
      h('aside', { style: { width: 200, flexShrink: 0, overflow: 'auto' } },
        h(PeopleList, { agents, t, selected: open?.kind === 'agent' ? open.id : null, onPick: id => setOpen({ kind: 'agent', id }) }),
        h('h3', { style: { fontSize: 14, margin: '16px 0 6px' } }, t('btn_about')),
        h('ul', { style: { listStyle: 'none', padding: 0, margin: 0 } }, ...ROOM_IDS.map(r => h('li', { key: r },
          h(Button, { kind: 'ghost', pressed: open?.kind === 'about' && open.id === r, 'data-room': r, style: { width: '100%' }, onClick: () => setOpen({ kind: 'about', id: r }) }, t(`room_${r}`))))))));
}

// 本体の横の一覧の「Office」（plugin の sidebar slot・範囲 2026-11-18 G4・F4）。会社の prefix が無い時は出さない。
// 言語は起動係の state から 1 回だけ読む（読めない時は英語）
export function OfficeSidebarLink({ context }) {
  const prefix = context?.companyPrefix || '';
  const [lang, setLang] = useState('en');
  useEffect(() => { let on = true; createApi().launcherState().then(s => { if (on) setLang(pickLang(s?.lang)); }, () => {}); return () => { on = false; }; }, []);
  if (!prefix) return null;
  const t = translator(lang);
  return h('div', { className: 'aio', 'data-office-sidebar': '1' }, h('style', null, OFFICE_CSS),
    h(Link, { kind: 'nav', href: `/${encodeURIComponent(prefix)}/${PAGE_ROUTE}`, 'data-office-nav': '1' },
      h('span', { 'aria-hidden': 'true', style: { display: 'inline-block', width: 10, height: 10, borderRadius: 3, background: 'var(--aio-accent)' } }), t('sidebar_office')));
}
