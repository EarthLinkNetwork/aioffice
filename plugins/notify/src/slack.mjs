// Slack への届けの、本体に触らない部分（unit で確かめる）。範囲: docs/review/2026-11-18-slack-notify-scope.md の S1〜S8
// 文字は lib.mjs の辞書から引く（AI は使わない・S5）
import { createHash } from 'node:crypto';
import { t, safeTitle } from './lib.mjs';
import { slackUrlOk, destFingerprint } from '../../../packages/aioffice/launcher/lib/slack-url.mjs';
import { officeUrlOk as officeUrlOkCore } from '../../../packages/aioffice/launcher/lib/mail-core.mjs';

export { slackUrlOk, destFingerprint };

// ---- 持ち主に決めてもらうことの既定（「決めてほしいこと」Q1・Q2 の推奨の形）。答えが違ったらここだけを替える ----
// Q1 (c): 中身の形は欄で選べる（titles = 題つき・counts = 件数だけ）。既定は題つき
// Q2 (a): 既定は朝夕のまとめだけ。すぐの知らせは種類ごとに持ち主が足す
export const SLACK_DEFAULTS = Object.freeze({ kinds: Object.freeze(['digest']), form: 'titles' });
export const SLACK_FORMS = Object.freeze(['titles', 'counts']);
// 選べる種類（stuck は止まった課題と古い定時の回の 2 つ）。run_failed（1 回ごとの失敗）は送らない（S5）
export const SLACK_CHOICES = Object.freeze(['digest', 'approval', 'decision', 'run_failing', 'stuck']);
export const CHOICE_KINDS = Object.freeze({ digest: ['digest'], approval: ['approval'], decision: ['decision'], run_failing: ['run_failing'], stuck: ['stuck', 'stale_routine'] });
// 文の形の版（previewHash に入る。文の形を変えたら上げる。ON の人も見本を見直すまで送らない）
export const SLACK_FORMAT_VERSION = 1;

// 枠（S6・S8）
export const SLACK_LIMITS = Object.freeze({
  perCall: 3, gapMs: 1100, budgetMs: 20_000, minLeftMs: 9_000, waitMs: 8_000,
  perHour: 20, digestMax: 10, titleMax: 80, giveUpMs: 24 * 3600_000, retryAfterDefault: 60, retryAfterMax: 3600,
  rateWarnMs: 30 * 60_000, failBanner: 3, testEveryMs: 60_000, officeUrlMax: 200,
});
const RETRY_MIN = [1, 5, 15, 60];

// 起動係から来る選び（種類・形）を確かめる。知らない物は捨て、空なら null
export function checkChoice({ kinds, form } = {}) {
  const list = Array.isArray(kinds) ? kinds : typeof kinds === 'string' ? kinds.split(',') : [];
  const ks = SLACK_CHOICES.filter(k => list.includes(k));
  if (!ks.length || !SLACK_FORMS.includes(form)) return null;
  return { kinds: ks, form };
}
export const noticeKindsOf = choices => choices.flatMap(c => CHOICE_KINDS[c] || []);

// 「開く」の先の office の URL（http・https だけ・200 字まで・user:pass 無し）
// 判定は起動係と同じ 1 つ（メールの形の確かめと共通・launcher/lib/mail-core.mjs）
export const officeUrlOk = officeUrlOkCore;

// 見本の hash（入力は設定だけ。今の知らせの中身は入れない・S1）
export function previewHash({ fp, kinds, form, lang, officeUrl }) {
  const s = JSON.stringify({ v: SLACK_FORMAT_VERSION, fp: String(fp || ''), kinds: [...kinds].sort(), form, lang, officeUrl });
  return createHash('sha256').update(s).digest('hex').slice(0, 32);
}

// Slack の特別な文字を置き換え、呼び出し（<!channel>・<!here>・<@U…>・素の @here など）にならない文字にする（S5）
export function escapeSlack(s) {
  return String(s ?? '')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/@(?=(?:here|channel|everyone)\b)/gi, '＠');
}
const fill = (s, n) => s.replace('{n}', String(n));
const cut = (s, n) => { const v = String(s ?? ''); return v.length > n ? `${v.slice(0, n - 1)}…` : v; };

// 1 通の形（S5）: 見出し 1 行（text にも同じ文）・1 件 1 行・「AI オフィスで開く」の url ボタン 1 つ。文の中に link は置かない
// msg: { type: 'digest'|'notice'|'overflow'|'test', lang, form, slot, kind, items: [{ kind, title }], count }
export function slackMessage(msg, officeUrl) {
  const lang = msg.lang === 'ja' ? 'ja' : 'en';
  const L = k => t(lang, k);
  let head, lines = [];
  if (msg.type === 'digest') {
    const items = msg.items || [];
    head = `${L(msg.slot === 'pm' ? 'slack_digest_pm' : 'slack_digest_am')}: ${items.length ? fill(L('slack_waiting'), items.length) : L('slack_none')}`;
    if (msg.form === 'counts') lines = countLines(lang, items);
    else {
      lines = items.slice(0, SLACK_LIMITS.digestMax).map(n => `• ${cut(safeTitle(n.title, 400), SLACK_LIMITS.titleMax)}`);
      if (items.length > SLACK_LIMITS.digestMax) lines.push(fill(L('slack_more'), items.length - SLACK_LIMITS.digestMax));
    }
  } else if (msg.type === 'notice') {
    head = L(`slack_head_${msg.kind}`);
    lines = msg.form === 'counts' ? countLines(lang, [{ kind: msg.kind }]) : [`• ${cut(safeTitle(msg.items?.[0]?.title, 400), SLACK_LIMITS.titleMax)}`];
  } else if (msg.type === 'overflow') {
    head = L('slack_overflow_head');
    lines = [fill(L('slack_overflow'), msg.count)];
  } else {
    head = L('slack_test');
  }
  const blocks = [{ type: 'section', text: { type: 'mrkdwn', text: `*${escapeSlack(head)}*` } }];
  if (lines.length) blocks.push({ type: 'section', text: { type: 'mrkdwn', text: lines.map(escapeSlack).join('\n') } });
  if (officeUrlOk(officeUrl)) blocks.push({ type: 'actions', elements: [{ type: 'button', action_id: 'open_office', text: { type: 'plain_text', text: L('slack_open') }, url: officeUrl }] });
  return { text: escapeSlack(head), blocks };
}
// 件数だけの形: 種類ごとの件数を 1 行ずつ
const COUNT_LABEL = { approval: 'approval', decision: 'decision', run_failing: 'run_failed', run_failed: 'run_failed', stuck: 'stuck', stale_routine: 'stuck', digest: 'unread' };
export function countLines(lang, items) {
  const by = new Map();
  for (const n of items) { const k = COUNT_LABEL[n.kind] || 'unread'; by.set(k, (by.get(k) || 0) + 1); }
  return [...by].map(([k, n]) => `• ${t(lang, k)}: ${n}`);
}
// 送る body（link_names・unfurl を明示する・S5）
export const slackBody = m => JSON.stringify({ text: m.text, blocks: m.blocks, link_names: false, unfurl_links: false, unfurl_media: false });

// まとめの中身: 未読の知らせ（まとめ自身と Slack の失敗の知らせを除く）を、まとめができた時より前の物だけ
export const DIGEST_ITEM_KINDS = ['approval', 'decision', 'run_failing', 'run_failed', 'stuck', 'stale_routine'];
export function digestItems(notices, digest) {
  const at = Date.parse(digest?.createdAt) || Infinity;
  return (notices || []).filter(n => DIGEST_ITEM_KINDS.includes(n.kind) && !n.readAt && (Date.parse(n.createdAt) || 0) <= at)
    .sort((a, b) => DIGEST_ITEM_KINDS.indexOf(a.kind) - DIGEST_ITEM_KINDS.indexOf(b.kind) || String(a.createdAt).localeCompare(String(b.createdAt)));
}
const slotOf = n => (String(n?.originId || '').endsWith(':pm') ? 'pm' : 'am');

// 1 件の知らせから 1 通を作る（送る時も見本も同じ関数・S5）
export function messageFor(notice, { lang, form, notices }) {
  if (notice.kind === 'digest') return { type: 'digest', lang, form, slot: slotOf(notice), items: digestItems(notices, notice) };
  return { type: 'notice', lang, form, kind: notice.kind, items: [{ kind: notice.kind, title: notice.title }] };
}

// 見本: 選んだ種類ごとに 1 通。今の会社の知らせがあればその最新の物、無い種類は決まった例の文
export function previewOf({ kinds, form, lang, officeUrl, notices = [] }) {
  const now = new Date().toISOString();
  return kinds.map(c => {
    const have = (notices || []).filter(n => CHOICE_KINDS[c].includes(n.kind)).sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)))[0];
    const n = have || (c === 'digest' ? { kind: 'digest', originId: 'example:am', createdAt: now } : { kind: CHOICE_KINDS[c][0], title: t(lang, `slack_ex_${c}`), createdAt: now });
    return { kind: c, ...slackMessage(messageFor(n, { lang, form, notices }), officeUrl) };
  });
}

// Slack の短い答え（`^[a-z_]{1,40}$` に合う時だけ・S3）
export const slackCode = body => { const s = String(body ?? '').trim(); return /^[a-z_]{1,40}$/.test(s) ? s : 'unknown'; };

// Slack の答えの扱い（S6）。action: sent | rate | retry | drop | dead。status は答えの HTTP の数そのまま（code から抜き出さない・実装 r1 の 5）
export function classifySlack({ status, body, headers }) {
  const code = slackCode(body);
  const n0 = Number(status), st = Number.isInteger(n0) && n0 >= 100 && n0 < 600 ? n0 : null;
  if (status >= 200 && status < 300) return { action: 'sent', code: 'ok', status: st };
  if (status === 429) {
    const raw = headers?.['retry-after'] ?? (typeof headers?.get === 'function' ? headers.get('retry-after') : undefined);
    const n = Number(raw);
    const sec = Number.isFinite(n) && n > 0 ? Math.min(Math.ceil(n), SLACK_LIMITS.retryAfterMax) : SLACK_LIMITS.retryAfterDefault;
    return { action: 'rate', code: `http_429`, status: st, waitMs: sec * 1000 };
  }
  if (status === 400) return { action: 'drop', code: code === 'unknown' ? 'http_400' : code, status: st };
  if ([401, 403, 404, 410].includes(status)) return { action: 'dead', code: code === 'unknown' ? `http_${status}` : code, status: st };
  return { action: 'retry', code: `http_${Number(status) || 0}`, status: st };
}

// 送り直しの待ち（S6）: 1 分・5 分・15 分・60 分・以後 60 分ごと。attempts は失敗の回数（1 から）
export const nextAttempt = (attempts, nowMs) => nowMs + (RETRY_MIN[Math.min(Math.max(attempts, 1), RETRY_MIN.length) - 1]) * 60_000;
export const expired = (createdAt, nowMs) => nowMs - (Date.parse(createdAt) || nowMs) >= SLACK_LIMITS.giveUpMs;

// error を決まった印に置き換える（文を外へ出さない・S3）。URL の全文を含む error でも印だけを返す
export function errorCode(e) {
  const name = String(e?.name || ''), code = String(e?.code || ''), m = String(e?.message || '');
  if (name === 'AbortError' || name === 'TimeoutError' || code === 'slack_timeout') return 'timeout';
  if (/^E(NOTFOUND|AI_AGAIN|AI_NONAME)$/.test(code) || /\bDNS\b/i.test(m)) return 'dns';
  if (/CERT|SSL|TLS|self[- ]signed|certificate/i.test(code + ' ' + m)) return 'tls';
  if (/private|blocked|not allowed|Invalid URL|protocol/i.test(m)) return 'blocked';
  if (/timed? ?out/i.test(m)) return 'timeout';
  return 'network';
}
