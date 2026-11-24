// 人と承認の列（設計 docs/design/2026-11-23-public-office-multi-user.md 2.5）
// - 人 = 本体の会社の members のうち、user・active・viewer でない・local-board でない
// - 持ち主が人ごとに 肩書き・上の人・知らせのメール（持ち主が確かめた物だけ）を決め、起動係の state.people[userId] に置く
// - relay の設定（directory・approvers・defaultRequester）は、全部の会社の members と state.people から作る
const ID = /^[A-Za-z0-9_-]{1,200}$/;
const str = (v, n) => (typeof v === 'string' ? v.trim().slice(0, n) : '');

export const isPerson = m => m?.principalType === 'user' && m.status === 'active' && m.membershipRole !== 'viewer' && m.principalId !== 'local-board' && ID.test(String(m.principalId || ''));

// members の一覧（会社ごと）から人の表を作る。membersByCompany: { companyId: members[] }
export function peopleIndex(membersByCompany) {
  const out = {};
  for (const [cid, list] of Object.entries(membersByCompany || {})) {
    for (const m of Array.isArray(list) ? list : []) {
      if (!isPerson(m)) continue;
      const p = out[m.principalId] ||= { userId: m.principalId, name: str(m.user?.name, 80), email: str(m.user?.email, 200), companies: [], roles: {} };
      if (!p.companies.includes(cid)) p.companies.push(cid);
      p.roles[cid] = m.membershipRole;
    }
  }
  return out;
}

// 上の人を決める。輪になる・自分・人でない userId は断る（理由の印を返す）。boss が空なら外す
export function setBoss(people, userId, boss, known) {
  if (!ID.test(String(userId || ''))) return { error: 'person_unknown' };
  const next = { ...(people || {}) };
  const cur = { ...(next[userId] || {}) };
  if (!boss) { delete cur.boss; next[userId] = cur; return { people: next }; }
  if (boss === userId) return { error: 'boss_self' };
  if (known && !known[boss]) return { error: 'person_unknown' };
  const seen = new Set([userId]);
  for (let u = boss; u; u = next[u]?.boss) { if (seen.has(u)) return { error: 'boss_loop' }; seen.add(u); }
  cur.boss = boss; next[userId] = cur;
  return { people: next };
}

// relay の設定。ownerUserId は持ち主（担当が作った課題で依頼元が無い時の起点）。上の人が会社から外れた時は、その人の手前で止まる（approvers に載せない）
export function relayConfig({ index, people, ownerUserId }) {
  const directory = {}, approvers = {};
  for (const [u, p] of Object.entries(index || {})) directory[u] = { name: p.name || p.email || 'その人', email: p.email, companies: [...p.companies] };
  for (const [u, v] of Object.entries(people || {})) if (directory[u] && v?.boss && directory[v.boss]) approvers[u] = v.boss;
  const cfg = { directory, approvers };
  if (ownerUserId && directory[ownerUserId]) cfg.defaultRequester = ownerUserId;
  return cfg;
}

// 持ち主の「人」の欄に出す行（上の人が会社から外れた・メールが未確認 の注意つき）
export function peopleRows({ index, people }) {
  return Object.values(index || {}).map(p => {
    const v = people?.[p.userId] || {};
    const warn = [];
    if (v.boss && !index[v.boss]) warn.push('boss_gone');
    if (!(v.mail && v.mailConfirmed)) warn.push('mail_unconfirmed');
    return { userId: p.userId, name: p.name, email: p.email, companies: p.companies, title: str(v.title, 80), boss: v.boss || null, mail: v.mailConfirmed ? v.mail : null, warn };
  }).sort((a, b) => a.name.localeCompare(b.name));
}

// 設定を比べる（変わった時だけ setPluginConfig）
// 本体は設定を jsonb に置くので key の順が変わる。順をそろえて比べる（毎分の書き直しをしない）
const canon = v => (Array.isArray(v) ? v.map(canon) : v && typeof v === 'object' ? Object.fromEntries(Object.keys(v).sort().map(k => [k, canon(v[k])])) : v);
export const sameJson = (a, b) => JSON.stringify(canon(a ?? null)) === JSON.stringify(canon(b ?? null));
