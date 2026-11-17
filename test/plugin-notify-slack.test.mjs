// Slack への届け（知らせの plugin）の試験。範囲: docs/review/2026-11-18-slack-notify-scope.md「確かめ方」の unit の項目
// 本体・表・起動係の照合の口・Slack は偽物
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { build } from 'esbuild';
import { createHash } from 'node:crypto';
import { singleFlight, noticeKey, safeTitle, t } from '../plugins/notify/src/lib.mjs';
import { slackUrlOk, destFingerprint, escapeSlack, slackMessage, slackBody, previewOf, previewHash, classifySlack, nextAttempt, errorCode, checkChoice, officeUrlOk, SLACK_DEFAULTS, SLACK_LIMITS, messageFor } from '../plugins/notify/src/slack.mjs';
import { SLACK, slackStore, postSlack, nonceUrl, admit, savedUrl } from '../plugins/notify/src/slack-worker.mjs';
import { MASKED_DEST } from '../packages/aioffice/launcher/lib/slack-url.mjs';
import manifest from '../plugins/notify/src/manifest.mjs';

const { handleRoute, handleTick } = await import('../plugins/notify/src/worker.mjs');

const tok = s => `T${s}AAAA/B${s}BBBB/${s.repeat(4)}xyzXYZ123`;
const URL_A = `https://hooks.slack.com/services/${tok('a')}`;
const URL_A2 = `https://hooks.slack.com/services/${tok('c')}`;
const URL_B = `https://hooks.slack.com/services/${tok('b')}`;
const OFFICE = 'http://localhost:3100/ACM/office';
const T0 = Date.parse('2026-11-18T09:00:00Z');
const clone = v => (v == null ? v : JSON.parse(JSON.stringify(v)));

// 偽の本体（state・設定・秘密・http.fetch）と表（知らせ・送りの記録）と起動係の照合の口
function world() {
  let clock = T0;
  const notices = [], sends = new Map(), state = new Map(), logs = [];
  const config = { A: { stuckIdleMin: 60, slack: { webhook: { type: 'secret_ref', secretId: 'sA' } } }, B: { slack: { webhook: { type: 'secret_ref', secretId: 'sB' } } } };
  const secretVals = { sA: URL_A, sB: URL_B, sA2: URL_A2 };
  const secretCo = { sA: 'A', sA2: 'A', sB: 'B' };
  const calls = { fetch: [], resolve: 0 };
  let reply = () => ({ status: 200, body: 'ok' });
  const nonces = new Map();
  const saved = { A: destFingerprint(URL_A), B: destFingerprint(URL_B) }; // 起動係が覚えた、持ち主の保存した宛先の指紋
  const sk = (c, k) => `${c}|${k}`;
  const deps = {
    now: () => clock, sleep: async ms => { clock += ms; }, flight: singleFlight(), slackFlight: singleFlight(),
    state: { get: async k => clone(state.get(JSON.stringify(k))) ?? null, set: async (k, v) => { state.set(JSON.stringify(k), clone(v)); } },
    config: { get: async c => clone(config[c]) ?? null },
    secrets: { resolve: async (ref, { companyId }) => { calls.resolve++; if (secretCo[ref.secretId] !== companyId) throw new Error('binding_missing'); return secretVals[ref.secretId]; } },
    http: { fetch: async (url, init) => { calls.fetch.push({ url, body: JSON.parse(init.body) }); const r = await reply(url, init); return new Response(r.body ?? '', { status: r.status, headers: r.headers || {} }); } },
    verifyNonce: async ({ nonce, companyId, previewHash: ph }) => { const v = nonces.get(nonce); nonces.delete(nonce); return v && v.companyId === companyId && v.previewHash === ph && v.exp > clock ? { ok: true, fp: v.fp } : { ok: false }; },
    savedDest: async ({ companyId, fp }) => saved[companyId] === fp,
    notices: {
      listNotices: async c => clone(notices.filter(n => n.c === c)),
      addNotice: async (c, n) => { if (!notices.some(x => x.c === c && x.key === n.key)) notices.push({ ...n, c, createdAt: new Date(clock).toISOString(), readAt: null }); },
    },
    slack: {
      enqueue: async (c, kinds, since) => { for (const n of notices) if (n.c === c && kinds.includes(n.kind) && Date.parse(n.createdAt) >= Date.parse(since) && !sends.has(sk(c, n.key))) sends.set(sk(c, n.key), { c, key: n.key, status: 'pending', attempts: 0, nextAt: Date.parse(n.createdAt) }); },
      dropOrphans: async c => { for (const [k, s] of sends) if (s.c === c && s.status === 'pending' && !notices.some(n => n.c === c && n.key === s.key)) sends.delete(k); },
      due: async (c, nowIso) => [...sends.values()].filter(s => s.c === c && s.status === 'pending' && s.nextAt <= Date.parse(nowIso)).map(s => { const n = notices.find(x => x.c === c && x.key === s.key); return { key: s.key, attempts: s.attempts, kind: n.kind, title: n.title, originId: n.originId, createdAt: n.createdAt }; }).sort((a, b) => a.createdAt.localeCompare(b.createdAt)),
      pendingCount: async c => [...sends.values()].filter(s => s.c === c && s.status === 'pending').length,
      markSent: async (c, k) => { const s = sends.get(sk(c, k)); if (s) s.status = 'sent'; }, // 本物の UPDATE と同じく、消えた行には何もしない
      markRetry: async (c, k, attempts, nextIso, code) => Object.assign(sends.get(sk(c, k)), { attempts, nextAt: Date.parse(nextIso), code }),
      markDone: async (c, k, status, code) => Object.assign(sends.get(sk(c, k)), { status, code }),
      giveUp: async (c, cutoff) => { let n = 0; for (const s of sends.values()) { const no = notices.find(x => x.c === c && x.key === s.key); if (s.c === c && s.status === 'pending' && no && Date.parse(no.createdAt) < Date.parse(cutoff)) { s.status = 'gave_up'; n++; } } return n; },
      clearPending: async c => { for (const [k, s] of sends) if (s.c === c && s.status === 'pending') sends.delete(k); },
    },
    // 見回りの口のための物
    store: null, approvals: { list: async () => [] }, issues: { list: async () => [], listInteractions: async () => [] }, agents: { list: async () => [] },
  };
  deps.store = { ...deps.notices, removeNotice: async (c, k) => { const i = notices.findIndex(n => n.c === c && n.key === k); if (i >= 0) notices.splice(i, 1); }, openEvents: async () => [], doneEvents: async () => {}, markRead: async () => {} };
  const add = (c, kind, origin, title, at = clock) => { const n = { c, key: noticeKey(kind, origin), kind, originId: origin, title, createdAt: new Date(at).toISOString(), readAt: null }; notices.push(n); return n; };
  const issueNonce = (c, ph, fp) => { const nonce = createHash('sha256').update(String(Math.random())).digest('hex'); nonces.set(nonce, { companyId: c, previewHash: ph, fp, exp: clock + 120_000 }); return nonce; };
  const route = (routeKey, companyId, extra = {}) => handleRoute(deps, { routeKey, companyId, ...extra });
  // 持ち主の手順: 見本を見て、その hash で ON（起動係は保存した宛先の指紋を照合の口の答えに入れる）
  async function turnOn(c = 'A', { kinds = ['digest'], form = 'titles', lang = 'en', savedUrl = URL_A } = {}) {
    const pv = await route('slack-preview', c, { query: { kinds: kinds.join(','), form, lang, officeUrl: OFFICE } });
    assert.equal(pv.status, 200, JSON.stringify(pv.body));
    const nonce = issueNonce(c, pv.body.hash, destFingerprint(savedUrl));
    return route('slack-confirm', c, { body: { nonce, kinds, form, previewHash: pv.body.hash, lang, officeUrl: OFFICE } });
  }
  return { deps, calls, notices, sends, state, config, secretVals, saved, logs, add, route, turnOn, issueNonce, setReply: f => { reply = f; }, tick: ms => { clock += ms; }, get clock() { return clock; } };
}
const st = async (w, c = 'A') => w.deps.state.get(SLACK(c));

// ---- 形の確かめ（S3） ----
test('slackUrlOk: 正しい形だけ通し、http・別の名前・@・query・空白・改行・段の足りない path・GovSlack は断る', () => {
  assert.equal(slackUrlOk(URL_A), true);
  for (const bad of [URL_A.replace('https:', 'http:'), 'https://hooks.slack.com.example.org/services/T1/B1/x', 'https://example.org/hooks.slack.com/services/T1/B1/x', 'https://user@hooks.slack.com/services/T1/B1/x', 'https://hooks.slack.com@evil.example/services/T1/B1/x',
    `${URL_A}?x=1`, `${URL_A}#f`, ` ${URL_A}`, `${URL_A} `, `${URL_A}\n`, `${URL_A}\r\n`, 'https://hooks.slack.com/services/T1/B1', 'https://hooks.slack.com/services/T1/B1/x/y', 'https://hooks.slack-gov.com/services/T1/B1/x', 'https://HOOKS.slack.com/services/T1/B1/x', '', null, 42, `https://hooks.slack.com/services/T1/B1/${'x'.repeat(300)}`])
    assert.equal(slackUrlOk(bad), false, JSON.stringify(bad));
});

test('伏せた形: 保存の返事と欄の表示に URL のどの段の文字も入らない・指紋は 16 字で元に戻せない形', () => {
  for (const part of URL_A.replace('https://hooks.slack.com/services/', '').split('/')) assert.ok(!MASKED_DEST.includes(part));
  assert.match(destFingerprint(URL_A), /^[0-9a-f]{16}$/);
  assert.notEqual(destFingerprint(URL_A), destFingerprint(URL_A2));
  for (const part of URL_A.split('/')) if (part.length > 3) assert.ok(!destFingerprint(URL_A).includes(part));
});

test('escapeSlack: <!channel>・<!here>・<@U123>・<https://x|y>・&amp;・素の @here・@channel・@everyone が呼び出しにならない', () => {
  const s = escapeSlack('a <!channel> b <!here> <@U123> <https://x.example|y> &amp; @here @channel @everyone @Here mail@example.com');
  for (const bad of ['<!channel>', '<!here>', '<@U123>', '<https://', '@here', '@channel', '@everyone', '@Here']) assert.ok(!s.includes(bad), bad);
  assert.ok(!/[<>]/.test(s));
  assert.match(s, /&amp;amp;/); assert.match(s, /＠here/); assert.match(s, /mail@example\.com/);
});

// ---- 1 通の形（S5） ----
const sections = m => m.blocks.filter(b => b.type === 'section');
const buttons = m => m.blocks.filter(b => b.type === 'actions').flatMap(b => b.elements);
for (const lang of ['en', 'ja']) {
  test(`slackBlocks（${lang}）: 見出し 1 行・1 件 1 行・80 字で詰める・まとめの 10 件と「ほか n 件」・0 件の文・url ボタン 1 つ・文の中に link が無い`, () => {
    const items = Array.from({ length: 13 }, (_, i) => ({ kind: i % 2 ? 'approval' : 'stuck', title: `Item ${i} ${'x'.repeat(100)}`, createdAt: '2026-11-18T08:00:00Z' }));
    const d = slackMessage({ type: 'digest', lang, form: 'titles', slot: 'am', items }, OFFICE);
    assert.equal(d.text.split('\n').length, 1);
    assert.equal(sections(d)[0].text.text, `*${d.text}*`);
    const lines = sections(d)[1].text.text.split('\n');
    assert.equal(lines.length, 11);
    for (const l of lines.slice(0, 10)) assert.ok(l.length <= 2 + SLACK_LIMITS.titleMax, l);
    assert.match(lines[10], lang === 'ja' ? /ほか 3 件/ : /and 3 more/);
    assert.equal(buttons(d).length, 1); assert.equal(buttons(d)[0].url, OFFICE);
    for (const b of sections(d)) assert.ok(!/https?:|<http/.test(b.text.text), b.text.text);
    assert.ok(!/https?:/.test(d.text));
    const z = slackMessage({ type: 'digest', lang, form: 'titles', slot: 'pm', items: [] }, OFFICE);
    assert.match(z.text, lang === 'ja' ? /夕方のまとめ: 待っている物はありません/ : /Evening summary: nothing is waiting/);
    assert.equal(sections(z).length, 1);
    // 件数だけ: 種類ごとの件数を 1 行ずつ・題は入らない
    const c = slackMessage({ type: 'digest', lang, form: 'counts', slot: 'am', items }, OFFICE);
    const cl = sections(c)[1].text.text;
    assert.ok(!/Item/.test(cl)); assert.equal(cl.split('\n').length, 2);
    const one = slackMessage({ type: 'notice', lang, form: 'counts', kind: 'approval', items: [{ kind: 'approval', title: 'Secret plan' }] }, OFFICE);
    assert.ok(!JSON.stringify(one).includes('Secret plan'));
    // body の明示
    const body = JSON.parse(slackBody(d));
    assert.equal(body.link_names, false); assert.equal(body.unfurl_links, false); assert.equal(body.unfurl_media, false);
  });
}

test('種類ごとの見出しと、office の URL が http(s) でない・長い時はボタンを出さない', () => {
  for (const kind of ['approval', 'decision', 'run_failing', 'stuck', 'stale_routine']) {
    const m = slackMessage({ type: 'notice', lang: 'en', form: 'titles', kind, items: [{ kind, title: 'T' }] }, OFFICE);
    assert.ok(m.text.length > 3 && !m.text.startsWith('slack_'), m.text);
  }
  for (const bad of ['javascript:alert(1)', 'file:///etc/passwd', `http://localhost/${'x'.repeat(200)}`, 'http://u:p@localhost/x']) {
    assert.equal(officeUrlOk(bad), false);
    assert.equal(buttons(slackMessage({ type: 'test', lang: 'en' }, bad)).length, 0);
  }
});

test('previewHash: 入力は設定だけ。知らせを足しても変わらず、指紋・言語・office の URL・種類・形のどれかを替えると変わる', () => {
  const base = { fp: destFingerprint(URL_A), kinds: ['digest', 'approval'], form: 'titles', lang: 'en', officeUrl: OFFICE };
  const h = previewHash(base);
  assert.match(h, /^[0-9a-f]{32}$/);
  assert.equal(previewHash({ ...base, kinds: ['approval', 'digest'] }), h, '順は問わない');
  for (const ch of [{ fp: destFingerprint(URL_A2) }, { lang: 'ja' }, { officeUrl: 'http://localhost:3100/X/office' }, { kinds: ['digest'] }, { form: 'counts' }]) assert.notEqual(previewHash({ ...base, ...ch }), h, JSON.stringify(ch));
});

test('既定は 1 か所の定数（Q1 (c)・Q2 (a)）: 種類は朝夕のまとめだけ・形は題つき', () => {
  assert.deepEqual([...SLACK_DEFAULTS.kinds], ['digest']); assert.equal(SLACK_DEFAULTS.form, 'titles');
  assert.equal(checkChoice({ kinds: ['run_failed', 'digest'], form: 'titles' }).kinds.join(), 'digest', 'run_failed は選べない');
  assert.equal(checkChoice({ kinds: [], form: 'titles' }), null); assert.equal(checkChoice({ kinds: ['digest'], form: 'html' }), null);
});

// ---- 失敗の扱い（S6） ----
test('classifySlack と nextAttempt: S6 の表の行ごと', () => {
  assert.deepEqual(classifySlack({ status: 200, body: 'ok' }), { action: 'sent', code: 'ok', status: 200 });
  assert.deepEqual(classifySlack({ status: 400, body: 'invalid_payload' }), { action: 'drop', code: 'invalid_payload', status: 400 });
  for (const [s, b] of [[401, 'invalid_token'], [403, 'action_prohibited'], [404, 'no_service'], [410, 'channel_is_archived']]) assert.deepEqual(classifySlack({ status: s, body: b }), { action: 'dead', code: b, status: s });
  assert.deepEqual(classifySlack({ status: 404, body: '<html>Not found https://hooks.slack.com/services/x</html>' }), { action: 'dead', code: 'http_404', status: 404 }, '形の合わない答えは使わない');
  assert.equal(classifySlack({ status: 429, body: '', headers: { 'retry-after': '2' } }).waitMs, 2000);
  assert.equal(classifySlack({ status: 429, body: '', headers: {} }).waitMs, 60_000);
  assert.equal(classifySlack({ status: 429, body: '', headers: { 'retry-after': '4000' } }).waitMs, 3_600_000);
  assert.equal(classifySlack({ status: 429, body: '', headers: { 'retry-after': 'soon' } }).waitMs, 60_000);
  for (const s of [500, 503, 302, 418]) assert.deepEqual(classifySlack({ status: s, body: 'x' }), { action: 'retry', code: `http_${s}`, status: s });
  assert.deepEqual([1, 2, 3, 4, 5, 9].map(a => (nextAttempt(a, 0)) / 60_000), [1, 5, 15, 60, 60, 60]);
});

test('errorCode: URL の全文を含む error を渡しても、印に URL の文字が無い', () => {
  const cases = [[new Error(`Invalid URL: ${URL_A}`), 'blocked'], [Object.assign(new Error(`getaddrinfo ENOTFOUND hooks.slack.com ${URL_A}`), { code: 'ENOTFOUND' }), 'dns'], [new Error(`DNS resolution failed for hooks.slack.com`), 'dns'],
    [Object.assign(new Error(`self-signed certificate ${URL_A}`), { code: 'DEPTH_ZERO_SELF_SIGNED_CERT' }), 'tls'], [Object.assign(new Error('x'), { name: 'TimeoutError' }), 'timeout'], [new Error(`connect ECONNREFUSED ${URL_A}`), 'network'], [new Error('Request to private IP blocked'), 'blocked']];
  for (const [e, want] of cases) { const c = errorCode(e); assert.equal(c, want, e.message); assert.ok(!c.includes('hooks') && !c.includes('services')); }
});

// ---- 口（S1・S2・S5〜S8） ----
test('confirm: nonce が有効で、引いた指紋が照合の口の答えの指紋と合い、hash が合う時だけ ON', async () => {
  const w = world();
  const r = await w.turnOn('A', { kinds: ['digest', 'approval'] });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  const s = await st(w);
  assert.equal(s.on, true); assert.equal(s.fp, destFingerprint(URL_A)); assert.deepEqual(s.kinds, ['digest', 'approval']); assert.equal(s.officeUrl, OFFICE); assert.equal(s.lang, 'en');
  assert.ok(!JSON.stringify(s).includes(tok('a').split('/')[2]), 'state に URL を置かない');
  assert.ok(!JSON.stringify(r.body).includes('hooks.slack.com'));
});

test('confirm: nonce なし・使い済み・期限切れ・別の会社の nonce は 403。古い hash・宛先なしは 409', async () => {
  const w = world();
  const pv = await w.route('slack-preview', 'A', { query: { kinds: 'digest', form: 'titles', lang: 'en', officeUrl: OFFICE } });
  const good = { kinds: ['digest'], form: 'titles', previewHash: pv.body.hash, lang: 'en', officeUrl: OFFICE };
  const fp = destFingerprint(URL_A);
  assert.equal((await w.route('slack-confirm', 'A', { body: good })).status, 403, 'nonce なし');
  assert.equal((await w.route('slack-confirm', 'A', { body: { ...good, nonce: 'f'.repeat(64) } })).status, 403, '作っていない nonce');
  const n1 = w.issueNonce('A', pv.body.hash, fp);
  assert.equal((await w.route('slack-confirm', 'A', { body: { ...good, nonce: n1 } })).status, 200);
  await w.route('slack-off', 'A');
  assert.equal((await w.route('slack-confirm', 'A', { body: { ...good, nonce: n1 } })).status, 403, '使い済み');
  const n2 = w.issueNonce('A', pv.body.hash, fp); w.tick(121_000);
  assert.equal((await w.route('slack-confirm', 'A', { body: { ...good, nonce: n2 } })).status, 403, '期限切れ');
  const n3 = w.issueNonce('B', pv.body.hash, fp);
  assert.equal((await w.route('slack-confirm', 'A', { body: { ...good, nonce: n3 } })).status, 403, '別の会社');
  const n4 = w.issueNonce('A', 'a'.repeat(32), fp);
  assert.equal((await w.route('slack-confirm', 'A', { body: { ...good, nonce: n4 } })).status, 403, '別の hash に結んだ nonce');
  // 種類を替えた後に古い hash（nonce は新しい hash に結ぶ = 起動係は画面の hash を渡すので、画面が古い hash のまま押した形）
  const n5 = w.issueNonce('A', pv.body.hash, fp);
  const r5 = await w.route('slack-confirm', 'A', { body: { ...good, nonce: n5, form: 'counts' } });
  assert.equal(r5.status, 409); assert.equal(r5.body.error, 'slack_preview_stale');
  assert.equal((await st(w)).on, false);
  // 宛先の無い会社
  delete w.config.A.slack;
  const n6 = w.issueNonce('A', pv.body.hash, fp);
  const r6 = await w.route('slack-confirm', 'A', { body: { ...good, nonce: n6 } });
  assert.equal(r6.status, 409); assert.equal(r6.body.error, 'slack_no_dest');
});

test('confirm: 見本の前に本体の口で秘密の値か設定の参照を替えた場合は、hash を作り直して送っても 409 で ON にならない', async () => {
  for (const change of ['value', 'ref']) {
    const w = world();
    const savedFp = destFingerprint(URL_A); // 持ち主が起動係で保存した宛先
    if (change === 'value') w.secretVals.sA = URL_A2; else w.config.A.slack.webhook = { type: 'secret_ref', secretId: 'sA2' };
    const pv = await w.route('slack-preview', 'A', { query: { kinds: 'digest', form: 'titles', lang: 'en', officeUrl: OFFICE } }); // 担当が替えた宛先で作った hash
    const r = await w.route('slack-confirm', 'A', { body: { nonce: w.issueNonce('A', pv.body.hash, savedFp), kinds: ['digest'], form: 'titles', previewHash: pv.body.hash, lang: 'en', officeUrl: OFFICE } });
    assert.equal(r.status, 409, change); assert.equal(r.body.error, 'slack_dest_changed');
    assert.equal((await st(w)).on, false); assert.equal((await st(w)).offReason, 'dest_changed');
    assert.equal(w.calls.fetch.length, 0);
  }
});

test('照合の口の行き先は plugin の設定から読まない（package の決まりの port・env の数だけ）', () => {
  assert.equal(nonceUrl({}), 'http://127.0.0.1:3100/setup/internal/slack-nonce');
  assert.equal(nonceUrl({ AIOFFICE_LAUNCHER_PORT: '3200' }), 'http://127.0.0.1:3200/setup/internal/slack-nonce');
  assert.equal(nonceUrl({ AIOFFICE_LAUNCHER_PORT: 'evil.example' }), 'http://127.0.0.1:3100/setup/internal/slack-nonce');
  const src = readFileSync(new URL('../plugins/notify/src/slack-worker.mjs', import.meta.url), 'utf8');
  assert.ok(!/config[^\n]*(nonce|launcher)/i.test(src.replace(/\/\/.*$/gm, '')), '設定から照合の口を読まない');
});

test('見本と送る文が同じ: previewOf の形と、同じ知らせで /deliver が偽の http に渡す text と blocks が一致する', async () => {
  for (const form of ['titles', 'counts']) {
    const w = world();
    await w.turnOn('A', { kinds: ['approval'], form });
    w.tick(1000);
    const n = w.add('A', 'approval', 'ap1', 'Publish price list <!here> @channel & co');
    const pv = await w.route('slack-preview', 'A', { query: { kinds: 'approval', form, lang: 'en', officeUrl: OFFICE } });
    const r = await w.route('deliver', 'A');
    assert.equal(r.body.sent, 1, JSON.stringify(r.body));
    const sent = w.calls.fetch[0].body;
    assert.equal(sent.text, pv.body.messages[0].text); assert.deepEqual(sent.blocks, pv.body.messages[0].blocks);
    assert.equal(w.calls.fetch[0].url, URL_A);
    const js = JSON.stringify(sent);
    assert.ok(!js.includes('<!here>') && !js.includes('@channel'), js);
    assert.equal(n.kind, 'approval');
  }
});

test('写しで送る: ON の後に本体の設定を替えても種類と形は ON の時のまま。秘密の値か参照を替えると送らずに OFF', async () => {
  const w = world();
  await w.turnOn('A', { kinds: ['digest'], form: 'counts' });
  w.tick(1000); w.add('A', 'approval', 'ap1', 'Not selected'); w.add('A', 'stuck', 'st1', 'Not selected either');
  w.config.A.slack.kinds = ['approval']; // 本体の設定の口で足しても使わない
  await w.route('deliver', 'A');
  assert.equal(w.calls.fetch.length, 0, '選んでいない種類は送らない');
  w.add('A', 'digest', '2026-11-18:pm', 'Evening');
  await w.route('deliver', 'A');
  assert.equal(w.calls.fetch.length, 1); assert.ok(!JSON.stringify(w.calls.fetch[0].body).includes('Not selected'), '件数だけの形のまま');
  // 秘密の値を替える
  w.secretVals.sA = URL_A2; w.add('A', 'digest', '2026-11-19:am', 'Morning');
  const r = await w.route('deliver', 'A');
  assert.equal(r.body.off, true); assert.equal(w.calls.fetch.length, 1); assert.equal((await st(w)).offReason, 'dest_changed');
  assert.ok(w.notices.some(n => n.kind === 'slack_failed'), '受信箱に 1 件');
  // 参照を替える
  const w2 = world(); await w2.turnOn('A'); w2.config.A.slack.webhook = { type: 'secret_ref', secretId: 'sA2' }; w2.add('A', 'digest', 'x:am', 'm');
  assert.equal((await w2.route('deliver', 'A')).body.off, true); assert.equal(w2.calls.fetch.length, 0);
});

test('OFF の時に送らない: OFF・宛先なし・未確認・指紋違い・止まった の各状態で、tick・deliver・test・event を 100 回流しても fetch と秘密の引きが 0 回', async () => {
  const states = {
    off: async w => { await w.turnOn(); await w.route('slack-off', 'A'); },
    no_dest: async w => { delete w.config.A.slack; },
    unconfirmed: async () => {},
    fp_mismatch: async w => { await w.turnOn(); w.secretVals.sA = URL_A2; await w.route('deliver', 'A'); }, // 最初の 1 回で気づいて OFF（その 1 回の引きは数えない）
    stopped: async w => { await w.turnOn(); w.setReply(() => ({ status: 404, body: 'no_service' })); w.add('A', 'digest', 'd0:am', 'x'); await w.route('deliver', 'A'); },
  };
  for (const [name, prep] of Object.entries(states)) {
    const w = world();
    await prep(w);
    const f0 = w.calls.fetch.length, r0 = w.calls.resolve;
    for (let i = 0; i < 100; i++) {
      w.add('A', i % 2 ? 'approval' : 'digest', `o${i}`, `t${i}`);
      await handleTick(w.deps, 'A', { lang: 'en' });
      await w.route('deliver', 'A');
      await w.route('slack-test', 'A');
      w.tick(61_000);
    }
    assert.equal(w.calls.fetch.length - f0, 0, `${name}: fetch`);
    assert.equal(w.calls.resolve - r0, 0, `${name}: secrets.resolve`);
    assert.equal((await st(w))?.on ?? false, false, name);
  }
});

test('OFF にした時に待ちの行が消え、ON にし直しても前の知らせを送らない', async () => {
  const w = world();
  await w.turnOn('A', { kinds: ['approval'] });
  w.setReply(() => ({ status: 500, body: '' }));
  w.tick(1000); w.add('A', 'approval', 'a1', 'Before off');
  await w.route('deliver', 'A');
  assert.equal([...w.sends.values()].filter(s => s.status === 'pending').length, 1);
  await w.route('slack-off', 'A');
  assert.equal([...w.sends.values()].filter(s => s.status === 'pending').length, 0, '待ちが消える');
  w.tick(1000); w.add('A', 'approval', 'a2', 'While off');
  w.setReply(() => ({ status: 200, body: 'ok' }));
  w.tick(1000); await w.turnOn('A', { kinds: ['approval'] });
  w.tick(120 * 60_000);
  const r = await w.route('deliver', 'A');
  assert.equal(r.body.sent, 0);
  assert.equal(w.calls.fetch.length, 1, 'OFF の前の失敗の 1 回だけ。前の知らせ・OFF の間の知らせは送らない');
  w.add('A', 'approval', 'a3', 'After on');
  assert.equal((await w.route('deliver', 'A')).body.sent, 1);
  assert.match(JSON.stringify(w.calls.fetch[1].body), /After on/);
});

test('S6: 429 は Retry-After まで待ち、失敗に数えない。500 は送り直し・3 回続くと帯の数。404 は OFF と受信箱。400 はその 1 通を捨てる。24 時間で捨てて数える', async () => {
  const w = world();
  await w.turnOn('A', { kinds: ['approval'] });
  w.tick(1000); w.add('A', 'approval', 'a1', 'One');
  w.setReply(() => ({ status: 429, body: '', headers: { 'retry-after': '2' } }));
  let r = await w.route('deliver', 'A');
  assert.equal(r.body.rateLimited, true); assert.equal((await st(w)).failStreak, 0);
  w.setReply(() => ({ status: 200, body: 'ok' }));
  r = await w.route('deliver', 'A'); assert.equal(r.body.sent, 0, '2 秒の前は送らない');
  w.tick(2000); r = await w.route('deliver', 'A'); assert.equal(r.body.sent, 1);
  // 500 が 3 回
  w.add('A', 'approval', 'a2', 'Two');
  w.setReply(() => ({ status: 500, body: 'oops' }));
  for (const gap of [0, 60_000, 5 * 60_000]) { w.tick(gap); await w.route('deliver', 'A'); }
  let s = await st(w);
  assert.equal(s.failStreak, 3); assert.equal(s.lastFail.status, 500); assert.equal(s.on, true);
  const sa = await w.route('slack', 'A'); assert.equal(sa.body.failStreak, 3); assert.equal(sa.body.waiting, 1);
  w.setReply(() => ({ status: 200, body: 'ok' })); w.tick(15 * 60_000); await w.route('deliver', 'A');
  assert.equal((await st(w)).failStreak, 0, '直ると数が戻る');
  // 400
  w.add('A', 'approval', 'a3', 'Three'); w.setReply(() => ({ status: 400, body: 'invalid_payload' }));
  await w.route('deliver', 'A');
  assert.equal((await st(w)).lastDrop.code, 'invalid_payload'); assert.equal((await w.route('slack', 'A')).body.waiting, 0);
  // 24 時間
  w.add('A', 'approval', 'a4', 'Four'); w.setReply(() => ({ status: 503, body: '' }));
  await w.route('deliver', 'A'); w.tick(24 * 3600_000 + 1);
  await w.route('deliver', 'A');
  assert.equal((await st(w)).dropped, 1);
  // 404
  w.add('A', 'approval', 'a5', 'Five'); w.setReply(() => ({ status: 404, body: 'no_service' }));
  await w.route('deliver', 'A');
  s = await st(w);
  assert.equal(s.on, false); assert.equal(s.offReason, 'dead'); assert.equal(s.offCode, 'no_service');
  assert.ok(w.notices.some(n => n.kind === 'slack_failed' && n.title.includes('no_service')));
  const before = w.calls.fetch.length; w.add('A', 'approval', 'a6', 'Six'); await w.route('deliver', 'A');
  assert.equal(w.calls.fetch.length, before, 'OFF の後は増えない');
});

test('網の失敗・8 秒の待ち超えは送り直しで、返事と state に URL の文字が無い', async () => {
  const w = world();
  await w.turnOn('A', { kinds: ['approval'] });
  w.tick(1000); w.add('A', 'approval', 'a1', 'One');
  w.deps.http.fetch = async () => { throw new Error(`connect ECONNREFUSED ${URL_A}`); };
  let r = await w.route('deliver', 'A');
  assert.equal(r.body.last, 'network');
  // 8 秒より長く待つ
  const real = globalThis.setTimeout;
  w.deps.http.fetch = () => new Promise(() => {});
  const p = postSlack(w.deps, 'A', { url: URL_A, fp: destFingerprint(URL_A) }, '{}', (await st(w)).onAt);
  const res = await p; // 8 秒の待ちは本物の時計（短くはしない）
  assert.equal(res.code, 'timeout');
  assert.equal(real, globalThis.setTimeout);
  const all = JSON.stringify([r.body, await st(w), (await w.route('slack', 'A')).body]);
  for (const part of tok('a').split('/')) assert.ok(!all.includes(part), part);
});

test('枠: 1 回の口で 3 通・1.1 秒あける・1 時間 20 通・超えた分は次の回に 1 通のまとめ・20 秒の枠で 9 秒を切ったら送らない', async () => {
  const w = world();
  await w.turnOn('A', { kinds: ['approval'] });
  w.tick(1000);
  for (let i = 0; i < 25; i++) w.add('A', 'approval', `a${i}`, `A${i}`);
  const t0 = w.clock;
  let r = await w.route('deliver', 'A');
  assert.equal(r.body.sent, 3); assert.ok(w.clock - t0 >= 2 * 1100, '1.1 秒ずつあける');
  for (let i = 0; i < 10; i++) await w.route('deliver', 'A');
  const s = await st(w);
  assert.equal(s.hour.n, 20, '1 時間 20 通まで'); assert.equal(s.overflow, 5);
  assert.equal(w.calls.fetch.length, 20);
  w.tick(3600_000);
  r = await w.route('deliver', 'A');
  assert.match(JSON.stringify(w.calls.fetch[20].body), /5 more notices/);
  assert.equal((await st(w)).overflow, 0);
  // 枠: 1 通ごとに 7 秒かかると、2 通目の後は残りが 9 秒を切るので 3 通目を送らない
  const w2 = world(); await w2.turnOn('A', { kinds: ['approval'] }); w2.tick(1000);
  for (let i = 0; i < 3; i++) w2.add('A', 'approval', `b${i}`, `B${i}`);
  w2.setReply(() => { w2.tick(5000); return { status: 200, body: 'ok' }; });
  r = await w2.route('deliver', 'A');
  assert.equal(r.body.sent, 2);
});

test('2 社: A の送りは B の知らせを送らず B の宛先を使わない', async () => {
  const w = world();
  await w.turnOn('A', { kinds: ['approval'] }); await w.turnOn('B', { kinds: ['approval'], savedUrl: URL_B });
  w.tick(1000); w.add('A', 'approval', 'a1', 'For A'); w.add('B', 'approval', 'b1', 'For B');
  await w.route('deliver', 'A');
  assert.equal(w.calls.fetch.length, 1); assert.equal(w.calls.fetch[0].url, URL_A); assert.match(JSON.stringify(w.calls.fetch[0].body), /For A/);
  await w.route('deliver', 'B');
  assert.equal(w.calls.fetch[1].url, URL_B); assert.match(JSON.stringify(w.calls.fetch[1].body), /For B/);
  await w.route('slack-off', 'B'); w.add('B', 'approval', 'b2', 'B again'); await w.route('deliver', 'B');
  assert.equal(w.calls.fetch.length, 2);
});

test('試しの 1 通: ON の時だけ・1 分に 1 回・会社の題を含まない', async () => {
  const w = world();
  assert.equal((await w.route('slack-test', 'A')).status, 409);
  await w.turnOn('A');
  w.add('A', 'approval', 'a1', 'Company secret title');
  const r = await w.route('slack-test', 'A');
  assert.equal(r.body.result, 'ok');
  assert.ok(!JSON.stringify(w.calls.fetch[0].body).includes('Company secret title'));
  assert.match(w.calls.fetch[0].body.text, /test message/);
  assert.equal((await w.route('slack-test', 'A')).status, 429);
  w.tick(60_000); assert.equal((await w.route('slack-test', 'A')).status, 200);
});

test('同じ知らせは 1 回だけ・承認が決まって消えた知らせは送らない・まとめは 0 件でも送る', async () => {
  const w = world();
  await w.turnOn('A', { kinds: ['digest', 'approval'] });
  w.tick(1000); w.add('A', 'digest', '2026-11-18:am', 'Morning');
  await w.route('deliver', 'A'); await w.route('deliver', 'A');
  assert.equal(w.calls.fetch.length, 1); assert.match(w.calls.fetch[0].body.text, /nothing is waiting/);
  const gone = w.add('A', 'approval', 'gone', 'Decided');
  w.notices.splice(w.notices.indexOf(gone), 1);
  await w.route('deliver', 'A'); assert.equal(w.calls.fetch.length, 1);
});

test('見本: 選んだ種類ごとに 1 通・無い種類は決まった例・宛先が無い時は 409・URL の文字は返事に無い', async () => {
  const w = world();
  w.add('A', 'decision', 'd1', 'Decision waiting: pick a logo');
  const pv = await w.route('slack-preview', 'A', { query: { kinds: 'digest,approval,decision', form: 'titles', lang: 'ja', officeUrl: OFFICE } });
  assert.equal(pv.status, 200); assert.equal(pv.body.messages.length, 3);
  assert.match(JSON.stringify(pv.body.messages[1]), /例:/); assert.match(JSON.stringify(pv.body.messages[2]), /pick a logo/);
  assert.ok(!JSON.stringify(pv.body).includes('hooks.slack.com'));
  assert.equal((await w.route('slack-preview', 'A', { query: { kinds: 'nope', form: 'titles', lang: 'en', officeUrl: OFFICE } })).status, 400);
  delete w.config.A.slack;
  assert.equal((await w.route('slack-preview', 'A', { query: { kinds: 'digest', form: 'titles', lang: 'en', officeUrl: OFFICE } })).status, 409);
});

test('状態の口: URL を返さず、既定と選べる物を返す', async () => {
  const w = world();
  const s = await w.route('slack', 'A');
  assert.equal(s.body.on, false); assert.equal(s.body.configured, true); assert.deepEqual(s.body.defaults, { kinds: ['digest'], form: 'titles' });
  assert.ok(!JSON.stringify(s.body).includes('hooks'));
});

test('口の error の文を外へ出さない（Slack の口は detail なし）', async () => {
  const mod = readFileSync(new URL('../plugins/notify/src/worker.mjs', import.meta.url), 'utf8');
  assert.match(mod, /startsWith\('slack'\) \|\| input\?\.routeKey === 'deliver' \? \{ error: 'notify_failed' \}/);
  for (const r of manifest.apiRoutes) if (r.routeKey.startsWith('slack') || r.routeKey === 'deliver') assert.ok(r.routeKey.startsWith('slack') || r.routeKey === 'deliver');
});

// ---- lint（S2・S3・S4） ----
const strip = s => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:'"`\\])\/\/.*$/gm, '$1');
const notifySrc = ['worker.mjs', 'lib.mjs', 'slack.mjs', 'slack-worker.mjs', 'manifest.mjs'].map(f => [f, strip(readFileSync(new URL(`../plugins/notify/src/${f}`, import.meta.url), 'utf8'))]);
test('lint: 本体の http.fetch を呼ぶ所は 1 か所（postSlack）・Node の fetch は照合の 1 か所だけ・ほかの網の口は無い', async () => {
  const host = notifySrc.flatMap(([f, s]) => [...s.matchAll(/\.http\.fetch\(/g)].map(() => f));
  assert.deepEqual(host, ['slack-worker.mjs']);
  const node = notifySrc.flatMap(([f, s]) => [...s.matchAll(/(?<![.\w])fetch\(/g)].map(() => f));
  assert.deepEqual(node, ['slack-worker.mjs']);
  const sw = notifySrc.find(([f]) => f === 'slack-worker.mjs')[1];
  const nodeAt = sw.search(/(?<![.\w])fetch\(/), fnAt = sw.lastIndexOf('export async function askLauncher', nodeAt);
  assert.ok(fnAt > 0 && sw.slice(fnAt, nodeAt).split('\n').length < 5, 'Node の fetch は起動係に聞く askLauncher の中だけ');
  const hostAt = sw.search(/\.http\.fetch\(/), postAt = sw.lastIndexOf('export async function postSlack', hostAt);
  assert.ok(postAt > 0 && hostAt - postAt < 1200, 'http.fetch は postSlack の中だけ');
  for (const [f, s] of notifySrc) assert.ok(!/https?\.request|undici|WebSocket|from\s*['"](?:node:)?(?:http|https|http2|net|tls|dgram|child_process)['"]/.test(s), f);
  // 束ねた worker にも、自前の分は 2 か所だけ（SDK の既知の http の口を除く）
  const r = await build({ entryPoints: [new URL('../plugins/notify/src/worker.mjs', import.meta.url).pathname], bundle: true, platform: 'node', format: 'esm', target: 'node22', write: false, metafile: true, logLevel: 'silent' });
  const own = Object.keys(r.metafile.inputs).filter(p => !p.includes('node_modules'));
  assert.ok(own.some(p => p.endsWith('slack-url.mjs')), '起動係と同じ形の確かめを取り込む');
});

test('lint: notify の口の body に URL を受ける欄が無い（webhook の URL は起動係だけが受ける）', () => {
  const fields = notifySrc.flatMap(([, s]) => [...s.matchAll(/\b(?:body|b)\??\.([A-Za-z_]\w*)/g)].map(m => m[1]));
  assert.ok(fields.length > 3);
  for (const f of fields) assert.ok(!/^(url|webhook|hook|slackUrl|webhookUrl|dest|destination|value)$/i.test(f), f);
});

test('lint: Slack の処理で ctx.logger を使わない（URL・秘密を渡す道を作らない）', () => {
  for (const f of ['slack.mjs', 'slack-worker.mjs']) assert.ok(!/logger|console\./.test(notifySrc.find(([n]) => n === f)[1]), f);
});

test('lint: 送りの記録の表の SQL は全部、会社で絞る', () => {
  const calls = [];
  const db = { namespace: 'ns', execute: async (sql, p) => { calls.push(sql); return { rowCount: 0 }; }, query: async (sql, p) => { calls.push(sql); return []; } };
  const s = slackStore(db);
  return Promise.all([s.enqueue('A', ['digest'], new Date().toISOString()), s.dropOrphans('A'), s.due('A', new Date().toISOString()), s.pendingCount('A'), s.markSent('A', 'k', 'x'), s.markRetry('A', 'k', 1, 'x', 'c'), s.markDone('A', 'k', 'dropped', 'c'), s.giveUp('A', 'x'), s.clearPending('A')]).then(() => {
    assert.equal(calls.length, 9);
    for (const q of calls) { assert.match(q, /company_id = \$1/, q); assert.ok(!/\bdelete\b/i.test(q) || /^DELETE FROM/.test(q)); }
    for (const q of calls.filter(x => /^SELECT/.test(x))) assert.ok(!/\b(insert|update|delete)\b/i.test(q), `本体は SELECT にこれらの語を断る: ${q}`);
  });
});

test('migration 004: 送りの記録の表は会社と知らせの key が主キー', () => {
  const sql = readFileSync(new URL('../plugins/notify/migrations/004_slack.sql', import.meta.url), 'utf8');
  assert.match(sql, /PRIMARY KEY \(company_id, notice_key\)/);
  assert.match(sql, /plugin_notify_4b4010a560\.sends/);
});

test('manifest: Slack の口は全部 board・会社は query・設定の宛先は secret-ref', () => {
  for (const k of ['slack', 'slack-preview', 'slack-confirm', 'slack-off', 'slack-test', 'deliver']) {
    const r = manifest.apiRoutes.find(x => x.routeKey === k); assert.ok(r, k);
    assert.equal(r.auth, 'board'); assert.deepEqual(r.companyResolution, { from: 'query', key: 'companyId' });
  }
  assert.equal(manifest.instanceConfigSchema.properties.slack.properties.webhook.format, 'secret-ref');
  assert.equal(manifest.instanceConfigSchema.properties.stuckIdleMin.default, 60, '前の設定の欄を消さない');
});

test('messageFor: まとめは、まとめより前にできた未読の知らせだけを一覧にする', () => {
  const ns = [{ kind: 'approval', title: 'old', createdAt: '2026-11-18T07:00:00Z' }, { kind: 'approval', title: 'later', createdAt: '2026-11-18T09:00:00Z' }, { kind: 'stuck', title: 'read', createdAt: '2026-11-18T07:00:00Z', readAt: 'x' }, { kind: 'slack_failed', title: 'sf', createdAt: '2026-11-18T07:00:00Z' }];
  const m = messageFor({ kind: 'digest', originId: '2026-11-18:am', createdAt: '2026-11-18T08:00:00Z' }, { lang: 'en', form: 'titles', notices: ns });
  assert.deepEqual(m.items.map(x => x.title), ['old']);
  assert.equal(safeTitle('x', 5), 'x');
});

test('previewOf は送る時と同じ関数（slackMessage・messageFor）で作る', () => {
  const src = readFileSync(new URL('../plugins/notify/src/slack.mjs', import.meta.url), 'utf8');
  const fn = src.slice(src.indexOf('export function previewOf'), src.indexOf('// Slack の短い答え'));
  assert.match(fn, /slackMessage\(messageFor\(/);
  const ex = previewOf({ kinds: ['approval'], form: 'titles', lang: 'en', officeUrl: OFFICE, notices: [] });
  assert.match(ex[0].blocks[1].text.text, /Example/);
});

// ---- 守りを 1 つずつ外した時に落ちる試験（守りが重なっている所も、それぞれの守りを直に見る） ----
test('postSlack は呼ばれた時に自分で state を読み直す: OFF なら送らない・指紋が ON の時と違えば送らずに OFF', async () => {
  const w = world();
  await w.turnOn('A', { kinds: ['approval'] });
  const body = slackBody(slackMessage({ type: 'test', lang: 'en' }, OFFICE));
  const destA = { url: URL_A, fp: destFingerprint(URL_A) };
  await w.route('slack-off', 'A');
  assert.deepEqual(await postSlack(w.deps, 'A', destA, body, (await st(w)).onAt), { skipped: 'off' });
  assert.equal(w.calls.fetch.length, 0);
  await w.turnOn('A', { kinds: ['approval'] });
  const other = { url: URL_A2, fp: destFingerprint(URL_A2) };
  assert.deepEqual(await postSlack(w.deps, 'A', other, body, (await st(w)).onAt), { skipped: 'dest_changed' });
  assert.equal(w.calls.fetch.length, 0, '指紋の違う宛先へ送らない');
  const s = await st(w); assert.equal(s.on, false); assert.equal(s.offReason, 'dest_changed');
});

test('送りの途中で OFF にされたら、次の 1 通の前の 1.1 秒も待たずにその回を終える', async () => {
  const w = world();
  await w.turnOn('A', { kinds: ['approval'] });
  w.tick(1000); w.add('A', 'approval', 'm1', 'One'); w.add('A', 'approval', 'm2', 'Two');
  let slept = 0; const sleep0 = w.deps.sleep; w.deps.sleep = async ms => { slept++; return sleep0(ms); };
  w.setReply(async () => { await w.route('slack-off', 'A'); return { status: 200, body: 'ok' }; }); // 1 通目の送りの間に持ち主が OFF
  const r = await w.route('deliver', 'A');
  assert.equal(w.calls.fetch.length, 1); assert.equal(r.body.attempted, 1);
  assert.equal(slept, 0, 'OFF の後に待たない');
});

test('confirm: 形の合わない nonce は照合の口に問い合わせもしない', async () => {
  const w = world();
  const pv = await w.route('slack-preview', 'A', { query: { kinds: 'digest', form: 'titles', lang: 'en', officeUrl: OFFICE } });
  let asked = 0; const v0 = w.deps.verifyNonce; w.deps.verifyNonce = async a => { asked++; return v0(a); };
  for (const nonce of [undefined, '', 'x'.repeat(64), 'F'.repeat(64), 'f'.repeat(63), { a: 1 }]) {
    assert.equal((await w.route('slack-confirm', 'A', { body: { nonce, kinds: ['digest'], form: 'titles', previewHash: pv.body.hash, lang: 'en', officeUrl: OFFICE } })).status, 403, JSON.stringify(nonce));
  }
  assert.equal(asked, 0);
});

// ---- 実装 r1 の指摘（state の書き込みの鍵・ON の印・status） ----
test('鍵: 送った後の書き込みが ON の state を読んだ後に持ち主が OFF にしても、古い値で ON に戻さず、OFF の間の知らせを次の回に送らない', async () => {
  const w = world();
  await w.turnOn('A', { kinds: ['approval'] });
  w.tick(1000); w.add('A', 'approval', 'r1', 'One');
  // 送った後の最初の state の読み（送った後の書き込みの読み）を、値を読んだ所で止める
  let armed = false, release, paused;
  const gate = new Promise(r => { release = r; }), reached = new Promise(r => { paused = r; });
  const get0 = w.deps.state.get;
  w.deps.state.get = async k => { const v = await get0(k); if (armed) { armed = false; paused(); await gate; } return v; };
  w.setReply(() => { armed = true; return { status: 200, body: 'ok' }; });
  const d = w.route('deliver', 'A');
  await reached; // 送った後の書き込みが ON の state を読んだ
  const off = w.route('slack-off', 'A'); // 持ち主が OFF
  for (let i = 0; i < 20; i++) await new Promise(r => setImmediate(r)); // 鍵が無ければ、この間に OFF が書き終わる
  release();
  assert.equal((await d).status, 200); assert.equal((await off).status, 200);
  const s = await st(w);
  assert.equal(s.on, false, '古い書き込みで ON に戻らない');
  assert.equal(s.offReason, 'owner');
  // OFF の間にできた知らせは、次の回にも送らない
  w.tick(60_000); w.add('A', 'approval', 'r2', 'During off');
  const r = await w.route('deliver', 'A');
  assert.equal(r.body.off, true);
  assert.equal(w.calls.fetch.length, 1);
  assert.ok(!w.calls.fetch.some(f => JSON.stringify(f.body).includes('During off')));
});

test('ON の印: 送りの呼び出しの間に OFF → ON し直されたら、前の ON の時に読んだ知らせは送らない', async () => {
  const w = world();
  await w.turnOn('A', { kinds: ['approval'] });
  w.tick(1000); w.add('A', 'approval', 'n1', 'One'); w.add('A', 'approval', 'n2', 'Two');
  let once = true;
  w.setReply(async () => { if (once) { once = false; await w.route('slack-off', 'A'); w.tick(1000); const on = await w.turnOn('A', { kinds: ['approval'] }); assert.equal(on.status, 200); } return { status: 200, body: 'ok' }; });
  const r = await w.route('deliver', 'A');
  assert.equal(w.calls.fetch.length, 1, '2 通目（前の ON の時に読んだ物）は送らない');
  assert.equal(r.body.attempted, 1);
  assert.ok(!JSON.stringify(w.calls.fetch).includes('Two'));
  const s = await st(w); assert.equal(s.on, true);
});

test('鍵: 試しの 1 通を同時に 2 回押しても、送るのは 1 通だけ', async () => {
  const w = world();
  await w.turnOn('A');
  const [a, b] = await Promise.all([w.route('slack-test', 'A'), w.route('slack-test', 'A')]);
  assert.deepEqual([a.status, b.status].sort(), [200, 429]);
  assert.equal(w.calls.fetch.length, 1);
});

test('status: 401 の invalid_token のように code が数でない答えでも、最後の失敗に 401 を残す', async () => {
  for (const [status, body] of [[401, 'invalid_token'], [403, 'action_prohibited'], [404, 'no_service'], [410, 'channel_is_archived']]) {
    const w = world();
    await w.turnOn('A', { kinds: ['approval'] });
    w.tick(1000); w.add('A', 'approval', 'x1', 'One');
    w.setReply(() => ({ status, body }));
    await w.route('deliver', 'A');
    const s = await st(w);
    assert.deepEqual([s.on, s.lastFail.status, s.lastFail.code], [false, status, body]);
  }
  const w = world();
  await w.turnOn('A', { kinds: ['approval'] });
  w.tick(1000); w.add('A', 'approval', 'x2', 'One');
  w.deps.http.fetch = async () => { throw new Error('connect ECONNREFUSED'); };
  await w.route('deliver', 'A');
  assert.equal((await st(w)).lastFail.status, null, '網の失敗は status なし');
});

test('lint: Slack の state を書く所は 1 か所（鍵の中の patchIn）だけ', () => {
  const sw = readFileSync(new URL('../plugins/notify/src/slack-worker.mjs', import.meta.url), 'utf8').replace(/\/\/.*$/gm, '');
  assert.equal([...sw.matchAll(/state\.set\(/g)].length, 1);
  const setAt = sw.search(/state\.set\(/), fnAt = sw.lastIndexOf('async function patchIn', setAt);
  assert.ok(fnAt > 0 && sw.slice(fnAt, setAt).split('\n').length < 6, 'state.set は patchIn の中だけ');
  assert.match(sw, /const patch = \(deps, companyId, fn\) => locked\(companyId, \(\) => patchIn\(deps, companyId, fn\)\);/);
  // patchIn を呼ぶのは鍵の中（locked( の後で、その鍵の関数の中）だけ。鍵の中から鍵を取る patch・turnOff を呼ばない
  const bodies = [...sw.matchAll(/locked\(companyId, async \(\) => \{([\s\S]*?)\n {2,4}\}\);/g)].map(m => m[1]);
  assert.ok(bodies.length >= 3);
  for (const b of bodies) assert.ok(!/\b(patch|turnOff)\(/.test(b), '鍵の中で鍵を取り直さない');
  const outside = sw.replace(/locked\(companyId, async \(\) => \{[\s\S]*?\n {2,4}\}\);/g, '').replace(/const patch = [^\n]*/, '').replace(/async function patchIn[\s\S]*?\n\}/, '');
  assert.ok(!/patchIn\(/.test(outside), 'patchIn は鍵の外で呼ばない');
});

// ---- 実装 独立 r3 の指摘 ----
const pendingOf = w => [...w.sends.values()].filter(s => s.status === 'pending');
// 前の ON の待ちに 1 行残した状態を作る（500 で送り直しの待ち）
async function leftPending(w, kinds = ['approval']) {
  await w.turnOn('A', { kinds });
  w.setReply(() => ({ status: 500, body: '' }));
  w.tick(1000); w.add('A', 'approval', 'a1', 'Deselected approval');
  await w.route('deliver', 'A');
  assert.equal(pendingOf(w).length, 1, '送り直しの待ちが 1 行');
  w.setReply(() => ({ status: 200, body: 'ok' }));
}

test('r3-1: ON のまま種類を外して ON にし直すと、外した種類の送り残しは送らない（ON の時に待ちを片付ける）', async () => {
  const w = world();
  await leftPending(w);
  w.tick(1000);
  assert.equal((await w.turnOn('A', { kinds: ['digest'] })).status, 200);
  assert.equal(pendingOf(w).length, 0, 'ON にし直した時に前の ON の待ちが消える');
  w.tick(120 * 60_000);
  const r = await w.route('deliver', 'A');
  assert.equal(r.body.sent, 0);
  assert.equal(w.calls.fetch.length, 1, '最初の失敗の 1 回だけ。外した種類は送らない');
});

test('r3-1: ON の時の片付けを外しても、送る直前の関門が外した種類と前の ON の行を送らずに片付ける（sent にしない・理由を残す）', async () => {
  // 種類を外した
  const w = world();
  await leftPending(w);
  w.deps.slack.clearPending = async () => {}; // 二重の守りの片方（ON の時の片付け）を外す
  w.tick(1000); await w.turnOn('A', { kinds: ['digest'] });
  assert.equal(pendingOf(w).length, 1, '片付けを外したので行は残る');
  w.tick(120 * 60_000);
  assert.equal((await w.route('deliver', 'A')).body.sent, 0);
  assert.equal(w.calls.fetch.length, 1, '関門が送らない');
  const row = [...w.sends.values()][0];
  assert.equal(row.status, 'skipped'); assert.equal(row.code, 'kind_off');
  // 同じ種類のまま ON にし直した: 前の ON の時にできた行は送らない
  const w2 = world();
  await leftPending(w2);
  w2.deps.slack.clearPending = async () => {};
  w2.tick(1000); await w2.turnOn('A', { kinds: ['approval'] });
  w2.tick(120 * 60_000);
  assert.equal((await w2.route('deliver', 'A')).body.sent, 0);
  assert.equal(w2.calls.fetch.length, 1);
  const row2 = [...w2.sends.values()][0];
  assert.equal(row2.status, 'skipped'); assert.equal(row2.code, 'before_on');
  // 新しい ON の後にできた知らせは届く
  w2.add('A', 'approval', 'a2', 'After re-on');
  assert.equal((await w2.route('deliver', 'A')).body.sent, 1);
  assert.match(JSON.stringify(w2.calls.fetch[1].body), /After re-on/);
});

test('r3-1: 関門 admit は今の写しの種類・ON の時刻・言語・形で照らし、文は写しの言語と形から作る', () => {
  const st0 = { on: true, onAt: '2026-11-18T09:00:00.000Z', kinds: ['approval'], form: 'counts', lang: 'ja', officeUrl: OFFICE };
  const item = { key: 'k', kind: 'approval', title: 'Secret title', originId: 'o', createdAt: new Date('2026-11-18T09:00:00.500Z') }; // 表の時刻は Date で来る（ms まで比べる）
  const ok = admit(st0, item);
  assert.ok(ok.body && !ok.skip);
  assert.ok(!ok.body.includes('Secret title'), '件数だけの形（写しの形）');
  assert.ok(ok.body.includes('承認待ち'), '写しの言語');
  assert.deepEqual(admit({ ...st0, kinds: ['digest'] }, item), { skip: 'kind_off' });
  assert.deepEqual(admit(st0, { ...item, createdAt: new Date('2026-11-18T08:59:59.999Z') }), { skip: 'before_on' });
  assert.deepEqual(admit(st0, { ...item, createdAt: 'not a time' }), { skip: 'before_on' });
  assert.deepEqual(admit({ ...st0, lang: 'fr' }, item), { skip: 'copy_bad' });
  assert.deepEqual(admit({ ...st0, form: 'full' }, item), { skip: 'copy_bad' });
  assert.deepEqual(admit({ ...st0, officeUrl: 'javascript:x' }, item), { skip: 'copy_bad' });
  assert.ok(admit(st0, { overflow: 3 }).body.includes('3'), 'まとめて数えた分は今の ON の数');
});

test('r3-P3-2: 設定の読み出し・秘密を引く口の失敗（上限を含む）は一時の失敗。その回だけ送らず、待ちに残し、OFF にしない', async () => {
  for (const [name, breakIt, fixIt] of [
    ['config', w => { w.deps.config.get = async () => { throw new Error('config read failed'); }; }, (w, orig) => { w.deps.config.get = orig.config; }],
    ['secrets', w => { w.deps.secrets.resolve = async () => { throw Object.assign(new Error('rate limit: 30 per minute'), { status: 429 }); }; }, (w, orig) => { w.deps.secrets.resolve = orig.resolve; }],
  ]) {
    const w = world();
    await w.turnOn('A', { kinds: ['approval'] });
    const orig = { config: w.deps.config.get, resolve: w.deps.secrets.resolve };
    w.tick(1000); w.add('A', 'approval', 'a1', 'Kept while down');
    breakIt(w);
    const r = await w.route('deliver', 'A');
    assert.equal(r.status, 200); assert.ok(!r.body.off, `${name}: OFF にしない`); assert.equal(r.body.last, 'dest_unavailable');
    const s = await st(w); assert.equal(s.on, true, name); assert.equal(s.offReason ?? null, null, name); assert.equal(s.lastFail.code, 'dest_unavailable'); assert.equal(s.failStreak, 1);
    assert.equal(w.calls.fetch.length, 0, `${name}: その回は送らない`);
    assert.ok(!w.notices.some(n => n.kind === 'slack_failed' || n.kind === 'slack_resaved'), `${name}: 受信箱に失敗を入れない`);
    const tr = await w.route('slack-test', 'A');
    assert.equal(tr.body.result, 'dest_unavailable'); assert.equal((await st(w)).on, true, `${name}: 試しの 1 通でも OFF にしない`);
    fixIt(w, orig);
    const r2 = await w.route('deliver', 'A');
    assert.equal(r2.body.sent, 1, `${name}: 直った後に届く`); assert.match(JSON.stringify(w.calls.fetch[0].body), /Kept while down/);
  }
});

test('r3-P3-3: 持ち主が自分で宛先を保存し直した時は OFF にし、受信箱には失敗でなく「見本を見て ON にし直す」の案内（英日）。それ以外の変化は失敗の知らせ', async () => {
  for (const lang of ['en', 'ja']) {
    const w = world();
    await w.turnOn('A', { kinds: ['approval'], lang });
    w.secretVals.sA = URL_A2; w.saved.A = destFingerprint(URL_A2); // 起動係の保存（同じ秘密の値を替え、覚えた指紋も替える）
    w.tick(1000); w.add('A', 'approval', 'a1', 'After resave');
    const r = await w.route('deliver', 'A');
    assert.equal(r.body.off, true); assert.equal(w.calls.fetch.length, 0, '新しい宛先へは見本の前に送らない');
    const s = await st(w); assert.equal(s.on, false); assert.equal(s.offReason, 'dest_changed');
    assert.ok(!w.notices.some(n => n.kind === 'slack_failed'), `${lang}: 失敗の知らせは入れない`);
    const g = w.notices.find(n => n.kind === 'slack_resaved');
    assert.ok(g, `${lang}: 案内が 1 件`); assert.equal(g.title, t(lang, 'slack_resaved_title'));
    assert.notEqual(t('en', 'slack_resaved_title'), t('ja', 'slack_resaved_title'));
  }
  // 起動係の覚えた物と違う変化（本体の口で秘密を替えた）は失敗の知らせのまま
  const w = world();
  await w.turnOn('A', { kinds: ['approval'] });
  w.secretVals.sA = URL_A2;
  await w.route('deliver', 'A');
  assert.ok(w.notices.some(n => n.kind === 'slack_failed')); assert.ok(!w.notices.some(n => n.kind === 'slack_resaved'));
  // 起動係に聞けない時も失敗の知らせのまま
  const w3 = world();
  await w3.turnOn('A', { kinds: ['approval'] });
  w3.secretVals.sA = URL_A2; w3.saved.A = destFingerprint(URL_A2); w3.deps.savedDest = async () => { throw new Error('launcher down'); };
  await w3.route('deliver', 'A');
  assert.ok(w3.notices.some(n => n.kind === 'slack_failed')); assert.ok(!w3.notices.some(n => n.kind === 'slack_resaved'));
  assert.equal(savedUrl({}), 'http://127.0.0.1:3100/setup/internal/slack-saved');
});
