// 持ち主に決めてもらう時の書き方（判断の形）を、会社の全部の AI の担当の指示書（AGENTS.md）に揃える。
// 範囲: docs/review/2026-11-25-case-format-in-public-scope.md（開発元の記録）。本文の正本は templates/case-format.{ja,en}.md。
// 目印 <!-- case-format:begin --> 〜 <!-- case-format:end --> の間だけを書き換え、目印の外には触らない。
// 社内の運用の道具も同じ関数と同じ本文を使う（本文は全部の会社で 1 字も違わない）。
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../templates');
export const CASE_MARK = { begin: '<!-- case-format:begin -->', end: '<!-- case-format:end -->', before: ['<!-- library-rules:begin -->', '<!-- decisions:begin -->'] };
export const caseText = lang => fs.readFileSync(path.join(DIR, `case-format.${lang === 'ja' ? 'ja' : 'en'}.md`), 'utf8').trim();

// 目印は行頭にある物だけを数える（説明の文の中に文字として出た目印では動かさない）
const marksOf = (text, mark) => [...text.matchAll(new RegExp(`^${mark.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`, 'gm'))].map(m => m.index);
// 節を入れる・差し替える（純関数）。cur が null（AGENTS.md が無い）なら null（作らない）。mark: { begin, end, before: [その前に入れる目印] }
export const upsertSection = (cur, block, mark) => {
  if (cur == null) return null;
  const bs = marksOf(cur, mark.begin), es = marksOf(cur, mark.end);
  if (bs.length === 1 && es.length === 1 && es[0] > bs[0]) return `${cur.slice(0, bs[0])}${block}${cur.slice(es[0] + mark.end.length)}`;
  if (bs.length || es.length) return null; // 目印が片方だけ・2 つ以上・順が逆（壊れている）は触らない
  const d = (mark.before || []).flatMap(m => marksOf(cur, m)).sort((x, y) => x - y)[0];
  if (d !== undefined) return `${cur.slice(0, d).replace(/\s*$/, '\n\n')}${block}\n\n${cur.slice(d)}`;
  return `${cur.replace(/\s*$/, '')}\n\n${block}\n`;
};
export const upsertCase = (cur, block) => upsertSection(cur, block, CASE_MARK);
// 指示書の全体を書くほかの道具用: 今の指示書にこの節があれば、新しい全文にも同じ節を引き継ぐ（全体の書き直しで節を消さない）
export const keepCase = (cur, next) => {
  if (cur == null || next == null) return next;
  const bs = marksOf(cur, CASE_MARK.begin), es = marksOf(cur, CASE_MARK.end);
  if (!(bs.length === 1 && es.length === 1 && es[0] > bs[0])) return next;
  return upsertCase(next, cur.slice(bs[0], es[0] + CASE_MARK.end.length)) ?? next;
};
// 書く対象: AI の担当（adapterType が process でない・やめていない）。op: insert・replace・same・no-agents-md・broken-marks
export const isAiAgent = a => a && a.adapterType !== 'process' && a.status !== 'terminated';
export const planCase = (agents, files, block) => agents.filter(isAiAgent).map(a => {
  const cur = files[a.id] ?? null, next = upsertCase(cur, block);
  const op = cur == null ? 'no-agents-md' : next == null ? 'broken-marks' : next === cur ? 'same' : marksOf(cur, CASE_MARK.begin).length ? 'replace' : 'insert';
  return { id: a.id, name: a.name, office: a.office, adapterType: a.adapterType, op, delta: next != null && cur != null ? next.length - cur.length : 0, next };
});

// 本体の API で会社の全部の AI の担当を揃える。pc: launcher/lib/paperclip.mjs の口（companies・agents・instructionsFile・putInstructionsFile）
// 同じ本文の担当には書かない（何回たどっても 1 回だけ入る）。1 人の失敗はほかの担当を止めない。返り値は op ごとの数
export async function syncCaseFormat(pc, { lang, log = () => {} }) {
  const block = caseText(lang);
  const out = { insert: 0, replace: 0, same: 0, 'no-agents-md': 0, 'broken-marks': 0, failed: 0 };
  const list = j => (Array.isArray(j) ? j : j?.items || []);
  for (const c of list(await pc.companies())) {
    const agents = list(await pc.agents(c.id)).filter(isAiAgent), files = {};
    for (const a of agents) {
      try { files[a.id] = (await pc.instructionsFile(a.id))?.content ?? null; } catch (e) { if (e.status !== 404) { out.failed++; log(`aioffice: case-format read failed for an agent: ${e.status || e.message}`); files[a.id] = undefined; } else files[a.id] = null; }
    }
    for (const p of planCase(agents.filter(a => files[a.id] !== undefined), files, block)) {
      if (p.op === 'insert' || p.op === 'replace') {
        try { await pc.putInstructionsFile(p.id, p.next); } catch (e) { out.failed++; log(`aioffice: case-format write failed for an agent: ${e.status || e.message}`); continue; }
      }
      out[p.op]++;
    }
  }
  return out;
}
