// 受信箱の「メールで届ける」の欄（docs/review/2026-11-19-mail-notify-scope.md の M1〜M10・r2・r3）。Slack の欄（slack.mjs）と同じ並び。
// - アドレスとアプリ パスワードは type=password・autocomplete=off。送り先は起動係の口だけ。保存の後は入力を空にし、伏せたアドレスと保存した日時だけを出す（M3）
// - 種類と形の選びは ON の前は画面の中だけで持ち、見本の口に渡す。「この形で ON にする」は見本の hash を起動係の確認の口へ送る（M1）
// - 文字は辞書の key から（英日）。a と button は Link・Button だけ
import { createElement as h, useEffect, useState } from 'react';
import { Button, Link, Status } from './controls.mjs';

const GOOGLE_DOCS = 'https://support.google.com/accounts/answer/185833';
const S = {
  box: { border: '1px solid var(--aio-line, rgba(0,0,0,.12))', borderRadius: 10, padding: 12, margin: '14px 0' },
  input: { width: '100%', boxSizing: 'border-box', padding: '7px 10px', borderRadius: 8, border: '1px solid var(--aio-line, rgba(0,0,0,.25))', font: 'inherit', background: 'transparent', color: 'inherit', marginTop: 4 },
  row: { display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center', marginTop: 8 },
  sample: { borderLeft: '4px solid #1a73e8', background: 'rgba(127,127,127,.08)', borderRadius: 6, padding: '8px 12px', margin: '8px 0', font: '14px/1.45 system-ui, sans-serif' },
  muted: { color: 'var(--aio-muted, #5c574f)', fontSize: 12 },
};
const ERR_KEYS = new Set(['mail_addr_bad', 'mail_pass_bad', 'mail_no_dest', 'mail_preview_stale', 'mail_off', 'mail_test_wait', 'mail_busy', 'mail_bad_choice']);
export const mailErrKey = e => { const c = String(e?.body?.error || ''); return ERR_KEYS.has(c) ? `mail_e_${c}` : 'mail_e_failed'; };
const When = ({ at, t }) => h('span', null, at ? new Date(at).toLocaleString() : t('slack_never'));

// 見本の 1 通（件名と本文。送る文と同じ）
export function MailSample({ msg }) {
  return h('div', { style: S.sample, 'data-mail-sample-msg': msg.kind },
    h('strong', { 'data-mail-sample-subject': '1' }, msg.subject),
    h('div', { style: { whiteSpace: 'pre-wrap', marginTop: 4 }, 'data-mail-sample-text': '1' }, msg.text));
}

// status: 起動係の GET /setup/api/mail の答え（undefined は読み込み中・null は起動係の口が無い）。reload: 状態を読み直す
export function MailSection({ api, companyId, t, status, reload = () => {}, focus = false }) {
  const [addr, setAddr] = useState(''), [pw, setPw] = useState('');
  const [kinds, setKinds] = useState(null), [form, setForm] = useState(null);
  const [preview, setPreview] = useState(null);
  const [msg, setMsg] = useState(null);
  useEffect(() => { if (focus && typeof document !== 'undefined') document.getElementById('aio-mail')?.scrollIntoView?.({ block: 'start' }); }, [focus]);
  if (status === null) return null;
  if (status === undefined) return h('section', { id: 'aio-mail', style: S.box, 'data-mail': 'loading' }, h('p', { style: S.muted }, t('loading')));
  const saved = !!status.saved;
  const curKinds = kinds || (status.on ? status.kinds : status.defaults?.kinds) || ['digest'];
  const curForm = form || (status.on ? status.form : status.defaults?.form) || 'titles';
  const choices = status.choices || ['digest'];
  const forms = status.forms || ['titles', 'counts'];
  const fail = e => setMsg({ tone: 'err', key: mailErrKey(e) });
  const stopped = !status.on && (status.offReason === 'dead' || status.offReason === 'resaved');
  const tone = status.on ? (status.failStreak >= 3 ? 'warn' : 'ok') : stopped ? 'err' : 'muted';
  const stateKey = status.on ? 'mail_state_on' : stopped ? 'mail_state_stopped' : 'mail_state_off';

  const save = async () => {
    setMsg(null);
    try { await api.mailSave(companyId, addr.trim(), pw); setAddr(''); setPw(''); setPreview(null); setMsg({ tone: 'ok', key: 'mail_saved' }); }
    catch (e) { fail(e); } // 失敗の時も入力は残す（直して押し直せる）。返事にアドレスもパスワードも無い
    reload();
  };
  const remove = async () => { setMsg(null); try { await api.mailRemove(companyId); setPreview(null); setMsg({ tone: 'ok', key: 'mail_removed' }); } catch (e) { fail(e); } reload(); };
  const showPreview = async () => { setMsg(null); try { setPreview(await api.mailPreview(companyId, curKinds, curForm)); } catch (e) { setPreview(null); fail(e); } };
  const turnOn = async () => { setMsg(null); try { await api.mailConfirm(companyId, curKinds, curForm, preview.hash); setMsg({ tone: 'ok', key: 'slack_on_done' }); setPreview(null); } catch (e) { fail(e); } reload(); };
  const turnOff = async () => { setMsg(null); try { await api.mailOff(companyId); setMsg({ tone: 'ok', key: 'slack_off_done' }); } catch (e) { fail(e); } reload(); };
  const test = async () => {
    setMsg(null);
    try { const r = await api.mailTest(companyId); setMsg(r?.result === 'ok' ? { tone: 'ok', key: 'mail_test_ok' } : { tone: 'err', key: 'mail_test_fail', code: String(r?.result || '') }); }
    catch (e) { fail(e); }
    reload();
  };
  const toggle = k => setKinds(curKinds.includes(k) ? curKinds.filter(x => x !== k) : [...curKinds, k]);

  return h('section', { id: 'aio-mail', style: S.box, 'data-mail': status.on ? 'on' : stopped ? 'stopped' : 'off' },
    h('div', { style: { display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' } },
      h('h3', { style: { margin: 0, fontSize: 15 } }, t('mail_title')), h(Status, { tone, text: t(stateKey), 'data-mail-state': stateKey })),
    h('p', { className: 'aio-help', style: { marginTop: 6 } }, t('mail_help')),
    h('ol', { style: { paddingLeft: 18, margin: '0 0 6px', fontSize: 13 } }, h('li', null, t('mail_step1')), h('li', null, t('mail_step2')), h('li', null, t('mail_step3'))),
    h('p', { style: { margin: '0 0 8px', fontSize: 13 } }, h(Link, { href: GOOGLE_DOCS, external: true }, t('mail_docs'))),
    h('p', { className: 'aio-help', 'data-mail-limit': '1' }, t('mail_limit')),
    // 止まった理由・状態（M9）
    stopped ? h('p', { className: 'aio-result', 'data-tone': 'err', 'data-mail-reason': status.offReason }, t(status.offCode === 'test_ca_env' ? 'mail_reason_test_ca_env' : `mail_reason_${status.offReason}`), status.offCode ? ` (${status.offCode})` : '') : null,
    status.on && status.stale ? h('p', { className: 'aio-result', 'data-tone': 'err', 'data-mail-stale': '1' }, t('mail_stale')) : null,
    status.on && status.dayBlocked ? h('p', { className: 'aio-result', 'data-tone': 'err', 'data-mail-day': '1' }, t('mail_day_limit')) : null,
    status.on && status.badCount > 0 ? h('p', { className: 'aio-result', 'data-tone': 'err', 'data-mail-skipped': '1' }, t('mail_skipped')) : null,
    status.on && status.failStreak >= 3 ? h('p', { className: 'aio-result', 'data-tone': 'err', 'data-mail-failing': '1' }, t('mail_failing')) : null,
    // 宛先（伏せたアドレスと保存した日時だけ）
    h('p', { 'data-mail-dest': saved ? 'saved' : 'none', style: { margin: '10px 0 4px' } },
      saved ? [h('span', { key: 'l', className: 'aio-label' }, t('mail_dest')), ': ', h('code', { key: 'm', 'data-mail-masked': '1' }, status.masked || ''), ' · ', t('mail_saved_at'), ' ', h(When, { key: 'w', at: status.savedAt, t })] : t('mail_dest_none')),
    h('label', { className: 'aio-label', style: { display: 'block' } }, t('mail_addr_label'),
      h('input', { type: 'text', autoComplete: 'off', spellCheck: false, value: addr, onChange: e => setAddr(e.target.value), placeholder: t('mail_addr_ph'), 'data-mail-addr': '1', style: S.input })),
    h('label', { className: 'aio-label', style: { display: 'block', marginTop: 6 } }, t('mail_pass_label'),
      h('input', { type: 'password', autoComplete: 'off', spellCheck: false, value: pw, onChange: e => setPw(e.target.value), placeholder: t('mail_pass_ph'), 'data-mail-pass': '1', style: S.input })),
    h('div', { style: S.row },
      h(Button, { kind: saved ? 'secondary' : 'primary', busyText: t('busy'), disabled: !addr.trim() || !pw.trim(), 'data-mail-save': '1', onClick: save }, t('mail_save')),
      saved ? h(Button, { busyText: t('busy'), 'data-mail-remove': '1', onClick: remove }, t('mail_remove')) : null),
    // 選び（ON の前は画面の中だけ）
    h('fieldset', { style: { border: 'none', padding: 0, margin: '12px 0 0' }, 'data-mail-kinds': '1' },
      h('legend', { className: 'aio-label' }, t('slack_kinds')),
      ...choices.map(k => h('label', { key: k, style: { display: 'block', fontSize: 14 } },
        h('input', { type: 'checkbox', checked: curKinds.includes(k), onChange: () => toggle(k), 'data-mail-kind': k }), ' ', t(`slack_kind_${k}`)))),
    h('label', { className: 'aio-label', style: { display: 'block', marginTop: 8 } }, t('slack_form'), ' ',
      h('select', { className: 'aio-select', value: curForm, onChange: e => setForm(e.target.value), 'data-mail-form': '1' }, ...forms.map(f => h('option', { key: f, value: f }, t(`slack_form_${f}`))))),
    h('div', { style: S.row },
      h(Button, { busyText: t('busy'), disabled: !saved || !curKinds.length, 'data-mail-preview': '1', onClick: showPreview }, t('slack_preview_btn'))),
    preview ? h('div', { 'data-mail-sample': '1', style: { marginTop: 8 } }, h('p', { className: 'aio-label', style: { margin: '4px 0' } }, t('slack_preview_title')), ...(preview.messages || []).map(m => h(MailSample, { key: m.kind, msg: m })),
      h('div', { style: S.row }, h(Button, { kind: 'primary', busyText: t('busy'), 'data-mail-on': '1', onClick: turnOn }, t('slack_turn_on')))) : null,
    status.on ? h('div', { style: S.row },
      h(Button, { busyText: t('busy'), 'data-mail-off': '1', onClick: turnOff }, t('slack_turn_off')),
      h(Button, { busyText: t('busy'), 'data-mail-test': '1', onClick: test }, t('slack_test_btn'))) : null,
    // 状態の行
    h('dl', { style: { display: 'grid', gridTemplateColumns: 'auto 1fr', gap: '2px 10px', fontSize: 13, margin: '10px 0 0' }, 'data-mail-status': '1' },
      h('dt', null, t('slack_last_ok')), h('dd', { style: { margin: 0 }, 'data-mail-last-ok': status.lastOkAt || '' }, h(When, { at: status.lastOkAt, t })),
      h('dt', null, t('mail_sent_today')), h('dd', { style: { margin: 0 }, 'data-mail-sent-today': String(status.sentToday ?? 0) }, String(status.sentToday ?? 0)),
      h('dt', null, t('slack_waiting')), h('dd', { style: { margin: 0 } }, String(status.waiting ?? 0)),
      status.lastFail ? h('dt', null, t('slack_last_fail')) : null,
      status.lastFail ? h('dd', { style: { margin: 0 }, 'data-mail-last-fail': status.lastFail.code || '' }, h(When, { at: status.lastFail.at, t }), ` · ${status.lastFail.status ?? '-'}${status.lastFail.ext ? ` ${status.lastFail.ext}` : ''} · ${status.lastFail.code || ''}`) : null,
      !status.on && status.offAt && status.offReason === 'owner' ? h('dt', null, t('mail_reason_owner')) : null,
      !status.on && status.offAt && status.offReason === 'owner' ? h('dd', { style: { margin: 0 } }, h(When, { at: status.offAt, t })) : null),
    msg ? h('p', { className: 'aio-result', 'data-tone': msg.tone, 'data-mail-msg': msg.key, role: 'status' }, t(msg.key).replace('{code}', msg.code || '')) : null);
}
