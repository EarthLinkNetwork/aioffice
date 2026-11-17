// Slack への届けの口（知らせの plugin の worker の中）。範囲: docs/review/2026-11-18-slack-notify-scope.md の S1〜S8
// - 本体の http.fetch を呼ぶのは postSlack の 1 か所だけ。呼ぶ直前に会社の state を読み直し、ON で、今引いた宛先の指紋が ON の時の指紋と同じ時だけ送る（S2）
// - 送る文は state に写した ON の時の設定（種類・形・言語・office の URL）からだけ作る。本体の plugin の設定の欄は宛先の参照のほかに使わない
// - 宛先の URL・秘密・body は、口の返事・state・ログのどこにも出さない（S3）。error は決まった印だけ
import { makeBudget, keyedChain, LANGS, noticeKey, t } from './lib.mjs';
import { SLACK_DEFAULTS, SLACK_CHOICES, SLACK_FORMS, SLACK_LIMITS as L, checkChoice, noticeKindsOf, officeUrlOk, previewHash, previewOf, slackMessage, slackBody, messageFor, classifySlack, nextAttempt, errorCode, slackUrlOk, destFingerprint } from './slack.mjs';

export const SLACK = companyId => ({ scopeKind: 'company', scopeId: companyId, stateKey: 'slack' });
export const SLACK_CONFIG_PATH = 'slack.webhook';
const iso = ms => new Date(ms).toISOString();

// 送りの記録の表への読み書き（SQL はここだけ・どれも会社で絞る・S4）
export function slackStore(db) {
  const tb = `${db.namespace}.sends`, nt = `${db.namespace}.notices`;
  return {
    // 選んだ種類で、ON にした時刻より後にできた、記録の無い知らせを待ちに足す（OFF の間にできた物は ON の時刻より前なので足さない・S2）
    enqueue: (companyId, kinds, sinceIso) => db.execute(`INSERT INTO ${tb} (company_id, notice_key, status, attempts, next_at) SELECT n.company_id, n.key, 'pending', 0, n.created_at FROM ${nt} n WHERE n.company_id = $1 AND n.kind = ANY(string_to_array($2, ',')) AND n.created_at >= $3::timestamptz ON CONFLICT (company_id, notice_key) DO NOTHING`, [companyId, kinds.join(','), sinceIso]),
    // 元の知らせが消えた待ち（承認が決まった等）は送らない
    dropOrphans: companyId => db.execute(`DELETE FROM ${tb} s WHERE s.company_id = $1 AND s.status = 'pending' AND NOT EXISTS (SELECT 1 FROM ${nt} n WHERE n.company_id = s.company_id AND n.key = s.notice_key)`, [companyId]),
    due: (companyId, nowIso, limit = 50) => db.query(`SELECT s.notice_key AS "key", s.attempts, n.kind, n.title, n.origin_id AS "originId", n.created_at AS "createdAt" FROM ${tb} s JOIN ${nt} n ON n.company_id = s.company_id AND n.key = s.notice_key WHERE s.company_id = $1 AND s.status = 'pending' AND s.next_at <= $2::timestamptz ORDER BY n.created_at, s.notice_key LIMIT ${Number(limit)}`, [companyId, nowIso]),
    pendingCount: async companyId => Number((await db.query(`SELECT count(*)::int AS n FROM ${tb} WHERE company_id = $1 AND status = 'pending'`, [companyId]))[0]?.n || 0),
    markSent: (companyId, key, nowIso) => db.execute(`UPDATE ${tb} SET status = 'sent', sent_at = $3::timestamptz, last_code = 'ok' WHERE company_id = $1 AND notice_key = $2`, [companyId, key, nowIso]),
    markRetry: (companyId, key, attempts, nextIso, code) => db.execute(`UPDATE ${tb} SET attempts = $3, next_at = $4::timestamptz, last_code = $5 WHERE company_id = $1 AND notice_key = $2`, [companyId, key, attempts, nextIso, code]),
    markDone: (companyId, key, status, code) => db.execute(`UPDATE ${tb} SET status = $3, last_code = $4 WHERE company_id = $1 AND notice_key = $2`, [companyId, key, status, code]),
    // 送れないまま 24 時間たった待ちを捨てる（数を返す・S6）
    giveUp: async (companyId, cutoffIso) => Number((await db.execute(`UPDATE ${tb} s SET status = 'gave_up' FROM ${nt} n WHERE s.company_id = $1 AND s.status = 'pending' AND n.company_id = s.company_id AND n.key = s.notice_key AND n.created_at < $2::timestamptz`, [companyId, cutoffIso]))?.rowCount || 0),
    // OFF にした時、送っていない物の行を消す（S2）
    clearPending: companyId => db.execute(`DELETE FROM ${tb} WHERE company_id = $1 AND status = 'pending'`, [companyId]),
  };
}

// 会社の Slack の state の書き込みは、全部この process の中の 1 本の鍵（会社ごとの promise の鎖）を通す（実装 r1 の 1）。
// 本体の SDK は口の要求を並べて走らせるので、get → set の間に別の口の書き込みが入りうる。鍵の中で読み直してから書けば、
// OFF の後に送りの途中の古い値で ON に戻すことは無い。state.set を呼ぶのは patchIn の 1 か所だけ（lint の試験が数える）
const SLACK_LOCK = keyedChain();
const locked = (companyId, fn) => SLACK_LOCK(String(companyId), fn);
// 鍵の中だけで呼ぶ（鍵を取らない）
async function patchIn(deps, companyId, fn) {
  const cur = (await deps.state.get(SLACK(companyId))) || { on: false };
  const next = { ...cur }; fn(next);
  await deps.state.set(SLACK(companyId), next);
  return next;
}
const patch = (deps, companyId, fn) => locked(companyId, () => patchIn(deps, companyId, fn));
// ON にした時の印（onAt）が同じ間だけ「同じ ON」とみなす。途中で OFF → ON されたら、前の ON の時に読んだ物は送らない（実装 r1 の 2）
const sameOn = (st, onAt) => !!st?.on && st.onAt === onAt;
async function turnOff(deps, companyId, reason, code = null, newFp = null) {
  const at = iso(deps.now());
  await locked(companyId, async () => {
    await patchIn(deps, companyId, s => { s.on = false; s.offAt = at; s.offReason = reason; s.offCode = code; s.failStreak = 0; s.rateUntil = null; s.rateSince = null; });
    await deps.slack.clearPending(companyId); // OFF と待ちの片付けの間に、送りの口が待ちを足さない
  });
  // 宛先が使えない・宛先が変わった時は受信箱にも 1 件（Slack へは送らない・S6）
  if (reason === 'dead' || reason === 'dest_changed') {
    const lang = (await deps.state.get(SLACK(companyId)))?.lang;
    // 持ち主が自分で保存し直した宛先（起動係の覚えた指紋と同じ）への変化なら、失敗ではなく「見本を見て ON にし直す」の案内（実装 r3 の P3-3）
    if (reason === 'dest_changed' && newFp && await isSavedDest(deps, companyId, newFp)) {
      await deps.notices.addNotice(companyId, { key: noticeKey('slack_resaved', at), kind: 'slack_resaved', originId: at, title: t(lang, 'slack_resaved_title') });
      return;
    }
    const title = `${t(lang, 'slack_failed_title')}${code ? ` (${code})` : ''}`;
    await deps.notices.addNotice(companyId, { key: noticeKey('slack_failed', at), kind: 'slack_failed', originId: at, title });
  }
}
// 起動係に「この指紋は持ち主が保存した宛先か」を聞く（答えは真偽だけ）。聞けない時は false（失敗の知らせのまま）
async function isSavedDest(deps, companyId, fp) {
  if (typeof deps.savedDest !== 'function') return false;
  try { return (await deps.savedDest({ companyId, fp })) === true; } catch { return false; }
}

// 宛先を 1 回だけ引く。比べる指紋と送る URL はこの同じ 1 回の値から作る（S2・r3 の 3）。参照が無い・形が違う時は null。
// 設定の読み出し・秘密を引く口の失敗（1 分 30 回の上限を含む）は一時の失敗として { transient } を返し、宛先が変わったとはみなさない（実装 r3 の P3-2）
const DEST_UNAVAILABLE = 'dest_unavailable';
async function resolveDest(deps, companyId) {
  let cfg;
  try { cfg = (await deps.config.get(companyId)) || {}; } catch { return { transient: DEST_UNAVAILABLE }; }
  const ref = cfg?.slack?.webhook;
  if (!ref || typeof ref !== 'object' || ref.type !== 'secret_ref') return null;
  let url;
  try { url = await deps.secrets.resolve(ref, { companyId }); } catch { return { transient: DEST_UNAVAILABLE }; } // 参照は 1 つだけなので configPath は渡さない
  if (!slackUrlOk(url)) return null; // 形の合わない値は本体の http.fetch に渡さない（本体が URL の全文をログに書く・S3）
  return { url, fp: destFingerprint(url) };
}
// 一時の失敗は欄の「最後の失敗」と続けての失敗の数にだけ残す（同じ ON の間だけ）
async function noteTransient(deps, companyId, onAt, at, code) {
  await locked(companyId, async () => {
    if (sameOn(await deps.state.get(SLACK(companyId)), onAt)) await patchIn(deps, companyId, s => { s.failStreak = (s.failStreak || 0) + 1; s.lastFail = { at, status: null, code }; });
  });
}

// 外へ送る所は、ここの 1 か所だけ（S2）。返り値は classifySlack の形か { skipped }。onAt は呼ぶ側が読んだ ON の印（途中で OFF → ON されたら送らない）
export async function postSlack(deps, companyId, dest, body, onAt) {
  const st = await deps.state.get(SLACK(companyId)); // 覚えた値を使わず毎回読み直す
  if (!sameOn(st, onAt)) return { skipped: 'off' };
  if (dest?.transient) return { skipped: dest.transient }; // 一時の失敗は OFF にしない
  if (!dest || dest.fp !== st.fp || !slackUrlOk(dest.url)) { await turnOff(deps, companyId, 'dest_changed', null, dest?.fp); return { skipped: 'dest_changed' }; }
  let timer;
  try {
    const wait = new Promise((_, rej) => { timer = setTimeout(() => rej(Object.assign(new Error('slack wait'), { code: 'slack_timeout' })), L.waitMs); });
    const res = await Promise.race([deps.http.fetch(dest.url, { method: 'POST', headers: { 'content-type': 'application/json' }, body }), wait]);
    const text = await res.text().catch(() => '');
    const headers = {}; try { res.headers?.forEach?.((v, k) => { headers[String(k).toLowerCase()] = v; }); } catch { /* 無い */ }
    return classifySlack({ status: res.status, body: text, headers });
  } catch (e) {
    return { action: 'retry', code: errorCode(e) };
  } finally { clearTimeout(timer); }
}

// 状態（URL は入れない）
export async function slackStatus(deps, companyId) {
  const st = (await deps.state.get(SLACK(companyId))) || {};
  const cfg = (await deps.config.get(companyId).catch(() => null)) || {};
  const nowMs = deps.now();
  return {
    v: 1, on: !!st.on, configured: !!(cfg?.slack?.webhook && cfg.slack.webhook.type === 'secret_ref'),
    kinds: st.kinds || [...SLACK_DEFAULTS.kinds], form: st.form || SLACK_DEFAULTS.form, onAt: st.onAt || null, offAt: st.offAt || null, offReason: st.offReason || null, offCode: st.offCode || null,
    lastOkAt: st.lastOkAt || null, lastFail: st.lastFail || null, lastDrop: st.lastDrop || null, dropped: st.dropped || 0, failStreak: st.failStreak || 0,
    rateLimited: !!(st.rateSince && nowMs - Date.parse(st.rateSince) >= L.rateWarnMs), waiting: await deps.slack.pendingCount(companyId),
    lastTest: st.lastTest || null, choices: [...SLACK_CHOICES], forms: [...SLACK_FORMS], defaults: { kinds: [...SLACK_DEFAULTS.kinds], form: SLACK_DEFAULTS.form },
  };
}

const q1 = v => (Array.isArray(v) ? v[0] : v);
// 見本（起動係が言語と office の URL を足して呼ぶ）。今の会社の知らせから、送る時と同じ関数で作る（S5）
export async function slackPreview(deps, companyId, query) {
  const choice = checkChoice({ kinds: q1(query?.kinds), form: q1(query?.form) });
  const lang = q1(query?.lang), officeUrl = q1(query?.officeUrl);
  if (!choice || !LANGS.includes(lang) || !officeUrlOk(officeUrl)) return { status: 400, body: { error: 'slack_bad_choice' } };
  const dest = await resolveDest(deps, companyId);
  if (dest?.transient) return { status: 503, body: { error: 'slack_dest_unavailable' } };
  if (!dest) return { status: 409, body: { error: 'slack_no_dest' } };
  const notices = await deps.notices.listNotices(companyId);
  return { status: 200, body: { v: 1, hash: previewHash({ fp: dest.fp, ...choice, lang, officeUrl }), messages: previewOf({ ...choice, lang, officeUrl, notices }) } };
}

// ON にする口（S1）。nonce を起動係の照合の口に照らし、指紋と hash が合う時だけ ON
export async function slackConfirm(deps, companyId, body) {
  const b = body && typeof body === 'object' ? body : {};
  if (typeof b.nonce !== 'string' || !/^[0-9a-f]{64}$/.test(b.nonce)) return { status: 403, body: { error: 'slack_not_owner' } };
  const choice = checkChoice(b);
  if (!choice || !LANGS.includes(b.lang) || !officeUrlOk(b.officeUrl) || typeof b.previewHash !== 'string' || !/^[0-9a-f]{32}$/.test(b.previewHash)) return { status: 400, body: { error: 'slack_bad_choice' } };
  let v = null;
  try { v = await deps.verifyNonce({ nonce: b.nonce, companyId, previewHash: b.previewHash }); } catch { v = null; }
  if (!v?.ok || typeof v.fp !== 'string' || !/^[0-9a-f]{16}$/.test(v.fp)) return { status: 403, body: { error: 'slack_not_owner' } };
  const dest = await resolveDest(deps, companyId);
  if (dest?.transient) return { status: 503, body: { error: 'slack_dest_unavailable' } };
  if (!dest) return { status: 409, body: { error: 'slack_no_dest' } };
  if (dest.fp !== v.fp) { await patch(deps, companyId, s => { s.offReason = 'dest_changed'; }); return { status: 409, body: { error: 'slack_dest_changed' } }; }
  const hash = previewHash({ fp: dest.fp, ...choice, lang: b.lang, officeUrl: b.officeUrl });
  if (hash !== b.previewHash) return { status: 409, body: { error: 'slack_preview_stale' } };
  const at = iso(deps.now());
  // ON の写しの書き替えと、前の ON の送り残しの片付けは同じ鍵の中で（ON のまま種類を外しても、外した種類の待ちを残さない・実装 r3 の 1。送る直前の関門と二重の守り）
  await locked(companyId, async () => {
    await patchIn(deps, companyId, s => { Object.assign(s, { on: true, fp: dest.fp, kinds: choice.kinds, form: choice.form, lang: b.lang, officeUrl: b.officeUrl, hash, onAt: at, offAt: null, offReason: null, offCode: null, failStreak: 0, rateUntil: null, rateSince: null, overflow: 0 }); });
    await deps.slack.clearPending(companyId);
  });
  return { status: 200, body: { v: 1, on: true, onAt: at } };
}

// OFF は nonce なしで通す（送らない側にしか動かない・S1）
export async function slackOff(deps, companyId) {
  await turnOff(deps, companyId, 'owner');
  return { status: 200, body: { v: 1, on: false } };
}

// 試しの 1 通（S7）: ON の時だけ・1 分に 1 回・会社の中身を含まない決まった文
export async function slackTest(deps, companyId) {
  const nowMs = deps.now();
  // 1 分に 1 回の判定と「送っている」の印は、鍵の中で読み直して一度に（2 つの要求が同時に来ても 1 通だけ）
  const pre = await locked(companyId, async () => {
    const s0 = await deps.state.get(SLACK(companyId));
    if (!s0?.on) return { status: 409, body: { error: 'slack_off' } };
    if (s0.lastTest?.at && nowMs - Date.parse(s0.lastTest.at) < L.testEveryMs) return { status: 429, body: { error: 'slack_test_wait' } };
    return { st: await patchIn(deps, companyId, s => { s.lastTest = { at: iso(nowMs), result: 'sending' }; }) };
  });
  if (!pre.st) return pre;
  const { st } = pre;
  const dest = await resolveDest(deps, companyId); // 一時の失敗なら postSlack が送らずに印を返す（OFF にしない）
  const r = await postSlack(deps, companyId, dest, slackBody(slackMessage({ type: 'test', lang: st.lang }, st.officeUrl)), st.onAt);
  const result = r.skipped ? r.skipped : r.action === 'sent' ? 'ok' : r.code;
  await patch(deps, companyId, s => { s.lastTest = { at: iso(nowMs), result }; if (r.action === 'sent') { s.lastOkAt = iso(deps.now()); s.failStreak = 0; } });
  if (r.action === 'dead') await turnOff(deps, companyId, 'dead', r.code);
  return { status: 200, body: { v: 1, result } };
}

// 送る直前の関門。待ちの行を今の ON の写し（st）と照らす: 種類が写しの種類に入る・知らせが ON の時刻より後にできた・言語と形が写しの物。
// 文は写しの言語・形・office の URL からだけ作る。合わない時は { skip: 理由 }（sent にしない）。まとめて数えた分（overflow）は今の ON の state の数なので、照らすのは言語と形だけ
export function admit(st, item, notices = []) {
  if (!LANGS.includes(st?.lang) || !SLACK_FORMS.includes(st?.form) || !officeUrlOk(st?.officeUrl)) return { skip: 'copy_bad' };
  if (item.overflow) return { body: slackBody(slackMessage({ type: 'overflow', lang: st.lang, count: item.overflow }, st.officeUrl)) };
  if (!noticeKindsOf(st.kinds || []).includes(item.kind)) return { skip: 'kind_off' };
  const made = new Date(item.createdAt).getTime(), onAt = Date.parse(st.onAt); // 表の時刻は Date で来る（文字にすると ms が落ちる）
  if (!Number.isFinite(made) || !Number.isFinite(onAt) || made < onAt) return { skip: 'before_on' };
  return { body: slackBody(slackMessage(messageFor(item, { lang: st.lang, form: st.form, notices }), st.officeUrl)) };
}

// 送りの口（S8）。起動係が見回りの口の後に呼ぶ。OFF の時は秘密も引かずに { off: true }
export async function slackDeliver(deps, companyId) {
  const r = await deps.slackFlight.run(async () => {
    const st0 = await deps.state.get(SLACK(companyId));
    if (!st0?.on) return { v: 1, off: true };
    const budget = makeBudget(deps.now, L.budgetMs);
    const nowMs = deps.now();
    const dest = await resolveDest(deps, companyId); // この回の宛先は 1 回だけ引く
    if (dest?.transient) { // 一時の失敗: この回は送らず、待ちに残す（OFF にしない）
      await noteTransient(deps, companyId, st0.onAt, iso(nowMs), dest.transient);
      return { v: 1, sent: 0, attempted: 0, rateLimited: false, last: dest.transient, waiting: await deps.slack.pendingCount(companyId) };
    }
    if (!dest || dest.fp !== st0.fp) { await turnOff(deps, companyId, 'dest_changed', null, dest?.fp); return { v: 1, off: true, reason: 'dest_changed' }; }
    // 待ちを足すのは鍵の中で、同じ ON の間だけ（OFF の片付けの後に、古い ON の時刻で待ちを足し直さない・実装 r1 の 1）
    let st = await locked(companyId, async () => {
      if (!sameOn(await deps.state.get(SLACK(companyId)), st0.onAt)) return null;
      await deps.slack.dropOrphans(companyId);
      await deps.slack.enqueue(companyId, noticeKindsOf(st0.kinds || []), st0.onAt);
      const gaveUp = await deps.slack.giveUp(companyId, iso(nowMs - L.giveUpMs));
      return patchIn(deps, companyId, s => {
        s.dropped = (s.dropped || 0) + gaveUp;
        if (!s.hour || nowMs - s.hour.start >= 3600_000) s.hour = { start: nowMs, n: 0 };
      });
    });
    if (!st) return { v: 1, off: true };
    const out = { v: 1, sent: 0, attempted: 0, rateLimited: false, last: null };
    if (st.rateUntil && nowMs < st.rateUntil) { out.rateLimited = true; out.waiting = await deps.slack.pendingCount(companyId); return out; }
    const rows = await deps.slack.due(companyId, iso(nowMs));
    const queue = [...(st.overflow > 0 ? [{ overflow: st.overflow }] : []), ...rows];
    const notices = queue.some(x => x.kind === 'digest') ? await deps.notices.listNotices(companyId) : [];
    for (const item of queue) {
      if (out.attempted >= L.perCall || budget.left() < L.minLeftMs) break;
      const immediate = !!item.overflow || item.kind !== 'digest';
      st = (await deps.state.get(SLACK(companyId))) || {};
      if (!sameOn(st, st0.onAt)) break; // OFF のままでも、OFF → ON し直した後でも、この回に読んだ物は送らない
      // すぐの知らせは会社ごとに 1 時間 20 通まで。超えた分は次の回に 1 通にまとめる（S8）
      if (immediate && !item.overflow && (st.hour?.n || 0) >= L.perHour) { await deps.slack.markDone(companyId, item.key, 'overflow', null); await patch(deps, companyId, s => { s.overflow = (s.overflow || 0) + 1; }); continue; }
      if (item.overflow && (st.hour?.n || 0) >= L.perHour) continue;
      // 送る直前の関門（1 か所）: 今読んだ ON の写しと照らし、合わない行は送らずに片付ける（実装 r3 の 1）
      const gate = admit(st, item, notices);
      if (gate.skip) { if (!item.overflow) await deps.slack.markDone(companyId, item.key, 'skipped', gate.skip); continue; }
      if (out.attempted > 0) await deps.sleep(L.gapMs);
      const res = await postSlack(deps, companyId, dest, gate.body, st0.onAt);
      if (res.skipped) { out.last = res.skipped; break; }
      out.attempted++; out.last = res.code;
      const at = iso(deps.now());
      if (res.action === 'sent') {
        out.sent++;
        if (!item.overflow) await deps.slack.markSent(companyId, item.key, at);
        await patch(deps, companyId, s => { s.lastOkAt = at; s.failStreak = 0; s.rateSince = null; s.rateUntil = null; if (immediate) s.hour = { ...(s.hour || { start: nowMs, n: 0 }), n: (s.hour?.n || 0) + 1 }; if (item.overflow) s.overflow = 0; });
      } else if (res.action === 'rate') {
        await patch(deps, companyId, s => { s.rateUntil = deps.now() + res.waitMs; s.rateSince ??= at; s.lastFail = { at, status: res.status, code: res.code }; });
        out.rateLimited = true; break;
      } else if (res.action === 'drop') {
        if (!item.overflow) await deps.slack.markDone(companyId, item.key, 'dropped', res.code); else await patch(deps, companyId, s => { s.overflow = 0; });
        await patch(deps, companyId, s => { s.lastDrop = { at, code: res.code }; s.lastFail = { at, status: res.status, code: res.code }; });
      } else if (res.action === 'dead') {
        await patch(deps, companyId, s => { s.lastFail = { at, status: res.status ?? null, code: res.code }; });
        await turnOff(deps, companyId, 'dead', res.code); break;
      } else {
        const attempts = (item.attempts || 0) + 1;
        if (!item.overflow) await deps.slack.markRetry(companyId, item.key, attempts, iso(nextAttempt(attempts, deps.now())), res.code);
        await patch(deps, companyId, s => { s.failStreak = (s.failStreak || 0) + 1; s.lastFail = { at, status: res.status ?? null, code: res.code }; }); // 網の失敗・待ち超えは status なし
        break; // 送り先が答えない間は、この回の残りを送らない
      }
    }
    out.waiting = await deps.slack.pendingCount(companyId);
    return out;
  });
  if (r.busy) return { status: 409, body: { error: 'notify_busy' } };
  return { status: 200, body: r.value };
}

// 起動係の照合の口（loopback）。行き先は plugin の設定から読まない（S1）。
// 本体は worker に env をほとんど渡さない（本体: server/dist/services/plugin-worker-manager.js:1926-1943）ので、起動係の port は package の決まり（3100）を既定にする
export const LAUNCHER_PORT_DEFAULT = 3100;
export function nonceUrl(env = {}) {
  const p = Number(env.AIOFFICE_LAUNCHER_PORT);
  return `http://127.0.0.1:${Number.isInteger(p) && p > 0 && p < 65536 ? p : LAUNCHER_PORT_DEFAULT}/setup/internal/slack-nonce`;
}
// 「この指紋は持ち主が保存した宛先か」を聞く口（同じ起動係・loopback）。答えは真偽だけ
export const savedUrl = (env = {}) => nonceUrl(env).replace(/slack-nonce$/, 'slack-saved');
// Node の fetch を直に呼ぶのはここだけ（本体の http.fetch は 127/8 を断るため・lint の例外はこの 1 か所）
export async function askLauncher(url, payload) {
  const r = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(payload), signal: AbortSignal.timeout(5000) });
  return { ok: r.ok, j: await r.json().catch(() => null) };
}
export function createVerifyNonce(url) {
  return async ({ nonce, companyId, previewHash: ph }) => {
    const { ok, j } = await askLauncher(url, { nonce, companyId, previewHash: ph });
    return ok && j?.ok === true ? { ok: true, fp: j.fp } : { ok: false };
  };
}
export function createSavedDest(url) {
  return async ({ companyId, fp }) => {
    const { ok, j } = await askLauncher(url, { companyId, fp });
    return ok && j?.ok === true && j.same === true;
  };
}
