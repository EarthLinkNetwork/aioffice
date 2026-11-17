// 受信箱の「AI の連携」の欄（docs/review/2026-11-22-notify-via-ai-connectors-scope.md の作り方 2・10・裁定 L1295655c）
// - 起動係の口 GET /setup/api/connectors の状態の語だけを出す（連携の id・アカウント・生の出力は口に無い）
// - 一覧は目安。「この連携で届けます」は試しの 1 通が届いた後の段で出す。この欄は「つながっていそう」「つないでください」まで
// - v1 は ChatGPT（Codex）だけ。Claude は調べられないので、下の会社向けの道（Slack の Webhook・メールのアプリ パスワード）へ案内する
// - 持ち主が受け入れた危険（P1-2）を欄に書く: 連携をつなぐと、その ChatGPT のアカウントで動く担当は Gmail を読み・送れる
// - 文字は辞書の key から（英日）。button は Button だけ
import { createElement as h, useEffect, useState } from 'react';
import { Button, Status } from './controls.mjs';

const S = {
  box: { border: '1px solid var(--aio-line, rgba(0,0,0,.12))', borderRadius: 10, padding: 12, margin: '14px 0' },
  row: { display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center', marginTop: 8 },
  muted: { color: 'var(--aio-muted, #5c574f)', fontSize: 12 },
};
const NAMES = ['gmail', 'slack'];
const ERRS = new Set(['codex_missing', 'timeout', 'failed']);

// 1 つの連携の行の文の key（状態の語 → 文）
export const connectorKey = (name, state) => {
  if (state === 'enabled') return `conn_${name}_enabled`;
  if (state === 'unknown') return 'conn_unknown';
  return `conn_${name}_missing`; // missing・disabled はどちらも「つないでください」
};

export function ConnectorsSection({ api, t }) {
  const [data, setData] = useState(undefined);
  const [failed, setFailed] = useState(false);
  const load = async fresh => {
    try { setData(await api.connectors(fresh)); setFailed(false); }
    catch (e) { if (e?.status === 404) setData(null); else setFailed(true); }
  };
  useEffect(() => { load(false); }, [api]); // eslint-disable-line react-hooks/exhaustive-deps
  if (data === null) return null; // 起動係の無い置き方（Paperclip だけ）では出さない
  const head = h('div', { style: { display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' } }, h('h3', { style: { margin: 0, fontSize: 15 } }, t('conn_title')));
  const help = h('p', { className: 'aio-help', style: { marginTop: 6 } }, t('conn_help'));
  if (data === undefined && !failed) return h('section', { id: 'aio-connectors', style: S.box, 'data-connectors': 'loading' }, head, h('p', { style: S.muted }, t('loading')));
  const cx = data?.codex || {};
  const state = failed ? 'error' : cx.state;
  let body;
  if (state === 'ok') {
    body = h('ul', { style: { paddingLeft: 18, margin: '6px 0', fontSize: 13 } },
      ...NAMES.map(n => { const st = cx.connectors?.[n] || 'unknown'; return h('li', { key: n, 'data-connector': n, 'data-connector-state': st }, t(connectorKey(n, st))); }));
  } else if (state === 'not_connected') body = h('p', { 'data-connectors-msg': 'not_connected' }, t('conn_not_connected'));
  else if (state === 'busy') body = h('p', { 'data-connectors-msg': 'busy' }, t('conn_busy'));
  else body = h('p', { className: 'aio-result', 'data-tone': 'err', 'data-connectors-msg': 'error' }, t(ERRS.has(cx.error) ? `conn_e_${cx.error}` : 'conn_e_failed'));
  const tone = state === 'ok' && NAMES.some(n => cx.connectors?.[n] === 'enabled') ? 'ok' : state === 'error' ? 'err' : 'muted';
  return h('section', { id: 'aio-connectors', style: S.box, 'data-connectors': state || 'error' },
    head, help,
    h('p', { style: { margin: '6px 0 0', fontWeight: 600, fontSize: 13 } }, t('conn_chatgpt'), ' ', h(Status, { tone, text: t(`conn_s_${state === 'ok' ? 'ok' : state === 'not_connected' ? 'not_connected' : state === 'busy' ? 'busy' : 'error'}`), 'data-connectors-state': state || 'error' })),
    body,
    state === 'ok' ? h('p', { className: 'aio-help', 'data-connectors-guess': '1' }, t('conn_guess')) : null,
    h('p', { className: 'aio-help', 'data-connectors-claude': '1' }, t('conn_claude')),
    h('p', { className: 'aio-help', 'data-connectors-risk': '1' }, t('conn_risk')),
    h('p', { className: 'aio-help', 'data-connectors-next': '1' }, t('conn_next')),
    h('div', { style: S.row },
      h(Button, { busyText: t('busy'), 'data-connectors-refresh': '1', onClick: () => load(true) }, t('conn_refresh')),
      !failed && cx.checkedAt ? h('span', { style: S.muted, 'data-connectors-checked': '1' }, t('conn_checked'), ': ', new Date(cx.checkedAt).toLocaleString()) : null));
}
