// メールで届ける口（知らせの plugin の worker の中）。範囲: docs/review/2026-11-19-mail-notify-scope.md の r2 の「送る形」と r3 の 1〜13
// この plugin は文を作って待ちに積むだけで、外へは何も送らない。送るのは起動係（見回りの中で pending を取り、result を返す）。
// - ON・OFF・宛先・アプリ パスワードは起動係の state が正。ここには置かない（口の body でも受けない）
// - 起動係が ON の時刻（onAt）を渡さない回は、待ちを作らず空を返す（OFF の間に待ちを溜めない・r3 の 2）
// - 失敗の置き場・やり直しの時刻・24 時間で捨てる・1 時間の上限を超えた分の「ほか n 件」は、ここで受け持つ（r3 の 4）。枠を数えるのは起動係
import { keyedChain, LANGS } from './lib.mjs';
import { nextAttempt, expired } from './slack.mjs';
import { MAIL_LIMITS, MAIL_FORMAT_VERSION, checkMailChoice, noticeKindsOf, officeUrlOk, admitMail, testMail, mailPreviewMessages } from './mail.mjs';

export const MAIL = companyId => ({ scopeKind: 'company', scopeId: companyId, stateKey: 'mail' });
const iso = ms => new Date(ms).toISOString();
const q1 = v => (Array.isArray(v) ? v[0] : v);
const ID_RE = /^(?:[0-9a-f]{32}|overflow:\d{1,9})$/;
const CODE_RE = /^[a-z_0-9]{1,40}$/;
const EXT_RE = /^\d\.\d{1,3}\.\d{1,3}$/;
export const RESULTS = Object.freeze(['sent', 'retry', 'hold', 'dead', 'drop', 'overflow', 'bad']);

// 待ちの記録の表への読み書き（SQL はここだけ・どれも会社で絞る）
export function mailStore(db) {
  const tb = `${db.namespace}.mail_sends`, nt = `${db.namespace}.notices`;
  return {
    enqueue: (companyId, kinds, sinceIso) => db.execute(`INSERT INTO ${tb} (company_id, notice_key, status, attempts, next_at) SELECT n.company_id, n.key, 'pending', 0, n.created_at FROM ${nt} n WHERE n.company_id = $1 AND n.kind = ANY(string_to_array($2, ',')) AND n.created_at >= $3::timestamptz ON CONFLICT (company_id, notice_key) DO NOTHING`, [companyId, kinds.join(','), sinceIso]),
    dropOrphans: companyId => db.execute(`DELETE FROM ${tb} s WHERE s.company_id = $1 AND s.status = 'pending' AND NOT EXISTS (SELECT 1 FROM ${nt} n WHERE n.company_id = s.company_id AND n.key = s.notice_key)`, [companyId]),
    // ON にした時刻より前の知らせは送らない（OFF の間・前の ON の時の物・r3 の 2）
    skipBefore: (companyId, sinceIso) => db.execute(`UPDATE ${tb} s SET status = 'skipped', last_code = 'before_on' FROM ${nt} n WHERE s.company_id = $1 AND s.status = 'pending' AND n.company_id = s.company_id AND n.key = s.notice_key AND n.created_at < $2::timestamptz`, [companyId, sinceIso]),
    due: (companyId, nowIso, limit = 20) => db.query(`SELECT s.notice_key AS "key", s.attempts, n.kind, n.title, n.origin_id AS "originId", n.created_at AS "createdAt" FROM ${tb} s JOIN ${nt} n ON n.company_id = s.company_id AND n.key = s.notice_key WHERE s.company_id = $1 AND s.status = 'pending' AND s.next_at <= $2::timestamptz ORDER BY n.created_at, s.notice_key LIMIT ${Number(limit)}`, [companyId, nowIso]),
    one: async (companyId, key) => (await db.query(`SELECT s.attempts, s.status, n.created_at AS "createdAt" FROM ${tb} s LEFT JOIN ${nt} n ON n.company_id = s.company_id AND n.key = s.notice_key WHERE s.company_id = $1 AND s.notice_key = $2`, [companyId, key]))[0] || null,
    pendingCount: async companyId => Number((await db.query(`SELECT count(*)::int AS n FROM ${tb} WHERE company_id = $1 AND status = 'pending'`, [companyId]))[0]?.n || 0),
    markSent: (companyId, key, nowIso) => db.execute(`UPDATE ${tb} SET status = 'sent', sent_at = $3::timestamptz, last_code = 'ok' WHERE company_id = $1 AND notice_key = $2`, [companyId, key, nowIso]),
    markRetry: (companyId, key, attempts, nextIso, code) => db.execute(`UPDATE ${tb} SET attempts = $3, next_at = $4::timestamptz, last_code = $5 WHERE company_id = $1 AND notice_key = $2`, [companyId, key, attempts, nextIso, code]),
    markDone: (companyId, key, status, code) => db.execute(`UPDATE ${tb} SET status = $3, last_code = $4 WHERE company_id = $1 AND notice_key = $2`, [companyId, key, status, code]),
    giveUp: async (companyId, cutoffIso) => Number((await db.execute(`UPDATE ${tb} s SET status = 'gave_up' FROM ${nt} n WHERE s.company_id = $1 AND s.status = 'pending' AND n.company_id = s.company_id AND n.key = s.notice_key AND n.created_at < $2::timestamptz`, [companyId, cutoffIso]))?.rowCount || 0),
  };
}

// 会社ごとの state の書き込みは 1 本の鍵（会社ごとの promise の鎖）を通す。state.set を呼ぶのは patch の 1 か所だけ
const LOCK = keyedChain();
async function patch(deps, companyId, fn) {
  return LOCK(String(companyId), async () => {
    const cur = (await deps.state.get(MAIL(companyId))) || {};
    const next = { ...cur }; fn(next);
    await deps.state.set(MAIL(companyId), next);
    return next;
  });
}

// 画面と帯のための状態（宛先・アプリ パスワードは持たない）
export async function mailStatus(deps, companyId) {
  const st = (await deps.state.get(MAIL(companyId))) || {};
  return { v: 1, formatVersion: MAIL_FORMAT_VERSION, waiting: await deps.mail.pendingCount(companyId), dropped: st.dropped || 0, overflow: st.overflow || 0, lastOkAt: st.lastOkAt || null, lastFail: st.lastFail || null };
}

// 起動係が選び・言語・office の URL を足して呼ぶ（見本と送る文は同じ関数で作る・M5）
function readChoice(query) {
  const choice = checkMailChoice({ kinds: q1(query?.kinds), form: q1(query?.form) });
  const lang = q1(query?.lang), officeUrl = q1(query?.officeUrl);
  if (!choice || !LANGS.includes(lang) || !officeUrlOk(officeUrl)) return null;
  return { ...choice, lang, officeUrl };
}

export async function mailPreview(deps, companyId, query) {
  const c = readChoice(query);
  if (!c) return { status: 400, body: { error: 'mail_bad_choice' } };
  const notices = await deps.notices.listNotices(companyId);
  return { status: 200, body: { v: 1, formatVersion: MAIL_FORMAT_VERSION, messages: mailPreviewMessages({ ...c, notices }), test: testMail(c.lang, c.officeUrl) } };
}

// 送り待ちの文（r3 の 1・2・4）。答えの各行: { id, kind, createdAt, attempts, subject, text, html }。宛先の欄は無い
export async function mailPending(deps, companyId, query) {
  const onRaw = q1(query?.onAt);
  if (!onRaw) return { status: 200, body: { v: 1, formatVersion: MAIL_FORMAT_VERSION, rows: [], off: true } }; // 起動係が ON の時刻を渡さない回は空
  const c = readChoice(query);
  const onMs = Date.parse(onRaw);
  const limit = Math.min(Math.max(Number.parseInt(q1(query?.limit), 10) || 3, 1), MAIL_LIMITS.perCallMax);
  if (!c || !Number.isFinite(onMs) || onMs > deps.now() + 60_000) return { status: 400, body: { error: 'mail_bad_choice' } };
  const r = await deps.mailFlight.run(async () => {
    const nowMs = deps.now(), nowIso = iso(nowMs), onIso = iso(onMs);
    await deps.mail.dropOrphans(companyId);
    await deps.mail.skipBefore(companyId, onIso);
    await deps.mail.enqueue(companyId, noticeKindsOf(c.kinds), onIso);
    const gaveUp = await deps.mail.giveUp(companyId, iso(nowMs - MAIL_LIMITS.giveUpMs));
    let st = gaveUp ? await patch(deps, companyId, s => { s.dropped = (s.dropped || 0) + gaveUp; }) : ((await deps.state.get(MAIL(companyId))) || {});
    // 前の ON の間にまとめた「ほか n 件」は、OFF → ON し直し（onAt が替わる）で 0 に戻す。新しい ON に前の ON の分を持ち越さない
    if (st.lastOnAt !== onIso) st = await patch(deps, companyId, s => { s.lastOnAt = onIso; s.overflow = 0; });
    const rows = await deps.mail.due(companyId, nowIso, 20);
    const queue = [...(st.overflow > 0 ? [{ overflow: st.overflow, key: `overflow:${st.overflowSeq || 0}` }] : []), ...rows];
    const notices = queue.some(x => x.kind === 'digest') ? await deps.notices.listNotices(companyId) : [];
    const out = [];
    for (const item of queue) {
      if (out.length >= limit) break;
      const gate = admitMail({ ...c, onAt: onMs }, item, notices);
      if (gate.skip) { if (!item.overflow) await deps.mail.markDone(companyId, item.key, 'skipped', gate.skip); continue; }
      out.push({ id: item.key, kind: item.overflow ? 'overflow' : item.kind, createdAt: item.overflow ? nowIso : iso(new Date(item.createdAt).getTime()), attempts: item.attempts || 0, ...gate.msg });
    }
    return { v: 1, formatVersion: MAIL_FORMAT_VERSION, rows: out };
  });
  if (r.busy) return { status: 409, body: { error: 'notify_busy' } };
  return { status: 200, body: r.value };
}

// 起動係が返す結果（成功と失敗の両方・r3 の 4）。body: { id, result, code?, ext? }
export async function mailResult(deps, companyId, body) {
  const b = body && typeof body === 'object' ? body : {};
  if (typeof b.id !== 'string' || !ID_RE.test(b.id) || !RESULTS.includes(b.result)) return { status: 400, body: { error: 'mail_bad_result' } };
  const code = typeof b.code === 'string' && CODE_RE.test(b.code) ? b.code : 'unknown';
  const ext = typeof b.ext === 'string' && EXT_RE.test(b.ext) ? b.ext : null;
  const overflowRow = b.id.startsWith('overflow:');
  const nowMs = deps.now(), at = iso(nowMs);
  const fail = { at, code, ext };
  if (b.result === 'sent') {
    if (overflowRow) await patch(deps, companyId, s => { s.overflow = 0; s.overflowSeq = (s.overflowSeq || 0) + 1; s.lastOkAt = at; });
    else { await deps.mail.markSent(companyId, b.id, at); await patch(deps, companyId, s => { s.lastOkAt = at; }); }
  } else if (b.result === 'overflow') {
    if (!overflowRow) { await deps.mail.markDone(companyId, b.id, 'overflow', null); await patch(deps, companyId, s => { s.overflow = (s.overflow || 0) + 1; }); }
  } else if (b.result === 'drop' || b.result === 'bad') {
    if (overflowRow) await patch(deps, companyId, s => { s.overflow = 0; s.overflowSeq = (s.overflowSeq || 0) + 1; s.lastFail = fail; });
    else { await deps.mail.markDone(companyId, b.id, b.result === 'bad' ? 'skipped' : 'dropped', b.result === 'bad' ? 'bad' : code); await patch(deps, companyId, s => { s.lastFail = fail; }); }
  } else if (b.result === 'retry' && !overflowRow) {
    const row = await deps.mail.one(companyId, b.id);
    if (row) {
      const attempts = (row.attempts || 0) + 1;
      // 24 時間たった物は捨てて数える（M9）
      if (row.createdAt && expired(row.createdAt, nowMs)) { await deps.mail.markDone(companyId, b.id, 'gave_up', code); await patch(deps, companyId, s => { s.dropped = (s.dropped || 0) + 1; s.lastFail = fail; }); }
      else { await deps.mail.markRetry(companyId, b.id, attempts, iso(nextAttempt(attempts, nowMs)), code); await patch(deps, companyId, s => { s.lastFail = fail; }); }
    }
  } else {
    // dead（宛先・認証で OFF にした）・hold（今日は送らない）・overflow の行の retry: 待ちはそのまま残し、失敗の印だけ残す
    await patch(deps, companyId, s => { s.lastFail = fail; });
  }
  return { status: 200, body: { v: 1 } };
}

// 口の振り分け（worker.mjs から呼ぶ）。error の文は外へ出さない
export async function mailRoute(deps, input) {
  const companyId = input.companyId;
  try {
    if (input.routeKey === 'mail') return { status: 200, body: await mailStatus(deps, companyId) };
    if (input.routeKey === 'mail-preview') return await mailPreview(deps, companyId, input.query);
    if (input.routeKey === 'mail-pending') return await mailPending(deps, companyId, input.query);
    if (input.routeKey === 'mail-result') return await mailResult(deps, companyId, input.body);
  } catch { return { status: 502, body: { error: 'notify_failed' } }; }
  return null;
}
export const MAIL_ROUTE_KEYS = Object.freeze(['mail', 'mail-preview', 'mail-pending', 'mail-result']);
