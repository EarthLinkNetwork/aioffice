// 会社の人の役（owner・operator）を本体の DB で直す（設計 2.8・2026-11-24 e2e）
// 本体の API（PATCH /companies/:id/members/:memberId）は、自分の役も、自分と同じ役の人の役も変えさせない（routes/access.js の getProtectedMemberReason）。
// instance admin は会社の中で owner として扱われるが、relay は会社の owner の役で「持ち主」を決める。そのため、
// 会社の口から operator で入った新しい持ち主を owner に上げることと、admin を外れた前の持ち主を owner から下げることは、API では書けない。
// reset-owner と同じ住所（container の中の embedded postgres・本体の CLI と同じ資格）で、その 1 行の役だけを書き換える
import fs from 'node:fs';

const ROLES = new Set(['owner', 'operator']);
export function createRoleWriter({ dataRoot = process.env.AIOFFICE_DATA_ROOT || '/data', dbLib = process.env.AIOFFICE_DB_LIB || '/opt/aioffice/runtime/node_modules/@paperclipai/db/dist/index.js' } = {}) {
  return async (companyId, memberId, role) => {
    if (!ROLES.has(role)) throw new Error('bad role');
    const port = JSON.parse(fs.readFileSync(`${dataRoot}/paperclip/instances/default/config.json`, 'utf8')).database?.embeddedPostgresPort;
    if (!Number.isInteger(port)) throw new Error('no db port');
    const { createDb } = await import(dbLib);
    const db = createDb(`postgres://paperclip:paperclip@127.0.0.1:${port}/paperclip`);
    try {
      const rows = await db.$client`update company_memberships set membership_role = ${role}, updated_at = now()
        where id = ${memberId} and company_id = ${companyId} and principal_type = 'user' and status = 'active' returning id`;
      if (!rows.length) throw new Error('member not found');
    } finally { await db.$client.end?.({ timeout: 5 }).catch(() => {}); }
  };
}
