// 担当の指示書の雛形（日英）。秘書は必ず入れる。ほかは wizard で選ぶ
// 雛形は特定の会社の運用の語を含まない（test/launcher.test.mjs が確かめる）
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../templates');

export const TEMPLATES = {
  secretary: { required: true, name: { en: 'Secretary', ja: '秘書' }, title: { en: 'Answers you and routes work to the right desk', ja: '話しかけると答え、仕事を担当へ回す' } },
  design: { name: { en: 'Design Desk', ja: 'デザイン課' }, title: { en: 'Makes logos and flyers as images', ja: 'ロゴ・チラシなどの画像を作る' } },
  research: { name: { en: 'Research Desk', ja: '調べもの係' }, title: { en: 'Looks things up and writes a short report', ja: '調べて短い報告を書く' } },
};

export function templateText(id, lang) {
  if (!TEMPLATES[id]) throw new Error(`unknown template ${id}`);
  return fs.readFileSync(path.join(DIR, `${id}.${lang === 'ja' ? 'ja' : 'en'}.md`), 'utf8');
}
