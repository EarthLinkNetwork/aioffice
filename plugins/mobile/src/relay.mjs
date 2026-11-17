// 判断待ちを通知 API へ送り、押された操作を取りに行って本体に反映する。
// - 送る: 承認（approval.created の出来事と 30 秒ごと）・課題ごとの判断カード（30 秒ごと）・会社ごとの判断（key がある人の分だけ・30 秒ごと）
// - 消す: 片付いた件（2 回続けて見えなかった件）・宛先から外れた人の card
// - 初めて入れる回は受信箱に入れるだけで push しない（push は入れた後に新しく出た件から）
// - 反映する: 片付いていない card がある間（と最後の card が片付いた後の 1 回）だけ 15 秒ごとに取りに行き、許可の一覧 1〜6 を全部満たすものだけ
// - card の id は `<種類>:<会社の id>:<件の id>`。同じ通知 API のキーをほかの会社と使っても、自分の会社の分の操作だけを扱う
// - 会社ごとの判断の key: 結びついた本人が承認して出す（CLI のログインの依頼）・持ち主を確かめる・期限の 7 日前に入れ替える・外れたら失効させる。
//   key の無い人には、その人の受信箱にだけ「承認が要ります」のお知らせ（押す操作なし・push しない）を置く
// 状態は plugin の状態（会社ごと・namespace mobile）に置く。key・通知 API のキーはログ・戻り値に出さない。
import { createHash } from 'node:crypto';
import { approvalToCard, decisionToCard, interactionToCard, keyNoticeCard, INTERACTION_KINDS, QUESTION_OTHER, DEFAULT_SEND_KEYS, decorate, conclusionOf, isCommonAction, AIO, jstDay } from './cards.mjs';
import { KEY_TTL_MS } from './host-auth-client.mjs';

export const ACTION_TTL_MS = 24 * 60 * 60 * 1000;
const USED_KEEP_MS = 2 * ACTION_TTL_MS;
const OPEN_ISSUE_STATUSES = ['backlog', 'todo', 'in_progress', 'in_review', 'blocked'];
const NS = 'mobile';
export const RENEW_BEFORE_MS = 7 * 24 * 60 * 60 * 1000; // 期限の 7 日前に入れ替える
const DAY_MS = 24 * 60 * 60 * 1000;
const CHALLENGE_TTL_MS = 10 * 60 * 1000;
// 読めないと card を消さない種類（notice は plugin が自分で決めるので、毎回確か）
const READ_KINDS = ['approval', 'interaction', 'decision'];

const sortKeys = v => (Array.isArray(v) ? v.map(sortKeys) : v instanceof Date ? v.toISOString() : v && typeof v === 'object' ? Object.fromEntries(Object.keys(v).sort().map(k => [k, sortKeys(v[k])])) : v);
// card の版: 送った中身の hash（見た後で本文が変わった件には反映しない）
export const cardVersion = card => createHash('sha256').update(JSON.stringify(sortKeys(card))).digest('hex').slice(0, 32);
export const cardKeyOf = (kind, companyId, id) => `${kind}:${companyId}:${id}`;
// card の id から会社の id を取り出す（形が違えば null）
export const companyOfCardKey = cardId => {
  const m = typeof cardId === 'string' ? cardId.match(/^(approval|interaction|decision|notice):([^:]+):./) : null;
  return m ? m[2] : null;
};
// 送り先ごとの版 { bindingId: version }（前の形 recipients: [bindingId] と version は読み替える）
const recipsOf = s => (Array.isArray(s?.recipients) ? Object.fromEntries(s.recipients.map(b => [b, s.version])) : { ...(s?.recipients || {}) });
// 片付いたとみなすまでに続けて見えなかった回数（課題は状態ごと・offset で読むので、並びが変わると 1 回取りこぼすことがある）
export const MISSES_TO_RESOLVE = 2;
export const REFRESHING_MS = 60 * 60 * 1000; // 「最新にしています」を出しておく長さ
const BASES_KEEP = 16; // 送る版 → 元の版 の対応を持つ数（card ごと）

const BIND_TTL_MS = 10 * 60 * 1000; // code の寿命（通知 API 側と同じ 10 分）
export function createRelay({ ctx, notifyFor, decisionsFor = async () => null, hostAuthFor = async () => null, pageUrlFor = async () => null, now = Date.now, sendKeysFor = async () => DEFAULT_SEND_KEYS }) {
  const st = {
    get: async (companyId, key, dflt) => (await ctx.state.get({ scopeKind: 'company', scopeId: companyId, namespace: NS, stateKey: key })) ?? dflt,
    set: (companyId, key, v) => ctx.state.set({ scopeKind: 'company', scopeId: companyId, namespace: NS, stateKey: key }, v),
  };
  const warn = (msg, meta) => { try { ctx.logger?.warn?.(msg, meta); } catch { /* ログが出せなくても止めない */ } };
  // 会社ごとに 1 本ずつ順に回す（出来事と定期の処理が重ならないように）
  const locks = new Map();
  const serial = (companyId, fn) => { const p = (locks.get(companyId) || Promise.resolve()).then(fn, fn); locks.set(companyId, p.catch(() => {})); return p; };

  const isAdmin = role => role === 'owner' || role === 'admin';
  const validKey = (keys, userId) => { const k = keys[userId]; return k && k.key && (!k.expiresAt || Date.parse(k.expiresAt) > now()) ? k : null; };

  async function activeMembers(companyId) {
    const list = await ctx.access.members.list({ companyId });
    const m = new Map();
    for (const x of list) if (x.principalType === 'user' && x.status === 'active') m.set(x.principalId, x.membershipRole || null);
    return m;
  }

  // 今の判断待ちを集める。読めなかった種類は ok に入れない（読めなかった種類の card は消さない）
  // sure: 無いことが確かな種類（誰も key を持たない会社の判断）。1 回で消す
  async function collect(companyId, keys, activeUsers) {
    const items = []; const ok = new Set(); const sure = new Set();
    const sendKeys = await sendKeysFor(companyId);
    try {
      for (const a of await ctx.approvals.list({ companyId, status: 'pending' })) {
        if (a.status !== 'pending') continue;
        items.push({ kind: 'approval', id: a.id, card: approvalToCard(a, { sendKeys }) });
      }
      ok.add('approval');
    } catch (e) { warn('mobile: approvals could not be read', { error: String(e?.message || e) }); }
    try {
      const seen = new Set();
      // 質問の答えは本体の口（会社ごとの key）で渡すので、口が無い会社（hostUrl の設定が無い）には質問のカードを送らない（PR #108 のレビュー）
      const canAnswer = !!(await decisionsFor(companyId).catch(() => null));
      for (const status of OPEN_ISSUE_STATUSES) {
        for (let offset = 0; ; offset += 200) {
          const page = await ctx.issues.list({ companyId, status, limit: 200, offset });
          for (const is of page) {
            if (seen.has(is.id)) continue; seen.add(is.id);
            for (const i of await ctx.issues.listInteractions(is.id, companyId)) {
              if (i.status !== 'pending' || !INTERACTION_KINDS.includes(i.kind)) continue;
              const card = interactionToCard(i);
              if (!card || (card.question && !canAnswer)) continue; // 問いが 2 つ以上などの質問は web で答える
              items.push({ kind: 'interaction', id: i.id, issueId: is.id, card, question: card.question || null, addressee: card.addressee || null });
            }
          }
          if (page.length < 200) break;
        }
      }
      ok.add('interaction');
    } catch (e) { warn('mobile: interactions could not be read', { error: String(e?.message || e) }); }
    // 会社ごとの判断: 有効な key を持つ人の誰か 1 人の key で読む（読めなければ次の人）
    const dc = await decisionsFor(companyId);
    const holders = [...activeUsers].filter(u => validKey(keys, u));
    if (dc && holders.length) {
      for (const u of holders) {
        try {
          for (const d of await dc.listOpen(companyId, keys[u].key)) items.push({ kind: 'decision', id: d.id, issueId: d.originIssueId || null, wakes: d.continuationPolicy === 'wake_origin_agent', card: decisionToCard(d), createdAt: d.createdAt });
          ok.add('decision'); break;
        } catch (e) { warn('mobile: decisions could not be read with one key', { status: e?.status ?? null }); }
      }
    } else { ok.add('decision'); sure.add('decision'); } // 誰も key を持たない会社は判断を送らない（送った判断の card も消す）
    return { items, ok, sure };
  }

  // 飾りの材料（会社と担当の名前・その人の話・話の結論・「最新にする」の時刻）を 1 回の送りの分だけ読む。
  // 名前は最後に読めた値を残し、読めない回もそれを使う（読みの揺れで送る版を変えない）
  async function lookups(companyId, items, sent = {}) {
    const names = await st.get(companyId, 'names', { company: null, agents: {} });
    const co = await ctx.companies?.get?.(companyId).catch(() => null);
    if (co?.name) names.company = co.name;
    const agents = await ctx.agents?.list?.({ companyId, limit: 500 }).catch(() => null);
    if (Array.isArray(agents)) for (const a of agents) if (a?.id && a?.name) names.agents[a.id] = a.name;
    const threads = await st.get(companyId, 'cardThreads', {}); // 書くのは chat.mjs だけ（ここは読むだけ）
    const refreshing = await st.get(companyId, 'refreshing', {});
    const keys = new Set(items.map(it => cardKeyOf(it.kind, companyId, it.id)));
    const said = {}; // 話の課題 → 結論の行（同じ課題は 1 回だけ読む）
    for (const key of keys) {
      for (const link of Object.values(threads[key] || {})) {
        if (!link?.issueId || Object.hasOwn(said, link.issueId)) continue;
        said[link.issueId] = await ctx.issues.listComments(link.issueId, companyId).then(conclusionOf, () => undefined); // 読めない回は undefined（前の回の結論を使う）
      }
    }
    const talk = {};
    return {
      decorate(key, bid, it, base) {
        const link = threads[key]?.[bid] || null;
        const got = link ? said[link.issueId] : null;
        const conclusion = got === undefined ? sent[key]?.talk?.[bid] || null : got || null; // 読めない回に結論を消して版を揺らさない
        if (conclusion) (talk[key] = talk[key] || {})[bid] = conclusion;
        const r = refreshing[key]?.[bid];
        const live = r && r.base === base && now() - r.at < REFRESHING_MS;
        return decorate(it.card, {
          companyName: names.company,
          agentName: it.card.requestedBy?.agentId ? names.agents[it.card.requestedBy.agentId] || null : null,
          thread: link ? { id: link.threadId, agentId: link.agentId } : null,
          conclusion,
          refreshingAt: live ? r.at : null,
        });
      },
      talkOf: key => talk[key] || null,
      async save(sent) {
        await st.set(companyId, 'names', names);
        // 「最新にしています」は、元の版が変わったか 60 分たったら消す。card の無い件の分も消す
        let dirty = false;
        for (const [key, per] of Object.entries(refreshing)) {
          for (const [bid, r] of Object.entries(per || {})) {
            if (!sent[key] || r.base !== sent[key].version || now() - r.at >= REFRESHING_MS) { delete per[bid]; dirty = true; }
          }
          if (!Object.keys(per || {}).length) { delete refreshing[key]; dirty = true; }
        }
        if (dirty) await st.set(companyId, 'refreshing', refreshing);
      },
    };
  }

  async function syncCompany(companyId) {
    return serial(companyId, async () => {
      const notify = await notifyFor(companyId);
      if (!notify) return { skipped: true };
      const members = await activeMembers(companyId);
      const bindings = await st.get(companyId, 'bindings', {});
      const sent = await st.get(companyId, 'sent', {});
      const primed = !!(await st.get(companyId, 'primed', false));
      const known = await st.get(companyId, 'known', {});
      const missing = await st.get(companyId, 'missing', {});
      const cleared = await st.get(companyId, 'cleared', {});
      const iso = () => new Date(now()).toISOString();
      // メンバーから外れた人の結びつけを失効させる（その人宛ての card を下で消してから、通知 API の結びつけを外す）
      const toRevoke = [];
      for (const [bid, b] of Object.entries(bindings)) {
        if (b.status === 'active' && !members.has(b.userId)) { b.status = 'revoked'; b.updatedAt = iso(); toRevoke.push(bid); }
      }
      const active = Object.entries(bindings).filter(([, b]) => b.status === 'active');
      const activeUsers = new Set(active.map(([, b]) => b.userId));
      // 判断の key の手入れ（承認された依頼の確かめ・入れ替え・外れた人の失効）。失敗しても送る処理は続ける
      const keys = await maintainKeys(companyId, { members, activeUsers, bindings }).catch(e => { warn('mobile: decision keys could not be maintained', { error: String(e?.message || e).slice(0, 200) }); return null; }) ?? await st.get(companyId, 'decisionKeys', {});
      const { items, ok, sure } = await collect(companyId, keys, activeUsers);
      // key の無い人（入れ替えに失敗して期限が近い人も）へのお知らせ: 会社ごとの判断を読む設定がある会社だけ
      // 結びつけの画面が無い（pageUrlFor が null）間は、押す所が無いのでお知らせも出さない
      const href = (await decisionsFor(companyId)) && (await hostAuthFor(companyId)) ? await pageUrlFor(companyId).catch(() => null) : null;
      if (href) {
        const co = await ctx.companies?.get?.(companyId).catch(() => null);
        for (const u of activeUsers) {
          const n = keyNoticeOf(keys[u]);
          if (n) items.push({ kind: 'notice', id: u, only: active.filter(([, b]) => b.userId === u).map(([bid]) => bid), card: keyNoticeCard({ id: `key:${u}`, state: n.state, daysLeft: n.daysLeft, companyName: co?.name || null, href, day: jstDay(now()) }) });
        }
      }
      ok.add('notice'); sure.add('notice');
      const look = await lookups(companyId, items, sent);
      // 判断と質問は、答えに会社ごとの key が要るので key を持つ人だけ。宛先のある質問は宛先の人だけ
      const recipientsOf = it => (it.only ? it.only : active.filter(([, b]) => (it.kind !== 'decision' && !it.question) || validKey(keys, b.userId))
        .filter(([, b]) => !it.addressee || b.userId === it.addressee).map(([bid]) => bid));
      const stats = { put: 0, pushed: 0, deleted: 0 };
      const current = new Set();
      for (const it of items) {
        const key = cardKeyOf(it.kind, companyId, it.id); current.add(key); delete missing[key];
        const base = cardVersion(it.card);
        const prev = sent[key];
        const bases = { ...(prev?.bases || {}) };
        // 前の形の記録（bases なし）から移る最初の回: 送っていた版はそのまま元の版だった
        if (prev && !prev.bases) for (const v of Object.values(recipsOf(prev))) if (v) bases[v] = v;
        const prevR = recipsOf(prev);
        // 前の回までに見ていない件だけが「新しく出た件」（宛先がまだ居なかった件も、見たことにする）
        const isNew = !known[key];
        known[key] = known[key] || iso();
        const want = recipientsOf(it);
        const nextR = {}; // 送り先ごとに、その人の受信箱にある版
        for (const bid of want) {
          const had = Object.hasOwn(prevR, bid);
          // 受け取る人ごとの飾り（docs/design/2026-11-22-app-card-ux.md 2.0）。照合は元の版（base）で行う
          const card = look.decorate(key, bid, it, base);
          const version = cardVersion(card);
          bases[version] = base;
          if (had && prevR[bid] === version) { nextR[bid] = version; continue; }
          // push するのは、入れた後に新しく出た件だけ（初回・中身の更新・後から結びついた人・key を承認した時点で open の判断には push しない）
          const k = it.kind === 'decision' ? validKey(keys, bindings[bid].userId) : null;
          const push = primed && isNew && it.kind !== 'notice' && (it.kind !== 'decision' || !k?.grantedAt || Date.parse(it.createdAt || 0) >= Date.parse(k.grantedAt));
          try {
            await notify.putCard({ bindingId: bid, cardId: key, version, push, card });
            nextR[bid] = version; stats.put++; if (push) stats.pushed++;
          } catch (e) {
            if (e?.status === 404 || e?.status === 410) { bindings[bid].status = 'revoked'; bindings[bid].updatedAt = iso(); }
            else if (had) nextR[bid] = prevR[bid]; // 古い版のまま残っている（その人には次の回に送り直す・押されても版の違いで反映しない）
            warn('mobile: card could not be sent', { status: e?.status ?? null });
          }
        }
        for (const bid of Object.keys(prevR)) {
          if (want.includes(bid)) continue;
          await notify.deleteCard({ bindingId: bid, cardId: key }).then(() => stats.deleted++, e => warn('mobile: card could not be deleted', { status: e?.status ?? null }));
        }
        const shown = decorate(it.card).actions || [];
        const actions = shown.map(a => a.id);
        const needsNote = shown.filter(a => a.needsNote).map(a => a.id);
        // 今配っている版（nextR）は必ず残し、ほかの版を新しい方から残す
        const live = new Set(Object.values(nextR));
        const keep = [...live, ...Object.keys(bases).filter(v => !live.has(v)).slice(-Math.max(0, BASES_KEEP - live.size))];
        const inputs = (it.card.inputs || []).map(i => i.id);
        if (Object.keys(nextR).length) sent[key] = { kind: it.kind, id: it.id, issueId: it.issueId || null, wakes: !!it.wakes, ...(it.question ? { question: it.question } : {}), version: base, bases: Object.fromEntries(keep.map(v => [v, bases[v]])), talk: look.talkOf(key), actions, needsNote, inputs, recipients: nextR, firstSentAt: prev?.firstSentAt || iso() };
        else delete sent[key];
      }
      // 片付いた件（読めた種類で、2 回続けて見えなかったもの）を消す。無いことが確かな種類と前の形の id は 1 回で消す
      for (const key of new Set([...Object.keys(sent), ...Object.keys(known), ...Object.keys(missing)])) {
        if (current.has(key)) continue;
        const kind = key.split(':')[0];
        if (!ok.has(kind)) continue;
        const miss = (missing[key] || 0) + 1;
        if (miss < MISSES_TO_RESOLVE && !sure.has(kind) && companyOfCardKey(key) === companyId) { missing[key] = miss; continue; }
        if (sent[key]) {
          stats.deleted += await removeCard(notify, key, sent[key]);
          cleared[key] = { at: now(), reason: sure.has(kind) ? 'key-required' : 'already-resolved' };
          delete sent[key];
        }
        delete known[key]; delete missing[key];
      }
      for (const [k, v] of Object.entries(cleared)) if (now() - v.at > USED_KEEP_MS) delete cleared[k];
      await look.save(sent);
      for (const bid of toRevoke) await notify.revokeBinding(bid).catch(e => warn('mobile: revoke failed', { status: e?.status ?? null }));
      await st.set(companyId, 'bindings', bindings);
      await st.set(companyId, 'sent', sent);
      await st.set(companyId, 'known', known);
      await st.set(companyId, 'missing', missing);
      await st.set(companyId, 'cleared', cleared);
      // card がある間は、最後の card が片付いた後にも 1 回は押された操作を取りに行く印を立てる
      if (Object.values(sent).some(x => x.actions.length) && !(await st.get(companyId, 'drain', false))) await st.set(companyId, 'drain', true);
      if (!primed && READ_KINDS.every(k => ok.has(k))) await st.set(companyId, 'primed', true);
      return stats;
    });
  }

  async function removeCard(notify, key, s) {
    let n = 0;
    for (const bid of Object.keys(recipsOf(s))) await notify.deleteCard({ bindingId: bid, cardId: key }).then(() => n++, e => warn('mobile: card could not be deleted', { status: e?.status ?? null }));
    return n;
  }

  // 押す操作のある card だけを数える（お知らせしか無い間は取りに行かない）
  const hasOpenCards = async companyId => Object.values(await st.get(companyId, 'sent', {})).some(s => Array.isArray(s.actions) && s.actions.length > 0);

  // 今の件を読み直して card にする（片付いていれば null）
  async function currentCard(companyId, s, presserKey) {
    if (s.kind === 'approval') {
      const a = await ctx.approvals.get(s.id, companyId);
      return a && a.status === 'pending' ? approvalToCard(a, { sendKeys: await sendKeysFor(companyId) }) : null;
    }
    if (s.kind === 'interaction') {
      const i = (await ctx.issues.listInteractions(s.issueId, companyId)).find(x => x.id === s.id);
      return i && i.status === 'pending' ? interactionToCard(i) : null;
    }
    if (s.kind === 'decision') {
      const dc = await decisionsFor(companyId);
      if (!dc || !presserKey) return null;
      const d = (await dc.listOpen(companyId, presserKey)).find(x => x.id === s.id);
      return d ? decisionToCard(d) : null;
    }
    return null;
  }

  // 共通の操作を本体に反映する（押した人の名義）。docs/design/2026-11-22-app-card-ux.md 2.1
  async function applyCommon(companyId, s, a, b, note, key, cur, base) {
    const issueId = s.issueId || cur.origin?.issueId || null;
    // 人の名義のコメントは、課題が開いていて担当がいれば本体が担当を 1 回起こす（明示の requestWakeup は重ねない）。
    // 本体が起こす判断（wake_origin_agent）では、人の名義にせず plugin の名義で書く（2 回起こさない）
    const comment = (text, asUser) => (issueId ? ctx.issues.createComment(issueId, text, companyId, asUser ? { actorUserId: b.userId } : undefined).catch(e => warn('mobile: comment could not be written', { error: String(e?.message || e).slice(0, 200) })) : null);
    if (a.actionId === AIO.refresh) {
      if (!issueId) return { ok: false, reason: 'no-issue' };
      await comment('アプリから: この判断を最新にしてください。課題のコメントと、後から届いたメールを読み直し、判断が変わるなら今の判断を取り消して作り直してください。要らなくなったなら取り消してください。変わらないなら「変わりません」と返してください。', true);
      const refreshing = await st.get(companyId, 'refreshing', {});
      (refreshing[a.cardId] = refreshing[a.cardId] || {})[a.bindingId] = { at: now(), base };
      await st.set(companyId, 'refreshing', refreshing);
      return { ok: true, applied: true, keep: true }; // card は消さない（担当が作り直すまで残す）
    }
    if (a.actionId === AIO.none || a.actionId === AIO.resolve) {
      const talked = s.talk?.[a.bindingId] || '';
      const reason = a.actionId === AIO.none ? `どれでもない: ${note}` : `話で解決: ${note || talked || '（理由なし）'}`;
      if (s.kind === 'decision' && key) {
        await (await decisionsFor(companyId)).dismiss(s.id, { reason }, key);
        await comment(`アプリから「${a.actionId === AIO.none ? 'どれでもない' : '解決にする'}」で閉じました。${reason}`, !s.wakes);
        return { ok: true, applied: true };
      }
      if (s.kind === 'interaction' && s.question && a.actionId === AIO.none && s.question.free && key) {
        await (await decisionsFor(companyId)).respond(s.issueId, s.id, { questionId: s.question.id, optionId: s.question.free, otherText: reason }, key);
        return { ok: true, applied: true };
      }
      if (s.kind === 'interaction' && !s.question && a.actionId === AIO.none) {
        const r = await ctx.issues.respondInteraction(s.issueId, s.id, { action: 'reject', actorUserId: b.userId, reason }, companyId);
        return { ok: true, applied: !!r?.applied };
      }
    }
    return { ok: false, reason: 'unknown-action' };
  }

  // 許可の一覧 1〜6。満たさない時は { ok: false, reason }
  async function applyAction(companyId, a) {
    const used = await st.get(companyId, 'used', {});
    if (!a || typeof a.id !== 'string' || !a.id) return { ok: false, reason: 'invalid' };
    // 5（後半）: 操作の id で二重の反映を止める
    if (used[a.id]) return { ok: false, reason: 'duplicate' };
    const sent = await st.get(companyId, 'sent', {});
    const bindings = await st.get(companyId, 'bindings', {});
    // 1: plugin 自身が送った card
    const s = sent[a.cardId];
    if (!s) return { ok: false, reason: (await st.get(companyId, 'cleared', {}))[a.cardId]?.reason || 'unknown-card' }; // 片付いた件は「もう決まっている」
    const recips = recipsOf(s);
    // 2: 宛先の本人で、結びつけが有効
    const b = bindings[a.bindingId];
    if (!b || b.status !== 'active') return { ok: false, reason: 'binding-inactive' };
    if (!Object.hasOwn(recips, a.bindingId)) return { ok: false, reason: 'not-recipient' };
    const members = await activeMembers(companyId);
    if (!members.has(b.userId)) return { ok: false, reason: 'binding-inactive' };
    // 5（前半）: 押してから 24 時間以内
    const t = Date.parse(a.pressedAt);
    if (!Number.isFinite(t) || now() - t > ACTION_TTL_MS || t - now() > 5 * 60 * 1000) return { ok: false, reason: 'expired' };
    // 4: card の actions[] にある操作
    if (!s.actions.includes(a.actionId)) return { ok: false, reason: 'unknown-action' };
    const note = typeof a.values?.note === 'string' ? a.values.note.trim().slice(0, 2000) : '';
    if (s.needsNote.includes(a.actionId) && !note) return { ok: false, reason: 'note-required' };
    let key = null;
    if (s.kind === 'decision' || s.question) {
      key = validKey(await st.get(companyId, 'decisionKeys', {}), b.userId)?.key || null;
      if (!key) return { ok: false, reason: 'key-required' }; // 承認し直してください
    }
    // 質問: 本体の口が無い・自由に書く選択肢の文が空なら、使った印を付ける前に断る（印の後だと、やり直しが二重押しで断られる・PR #108 のレビュー）
    if (s.question) {
      if (!(await decisionsFor(companyId).catch(() => null))) return { ok: false, reason: 'unavailable', retry: true };
      const other = typeof a.values?.inputs?.[QUESTION_OTHER] === 'string' ? a.values.inputs[QUESTION_OTHER].trim() : '';
      if (a.actionId === s.question.free && !other) return { ok: false, reason: 'note-required' };
    }
    // 3: 中身の hash が今の件と一致（片付いていれば反映しない）
    let cur;
    try { cur = await currentCard(companyId, s, key); } catch { return { ok: false, reason: 'unavailable', retry: true }; }
    if (!cur) return { ok: false, reason: 'already-resolved' };
    // 押した時の送る版 → 元の版。飾り（状態の行・名前・話）だけが変わった時は断らず、中身が変わった時だけ断る
    const base = s.bases ? s.bases[a.version] : a.version === recips[a.bindingId] ? a.version : undefined;
    if (!base || cardVersion(cur) !== base) return { ok: false, reason: 'stale' };
    // 反映の前に使った印を残す（本体の呼び出しの途中で止まっても 2 回目を反映しない）
    used[a.id] = now();
    for (const [k, v] of Object.entries(used)) if (now() - v > USED_KEEP_MS) delete used[k];
    await st.set(companyId, 'used', used);
    // 共通の操作（どれでもない・解決にする・最新にする）は種類より先に分ける（本体の選択肢の id と混ぜない）
    if (isCommonAction(a.actionId)) {
      try { return await applyCommon(companyId, s, a, b, note, key, cur, base); } catch (e) { return { ok: false, reason: 'host-refused', status: e?.status ?? null }; }
    }
    // 6: 本体が押した人の名義で確かめ直す
    try {
      if (s.kind === 'approval') {
        const r = await ctx.approvals.decide(s.id, { action: a.actionId, actorUserId: b.userId, decisionNote: note || null }, companyId);
        return { ok: true, applied: !!r?.applied };
      }
      if (s.kind === 'interaction' && s.question) {
        const raw = typeof a.values?.inputs?.[QUESTION_OTHER] === 'string' ? a.values.inputs[QUESTION_OTHER].trim() : '';
        const otherText = a.actionId === s.question.free ? raw : '';
        const dc = await decisionsFor(companyId);
        await dc.respond(s.issueId, s.id, { questionId: s.question.id, optionId: a.actionId, otherText }, key);
        return { ok: true, applied: true };
      }
      if (s.kind === 'interaction') {
        const r = await ctx.issues.respondInteraction(s.issueId, s.id, { action: a.actionId, actorUserId: b.userId, reason: note || null }, companyId);
        return { ok: true, applied: !!r?.applied };
      }
      if (s.kind === 'decision') {
        const raw = a.values?.inputs && typeof a.values.inputs === 'object' ? a.values.inputs : {};
        const inputValues = Object.fromEntries(Object.entries(raw).filter(([k, v]) => s.inputs.includes(k) && typeof v === 'string').map(([k, v]) => [k, v.slice(0, 20000)]));
        const dc = await decisionsFor(companyId);
        await dc.decide(s.id, { optionId: a.actionId, inputValues, idempotencyKey: a.id }, key);
        return { ok: true, applied: true };
      }
    } catch (e) { return { ok: false, reason: 'host-refused', status: e?.status ?? null }; }
    return { ok: false, reason: 'unknown-kind' };
  }

  // 片付いていない card がある間（と最後の card が片付いた後の 1 回）だけ、押された操作を取りに行く
  async function pollActions(companyId) {
    const idle = { polled: false, applied: 0, refused: 0, skipped: 0 };
    const open = await hasOpenCards(companyId);
    if (!open && !(await st.get(companyId, 'drain', false))) return idle;
    const notify = await notifyFor(companyId);
    if (!notify) return idle;
    const list = await notify.pendingActions();
    let applied = 0, refused = 0, skipped = 0;
    for (const a of list) {
      // 同じキーをほかの会社と使う時: 自分の会社の card でない操作は、結果を返さずに飛ばす（その会社が返す）
      if (companyOfCardKey(a?.cardId) !== companyId) { skipped++; continue; }
      const r = await serial(companyId, () => applyAction(companyId, a));
      if (r.retry) continue; // 本体が読めない時は返さず、次の回にやり直す
      const out = r.ok ? { ok: true } : { ok: false, reason: r.reason };
      await notify.reportAction(a.id, out).catch(e => warn('mobile: result could not be returned', { status: e?.status ?? null }));
      if (r.ok && r.keep) applied++; // 「最新にする」は card を残す
      else if (r.ok) {
        applied++;
        await serial(companyId, async () => { // 片付いた card を消す
          const sent = await st.get(companyId, 'sent', {});
          const s = sent[a.cardId];
          if (s) {
            await removeCard(notify, a.cardId, s); delete sent[a.cardId]; await st.set(companyId, 'sent', sent);
            const cleared = await st.get(companyId, 'cleared', {});
            cleared[a.cardId] = { at: now(), reason: 'already-resolved' };
            await st.set(companyId, 'cleared', cleared);
          }
        });
      } else refused++;
    }
    // 始めから card が無かった回（片付いた後の 1 回）を済ませたら、次の card が出るまで取りに行かない
    if (!open && !(await hasOpenCards(companyId))) await st.set(companyId, 'drain', false);
    return { polled: true, applied, refused, skipped };
  }

  // 結びつけ（画面は ui.mjs。ここは本体のログインで決まった人 userId だけを受ける）
  const bindingsApi = {
    async start(companyId, userId) {
      if (!userId) throw new Error('only a signed-in member can link');
      const notify = await notifyFor(companyId);
      if (!notify) throw new Error('notify is not configured');
      // 3 秒の読みの合間に相手が code を入れていたら、捨てずに確認の表示に戻す（新しい code は作らない）
      for (const [oid, o] of Object.entries(await st.get(companyId, 'bindings', {}))) {
        if (o.userId !== userId || o.status !== 'waiting') continue;
        const cur = await notify.bindingState(oid).catch(() => null);
        if (cur?.state === 'claimed') return { claimed: true, bindingId: oid, email: cur.email || null };
      }
      const r = await notify.createBindCode();
      await serial(companyId, async () => {
        const bindings = await st.get(companyId, 'bindings', {});
        // 出し直しで、この人の古い待ち（waiting / claimed）を通知 API と記録の両方で捨てる（取り残しを作らない）
        for (const [oid, o] of Object.entries(bindings)) {
          if (o.userId !== userId || o.status !== 'waiting') continue;
          await notify.revokeBinding(oid).catch(e => warn('mobile: stale binding revoke failed', { status: e?.status ?? null }));
          o.status = 'revoked'; o.updatedAt = new Date(now()).toISOString();
        }
        // code 自体は記録しない（10 分で切れる秘密。画面は出した時だけ持つ）
        bindings[r.bindingId] = { userId, status: 'waiting', email: null, createdAt: new Date(now()).toISOString(), expiresAt: r.expiresAt || null };
        await st.set(companyId, 'bindings', bindings);
      });
      return { bindingId: r.bindingId, code: r.code, expiresAt: r.expiresAt || null };
    },
    async status(companyId, userId, bindingId) {
      const b = (await st.get(companyId, 'bindings', {}))[bindingId];
      if (!b || b.userId !== userId) return { state: 'unknown' };
      const r = await (await notifyFor(companyId)).bindingState(bindingId);
      return { state: r?.state || 'unknown', email: r?.email || null };
    },
    // code を出した本人だけが確認できる（管理者の代わりの承認はできない）
    async confirm(companyId, userId, bindingId, accept) {
      const notify = await notifyFor(companyId);
      return serial(companyId, async () => {
        const bindings = await st.get(companyId, 'bindings', {});
        const b = bindings[bindingId];
        if (!b || !userId || b.userId !== userId) return { ok: false, reason: 'not-issuer' };
        if (!(await activeMembers(companyId)).has(userId)) return { ok: false, reason: 'not-member' };
        const cur = await notify.bindingState(bindingId);
        if (cur?.state !== 'claimed') return { ok: false, reason: `not-claimed:${cur?.state || 'unknown'}` };
        const r = await notify.confirmBinding(bindingId, accept);
        b.status = accept && r?.state === 'active' ? 'active' : 'rejected';
        b.email = cur.email || null; b.updatedAt = new Date(now()).toISOString();
        await st.set(companyId, 'bindings', bindings);
        return { ok: b.status === 'active', state: b.status };
      });
    },
    // 本人の「待っている / 名乗り出た」結びつけ（画面を開き直した時に確認を戻す）。切れたものは返さない（記録も閉じる）
    async pending(companyId, userId) {
      if (!userId) return [];
      const notify = await notifyFor(companyId);
      if (!notify) return [];
      const bindings = await st.get(companyId, 'bindings', {});
      const out = []; let dirty = false;
      for (const [bindingId, b] of Object.entries(bindings)) {
        if (b.userId !== userId || b.status !== 'waiting') continue;
        const until = Date.parse(b.expiresAt) || (Date.parse(b.createdAt) + BIND_TTL_MS);
        const live = until > now() ? await notify.bindingState(bindingId).catch(() => null) : null;
        // 切れの判定は期限（expiresAt）。通知 API を読めなかっただけの件は state: 'unknown' で返し、画面の表示を保つ
        if (until > now() && !live) { out.push({ bindingId, state: 'unknown', email: null, expiresAt: new Date(until).toISOString(), createdAt: b.createdAt }); continue; }
        const state = live?.state;
        if (state !== 'waiting' && state !== 'claimed') { b.status = 'expired'; b.updatedAt = new Date(now()).toISOString(); dirty = true; continue; }
        out.push({ bindingId, state, email: live.email || null, expiresAt: new Date(until).toISOString(), createdAt: b.createdAt });
      }
      if (dirty) await serial(companyId, async () => { // 閉じるのは今も waiting のものだけ（確認と競合させない）
        const cur = await st.get(companyId, 'bindings', {});
        for (const [id, b] of Object.entries(bindings)) if (b.status === 'expired' && cur[id]?.status === 'waiting') cur[id] = { ...cur[id], status: 'expired', updatedAt: b.updatedAt };
        await st.set(companyId, 'bindings', cur);
      });
      return out.sort((a, c) => Date.parse(c.createdAt) - Date.parse(a.createdAt));
    },
    // 本人の分（管理者は会社の全員の分）
    async list(companyId, userId) {
      const role = (await activeMembers(companyId)).get(userId);
      const admin = isAdmin(role);
      return Object.entries(await st.get(companyId, 'bindings', {})).filter(([, b]) => b.status === 'active' && (admin || b.userId === userId)).map(([bindingId, b]) => ({ bindingId, email: b.email, mine: b.userId === userId, createdAt: b.createdAt }));
    },
    // 画面の人が会社の管理者か（全員の結びつけと「全員の判断の承認を取り消す」を出すため）
    async role(companyId, userId) { return { admin: isAdmin((await activeMembers(companyId)).get(userId)) }; },
    // 本人と会社の管理者が外せる
    async remove(companyId, userId, bindingId) {
      const notify = await notifyFor(companyId);
      const role = (await activeMembers(companyId)).get(userId);
      return serial(companyId, async () => {
        const bindings = await st.get(companyId, 'bindings', {});
        const b = bindings[bindingId];
        if (!b || !(b.userId === userId || role === 'owner' || role === 'admin')) return { ok: false, reason: 'forbidden' };
        await notify.revokeBinding(bindingId).catch(e => warn('mobile: revoke failed', { status: e?.status ?? null }));
        b.status = 'revoked'; b.updatedAt = new Date(now()).toISOString();
        const sent = await st.get(companyId, 'sent', {});
        for (const [key, s] of Object.entries(sent)) {
          const r = recipsOf(s);
          if (!Object.hasOwn(r, bindingId)) continue;
          await notify.deleteCard({ bindingId, cardId: key }).catch(() => {});
          delete r[bindingId]; s.recipients = r;
          if (!Object.keys(r).length) delete sent[key];
        }
        await st.set(companyId, 'bindings', bindings);
        await st.set(companyId, 'sent', sent);
        // その人の有効な結びつけが無くなったら、判断の key を本体で失効させて消す（依頼も捨てる）
        if (!Object.values(bindings).some(x => x.status === 'active' && x.userId === b.userId)) await retireUser(companyId, b.userId);
        return { ok: true };
      });
    },
  };

  // ---- 会社ごとの判断の key ----
  // 状態 decisionKeys[userId]: 有効な時 { key, keyId, expiresAt, grantedAt, renewFailedAt? }・無い時 { key: null, reason, lostAt? }
  // 状態 keyRequests[userId]: 承認待ちの依頼 { id, token, pendingKey, approvalPath, expiresAt, createdAt }（承認か 10 分で消える）
  // 状態 keyAbandoned: 捨てた依頼（上書き・外した・外れた・切れた）。本体の期限まで見張り、後から承認されたらその key を失効させる
  // 状態 keyRevokeQueue: 失効させる key。失効できるまで（か key の期限まで）毎回やり直す（失効に失敗しても追跡を失わない）
  const LOST_REASONS = ['expired', 'revoked'];
  const RENEW_RETRY_MS = 60 * 60 * 1000; // 入れ替えに失敗したら 1 時間おいてやり直す
  const ABANDON_GRACE_MS = 60 * 60 * 1000; // 捨てた依頼は期限の後 1 時間まで見張る（時計のずれ）
  const ABANDON_MAX_MS = 24 * 60 * 60 * 1000; // 本体が答えない（401/403 以外）ままでも、期限の 24 時間後には捨てる
  const iso = t => new Date(t).toISOString();
  const nameFor = email => `AI Office: ${email || 'mobile'} との結びつけ`;
  const authFail = e => e?.status === 401 || e?.status === 403;

  // 失効の列を処理する（key の期限が過ぎたもの・本体がもう受けないもの（401/403）は列から外す）
  async function processRevokes(companyId) {
    const queue = await st.get(companyId, 'keyRevokeQueue', []);
    if (!queue.length) return 0;
    const ha = await hostAuthFor(companyId);
    const left = [];
    let n = 0;
    for (const q of queue) {
      if (q.expiresAt && Date.parse(q.expiresAt) <= now()) continue;
      if (!ha) { left.push(q); continue; }
      try { await ha.revokeCurrent(q.key); n++; } catch (e) { if (!authFail(e)) { left.push(q); warn('mobile: decision key could not be revoked; retrying later', { status: e?.status ?? null }); } }
    }
    await st.set(companyId, 'keyRevokeQueue', left);
    return n;
  }
  const retireKey = (queue, k) => { if (k?.key) queue.push({ key: k.key, expiresAt: k.expiresAt || iso(now() + KEY_TTL_MS) }); };
  const abandonReq = (abandoned, r) => { if (r?.id) abandoned.push({ id: r.id, token: r.token, pendingKey: r.pendingKey, expiresAt: r.expiresAt }); };

  // お知らせの種類（null ならお知らせ不要）
  function keyNoticeOf(k) {
    if (!k) return { state: 'none' };
    if (!k.key) return { state: LOST_REASONS.includes(k.reason) ? 'lost' : 'none' };
    if (!k.expiresAt) return null;
    const left = Date.parse(k.expiresAt) - now();
    if (left <= 0) return { state: 'lost' };
    if (k.renewFailedAt) return { state: 'expiring', daysLeft: Math.max(1, Math.ceil(left / DAY_MS)) };
    return null;
  }

  // 承認された依頼の確かめ・捨てた依頼の見張り・期限の 7 日前の入れ替え・切れた key の始末・外れた人の失効（serial の中から呼ぶ）
  async function maintainKeys(companyId, { members, activeUsers, bindings }) {
    const keys = await st.get(companyId, 'decisionKeys', {});
    const reqs = await st.get(companyId, 'keyRequests', {});
    const abandoned = await st.get(companyId, 'keyAbandoned', []);
    const queue = await st.get(companyId, 'keyRevokeQueue', []);
    const ha = await hostAuthFor(companyId);
    const emailOf = u => Object.values(bindings || {}).find(b => b.userId === u && b.status === 'active')?.email || null;
    // 外れた人（メンバーでない・有効な結びつけが無い）: key は失効の列へ、依頼は捨てた依頼へ
    for (const u of Object.keys(keys)) if (!members.has(u) || !activeUsers.has(u)) { retireKey(queue, keys[u]); delete keys[u]; }
    for (const u of Object.keys(reqs)) if (!members.has(u) || !activeUsers.has(u)) { abandonReq(abandoned, reqs[u]); delete reqs[u]; }
    // 承認待ちの依頼。本体は承認された依頼も 10 分を過ぎると expired と返す（services/board-auth.js の challengeStatusForRow）ので、
    // pending 以外は依頼の key そのもので持ち主を読んで確かめる（読めれば承認されている・401/403 なら承認されていない）
    for (const [u, r] of Object.entries(reqs)) {
      if (!ha) { if (now() >= Date.parse(r.expiresAt || 0)) { abandonReq(abandoned, r); delete reqs[u]; if (!keys[u]?.key) keys[u] = { key: null, reason: 'request-expired' }; } continue; }
      let state = 'unknown';
      if (now() < Date.parse(r.expiresAt || 0)) {
        try { state = await ha.challengeState(r.id, r.token); } catch (e) { warn('mobile: key request could not be read', { status: e?.status ?? null }); continue; }
        if (state === 'pending') continue;
      }
      // 持ち主の確かめ: 承認した人（key の持ち主）が依頼した本人でなければ、その key を失効させて使わない
      let me;
      try { me = await ha.me(r.pendingKey); } catch (e) {
        if (!authFail(e)) { warn('mobile: key owner could not be read; retrying later', { status: e?.status ?? null }); if (now() >= Date.parse(r.expiresAt || 0) + ABANDON_GRACE_MS) { abandonReq(abandoned, r); delete reqs[u]; } continue; } // 一時的な失敗はやり直す
        me = null;
      }
      delete reqs[u];
      if (!me && state !== 'approved') { if (!keys[u]?.key) keys[u] = { key: null, reason: state === 'cancelled' ? 'request-cancelled' : 'request-expired' }; continue; } // 承認されていない
      if (!me || me.userId !== u) {
        retireKey(queue, { key: r.pendingKey });
        if (!keys[u]?.key) keys[u] = { key: null, reason: me ? 'owner-mismatch' : 'owner-unknown' };
        warn('mobile: approved key does not belong to the requester; revoking', { reason: me ? 'owner-mismatch' : 'owner-unknown' });
        continue;
      }
      const expiresAt = (await ha.expiresAtOf(r.pendingKey, me.keyId).catch(() => null)) || iso(now() + KEY_TTL_MS - DAY_MS);
      retireKey(queue, keys[u]); // 承認し直した時は前の key を失効させる
      keys[u] = { key: r.pendingKey, keyId: me.keyId, expiresAt, grantedAt: iso(now()) };
    }
    // 捨てた依頼: 依頼の key で持ち主を読めたら承認されているので、その key を失効させる（期限の後は承認できないので、期限の 1 時間後まで見張る）
    for (let i = abandoned.length - 1; i >= 0; i--) {
      const a = abandoned[i];
      if (!ha) { if (now() > Date.parse(a.expiresAt || 0) + ABANDON_GRACE_MS) abandoned.splice(i, 1); continue; }
      try { await ha.me(a.pendingKey); retireKey(queue, { key: a.pendingKey }); abandoned.splice(i, 1); } catch (e) {
        const over = now() - Date.parse(a.expiresAt || 0);
        if ((over > ABANDON_GRACE_MS && authFail(e)) || over > ABANDON_MAX_MS) { if (!authFail(e)) warn('mobile: abandoned key request dropped without an answer from the host', { status: e?.status ?? null }); abandoned.splice(i, 1); }
      }
    }
    // 切れた key と、期限の 7 日前の入れ替え
    for (const [u, k] of Object.entries(keys)) {
      if (!k.key || !k.expiresAt) continue;
      const left = Date.parse(k.expiresAt) - now();
      if (left <= 0) { keys[u] = { key: null, reason: 'expired', lostAt: iso(now()) }; continue; }
      if (left > RENEW_BEFORE_MS || !ha) continue;
      if (k.renewFailedAt && now() - Date.parse(k.renewFailedAt) < RENEW_RETRY_MS) continue;
      try {
        const n = await ha.createKey(k.key, { name: nameFor(emailOf(u)), expiresAt: iso(now() + KEY_TTL_MS), companyId });
        retireKey(queue, k); // 新しい key を状態に置いてから古い key を失効させる（下の processRevokes）
        keys[u] = { key: n.key, keyId: n.keyId, expiresAt: n.expiresAt, grantedAt: k.grantedAt || iso(now()) };
      } catch (e) {
        warn('mobile: decision key could not be renewed', { status: e?.status ?? null });
        keys[u] = authFail(e) ? { key: null, reason: 'revoked', lostAt: iso(now()) } : { ...k, renewFailedAt: iso(now()) };
      }
    }
    await st.set(companyId, 'decisionKeys', keys);
    await st.set(companyId, 'keyRequests', reqs);
    await st.set(companyId, 'keyAbandoned', abandoned);
    await st.set(companyId, 'keyRevokeQueue', queue);
    await processRevokes(companyId);
    return keys;
  }

  async function keyContext(companyId) {
    const members = await activeMembers(companyId);
    const bindings = await st.get(companyId, 'bindings', {});
    const activeUsers = new Set(Object.values(bindings).filter(b => b.status === 'active' && members.has(b.userId)).map(b => b.userId));
    return { members, bindings, activeUsers };
  }

  // その人の key を失効の列へ・依頼を捨てた依頼へ移して、すぐ失効させる（結びつけを外した時など）
  async function retireUser(companyId, userId) {
    const keys = await st.get(companyId, 'decisionKeys', {});
    const reqs = await st.get(companyId, 'keyRequests', {});
    const abandoned = await st.get(companyId, 'keyAbandoned', []);
    const queue = await st.get(companyId, 'keyRevokeQueue', []);
    retireKey(queue, keys[userId]); delete keys[userId];
    abandonReq(abandoned, reqs[userId]); delete reqs[userId];
    await st.set(companyId, 'decisionKeys', keys);
    await st.set(companyId, 'keyRequests', reqs);
    await st.set(companyId, 'keyAbandoned', abandoned);
    await st.set(companyId, 'keyRevokeQueue', queue);
    await processRevokes(companyId);
  }

  const decisionKeysApi = {
    // 「判断を受けるために承認する」: 結びつけが有効な本人だけ。承認の URL はこの戻り値（本人の画面）にだけ出す。
    // 承認待ちの依頼が期限内にあれば、新しく作らず同じ依頼を返す（二重に押しても依頼は 1 つ）
    request: (companyId, userId) => serial(companyId, async () => {
      const ha = await hostAuthFor(companyId);
      if (!ha || !(await decisionsFor(companyId))) return { ok: false, reason: 'not-configured' };
      const { bindings, activeUsers } = await keyContext(companyId);
      if (!userId || !activeUsers.has(userId)) return { ok: false, reason: 'not-linked' };
      const reqs = await st.get(companyId, 'keyRequests', {});
      const cur = reqs[userId];
      if (cur && Date.parse(cur.expiresAt) - now() > 60_000) return { ok: true, approvalUrl: ha.approvalUrl(cur.approvalPath), expiresAt: cur.expiresAt };
      const email = Object.values(bindings).find(b => b.userId === userId && b.status === 'active')?.email || null;
      const ch = await ha.createChallenge({ clientName: nameFor(email), companyId });
      if (cur) { const abandoned = await st.get(companyId, 'keyAbandoned', []); abandonReq(abandoned, cur); await st.set(companyId, 'keyAbandoned', abandoned); }
      const expiresAt = ch.expiresAt && Date.parse(ch.expiresAt) <= now() + CHALLENGE_TTL_MS ? ch.expiresAt : iso(now() + CHALLENGE_TTL_MS);
      reqs[userId] = { id: ch.id, token: ch.token, pendingKey: ch.pendingKey, approvalPath: ch.approvalPath, expiresAt, createdAt: iso(now()) };
      await st.set(companyId, 'keyRequests', reqs);
      return { ok: true, approvalUrl: ha.approvalUrl(ch.approvalPath), expiresAt };
    }),
    // 本人の状態（承認待ちなら先に本体へ確かめに行く）。none | pending | active | expiring | lost
    status: async (companyId, userId) => {
      if (!userId) return { state: 'none' };
      if ((await st.get(companyId, 'keyRequests', {}))[userId]) await decisionKeysApi.maintain(companyId).catch(e => warn('mobile: decision keys could not be maintained', { error: String(e?.message || e).slice(0, 200) }));
      const k = (await st.get(companyId, 'decisionKeys', {}))[userId];
      const r = (await st.get(companyId, 'keyRequests', {}))[userId];
      const n = keyNoticeOf(k);
      if (!n) return { state: 'active', expiresAt: k.expiresAt, renewAt: k.expiresAt ? iso(Date.parse(k.expiresAt) - RENEW_BEFORE_MS) : null };
      if (n.state === 'expiring') return { state: 'expiring', expiresAt: k.expiresAt, daysLeft: n.daysLeft };
      if (r) {
        const ha = await hostAuthFor(companyId);
        return { state: 'pending', approvalUrl: ha ? ha.approvalUrl(r.approvalPath) : null, expiresAt: r.expiresAt };
      }
      return { state: n.state, ...(k?.reason ? { reason: k.reason } : {}) };
    },
    maintain: companyId => serial(companyId, async () => maintainKeys(companyId, await keyContext(companyId)).then(() => true)),
    // 会社の管理者が、全員の判断の key を失効させる（plugin を外す前など。本体に外す時の呼び出しが無いため）
    revokeAll: (companyId, userId) => serial(companyId, async () => {
      const role = (await activeMembers(companyId)).get(userId);
      if (!userId || !isAdmin(role)) return { ok: false, reason: 'forbidden' };
      const keys = await st.get(companyId, 'decisionKeys', {});
      const reqs = await st.get(companyId, 'keyRequests', {});
      const abandoned = await st.get(companyId, 'keyAbandoned', []);
      const queue = await st.get(companyId, 'keyRevokeQueue', []);
      let n = 0;
      for (const [u, k] of Object.entries(keys)) { if (!k.key) continue; n++; retireKey(queue, k); keys[u] = { key: null, reason: 'revoked', lostAt: iso(now()) }; }
      for (const r of Object.values(reqs)) abandonReq(abandoned, r);
      await st.set(companyId, 'decisionKeys', keys);
      await st.set(companyId, 'keyRequests', {});
      await st.set(companyId, 'keyAbandoned', abandoned);
      await st.set(companyId, 'keyRevokeQueue', queue);
      await processRevokes(companyId);
      const left = (await st.get(companyId, 'keyRevokeQueue', [])).length;
      return { ok: true, revoked: n, pending: left };
    }),
    set: (companyId, userId, { key, expiresAt, grantedAt }) => serial(companyId, async () => {
      const keys = await st.get(companyId, 'decisionKeys', {});
      keys[userId] = { key, expiresAt: expiresAt || null, grantedAt: grantedAt || new Date(now()).toISOString() };
      await st.set(companyId, 'decisionKeys', keys);
    }),
    remove: (companyId, userId) => serial(companyId, async () => {
      const keys = await st.get(companyId, 'decisionKeys', {});
      delete keys[userId];
      await st.set(companyId, 'decisionKeys', keys);
    }),
    has: async (companyId, userId) => !!validKey(await st.get(companyId, 'decisionKeys', {}), userId),
  };

  return { syncCompany, pollActions, applyAction, hasOpenCards, bindings: bindingsApi, decisionKeys: decisionKeysApi };
}
