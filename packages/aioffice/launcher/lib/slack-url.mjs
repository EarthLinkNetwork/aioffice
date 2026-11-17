// Slack の Incoming Webhook の URL の形と指紋（起動係と知らせの plugin の両方が同じ関数を使う・範囲 docs/review/2026-11-18-slack-notify-scope.md S1・S3）
// 知らせの plugin は build の時にこの file を取り込む（Dockerfile の plugins の段で写す。folder-pick.js と同じ形）
import { createHash } from 'node:crypto';

// 本体に渡す前に形を確かめる（本体は壊れた URL の全文を error の文に入れ、ログに書く）。
// https・名前は hooks.slack.com だけ・path は /services/ と英数字の 3 段だけ。query・@・空白・改行・別の名前は通さない
export const SLACK_URL_RE = /^https:\/\/hooks\.slack\.com\/services\/[A-Za-z0-9]+\/[A-Za-z0-9]+\/[A-Za-z0-9]+$/;
export const slackUrlOk = u => typeof u === 'string' && u.length <= 300 && SLACK_URL_RE.test(u);

// 宛先の指紋: URL の sha256 の先頭 16 字（元に戻せない。state にはこれだけを置く）
export const destFingerprint = u => createHash('sha256').update(String(u)).digest('hex').slice(0, 16);

// 画面に出す伏せた形（URL のどの段の文字も入れない）
export const MASKED_DEST = 'hooks.slack.com/services/••••';
