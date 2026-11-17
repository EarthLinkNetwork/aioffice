// メールで届ける（知らせの plugin 側と、起動係と共有する形の確かめ）の試験。範囲: docs/review/2026-11-19-mail-notify-scope.md の M4・M5・M6・M10 と r3 の 1・2・4・13
// 本体・表は偽物。文を作る関数・待ちの積み方・結果の受け方・会社ごとの分け方・manifest を確かめる
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createHash } from 'node:crypto';
import { singleFlight, noticeKey } from '../plugins/notify/src/lib.mjs';
import { SLACK_CHOICES, CHOICE_KINDS, SLACK_DEFAULTS } from '../plugins/notify/src/slack.mjs';
import { mailMessage, mailPreviewMessages, testMail, admitMail, MAIL_LIMITS, htmlEscape } from '../plugins/notify/src/mail.mjs';
import { mailStore, mailPending, mailResult, mailPreview, mailStatus, mailRoute, MAIL } from '../plugins/notify/src/mail-worker.mjs';
import {
  MAIL_DICT, MAIL_CHOICES, MAIL_FORMS, MAIL_DEFAULTS, MAIL_CHOICE_KINDS, MAIL_FORMAT_VERSION, MAIL_BODY_LIMITS, subjectRegex, checkMailMessage, checkMailChoice,
  mailAddrOk, mailPassOk, normalizeMailPass, maskAddr, mailFingerprint, mailPreviewHash, officeUrlOk,
} from '../packages/aioffice/launcher/lib/mail-core.mjs';
import manifest from '../plugins/notify/src/manifest.mjs';

const { handleRoute } = await import('../plugins/notify/src/worker.mjs');
const OFFICE = 'http://localhost:3100/ACM/office';
const T0 = Date.parse('2026-11-19T09:00:00Z');
const iso = ms => new Date(ms).toISOString();

// ---- 文の形（M4・M5・M10・r3 の 1）----
const lineItems = (n, prefix = 'Item') => Array.from({ length: n }, (_, i) => ({ kind: 'approval', title: `${prefix} ${i + 1}` }));
const strip = html => html.replace(/<\/(?:li|p)>/g, '\n').replace(/<[^>]+>/g, '').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, '&');
const ALL = lang => [
  mailMessage({ type: 'digest', lang, form: 'titles', slot: 'am', items: [] }, OFFICE),
  mailMessage({ type: 'digest', lang, form: 'titles', slot: 'pm', items: lineItems(2) }, OFFICE),
  mailMessage({ type: 'digest', lang, form: 'titles', slot: 'am', items: lineItems(13) }, OFFICE),
  mailMessage({ type: 'digest', lang, form: 'counts', slot: 'pm', items: [...lineItems(2), { kind: 'decision', title: 'd' }, { kind: 'stuck', title: 's' }] }, OFFICE),
  ...['approval', 'decision', 'run_failing', 'stuck', 'stale_routine'].flatMap(kind => ['titles', 'counts'].map(form => mailMessage({ type: 'notice', lang, form, kind, items: [{ kind, title: `T ${kind}` }] }, OFFICE))),
  mailMessage({ type: 'overflow', lang, count: 7 }, OFFICE), testMail(lang, OFFICE),
];

test('件名は「[AI Office] 」＋辞書の見出し（と数字）だけ。英日の全部の形が起動係の検査を通る', () => {
  for (const lang of ['en', 'ja']) {
    for (const m of ALL(lang)) {
      assert.equal(checkMailMessage(m, { lang, officeUrl: OFFICE }), null, `${lang}: ${m.subject}`);
      assert.match(m.subject, /^\[AI Office\] /); assert.ok(!/[\r\n]/.test(m.subject));
    }
  }
  const d = MAIL_DICT;
  assert.equal(mailMessage({ type: 'digest', lang: 'ja', form: 'titles', slot: 'am', items: lineItems(2) }, OFFICE).subject, `[AI Office] ${d.ja.digest_am}: ${d.ja.waiting.replace('{n}', 2)}`);
  assert.equal(mailMessage({ type: 'notice', lang: 'ja', form: 'titles', kind: 'approval', items: [{ title: 'x' }] }, OFFICE).subject, '[AI Office] 承認待ち 1 件');
  assert.equal(mailMessage({ type: 'notice', lang: 'en', form: 'titles', kind: 'approval', items: [{ title: 'x' }] }, OFFICE).subject, '[AI Office] Approval waiting');
});

test('件名に知らせの題は入らない（題に何を入れても件名は辞書だけ）', () => {
  const evil = 'SECRET-TITLE\r\nBcc: attacker@example.com';
  for (const m of [mailMessage({ type: 'notice', lang: 'en', form: 'titles', kind: 'approval', items: [{ title: evil }] }, OFFICE), mailMessage({ type: 'digest', lang: 'en', form: 'titles', slot: 'am', items: [{ kind: 'approval', title: evil }] }, OFFICE)]) {
    assert.ok(!m.subject.includes('SECRET') && !/[\r\n]/.test(m.subject), m.subject);
    assert.equal(checkMailMessage(m, { lang: 'en', officeUrl: OFFICE }), null);
  }
});

test('本文: 見出し・1 件 1 行・80 字で詰める・まとめは 10 件と「ほか n 件」・text と HTML は同じ中身・リンクは 1 つ', () => {
  const m = mailMessage({ type: 'digest', lang: 'ja', form: 'titles', slot: 'am', items: [...lineItems(11), { kind: 'approval', title: 'あ'.repeat(200) }] }, OFFICE);
  const lines = m.text.split('\n');
  assert.equal(lines[0], `${MAIL_DICT.ja.digest_am}: ${MAIL_DICT.ja.waiting.replace('{n}', 12)}`);
  const bullets = lines.filter(l => l.startsWith('• '));
  assert.equal(bullets.length, 10, 'まとめは 10 件');
  assert.ok(lines.includes('ほか 2 件'), '「ほか n 件」');
  const long = mailMessage({ type: 'digest', lang: 'ja', form: 'titles', slot: 'am', items: [{ kind: 'approval', title: 'あ'.repeat(200) }] }, OFFICE).text.split('\n').find(l => l.startsWith('• '));
  assert.equal([...long.slice(2)].length, 80, '80 字で詰める'); assert.ok(long.endsWith('…'));
  assert.equal((m.text.match(/https?:\/\//g) || []).length, 1, 'text のリンクは 1 つ'); assert.ok(m.text.includes(`${MAIL_DICT.ja.open}: ${OFFICE}`));
  assert.equal((m.html.match(/href=/g) || []).length, 1, 'HTML のリンクは 1 つ'); assert.ok(m.html.includes(`<a href="${OFFICE}">${MAIL_DICT.ja.open}</a>`));
  // text と HTML の文は同じ（タグを外した HTML の行 = text の行・リンクの行を除く）
  const textLines = m.text.split('\n').filter(l => l && !l.startsWith(MAIL_DICT.ja.open)).map(l => l.replace(/^• /, ''));
  const htmlLines = strip(m.html).split('\n').filter(l => l && l !== MAIL_DICT.ja.open);
  assert.deepEqual(htmlLines, textLines);
});

test('題の中の HTML・URL・制御文字・秘密の形: HTML は escape・URL は壊す（hxxp）・改行は 1 行に・鍵の形は伏せる', () => {
  const titles = ['Pay <script>alert(1)</script> & "q" \'s\'', 'https://evil.example/a?b=1 http://x.test', 'www.evil.example ftp://f.example', 'Bcc\r\nBcc: a@b.test\u2028x', 'sk-ant-api03-abcdefghijklmnopqrstuvwxyz0123456789'];
  const m = mailMessage({ type: 'digest', lang: 'en', form: 'titles', slot: 'am', items: titles.map(title => ({ kind: 'approval', title })) }, OFFICE);
  assert.ok(!m.html.includes('<script>') && m.html.includes('&lt;script&gt;'), 'HTML は escape');
  assert.ok(m.html.includes('&amp;') && m.html.includes('&quot;q&quot;') && m.html.includes('&#39;s&#39;'));
  for (const s of [m.text, m.html]) {
    assert.ok(!/https?:\/\/evil|https?:\/\/x\.test|www\.evil|ftp:\/\//.test(s), `題の URL は自動でリンクにならない形: ${s.slice(0, 300)}`);
    assert.ok(s.includes('hxxps://evil.example') && s.includes('hxxp://x.test') && s.includes('www[.]evil.example') && s.includes('ftp[:]//f.example'));
    assert.ok(!s.includes('sk-ant-api03-abcdefghijklmnopqrstuvwxyz'), '鍵の形は伏せる');
  }
  const bulletLines = m.text.split('\n').filter(l => l.startsWith('• '));
  assert.equal(bulletLines.length, 5, '題の改行で行が増えない');
  assert.ok(bulletLines.some(l => l.includes('Bcc Bcc: a@b.test x')), '改行は空白 1 つになる');
  const bullet = bulletLines[0];
  assert.ok(!/[\r\u2028]/.test(bullet) && !m.text.includes('\nBcc:'), '1 件は 1 行（改行から別の行を作れない）');
  assert.equal(checkMailMessage(m, { lang: 'en', officeUrl: OFFICE }), null);
  assert.equal(htmlEscape('<a href="x">&\'</a>'), '&lt;a href=&quot;x&quot;&gt;&amp;&#39;&lt;/a&gt;');
});

test('リンクは officeUrlOk を通した物だけが入る・属性用に escape する', () => {
  const m = mailMessage({ type: 'overflow', lang: 'en', count: 3 }, 'http://localhost:3100/A"B/office');
  assert.ok(m.html.includes('href="http://localhost:3100/A&quot;B/office"'));
  assert.equal(checkMailMessage(m, { lang: 'en', officeUrl: 'http://localhost:3100/A"B/office' }), null, '属性の escape を戻して同じ URL');
  for (const bad of ['javascript:alert(1)', 'http://u:p@h/x', 'http://h/\n', `http://h/${'a'.repeat(300)}`, '', null]) assert.equal(officeUrlOk(bad), false, String(bad));
  assert.equal(officeUrlOk('https://example.test/x'), true);
});

test('英日の辞書は同じ key・空の文字が無い・既定は英語・選べる物は Slack と同じ', () => {
  assert.deepEqual(Object.keys(MAIL_DICT.en).sort(), Object.keys(MAIL_DICT.ja).sort());
  for (const l of ['en', 'ja']) for (const [k, v] of Object.entries(MAIL_DICT[l])) assert.ok(v.trim(), `${l}.${k}`);
  assert.ok(!/[぀-ヿ一-鿿]/.test(Object.values(MAIL_DICT.en).join('')), '英語の欄に日本語が無い');
  assert.equal(mailMessage({ type: 'test', lang: 'fr' }, OFFICE).subject, `[AI Office] ${MAIL_DICT.en.test_subject}`, '知らない言語は英語');
  assert.deepEqual([...MAIL_CHOICES], [...SLACK_CHOICES]); assert.deepEqual(MAIL_CHOICE_KINDS, CHOICE_KINDS);
  assert.deepEqual({ kinds: [...MAIL_DEFAULTS.kinds], form: MAIL_DEFAULTS.form }, { kinds: [...SLACK_DEFAULTS.kinds], form: SLACK_DEFAULTS.form });
  assert.deepEqual([...MAIL_FORMS], ['titles', 'counts']);
});

test('試しの 1 通は会社の題を入れない・見本と同じ関数で作る', () => {
  const notices = [{ kind: 'approval', title: 'COMPANY-SECRET-TITLE', createdAt: iso(T0) }];
  const pv = mailPreviewMessages({ kinds: ['approval', 'digest'], form: 'titles', lang: 'en', officeUrl: OFFICE, notices });
  assert.equal(pv.length, 2); assert.ok(pv[0].text.includes('COMPANY-SECRET-TITLE'), '見本は今の知らせから');
  const t = testMail('en', OFFICE);
  assert.ok(!JSON.stringify(t).includes('COMPANY'));
  assert.deepEqual(t, mailMessage({ type: 'test', lang: 'en' }, OFFICE));
  const ex = mailPreviewMessages({ kinds: ['decision'], form: 'titles', lang: 'ja', officeUrl: OFFICE, notices: [] });
  assert.match(ex[0].text, /例:/, '知らせが無い種類は決まった例の文');
});

// ---- 起動係の確かめ（r3 の 1・13: 偽の notify が悪い物を返す）----
test('起動係の確かめ: 悪い文の表（改行入りの件名・長すぎる本文・別の href・href 2 つ・タグ・NUL）', () => {
  const ok = mailMessage({ type: 'overflow', lang: 'en', count: 2 }, OFFICE);
  const c = over => checkMailMessage({ ...ok, ...over }, { lang: 'en', officeUrl: OFFICE });
  assert.equal(c({}), null);
  assert.equal(c({ subject: `${ok.subject}\r\nBcc: a@b.test` }), 'subject_ctl'); assert.equal(c({ subject: `${ok.subject}\n` }), 'subject_ctl'); assert.equal(c({ subject: `${ok.subject}\u0000` }), 'subject_ctl');
  assert.equal(c({ subject: 'No prefix' }), 'subject_form'); assert.equal(c({ subject: '[AI Office] Free money' }), 'subject_form'); assert.equal(c({ subject: `${ok.subject} extra` }), 'subject_form');
  assert.equal(c({ subject: `[AI Office] ${'a'.repeat(300)}` }), 'subject_long');
  assert.equal(c({ text: 'x'.repeat(MAIL_BODY_LIMITS.text + 1) }), 'text_long'); assert.equal(c({ html: `${ok.html}${'x'.repeat(MAIL_BODY_LIMITS.html)}` }), 'html_long');
  assert.equal(c({ text: 'a\u0000b' }), 'nul'); assert.equal(c({ html: `${ok.html}\u0000` }), 'nul');
  assert.equal(c({ html: ok.html.replace(OFFICE, 'http://evil.example/phish') }), 'href_other');
  assert.equal(c({ html: ok.html.replace('</body>', '<a href="http://evil.example/">x</a></body>') }), 'href_count');
  assert.equal(c({ html: ok.html.replace('<a href=', '<a  class="x" href=') }), 'href_form');
  assert.equal(c({ html: ok.html.replace('</body>', '<img src="http://evil.example/p.gif"></body>') }), 'html_tag');
  assert.equal(c({ html: ok.html.replace('</body>', '<script>1</script></body>') }), 'html_tag');
  assert.equal(c({ html: ok.html.replace('<p>', '<p onclick="x()">') }), 'html_tag');
  assert.equal(c({ html: ok.html.replace('</body>', '<iframe src=x></iframe></body>') }), 'html_tag');
  for (const bad of [null, 'x', 5, [], {}, { subject: 1, text: '', html: '' }, { subject: '', text: '', html: 1 }]) assert.equal(checkMailMessage(bad, { lang: 'en', officeUrl: OFFICE }), 'shape', JSON.stringify(bad));
  assert.equal(checkMailMessage(ok, { lang: 'en', officeUrl: 'javascript:1' }), 'office_url');
  // 件名は辞書から作った形: 英語の文は日本語の言語では通らない
  assert.equal(checkMailMessage(ok, { lang: 'ja', officeUrl: OFFICE }), 'subject_form');
  assert.ok(subjectRegex('en').test('[AI Office] Morning summary: 12 waiting') && !subjectRegex('en').test('[AI Office] Morning summary: x waiting') && !subjectRegex('en').test('[AI Office] Morning summary: 1234567 waiting'));
});

test('アドレス・アプリ パスワードの形・伏せた形・指紋・見本の hash', () => {
  for (const a of ['owner@gmail.com', 'a.b+c@example.co.jp', 'x_y%z@sub.example.org']) assert.equal(mailAddrOk(a), true, a);
  for (const a of ['a@b', 'a@gmail.com\n', 'a@gmail.com,b@gmail.com', 'a@gmail.com;b@gmail.com', 'a@gmail.com b@gmail.com', ' a@gmail.com', '"x" <a@gmail.com>', '<a@gmail.com>', 'a@gmail.com\u0000', 'a@@gmail.com', '@gmail.com', `${'a'.repeat(65)}@gmail.com`, `a@${'b'.repeat(250)}.com`, '', null, 5, 'a b@gmail.com', 'a@gmail.com\r\nBcc: x@y.test'])
    assert.equal(mailAddrOk(a), false, JSON.stringify(a));
  assert.equal(normalizeMailPass('abcd efgh\tijkl mnop\n'), 'abcdefghijklmnop');
  assert.equal(mailPassOk('abcd efgh ijkl mnop'), true);
  for (const p of ['abcdefghijklmno', 'abcdefghijklmnopq', 'ABCDEFGHIJKLMNOP', 'abcdefghijklmn1p', 'abcdefghijklmnó', '', null, 'abcd efgh ijkl mn\u0000p']) assert.equal(mailPassOk(p), false, JSON.stringify(p));
  assert.equal(maskAddr('masa@gmail.com'), 'm***@gmail.com'); assert.equal(maskAddr('bad'), null);
  assert.ok(!maskAddr('owner.test@gmail.com').includes('wner'), '元の文字を 1 字目より多く残さない');
  // 指紋: どちらかが替わると替わる・境目があいまいにならない
  const fp = mailFingerprint({ addr: 'a@x.com', pw: 'abcdefghijklmnop' });
  assert.match(fp, /^[0-9a-f]{16}$/);
  assert.equal(fp, createHash('sha256').update(JSON.stringify({ addr: 'a@x.com', pw: 'abcdefghijklmnop' })).digest('hex').slice(0, 16));
  assert.notEqual(fp, mailFingerprint({ addr: 'a@x.com', pw: 'abcdefghijklmnoq' })); assert.notEqual(fp, mailFingerprint({ addr: 'b@x.com', pw: 'abcdefghijklmnop' }));
  assert.notEqual(mailFingerprint({ addr: 'a@x.compw', pw: 'abcdefghijklmnop' }), mailFingerprint({ addr: 'a@x.com', pw: 'pwabcdefghijklmnop' }));
  const h = mailPreviewHash({ fp, kinds: ['approval', 'digest'], form: 'titles', lang: 'en', officeUrl: OFFICE });
  assert.match(h, /^[0-9a-f]{32}$/);
  assert.equal(h, mailPreviewHash({ fp, kinds: ['digest', 'approval'], form: 'titles', lang: 'en', officeUrl: OFFICE }), '種類の順は関係ない');
  for (const o of [{ fp: 'f'.repeat(16) }, { kinds: ['digest'] }, { form: 'counts' }, { lang: 'ja' }, { officeUrl: `${OFFICE}x` }]) assert.notEqual(h, mailPreviewHash({ fp, kinds: ['approval', 'digest'], form: 'titles', lang: 'en', officeUrl: OFFICE, ...o }));
  assert.equal(MAIL_FORMAT_VERSION, 1);
  assert.deepEqual(checkMailChoice({ kinds: 'digest,nope', form: 'titles' }), { kinds: ['digest'], form: 'titles' }); assert.equal(checkMailChoice({ kinds: 'nope', form: 'titles' }), null); assert.equal(checkMailChoice({ kinds: 'digest', form: 'x' }), null);
});

// ---- 待ちの積み方・結果の受け方（r3 の 2・4）----
function world() {
  let clock = T0;
  const notices = [], sends = new Map(), state = new Map(), ops = [];
  const sk = (c, k) => `${c}|${k}`;
  const nAt = (c, key) => notices.find(n => n.c === c && n.key === key);
  const store = {
    enqueue: async (c, kinds, since) => { ops.push('enqueue'); for (const n of notices) if (n.c === c && kinds.includes(n.kind) && Date.parse(n.createdAt) >= Date.parse(since) && !sends.has(sk(c, n.key))) sends.set(sk(c, n.key), { c, key: n.key, status: 'pending', attempts: 0, nextAt: Date.parse(n.createdAt), code: null }); },
    dropOrphans: async c => { ops.push('orphans'); for (const [k, s] of sends) if (s.c === c && s.status === 'pending' && !nAt(c, s.key)) sends.delete(k); },
    skipBefore: async (c, since) => { ops.push('skipBefore'); for (const s of sends.values()) { const n = nAt(c, s.key); if (s.c === c && s.status === 'pending' && n && Date.parse(n.createdAt) < Date.parse(since)) { s.status = 'skipped'; s.code = 'before_on'; } } },
    due: async (c, nowIso, limit) => [...sends.values()].filter(s => s.c === c && s.status === 'pending' && s.nextAt <= Date.parse(nowIso)).map(s => { const n = nAt(c, s.key); return { key: s.key, attempts: s.attempts, kind: n.kind, title: n.title, originId: n.originId, createdAt: new Date(n.createdAt) }; }).sort((a, b) => a.createdAt - b.createdAt || a.key.localeCompare(b.key)).slice(0, limit),
    pendingCount: async c => [...sends.values()].filter(s => s.c === c && s.status === 'pending').length,
    one: async (c, key) => { const s = sends.get(sk(c, key)); const n = s && nAt(c, key); return s ? { attempts: s.attempts, status: s.status, createdAt: n ? new Date(n.createdAt) : null } : null; },
    markSent: async (c, key) => { const s = sends.get(sk(c, key)); if (s) { s.status = 'sent'; s.code = 'ok'; } },
    markRetry: async (c, key, attempts, nextIso, code) => { const s = sends.get(sk(c, key)); if (s) Object.assign(s, { attempts, nextAt: Date.parse(nextIso), code }); },
    markDone: async (c, key, status, code) => { const s = sends.get(sk(c, key)); if (s) Object.assign(s, { status, code }); },
    giveUp: async (c, cutoff) => { let n = 0; for (const s of sends.values()) { const no = nAt(c, s.key); if (s.c === c && s.status === 'pending' && no && Date.parse(no.createdAt) < Date.parse(cutoff)) { s.status = 'gave_up'; n++; } } return n; },
  };
  const deps = {
    now: () => clock, mailFlight: singleFlight(), mail: store,
    state: { get: async k => { const v = state.get(JSON.stringify(k)); return v == null ? null : JSON.parse(JSON.stringify(v)); }, set: async (k, v) => { state.set(JSON.stringify(k), JSON.parse(JSON.stringify(v))); } },
    notices: { listNotices: async c => notices.filter(n => n.c === c).map(n => ({ ...n })) },
  };
  const add = (c, kind, title, at = clock, extra = {}) => { const n = { c, key: noticeKey(kind, `${title}${at}`), kind, title, originId: title, createdAt: iso(at), readAt: null, ...extra }; notices.push(n); return n; };
  return { deps, notices, sends, state, ops, add, tick: ms => { clock += ms; }, get clock() { return clock; }, set clock(v) { clock = v; } };
}
const Q = (over = {}) => ({ onAt: iso(T0), kinds: 'digest,approval,decision', form: 'titles', lang: 'en', officeUrl: OFFICE, limit: '3', ...over });

test('pending: onAt を渡さない回は空を返し、待ちを作らない（OFF の間に溜めない）', async () => {
  const w = world(); w.add('A', 'approval', 'x', T0 + 1000);
  const r = await mailPending(w.deps, 'A', { ...Q(), onAt: undefined });
  assert.equal(r.status, 200); assert.deepEqual(r.body.rows, []); assert.equal(r.body.off, true);
  assert.deepEqual(w.ops, [], '表に何も触らない'); assert.equal(w.sends.size, 0);
  assert.equal((await mailPending(w.deps, 'A', { ...Q(), onAt: '' })).body.rows.length, 0);
});

test('pending: 形の合わない選び・未来の onAt・知らない言語・悪い office の URL は 400', async () => {
  const w = world();
  for (const q of [Q({ kinds: 'nope' }), Q({ form: 'x' }), Q({ lang: 'fr' }), Q({ officeUrl: 'javascript:1' }), Q({ onAt: 'garbage' }), Q({ onAt: iso(T0 + 3600_000) })]) assert.equal((await mailPending(w.deps, 'A', q)).status, 400, JSON.stringify(q));
  assert.equal((await mailPreview(w.deps, 'A', { kinds: 'nope', form: 'titles', lang: 'en', officeUrl: OFFICE })).status, 400);
});

test('pending: ON の時刻より前の知らせは送らない・選んでいない種類は出ない・同じ知らせは 1 回（sent の後は出ない）', async () => {
  const w = world();
  const old = w.add('A', 'approval', 'before on', T0 - 5000), dec = w.add('A', 'decision', 'not selected', T0 + 1000), ap = w.add('A', 'approval', 'after on', T0 + 2000);
  w.clock = T0 + 10_000;
  const r = await mailPending(w.deps, 'A', Q({ kinds: 'approval' }));
  assert.equal(r.status, 200); assert.equal(r.body.formatVersion, MAIL_FORMAT_VERSION);
  assert.deepEqual(r.body.rows.map(x => x.id), [ap.key]); assert.equal(w.sends.has(`A|${old.key}`), false, 'ON の前の知らせは待ちに積まない'); assert.equal(w.sends.has(`A|${dec.key}`), false);
  const row = r.body.rows[0];
  assert.deepEqual(Object.keys(row).sort(), ['attempts', 'createdAt', 'html', 'id', 'kind', 'subject', 'text']);
  assert.ok(!('to' in row) && !('addr' in row) && !('from' in row), '答えに宛先の欄が無い');
  assert.equal(row.createdAt, iso(T0 + 2000)); assert.equal(checkMailMessage(row, { lang: 'en', officeUrl: OFFICE }), null);
  // もう一度取っても同じ 1 通・sent の後は出ない
  assert.deepEqual((await mailPending(w.deps, 'A', Q({ kinds: 'approval' }))).body.rows.map(x => x.id), [ap.key]);
  assert.equal((await mailResult(w.deps, 'A', { id: ap.key, result: 'sent', code: 'ok' })).status, 200);
  assert.deepEqual((await mailPending(w.deps, 'A', Q({ kinds: 'approval' }))).body.rows, []);
  // OFF → 新しい ON（onAt が後）: 前の ON の待ちは出ない
  const later = w.add('A', 'approval', 'later', T0 + 20_000); w.clock = T0 + 30_000;
  await mailPending(w.deps, 'A', Q({ kinds: 'approval', limit: '1' })); // 前の ON の間に待ちに積まれる
  assert.equal(w.sends.get(`A|${later.key}`).status, 'pending');
  const w2 = await mailPending(w.deps, 'A', Q({ kinds: 'approval', onAt: iso(T0 + 25_000) }));
  assert.deepEqual(w2.body.rows, [], '新しい onAt より前の知らせ（later）は出ない'); assert.equal(w.sends.get(`A|${later.key}`).status, 'skipped');
});

test('pending: 1 回に返す数は limit（既定 3・上限 5）・消えた知らせの待ちは送らない', async () => {
  const w = world(); for (let i = 0; i < 8; i++) w.add('A', 'approval', `n${i}`, T0 + 1000 + i); w.clock = T0 + 9000;
  assert.equal((await mailPending(w.deps, 'A', Q({ kinds: 'approval' }))).body.rows.length, 3);
  assert.equal((await mailPending(w.deps, 'A', Q({ kinds: 'approval', limit: '99' }))).body.rows.length, MAIL_LIMITS.perCallMax);
  assert.equal((await mailPending(w.deps, 'A', Q({ kinds: 'approval', limit: '1' }))).body.rows.length, 1);
  const gone = w.notices.pop(); w.notices.splice(w.notices.indexOf(gone), 1);
  w.notices.length = 0; // 全部消えた（承認が決まった等）
  assert.deepEqual((await mailPending(w.deps, 'A', Q({ kinds: 'approval' }))).body.rows, []);
});

test('pending: まとめの 1 通は回の時刻で判定し、まとめより前にできた未読だけを一覧にする', async () => {
  const w = world();
  w.add('A', 'approval', 'listed', T0 + 500); w.add('A', 'approval', 'read', T0 + 600, { readAt: 'x' });
  const dg = w.add('A', 'digest', 'D', T0 + 1000, { originId: '2026-11-19:pm' }); w.add('A', 'approval', 'after digest', T0 + 2000);
  w.clock = T0 + 5000;
  const r = await mailPending(w.deps, 'A', Q({ kinds: 'digest' }));
  assert.equal(r.body.rows.length, 1); assert.equal(r.body.rows[0].id, dg.key);
  assert.ok(r.body.rows[0].subject.includes('Evening summary: 1 waiting'), r.body.rows[0].subject); assert.ok(r.body.rows[0].text.includes('listed') && !r.body.rows[0].text.includes('after digest') && !r.body.rows[0].text.includes('• read'));
  const old = await mailPending(w.deps, 'A', Q({ kinds: 'digest', onAt: iso(T0 + 1500) }));
  assert.deepEqual(old.body.rows, [], 'ON の時刻より前にできたまとめは送らない');
});

test('見本と送る文は同じ（同じ入力から同じ件名・text・HTML）', async () => {
  const w = world(); const n = w.add('A', 'approval', 'Publish the price list', T0 + 1000); w.clock = T0 + 5000;
  const pv = (await mailPreview(w.deps, 'A', { kinds: 'approval', form: 'titles', lang: 'ja', officeUrl: OFFICE })).body;
  const pend = (await mailPending(w.deps, 'A', Q({ kinds: 'approval', lang: 'ja' }))).body.rows[0];
  const sample = pv.messages.find(m => m.kind === 'approval');
  assert.deepEqual({ subject: pend.subject, text: pend.text, html: pend.html }, { subject: sample.subject, text: sample.text, html: sample.html });
  assert.equal(pv.formatVersion, MAIL_FORMAT_VERSION); assert.equal(checkMailMessage(pv.test, { lang: 'ja', officeUrl: OFFICE }), null); assert.ok(n);
});

test('結果: sent・retry（1・5・15・60 分）・24 時間で捨てる・hold・dead・drop・bad・二重の sent', async () => {
  const w = world(); const n = w.add('A', 'approval', 'a', T0 + 1000); w.clock = T0 + 2000;
  const P = async () => (await mailPending(w.deps, 'A', Q({ kinds: 'approval' }))).body.rows;
  const R = (body, c = 'A') => mailResult(w.deps, c, body);
  assert.equal((await P()).length, 1);
  // retry: 1 分後・5 分後・15 分後・60 分後
  for (const [i, min] of [1, 5, 15, 60, 60].entries()) {
    assert.equal((await R({ id: n.key, result: 'retry', code: 'timeout' })).status, 200);
    assert.equal(w.sends.get(`A|${n.key}`).attempts, i + 1); assert.equal(w.sends.get(`A|${n.key}`).nextAt, w.clock + min * 60_000, `${i + 1} 回目は ${min} 分後`);
    assert.deepEqual(await P(), [], '待ちの間は出ない'); w.tick(min * 60_000);
    assert.equal((await P()).length, 1, '時刻が来ると出る');
  }
  let st = await mailStatus(w.deps, 'A'); assert.deepEqual({ code: st.lastFail.code, ext: st.lastFail.ext }, { code: 'timeout', ext: null }); assert.equal(st.dropped, 0);
  // hold・dead は待ちをそのまま残し、失敗の印だけ残す
  await R({ id: n.key, result: 'hold', code: 'day_limit', ext: '5.4.5' }); assert.equal(w.sends.get(`A|${n.key}`).status, 'pending'); assert.equal((await mailStatus(w.deps, 'A')).lastFail.ext, '5.4.5');
  await R({ id: n.key, result: 'dead', code: 'auth_failed', ext: '5.7.8' }); assert.equal(w.sends.get(`A|${n.key}`).status, 'pending'); assert.equal((await mailStatus(w.deps, 'A')).lastFail.code, 'auth_failed');
  // 24 時間たった物は retry で捨てて数える
  w.clock = T0 + 1000 + 24 * 3600_000 + 1;
  await R({ id: n.key, result: 'retry', code: 'network' }); assert.equal(w.sends.get(`A|${n.key}`).status, 'gave_up'); st = await mailStatus(w.deps, 'A'); assert.equal(st.dropped, 1);
  // drop: その 1 通だけ捨てて ON のまま・bad: 送らずに数える・sent
  const d = w.add('A', 'approval', 'd', w.clock), b = w.add('A', 'approval', 'b', w.clock), s = w.add('A', 'approval', 's', w.clock);
  await mailPending(w.deps, 'A', Q({ kinds: 'approval', onAt: iso(w.clock - 1000) }));
  await R({ id: d.key, result: 'drop', code: 'content', ext: '5.6.1' }); assert.equal(w.sends.get(`A|${d.key}`).status, 'dropped');
  await R({ id: b.key, result: 'bad', code: 'bad_mail' }); assert.equal(w.sends.get(`A|${b.key}`).status, 'skipped'); assert.equal(w.sends.get(`A|${b.key}`).code, 'bad');
  await R({ id: s.key, result: 'sent', code: 'ok' }); assert.equal(w.sends.get(`A|${s.key}`).status, 'sent'); await R({ id: s.key, result: 'sent', code: 'ok' }); assert.equal(w.sends.get(`A|${s.key}`).status, 'sent', '2 回呼んでも同じ');
  assert.equal((await mailStatus(w.deps, 'A')).lastOkAt, iso(w.clock));
  assert.equal((await mailStatus(w.deps, 'A')).waiting, 0);
});

test('結果: 口の入力の確かめ（id・result・code・ext の形・知らない行は何も変えない）', async () => {
  const w = world(); const n = w.add('A', 'approval', 'a', T0 + 1000); w.clock = T0 + 2000; await mailPending(w.deps, 'A', Q({ kinds: 'approval' }));
  for (const b of [null, {}, { id: n.key }, { id: n.key, result: 'bogus' }, { id: 'x', result: 'sent' }, { id: `${n.key}\n`, result: 'sent' }, { id: 5, result: 'sent' }, { id: 'overflow:x', result: 'sent' }, { id: n.key, result: 'sent', extra: 1, code: 5 }].slice(0, 8)) assert.equal((await mailResult(w.deps, 'A', b)).status, 400, JSON.stringify(b));
  await mailResult(w.deps, 'A', { id: n.key, result: 'dead', code: 'Bad Code!\n<x>', ext: '5.7.x\n' });
  const f = (await mailStatus(w.deps, 'A')).lastFail; assert.deepEqual({ code: f.code, ext: f.ext }, { code: 'unknown', ext: null }, '形の合わない印は unknown・ext なし');
  assert.equal((await mailResult(w.deps, 'A', { id: 'f'.repeat(32), result: 'sent', code: 'ok' })).status, 200, '知らない行の sent は表を変えない');
  assert.equal(w.sends.get(`A|${n.key}`).status, 'pending');
});

test('1 時間の上限を超えた分は notify が「ほか n 件」の 1 通にまとめる（overflow の結果 → 次の回に 1 通）', async () => {
  const w = world(); const a = w.add('A', 'approval', 'a1', T0 + 1000), b = w.add('A', 'approval', 'b1', T0 + 1001), c = w.add('A', 'approval', 'c1', T0 + 1002); w.clock = T0 + 5000;
  await mailPending(w.deps, 'A', Q({ kinds: 'approval' }));
  for (const n of [a, b]) await mailResult(w.deps, 'A', { id: n.key, result: 'overflow', code: 'hour_limit' });
  assert.equal(w.sends.get(`A|${a.key}`).status, 'overflow'); assert.equal((await mailStatus(w.deps, 'A')).overflow, 2);
  const r = (await mailPending(w.deps, 'A', Q({ kinds: 'approval' }))).body.rows;
  assert.equal(r[0].id, 'overflow:0'); assert.equal(r[0].kind, 'overflow'); assert.ok(r[0].text.includes('2 more notices'), r[0].text);
  assert.equal(checkMailMessage(r[0], { lang: 'en', officeUrl: OFFICE }), null);
  assert.deepEqual(r.map(x => x.id), ['overflow:0', c.key]);
  await mailResult(w.deps, 'A', { id: 'overflow:0', result: 'sent', code: 'ok' });
  assert.equal((await mailStatus(w.deps, 'A')).overflow, 0);
  assert.deepEqual((await mailPending(w.deps, 'A', Q({ kinds: 'approval' }))).body.rows.map(x => x.id), [c.key], 'まとめた後は出ない');
  await mailResult(w.deps, 'A', { id: c.key, result: 'overflow' }); assert.equal((await mailPending(w.deps, 'A', Q({ kinds: 'approval' }))).body.rows[0].id, 'overflow:1', '次のまとめは別の id（Message-ID が重ならない）');
});

test('会社ごと: A の待ち・結果・状態が B に混ざらず、B の結果で A の行は変わらない', async () => {
  const w = world(); const a = w.add('A', 'approval', 'A-only', T0 + 1000), b = w.add('B', 'approval', 'B-only', T0 + 1000); w.clock = T0 + 5000;
  const ra = (await mailPending(w.deps, 'A', Q({ kinds: 'approval' }))).body.rows, rb = (await mailPending(w.deps, 'B', Q({ kinds: 'approval' }))).body.rows;
  assert.deepEqual(ra.map(x => x.id), [a.key]); assert.deepEqual(rb.map(x => x.id), [b.key]);
  assert.ok(ra[0].text.includes('A-only') && !ra[0].text.includes('B-only') && rb[0].text.includes('B-only') && !rb[0].text.includes('A-only'));
  await mailResult(w.deps, 'B', { id: a.key, result: 'sent', code: 'ok' }); // B が A の行を sent にしようとする
  assert.equal(w.sends.get(`A|${a.key}`).status, 'pending', 'A の行は変わらない');
  await mailResult(w.deps, 'B', { id: b.key, result: 'dead', code: 'auth_failed' });
  assert.equal((await mailStatus(w.deps, 'A')).lastFail, null); assert.equal((await mailStatus(w.deps, 'B')).lastFail.code, 'auth_failed');
  assert.notDeepEqual(MAIL('A'), MAIL('B'));
});

test('状態の口: 宛先・アプリ パスワード・文は返さない', async () => {
  const w = world(); w.add('A', 'approval', 'TITLE-LEAK', T0 + 1000); w.clock = T0 + 2000; await mailPending(w.deps, 'A', Q({ kinds: 'approval' }));
  const s = JSON.stringify(await mailStatus(w.deps, 'A'));
  assert.deepEqual(Object.keys(JSON.parse(s)).sort(), ['dropped', 'formatVersion', 'lastFail', 'lastOkAt', 'overflow', 'v', 'waiting']);
  assert.ok(!s.includes('TITLE-LEAK') && !/addr|pw|pass|@/.test(s));
});

test('口の振り分け: mail の口だけ受け・error の文は外へ出さず、知らない口は null', async () => {
  const w = world();
  assert.equal(await mailRoute(w.deps, { routeKey: 'tick', companyId: 'A' }), null);
  const boom = { ...w.deps, mail: { ...w.deps.mail, pendingCount: async () => { throw new Error('SECRET-DB-DETAIL postgres://x'); } } };
  const r = await mailRoute(boom, { routeKey: 'mail', companyId: 'A' });
  assert.equal(r.status, 502); assert.deepEqual(r.body, { error: 'notify_failed' });
  const via = await handleRoute({ ...w.deps }, { routeKey: 'mail-pending', companyId: 'A', query: Q({ onAt: undefined }) });
  assert.equal(via.status, 200); assert.deepEqual(via.body.rows, []);
  assert.equal((await handleRoute(w.deps, { routeKey: 'mail-result', companyId: 'A', body: { id: 'zz', result: 'sent' } })).status, 400);
});

test('lint: 待ちの表の SQL は全部、会社で絞る・SELECT に更新の語が無い', async () => {
  const calls = [];
  const db = { namespace: 'ns', execute: async sql => { calls.push(sql); return { rowCount: 0 }; }, query: async sql => { calls.push(sql); return []; } };
  const s = mailStore(db);
  await Promise.all([s.enqueue('A', ['digest'], iso(T0)), s.dropOrphans('A'), s.skipBefore('A', iso(T0)), s.due('A', iso(T0), 3), s.one('A', 'k'), s.pendingCount('A'), s.markSent('A', 'k', iso(T0)), s.markRetry('A', 'k', 1, iso(T0), 'c'), s.markDone('A', 'k', 'dropped', 'c'), s.giveUp('A', iso(T0))]);
  assert.equal(calls.length, 10);
  for (const q of calls) { assert.match(q, /company_id = \$1/, q); assert.match(q, /ns\.mail_sends/, q); }
  for (const q of calls.filter(x => /^SELECT/.test(x))) assert.ok(!/\b(insert|update|delete)\b/i.test(q), q);
});

test('manifest 0.4.0: 口は board・会社は query・capability と設定の欄は増えない・migration 006 の hash が lock と同じ', () => {
  assert.equal(manifest.version, '0.4.0');
  assert.equal(JSON.parse(fs.readFileSync(new URL('../plugins/notify/package.json', import.meta.url), 'utf8')).version, '0.4.0');
  for (const [k, method, p] of [['mail', 'GET', '/mail'], ['mail-preview', 'GET', '/mail/preview'], ['mail-pending', 'GET', '/mail/pending'], ['mail-result', 'POST', '/mail/result']]) {
    const r = manifest.apiRoutes.find(x => x.routeKey === k); assert.ok(r, k); assert.equal(r.method, method); assert.equal(r.path, p); assert.equal(r.auth, 'board'); assert.deepEqual(r.companyResolution, { from: 'query', key: 'companyId' });
  }
  assert.ok(!manifest.apiRoutes.some(r => /mail/.test(r.routeKey) && /confirm|on$|save|addr|password/.test(r.routeKey)), 'メールを ON にする口・宛先を受ける口が plugin に無い');
  assert.deepEqual(Object.keys(manifest.instanceConfigSchema.properties).sort(), ['slack', 'stuckIdleMin'], '設定の欄は増えない（アドレスは起動係の state にだけ置く）');
  assert.ok(!manifest.capabilities.some(c => /mail|smtp/i.test(c)));
  const lock = JSON.parse(fs.readFileSync(new URL('../plugins/notify/migrations.lock.json', import.meta.url), 'utf8'));
  const sql = fs.readFileSync(new URL('../plugins/notify/migrations/006_mail.sql', import.meta.url), 'utf8');
  assert.equal(lock['006_mail.sql'], createHash('sha256').update(sql).digest('hex'));
  assert.match(sql, /PRIMARY KEY \(company_id, notice_key\)/); assert.match(sql, /plugin_notify_4b4010a560\.mail_sends/);
  assert.equal(manifest.database.migrationsDir, 'migrations');
});

test('admitMail: ON の時刻より前・選んでいない種類は文を作らない', () => {
  const c = { kinds: ['approval'], form: 'titles', lang: 'en', officeUrl: OFFICE, onAt: T0 };
  assert.equal(admitMail(c, { key: 'k', kind: 'approval', title: 't', createdAt: new Date(T0 - 1) }).skip, 'before_on');
  assert.equal(admitMail(c, { key: 'k', kind: 'decision', title: 't', createdAt: new Date(T0 + 1) }).skip, 'kind_off');
  assert.ok(admitMail(c, { key: 'k', kind: 'approval', title: 't', createdAt: new Date(T0 + 1) }).msg.subject);
  assert.ok(admitMail(c, { overflow: 3 }).msg.subject.includes('More notices'));
});

test('起動係が text から作り直す HTML は、notify が作る HTML と全部の形で同じ（P2-2）', async () => {
  const { htmlFromText, checkMailMessageStrict } = await import('../packages/aioffice/launcher/lib/mail-core.mjs');
  for (const lang of ['en', 'ja']) for (const m of ALL(lang)) {
    assert.equal(htmlFromText(m.text, { lang, officeUrl: OFFICE }), m.html, m.subject);
    assert.equal(checkMailMessageStrict(m, { lang, officeUrl: OFFICE }), null);
  }
  const m = mailMessage({ type: 'overflow', lang: 'en', count: 2 }, OFFICE);
  for (const evil of ['<table background="https://e.example/x.gif"></table>', '<div style="background:url(https://e.example/x)"></div>', '<video poster="https://e.example/x"></video>', '<meta http-equiv="refresh" content="0;url=https://e.example/">'])
    assert.equal(checkMailMessageStrict({ ...m, html: m.html.replace('<p>', evil + '<p>') }, { lang: 'en', officeUrl: OFFICE }), 'html_form', evil);
  assert.equal(htmlFromText('no tail', { lang: 'en', officeUrl: OFFICE }), null); assert.equal(htmlFromText(m.text.replace('\n\n', '\n'), { lang: 'en', officeUrl: OFFICE }), null);
});

test('題に href・src=・onboarding=・<script> を含む知らせは Strict の確かめを通る（P3-a）', async () => {
  const { checkMailMessageStrict } = await import('../packages/aioffice/launcher/lib/mail-core.mjs');
  const m = mailMessage({ type: 'notice', lang: 'en', form: 'titles', kind: 'approval', items: [{ kind: 'approval', title: 'Fix href src=x onboarding=1 <script>alert(1)</script> style=a' }] }, OFFICE);
  assert.equal(checkMailMessageStrict(m, { lang: 'en', officeUrl: OFFICE }), null);
  assert.equal(checkMailMessageStrict({ ...m, html: m.html.replace('<p>', '<p onclick="x()">') }, { lang: 'en', officeUrl: OFFICE }), 'html_form', '作り直しと違えば断る');
});

test('OFF → ON し直し（onAt が替わる）で、前の ON の間の「ほか n 件」は持ち越さない（overflow）', async () => {
  const w = world(); const a = w.add('A', 'approval', 'o1', T0 + 1000); w.clock = T0 + 5000;
  await mailPending(w.deps, 'A', Q({ kinds: 'approval' }));
  await mailResult(w.deps, 'A', { id: a.key, result: 'overflow', code: 'hour_limit' });
  assert.equal((await mailStatus(w.deps, 'A')).overflow, 1);
  assert.equal((await mailPending(w.deps, 'A', Q({ kinds: 'approval' }))).body.rows[0].id, 'overflow:0', '同じ ON の間は出る');
  w.clock = T0 + 20_000; const c = w.add('A', 'approval', 'o2', T0 + 21_000); w.clock = T0 + 30_000;
  const r = await mailPending(w.deps, 'A', Q({ kinds: 'approval', onAt: iso(T0 + 20_500) })); // 新しい ON
  assert.deepEqual(r.body.rows.map(x => x.id), [c.key], '前の ON のまとめは届かない'); assert.equal((await mailStatus(w.deps, 'A')).overflow, 0);
});
