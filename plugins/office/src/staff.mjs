// 「人」の欄（持ち主だけ・設計 docs/design/2026-11-23-public-office-multi-user.md 2.5）
// - 招く: 起動係が本体の招待を作り、URL を出す。持ち主が相手に渡す
// - 人ごとに 肩書き・上の人（承認はこの順に上がって戻る）・知らせのメール（本人が書いた住所を持ち主が確かめた物だけ）
// - 文字は辞書の key から（英日）。a と button は Link・Button だけ
import { createElement as h, useEffect, useState } from 'react';
import { Button } from './controls.mjs';
import { Panel } from './panels.mjs';

const S = {
  box: { border: '1px solid var(--aio-line, rgba(0,0,0,.12))', borderRadius: 10, padding: 12, margin: '10px 0' },
  input: { boxSizing: 'border-box', padding: '6px 8px', borderRadius: 8, border: '1px solid var(--aio-line, rgba(0,0,0,.25))', font: 'inherit', background: 'transparent', color: 'inherit' },
  row: { display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center', marginTop: 6 },
  muted: { color: 'var(--aio-muted, #5c574f)', fontSize: 12 },
  warn: { color: 'var(--aio-err, #b3261e)', fontSize: 12 },
  url: { wordBreak: 'break-all', fontFamily: 'ui-monospace, monospace', fontSize: 12, padding: '6px 8px', background: 'rgba(127,127,127,.1)', borderRadius: 6 },
};
const ERR = new Set(['boss_loop', 'boss_self', 'person_unknown', 'invite_failed', 'company_first']);
const errKey = e => { const c = String(e?.body?.error || ''); return ERR.has(c) ? `staff_e_${c}` : 'staff_e_failed'; };

export function StaffPanel({ api, companyId, t, onClose }) {
  const [rows, setRows] = useState(null), [err, setErr] = useState(null), [invite, setInvite] = useState(null);
  const load = () => api.people().then(r => { setRows(r.people || []); setErr(null); }, e => setErr(errKey(e)));
  useEffect(() => { load(); }, [api]);
  const save = async (userId, patch) => { try { const r = await api.savePerson({ userId, ...patch }); setRows(r.people || []); setErr(null); } catch (e) { setErr(errKey(e)); load(); } };
  const doInvite = async () => { try { const r = await api.invite(companyId); setInvite(r.inviteUrl); setErr(null); } catch (e) { setErr(errKey(e)); } };
  return h(Panel, { title: t('staff_title'), t, onClose, id: 'staff' },
    h('p', { style: S.muted }, t('staff_help')),
    h('p', { style: S.warn, 'data-staff-trust': '1' }, t('staff_trust')),
    h('div', { style: S.row }, h(Button, { kind: 'primary', 'data-staff-invite': '1', busyText: t('busy'), onClick: doInvite }, t('staff_invite'))),
    invite ? h('div', { style: S.box, 'data-staff-invite-url': '1' }, h('p', { style: S.muted }, t('staff_invite_help')), h('div', { style: S.url }, invite)) : null,
    err ? h('p', { style: S.warn, role: 'alert', 'data-staff-error': err }, t(err)) : null,
    rows == null ? h('p', null, t('loading')) : rows.map(p => h('div', { key: p.userId, style: S.box, 'data-person': p.userId },
      h('strong', null, p.name || p.email), ' ', h('span', { style: S.muted }, p.email),
      h('div', { style: S.row },
        h('label', null, t('staff_role'), ' ', h('input', { style: S.input, defaultValue: p.title || '', maxLength: 80, 'data-person-title': p.userId, onBlur: e => { if (e.target.value !== (p.title || '')) save(p.userId, { title: e.target.value }); } })),
        h('label', null, t('staff_boss'), ' ', h('select', { style: S.input, value: p.boss || '', 'data-person-boss': p.userId, onChange: e => save(p.userId, { boss: e.target.value || null }) },
          h('option', { value: '' }, t('staff_no_boss')),
          ...rows.filter(o => o.userId !== p.userId).map(o => h('option', { key: o.userId, value: o.userId }, o.name || o.email))))),
      h('div', { style: S.row },
        h('label', null, h('input', { type: 'checkbox', checked: !!p.mail, 'data-person-mail': p.userId, onChange: e => save(p.userId, { mailConfirmed: e.target.checked }) }), ' ', t('staff_mail_confirm'))),
      (p.warn || []).map(w => h('p', { key: w, style: w === 'boss_gone' ? S.warn : S.muted, 'data-person-warn': w }, t(`staff_w_${w}`))))));
}
