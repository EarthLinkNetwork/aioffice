// デザイン部の依頼（office の画面のデザイン部の部屋の「ロゴ」「チラシ」）。押した中身を確かめ、デザインの担当への課題の題と本文を作る。
// 範囲: docs/review/2026-11-15-office-plugin-scope.md の保証 5。担当の指示書の雛形: packages/aioffice/templates/design.{en,ja}.md
import { createHash } from 'node:crypto';

export const ORIGIN_KIND = 'plugin:aioffice.design:request'; // 本体の型は `plugin:${string}`
export const KINDS = { logo: { en: 'Logo', ja: 'ロゴ' }, flyer: { en: 'Flyer', ja: 'チラシ' } };
const MAX = { name: 80, brief: 2000 };
const clean = v => String(v ?? '').replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '').trim();
const langOf = v => (v === 'ja' ? 'ja' : 'en');

// 押した中身 → { ok, kind, name, brief, lang, agentId } か { ok: false, error }（error は画面の辞書の key）
export function checkRequest(b) {
  const kind = String(b?.kind || '');
  if (!Object.hasOwn(KINDS, kind)) return { ok: false, error: 'design_bad_kind' };
  const name = clean(b?.name), brief = clean(b?.brief), agentId = clean(b?.agentId);
  if (!name) return { ok: false, error: kind === 'logo' ? 'design_need_name' : 'design_need_title' };
  if (name.length > MAX.name) return { ok: false, error: 'design_name_too_long' };
  if (brief.length > MAX.brief) return { ok: false, error: 'design_brief_too_long' };
  if (!agentId) return { ok: false, error: 'design_no_agent' };
  return { ok: true, kind, name, brief, lang: langOf(b?.lang), agentId };
}

// 同じ依頼（種類・名前・希望）を見分ける id。言語は入れない（言語を替えても同じ依頼は 1 件）
export const originIdOf = ({ kind, name, brief }) => createHash('sha256').update(JSON.stringify([kind, name, brief])).digest('hex').slice(0, 32);

const TEXT = {
  en: {
    title: (k, name) => `[Design] ${k}: ${name}`,
    body: ({ k, kind, name, brief }) => [
      `# ${k} request`, '',
      `- Kind: ${k} (${kind})`,
      `- ${kind === 'logo' ? 'Name on the logo' : 'Title'}: ${name}`,
      '- Requested from: the Design room in the AI Office', '',
      '## Details', brief || '(None. Choose what fits the name or title best, and write down what you assumed in a comment.)', '',
      'Attach the images you make to this task, write how the drafts differ in a comment, and move the task to in_review.',
    ],
  },
  ja: {
    title: (k, name) => `[デザイン] ${k}: ${name}`,
    body: ({ k, kind, name, brief }) => [
      `# ${k}の依頼`, '',
      `- 種類: ${k}（${kind}）`,
      `- ${kind === 'logo' ? '入れる名前' : '題'}: ${name}`,
      '- 頼んだ所: AI オフィスのデザイン部の部屋', '',
      '## 細かい希望', brief || '（なし。名前・題から一番自然な物を選んで作り、選んだ前提をコメントに書く）', '',
      '作った画像はこの課題に添付し、案ごとの違いをコメントに書いて in_review にしてください。',
    ],
  },
};

export function issueOf({ kind, name, brief, lang }) {
  const T = TEXT[langOf(lang)], k = KINDS[kind][langOf(lang)];
  return { title: T.title(k, name), description: T.body({ k, kind, name, brief }).join('\n') };
}

const CLOSED = new Set(['done', 'cancelled']);
export const isOpen = issue => issue && !CLOSED.has(String(issue.status || ''));
