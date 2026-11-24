// メールで届ける形の、起動係と知らせの plugin が同じ物を使う部分（範囲 docs/review/2026-11-19-mail-notify-scope.md の M1〜M10 と r2・r3）。
// 知らせの plugin は build の時にこの file を取り込む（slack-url.mjs と同じ形・Dockerfile の plugins の段で写す）。
// ここに網の口は無い。形の確かめ・指紋・伏せた表示・件名の辞書・文の検査だけ
import { createHash } from 'node:crypto';

export const MAIL_PREFIX = '[AI Office] ';
// 文の形の版（previewHash に入る。文の形を変えたら上げる。ON の人も見本を見直すまで送らない）
export const MAIL_FORMAT_VERSION = 1;

// 選べる物（Slack と同じ並び・MAIL_CHOICES は notify の SLACK_CHOICES と同じ。試験で一致を確かめる）
export const MAIL_CHOICES = Object.freeze(['digest', 'approval', 'decision', 'run_failing', 'stuck']);
export const MAIL_FORMS = Object.freeze(['titles', 'counts']);
// 選びごとの知らせの種類（notify の CHOICE_KINDS と同じ。起動係は届いた行の種類がこの中かを照らす）
export const MAIL_CHOICE_KINDS = Object.freeze({ digest: ['digest'], approval: ['approval'], decision: ['decision'], run_failing: ['run_failing'], stuck: ['stuck', 'stale_routine'] });
export const mailKindsOf = choices => choices.flatMap(c => MAIL_CHOICE_KINDS[c] || []);
export const MAIL_DEFAULTS = Object.freeze({ kinds: Object.freeze(['digest']), form: 'titles' });
export const MAIL_LANGS = Object.freeze(['en', 'ja']);

// 文字は英日の辞書から（M10）。件名の検査の正規表現もこの辞書から作る（r3 の 1）。{n} は件数
export const MAIL_DICT = Object.freeze({
  en: Object.freeze({
    digest_am: 'Morning summary', digest_pm: 'Evening summary', waiting: '{n} waiting', none: 'nothing is waiting', more: 'and {n} more',
    head_approval: 'Approval waiting', head_decision: 'Decision waiting', head_run_failing: 'Runs keep failing', head_stuck: 'Stuck task', head_stale_routine: 'Old scheduled run',
    overflow_head: 'More notices', overflow: 'There are {n} more notices (see them in the office)',
    test_subject: 'Test message', test_body: 'This is a test message from AI Office.', open: 'Open AI Office',
    relay_subject: 'Waiting for you', relay_head: 'Something came to you in AI Office: {title}',
  }),
  ja: Object.freeze({
    digest_am: '朝のまとめ', digest_pm: '夕方のまとめ', waiting: '待っている物 {n} 件', none: '待っている物はありません', more: 'ほか {n} 件',
    head_approval: '承認待ち 1 件', head_decision: '判断待ち 1 件', head_run_failing: '失敗が続いています', head_stuck: '止まった課題', head_stale_routine: '古い定時の回',
    overflow_head: 'ほかの知らせ', overflow: 'ほか {n} 件の知らせがあります（オフィスで見てください）',
    test_subject: '試しのメール', test_body: 'AI オフィスからの試しのメールです。', open: 'AI オフィスで開く',
    relay_subject: 'あなた宛ての件', relay_head: 'AI オフィスであなたに回ってきました: {title}',
  }),
});
export const mailT = (lang, k) => (MAIL_DICT[lang] || MAIL_DICT.en)[k] ?? MAIL_DICT.en[k] ?? k;

// ---- 形の確かめ（M3・両側で行う） ----
export const MAIL_ADDR_RE = /^[A-Za-z0-9._%+-]{1,64}@[A-Za-z0-9.-]{1,252}\.[A-Za-z]{2,}$/;
export const mailAddrOk = a => typeof a === 'string' && a.length <= 254 && MAIL_ADDR_RE.test(a);
// アプリ パスワードは 16 字（Google の画面は 4 字ずつ空白で区切って出す）。空白を取り除いてから確かめる
export const normalizeMailPass = p => (typeof p === 'string' ? p.replace(/\s+/g, '') : '');
export const MAIL_PASS_RE = /^[a-z]{16}$/;
export const mailPassOk = p => MAIL_PASS_RE.test(normalizeMailPass(p));

// 画面に出す伏せた形（m***@gmail.com）。元の文字を 1 字目より多く残さない
export function maskAddr(a) {
  if (!mailAddrOk(a)) return null;
  const [l, d] = a.split('@');
  return `${l[0]}***@${d}`;
}
// 指紋: アドレスとアプリ パスワードの両方を入れた JSON の sha256 の先頭 16 字（r3 の 12）
export const mailFingerprint = ({ addr, pw }) => createHash('sha256').update(JSON.stringify({ addr, pw })).digest('hex').slice(0, 16);

// 「開く」の先の office の URL（http・https だけ・200 字まで・user:pass 無し）。slack.mjs の officeUrlOk はこれを使う
export const OFFICE_URL_MAX = 200;
export function officeUrlOk(u) {
  if (typeof u !== 'string' || !u || u.length > OFFICE_URL_MAX || /[\s\u0000-\u001f\u007f]/.test(u)) return false;
  try { const x = new URL(u); return (x.protocol === 'http:' || x.protocol === 'https:') && !x.username && !x.password; } catch { return false; }
}

// 見本の hash（入力は設定と文の形の版だけ。今の知らせの中身は入れない・M1）
export function mailPreviewHash({ fp, kinds, form, lang, officeUrl }) {
  const s = JSON.stringify({ v: MAIL_FORMAT_VERSION, fp: String(fp || ''), kinds: [...kinds].sort(), form, lang, officeUrl });
  return createHash('sha256').update(s).digest('hex').slice(0, 32);
}

// 選び（種類・形）の確かめ。知らない物は捨て、空なら null
export function checkMailChoice({ kinds, form } = {}) {
  const list = Array.isArray(kinds) ? kinds : typeof kinds === 'string' ? kinds.split(',') : [];
  const ks = MAIL_CHOICES.filter(k => list.includes(k));
  if (!ks.length || !MAIL_FORMS.includes(form)) return null;
  return { kinds: ks, form };
}

// ---- 文の検査（起動係は notify の答えを信じない・r3 の 1） ----
export const MAIL_BODY_LIMITS = Object.freeze({ subject: 200, text: 8000, html: 20000 });
const esc = s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const lit = s => esc(s).replace(/\\\{n\\\}/g, '\\d{1,6}');
const reCache = new Map();
// 件名は「[AI Office] 」＋辞書の見出し（と数字）だけの形
export function subjectRegex(lang) {
  const l = MAIL_DICT[lang] ? lang : 'en';
  if (reCache.has(l)) return reCache.get(l);
  const d = MAIL_DICT[l];
  const alts = [
    `(?:${lit(d.digest_am)}|${lit(d.digest_pm)}): (?:${lit(d.waiting)}|${lit(d.none)})`,
    ...['approval', 'decision', 'run_failing', 'stuck', 'stale_routine'].map(k => lit(d[`head_${k}`])),
    lit(d.overflow_head), lit(d.test_subject),
  ];
  const re = new RegExp(`^${esc(MAIL_PREFIX)}(?:${alts.join('|')})$`);
  reCache.set(l, re);
  return re;
}
const htmlEsc = s => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
// 起動係は notify の HTML を信じず、確かめた text と officeUrl から HTML を自分で作り直す（禁止の一覧の抜け道を作らない）。
// text は「見出し」「空行」「（1 件 1 行の一覧と空行）」「<開く>: <office の URL>」の形だけ。合わなければ null
export function htmlFromText(text, { lang, officeUrl } = {}) {
  if (typeof text !== 'string' || !officeUrlOk(officeUrl)) return null;
  const tail = `${mailT(lang, 'open')}: ${officeUrl}\n`;
  if (!text.endsWith(tail)) return null;
  const body = text.slice(0, text.length - tail.length);
  if (!body.endsWith('\n\n')) return null;
  const [head, ...rest] = body.slice(0, -2).split('\n\n');
  if (!head || head.includes('\n') || rest.length > 1) return null;
  const lines = rest.length ? rest[0].split('\n') : [];
  if (lines.some(l => !l)) return null;
  return `<!doctype html><html><body><p><strong>${htmlEsc(head)}</strong></p>${lines.length ? `<ul>${lines.map(l => `<li>${htmlEsc(l.replace(/^• /, ''))}</li>`).join('')}</ul>` : ''}<p><a href="${htmlEsc(officeUrl)}">${htmlEsc(mailT(lang, 'open'))}</a></p></body></html>`;
}
// checkMailMessage に加え、HTML が text から作り直した物と同じであることを求める（許す形はこれだけ・ほかは全部断る）
export function checkMailMessageStrict(m, ctx) {
  const bad = checkMailMessage(m, ctx, { html: false });
  if (bad) return bad;
  return htmlFromText(m.text, ctx) === m.html ? null : 'html_form';
}
// 属性用の escape の逆（href を比べるため）
const unattr = s => s.replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
// 返り値: null なら通す。通さない時は理由の印（ログと数えにだけ使う）
export function checkMailMessage(m, { lang, officeUrl } = {}, { html: htmlRules = true } = {}) {
  if (!m || typeof m !== 'object') return 'shape';
  const { subject, text, html } = m;
  if (typeof subject !== 'string' || typeof text !== 'string' || typeof html !== 'string') return 'shape';
  if (subject.length > MAIL_BODY_LIMITS.subject) return 'subject_long';
  if (text.length > MAIL_BODY_LIMITS.text) return 'text_long';
  if (html.length > MAIL_BODY_LIMITS.html) return 'html_long';
  if (/[\r\n\u0000]/.test(subject)) return 'subject_ctl';
  if (/\u0000/.test(text) || /\u0000/.test(html)) return 'nul';
  if (!subjectRegex(lang).test(subject)) return 'subject_form';
  if (!officeUrlOk(officeUrl)) return 'office_url';
  if (!htmlRules) return null; // 題の文字（href・src=・onboarding= など）にまで禁止の一覧を効かせない。HTML は作り直した物との比べで決める
  if ((html.match(/href/gi) || []).length !== 1) return 'href_count';
  const hrefs = [...html.matchAll(/<a\s+href="([^"]*)"/g)];
  if (hrefs.length !== 1) return 'href_form';
  const url = unattr(hrefs[0][1]);
  if (!officeUrlOk(url) || url !== officeUrl) return 'href_other';
  if (/<\s*(?:script|iframe|object|embed|form|img|link|style|base)\b|\bsrc\s*=|\bon[a-z]+\s*=/i.test(html)) return 'html_tag';
  return null;
}

// 1 日の境は UTC の 0 時（r3 の 10）
export const utcDay = ms => new Date(ms).toISOString().slice(0, 10);
export const nextUtcMidnight = ms => Date.parse(`${utcDay(ms)}T00:00:00Z`) + 86_400_000;
