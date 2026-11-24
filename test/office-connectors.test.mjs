// office の「AI の連携」の欄の試験（試験用の小さな React で描いて押す）。範囲: docs/review/2026-11-22-notify-via-ai-connectors-scope.md 作り方 2・10
import test from 'node:test';
import assert from 'node:assert/strict';
import { register } from 'node:module';
import { readFileSync } from 'node:fs';
import { translator, DICT } from '../plugins/office/src/i18n.mjs';
import { createApi } from '../plugins/office/src/api.mjs';
register('./fixtures/react-alias-hooks.mjs', import.meta.url);
const R = await import('./fixtures/mini-react.mjs');
const { ConnectorsSection, connectorKey } = await import('../plugins/office/src/connectors.mjs');
const h = R.createElement;
const click = node => node.props.onClick({ preventDefault() {}, currentTarget: node });
const ok = (gmail, slack) => ({ codex: { state: 'ok', connectors: { gmail, slack }, checkedAt: '2026-11-22T09:00:00Z' }, claude: { state: 'unsupported' } });
const draw = (api, lang = 'en') => R.render(h(ConnectorsSection, { api, t: translator(lang) }));

test('つながっている連携は「つながっていそう」・無い連携は「つないでください」・目安と危険と Claude の案内を出す', async () => {
  for (const lang of ['en', 'ja']) {
    const t = translator(lang), calls = [];
    const root = draw({ connectors: async fresh => { calls.push(fresh); return ok('enabled', 'missing'); } }, lang);
    await R.settle();
    assert.equal(R.byAttr(root.tree, 'data-connectors').props['data-connectors'], 'ok');
    assert.equal(R.byAttr(root.tree, 'data-connector', 'gmail').props['data-connector-state'], 'enabled');
    const all = R.text(root.tree);
    assert.ok(all.includes(t('conn_gmail_enabled')) && all.includes(t('conn_slack_missing')));
    for (const k of ['conn_guess', 'conn_claude', 'conn_risk', 'conn_next']) assert.ok(all.includes(t(k)), k);
    assert.deepEqual(calls, [false], '開いた時は覚えた結果でよい');
    click(R.byAttr(root.tree, 'data-connectors-refresh')); await R.settle();
    assert.deepEqual(calls, [false, true], 'もう一度確かめるは fresh');
  }
});

test('状態ごとの文: つないでいない・サインイン中・分からない・確かめられない（決まった印だけ）', async () => {
  const t = translator('en');
  let root = draw({ connectors: async () => ({ codex: { state: 'not_connected', connectors: null, checkedAt: null }, claude: { state: 'unsupported' } }) }); await R.settle();
  assert.equal(R.byAttr(root.tree, 'data-connectors-msg').props['data-connectors-msg'], 'not_connected');
  assert.equal(R.byAttr(root.tree, 'data-connectors-guess'), null, '目安の文は ok の時だけ');
  root = draw({ connectors: async () => ({ codex: { state: 'busy', connectors: null, checkedAt: null }, claude: { state: 'unsupported' } }) }); await R.settle();
  assert.ok(R.text(root.tree).includes(t('conn_busy')));
  root = draw({ connectors: async () => ok('unknown', 'unknown') }); await R.settle();
  assert.ok(R.text(root.tree).includes(t('conn_unknown')));
  root = draw({ connectors: async () => ({ codex: { state: 'error', error: 'timeout', connectors: null, checkedAt: '2026-11-22T09:00:00Z' }, claude: { state: 'unsupported' } }) }); await R.settle();
  assert.ok(R.text(root.tree).includes(t('conn_e_timeout')));
  root = draw({ connectors: async () => ({ codex: { state: 'error', error: '<script>x', connectors: null }, claude: { state: 'unsupported' } }) }); await R.settle();
  assert.ok(R.text(root.tree).includes(t('conn_e_failed')) && !R.text(root.tree).includes('<script>'), '知らない印は決まった文に');
  root = draw({ connectors: async () => { throw Object.assign(new Error('x'), { status: 500 }); } }); await R.settle();
  assert.equal(R.byAttr(root.tree, 'data-connectors').props['data-connectors'], 'error');
  // 一度読めた後の読み直しが失敗したら、前の確かめた時刻を出さない（レビュー P3-3）
  let n = 0;
  root = draw({ connectors: async () => { n++; if (n === 1) return ok('enabled', 'enabled'); throw Object.assign(new Error('x'), { status: 500 }); } }); await R.settle();
  assert.ok(R.byAttr(root.tree, 'data-connectors-checked'));
  click(R.byAttr(root.tree, 'data-connectors-refresh')); await R.settle();
  assert.equal(R.byAttr(root.tree, 'data-connectors').props['data-connectors'], 'error');
  assert.equal(R.byAttr(root.tree, 'data-connectors-checked'), null);
  root = draw({ connectors: async () => { throw Object.assign(new Error('x'), { status: 404 }); } }); await R.settle();
  assert.equal(root.tree, null, '起動係の無い置き方では出さない');
});

test('文の key は辞書に英日とも在り、disabled も「つないでください」', () => {
  // 危険の文は範囲の文書と持ち主の答え（P1-2）より狭めない: どこへでも送れる・外のメールの指示（レビュー P2-1）
  assert.ok(DICT.ja.conn_risk.includes('誰にでも') && DICT.ja.conn_risk.includes('防げません'));
  assert.ok(DICT.en.conn_risk.includes('to anyone') && DICT.en.conn_risk.includes('cannot prevent'));
  // 欄の名前は画面の表記と同じ（英語は AI subscriptions）
  assert.ok(DICT.en.conn_not_connected.includes(DICT.en.connect_title) || DICT.en.conn_not_connected.includes('AI subscriptions'));
  assert.equal(connectorKey('gmail', 'disabled'), 'conn_gmail_missing');
  const keys = [...readFileSync(new URL('../plugins/office/src/connectors.mjs', import.meta.url), 'utf8').matchAll(/t\('(conn_[a-z_]+)'\)/g)].map(m => m[1]);
  for (const n of ['gmail', 'slack']) for (const s of ['enabled', 'missing']) keys.push(connectorKey(n, s));
  for (const s of ['ok', 'not_connected', 'busy', 'error']) keys.push(`conn_s_${s}`);
  for (const e of ['codex_missing', 'timeout', 'failed']) keys.push(`conn_e_${e}`);
  for (const k of new Set(keys)) { assert.ok(DICT.en[k], `en ${k}`); assert.ok(DICT.ja[k], `ja ${k}`); }
});

test('api の口は起動係の /setup/api/connectors（fresh の時だけ ?fresh=1）', async () => {
  const urls = [];
  const api = createApi(async url => { urls.push(url); return new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } }); });
  await api.connectors(false); await api.connectors(true);
  assert.deepEqual(urls.map(u => String(u).replace(/^https?:\/\/[^/]+/, '')), ['/setup/api/connectors', '/setup/api/connectors?fresh=1']);
});
