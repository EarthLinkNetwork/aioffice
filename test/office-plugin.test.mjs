// office の plugin（plugins/office）の試験: 文言の英日・link の安全・画面の口・worker のデータ
import test from 'node:test';
import assert from 'node:assert/strict';
import { DICT, ABOUT, translator, pickLang } from '../plugins/office/src/i18n.mjs';
import { safeHref, createApi, decidableHere, statusKey } from '../plugins/office/src/api.mjs';
import { createHandlers } from '../plugins/office/src/worker.mjs';

test('文言: 英日の key が一致し、空の文言が無い', () => {
  const en = Object.keys(DICT.en).sort(), ja = Object.keys(DICT.ja).sort();
  assert.deepEqual(ja, en);
  for (const l of ['en', 'ja']) for (const [k, v] of Object.entries(DICT[l])) assert.ok(String(v).trim(), `${l}.${k} が空`);
  for (const [title, items] of Object.values(ABOUT)) for (const k of [title, ...items]) assert.ok(k in DICT.en, `${k} が辞書に無い`);
  assert.deepEqual(Object.keys(ABOUT), ['ceo', 'office', 'design', 'library', 'lounge']);
});

test('文言: 既定は英語・知らない言語も英語・知らない key は key のまま', () => {
  assert.equal(pickLang(undefined), 'en'); assert.equal(pickLang('fr'), 'en'); assert.equal(pickLang('ja'), 'ja');
  assert.equal(translator('ja')('inbox_title'), '受信箱');
  assert.equal(translator('xx')('inbox_title'), 'Inbox');
  assert.equal(translator('en')('no_such_key'), 'no_such_key');
});

test('文言: design の plugin が返すエラーの key は全部辞書にある', async () => {
  const src = await import('node:fs').then(fs => fs.readFileSync(new URL('../plugins/design/src/request.mjs', import.meta.url), 'utf8'));
  const keys = [...src.matchAll(/'(design_[a-z_]+)'/g)].map(m => m[1]);
  assert.ok(keys.length >= 5);
  for (const k of keys) assert.ok(k in DICT.en && k in DICT.ja, `${k} が辞書に無い`);
});

test('link: http(s) だけを link にする', () => {
  assert.equal(safeHref('https://example.com/a?b=1'), 'https://example.com/a?b=1');
  assert.equal(safeHref('http://x.test'), 'http://x.test/');
  for (const bad of ['javascript:alert(1)', 'JAVASCRIPT:alert(1)', 'data:text/html,x', 'vbscript:x', '//evil.test', '/relative', 'https://a b', 'java\nscript:x', '', null, undefined, 'mailto:a@b.test'])
    assert.equal(safeHref(bad), null, String(bad));
});

test('判断: 入力欄のある判断は office で押さない・担当の状態を分ける', () => {
  assert.equal(decidableHere({ options: [] }), true);
  assert.equal(decidableHere({ inputs: [] }), true);
  assert.equal(decidableHere({ inputs: [{ id: 'x' }] }), false);
  assert.equal(decidableHere({ inputs: { a: 1 } }), false);
  assert.deepEqual(['running', 'idle', 'active', 'paused', 'error', 'pending_approval', 'zzz', undefined].map(statusKey), ['running', 'idle', 'idle', 'paused', 'error', 'other', 'other', 'other']);
});

test('画面の口: 同じ origin・cookie・id は符号化・失敗は status つきで投げる', async () => {
  const calls = [];
  const api = createApi(async (url, init) => { calls.push([url, init]); return url.includes('fail') ? { ok: false, status: 409, json: async () => ({ error: 'already decided' }) } : { ok: true, status: 200, json: async () => ({ ok: 1 }) }; });
  await api.approve('a/b', 'ok');
  assert.equal(calls[0][0], '/api/approvals/a%2Fb/approve');
  assert.equal(calls[0][1].credentials, 'same-origin');
  assert.deepEqual(JSON.parse(calls[0][1].body), { decisionNote: 'ok' });
  await api.designRequest('c 1', { kind: 'logo' });
  assert.equal(calls[1][0], '/api/plugins/aioffice.design/api/request?companyId=c%201');
  await assert.rejects(api.decide('fail', 'o1'), e => e.status === 409 && e.message === 'already decided');
});

function fakeCtx() {
  const issues = [
    { id: 'i1', title: 'A', status: 'in_progress', assigneeAgentId: 'g1', updatedAt: '2026-11-15T01:00:00Z', description: 'x'.repeat(2000) },
    { id: 'i2', title: 'B', status: 'todo', assigneeAgentId: 'g1', updatedAt: '2026-11-15T03:00:00Z' },
    { id: 'i3', title: 'C', status: 'in_progress', assigneeAgentId: 'g2', updatedAt: '2026-11-15T02:00:00Z' },
    { id: 'i4', title: 'D', status: 'done', assigneeAgentId: 'g1', updatedAt: '2026-11-14T00:00:00Z' },
    { id: 'i5', title: 'E', status: 'blocked', assigneeAgentId: 'g2', updatedAt: '2026-11-13T00:00:00Z' },
  ];
  const seen = [];
  return {
    seen,
    agents: { list: async q => { seen.push(['agents', q]); return [{ id: 'g1', name: 'Sec', status: 'idle', adapterConfig: { secret: 'S' } }]; } },
    issues: {
      list: async q => { seen.push(['list', q]); return issues.filter(i => (!q.status || i.status === q.status) && (!q.assigneeAgentId || i.assigneeAgentId === q.assigneeAgentId)); },
      get: async (id, co) => { seen.push(['get', id, co]); return issues.find(i => i.id === id) ?? null; },
      listComments: async () => [1, 2, 3, 4].map(n => ({ id: `c${n}`, body: `b${n}`, authorAgentId: 'g1' })),
    },
  };
}

test('worker: 会社の id が無ければ断る・担当は必要な欄だけ返す', async () => {
  const ctx = fakeCtx(), h = createHandlers(ctx);
  await assert.rejects(h.agents({}), /companyId/);
  const a = await h.agents({ companyId: 'c1' });
  assert.deepEqual(ctx.seen[0], ['agents', { companyId: 'c1' }]);
  assert.equal(a[0].adapterConfig, undefined);
  assert.equal(JSON.stringify(a).includes('"S"'), false);
});

test('worker: 仕事の掲示は作業中と未着手を新しい順・課題はコメント 3 件と本文を切る・担当の仕事', async () => {
  const ctx = fakeCtx(), h = createHandlers(ctx);
  const t = await h.tasks({ companyId: 'c1' });
  assert.deepEqual(t.doing.map(i => i.id), ['i3', 'i1']); assert.deepEqual(t.next.map(i => i.id), ['i2']); assert.deepEqual(t.blocked.map(i => i.id), ['i5']);
  assert.ok(ctx.seen.every(([, q]) => q.companyId === 'c1'));
  const i = await h.issue({ companyId: 'c1', issueId: 'i1' });
  assert.deepEqual(i.comments.map(c => c.id), ['c2', 'c3', 'c4']);
  assert.ok(i.description.length <= 1501);
  assert.deepEqual(ctx.seen.at(-1), ['get', 'i1', 'c1']);
  assert.equal(await h.issue({ companyId: 'c1', issueId: 'nope' }), null);
  await assert.rejects(h.issue({ companyId: 'c1' }), /issueId/);
  const w = await h.agentWork({ companyId: 'c1', agentId: 'g1' });
  assert.deepEqual(w.now.map(i => i.id), ['i1']); assert.deepEqual(w.recent.map(i => i.id), ['i2', 'i4']);
});

// worker が呼ぶ SDK の口ごとに要る権限（本体は足りないと 502 で断る・2026-11-15 実測 issues.listComments）
const NEED = { 'agents.list': 'agents.read', 'issues.list': 'issues.read', 'issues.get': 'issues.read', 'issues.listComments': 'issue.comments.read', 'issues.create': 'issues.create' };
test('manifest: worker が呼ぶ SDK の口の権限が全部ある（office・design）', async () => {
  const fs = await import('node:fs');
  for (const name of ['office', 'design']) {
    const src = fs.readFileSync(new URL(`../plugins/${name}/src/worker.mjs`, import.meta.url), 'utf8');
    const { default: m } = await import(`../plugins/${name}/src/manifest.mjs`);
    const calls = [...new Set([...src.matchAll(/\b(?:ctx|C)\.(agents|issues)\.([a-zA-Z]+)\(/g)].map(x => `${x[1]}.${x[2]}`))];
    assert.ok(calls.length >= 2, name);
    for (const c of calls) { assert.ok(NEED[c], `${name}: ${c} の権限が表に無い`); assert.ok(m.capabilities.includes(NEED[c]), `${name}: ${c} に ${NEED[c]} が要る`); }
  }
});

// ---- 欄を node で描いて押す（範囲 docs/review/2026-11-18-office-ai-panel-ux-scope.md G1・G2・G3・F6・F8・F9）----
// 本物の React は本体が渡す（repo に無い）ので、'react' を試験用の小さな React に向ける
import { register } from 'node:module';
import { readFileSync } from 'node:fs';
register('./fixtures/react-alias-hooks.mjs', import.meta.url);
const R = await import('./fixtures/mini-react.mjs');
const P = await import('../plugins/office/src/panels.mjs');
const C = await import('../plugins/office/src/controls.mjs');
const h = R.createElement;
const tEn = translator('en'), tJa = translator('ja');
const deferred = () => { let resolve, reject; const p = new Promise((a, b) => { resolve = a; reject = b; }); return { p, resolve, reject }; };
const click = node => node.props.onClick({ preventDefault() {}, currentTarget: node });

// 起動係の AI の一覧の形（GET /setup/api/ai）
const aiState = ({ claude = { state: 'idle' }, codex = { state: 'idle' }, codexConnected = true, claudeInstall = 'done', grokInstall = 'pending' } = {}) => ({
  ais: [
    { type: 'codex_local', name: { en: 'ChatGPT (Codex)', ja: 'ChatGPT（Codex）' }, selectable: true, install: { status: 'done' }, connected: codexConnected, loginReady: true },
    { type: 'claude_local', name: { en: 'Claude', ja: 'Claude' }, selectable: true, install: { status: claudeInstall }, connected: claude.state === 'done', loginReady: true },
    { type: 'grok_local', name: { en: 'Grok', ja: 'Grok' }, selectable: true, install: { status: grokInstall }, connected: false, loginReady: false },
    { type: 'muse_local', name: { en: 'Muse', ja: 'Muse' }, selectable: false },
  ],
  claude, codex,
});
function fakeAiApi(over = {}) {
  const calls = [];
  const rec = (name, fn) => (...a) => { calls.push([name, ...a]); return fn(...a); };
  let state = aiState(over.state);
  const api = {
    aiList: rec('aiList', async () => JSON.parse(JSON.stringify(state))),
    agentsAi: rec('agentsAi', async () => ({ agents: [{ id: 'g1', name: 'Sec', title: 'Secretary', adapterType: 'codex_local' }, { id: 'g2', name: 'Res', title: null, adapterType: 'claude_local' }] })),
    aiInstall: rec('aiInstall', async () => ({ status: 'running' })),
    aiStart: rec('aiStart', async () => ({ state: 'starting' })),
    aiCode: rec('aiCode', async () => ({ state: 'submitting' })),
    aiCancel: rec('aiCancel', async () => ({ state: 'cancelled' })),
    assignAi: rec('assignAi', async () => ({ results: {} })),
    ...over.api,
  };
  return { api, calls, setState: s => { state = s; } };
}
const timers = () => { const list = []; return { list, setTimer: (fn, ms) => { list.push({ fn, ms }); return list.length; }, clearTimer: id => { if (list[id - 1]) list[id - 1].cleared = true; } }; };
const panel = (f, extra = {}) => R.render(h(P.ConnectPanel, { api: f.api, launcher: { lang: 'en' }, t: tEn, lang: 'en', onClose() {}, ...extra }));
const rowOf = (root, type) => R.byAttr(root.tree, 'data-ai', type);
// 「ほかの AI をつなぐ（n）」を開く（閉じている時だけ押す）
const expand = async root => { const b = R.byAttr(root.tree, 'data-ai-more'); if (b && b.props['aria-expanded'] === 'false') { click(b); await R.settle(); } };

test('AI の契約の欄: AI の一覧（状態の印つき）と社員ごとの AI を出す・選べるのはつないだ AI だけ（G1）', async () => {
  const f = fakeAiApi({ state: { claude: { state: 'idle' } } });
  const root = panel(f); await R.settle();
  assert.equal(R.text(R.byAttr(root.tree, 'data-panel', 'connect').children[0]).includes(tEn('connect_title')), true);
  // 並び（独立レビュー r2 の 8）: 社員ごとの AI が一番上 → つないだ AI → 「ほかの AI をつなぐ（3）」（つないだ AI があるので閉じている）
  const marks = R.findAll(root.tree, n => n.props['data-assign-list'] || n.props['data-ai-list']).map(n => (n.props['data-assign-list'] ? 'assign' : 'ai'));
  assert.deepEqual(marks, ['assign', 'ai']);
  assert.deepEqual(R.findAll(R.byAttr(root.tree, 'data-ai-main'), n => n.props['data-ai'] !== undefined).map(n => n.props['data-ai']), ['codex_local']);
  const more = R.byAttr(root.tree, 'data-ai-more');
  assert.deepEqual([more.type, more.props['aria-expanded'], more.props['aria-controls']], ['button', 'false', 'aio-ai-others']);
  assert.ok(R.text(more).includes(tEn('ai_more').replace('{n}', '3')));
  assert.equal(R.byAttr(root.tree, 'data-ai-others'), null, '閉じている時は中を出さない');
  await expand(root);
  assert.equal(R.byAttr(root.tree, 'data-ai-more').props['aria-expanded'], 'true');
  assert.equal(R.byAttr(root.tree, 'data-ai-others').props.id, 'aio-ai-others');
  assert.deepEqual(R.findAll(root.tree, n => n.props['data-ai'] !== undefined).map(n => [n.props['data-ai'], n.props['data-ai-state']]),
    [['codex_local', 'connected'], ['claude_local', 'not_connected'], ['grok_local', 'not_downloaded'], ['muse_local', 'unknown']]);
  // 状態の印: 色の点と badge の文
  const badge = n => R.find(n, x => x.props.className === 'aio-badge');
  assert.equal(R.text(badge(rowOf(root, 'codex_local'))), tEn('ai_s_connected'));
  assert.equal(badge(rowOf(root, 'codex_local')).props['data-tone'], 'ok');
  assert.equal(R.text(badge(rowOf(root, 'grok_local'))), tEn('ai_s_not_downloaded'));
  assert.ok(R.byAttr(rowOf(root, 'grok_local'), 'data-ai-install', 'grok_local'), 'ダウンロードのボタン');
  assert.ok(R.byAttr(rowOf(root, 'claude_local'), 'data-ai-connect', 'claude_local'), 'つなぐボタン');
  // 割り当て: 担当ごとの select。選べるのはつないだ AI（ChatGPT）だけ。今の AI（Claude）がつないでいない物なら、選べない行で残す
  const sel = R.byAttr(root.tree, 'data-assign', 'g2');
  assert.equal(sel.props.value, 'claude_local');
  assert.deepEqual(sel.children.map(o => [o.props.value, !!o.props.disabled]), [['claude_local', true], ['codex_local', false]]);
  assert.equal(R.byAttr(root.tree, 'data-assign-save').props.disabled, true, '替えていない時は保存を押せない');
});

test('押した直後から aria-busy・押せない・「処理中…」、終わると欄の中に結果の文（G2）', async () => {
  const d = deferred();
  const f = fakeAiApi({ api: { aiInstall: async () => d.p } });
  const root = panel(f); await R.settle(); await expand(root);
  const before = R.byAttr(root.tree, 'data-ai-install', 'grok_local');
  assert.equal(before.props['aria-busy'], undefined);
  click(before); await R.settle(1);
  const busy = R.byAttr(root.tree, 'data-ai-install', 'grok_local');
  assert.equal(busy.props['aria-busy'], 'true');
  assert.equal(busy.props.disabled, true);
  assert.match(R.text(busy), new RegExp(tEn('busy')));
  assert.equal(R.byAttr(root.tree, 'data-ai-result'), null, '終わるまで結果は出さない');
  d.resolve({ status: 'running' }); await R.settle();
  assert.equal(R.byAttr(root.tree, 'data-ai-result').props['data-ai-result'], 'ai_r_download_started');
  assert.equal(R.byAttr(root.tree, 'data-ai-result').props['data-tone'], 'ok');
  assert.equal(R.byAttr(root.tree, 'data-ai-install', 'grok_local').props['aria-busy'], undefined, '終わると処理中を外す');
  // できなかった時: 起動係の error の code の文を、欄の中に赤で出す
  const g = fakeAiApi({ api: { aiStart: async () => { throw Object.assign(new Error('x'), { status: 409, body: { error: 'ai_install_first' } }); } } });
  const r2 = panel(g); await R.settle(); await expand(r2);
  await click(R.byAttr(r2.tree, 'data-ai-connect', 'claude_local')); await R.settle();
  const res = R.byAttr(r2.tree, 'data-ai-result');
  assert.deepEqual([res.props['data-ai-result'], res.props['data-tone'], R.text(res)], ['ai_r_install_first', 'err', tEn('ai_r_install_first')]);
});

test('Claude の code の欄: 2 秒ごとの読み直しで貼りかけの code が消えない・文字数を出す・動いていない時は読み直さない（F9）', async () => {
  const f = fakeAiApi({ state: { claude: { state: 'waiting', url: 'https://claude.ai/oauth?x=1', remainingMs: 600000 } } });
  const tm = timers();
  const root = panel(f, tm); await R.settle();
  const ta = () => R.byAttr(root.tree, 'data-ai-code', 'claude_local');
  ta().props.onChange({ target: { value: 'abc-123' } }); await R.settle();
  assert.equal(ta().props.value, 'abc-123');
  assert.equal(R.text(R.byAttr(root.tree, 'data-ai-code-count')), tEn('ai_code_count').replace('{n}', '7'));
  const live = tm.list.filter(x => !x.cleared);
  assert.equal(live.length, 1); assert.equal(live[0].ms, 2000, 'サインインを待つ間は 2 秒ごと');
  f.setState(aiState({ claude: { state: 'waiting', url: 'https://claude.ai/oauth?x=1', remainingMs: 598000 } }));
  live[0].fn(); await R.settle();
  assert.equal(f.calls.filter(c => c[0] === 'aiList').length, 2, '読み直した');
  assert.equal(ta().props.value, 'abc-123', '読み直しで下書きが消えない');
  // サインインのリンクはボタンの形・外へ開く（新しいタブ・↗）
  const a = R.byAttr(root.tree, 'data-ai-url', 'claude_local');
  assert.deepEqual([a.type, a.props.target, a.props.rel, a.props.className], ['a', '_blank', 'noopener noreferrer', 'aio-btn aio-btn-primary']);
  assert.ok(R.text(a).endsWith('↗'));
  // code を送る → 送る間は処理中
  await click(R.byAttr(root.tree, 'data-ai-send', 'claude_local')); await R.settle();
  assert.deepEqual(f.calls.find(c => c[0] === 'aiCode'), ['aiCode', 'claude_local', 'abc-123']);
  // つながった後は読み直しを止め、下書きを捨てる
  f.setState(aiState({ claude: { state: 'done' } }));
  tm.list.filter(x => !x.cleared).at(-1).fn(); await R.settle();
  assert.equal(rowOf(root, 'claude_local').props['data-ai-state'], 'connected');
  assert.equal(tm.list.filter(x => !x.cleared).length, 0, '動いていない時は読み直さない');
});

test('ChatGPT の code: 写すボタン・サインインのページはボタンの形のリンク（G1・G3）', async () => {
  const copied = [];
  const f = fakeAiApi({ state: { codexConnected: false, codex: { state: 'waiting', url: 'https://auth.openai.com/codex/device', code: 'AB12-CD345', remainingMs: 300000 } } });
  const root = panel(f, { copyText: async s => { copied.push(s); }, ...timers() }); await R.settle();
  assert.equal(R.text(R.byAttr(root.tree, 'data-codex-code')), 'AB12-CD345');
  assert.equal(R.byAttr(root.tree, 'data-codex-url').props.href, 'https://auth.openai.com/codex/device');
  await click(R.byAttr(root.tree, 'data-codex-copy')); await R.settle();
  assert.deepEqual(copied, ['AB12-CD345']);
  assert.equal(R.byAttr(root.tree, 'data-ai-result').props['data-ai-result'], 'ai_r_copied');
});

test('欄を閉じる・切り替える時は、待っている Claude のサインインを取り消す（F8）', async () => {
  for (const [state, want] of [['waiting', 1], ['starting', 1], ['idle', 0], ['done', 0]]) {
    const f = fakeAiApi({ state: { claude: { state, url: 'https://claude.ai/x' } } });
    const root = panel(f, timers()); await R.settle();
    root.update(h(P.TasksPanel, { tasks: { data: null }, t: tEn, onIssue() {}, onClose() {} })); await R.settle();
    assert.equal(f.calls.filter(c => c[0] === 'aiCancel' && c[1] === 'claude_local').length, want, state);
  }
});

test('社員ごとの AI の保存: 替えた担当だけを送り、担当ごとの結果と欄の結果の文を出す（G1・F1）', async () => {
  const f = fakeAiApi({ state: { claude: { state: 'done' } }, api: { assignAi: async assign => { f.calls.push(['assignAi', assign]); return { results: { g1: { ok: true, why: null }, g2: { ok: false, why: 'paperclip_500' } } }; } } });
  const root = panel(f); await R.settle();
  R.byAttr(root.tree, 'data-assign', 'g1').props.onChange({ target: { value: 'claude_local' } });
  R.byAttr(root.tree, 'data-assign', 'g2').props.onChange({ target: { value: 'codex_local' } }); await R.settle();
  assert.equal(R.byAttr(root.tree, 'data-assign-save').props.disabled, false);
  await click(R.byAttr(root.tree, 'data-assign-save')); await R.settle();
  assert.deepEqual(f.calls.find(c => c[0] === 'assignAi')[1], { g1: 'claude_local', g2: 'codex_local' });
  assert.equal(R.byAttr(root.tree, 'data-assign-agent', 'g1').children.some(c => c.props?.['data-assign-result'] === 'ok'), true);
  assert.equal(R.text(R.byAttr(R.byAttr(root.tree, 'data-assign-agent', 'g2'), 'data-assign-result')), `${tEn('assign_r_row_failed')}: ${tEn('assign_why_paperclip')}`);
  assert.equal(R.byAttr(root.tree, 'data-ai-result').props['data-ai-result'], 'assign_r_partial');
});

test('package の外（起動係なし）・読み込み中・日本語の文', async () => {
  const f = fakeAiApi();
  assert.match(R.text(R.render(h(P.ConnectPanel, { api: f.api, launcher: null, t: tEn, onClose() {} })).tree), new RegExp(tEn('connect_package_only')));
  assert.match(R.text(R.render(h(P.ConnectPanel, { api: f.api, launcher: undefined, t: tEn, onClose() {} })).tree), new RegExp(tEn('loading')));
  assert.equal(f.calls.length, 0, '起動係が無い時は口を呼ばない');
  const root = R.render(h(P.ConnectPanel, { api: f.api, launcher: {}, t: tJa, lang: 'ja', onClose() {} })); await R.settle();
  assert.match(R.text(root.tree), new RegExp(tJa('ai_s_connected')));
  assert.match(R.text(root.tree), new RegExp(tJa('assign_title')));
  assert.equal(R.text(R.byAttr(root.tree, 'data-close')), tJa('close'));
  assert.ok(tJa('close').startsWith('×') && tEn('close').startsWith('×'), '閉じるは「× 閉じる」でオフィスに戻ると分かる形（G4）');
});

test('起動係の error の code と状態の文の key は全部、英日の辞書にある', () => {
  const src = readFileSync(new URL('../plugins/office/src/panels.mjs', import.meta.url), 'utf8');
  // 文の key の候補: panels.mjs の 'ai_…'・'assign_…' の文字列（起動係の error の code＝AI_ERRORS の key は除く）と、code から引く文の key
  const codes = new Set(Object.keys(P.AI_ERRORS));
  const keys = new Set([...src.matchAll(/'((?:ai|assign)_[a-z_]+)'/g)].map(m => m[1]).filter(k => !codes.has(k)));
  for (const v of [...Object.values(P.AI_ERRORS), ...Object.values(P.FAIL_KEY), P.aiErrorKey({ body: { error: 'what' } }), P.aiErrorKey(null)]) keys.add(v);
  for (const s of ['connected', 'downloading', 'not_downloaded', 'download_failed', 'not_ready', 'not_connected', 'starting', 'waiting', 'checking', 'unknown']) keys.add(`ai_s_${s}`);
  assert.ok(keys.size >= 40, `少ない: ${keys.size}`);
  for (const k of keys) { assert.ok(k in DICT.en, `en.${k}`); assert.ok(k in DICT.ja, `ja.${k}`); }
});

test('Link: 外へは http(s) だけ・新しいタブ・noopener noreferrer・↗。中は / から始まる path だけ（G3・F6）', () => {
  const draw = el => R.render(el).tree;
  const ext = draw(h(C.Link, { href: 'https://example.com/a', external: true }, 'site'));
  assert.deepEqual([ext.type, ext.props.href, ext.props.target, ext.props.rel, ext.props.className], ['a', 'https://example.com/a', '_blank', 'noopener noreferrer', 'aio-link']);
  assert.equal(R.text(ext), 'site↗');
  for (const bad of ['javascript:alert(1)', 'data:text/html,x', '/relative']) assert.equal(draw(h(C.Link, { href: bad, external: true }, 'x')).type, 'span', bad);
  const inner = draw(h(C.Link, { href: '/ACM/issues/ACM-1' }, 'issue'));
  assert.deepEqual([inner.type, inner.props.target, R.text(inner)], ['a', undefined, 'issue']);
  for (const bad of ['//evil.test/x', 'https://evil.test', 'javascript:x']) assert.equal(draw(h(C.Link, { href: bad }, 'x')).type, 'span', bad);
  assert.equal(draw(h(C.Link, { href: '/x', kind: 'button' }, 'go')).props.className, 'aio-btn aio-btn-primary', 'ボタンの形のリンク');
  // AI の書いた文の URL も同じ Link（↗ つき）
  const rich = draw(h(P.RichText, { text: 'see https://example.com/1 and javascript:alert(1)' }));
  assert.equal(R.findAll(rich, n => n.type === 'a').length, 1);
  assert.equal(R.find(rich, n => n.type === 'a').props.target, '_blank');
});

test('Button: 同期の押下は処理中にしない・Promise の間だけ処理中・押した印（aria-pressed）', async () => {
  let n = 0;
  const root = R.render(h(C.Button, { onClick: () => { n += 1; }, pressed: true }, 'Tasks'));
  click(root.tree); await R.settle();
  assert.equal(n, 1);
  assert.deepEqual([root.tree.props['aria-busy'], root.tree.props.disabled, root.tree.props['aria-pressed'], root.tree.props.type], [undefined, false, 'true', 'button']);
  const d = deferred();
  const r2 = R.render(h(C.Button, { onClick: () => d.p, busyText: tJa('busy') }, 'Go'));
  click(r2.tree); await R.settle(1);
  assert.deepEqual([r2.tree.props['aria-busy'], r2.tree.props.disabled, R.text(r2.tree)], ['true', true, tJa('busy')]);
  click(r2.tree); // 処理中の二度押しは呼ばない
  d.reject(new Error('x')); await R.settle();
  assert.deepEqual([r2.tree.props['aria-busy'], r2.tree.props.disabled, R.text(r2.tree)], [undefined, false, 'Go'], '失敗でも処理中を外す');
  assert.match(C.OFFICE_CSS, /\.aio-btn:hover/); assert.match(C.OFFICE_CSS, /\.aio-btn:active/); assert.match(C.OFFICE_CSS, /\.aio-btn:focus-visible/);
  assert.match(C.OFFICE_CSS, /\.aio-link \{[^}]*text-decoration: underline/);
  assert.match(C.OFFICE_CSS, /\.dark \.aio/, '暗い画面の色');
});

test('sidebar の「Office」: manifest に slot と権限があり、prefix が無い時は出さない（G4・F4）', async () => {
  const m = (await import('../plugins/office/src/manifest.mjs')).default;
  assert.ok(m.capabilities.includes('ui.sidebar.register'));
  const slot = m.ui.slots.find(s => s.type === 'sidebar');
  assert.equal(slot?.exportName, 'OfficeSidebarLink');
  const ui = await import('../plugins/office/src/ui.mjs');
  assert.equal(typeof ui[slot.exportName], 'function', 'ui の束に sidebar の部品がある');
  const api404 = async () => ({ ok: false, status: 404, json: async () => null });
  const prev = globalThis.fetch; globalThis.fetch = api404;
  try {
    assert.equal(R.render(h(ui.OfficeSidebarLink, { context: { companyPrefix: null } })).tree, null, 'prefix が無い時は出さない');
    const root = R.render(h(ui.OfficeSidebarLink, { context: { companyPrefix: 'ACM' } })); await R.settle();
    const a = R.byAttr(root.tree, 'data-office-nav');
    assert.deepEqual([a.type, a.props.href, a.props.target, R.text(a)], ['a', '/ACM/office', undefined, tEn('sidebar_office')]);
  } finally { globalThis.fetch = prev; }
});

test('中のリンクは同じ origin に解く path だけ: /\\example.com・//x は断る（独立レビュー r2 の 3）', () => {
  const o = 'https://office.test';
  assert.equal(C.sameOriginPath('/ACME/office', o), '/ACME/office');
  assert.equal(C.sameOriginPath('/\\example.com', o), null);
  assert.equal(C.sameOriginPath('//example.com', o), null);
  assert.equal(C.sameOriginPath('/\t/example.com', o), null);
  assert.equal(C.sameOriginPath('https://office.test/x', o), null, '/ から始まらない物は断る');
  const el = R.render(h(C.Link, { href: '/\\example.com' }, 'x')).tree;
  assert.equal(el.type, 'span', '断った href は文字だけ');
});

test('読み直しが失敗しても、動いている間は次の 2 秒を掛け直す（独立レビュー r2 の 4）', async () => {
  let fail = false;
  const f = fakeAiApi({ state: { claude: { state: 'waiting', url: 'https://claude.ai/x' } } });
  const orig = f.api.aiList;
  f.api.aiList = async () => { if (fail) throw new Error('down'); return orig(); };
  const tm = timers();
  panel(f, tm); await R.settle();
  fail = true;
  for (let i = 0; i < 3; i++) {
    const live = tm.list.filter(x => !x.cleared);
    assert.equal(live.length, 1, `${i} 回目の失敗の後も 1 つ掛かっている`);
    live[0].fn(); await R.settle();
  }
  fail = false;
  tm.list.filter(x => !x.cleared).at(-1).fn(); await R.settle();
  assert.equal(tm.list.filter(x => !x.cleared).length, 1, '直った後も続く');
});

test('担当ごとの保存の失敗の理由は辞書の文で出す・知らない理由は汎用の文（独立レビュー r2 の 5）', () => {
  assert.equal(P.assignWhyKey('agent_unknown'), 'assign_why_agent_unknown');
  assert.equal(P.assignWhyKey('paperclip_500'), 'assign_why_paperclip');
  assert.equal(P.assignWhyKey('paperclip_404'), 'assign_why_paperclip');
  assert.equal(P.assignWhyKey('failed'), 'assign_why_failed');
  assert.equal(P.assignWhyKey('what_is_this'), 'assign_why_failed');
  assert.equal(P.assignWhyKey(undefined), 'assign_why_failed');
  for (const k of ['assign_why_agent_unknown', 'assign_why_paperclip', 'assign_why_failed']) {
    assert.notEqual(tEn(k), k); assert.notEqual(tJa(k), k);
    assert.ok(!/paperclip_|agent_unknown/.test(tEn(k) + tJa(k)), '内部の code を画面に出さない');
  }
});

test('つないだ AI の行に「つなぎ直す」: 押すと aiStart・処理中、つなぎ直しの途中は code の形（独立レビュー r2 の 7）', async () => {
  const d = deferred();
  const f = fakeAiApi({ state: { claude: { state: 'done' } }, api: { aiStart: async (...a) => { f.calls.push(['aiStart', ...a]); return d.p; } } });
  const root = panel(f, timers()); await R.settle();
  for (const type of ['codex_local', 'claude_local']) assert.ok(R.byAttr(rowOf(root, type), 'data-ai-reconnect', type), type);
  click(R.byAttr(root.tree, 'data-ai-reconnect', 'claude_local')); await R.settle(1);
  const b = R.byAttr(root.tree, 'data-ai-reconnect', 'claude_local');
  assert.deepEqual([b.props['aria-busy'], b.props.disabled], ['true', true]);
  assert.match(R.text(b), new RegExp(tEn('busy')));
  assert.deepEqual(f.calls.find(c => c[0] === 'aiStart'), ['aiStart', 'claude_local']);
  // 起動係が Claude を待ちにした（つないだまま code の流れ）→ code の欄を出す
  f.setState(aiState({ claude: { state: 'waiting', url: 'https://claude.ai/x' } }));
  const s = aiState({ claude: { state: 'waiting', url: 'https://claude.ai/x' } }); s.ais[1].connected = true; f.setState(s);
  d.resolve({ state: 'waiting' }); await R.settle();
  assert.ok(R.byAttr(rowOf(root, 'claude_local'), 'data-ai-code', 'claude_local'), 'code の欄');
  assert.equal(rowOf(root, 'claude_local').props['data-ai-state'], 'waiting');
  // ChatGPT: つないだまま code を待つ → code の形
  const g = fakeAiApi({ state: { codex: { state: 'waiting', url: 'https://auth.openai.com/codex/device', code: 'AB12-CD345' } } });
  const r2 = panel(g, timers()); await R.settle();
  assert.equal(R.text(R.byAttr(r2.tree, 'data-codex-code')), 'AB12-CD345');
  assert.ok(R.byAttr(R.byAttr(r2.tree, 'data-ai-main'), 'data-ai', 'codex_local'), 'つないでいる途中の AI は上の段');
  // 英日の文
  assert.equal(tEn('ai_reconnect'), 'Reconnect'); assert.equal(tJa('ai_reconnect'), 'つなぎ直す');
});

test('つないだ AI が 1 つも無い時だけ「ほかの AI をつなぐ」は開いている・押すと閉じる（独立レビュー r2 の 8）', async () => {
  const f = fakeAiApi({ state: { codexConnected: false } });
  const root = panel(f, timers()); await R.settle();
  assert.equal(R.byAttr(root.tree, 'data-ai-main'), null);
  assert.ok(R.byAttr(root.tree, 'data-ai-none'), 'つないだ AI が無いという文');
  const more = () => R.byAttr(root.tree, 'data-ai-more');
  assert.equal(more().props['aria-expanded'], 'true');
  assert.ok(R.text(more()).includes(tEn('ai_more').replace('{n}', '4')));
  assert.deepEqual(R.findAll(R.byAttr(root.tree, 'data-ai-others'), n => n.props['data-ai'] !== undefined).map(n => n.props['data-ai']), ['codex_local', 'claude_local', 'grok_local', 'muse_local']);
  click(more()); await R.settle();
  assert.equal(more().props['aria-expanded'], 'false');
  assert.equal(R.byAttr(root.tree, 'data-ai-others'), null);
  // ダウンロード中の AI はつないでいなくても上の段
  const g = fakeAiApi({ state: { codexConnected: false, grokInstall: 'running' } });
  const r2 = panel(g, timers()); await R.settle();
  assert.deepEqual(R.findAll(R.byAttr(r2.tree, 'data-ai-main'), n => n.props['data-ai'] !== undefined).map(n => n.props['data-ai']), ['grok_local']);
  assert.ok(tJa('ai_more').includes('{n}') && tEn('ai_more').includes('{n}'));
});

test('結果の文が出た時、押したボタンはもう処理中でない（読み直しが返らなくても・e2e wiz8 の en）', async () => {
  const hang = deferred();
  let n = 0;
  const f = fakeAiApi({ state: { codexConnected: false }, api: { aiStart: async () => { throw Object.assign(new Error('x'), { status: 409, body: { error: 'ai_install_first' } }); } } });
  const orig = f.api.aiList;
  f.api.aiList = async () => (++n === 1 ? orig() : hang.p); // 押した後の読み直しは返らない
  const root = panel(f, timers()); await R.settle();
  click(R.byAttr(root.tree, 'data-ai-connect', 'codex_local')); await R.settle();
  assert.equal(R.byAttr(root.tree, 'data-ai-result').props['data-ai-result'], 'ai_r_install_first');
  assert.equal(R.byAttr(root.tree, 'data-ai-connect', 'codex_local').props['aria-busy'], undefined, '結果の文と同時に処理中を外す');
  assert.equal(n, 2, '読み直しは始めている');
  // 保存: 担当の読み直しが返らなくても、保存のボタンは処理中を外す
  let m = 0;
  const g = fakeAiApi({ api: { assignAi: async () => ({ results: { g1: { ok: true } } }) } });
  const oa = g.api.agentsAi;
  g.api.agentsAi = async () => (++m === 1 ? oa() : hang.p);
  const r2 = panel(g, timers()); await R.settle();
  R.byAttr(r2.tree, 'data-assign', 'g2').props.onChange({ target: { value: 'codex_local' } }); await R.settle();
  click(R.byAttr(r2.tree, 'data-assign-save')); await R.settle();
  assert.equal(R.byAttr(r2.tree, 'data-ai-result').props['data-ai-result'], 'assign_r_saved');
  assert.equal(R.byAttr(r2.tree, 'data-assign-save').props['aria-busy'], undefined);
});

test('つないだ行に前の失敗の記録を出さない・つなぎ直しを押した後の失敗だけ出す（独立レビュー r3 の D）', async () => {
  const f = fakeAiApi({ state: { codex: { state: 'failed', error: 'login_timeout' } } });
  const root = panel(f, timers()); await R.settle();
  assert.equal(rowOf(root, 'codex_local').props['data-ai-state'], 'connected');
  assert.equal(R.byAttr(rowOf(root, 'codex_local'), 'data-ai-error'), null, '前の失敗は出さない');
  await click(R.byAttr(root.tree, 'data-ai-reconnect', 'codex_local')); await R.settle();
  assert.equal(R.byAttr(rowOf(root, 'codex_local'), 'data-ai-error').props['data-ai-error'], 'login_timeout', 'つなぎ直した後の失敗は出す');
  assert.equal(R.text(R.byAttr(rowOf(root, 'codex_local'), 'data-ai-error')), tEn('ai_login_timeout'));
});

test('本体の 422（種類を替えられない）は「待てば通る」でない専用の文（独立レビュー r3 の E）', () => {
  assert.equal(P.assignWhyKey('paperclip_422'), 'assign_why_incompatible');
  assert.equal(P.assignWhyKey('paperclip_500'), 'assign_why_paperclip');
  for (const t of [tEn, tJa]) {
    assert.notEqual(t('assign_why_incompatible'), 'assign_why_incompatible');
    assert.notEqual(t('assign_why_incompatible'), t('assign_why_paperclip'));
  }
  assert.ok(!/moment|later/i.test(tEn('assign_why_incompatible')) && !/少し待って/.test(tJa('assign_why_incompatible')), '待つように言わない');
});

test('読み直しの古い応答は新しい一覧を上書きしない（順番の番号・独立レビュー r4）', async () => {
  const waiting = aiState({ codexConnected: false, claude: { state: 'waiting', url: 'https://claude.ai/x' } }), idle = aiState({ codexConnected: false, claude: { state: 'idle' } }); // つないだ AI が無いので、ほかの AI の開閉は開いている
  const q = [];
  const f = fakeAiApi();
  f.api.aiList = () => { const d = deferred(); q.push(d); return d.p; };
  const tm = timers();
  const root = panel(f, tm); await R.settle();
  q[0].resolve(waiting); await R.settle();
  assert.equal(rowOf(root, 'claude_local').props['data-ai-state'], 'waiting');
  tm.list.filter(x => !x.cleared).at(-1).fn(); await R.settle(); // 2 秒の読み直し（古い方・まだ返らない）
  click(R.byAttr(root.tree, 'data-ai-cancel', 'claude_local')); await R.settle(); // やめる → 読み直し（新しい方）
  assert.equal(q.length, 3);
  q[2].resolve(idle); await R.settle();
  assert.equal(rowOf(root, 'claude_local').props['data-ai-state'], 'not_connected');
  q[1].resolve(waiting); await R.settle();
  assert.equal(rowOf(root, 'claude_local').props['data-ai-state'], 'not_connected', '古い応答（waiting）で戻らない');
});
