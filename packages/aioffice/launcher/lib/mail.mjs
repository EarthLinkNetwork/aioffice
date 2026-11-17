// メールで届ける係（起動係の中）。範囲 docs/review/2026-11-19-mail-notify-scope.md の r2「送る形」・M1〜M10 の置き換えと r3 の 1〜13
// - ON・OFF・宛先・アプリ パスワードの正は起動係の state（mail[会社 id]）。本体の秘密の保管庫にも plugin の設定にも置かない
// - 送るのは見回りの中だけ（外から「送れ」と頼む口は無い）。notify の mail/pending で文を取り、確かめ直してから送り、mail/result を返す
// - 接続を開くのは smtp.mjs の sendGmail の 1 か所だけ。呼ぶ直前に state を読み直し、OFF・未保存・hash 違いなら接続を開かない（M2）
import {
  MAIL_FORMAT_VERSION, MAIL_CHOICES, MAIL_FORMS, MAIL_DEFAULTS, MAIL_BODY_LIMITS, mailAddrOk, mailPassOk, normalizeMailPass, maskAddr, mailFingerprint, mailPreviewHash,
  checkMailChoice, checkMailMessageStrict, mailKindsOf, officeUrlOk, utcDay, nextUtcMidnight,
} from './mail-core.mjs';
import { sendGmail, classifySmtp, messageIdFor } from './smtp.mjs';

// 枠（M8）: 1 回の見回りで会社ごとに 3 通・すぐの知らせは 1 時間 20 通・どれも 1 日 50 通。メールの全体は 1 回の見回りで 60 秒
export const MAIL_LIMITS = Object.freeze({ perCall: 3, perHour: 20, perDay: 50, budgetMs: 60_000, minLeftMs: 10_000, testEveryMs: 60_000, notifyMs: 15_000 });
const ID_RE = /^(?:[0-9a-f]{32}|overflow:\d{1,9}|test:\d{1,16})$/;
const CODE_RE = /^[a-z_0-9]{1,40}$/;
const iso = ms => new Date(ms).toISOString();

// store: lib/state.mjs の openStore。notifyRoute: paperclip.mjs の notifyRoute。companyOk: 会社が本体にあるか
export function createMailer({ store, notifyRoute, companyOk = async () => true, now = () => Date.now(), send = sendGmail, sendSeam = {}, log = () => {} }) {
  const mailOf = cid => store.get().mail?.[cid] || null;
  const upd = (cid, fn) => store.update(x => { const m = { ...(x.mail || {}) }; const cur = { ...(m[cid] || {}) }; fn(cur); m[cid] = cur; x.mail = m; });
  const busy = new Set();
  const inflightOf = st => (st?.inflight && typeof st.inflight === 'object' ? st.inflight : {});
  const dropKey = (o, k) => { const { [k]: _gone, ...rest } = o && typeof o === 'object' ? o : {}; return rest; };
  const pruneInflight = o => Object.fromEntries(Object.entries(inflightOf({ inflight: o })).slice(-19)); // 表は 20 行まで

  // 送ってよい state か（r2 の M2・r3 の 12）。返り値は理由の印。null なら通す
  function gate(st) {
    if (!st?.on) return 'off';
    if (!mailAddrOk(st.addr) || !mailPassOk(st.pw)) return 'no_secret';
    if (st.fp !== mailFingerprint({ addr: st.addr, pw: st.pw })) return 'fp';
    if (!Number.isFinite(Date.parse(st.onAt))) return 'no_on_at';
    if (!checkMailChoice({ kinds: st.kinds, form: st.form }) || !['en', 'ja'].includes(st.lang)) return 'choice';
    if (st.hash !== mailPreviewHash({ fp: st.fp, kinds: st.kinds, form: st.form, lang: st.lang, officeUrl: st.officeUrl })) return 'format'; // 文の形の版が上がった・写しが変わった
    return null;
  }
  const dayCount = (st, ms) => (st.day?.date === utcDay(ms) ? st.day.n : 0);
  const hourCount = (st, ms) => (st.hour && ms - st.hour.start < 3600_000 ? st.hour.n : 0);
  const countSent = (cid, immediate) => upd(cid, s => {
    const ms = now();
    s.day = { date: utcDay(ms), n: dayCount(s, ms) + 1 };
    if (immediate) s.hour = { start: s.hour && ms - s.hour.start < 3600_000 ? s.hour.start : ms, n: hourCount(s, ms) + 1 };
  });
  const turnOff = (cid, reason, code = null) => upd(cid, s => { s.on = false; s.offAt = iso(now()); s.offReason = reason; s.offCode = code; s.inflight = null; });

  // notify への結果。届かなかった結果は state に残し、次の見回りの最初に出し直す（送った印を返す前に止まっても二重に送らない手当て）
  // notify を呼ぶ待ちの上限（15 秒）。呼べないまま見回りを塞がない
  async function callNotify(...args) {
    let t;
    try { return await Promise.race([notifyRoute(...args), new Promise((_, rej) => { t = setTimeout(() => rej(Object.assign(new Error('notify_timeout'), { tag: 'timeout' })), MAIL_LIMITS.notifyMs); })]); }
    finally { clearTimeout(t); }
  }
  async function postResult(cid, body, { keep = true } = {}) {
    try { await callNotify('POST', 'mail/result', cid, { body }); return true; }
    catch (e) {
      // 400 番台は何度送っても通らない（形が合わない・知らない行）。残さず捨てて印だけログに書く（会社が止まり続けない）
      if (Number.isInteger(e?.status) && e.status >= 400 && e.status < 500) { log(`aioffice: mail result dropped ${e.status}`); return true; }
      if (keep) upd(cid, s => { s.unreported = [...(s.unreported || []), body].slice(-20); });
      return false;
    }
  }
  async function flushUnreported(cid, deadlineAt = Infinity) {
    const list = mailOf(cid)?.unreported || [];
    if (!list.length) return;
    const left = [];
    for (let i = 0; i < list.length; i++) {
      if (deadlineAt - now() < MAIL_LIMITS.minLeftMs) { left.push(...list.slice(i)); break; } // 時間が切れたら残りは次の回へ
      if (!(await postResult(cid, list[i], { keep: false }))) left.push(list[i]);
    }
    upd(cid, s => { s.unreported = left; });
  }

  // 行を確かめ直す（r3 の 1）。理由の印か null
  function checkRow(row, st) {
    if (!row || typeof row !== 'object' || typeof row.id !== 'string' || !ID_RE.test(row.id) || typeof row.kind !== 'string') return 'shape';
    const bad = checkMailMessageStrict(row, { lang: st.lang, officeUrl: st.officeUrl }); // HTML は text から作り直した物と同じ時だけ通す
    if (bad) return bad;
    if (row.kind !== 'overflow') {
      if (!mailKindsOf(st.kinds).includes(row.kind)) return 'kind';
      const made = Date.parse(row.createdAt);
      if (!Number.isFinite(made) || made < Date.parse(st.onAt)) return 'before_on'; // まとめの 1 通も回の時刻で判定する（r3 の 2）
    }
    return null;
  }

  // 1 通を送り、結果の扱いまでを行う。{ stop, sent } を返す
  async function deliver(cid, st, row, { isTest = false } = {}) {
    // 「送り中」の記録は id ごとの表（別の行の送りで上書きされず、1 行ごとに再送は 1 回までが効く）
    const prior = inflightOf(st)[row.id]?.n || 0;
    if (prior >= 2) { // 送りかけで 2 回落ちた物。これ以上は送らない（「送ったかもしれない」として閉じる）
      upd(cid, s => { s.inflight = dropKey(s.inflight, row.id); });
      await postResult(cid, { id: row.id, result: 'sent', code: 'maybe' });
      return { stop: false, sent: false };
    }
    const res = await send({
      addr: st.addr, pw: st.pw, subject: row.subject, text: row.text, html: row.html, messageId: messageIdFor(cid, row.id),
      before: async () => { // DATA の前: 接続の間に OFF・保存し直し・ON のし直しがあれば止める。通れば「送り中」を書く（r3 の 10）
        const cur = mailOf(cid);
        if (cur?.onAt !== st.onAt || gate(cur)) throw Object.assign(new Error('off'), { tag: 'off' });
        upd(cid, s => { s.inflight = { ...pruneInflight(s.inflight), [row.id]: { n: prior + 1, at: iso(now()) } }; });
      },
    }, sendSeam);
    if (res.tag === 'off') return { stop: true, sent: false, off: true }; // DATA の前に止めた（送っていない・失敗にも数えない）
    const c = classifySmtp(res);
    const at = iso(now());
    const keepInflight = c.action === 'retry' && (res.stage === 'data_end' || res.stage === 'data_body') && res.code == null; // DATA の後に答えが無い: 届いたかもしれない
    if (!keepInflight) upd(cid, s => { s.inflight = dropKey(s.inflight, row.id); });
    const report = body => (isTest ? true : postResult(cid, { id: row.id, ...body }));
    if (c.action === 'sent') {
      countSent(cid, !isTest && row.kind !== 'digest' && row.kind !== 'overflow');
      upd(cid, s => { s.lastOkAt = at; s.failStreak = 0; });
      await report({ result: 'sent', code: 'ok' });
      return { stop: false, sent: true, c };
    }
    const fail = { at, code: c.tag, ext: c.ext ?? null, status: c.code ?? null };
    log(`aioffice: mail ${isTest ? 'test ' : ''}${c.action} ${c.tag}${c.code ? ` ${c.code}` : ''}${c.ext ? ` ${c.ext}` : ''}`); // 答えの本文は書かない（M3）
    if (c.action === 'dead') { upd(cid, s => { s.lastFail = fail; }); turnOff(cid, 'dead', c.tag); await report({ result: 'dead', code: c.tag, ext: c.ext ?? undefined }); return { stop: true, sent: false, c }; }
    if (c.action === 'drop') { upd(cid, s => { s.lastFail = fail; s.lastDrop = { at, code: c.tag }; }); await report({ result: 'drop', code: c.tag, ext: c.ext ?? undefined }); return { stop: false, sent: false, c }; }
    if (c.action === 'day') { upd(cid, s => { s.lastFail = fail; s.dayBlockedUntil = nextUtcMidnight(now()); }); await report({ result: 'hold', code: 'day_limit', ext: c.ext ?? undefined }); return { stop: true, sent: false, c }; }
    upd(cid, s => { s.lastFail = fail; s.failStreak = (s.failStreak || 0) + 1; });
    await report({ result: 'retry', code: CODE_RE.test(c.tag) ? c.tag : 'unknown', ext: c.ext ?? undefined });
    return { stop: true, sent: false, c };
  }

  async function roundOne(cid, deadlineAt) {
    const st0 = mailOf(cid);
    if (!st0?.on) return { off: true };
    if (busy.has(cid)) return { busy: true };
    busy.add(cid);
    try {
      const why = gate(st0);
      if (why) return { skip: why };
      if (st0.dayBlockedUntil && now() < st0.dayBlockedUntil) return { skip: 'day_limit' };
      if (dayCount(st0, now()) >= MAIL_LIMITS.perDay) return { skip: 'day_full' };
      await flushUnreported(cid, deadlineAt);
      if (deadlineAt - now() < MAIL_LIMITS.minLeftMs) return { skip: 'deadline' };
      if (mailOf(cid)?.unreported?.length) return { skip: 'unreported' }; // 前の回の結果を返せないうちは、同じ行をもう一度取って送らない
      let r;
      try { r = await callNotify('GET', 'mail/pending', cid, { query: { onAt: st0.onAt, kinds: st0.kinds.join(','), form: st0.form, lang: st0.lang, officeUrl: st0.officeUrl, limit: String(MAIL_LIMITS.perCall) } }); }
      catch { return { skip: 'notify_unreachable' }; }
      if (!r || r.formatVersion !== MAIL_FORMAT_VERSION || !Array.isArray(r.rows)) return { skip: 'notify_bad_answer' };
      const out = { sent: 0, skippedBad: 0 };
      for (const row of r.rows.slice(0, MAIL_LIMITS.perCall)) {
        if (deadlineAt - now() < MAIL_LIMITS.minLeftMs) break;
        const cur = mailOf(cid); // 送る直前に読み直す（M2）
        if (cur?.onAt !== st0.onAt || gate(cur)) break;
        if (cur.dayBlockedUntil && now() < cur.dayBlockedUntil) break;
        if (dayCount(cur, now()) >= MAIL_LIMITS.perDay) break;
        const bad = checkRow(row, cur);
        if (bad) { // 合わない物は送らずに数える（帯に「送らなかった文があります」）
          upd(cid, s => { s.badCount = (s.badCount || 0) + 1; s.lastBad = { at: iso(now()), why: bad }; });
          if (typeof row?.id === 'string' && ID_RE.test(row.id)) await postResult(cid, { id: row.id, result: 'bad', code: 'bad_mail' });
          out.skippedBad++; continue;
        }
        const immediate = row.kind !== 'digest' && row.kind !== 'overflow';
        if (row.kind !== 'digest' && hourCount(cur, now()) >= MAIL_LIMITS.perHour) { // 1 時間の上限（朝夕のまとめは数えない）: すぐの知らせは notify が次の回に 1 通にまとめる
          if (immediate) await postResult(cid, { id: row.id, result: 'overflow', code: 'hour_limit' });
          continue;
        }
        const d = await deliver(cid, cur, row);
        if (d.sent) out.sent++;
        if (d.stop) break;
      }
      return out;
    } finally { busy.delete(cid); }
  }

  return {
    mailOf, gate,
    // 見回りの中から呼ぶ。companies: [{ id }]。1 回のメールの全体は 60 秒まで（次の見回りを塞がない・r3 の 9）
    async round(companies, { budgetMs = MAIL_LIMITS.budgetMs } = {}) {
      const deadlineAt = now() + budgetMs, out = {};
      for (const c of companies) {
        if (deadlineAt - now() < MAIL_LIMITS.minLeftMs) break;
        try { out[c.id] = await roundOne(c.id, deadlineAt); } catch { out[c.id] = { error: 'failed' }; }
      }
      return out;
    },
    // ---- 画面からの口（cookie を確かめた後に server.mjs が呼ぶ） ----
    async save(cid, b) {
      const addr = typeof b?.addr === 'string' ? b.addr.trim() : '';
      const pw = normalizeMailPass(b?.pw);
      if (!mailAddrOk(addr)) return [400, { error: 'mail_addr_bad' }];
      if (!mailPassOk(pw)) return [400, { error: 'mail_pass_bad' }];
      if (!(await companyOk(cid))) return [404, { error: 'company_unknown' }];
      const had = mailOf(cid);
      // 保存し直したら OFF（アドレスかアプリ パスワードが替わると指紋が替わる・r3 の 12）。送り中の記録・止めた印・数えは前の物なので持ち越さない
      upd(cid, s => { for (const k of Object.keys(s)) delete s[k]; Object.assign(s, { addr, pw, fp: mailFingerprint({ addr, pw }), savedAt: iso(now()), on: false, offAt: had?.on ? iso(now()) : null, offReason: had?.on ? 'resaved' : null }); });
      return [200, { ok: true, saved: { masked: maskAddr(addr), savedAt: mailOf(cid).savedAt } }];
    },
    remove(cid) { store.update(x => { const m = { ...(x.mail || {}) }; delete m[cid]; x.mail = m; }); return [200, { ok: true, saved: null }]; },
    // 持ち主を作り直した時: メールを全部 OFF にし、アプリ パスワードを消す（r3 の 12）
    wipeAll() { store.update(x => { x.mail = {}; }); },
    // 見本: 言語と office の URL を足して notify へ。hash は起動係が作る（ON の時の照合と同じ関数）
    async preview(cid, { kinds, form, lang, officeUrl }) {
      const st = mailOf(cid);
      if (!st?.fp) return [409, { error: 'mail_no_dest' }];
      const c = checkMailChoice({ kinds, form });
      if (!c) return [400, { error: 'mail_bad_choice' }];
      let r;
      try { r = await notifyRoute('GET', 'mail/preview', cid, { query: { kinds: c.kinds.join(','), form: c.form, lang, officeUrl } }); } catch (e) { return [e?.status && e.status < 500 ? e.status : 502, { error: 'mail_failed' }]; }
      const bad = (r?.messages || []).find(m => checkMailMessageStrict(m, { lang, officeUrl }));
      if (!Array.isArray(r?.messages) || bad || r.formatVersion !== MAIL_FORMAT_VERSION) return [502, { error: 'mail_failed' }];
      return [200, { v: 1, hash: mailPreviewHash({ fp: st.fp, ...c, lang, officeUrl }), messages: r.messages.map(m => ({ kind: m.kind, subject: m.subject, text: m.text })) }];
    },
    // ON にする: 持ち主が見本を見て押した時だけ（cookie を確かめた口からだけ呼ぶ・M1）
    confirm(cid, { kinds, form, previewHash, lang, officeUrl }) {
      const st = mailOf(cid);
      if (!st?.fp || !mailAddrOk(st.addr) || !mailPassOk(st.pw)) return [409, { error: 'mail_no_dest' }];
      const c = checkMailChoice({ kinds, form });
      if (!c || !['en', 'ja'].includes(lang) || !officeUrlOk(officeUrl) || typeof previewHash !== 'string' || !/^[0-9a-f]{32}$/.test(previewHash)) return [400, { error: 'mail_bad_choice' }];
      const hash = mailPreviewHash({ fp: st.fp, ...c, lang, officeUrl });
      if (hash !== previewHash) return [409, { error: 'mail_preview_stale' }];
      const at = iso(now());
      upd(cid, s => { Object.assign(s, { on: true, onAt: at, kinds: c.kinds, form: c.form, lang, officeUrl, hash, offAt: null, offReason: null, offCode: null, failStreak: 0, dayBlockedUntil: null, inflight: null, lastFail: null, badCount: 0, lastBad: null, unreported: [] }); });
      return [200, { on: true, onAt: at }];
    },
    off(cid) { if (!mailOf(cid)) return [200, { on: false }]; upd(cid, s => { s.on = false; s.offAt = iso(now()); s.offReason = 'owner'; s.offCode = null; s.inflight = null; }); return [200, { on: false }]; },
    // 試しの 1 通（M7）: ON の時だけ・1 分に 1 回・会社の題を入れない決まった文
    async test(cid) {
      const st = mailOf(cid);
      if (!st?.on) return [409, { error: 'mail_off' }];
      if (st.lastTest?.at && now() - Date.parse(st.lastTest.at) < MAIL_LIMITS.testEveryMs) return [429, { error: 'mail_test_wait' }];
      if (busy.has(cid)) return [409, { error: 'mail_busy' }];
      const why = gate(st);
      if (why) return [409, { error: why === 'format' ? 'mail_preview_stale' : 'mail_off' }];
      if (st.dayBlockedUntil && now() < st.dayBlockedUntil) return [200, { v: 1, result: 'day_limit' }];
      if (dayCount(st, now()) >= MAIL_LIMITS.perDay) return [200, { v: 1, result: 'day_full' }];
      busy.add(cid);
      try {
        upd(cid, s => { s.lastTest = { at: iso(now()), result: 'sending' }; });
        let r;
        try { r = await notifyRoute('GET', 'mail/preview', cid, { query: { kinds: st.kinds.join(','), form: st.form, lang: st.lang, officeUrl: st.officeUrl } }); }
        catch { upd(cid, s => { s.lastTest = { at: s.lastTest.at, result: 'notify_unreachable' }; }); return [200, { v: 1, result: 'notify_unreachable' }]; }
        const msg = r?.test;
        const bad = checkMailMessageStrict(msg, { lang: st.lang, officeUrl: st.officeUrl });
        if (bad) { upd(cid, s => { s.lastTest = { at: s.lastTest.at, result: 'bad_mail' }; }); return [200, { v: 1, result: 'bad_mail' }]; }
        const cur = mailOf(cid);
        if (gate(cur) || cur.onAt !== st.onAt) return [200, { v: 1, result: 'off' }];
        const d = await deliver(cid, cur, { ...msg, id: `test:${now()}`, kind: 'test' }, { isTest: true });
        const result = d.sent ? 'ok' : d.off ? 'off' : (d.c?.tag || 'failed');
        upd(cid, s => { s.lastTest = { at: s.lastTest.at, result }; });
        return [200, { v: 1, result }];
      } finally { busy.delete(cid); }
    },
    // 画面と帯のための状態。宛先は伏せた形だけ・アプリ パスワードは返さない（M3）
    async view(cid) {
      const st = mailOf(cid) || {};
      const ms = now();
      let waiting = null;
      if (st.on) { try { waiting = Number((await notifyRoute('GET', 'mail', cid))?.waiting) || 0; } catch { waiting = null; } }
      return {
        v: 1, saved: !!st.fp, masked: maskAddr(st.addr), savedAt: st.savedAt || null, on: !!st.on,
        kinds: st.kinds || [...MAIL_DEFAULTS.kinds], form: st.form || MAIL_DEFAULTS.form, onAt: st.onAt || null, offAt: st.offAt || null, offReason: st.offReason || null, offCode: st.offCode || null,
        lastOkAt: st.lastOkAt || null, lastFail: st.lastFail ? { at: st.lastFail.at, code: st.lastFail.code, ext: st.lastFail.ext ?? null, status: st.lastFail.status ?? null } : null,
        failStreak: st.failStreak || 0, dayBlocked: !!(st.dayBlockedUntil && ms < st.dayBlockedUntil), badCount: st.badCount || 0, stale: !!st.on && gate(st) === 'format',
        sentToday: dayCount(st, ms), waiting, lastTest: st.lastTest || null,
        choices: [...MAIL_CHOICES], forms: [...MAIL_FORMS], defaults: { kinds: [...MAIL_DEFAULTS.kinds], form: MAIL_DEFAULTS.form }, limits: { subject: MAIL_BODY_LIMITS.subject },
      };
    },
  };
}
