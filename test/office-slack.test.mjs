// office の「Slack に届ける」の欄と帯の試験（試験用の小さな React で描いて押す）。範囲: docs/review/2026-11-18-slack-notify-scope.md 作り方 4・S1・S3・S6
import test from 'node:test';
import assert from 'node:assert/strict';
import { register } from 'node:module';
import { readFileSync } from 'node:fs';
import { translator, DICT } from '../plugins/office/src/i18n.mjs';
import { bannerItems, slackFailing, createApi } from '../plugins/office/src/api.mjs';
register('./fixtures/react-alias-hooks.mjs', import.meta.url);
const R = await import('./fixtures/mini-react.mjs');
const { SlackSection, slackErrKey } = await import('../plugins/office/src/slack.mjs');
const h = R.createElement;
const URL1 = 'https://hooks.slack.com/services/T0OFFICE1/B0OFFICE1/officeSecretPart';
const click = node => node.props.onClick({ preventDefault() {}, currentTarget: node });
const base = { v: 1, on: false, configured: false, kinds: ['digest'], form: 'titles', choices: ['digest', 'approval', 'decision', 'run_failing', 'stuck'], forms: ['titles', 'counts'], defaults: { kinds: ['digest'], form: 'titles' }, waiting: 0, dropped: 0, failStreak: 0, lastOkAt: null, lastFail: null };
const err = (status, error) => Object.assign(new Error(error), { status, body: { error } });
function fakeApi(over = {}) {
  const calls = [];
  const rec = (n, fn) => (...a) => { calls.push([n, ...a]); return fn(...a); };
  return { calls, api: {
    slackSave: rec('save', async () => ({ ok: true, saved: { masked: 'x', savedAt: '2026-11-18T09:00:00Z' } })),
    slackRemove: rec('remove', async () => ({ ok: true })),
    slackPreview: rec('preview', async () => ({ v: 1, hash: 'h'.repeat(32), messages: [{ kind: 'digest', text: 'Morning summary: 2 waiting', blocks: [{ type: 'section', text: { type: 'mrkdwn', text: '*Morning summary: 2 waiting*' } }, { type: 'section', text: { type: 'mrkdwn', text: '• Approve &lt;!here&gt; plan\n• Stuck: report' } }, { type: 'actions', elements: [{ type: 'button', text: { type: 'plain_text', text: 'Open AI Office' }, url: 'http://localhost:3100/ACM/office' }] }] }] })),
    slackConfirm: rec('confirm', async () => ({ on: true })),
    slackOff: rec('off', async () => ({ on: false })),
    slackTest: rec('test', async () => ({ result: 'ok' })),
    ...over,
  } };
}
const draw = (props, lang = 'en') => R.render(h(SlackSection, { companyId: 'c1', t: translator(lang), launcher: { slack: {} }, reload() {}, ...props }));
const domText = root => JSON.stringify(root.tree);

for (const lang of ['en', 'ja']) {
  const t = translator(lang);
  test(`Slack の欄（${lang}）: 空の状態・入力は password で autocomplete=off・保存の後は入力を空にし伏せた印だけ・URL の文字が画面に無い`, async () => {
    const f = fakeApi();
    const root = draw({ api: f.api, status: base }, lang);
    assert.equal(R.byAttr(root.tree, 'data-slack').props['data-slack'], 'off');
    assert.ok(R.text(root.tree).includes(t('slack_title')) && R.text(root.tree).includes(t('slack_dest_none')) && R.text(root.tree).includes(t('slack_limit')));
    const input = R.byAttr(root.tree, 'data-slack-url');
    assert.equal(input.props.type, 'password'); assert.equal(input.props.autoComplete, 'off');
    assert.equal(R.byAttr(root.tree, 'data-slack-preview').props.disabled, true, '宛先の前は見本を出せない');
    assert.equal(R.byAttr(root.tree, 'data-slack-test'), null, 'OFF の時は試しの 1 通を押せない');
    input.props.onChange({ target: { value: URL1 } }); await R.settle();
    await click(R.byAttr(root.tree, 'data-slack-save')); await R.settle();
    assert.deepEqual(f.calls[0], ['save', 'c1', URL1]);
    assert.equal(R.byAttr(root.tree, 'data-slack-url').props.value, '', '保存の後は空');
    assert.equal(R.byAttr(root.tree, 'data-slack-msg').props['data-slack-msg'], 'slack_saved');
    root.update(h(SlackSection, { api: f.api, companyId: 'c1', t, launcher: { slack: { c1: { savedAt: '2026-11-18T09:00:00Z' } } }, status: { ...base, configured: true }, reload() {} })); await R.settle();
    assert.equal(R.byAttr(root.tree, 'data-slack-dest').props['data-slack-dest'], 'saved');
    assert.ok(R.text(root.tree).includes('hooks.slack.com/services/••••'));
    for (const part of URL1.split('/').slice(4)) assert.ok(!domText(root).includes(part), `画面に ${part}`);
  });

  test(`Slack の欄（${lang}）: 見本は Slack の形（見出し・行・ボタン）で出し、ON は見本の hash と画面の選びを送る・古い見本は断られて文を出す`, async () => {
    const f = fakeApi();
    const root = draw({ api: f.api, status: { ...base, configured: true }, launcher: { slack: { c1: { savedAt: '2026-11-18T09:00:00Z' } } } }, lang);
    R.byAttr(root.tree, 'data-slack-kind', 'approval').props.onChange(); await R.settle();
    await click(R.byAttr(root.tree, 'data-slack-preview')); await R.settle();
    assert.deepEqual(f.calls.at(-1), ['preview', 'c1', ['digest', 'approval'], 'titles']);
    const sample = R.byAttr(root.tree, 'data-slack-sample-msg', 'digest');
    assert.equal(R.text(R.byAttr(sample, 'data-slack-sample-head')), 'Morning summary: 2 waiting');
    assert.ok(R.text(R.byAttr(sample, 'data-slack-sample-lines')).includes('Approve <!here> plan'), '文字として出す');
    assert.equal(R.text(R.byAttr(sample, 'data-slack-sample-button')), 'Open AI Office');
    assert.equal(R.findAll(root.tree, n => n.type === 'a' && /localhost:3100\/ACM/.test(n.props.href || '')).length, 0, '見本のボタンは押せない印');
    // 見本の後に形を替えて押す → 起動係と plugin が 409
    f.api.slackConfirm = async (...a) => { f.calls.push(['confirm', ...a]); throw err(409, 'slack_preview_stale'); };
    R.byAttr(root.tree, 'data-slack-form').props.onChange({ target: { value: 'counts' } }); await R.settle();
    await click(R.byAttr(root.tree, 'data-slack-on')); await R.settle();
    assert.deepEqual(f.calls.at(-1), ['confirm', 'c1', ['digest', 'approval'], 'counts', 'h'.repeat(32)]);
    assert.equal(R.byAttr(root.tree, 'data-slack-msg').props['data-slack-msg'], 'slack_e_slack_preview_stale');
    assert.ok(R.text(root.tree).includes(t('slack_e_slack_preview_stale')));
  });

  test(`Slack の欄（${lang}）: ON の状態は OFF と試しの 1 通・最後に届いた時刻。止まった時は理由と Slack の短い答え`, async () => {
    const f = fakeApi();
    const root = draw({ api: f.api, status: { ...base, configured: true, on: true, lastOkAt: '2026-11-18T09:05:00Z', kinds: ['digest', 'approval'] }, launcher: { slack: { c1: { savedAt: 'x' } } } }, lang);
    assert.equal(R.byAttr(root.tree, 'data-slack').props['data-slack'], 'on');
    assert.equal(R.byAttr(root.tree, 'data-slack-kind', 'approval').props.checked, true, 'ON の時は ON にした時の選びを出す');
    assert.equal(R.byAttr(root.tree, 'data-slack-last-ok').props['data-slack-last-ok'], '2026-11-18T09:05:00Z');
    await click(R.byAttr(root.tree, 'data-slack-test')); await R.settle();
    assert.equal(R.byAttr(root.tree, 'data-slack-msg').props['data-slack-msg'], 'slack_test_ok');
    await click(R.byAttr(root.tree, 'data-slack-off')); await R.settle();
    assert.deepEqual(f.calls.map(c => c[0]), ['test', 'off']);
    const stopped = draw({ api: f.api, status: { ...base, configured: true, on: false, offReason: 'dead', offCode: 'no_service', lastFail: { at: '2026-11-18T09:06:00Z', status: 404, code: 'no_service' } } }, lang);
    assert.equal(R.byAttr(stopped.tree, 'data-slack').props['data-slack'], 'stopped');
    assert.ok(R.text(R.byAttr(stopped.tree, 'data-slack-reason')).includes('no_service'));
    assert.ok(R.text(R.byAttr(stopped.tree, 'data-slack-last-fail')).includes('404'));
    assert.ok(R.text(stopped.tree).includes(t('slack_state_stopped')));
  });
}

test('帯: 宛先が使えない時と送り直しが 3 回続いた時だけ「Slack に届いていません」・直ると消える', () => {
  const L = { lang: 'en', timeZone: 'Asia/Tokyo', rounds: {} };
  const keys = slack => bannerItems({ notices: [], launcher: L, slack }).map(b => b.key);
  assert.deepEqual(keys(null), []);
  assert.deepEqual(keys({ on: false, offReason: 'owner' }), []);
  assert.deepEqual(keys({ on: false, offReason: 'dead' }), ['slack_failed']);
  assert.deepEqual(keys({ on: true, failStreak: 2 }), []);
  assert.deepEqual(keys({ on: true, failStreak: 3 }), ['slack_failed']);
  assert.deepEqual(keys({ on: true, failStreak: 0 }), [], '直ると消える');
  assert.equal(slackFailing(undefined), false);
  for (const l of ['en', 'ja']) assert.ok(DICT[l].banner_slack_failed);
  const ui = readFileSync(new URL('../plugins/office/src/ui.mjs', import.meta.url), 'utf8');
  assert.match(ui, /b\.key === 'slack_failed'\) return h\(Button, \{[^}]*setOpen\(\{ kind: 'inbox', focus: 'slack' \}\)/, '押すと受信箱の Slack の欄へ');
});

test('画面の口: webhook の URL は起動係の口にだけ送り、本体の plugin の口には載せない', async () => {
  const calls = [];
  const api = createApi(async (url, init) => { calls.push({ url, body: init.body }); return { ok: true, json: async () => ({}) }; });
  await api.slackSave('c1', URL1); await api.slackPreview('c1', ['digest'], 'titles'); await api.slackConfirm('c1', ['digest'], 'titles', 'h'); await api.slackOff('c1'); await api.slackTest('c1'); await api.slackStatus('c1'); await api.slackRemove('c1');
  for (const c of calls) if (String(c.body || '').includes('hooks.slack.com')) assert.equal(c.url, '/setup/api/slack');
  assert.equal(calls.filter(c => String(c.body || '').includes('hooks.slack.com')).length, 1);
  assert.ok(calls.find(c => c.url.startsWith('/setup/api/slack/confirm')), 'ON は起動係を通す');
  assert.ok(calls.find(c => c.url.startsWith('/setup/api/slack/preview')), '見本は起動係を通す');
  assert.equal(slackErrKey(err(409, 'slack_dest_changed')), 'slack_e_slack_dest_changed');
  assert.equal(slackErrKey(err(500, 'weird <x>')), 'slack_e_failed');
  assert.equal(slackErrKey(err(409, 'slack_port')), 'slack_e_slack_port');
  for (const l of ['en', 'ja']) assert.match(DICT[l].slack_e_slack_port, /3100/, l);
});

test('注意書き: 保証より広く言わない（担当は持ち主の確認そのものを作れる・止めるのは口を直に叩く形と取り違えだけ）', () => {
  const en = DICT.en.slack_limit, ja = DICT.ja.slack_limit;
  assert.match(en, /make the owner's confirmation itself/); assert.match(en, /calling the notices plugin directly/); assert.match(en, /mix-ups/);
  assert.match(ja, /持ち主の確認そのものを作って/); assert.match(ja, /直に叩く/); assert.match(ja, /取り違え/);
  for (const s of [en, ja]) assert.ok(!/hidden|紛れた|隠れた/.test(s), '課題の文に隠れた指示を止めるとは言わない');
});

test('辞書: 欄が使う key は英日にある', () => {
  const src = readFileSync(new URL('../plugins/office/src/slack.mjs', import.meta.url), 'utf8');
  const used = new Set([...src.matchAll(/\bt\('([a-z_]+)'\)/g)].map(m => m[1]));
  for (const k of ['digest', 'approval', 'decision', 'run_failing', 'stuck']) used.add(`slack_kind_${k}`);
  for (const k of ['titles', 'counts']) used.add(`slack_form_${k}`);
  for (const k of ['owner', 'dead', 'dest_changed']) used.add(`slack_reason_${k}`);
  for (const k of ['slack_url_bad', 'slack_preview_stale', 'slack_dest_changed', 'slack_no_dest', 'slack_not_owner', 'slack_off', 'slack_test_wait', 'slack_busy', 'slack_bad_choice', 'slack_port']) used.add(`slack_e_${k}`);
  for (const k of used) for (const l of ['en', 'ja']) assert.ok(k in DICT[l], `${l}.${k}`);
});
