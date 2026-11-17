// メールで届ける文の、本体に触らない部分（unit で確かめる）。範囲: docs/review/2026-11-19-mail-notify-scope.md の M4・M5・M10 と r3 の 1・2・4
// 文を作るのはこの plugin、送るのは起動係。ここに網の口は無い（送り方の語も置かない）
// 文字は辞書（launcher/lib/mail-core.mjs の MAIL_DICT。起動係の件名の検査も同じ辞書から作る）と lib.mjs の辞書だけから出す
import { t, safeTitle } from './lib.mjs';
import { CHOICE_KINDS, SLACK_LIMITS, digestItems, countLines, messageFor, noticeKindsOf, officeUrlOk } from './slack.mjs';
import { MAIL_PREFIX, MAIL_FORMAT_VERSION, mailT, checkMailChoice, mailPreviewHash } from '../../../packages/aioffice/launcher/lib/mail-core.mjs';

export { MAIL_FORMAT_VERSION, checkMailChoice, mailPreviewHash, noticeKindsOf, officeUrlOk, digestItems };

// 枠のうち、この plugin が持つ物（送りの枠そのものを数えるのは起動係）。やり直しの待ちは Slack と同じ表（slack.mjs の nextAttempt）
export const MAIL_LIMITS = Object.freeze({ digestMax: SLACK_LIMITS.digestMax, titleMax: SLACK_LIMITS.titleMax, giveUpMs: SLACK_LIMITS.giveUpMs, perCallMax: 5 });

const fill = (s, n) => s.replace('{n}', String(n));
const cut = (s, n) => { const v = String(s ?? ''); return v.length > n ? `${v.slice(0, n - 1)}…` : v; };
// 題は AI や人が書いた物。制御文字を空白にし、URL の形はメールの画面が自動でリンクにしないよう壊す（M5）
const defang = s => s.replace(/\bhttp(s?):\/\//gi, 'hxxp$1://').replace(/(?<!hxxps?):\/\//g, '[:]//').replace(/\bwww\./gi, 'www[.]');
const oneLine = s => String(s ?? '').replace(/[\u0000-\u001f\u007f\u2028\u2029]+/g, ' ').replace(/\s+/g, ' ').trim();
const titleLine = n => defang(oneLine(cut(safeTitle(n?.title, 400), MAIL_LIMITS.titleMax)));
export const htmlEscape = s => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');

// 1 通の形（M5）: 件名は辞書と件数だけの 1 行・本文は見出し・1 件 1 行・「AI オフィスで開く」の 1 つのリンク。text と HTML は同じ中身
// msg: messageFor（slack.mjs）と同じ形 + { type: 'overflow'|'test' }
export function mailMessage(msg, officeUrl) {
  const lang = msg.lang === 'ja' ? 'ja' : 'en';
  const L = k => mailT(lang, k);
  let head, lines = [];
  if (msg.type === 'digest') {
    const items = msg.items || [];
    head = `${L(msg.slot === 'pm' ? 'digest_pm' : 'digest_am')}: ${items.length ? fill(L('waiting'), items.length) : L('none')}`;
    if (msg.form === 'counts') lines = countLines(lang, items).map(oneLine);
    else {
      lines = items.slice(0, MAIL_LIMITS.digestMax).map(n => `• ${titleLine(n)}`);
      if (items.length > MAIL_LIMITS.digestMax) lines.push(fill(L('more'), items.length - MAIL_LIMITS.digestMax));
    }
  } else if (msg.type === 'notice') {
    head = L(`head_${msg.kind}`);
    lines = msg.form === 'counts' ? countLines(lang, [{ kind: msg.kind }]).map(oneLine) : [`• ${titleLine(msg.items?.[0])}`];
  } else if (msg.type === 'overflow') {
    head = L('overflow_head');
    lines = [fill(L('overflow'), msg.count)];
  } else {
    head = L('test_subject');
    lines = [L('test_body')];
  }
  const subject = `${MAIL_PREFIX}${head}`;
  const open = L('open');
  const text = `${head}\n\n${lines.length ? `${lines.join('\n')}\n\n` : ''}${open}: ${officeUrl}\n`;
  const html = `<!doctype html><html><body><p><strong>${htmlEscape(head)}</strong></p>${lines.length ? `<ul>${lines.map(l => `<li>${htmlEscape(l.replace(/^• /, ''))}</li>`).join('')}</ul>` : ''}<p><a href="${htmlEscape(officeUrl)}">${htmlEscape(open)}</a></p></body></html>`;
  return { subject, text, html };
}

// 送りの口が渡す「試しの 1 通」の文（会社の題を入れない・M7）
export const testMail = (lang, officeUrl) => mailMessage({ type: 'test', lang }, officeUrl);

// 見本: 選んだ種類ごとに 1 通。今の会社の知らせがあればその最新の物、無い種類は決まった例の文。送る時と同じ関数（M5）
export function mailPreviewMessages({ kinds, form, lang, officeUrl, notices = [] }) {
  const now = new Date().toISOString();
  return kinds.map(c => {
    const have = (notices || []).filter(n => CHOICE_KINDS[c].includes(n.kind)).sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)))[0];
    const n = have || (c === 'digest' ? { kind: 'digest', originId: 'example:am', createdAt: now } : { kind: CHOICE_KINDS[c][0], title: t(lang, `slack_ex_${c}`), createdAt: now });
    return { kind: c, ...mailMessage(messageFor(n, { lang, form, notices }), officeUrl) };
  });
}

// 送る直前の関門。待ちの行を今の ON の写し（起動係が渡した選び）と照らす。合わない時は { skip: 理由 }
// choice: { kinds, form, lang, officeUrl, onAt(ms) }
export function admitMail(choice, item, notices = []) {
  if (item.overflow) return { msg: mailMessage({ type: 'overflow', lang: choice.lang, count: item.overflow }, choice.officeUrl) };
  if (!noticeKindsOf(choice.kinds).includes(item.kind)) return { skip: 'kind_off' };
  const made = new Date(item.createdAt).getTime();
  if (!Number.isFinite(made) || made < choice.onAt) return { skip: 'before_on' };
  return { msg: mailMessage(messageFor(item, { lang: choice.lang, form: choice.form, notices }), choice.officeUrl) };
}
