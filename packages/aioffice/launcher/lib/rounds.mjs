// 見回りの係（開発元の記録 docs/review/2026-11-16-library-notify-scope.md の保証 7・9・20・実測 17）。
// - 5 分ごとに、本体の会社ごとに、見回りの口を持つ plugin（知らせ・図書室）の POST /tick を 1 つずつ順に呼ぶ
// - body で起動係の state の言語と時刻帯を渡す（時刻帯の正本は起動係の state。無い時は渡さない）
// - plugin ごとに最後に成功した時刻を <dataDir>/rounds.json に残し、15 分を超えたら「遅れ」とする（見張りの見張り）
// plugin の worker は会社の物を job では読めない（実測 1・16）ので、会社の付いた口を外から呼ぶ。
import fs from 'node:fs';
import path from 'node:path';

// 秘書の気づき（docs/review/2026-11-21-secretary-awareness-scope.md 作り方 4）も同じ見回りで呼ぶ（秘書の id は wizard の会社にだけ入る）
// 回覧（docs/design/2026-11-21-office-relay.md 2.1-6）も会社ごとに呼ぶ（届ける・答えを読む・戻すは、それぞれの会社の回で行う）
export const ROUND_PLUGINS = ['aioffice.notify', 'aioffice.library', 'aioffice.secretary', 'aioffice.relay'];
export const EVERY_MS = 5 * 60_000;
export const LATE_MS = 15 * 60_000;

// companyId: tick を送る会社。wizard の会社（state.companyId）の時だけ秘書の id を入れる（図書室の「聞く」の宛先・開発元の記録 docs/review/2026-11-17-library-ask-scope.md 作り方 2）
export function tickBody(state, companyId = null) {
  const body = { lang: state.lang === 'ja' ? 'ja' : 'en' };
  if (typeof state.timeZone === 'string' && state.timeZone) body.timeZone = state.timeZone;
  if (companyId && state.companyId === companyId && typeof state.secretaryId === 'string' && state.secretaryId) body.secretaryAgentId = state.secretaryId;
  return body;
}

// installed: 本体に ready で入っている plugin の key の一覧を返す関数（起動係の plugins.json の記録）
// まとめの回（持ち主の時刻帯で 8 時と 18 時）。今より前の最後の回の key（日付:am|pm）と、その回の始まりの時刻（ms）
export function lastDigestSlot(nowMs, timeZone) {
  const parts = t => { const f = new Intl.DateTimeFormat('en-CA', { timeZone: timeZone || 'UTC', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }); const p = Object.fromEntries(f.formatToParts(new Date(t)).map(x => [x.type, x.value])); return { date: `${p.year}-${p.month}-${p.day}`, hour: Number(p.hour), min: Number(p.minute) }; };
  const { date, hour, min } = parts(nowMs);
  const back = h => nowMs - ((hour - h) * 60 + min) * 60_000;
  if (hour >= 18) return { key: `${date}:pm`, at: back(18) };
  if (hour >= 8) return { key: `${date}:am`, at: back(8) };
  const at = nowMs - ((hour + 6) * 60 + min) * 60_000; // 前の日の 18 時
  return { key: `${parts(at).date}:pm`, at };
}
export const DIGEST_LATE_MS = 60 * 60_000;

// installed: 起動係の記録にある plugin（status を問わない）。ready: そのうち ready の物（口を呼ぶのはこれだけ）。
// ready でない物は遅れとして出す（入れ直しが失敗した時も帯が出る・独立レビュー P2-3）
// limits: AI の使用量の上限の値を集める係（lib/limits.mjs の createLimitsCollector）。あれば知らせの /tick の body に会社ごとの値を足す
// mail: メールで届ける係（lib/mail.mjs の createMailer の戻り値）。あれば送りの後に round を呼ぶ
export function createRounds({ pcUrl, dataDir, getState, installed, ready = installed, fetchFn = fetch, now = () => Date.now(), everyMs = EVERY_MS, lateMs = LATE_MS, limits = null, mail = null }) {
  const file = path.join(dataDir, 'rounds.json');
  const read = () => { try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return { startedAt: null, lastRunAt: null, plugins: {} }; } };
  const write = r => { fs.mkdirSync(dataDir, { recursive: true }); fs.writeFileSync(`${file}.tmp`, JSON.stringify(r, null, 2)); fs.renameSync(`${file}.tmp`, file); };
  let running = false;

  async function call(p, init) { const r = await fetchFn(new URL(p, pcUrl), init); let j = null; try { j = await r.json(); } catch { /* 空 */ } return { status: r.status, ok: r.ok, body: j }; }

  async function runOnce() {
    const s = getState();
    const rec = read();
    rec.startedAt ??= new Date(now()).toISOString();
    if (!s.done) { write(rec); return rec; }
    const keys = ROUND_PLUGINS.filter(k => ready().includes(k));
    rec.lastRunAt = new Date(now()).toISOString();
    let companies = [];
    try { const c = await call('/api/companies'); companies = Array.isArray(c.body) ? c.body : (c.body?.items || []); if (!c.ok) throw new Error(`companies ${c.status}`); }
    catch (e) { for (const k of keys) rec.plugins[k] = { ...rec.plugins[k], lastError: String(e.message || e).slice(0, 200), lastErrorAt: rec.lastRunAt }; write(rec); return rec; }
    // 上限の値は知らせの見回りの前に会社ごとに 1 回だけ集める（集めそこねた会社は値なしで呼ぶ。notify は前の値を使う）
    const extra = {};
    if (limits && keys.includes('aioffice.notify')) {
      for (const c of companies) {
        try { extra[c.id] = await limits.collect(c.id); } catch (e) { console.log(`aioffice: limits collect failed: ${String(e?.message || e).slice(0, 200)}`); }
      }
    }
    for (const k of keys) {
      let ok = true, err = null, last = null;
      for (const c of companies) {
        try {
          const body = { ...tickBody(s, c.id), ...(k === 'aioffice.notify' ? extra[c.id] || {} : {}) };
          const r = await call(`/api/plugins/${encodeURIComponent(k)}/api/tick?companyId=${encodeURIComponent(c.id)}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
          if (!r.ok) { ok = false; err = `tick ${r.status}${r.body?.error ? ` ${String(r.body.error).slice(0, 120)}` : ''}`; } else {
            last = r.body;
            // 上限の値は notify が上限の処理を読み終えた時だけ、読んだ時刻を進める。notify は上限の処理を飛ばした回（枠の残りが少ない・limits が無い）も
            // 失敗した回（limitsError）も 200 を返すので、r.ok だけでは決めない（独立レビュー r4 の中 1）。失敗した回は次の回で同じ範囲を読み直す
            if (k === 'aioffice.notify' && extra[c.id] && typeof limits?.commit === 'function' && r.body && typeof r.body === 'object' && r.body.limits && !r.body.limitsError) limits.commit(c.id);
          }
        } catch (e) { ok = false; err = String(e.message || e).slice(0, 200); }
      }
      const prev = rec.plugins[k] || {};
      rec.plugins[k] = ok ? { ...prev, lastOkAt: rec.lastRunAt, lastError: null, last: last && typeof last === 'object' ? { digestKey: last.digestKey ?? prev.last?.digestKey ?? null, reconcileAt: last.reconcileAt ?? prev.last?.reconcileAt ?? null, dropped: Number(last.dropped) || 0 } : prev.last ?? null }
        : { ...prev, lastError: err, lastErrorAt: rec.lastRunAt };
    }
    // Slack への送り（docs/review/2026-11-18-slack-notify-scope.md S8）: 見回りの後に、会社ごとに知らせの plugin の送りの口を呼ぶ。
    // 見回りの口では送らない（Slack が遅くても office の中の知らせは遅れない）。送りの失敗は見回りの遅れに数えない。返事に URL は無い
    if (keys.includes('aioffice.notify')) {
      rec.slack = rec.slack || {};
      for (const c of companies) {
        try {
          const r = await call(`/api/plugins/aioffice.notify/api/deliver?companyId=${encodeURIComponent(c.id)}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
          const b = r.body && typeof r.body === 'object' ? r.body : {};
          rec.slack[c.id] = { at: rec.lastRunAt, status: r.status, off: b.off === true, sent: Number(b.sent) || 0, waiting: Number(b.waiting) || 0, last: typeof b.last === 'string' && /^[a-z_0-9]{1,40}$/.test(b.last) ? b.last : null };
        } catch { rec.slack[c.id] = { at: rec.lastRunAt, status: null, error: 'unreachable' }; }
      }
    }
    // メールで届ける（docs/review/2026-11-19-mail-notify-scope.md r2・r3 の 9）: Slack の送りの後に、同じ見回りの中で。全体で 60 秒まで・失敗は見回りの遅れに数えない。
    // 記録に残すのは決まった印と数だけ（宛先・パスワード・答えの文は無い）
    if (mail && keys.includes('aioffice.notify')) {
      rec.mail = rec.mail || {};
      try {
        const out = await mail.round(companies);
        for (const [cid, v] of Object.entries(out)) rec.mail[cid] = { at: rec.lastRunAt, off: v?.off === true, sent: Number(v?.sent) || 0, skip: typeof v?.skip === 'string' && /^[a-z_]{1,40}$/.test(v.skip) ? v.skip : null };
      } catch { /* 送りの失敗は見回りに数えない */ }
    }
    write(rec);
    return rec;
  }

  // 毎分呼ぶ。前の回から everyMs が過ぎた時だけ流す・同時には流さない
  async function maybeRun() {
    if (running) return null;
    const rec = read();
    if (rec.lastRunAt && now() - Date.parse(rec.lastRunAt) < everyMs) return null;
    running = true;
    try { return await runOnce(); } finally { running = false; }
  }

  // 遅れの判定（起動係の状態の画面と office の帯で使う）。入っている plugin だけを見る
  function status() {
    const rec = read(), t = now(), out = {}, rd = ready(), s = getState() || {};
    const started = rec.startedAt ? Date.parse(rec.startedAt) : t;
    for (const k of ROUND_PLUGINS.filter(x => installed().includes(x))) {
      const p = rec.plugins[k] || {};
      if (!rd.includes(k)) { out[k] = { late: true, lastOkAt: p.lastOkAt ?? null, lastError: 'not_ready' }; continue; }
      const since = p.lastOkAt ? Date.parse(p.lastOkAt) : started;
      let late = t - since > lateMs;
      // まとめの遅れ（知らせだけ）: 回の始まりから 1 時間たっても、その回の key が見回りの返事に出ていない（保証 20）
      if (k === 'aioffice.notify' && s.done) {
        const slot = lastDigestSlot(t, s.timeZone);
        if (t - slot.at > DIGEST_LATE_MS && slot.at > started && p.last?.digestKey !== slot.key) late = true;
      }
      out[k] = { late, lastOkAt: p.lastOkAt ?? null, lastError: p.lastError ?? null, ...(p.last?.dropped ? { dropped: p.last.dropped } : {}) };
    }
    return out;
  }

  return { runOnce, maybeRun, status, read };
}
