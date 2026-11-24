// 本体の画面「AI Office」（mock: docs/mocks/plugin-link-page-mock.html）: スマホとつなぐ・判断を受けるために承認する・つないでいるスマホ。
// 人は本体のログインで決まる（worker の操作は actor だけを使う）。承認の URL は押した本人の画面にだけ出る。
// React と SDK の UI は本体が渡す（build で外に出す）。JSX を使わず createElement で書く。
import { createElement as h, useCallback, useEffect, useRef, useState } from 'react';
import { linkView } from './link-view.mjs';
import { bindLinkOf, qrDataUrlOf } from './bind-link.mjs';
import { usePluginAction, useHostContext } from '@paperclipai/plugin-sdk/ui';

export const PAGE_ROUTE = 'ai-office';
const S = {
  wrap: { maxWidth: 720, margin: '0 auto', padding: 16, display: 'grid', gap: 12 },
  sec: { border: '1px solid rgba(127,127,127,.3)', borderRadius: 12, padding: 14, display: 'grid', gap: 8 },
  h2: { fontSize: 14, margin: 0, fontWeight: 700 },
  sub: { opacity: 0.7, fontSize: 12.5, margin: 0 },
  btn: { border: '1px solid rgba(127,127,127,.4)', borderRadius: 8, padding: '8px 14px', fontWeight: 700, cursor: 'pointer', justifySelf: 'start', background: 'transparent', color: 'inherit' },
  primary: { background: '#2c6bed', color: '#fff', borderColor: '#2c6bed' },
  small: { padding: '4px 10px', fontSize: 12 },
  code: { font: '700 24px/1.2 Menlo, monospace', letterSpacing: 3, padding: 10, border: '1px dashed rgba(127,127,127,.5)', borderRadius: 8, textAlign: 'center' },
  row: { display: 'flex', alignItems: 'center', gap: 10, padding: '6px 0', borderBottom: '1px solid rgba(127,127,127,.2)' },
  pill: { fontSize: 11, borderRadius: 999, padding: '1px 8px', background: 'rgba(47,138,87,.18)', color: '#2f8a57', marginLeft: 6 },
  alert: { borderLeft: '3px solid #b7791f', paddingLeft: 10, margin: 0 },
  lost: { borderLeft: '3px solid #d6452f', paddingLeft: 10, margin: 0 },
  actions: { display: 'flex', gap: 8, flexWrap: 'wrap' },
  err: { color: '#d6452f', fontSize: 12.5, margin: 0 },
};
const Btn = ({ label, onClick, primary, small, disabled }) => h('button', { type: 'button', onClick, disabled, style: { ...S.btn, ...(primary ? S.primary : {}), ...(small ? S.small : {}), ...(disabled ? { opacity: 0.5 } : {}) } }, label);
const Sec = ({ title, children }) => h('section', { style: S.sec }, h('h2', { style: S.h2 }, title), ...[].concat(children));
const fmtCode = c => String(c || '').replace(/[^A-Za-z0-9]/g, '').toUpperCase().match(/.{1,4}/g)?.join('-') || '';
const MSG = {
  'not-claimed:rejected': 'もう断られています。code を出し直してください', 'not-claimed:expired': '10 分で切れました。code を出し直してください',
  'not-issuer': 'code を出した人だけが「つなぐ」を押せます', 'not-member': '会社のメンバーでないため、つなげません',
  'not-linked': '先にスマホとつないでください', 'not-configured': 'この会社では会社ごとの判断を受ける設定（hostUrl）がありません。管理者に頼んでください',
  forbidden: '外せるのは自分の分と、会社の管理者だけです',
};
const msgOf = r => MSG[r?.reason] || (r?.reason ? `できませんでした（${r.reason}）` : 'できませんでした');

// 本体が渡す操作の関数は描画のたびに作り直されることがあるので、ref に置いて依存から外す（同じ取り直しを繰り返さない）
function useStableAction(key) {
  const fn = usePluginAction(key);
  const ref = useRef(fn); ref.current = fn;
  return useCallback(p => ref.current(p), []);
}

// 間隔ごとに fn を呼ぶ（on の間だけ）
function useEvery(on, ms, fn) {
  const ref = useRef(fn); ref.current = fn;
  useEffect(() => { if (!on) return undefined; const t = setInterval(() => ref.current(), ms); return () => clearInterval(t); }, [on, ms]);
}

function LinkSection({ onLinked }) {
  const start = useStableAction('link.start'); const pending = useStableAction('link.pending'); const confirm = useStableAction('link.confirm'); const remove = useStableAction('link.remove');
  const [pend, setPend] = useState([]); // 本体が覚えている「待っている / 名乗り出た」結びつけ（開き直しても戻る）
  const [w, setW] = useState(null); // この画面で出した code（code は記録しないので、出した画面だけが持つ）{ bindingId, code }
  const [err, setErr] = useState(null);
  const wRef = useRef(null); wRef.current = w;
  const refresh = useCallback(async () => {
    const r = await pending({}).catch(() => null);
    if (!Array.isArray(r)) return;
    setPend(r);
    const cur = wRef.current;
    if (cur && !r.some(p => p.bindingId === cur.bindingId)) { setW(null); setErr('10 分で切れました。code を出し直してください'); }
  }, [pending]);
  useEffect(() => { refresh(); }, [refresh]);
  const view = linkView(pend);
  useEvery(view.kind === 'waiting' || !!w, 3000, refresh);
  const go = async () => {
    setErr(null);
    try {
      const r = await start({});
      if (r.claimed) { await refresh(); return; } // 合間に相手が code を入れていた: 確認の表示に戻す
      setW({ bindingId: r.bindingId, code: r.code }); setPend([{ bindingId: r.bindingId, state: 'waiting', expiresAt: r.expiresAt || null, createdAt: new Date().toISOString() }]);
    } catch { setErr('code を出せませんでした。時間をおいてやり直してください'); }
  };
  const drop = async item => { if (w?.bindingId === item.bindingId) setW(null); await remove({ bindingId: item.bindingId }).catch(() => null); await refresh(); };
  const answer = async (item, accept) => {
    if (w?.bindingId === item.bindingId) setW(null); // 答えた結びつけは「切れた」扱いにしない
    const r = await confirm({ bindingId: item.bindingId, accept }).catch(() => ({ ok: false }));
    await refresh();
    if (accept && r.ok) onLinked(); else if (accept) setErr(msgOf(r));
  };
  if (view.kind === 'none') return h(Sec, { title: 'スマホとつなぐ' }, [h('p', { style: S.sub }, 'アプリの「会社とつなぐ」に、ここで出す code を入れます。'), h(Btn, { primary: true, label: 'スマホとつなぐ', onClick: go }), err ? h('p', { style: S.err }, err) : null]);
  if (view.kind === 'waiting') {
    const mine = w && w.bindingId === view.item.bindingId;
    return h(Sec, { title: 'スマホとつなぐ' }, [
      mine ? h(BindQr, { code: w.code }) : null,
      mine ? h('div', { style: S.code, 'aria-label': 'つなぐための code' }, fmtCode(w.code)) : h('p', { style: { margin: 0 } }, `待っている code があります${view.minutesLeft != null ? `（あと ${view.minutesLeft} 分）` : ''}。`),
      h('p', { style: S.sub }, mine ? 'iPhone のカメラで QR を読むと、アプリが開いて code が入ります。アプリで「つなぐ」を押してください。読めない時は、アプリの「会社とつなぐ」に code を入れてください。10 分で切れる・1 回だけ使える。' : 'code はこの画面を開き直したので出せません。出し直してください。'),
      h('p', { style: S.sub }, 'アプリで入れられるのを待っています…'),
      h('div', { style: S.actions }, mine ? null : h(Btn, { primary: true, label: 'code を出し直す', onClick: go }), h(Btn, { label: 'やめる', onClick: () => drop(view.item) })),
      err ? h('p', { style: S.err }, err) : null,
    ]);
  }
  return h(Sec, { title: 'スマホとつなぐ' }, [
    ...view.items.flatMap(item => [
      h('p', { key: `${item.bindingId}-q`, style: { margin: 0 } }, 'アプリで ', h('b', null, item.email || '（メールアドレスが読めません）'), ' が code を入れました。この人とつなぎますか。'),
      h('div', { key: `${item.bindingId}-a`, style: S.actions }, h(Btn, { primary: true, label: 'つなぐ', onClick: () => answer(item, true), disabled: !item.email }), h(Btn, { label: '断る', onClick: () => answer(item, false) })),
    ]),
    h('p', { style: S.sub }, 'メールアドレスが違う時は「断る」を押してください。code は使えなくなります。'),
    err ? h('p', { style: S.err }, err) : null,
  ]);
}

function KeySection({ linked, tick }) {
  const request = useStableAction('keys.request'); const status = useStableAction('keys.status');
  const [st, setSt] = useState(null);
  const [err, setErr] = useState(null);
  const [busy, setBusy] = useState(false);
  const load = useCallback(async () => {
    try { setSt(await status({})); } catch { setSt(s => s || { state: 'unknown' }); setErr('状態を読めませんでした。時間をおいて開き直してください'); }
  }, [status]);
  useEffect(() => { if (linked) load(); }, [linked, tick, load]);
  useEvery(st?.state === 'pending', 5000, load);
  if (!linked || !st) return null;
  // 押している間はボタンを押せなくする（依頼は worker の側でも 1 つにまとめる）。承認の画面は下のリンクから開く
  const ask = async () => {
    if (busy) return;
    setErr(null); setBusy(true);
    const r = await request({}).catch(() => ({ ok: false }));
    setBusy(false);
    if (!r.ok) { setErr(msgOf(r)); return; }
    setSt({ state: 'pending', approvalUrl: r.approvalUrl, expiresAt: r.expiresAt });
  };
  const btn = h(Btn, { primary: true, label: '判断を受けるために承認する', onClick: ask, disabled: busy });
  // 自動の更新は期限の 7 日前（renewAt）
  const days = st.renewAt ? Math.max(0, Math.ceil((Date.parse(st.renewAt) - Date.now()) / 86_400_000)) : null;
  const body = {
    none: [h('p', { style: { margin: 0 } }, '会社ごとの判断（選択肢つきの判断）も受けるには、1 回承認が要ります。押すまでは承認・判断カードだけが届きます。'), btn],
    pending: [
      h('p', { style: { margin: 0 } }, '承認の画面で「承認」を押してください。押すと 30 秒ほどで判断も届くようになります。'),
      st.approvalUrl ? h('div', { style: S.actions }, h('a', { href: st.approvalUrl, target: '_blank', rel: 'noopener', style: { ...S.btn, ...S.primary, textDecoration: 'none' } }, '承認の画面を開く')) : null,
      h('p', { style: S.sub }, '10 分で切れたら、もう一度「判断を受けるために承認する」を押してください。'),
    ],
    active: [h('p', { style: { margin: 0 } }, '判断も受けています。'), days != null ? h('p', { style: S.sub }, `あと ${days} 日で自動で更新します。`) : null],
    expiring: [h('p', { style: S.alert }, `あと ${st.daysLeft} 日で判断を受けられなくなります。自動の更新に失敗しました。承認し直してください。`), btn],
    lost: [h('p', { style: S.lost }, '判断を受けるための承認が切れました。今は承認・判断カードだけが届いています。'), btn],
    unknown: [],
  }[st.state] || [btn];
  return h(Sec, { title: '判断を受ける' }, [...body, err ? h('p', { style: S.err }, err) : null]);
}

function ListSection({ rows, reload, admin }) {
  const remove = useStableAction('link.remove'); const revokeAll = useStableAction('keys.revokeAll');
  const [err, setErr] = useState(null);
  const [note, setNote] = useState(null);
  const [sure, setSure] = useState(false);
  const all = async () => { setSure(false); const r = await revokeAll({}).catch(() => ({ ok: false })); if (r.ok) setNote(`全員の判断の承認を取り消しました（${r.revoked} 件${r.pending ? `・${r.pending} 件はやり直し中` : ''}）`); else setErr(msgOf(r)); reload(); };
  const out = async b => { const r = await remove({ bindingId: b.bindingId }).catch(() => ({ ok: false })); if (!r.ok) setErr(msgOf(r)); reload(); };
  return h(Sec, { title: 'つないでいるスマホ' }, [
    ...(rows.length ? rows.map(b => h('div', { key: b.bindingId, style: S.row }, h('span', { style: { flex: 1, minWidth: 0 } }, b.email || '（メールアドレスなし）', b.mine ? h('span', { style: S.pill }, 'あなた') : null), h(Btn, { small: true, label: '外す', onClick: () => out(b) })))
      : [h('p', { style: S.sub }, 'まだつないでいません。')]),
    h('p', { style: S.sub }, '自分の分と、会社の管理者は全員の分を外せます。外すと、そのスマホにこの会社の知らせは届かなくなります。'),
    admin ? h('div', { style: { display: 'grid', gap: 6, marginTop: 6 } },
      h('p', { style: S.sub }, 'この plugin を外す前に、全員の判断の承認を取り消してください（外すだけでは取り消されません）。'),
      sure ? h('div', { style: S.actions }, h(Btn, { label: '取り消す', onClick: all, primary: true }), h(Btn, { label: 'やめる', onClick: () => setSure(false) }))
        : h(Btn, { small: true, label: '全員の判断の承認を取り消す', onClick: () => setSure(true) })) : null,
    note ? h('p', { style: S.sub }, note) : null,
    err ? h('p', { style: S.err }, err) : null,
  ]);
}

export function AiOfficePage() {
  const list = useStableAction('link.list'); const role = useStableAction('link.role');
  const [rows, setRows] = useState([]);
  const [admin, setAdmin] = useState(false);
  useEffect(() => { role({}).then(r => setAdmin(!!r?.admin), () => setAdmin(false)); }, [role]);
  const [tick, setTick] = useState(0);
  const reload = useCallback(async () => { setRows((await list({}).catch(() => [])) || []); setTick(t => t + 1); }, [list]);
  useEffect(() => { reload(); }, [reload]);
  const linked = rows.some(r => r.mine);
  return h('div', { style: S.wrap }, [
    h('h1', { key: 't', style: { fontSize: 20, margin: 0 } }, 'AI Office'),
    h('p', { key: 'l', style: S.sub }, 'スマホのアプリとつなぐと、承認・判断カード・会社ごとの判断がスマホに届きます。'),
    h(LinkSection, { key: 'link', onLinked: reload }),
    h(KeySection, { key: 'key', linked, tick }),
    h(ListSection, { key: 'list', rows, reload, admin }),
  ]);
}

// 本体の左の並びの入口
export function AiOfficeSidebar() {
  const ctx = useHostContext();
  if (!ctx?.companyPrefix) return null;
  return h('a', { href: `/${encodeURIComponent(ctx.companyPrefix)}/${PAGE_ROUTE}`, style: { display: 'block', padding: '6px 12px', color: 'inherit', textDecoration: 'none' } }, 'AI Office');
}

// code の QR（aioffice://bind?code=…）。iPhone の標準のカメラで読むとアプリが開き、code が入る（送るのは本人が「つなぐ」を押した時）。作れない時は出さない（code は下に出る）
function BindQr({ code }) {
  let src = null;
  try { src = qrDataUrlOf(bindLinkOf(code)); } catch { return h('p', { style: S.sub }, 'この code は QR にできませんでした。下の code をアプリに入れてください。'); }
  return h('img', { src, alt: 'つなぐための QR（iPhone のカメラで読む）', width: 200, height: 200, style: { width: 200, height: 200, background: '#fff', borderRadius: 8, justifySelf: 'start' } });
}
