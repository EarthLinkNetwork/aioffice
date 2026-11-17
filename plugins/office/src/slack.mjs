// 受信箱の「Slack に届ける」の欄（docs/review/2026-11-18-slack-notify-scope.md 作り方 4・S1〜S7）。
// - URL の入力は type=password・autocomplete=off。送り先は起動係の口だけ。保存の後は入力を空にし、伏せた印と保存した日時だけを出す（S3）
// - 種類と形の選びは ON の前は画面の中だけで持ち、見本の口に渡す。「この形で ON にする」は見本の hash を起動係の確認の口へ送る（S1）
// - 文字は辞書の key から（英日）。a と button は Link・Button だけ
import { createElement as h, useEffect, useState } from 'react';
import { Button, Link, Status } from './controls.mjs';

const SLACK_DOCS = 'https://api.slack.com/messaging/webhooks';
const S = {
  box: { border: '1px solid var(--aio-line, rgba(0,0,0,.12))', borderRadius: 10, padding: 12, margin: '14px 0' },
  input: { width: '100%', boxSizing: 'border-box', padding: '7px 10px', borderRadius: 8, border: '1px solid var(--aio-line, rgba(0,0,0,.25))', font: 'inherit', background: 'transparent', color: 'inherit', marginTop: 4 },
  row: { display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center', marginTop: 8 },
  sample: { borderLeft: '4px solid #611f69', background: 'rgba(127,127,127,.08)', borderRadius: 6, padding: '8px 12px', margin: '8px 0', font: '14px/1.45 system-ui, sans-serif' },
  sampleBtn: { display: 'inline-block', marginTop: 6, padding: '3px 10px', border: '1px solid var(--aio-line, rgba(0,0,0,.3))', borderRadius: 4, fontWeight: 600, fontSize: 13 },
  muted: { color: 'var(--aio-muted, #5c574f)', fontSize: 12 },
};
const ERR_KEYS = new Set(['slack_url_bad', 'slack_preview_stale', 'slack_dest_changed', 'slack_no_dest', 'slack_not_owner', 'slack_off', 'slack_test_wait', 'slack_busy', 'slack_bad_choice', 'slack_port']);
export const slackErrKey = e => { const c = String(e?.body?.error || ''); return ERR_KEYS.has(c) ? `slack_e_${c}` : 'slack_e_failed'; };
// Slack の文字の置き換え（&amp; など）を、画面では Slack と同じ見え方に戻す（文字として出す・HTML にしない）
const unescape = s => String(s ?? '').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
const When = ({ at, t }) => h('span', null, at ? new Date(at).toLocaleString() : t('slack_never'));

// 見本の 1 通（Slack の見え方に近い形: 見出し・行・ボタン）
export function SlackSample({ msg }) {
  const secs = (msg.blocks || []).filter(b => b.type === 'section').map(b => unescape(b.text?.text));
  const btn = (msg.blocks || []).filter(b => b.type === 'actions').flatMap(b => b.elements || [])[0];
  return h('div', { style: S.sample, 'data-slack-sample-msg': msg.kind },
    h('strong', { 'data-slack-sample-head': '1' }, (secs[0] || '').replace(/^\*|\*$/g, '')),
    secs[1] ? h('div', { style: { whiteSpace: 'pre-wrap' }, 'data-slack-sample-lines': '1' }, secs[1]) : null,
    btn ? h('span', { style: S.sampleBtn, 'data-slack-sample-button': '1' }, btn.text?.text || '') : null);
}

// status: GET /slack の答え（undefined は読み込み中・null は知らせの plugin が無い）。reload: 状態と起動係の state を読み直す
export function SlackSection({ api, companyId, launcher, t, status, reload = () => {}, focus = false }) {
  const [url, setUrl] = useState('');
  const [kinds, setKinds] = useState(null), [form, setForm] = useState(null);
  const [preview, setPreview] = useState(null);
  const [msg, setMsg] = useState(null);
  useEffect(() => { if (focus && typeof document !== 'undefined') document.getElementById('aio-slack')?.scrollIntoView?.({ block: 'start' }); }, [focus]);
  if (status === null) return null;
  if (status === undefined) return h('section', { id: 'aio-slack', style: S.box, 'data-slack': 'loading' }, h('p', { style: S.muted }, t('loading')));
  const savedAt = launcher?.slack?.[companyId]?.savedAt || null;
  const curKinds = kinds || (status.on ? status.kinds : status.defaults?.kinds) || ['digest'];
  const curForm = form || (status.on ? status.form : status.defaults?.form) || 'titles';
  const choices = status.choices || ['digest'];
  const forms = status.forms || ['titles', 'counts'];
  const fail = e => setMsg({ tone: 'err', key: slackErrKey(e) });
  const stopped = !status.on && (status.offReason === 'dead' || status.offReason === 'dest_changed');
  const tone = status.on ? (status.failStreak >= 3 ? 'warn' : 'ok') : stopped ? 'err' : 'muted';
  const stateKey = status.on ? 'slack_state_on' : stopped ? 'slack_state_stopped' : 'slack_state_off';

  const save = async () => {
    setMsg(null);
    try { await api.slackSave(companyId, url.trim()); setUrl(''); setPreview(null); setMsg({ tone: 'ok', key: 'slack_saved' }); }
    catch (e) { fail(e); } // 失敗の時も入力は残す（直して押し直せる）。返事に URL は無い
    reload();
  };
  const remove = async () => { setMsg(null); try { await api.slackRemove(companyId); setPreview(null); setMsg({ tone: 'ok', key: 'slack_removed' }); } catch (e) { fail(e); } reload(); };
  const showPreview = async () => { setMsg(null); try { setPreview(await api.slackPreview(companyId, curKinds, curForm)); } catch (e) { setPreview(null); fail(e); } };
  // ON は見本の hash を送る（見本の後に選びを変えていれば、起動係と plugin が 409 で断る）
  const turnOn = async () => { setMsg(null); try { await api.slackConfirm(companyId, curKinds, curForm, preview.hash); setMsg({ tone: 'ok', key: 'slack_on_done' }); setPreview(null); } catch (e) { fail(e); } reload(); };
  const turnOff = async () => { setMsg(null); try { await api.slackOff(companyId); setMsg({ tone: 'ok', key: 'slack_off_done' }); } catch (e) { fail(e); } reload(); };
  const test = async () => {
    setMsg(null);
    try { const r = await api.slackTest(companyId); setMsg(r?.result === 'ok' ? { tone: 'ok', key: 'slack_test_ok' } : { tone: 'err', key: 'slack_test_fail', code: String(r?.result || '') }); }
    catch (e) { fail(e); }
    reload();
  };
  const toggle = k => setKinds(curKinds.includes(k) ? curKinds.filter(x => x !== k) : [...curKinds, k]);

  return h('section', { id: 'aio-slack', style: S.box, 'data-slack': status.on ? 'on' : stopped ? 'stopped' : 'off' },
    h('div', { style: { display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' } },
      h('h3', { style: { margin: 0, fontSize: 15 } }, t('slack_title')), h(Status, { tone, text: t(stateKey), 'data-slack-state': stateKey })),
    h('p', { className: 'aio-help', style: { marginTop: 6 } }, t('slack_help')),
    h('ol', { style: { paddingLeft: 18, margin: '0 0 6px', fontSize: 13 } }, h('li', null, t('slack_step1')), h('li', null, t('slack_step2')), h('li', null, t('slack_step3'))),
    h('p', { style: { margin: '0 0 8px', fontSize: 13 } }, h(Link, { href: SLACK_DOCS, external: true }, t('slack_docs'))),
    h('p', { className: 'aio-help', 'data-slack-limit': '1' }, t('slack_limit')),
    // 止まった理由・状態（S6）
    stopped ? h('p', { className: 'aio-result', 'data-tone': 'err', 'data-slack-reason': status.offReason }, t(`slack_reason_${status.offReason}`), status.offCode ? ` (${status.offCode})` : '') : null,
    status.on && status.rateLimited ? h('p', { className: 'aio-result', 'data-tone': 'err', 'data-slack-rate': '1' }, t('slack_rate')) : null,
    status.on && status.failStreak >= 3 ? h('p', { className: 'aio-result', 'data-tone': 'err', 'data-slack-failing': '1' }, t('slack_failing')) : null,
    // 宛先（伏せた印と保存した日時だけ）
    h('p', { 'data-slack-dest': savedAt ? 'saved' : 'none', style: { margin: '10px 0 4px' } },
      savedAt ? [h('span', { key: 'l', className: 'aio-label' }, t('slack_dest')), ': ', h('code', { key: 'm' }, t('slack_masked')), ' · ', t('slack_saved_at'), ' ', h(When, { key: 'w', at: savedAt, t })] : t('slack_dest_none')),
    h('label', { className: 'aio-label', style: { display: 'block' } }, t('slack_url_label'),
      h('input', { type: 'password', autoComplete: 'off', spellCheck: false, value: url, onChange: e => setUrl(e.target.value), placeholder: t('slack_url_ph'), 'data-slack-url': '1', style: S.input })),
    h('div', { style: S.row },
      h(Button, { kind: savedAt ? 'secondary' : 'primary', busyText: t('busy'), disabled: !url.trim(), 'data-slack-save': '1', onClick: save }, t('slack_save')),
      savedAt ? h(Button, { busyText: t('busy'), 'data-slack-remove': '1', onClick: remove }, t('slack_remove')) : null),
    // 選び（ON の前は画面の中だけ）
    h('fieldset', { style: { border: 'none', padding: 0, margin: '12px 0 0' }, 'data-slack-kinds': '1' },
      h('legend', { className: 'aio-label' }, t('slack_kinds')),
      ...choices.map(k => h('label', { key: k, style: { display: 'block', fontSize: 14 } },
        h('input', { type: 'checkbox', checked: curKinds.includes(k), onChange: () => toggle(k), 'data-slack-kind': k }), ' ', t(`slack_kind_${k}`)))),
    h('label', { className: 'aio-label', style: { display: 'block', marginTop: 8 } }, t('slack_form'), ' ',
      h('select', { className: 'aio-select', value: curForm, onChange: e => setForm(e.target.value), 'data-slack-form': '1' }, ...forms.map(f => h('option', { key: f, value: f }, t(`slack_form_${f}`))))),
    h('div', { style: S.row },
      h(Button, { busyText: t('busy'), disabled: !savedAt || !curKinds.length, 'data-slack-preview': '1', onClick: showPreview }, t('slack_preview_btn'))),
    preview ? h('div', { 'data-slack-sample': '1', style: { marginTop: 8 } }, h('p', { className: 'aio-label', style: { margin: '4px 0' } }, t('slack_preview_title')), ...(preview.messages || []).map(m => h(SlackSample, { key: m.kind, msg: m })),
      h('div', { style: S.row }, h(Button, { kind: 'primary', busyText: t('busy'), 'data-slack-on': '1', onClick: turnOn }, t('slack_turn_on')))) : null,
    status.on ? h('div', { style: S.row },
      h(Button, { busyText: t('busy'), 'data-slack-off': '1', onClick: turnOff }, t('slack_turn_off')),
      h(Button, { busyText: t('busy'), 'data-slack-test': '1', onClick: test }, t('slack_test_btn'))) : null,
    // 状態の行
    h('dl', { style: { display: 'grid', gridTemplateColumns: 'auto 1fr', gap: '2px 10px', fontSize: 13, margin: '10px 0 0' }, 'data-slack-status': '1' },
      h('dt', null, t('slack_last_ok')), h('dd', { style: { margin: 0 }, 'data-slack-last-ok': status.lastOkAt || '' }, h(When, { at: status.lastOkAt, t })),
      h('dt', null, t('slack_waiting')), h('dd', { style: { margin: 0 } }, String(status.waiting ?? 0)),
      status.lastFail ? h('dt', null, t('slack_last_fail')) : null,
      status.lastFail ? h('dd', { style: { margin: 0 }, 'data-slack-last-fail': status.lastFail.code || '' }, h(When, { at: status.lastFail.at, t }), ` · ${status.lastFail.status ?? '-'} · ${status.lastFail.code || ''}`) : null,
      status.dropped ? h('dt', null, t('slack_dropped')) : null, status.dropped ? h('dd', { style: { margin: 0 } }, String(status.dropped)) : null,
      !status.on && status.offAt && status.offReason === 'owner' ? h('dt', null, t('slack_reason_owner')) : null,
      !status.on && status.offAt && status.offReason === 'owner' ? h('dd', { style: { margin: 0 } }, h(When, { at: status.offAt, t })) : null),
    msg ? h('p', { className: 'aio-result', 'data-tone': msg.tone, 'data-slack-msg': msg.key, role: 'status' }, t(msg.key).replace('{code}', msg.code || '')) : null);
}
