// 回覧（office の間の質問と多段の承認）の中身。通信と DB は渡された deps だけを使う（試験は public/test/relay-plugin.test.mjs）。
// 設計: docs/design/2026-11-21-office-relay.md（2.1 流れ・2.2 宛先・2.3 保証・2.4 限界）
// 担当が課題 X から回覧を出し、宛先の人の会社に課題 Y を作って答えを待ち、答えを X に戻す。どの書き込みも、その会社の見回りの回の中で行う。
export const ORIGIN_KIND = 'plugin:aioffice.relay';
export const KINDS = ['question', 'approval'];
export const LIMITS = { title: 200, body: 8000, chain: 8, answer: 4000 };
// 行を取った回が課題を作り終えずに止まった時、ほかの回が続きをするまでの時間（それより新しい行は、作っている途中とみなして触らない）
export const STALE_MS = 2 * 60 * 1000;
const str = (v, n) => (typeof v === 'string' ? v.trim().slice(0, n) : '');
const CLOSED = new Set(['done', 'cancelled']);
const ANSWERED = new Set(['answered', 'accepted', 'rejected']);
const GONE = new Set(['cancelled', 'expired', 'failed']);

// 設定（会社ごと・本体の plugin の設定）: directory（userId → { name, email }）・homes（userId → 会社の id）・approvers（userId → 上の人の userId）・defaultRequester（userId）
export function nameOf(cfg, userId) { return str(cfg?.directory?.[userId]?.name, 80) || (userId === 'local-board' ? '持ち主' : 'その人'); }
const OWNER_WORDS = new Set(['持ち主', 'owner', 'オーナー']);

// 宛先の 1 人を userId にする。名前・email でも引ける（directory）。見つからなければ null。
// directory に無くても、宛先にできる member の userId そのもの、または「持ち主」（宛先にできる人が 1 人だけの office・公開版のログインなしの形）は引ける
export function userIdOf(cfg, who, memberships = []) {
  const w = str(who, 200);
  if (!w) return null;
  const dir = cfg?.directory && typeof cfg.directory === 'object' ? cfg.directory : {};
  if (Object.hasOwn(dir, w)) return w;
  const hit = Object.entries(dir).filter(([, v]) => v && (str(v.name, 80) === w || str(v.email, 200).toLowerCase() === w.toLowerCase()));
  if (hit.length === 1) return hit[0][0];
  if (hit.length > 1) return null;
  // directory が無い形（公開版・relay-config を流さない）だけ、この会社の member の userId と「持ち主」で引く（独立レビュー P3）
  if (Object.keys(dir).length) return null;
  const rs = receivers(memberships);
  const people = [...new Set(rs.map(m => m.userId))];
  if (people.includes(w)) return w;
  // 「持ち主」は、この会社の owner の役の人が 1 人だけの時のその人（owner でない人を持ち主として引かない・PR #133 独立レビュー P3-2）
  const owners = [...new Set(rs.filter(m => m.membershipRole === 'owner').map(m => m.userId))];
  if (OWNER_WORDS.has(w.toLowerCase()) && owners.length === 1) return owners[0];
  return null;
}

// 承認の既定の列: 起点の人から approvers を上へたどる（起点は含めない）。輪になったら止める
export function approverChain(cfg, from) {
  const up = cfg?.approvers && typeof cfg.approvers === 'object' ? cfg.approvers : {};
  const out = []; const seen = new Set([from]);
  let cur = from;
  while (Object.hasOwn(up, cur) && out.length < LIMITS.chain) {
    const next = up[cur];
    if (!next || seen.has(next)) break;
    out.push(next); seen.add(next); cur = next;
  }
  return out;
}

// 宛先の人の届け先の会社。本体は出す口（依頼元の会社の呼び出し）の中でほかの会社の member を読ませないので、ほかの会社は設定で決める:
// homes（その人の会社）が最優先。無ければ directory のその人の companies（宛先にできる会社の一覧・relay-config が全部の会社の member から作る）が 1 つだけの時その会社。
// どちらも無い時だけ、この会社の member（宛先にできる人）ならこの会社。2 つ以上の会社にいて homes が無い人は断る（推測で届け先を選ばない・2.2）
export function homeOf(cfg, userId, memberships = []) {
  const cos = Array.isArray(cfg?.directory?.[userId]?.companies) ? cfg.directory[userId].companies.filter(c => typeof c === 'string') : null;
  const hasDir = !!(cfg?.directory && Object.keys(cfg.directory).length);
  // directory がある形で、その人の会社の一覧が無ければ、homes より先に断る（0.1.0 の古い設定が残った時に推測で届けない・codex P2）
  if (hasDir && !cos) return null;
  const h = cfg?.homes?.[userId];
  if (h) return !cos || cos.includes(h) ? h : null;
  if (cos) return cos.length === 1 ? cos[0] : null;
  // directory がある形では、その人の会社の一覧が無ければ断る（推測で届け先を選ばない）。
  // directory が無い形（公開版）だけ、この会社の宛先にできる member ならこの会社（ほかの会社の所属は読めないので分からない・受け入れる限界・独立レビュー P2）
  if (hasDir) return null;
  const here = receivers(memberships).filter(m => m.userId === userId);
  return here.length ? here[0].companyId : null;
}
export const canReceive = m => m && m.principalType === 'user' && m.status === 'active' && m.membershipRole !== 'viewer' && m.role !== 'viewer';
// 宛先にできる member。ログインのある形に移した office では、ログインの無い形の持ち主（local-board）が owner の member に残る（本体の API で外せない）。
// 実在の人が 1 人でもいれば local-board は宛先にしない（だれも答えられない）。人が local-board だけの office（ログインの無い形）では今と同じく宛先にする
// （設計 docs/design/2026-11-23-public-office-multi-user.md 2.5）
export function receivers(memberships = []) {
  const ok = memberships.filter(canReceive);
  return ok.some(m => m.userId !== 'local-board') ? ok.filter(m => m.userId !== 'local-board') : ok;
}

// 出す口の中身を確かめ、宛先の列（{ userId, companyId }）にする。断る時は { error }
export function planRequest({ body, cfg, memberships, requesterUserId }) {
  const kind = str(body?.kind, 20);
  if (!KINDS.includes(kind)) return { error: 'kind は question か approval です' };
  const title = str(body?.title, LIMITS.title);
  if (!title) return { error: 'title が要ります' };
  const text = str(body?.body, LIMITS.body);
  const raw = Array.isArray(body?.to) ? body.to : body?.to ? [body.to] : [];
  let users;
  if (raw.length) {
    users = raw.map(w => userIdOf(cfg, w, memberships));
    const bad = raw.filter((w, i) => !users[i]);
    if (bad.length) return { error: `宛先が見つかりません: ${bad.map(w => str(w, 80)).join('、')}（directory に無い・同じ名前が 2 人いる）` };
  } else if (kind === 'approval') {
    let from = requesterUserId || str(cfg?.defaultRequester, 200);
    // ログインの無い形のころに持ち主（local-board）が作った課題は、移した後の承認の列（実在の人で作る）に local-board がいない。設定の defaultRequester（持ち主）から上をたどる（PR #133 独立レビュー P3-3）
    if (from === 'local-board' && str(cfg?.defaultRequester, 200)) from = str(cfg.defaultRequester, 200);
    if (!from) return { error: '承認の列が書かれていません（to か、設定の approvers と defaultRequester が要ります）' };
    users = approverChain(cfg, from);
    if (!users.length) return { error: '承認の列を作れません（設定の approvers に上の人がいません）' };
  } else return { error: '質問の宛先（to）が要ります' };
  if (kind === 'question' && users.length !== 1) return { error: '質問の宛先は 1 人です' };
  if (users.length > LIMITS.chain) return { error: `宛先は ${LIMITS.chain} 人までです` };
  const chain = [];
  for (const u of users) {
    const companyId = homeOf(cfg, u, memberships);
    if (!companyId) return { error: `${nameOf(cfg, u)} の届け先の会社が決まりません（どの会社の member でもない・2 つ以上の会社にいて設定の homes が無い）` };
    chain.push({ userId: u, companyId });
  }
  return { kind, title, body: text, chain };
}

// 答えを文にする（質問は選んだ選択肢の名前と書いた文・承認は承認／却下と理由）
export function answerOf(interaction) {
  const r = interaction?.result || {};
  if (interaction?.kind === 'ask_user_questions') {
    const opts = new Map(((interaction.payload?.questions || [])[0]?.options || []).map(o => [o.id, o.label]));
    const a = (r.answers || [])[0] || {};
    const picked = (a.optionIds || []).map(id => opts.get(id) || id).filter(x => x && x !== '回答');
    const text = [str(a.otherText, LIMITS.answer), ...picked].filter(Boolean).join(' / ');
    return { outcome: 'answered', text: text || '（答えの文なし）' };
  }
  const outcome = interaction?.status === 'accepted' || r.outcome === 'accepted' ? 'accepted' : 'rejected';
  return { outcome, text: str(r.reason, LIMITS.answer) };
}

// 多段の承認は上まで回った後、同じ人を下へたどって戻る（課長 → 部長 → 課長 → 担当）。段 s の人の位置と、戻りの段か
// 列が n 人なら段は 0..n-1（上る）と n..2n-2（戻る・人は 2n-2-s）。質問は 1 段
export const stepsOf = req => (req.kind === 'approval' ? 2 * req.chain.length - 1 : 1);
export const seatOf = (req, step) => (step < req.chain.length ? { idx: step, back: false } : { idx: 2 * req.chain.length - 2 - step, back: true });
const personAt = (req, step) => req.chain[seatOf(req, step).idx];

const stepText = (req, cfg, step) => {
  const { idx, back } = seatOf(req, step);
  const who = nameOf(cfg, req.chain[idx].userId);
  if (req.kind === 'question') return `${who}さんに聞いています（返事待ち）`;
  if (back) return `上の承認が戻り、${who}さんの確かめを待っています（${step + 1}/${stepsOf(req)} 段目）`;
  return `${who}さんの承認を待っています（${step + 1}/${stepsOf(req)} 段目）`;
};

// 見回りの 1 回（会社 companyId の回）。deps: { ctx, store, cfgOf, companyName, newId, now }
export async function tick(deps, companyId) {
  const out = { delivered: 0, read: 0, returned: 0, cancelled: 0, notified: 0, errors: 0 };
  Object.defineProperty(out, 'woken', { value: new Set(), enumerable: false }); // この回で起こした X（返事の JSON には出さない）
  // 失敗の理由は返事にも載せる（見回りの記録 /tmp/aioffice-relay-tick.log に残り、原因を追える）
  const safe = async (fn) => { try { await fn(); } catch (e) { out.errors++; out.lastError = String(e?.message || e).slice(0, 300); deps.warn?.('relay: step failed', { error: out.lastError }); } };
  for (const req of await deps.store.openRequests()) await safe(() => deliver(deps, companyId, req, out));
  for (const s of await deps.store.stepsOf(companyId, ['open'])) await safe(() => readStep(deps, companyId, s, out));
  for (const req of await deps.store.originRequests(companyId)) await safe(() => returnRequest(deps, companyId, req, out));
  for (const s of await deps.store.stepsToClose(companyId)) await safe(() => closeStep(deps, companyId, s, out));
  return out;
}

// 2: 届ける。宛先の人の会社の回で、まだ作っていない段・回の課題と答えの口を作る
async function deliver(deps, companyId, req, out) {
  const at = personAt(req, req.step);
  if (!at || at.companyId !== companyId) return;
  const { idx, back } = seatOf(req, req.step);
  const claimed = await deps.store.claimStep({ requestId: req.id, step: req.step, round: req.round, companyId, userId: at.userId });
  const s = claimed || (await deps.store.getStep(req.id, req.step, req.round));
  if (!s || s.interactionId || s.state !== 'open') return; // 作り終えた
  if (!claimed && deps.now() - Date.parse(s.updatedAt || 0) < STALE_MS) return; // ほかの回が作っている途中
  const { ctx } = deps;
  // 戻りの段は、その人が上る段で受けた課題を使い直す（同じ課題がその人に戻る）
  const originId = `${req.id}:${idx}`;
  // 作る途中で止まった時・出し直しの回は、作った課題を見つけ直す（issues.create に idempotencyKey が無いため）
  let issue = (await ctx.issues.list({ companyId, originKind: ORIGIN_KIND, originId, limit: 5 }))[0] || null;
  const fromName = req.originName || 'ほかの会社';
  if (!issue) {
    issue = await ctx.issues.create({
      companyId, title: `要対応: [回覧] ${req.title}（${fromName} から）`.slice(0, 240),
      description: [req.body, '', `回覧（${req.kind === 'question' ? '質問' : '承認'}）です。下の欄で答えると、元の課題に戻ります。`].join('\n'),
      status: 'todo', assigneeUserId: at.userId, originKind: ORIGIN_KIND, originId,
    });
  }
  // 本体は会社に付いた呼び出しの中でほかの会社を読ませないので、設定は今の回の会社の物を読む（relay-config が全部の会社に同じ物を書く）
  const cfg = await deps.cfgOf(companyId);
  const nextP = req.step + 1 < stepsOf(req) ? personAt(req, req.step + 1) : null;
  const lower = nextP ? `${nameOf(cfg, nextP.userId)}さん` : '依頼元';
  if (back) {
    const upper = nameOf(cfg, req.chain[idx + 1].userId);
    const did = new Set(s.answer?.did || []);
    // 上の承認を待つ間に、その人が自分の課題を閉じていたら、開き直さずに取り消す（人の手で閉じたら取り消し・2.3-6・独立レビュー R1）
    if (!did.has('reopen') && CLOSED.has(issue.status)) {
      const text = req.round > 0 ? `${nameOf(cfg, at.userId)}さんが答えずに課題を閉じたので取り消しました` : `${nameOf(cfg, at.userId)}さんが上の承認を待つ間に課題を閉じたので取り消しました`;
      await deps.store.setRequest(req.id, { state: 'cancelled', result: { outcome: 'closed', by: at.userId, text, at: { step: req.step, round: req.round } } });
      await deps.store.setStep(req.id, req.step, req.round, { issueId: issue.id, state: 'closed' });
      out.read++; return;
    }
    // 開き直しと知らせは、印で 1 回ずつ（出し直しの回・途中で止まった回で 2 回書かない・消さない）
    // 宛先でない人の答えで出し直した回（round > 0）は、もう知らせてあるので書かない
    if (req.round === 0) await once(deps, s, 'reopen-note', () => ctx.issues.createComment(issue.id, `${upper}さんが承認して戻ってきました。確かめて${lower}に戻してください（差し戻すこともできます）。`, companyId));
    await once(deps, s, 'reopen', () => (issue.status === 'todo' ? null : ctx.issues.update(issue.id, { status: 'todo' }, companyId)));
  }
  const common = { addresseeUserId: at.userId, resolverPolicy: 'human_only', continuationPolicy: 'none', idempotencyKey: `${req.id}:${req.step}:${req.round}`, title: req.title.slice(0, 240) };
  const it = req.kind === 'question'
    ? await ctx.issues.createInteraction(issue.id, { ...common, kind: 'ask_user_questions', payload: { version: 1, questions: [{ id: 'q', prompt: req.title.slice(0, 4000), helpText: req.body ? req.body.slice(0, 4000) : null, selectionMode: 'single', required: true, options: [{ id: 'answer', label: '回答', freeText: true }] }] } }, companyId)
    : back
      ? await ctx.issues.createInteraction(issue.id, { ...common, kind: 'request_confirmation', payload: { version: 1, prompt: `「${req.title}」を${nameOf(cfg, req.chain[idx + 1].userId)}さんが承認しました。確かめて${lower}に戻してください。`.slice(0, 1000), detailsMarkdown: req.body || null, rejectRequiresReason: true, supersedeOnUserComment: false, acceptLabel: `確かめて${lower}に戻す`.slice(0, 80), rejectLabel: '差し戻す' } }, companyId)
      : await ctx.issues.createInteraction(issue.id, { ...common, kind: 'request_confirmation', payload: { version: 1, prompt: req.title.slice(0, 1000), detailsMarkdown: req.body || null, rejectRequiresReason: true, supersedeOnUserComment: false, acceptLabel: (nextP ? (seatOf(req, req.step + 1).back ? `承認して ${nameOf(cfg, nextP.userId)} に戻す` : `承認して ${nameOf(cfg, nextP.userId)} に回す`) : '承認').slice(0, 80), rejectLabel: '却下' } }, companyId);
  await deps.store.setStep(req.id, req.step, req.round, { issueId: issue.id, interactionId: it.id, state: 'open' });
  out.delivered++;
}

// 段の行の本当の状態。正本は回覧の記録（requests）: 回覧を進める書き込みと段の行の確定は別の文なので（本体の口は 1 文で 1 つの表だけ）、
// 間で止まっても、回覧の記録が先へ進んでいれば、その段は答え済み（または無効）とみなす。終わった回覧は result.at に終えた段と回を持つ（codex P2-1）
export function effectiveState(req, s) {
  if (!req || s.state !== 'open') return s.state;
  if (s.answer?.did?.includes('advance')) return s.answer.final; // 進めた印がある行（見回りが並んで動いた時の古い記録の上書きにも効く・独立レビュー P3）
  if (req.step > s.step) return s.answer?.final || 'done';
  if (req.step === s.step && req.round > s.round) return s.answer?.final || 'invalid';
  const at = req.result?.at;
  if (req.state !== 'open' && at && at.step === s.step && at.round === s.round) return s.answer?.final || (req.result.outcome === 'closed' ? 'closed' : 'done');
  return 'open';
}

// 段の行に印（answer.did）を付けて 1 つの書き込みを 1 回だけ行う（失敗したら印を付けず、次の回でやり直す）
async function once(deps, s, key, fn) {
  const did = new Set(s.answer?.did || []);
  if (did.has(key)) return;
  await fn();
  did.add(key);
  s.answer = { ...(s.answer || {}), did: [...did] };
  await deps.store.setStep(s.requestId, s.step, s.round, { answer: s.answer });
}

// 答えを読んだ後の書き込みを、1 つずつ印（answer.did）を付けて進め、段の行の確定（state）は最後に書く。
// 途中で失敗しても、行は open のまま残り、次の回で印の無い所から続ける（書き込み 1 つの失敗で回覧が止まらない・独立レビュー B1）
async function settle(deps, s, a, final, actions) {
  const did = new Set(s.answer?.did || []);
  for (const [key, fn] of actions) {
    if (did.has(key)) continue;
    await fn();
    did.add(key);
    await deps.store.setStep(s.requestId, s.step, s.round, { answer: { ...a, final, did: [...did] } });
  }
  await deps.store.setStep(s.requestId, s.step, s.round, { state: final, answer: { ...a, did: [...did] } });
}

// 3: 答えを読む。宛先と同じ人の答えだけを採る
async function readStep(deps, companyId, s, out) {
  if (!s.issueId || !s.interactionId) return;
  const { ctx } = deps;
  const req = await deps.store.getRequest(s.requestId);
  if (!req) return;
  // 回覧を進め終えた後、行の確定の前に止まった段: 確定だけをする
  const eff = effectiveState(req, s);
  if (eff !== 'open') { await deps.store.setStep(s.requestId, s.step, s.round, { state: eff }); return; }
  if (req.state !== 'open' || req.step !== s.step || req.round !== s.round) return;
  const it = (await ctx.issues.listInteractions(s.issueId, companyId)).find(x => x.id === s.interactionId);
  const issue = await ctx.issues.get(s.issueId, companyId);
  // 本体は会社に付いた呼び出しの中でほかの会社を読ませないので、設定は今の回の会社の物を読む（relay-config が全部の会社に同じ物を書く）
  const cfg = await deps.cfgOf(companyId);
  if (!it || GONE.has(it.status) || (it.status === 'pending' && issue && CLOSED.has(issue.status))) {
    // 答えずに閉じられた（2.3-6）
    await settle(deps, s, {}, 'closed', [
      ['advance', () => deps.store.setRequest(req.id, { state: 'cancelled', result: { outcome: 'closed', by: s.userId, text: `${nameOf(cfg, s.userId)}さんが答えずに閉じました`, at: { step: s.step, round: s.round } } })],
    ]);
    out.read++; return;
  }
  if (!ANSWERED.has(it.status)) return;
  if (it.resolvedByUserId !== s.userId) {
    const who = it.resolvedByUserId ? nameOf(cfg, it.resolvedByUserId) : '担当';
    await settle(deps, s, { by: it.resolvedByUserId || null }, 'invalid', [
      ['comment', () => ctx.issues.createComment(s.issueId, `${who}の答えは無効にしました（宛先ではないため）。${nameOf(cfg, s.userId)}さんの答えを待っています。`, companyId)],
      ['advance', () => deps.store.setRequest(req.id, { round: req.round + 1 })],
    ]);
    out.read++; return;
  }
  const a = answerOf(it);
  const who = nameOf(cfg, s.userId);
  const nextP = req.step + 1 < stepsOf(req) ? personAt(req, req.step + 1) : null;
  if (req.kind === 'approval' && a.outcome === 'accepted' && nextP) {
    const up = !seatOf(req, req.step + 1).back;
    // 上へ回した人の課題は済みにせず、上の承認が戻るまで待たせる（戻ってきたらこの課題でもう一度確かめる）
    const text = up ? `${who}さんが承認しました。${nameOf(cfg, nextP.userId)}さんに回しました。承認が戻るとこの課題に戻ります。` : `${who}さんが承認しました。${nameOf(cfg, nextP.userId)}さんに戻しました。`;
    await settle(deps, s, a, 'done', [
      ['comment', () => ctx.issues.createComment(s.issueId, text, companyId)],
      ['issue', () => ctx.issues.update(s.issueId, { status: up ? 'blocked' : 'done' }, companyId)],
      ['advance', () => deps.store.setRequest(req.id, { step: req.step + 1, round: 0 })],
    ]);
  } else {
    const at = { step: s.step, round: s.round };
    const result = req.kind === 'question' ? { outcome: 'answered', by: s.userId, text: a.text, at }
      : { outcome: a.outcome, by: s.userId, text: a.text, at };
    await settle(deps, s, a, 'done', [
      ['comment', () => ctx.issues.createComment(s.issueId, `${req.kind === 'question' ? '答え' : a.outcome === 'accepted' ? '承認' : seatOf(req, req.step).back ? '差し戻し' : '却下'}を元の課題に戻しました。`, companyId)],
      ['issue', () => ctx.issues.update(s.issueId, { status: 'done' }, companyId)],
      ['advance', () => deps.store.setRequest(req.id, { state: a.outcome === 'rejected' ? 'rejected' : 'answered', result })],
    ]);
  }
  out.read++;
}

export function resultText(req, cfg) {
  const r = req.result || {};
  const who = r.by ? nameOf(cfg, r.by) : '';
  if (req.state === 'answered' && req.kind === 'question') return `回覧の答え（${who}さん）: ${r.text || ''}`;
  if (req.state === 'answered') return `回覧の承認: ${req.chain.map(c => nameOf(cfg, c.userId)).join(' → ')} が承認しました。${r.text ? `（${r.text}）` : ''}`;
  if (req.state === 'rejected' && seatOf(req, req.step).back) return `回覧の差し戻し: 上の承認の後、${who}さんが差し戻しました。理由: ${r.text || '（なし）'}`;
  if (req.state === 'rejected') return `回覧の却下: ${who}さんが却下しました。理由: ${r.text || '（なし）'}`;
  return `回覧の取り消し: ${r.text || '取り消されました'}`;
}

// 4: 元へ戻す（依頼元の会社の回）。段が進んだら待つ相手を書き、終わったら答えを書いて X を todo に戻し、担当がいれば起こす
async function returnRequest(deps, companyId, req, out) {
  const { ctx } = deps;
  // 本体は会社に付いた呼び出しの中でほかの会社を読ませないので、設定は今の回の会社の物を読む（relay-config が全部の会社に同じ物を書く）
  const cfg = await deps.cfgOf(companyId);
  const x = await ctx.issues.get(req.originIssueId, companyId);
  if (req.state === 'open') {
    if (x && CLOSED.has(x.status)) {
      await deps.store.setRequest(req.id, { state: 'cancelled', returned: true, result: { outcome: 'origin_closed', text: '依頼元の課題が閉じたので取り消しました' } });
      out.cancelled++; return;
    }
    if (req.step > req.reportedStep) {
      await ctx.issues.createComment(req.originIssueId, `回覧「${req.title}」: 今は ${stepText(req, cfg, req.step)}。`, companyId);
      await deps.store.setRequest(req.id, { reportedStep: req.step });
    }
    return;
  }
  if (req.returned) return;
  // 戻す書き込みを 1 つずつ印（result.did）を付けて進め、全部済んだら returned にする（1 つ失敗しても次の回で続き・2 回は書かない・独立レビュー S1）
  const did = new Set(req.result?.did || []);
  const step = async (key, fn) => { if (did.has(key)) return; await fn(); did.add(key); await deps.store.setRequest(req.id, { result: { ...(req.result || {}), did: [...did] } }); };
  if (x) {
    await step('comment', () => ctx.issues.createComment(req.originIssueId, resultText(req, cfg), companyId));
    // 同じ課題から出したほかの回覧がまだ開いていれば、答えは書くが、X を戻すのと起こすのは最後の回覧が終わった時にする（codex P2-4）
    const others = await deps.store.openCountFor(companyId, req.originIssueId);
    if (others > 0) await step('waiting-note', () => ctx.issues.createComment(req.originIssueId, `ほかの回覧 ${others} 件の答えを待っています。全部そろったらこの課題を戻します。`, companyId));
    if (!CLOSED.has(x.status) && others === 0) {
      if (x.status !== 'todo') await step('reopen', () => ctx.issues.update(req.originIssueId, { status: 'todo' }, companyId));
      // 待つ間に担当が替わった・外された時は起こさない（2.1-4）。起こすのが失敗したら次の回でやり直し、3 回失敗したら諦めて戻すのは終える
      // （本体の idempotencyKey で 2 回起こさない・独立レビュー N3）
      // 同じ回で同じ X の回覧が 2 つ終わっても、起こすのは 1 回（独立レビュー P3）
      if (x.assigneeAgentId && !did.has('wake') && out.woken?.has(req.originIssueId)) { did.add('wake'); await deps.store.setRequest(req.id, { result: { ...(req.result || {}), did: [...did] } }); }
      if (x.assigneeAgentId && !did.has('wake')) {
        (out.woken ||= new Set()).add(req.originIssueId);
        try { await step('wake', () => ctx.issues.requestWakeup(req.originIssueId, companyId, { reason: 'relay answered', idempotencyKey: `relay:${req.id}:return` })); }
        catch (e) {
          const tries = (Number(req.result?.wakeTries) || 0) + 1;
          await deps.store.setRequest(req.id, { result: { ...(req.result || {}), did: [...did], wakeTries: tries } });
          if (tries < 3) throw e;
          deps.warn?.('relay: wake failed', { error: String(e?.message || e).slice(0, 200) });
        }
      }
    }
  }
  await deps.store.setRequest(req.id, { returned: true });
  out.returned++;
}

// 終わった回覧の途中の段（宛先の会社の回）: 取り消しなら Y を閉じ、最後の答えを途中の段の人の課題に知らせる（2.1-4・2.3-6）
async function closeStep(deps, companyId, s, out) {
  const { ctx } = deps;
  const req = await deps.store.getRequest(s.requestId);
  if (!req || req.state === 'open') return;
  // 本体は会社に付いた呼び出しの中でほかの会社を読ませないので、設定は今の回の会社の物を読む（relay-config が全部の会社に同じ物を書く）
  const cfg = await deps.cfgOf(companyId);
  s = { ...s, state: effectiveState(req, s) };
  if (s.state === 'invalid') {
    // 宛先でない答えで無効にした回: 出し直しの回の行があれば、その行が片付ける。無ければ（出し直す前に終わった）この回が課題を閉じる（codex P2-3）
    if (await deps.store.getStep(s.requestId, s.step, s.round + 1)) { await deps.store.setStep(s.requestId, s.step, s.round, { notified: true }); return; }
    s = { ...s, state: 'open' };
  }
  if (!s.issueId) {
    // 課題を作った後、記録の前に止まった段: 作った課題を見つけ直して閉じる。閉じ終えてから印を付ける（失敗したら次の回でやり直す・codex P2-2）
    const y = (await ctx.issues.list({ companyId, originKind: ORIGIN_KIND, originId: `${req.id}:${seatOf(req, s.step).idx}`, limit: 5 }))[0];
    if (y && !CLOSED.has(y.status)) { await ctx.issues.update(y.id, { status: 'cancelled' }, companyId); out.cancelled++; }
    await deps.store.setStep(s.requestId, s.step, s.round, { state: 'cancelled', notified: true });
    return;
  }
  if (s.state === 'open') {
    await once(deps, s, 'cancel-note', () => ctx.issues.createComment(s.issueId, `取り消しました: ${req.result?.text || '依頼元が閉じました'}`, companyId));
    await ctx.issues.update(s.issueId, { status: 'cancelled' }, companyId);
    await deps.store.setStep(s.requestId, s.step, s.round, { state: 'cancelled', notified: true });
    out.cancelled++; return;
  }
  // 途中で終わった時（却下・差し戻し・取り消し）は、上へ回して待っている人の課題（上る段の行は 1 人 1 つ）に結果を書いて閉じる。
  // 最後まで承認された時は、戻りの段で全員が見ているので書かない。終えた本人の課題には書かない
  const mine = seatOf(req, req.step).idx;
  if (s.state === 'done' && s.step < req.chain.length && s.step !== mine && !(req.kind === 'approval' && req.state === 'answered')) {
    await once(deps, s, 'result-note', () => ctx.issues.createComment(s.issueId, resultText(req, cfg), companyId));
    const y = await ctx.issues.get(s.issueId, companyId);
    if (y && y.status === 'blocked') await ctx.issues.update(s.issueId, { status: 'done' }, companyId);
  }
  await deps.store.setStep(s.requestId, s.step, s.round, { notified: true });
  out.notified++;
}

// 1: 出す（担当の run の中から・口の会社 = 課題 X の会社）
export async function createRequest(deps, { companyId, issueId, actor, body }) {
  const { ctx } = deps;
  if (actor?.actorType !== 'agent' || !actor.agentId) return { status: 403, body: { error: '回覧を出せるのは担当だけです（v1）' } };
  const x = await ctx.issues.get(issueId, companyId);
  if (!x) return { status: 404, body: { error: '課題が見つかりません' } };
  const cfg = await deps.cfgOf(companyId);
  const memberships = await deps.memberships(companyId); // 本体が読ませるのは、この会社の member だけ
  const plan = planRequest({ body, cfg, memberships, requesterUserId: x.createdByUserId || null });
  if (plan.error) return { status: 422, body: { error: plan.error } };
  const mut = { actorAgentId: actor.agentId, actorRunId: actor.runId || null };
  // 同じ課題に同じ題の回覧が開いていれば、それを返す（担当が失敗の後に出し直しても 2 つ作らない・独立レビュー S2）
  const key = c => c.map(p => `${p.userId}@${p.companyId}`).join('>');
  const same = (await deps.store.openFor(companyId, issueId, plan.title)).find(r => r.kind === plan.kind && key(r.chain) === key(plan.chain));
  if (same) {
    if (x.status !== 'blocked') await ctx.issues.update(issueId, { status: 'blocked' }, companyId, mut);
    return { status: 201, body: { requestId: same.id, waitingFor: same.chain.map(c => nameOf(cfg, c.userId)), instruction: 'この課題の状態を変えずに run を終えてください。答えが戻ると起こされます。', existing: true } };
  }
  const id = deps.newId();
  const originName = await deps.companyName(companyId);
  await deps.store.createRequest({ id, originCompanyId: companyId, originName, originIssueId: issueId, originAgentId: actor.agentId, ...plan });
  const req = { id, ...plan, step: 0, round: 0 };
  await ctx.issues.update(issueId, { status: 'blocked' }, companyId, mut);
  await ctx.issues.createComment(issueId, `回覧「${plan.title}」を出しました: ${stepText(req, cfg, 0)}。答えが戻るとこの課題に書き、todo に戻します。`, companyId, { authorAgentId: actor.agentId });
  return { status: 201, body: { requestId: id, waitingFor: plan.chain.map(c => nameOf(cfg, c.userId)), instruction: 'この課題の状態を変えずに run を終えてください。答えが戻ると起こされます。' } };
}
