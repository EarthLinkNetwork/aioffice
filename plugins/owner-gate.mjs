// plugin の口の分け方（設計 docs/design/2026-11-23-public-office-multi-user.md 2.2b）。各 plugin の worker が取り込む（esbuild で 1 本に詰める）
// - 本体は plugin の口で「会社の member か」しか見ない。持ち主だけの口は、worker が actor.userId ∈ 設定の ownerUserIds を確かめる
// - ownerUserIds は起動係が会社ごとの plugin の設定に書く。無い時、持ち主だけの口は全部断る（fail-closed）
// - 表に無い口は断る（口を足したら表にも足す。試験 test/plugin-owner-gate.test.mjs が manifest の口と照らす）
export const ROUTES = {
  'aioffice.library': { member: ['search', 'status', 'documents', 'ask', 'ask-answer'], agent: [], owner: ['tick', 'put', 'remove'] },
  // read は member にも開くが、member が既読にできるのは kind が decision の知らせだけ（worker が key から kind を引いて確かめる）
  'aioffice.notify': { member: ['notices', 'read'], agent: [], owner: ['tick', 'settings', 'slack', 'slack-preview', 'slack-confirm', 'slack-off', 'slack-test', 'deliver', 'mail', 'mail-preview', 'mail-pending', 'mail-result', 'limit-resume'] },
  'aioffice.secretary': { member: ['status'], agent: [], owner: ['tick'] },
  'aioffice.design': { member: ['request'], agent: [], owner: [] },
  'aioffice.relay': { member: [], agent: ['request'], owner: ['tick'] },
};

// 設定の ownerUserIds の形（instanceConfigSchema に足す）
export const OWNER_SCHEMA = { type: 'array', title: 'Owners of this office (userIds). Set by the AI Office launcher', items: { type: 'string' } };

// 持ち主の返事として学んでよいコメントか（設計 2.7）: ownerUserIds の人か、その課題の宛先の人のコメントだけ。
// ownerUserIds が無い設定（ログインの無い前の版・起動係が書く前）は、今までどおり人のコメントを全部数える（local-board の返事を含む）
export const fromOwnerOrAssignee = (cfg, issue, comment) => {
  const uid = comment?.authorUserId; if (typeof uid !== 'string' || !uid) return false;
  if (!Array.isArray(cfg?.ownerUserIds)) return true;
  return cfg.ownerUserIds.includes(uid) || (typeof issue?.assigneeUserId === 'string' && issue.assigneeUserId === uid);
};
export const isOwner = (cfg, actor) => Array.isArray(cfg?.ownerUserIds) && typeof actor?.userId === 'string' && actor.userId !== '' && cfg.ownerUserIds.includes(actor.userId);

// 口を通してよいか。通す時は { owner } を返し、断る時は { deny: 本体へ返す答え } を返す
// getCfg: companyId → その会社の plugin の設定（読めなければ {}）
export async function gateRoute(pluginId, input, getCfg) {
  const t = ROUTES[pluginId];
  const k = input?.routeKey;
  if (!t || !k) return { deny: { status: 404, body: { error: 'unknown route' } } };
  if (t.agent.includes(k)) return { owner: false }; // 本体が auth: 'agent' で担当の鍵を確かめる
  const cfg = (await Promise.resolve().then(() => getCfg(input.companyId)).catch(() => ({}))) || {};
  const owner = isOwner(cfg, input.actor);
  if (t.member.includes(k)) return { owner };
  if (t.owner.includes(k)) return owner ? { owner } : { deny: { status: 403, body: { error: 'owner_only' } } };
  return { deny: { status: 404, body: { error: 'unknown route' } } };
}
