// 入れ直しの前後の比べ方（G1・G2）。reinstall-check.mjs が使い、unit（test/reinstall-compare.test.mjs）が欠けた応答で落ちることを確かめる
// 返り値は食い違いの一覧（空なら合格）
export function compareStates(before, after) {
  const bad = [];
  if (after.cid !== before.cid) bad.push('会社が違う');
  if (JSON.stringify(after.docs) !== JSON.stringify(before.docs)) bad.push(`置いた文書が違う (${before.docs.join(',')} → ${after.docs.join(',')})`);
  if (!(after.chunks >= before.chunks)) bad.push(`所蔵が減った (${before.chunks} → ${after.chunks})`);
  if (after.briefs !== before.briefs) bad.push(`添え書きの comment の数が違う (${before.briefs} → ${after.briefs})`);
  for (const k of before.read) if (!after.read.includes(k)) bad.push(`読んだ知らせ ${k} が既読に残っていない`);
  for (const k of before.unread) if (!after.unread.includes(k)) bad.push(`未読の知らせ ${k} が未読に残っていない`);
  return bad;
}
// 検索の結果に、置いた文書そのもの（srcId が doc:<名前>）が入っているか
export const searchHitsDoc = (results, name) => (results || []).some(r => r.srcId === `doc:${name}`);
