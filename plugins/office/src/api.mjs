// office の画面から呼ぶ口（同じ origin）。本体の /api は起動係の持ち主の cookie で通る（範囲の「前提」）。
// - 本体: 承認・判断・出来事（SDK に口が無い物と、書く操作）
// - 起動係: 言語・担当の id（雛形ごと）・AI の契約のつなぎ・担当を足す
// - design の plugin の口: デザインの依頼
// fetchFn を渡せるので試験では偽物にする

import { planFolder, toBatches, tally } from '../../../packages/aioffice/launcher/public/folder-pick.js'; // wizard と同じ絞り込み（フォルダの欄の範囲 作り方 3）

// 部屋のフォルダ選び: 部屋の会社の図書室の口（libraryPut）へ 1 件ずつ順に置く。起動係の口は使わない（フォルダの欄の範囲 作り方 6・保証 6）
// files: [{ webkitRelativePath?, name, text() }]。結果は { done: { put, refused }, skipped }
export async function folderToLibrary({ api, companyId, files, onProgress = () => {} }) {
  const plan = planFolder([...(files || [])].map(f => ({ path: f.webkitRelativePath || f.name, file: f })));
  const docs = []; for (const x of plan.take) docs.push({ name: x.name, text: await x.file.text() });
  const { batches, tooBig } = toBatches(docs);
  const all = batches.flat(), results = [];
  for (let i = 0; i < all.length; i += 1) {
    onProgress(`${i + 1} / ${all.length}`);
    try { await api.libraryPut(companyId, all[i].name, all[i].text); results.push({ name: all[i].name, ok: true }); }
    catch (e) { const code = String(e.body?.error || ''); results.push({ name: all[i].name, ok: false, why: code.startsWith('library_doc_') ? code : 'library_failed' }); }
  }
  return { done: tally(results), skipped: { ...plan.skipped, size: plan.skipped.size + tooBig.length } };
}

// AI の書いた文の中の link は http(s) だけを link にする（範囲の保証 4）。それ以外は null（画面は文字のまま出す）
export function safeHref(raw) {
  const s = String(raw ?? '').trim();
  if (!s || /[\u0000-\u001f\u007f\s]/.test(s)) return null;
  let u; try { u = new URL(s); } catch { return null; }
  return u.protocol === 'http:' || u.protocol === 'https:' ? u.href : null;
}

// 閉じていない課題の状態（本体の ISSUE_STATUSES から done・cancelled を外した物）
const OPEN_STATUSES = 'backlog,todo,in_progress,in_review,blocked';

export function createApi(fetchFn = (...a) => fetch(...a)) {
  async function call(method, url, body) {
    const r = await fetchFn(url, { method, credentials: 'same-origin', headers: { accept: 'application/json', ...(body ? { 'content-type': 'application/json' } : {}) }, body: body ? JSON.stringify(body) : undefined });
    let json = null; try { json = await r.json(); } catch { json = null; }
    if (!r.ok) throw Object.assign(new Error(json?.error || `${method} ${url} → ${r.status}`), { status: r.status, body: json });
    return json;
  }
  const co = id => `/api/companies/${encodeURIComponent(id)}`;
  return {
    // 本体
    approvals: companyId => call('GET', `${co(companyId)}/approvals?status=pending`),
    // タスクボードの課題: 閉じていない物の全部と、doneSince より後に動いた完了（設計 2026-11-24 §6.2「完了は直近 7 日だけ」）。
    // 閉じていない物は myIssues と同じ読み方（500 件ずつ・afterId）。完了は直近だけなので 1 ページで足りる
    // routines が false の時は、定期実行が作った課題を外す（実物の会社で 9,241 件のうち大半が定期実行の課題だった・2026-11-24）
    boardIssues: async (companyId, doneSince, { routines = false } = {}) => {
      const noRoutine = routines ? '' : '&excludeRoutineExecutions=true';
      const out = [], seen = new Set();
      const take = got => { for (const i of got) if (i?.id && !seen.has(i.id)) { seen.add(i.id); out.push(i); } };
      const items = r => (Array.isArray(r) ? r : r?.items || []);
      let after = null;
      for (let page = 0; page < 20; page++) {
        const got = items(await call('GET', `${co(companyId)}/issues?status=${OPEN_STATUSES}&sortField=id&sortDir=asc&limit=500${noRoutine}${after ? `&afterId=${encodeURIComponent(after)}` : ''}`));
        take(got);
        if (got.length < 500) break;
        after = got[got.length - 1]?.id;
        if (!after) break;
      }
      take(items(await call('GET', `${co(companyId)}/issues?status=done&updatedSince=${encodeURIComponent(doneSince)}&sortField=updated&sortDir=desc&limit=500${noRoutine}`)));
      return out;
    },
    // 動かす直前に 1 件を読み直す（手元の古いラベルの並びで上書きして、他の人が足したラベルを消さない）
    issue: issueId => call('GET', `/api/issues/${encodeURIComponent(issueId)}`),
    // 件のページの会話（課題のコメント）。書くのは開いている人の名義
    comments: issueId => call('GET', `/api/issues/${encodeURIComponent(issueId)}/comments`),
    addComment: (issueId, body) => call('POST', `/api/issues/${encodeURIComponent(issueId)}/comments`, { body }),
    labels: companyId => call('GET', `${co(companyId)}/labels`),
    createLabel: (companyId, name, color) => call('POST', `${co(companyId)}/labels`, { name, color }),
    // 課題の状態・ラベルを変える（札を列へ動かした時）。patch は board-lib の movePatch と、case-lib の goPatch・dropPatch が作った物だけを渡す
    patchIssue: (issueId, patch) => call('PATCH', `/api/issues/${encodeURIComponent(issueId)}`, patch),
    // 自分に割り当てた課題（回覧が人に回した物など・受信箱の「自分宛て」・設計 2.7）。本体の attention は承認を人ごとに絞らないので使わない
    // 閉じていない物だけを本体で絞り、500 件ずつ最後のページまで読む（1 回で 100 件に切ると、それより後の課題が出なかった・codex の最終確認 P2）
    // 次のページは前のページの最後の id より後（本体の afterId）。offset だと読む間に閉じた課題の分だけ列が前へずれて読み落とす（17 回目のレビュー P2 の兄弟）
    myIssues: async (companyId, userId) => {
      const out = [], seen = new Set();
      let after = null;
      for (let page = 0; page < 20; page++) { // 1 人に 1 万件まで
        const r = await call('GET', `${co(companyId)}/issues?assigneeUserId=${encodeURIComponent(userId)}&status=${OPEN_STATUSES}&sortField=id&sortDir=asc&limit=500${after ? `&afterId=${encodeURIComponent(after)}` : ''}`);
        const got = Array.isArray(r) ? r : r?.items || [];
        for (const i of got) if (i?.id && !seen.has(i.id)) { seen.add(i.id); out.push(i); }
        if (got.length < 500) break;
        after = got[got.length - 1]?.id;
        if (!after) break;
      }
      return out;
    },
    // ログイン中の人（名前を持ち主の部屋の名前に使う）
    me: () => call('GET', '/api/auth/get-session'),
    decisions: companyId => call('GET', `${co(companyId)}/decisions?status=open`),
    activity: (companyId, limit = 50) => call('GET', `${co(companyId)}/activity?limit=${limit}`),
    approve: (id, note) => call('POST', `/api/approvals/${encodeURIComponent(id)}/approve`, note ? { decisionNote: note } : {}),
    reject: (id, note) => call('POST', `/api/approvals/${encodeURIComponent(id)}/reject`, note ? { decisionNote: note } : {}),
    decide: (id, optionId) => call('POST', `/api/decisions/${encodeURIComponent(id)}/decide`, { optionId }),
    // 起動係（無い所では読めない → 画面は英語・依頼の欄とつなぎは使えない）
    launcherState: () => call('GET', '/setup/api/state'),
    // 言語と一緒にブラウザの時刻帯も残す（wizard を通らずに版上げで入った人の時刻帯・独立レビュー P2-6）
    setLang: (lang, timeZone = browserTimeZone()) => call('POST', '/setup/api/lang', { lang, ...(timeZone ? { timeZone } : {}) }),
    addAgents: ids => call('POST', '/setup/api/agents', { ids }),
    codexStart: () => call('POST', '/setup/api/codex/start'),
    codexRestart: () => call('POST', '/setup/api/codex/restart'),
    codexCancel: () => call('POST', '/setup/api/codex/cancel'),
    // AI の契約の欄（wizard の AI の段と同じ口・範囲 docs/review/2026-11-18-office-ai-panel-ux-scope.md G1・F1）
    aiList: () => call('GET', '/setup/api/ai'),
    aiInstall: type => call('POST', '/setup/api/ai/install', { type }),
    aiStart: type => call('POST', '/setup/api/ai/start', { type }),
    aiCode: (type, code) => call('POST', '/setup/api/ai/code', { type, code }),
    aiCancel: type => call('POST', '/setup/api/ai/cancel', { type }),
    agentsAi: () => call('GET', '/setup/api/agents/ai'),
    assignAi: assign => call('POST', '/setup/api/agents/ai', { assign }),
    // design の plugin の口
    // 知らせの plugin の口（入っていない所では 404 → 欄を出さない）
    notices: companyId => call('GET', `/api/plugins/aioffice.notify/api/notices?companyId=${encodeURIComponent(companyId)}`),
    noticeRead: (companyId, key) => call('POST', `/api/plugins/aioffice.notify/api/notices/read?companyId=${encodeURIComponent(companyId)}`, { key }),
    // AI の使用量の上限（範囲 docs/review/2026-11-18-ai-usage-limit-scope.md 7 の 7）:
    // notify の画面の値（止めた担当・直近の使用率・追加料金の設定）・本体の再開（持ち主の cookie）・記録を閉じる口・起動係の上限の設定
    notifyLimits: companyId => call('GET', `/api/plugins/aioffice.notify/api/settings?companyId=${encodeURIComponent(companyId)}`),
    limitResume: (companyId, agentIds) => call('POST', `/api/plugins/aioffice.notify/api/limit/resume?companyId=${encodeURIComponent(companyId)}`, { agentIds }),
    resumeAgent: id => call('POST', `/api/agents/${encodeURIComponent(id)}/resume`, {}),
    getAgent: id => call('GET', `/api/agents/${encodeURIComponent(id)}`), // 再開の前に今の status・pausedAt を読む（M3）
    aiLimits: () => call('GET', '/setup/api/ai-limits'),
    saveAiLimits: body => call('POST', '/setup/api/ai-limits', body),
    libraryStatus: companyId => call('GET', `/api/plugins/aioffice.library/api/status?companyId=${encodeURIComponent(companyId)}`),
    librarySearch: (companyId, q) => call('GET', `/api/plugins/aioffice.library/api/search?companyId=${encodeURIComponent(companyId)}&q=${encodeURIComponent(q)}`),
    libraryDocs: companyId => call('GET', `/api/plugins/aioffice.library/api/documents?companyId=${encodeURIComponent(companyId)}`),
    libraryPut: (companyId, name, text) => call('POST', `/api/plugins/aioffice.library/api/documents?companyId=${encodeURIComponent(companyId)}`, { name, text }),
    libraryAsk: (companyId, q, lang) => call('POST', `/api/plugins/aioffice.library/api/ask?companyId=${encodeURIComponent(companyId)}`, { q, lang }),
    libraryAskAnswer: (companyId, issueId) => call('GET', `/api/plugins/aioffice.library/api/ask/answer?companyId=${encodeURIComponent(companyId)}&issueId=${encodeURIComponent(issueId)}`),
    libraryRemove: (companyId, name) => call('POST', `/api/plugins/aioffice.library/api/documents/remove?companyId=${encodeURIComponent(companyId)}`, { name }),
    // Slack に届ける（docs/review/2026-11-18-slack-notify-scope.md 作り方 4）。webhook の URL は起動係の口にだけ送る（本体の plugin の口には載せない・S3）。
    // 見本と ON は起動係を通す（言語と office の URL を起動係が足し、ON は起動係の一度だけの確認を通る・S1）。状態・OFF・試しは知らせの plugin の口
    slackStatus: companyId => call('GET', `/api/plugins/aioffice.notify/api/slack?companyId=${encodeURIComponent(companyId)}`),
    slackSave: (companyId, url) => call('POST', '/setup/api/slack', { companyId, url }),
    slackRemove: companyId => call('POST', '/setup/api/slack', { companyId, remove: true }),
    slackPreview: (companyId, kinds, form) => call('GET', `/setup/api/slack/preview?companyId=${encodeURIComponent(companyId)}&kinds=${encodeURIComponent(kinds.join(','))}&form=${encodeURIComponent(form)}`),
    slackConfirm: (companyId, kinds, form, previewHash) => call('POST', '/setup/api/slack/confirm', { companyId, kinds, form, previewHash }),
    slackOff: companyId => call('POST', `/api/plugins/aioffice.notify/api/slack/off?companyId=${encodeURIComponent(companyId)}`),
    slackTest: companyId => call('POST', `/api/plugins/aioffice.notify/api/slack/test?companyId=${encodeURIComponent(companyId)}`),
    // メールで届ける（docs/review/2026-11-19-mail-notify-scope.md）。アドレスとアプリ パスワードは起動係の口にだけ送る（本体の plugin の口には載せない）。
    // 状態・見本・ON・OFF・試しは全部起動係を通す（ON・OFF・宛先の正は起動係の state）
    // AI の連携（docs/review/2026-11-22-notify-via-ai-connectors-scope.md 作り方 1・2）。起動係が状態の語だけを返す。fresh は前の実行から 30 秒は前の結果
    connectors: fresh => call('GET', `/setup/api/connectors${fresh ? '?fresh=1' : ''}`),
    // 人の欄（持ち主だけ・起動係の口）
    people: () => call('GET', '/setup/api/people'),
    savePerson: body => call('POST', '/setup/api/people', body),
    invite: companyId => call('POST', '/setup/api/people/invite', { companyId }),
    mailStatus: companyId => call('GET', `/setup/api/mail?companyId=${encodeURIComponent(companyId)}`),
    mailSave: (companyId, addr, pw) => call('POST', '/setup/api/mail', { companyId, addr, pw }),
    mailRemove: companyId => call('POST', '/setup/api/mail', { companyId, remove: true }),
    mailPreview: (companyId, kinds, form) => call('GET', `/setup/api/mail/preview?companyId=${encodeURIComponent(companyId)}&kinds=${encodeURIComponent(kinds.join(','))}&form=${encodeURIComponent(form)}`),
    mailConfirm: (companyId, kinds, form, previewHash) => call('POST', '/setup/api/mail/confirm', { companyId, kinds, form, previewHash }),
    mailOff: companyId => call('POST', '/setup/api/mail/off', { companyId }),
    mailTest: companyId => call('POST', '/setup/api/mail/test', { companyId }),
    designRequest: (companyId, body) => call('POST', `/api/plugins/aioffice.design/api/request?companyId=${encodeURIComponent(companyId)}`, body),
  };
}

// 判断の選択肢を office で押せるか（入力欄のある判断は本体の判断の画面へ回す・範囲の保証 3）
export const decidableHere = d => !(Array.isArray(d?.inputs) && d.inputs.length) && !(d?.inputs && typeof d.inputs === 'object' && !Array.isArray(d.inputs) && Object.keys(d.inputs).length);

// 担当の状態を 4 つ（＋その他）に分ける。本体の状態（AGENT_STATUSES）の active は「有効」で、実行中は running（本体 2026.1001.0）
export function statusKey(s) {
  const v = String(s || '');
  if (v === 'running') return 'running';
  if (v === 'idle' || v === 'active') return 'idle';
  if (v === 'paused' || v === 'disabled') return 'paused';
  if (v === 'error' || v === 'failed') return 'error';
  return 'other';
}

// 帯（保証 17〜20）: 待っている件数・未読の知らせ・見回りの遅れ・時刻帯の未設定。
// launcher: undefined=読み込み中 / null=package の外（起動係なし）/ 'down'=起動係を読めない
// limits: notify の /settings の limits（画面の値。無い時は null）
// AI の上限の帯（範囲 docs/review/2026-11-18-ai-usage-limit-scope.md G4・G2a・G9b・G7b・7 の 7）:
//   ai_limit_paused（赤・押すと受信箱。止めた担当の数は知らせと記録の担当の和。読んでも消えない）・
//   ai_quota_unreadable・ai_overage_enabled・budget_unset（案内の色・押せない）
// 帯の見た目と押した時に開く欄は BANNER_LOOK（帯の形は今までの { key, … } のまま）
// slack: 知らせの plugin の Slack の状態（GET /slack）。宛先が使えない時と、送り直しが 3 回続いた時に「Slack に届いていません」（S6）
export const SLACK_FAIL_BANNER = 3;
export const slackFailing = s => !!s && ((!s.on && s.offReason === 'dead') || (s.on && (s.failStreak || 0) >= SLACK_FAIL_BANNER));
// mail: 起動係のメールの状態（GET /setup/api/mail）。止まった時・続けて失敗した時・今日の上限・送らなかった文がある時に帯を出す（M9・r3 の 1）
export const mailFailing = m => !!m && ((!m.on && m.offReason === 'dead') || (m.on && (m.failStreak || 0) >= SLACK_FAIL_BANNER));
export function bannerItems({ pending = 0, notices = null, launcher, limits = null, slack = null, mail = null }) {
  // 承認は本体の承認の一覧（pending）で数えるので、承認の知らせは未読に数えない（二重にしない・保証 18・独立レビュー P2-5）
  const unread = Array.isArray(notices) ? inboxNotices(notices).filter(n => !n.readAt).length : 0;
  const list = Array.isArray(notices) ? notices : [];
  const out = [];
  const paused = new Set([...list.filter(n => n.kind === 'agent_paused_limit').map(n => n.originId), ...(Array.isArray(limits?.pauses) ? limits.pauses.map(p => p.agentId) : [])].filter(Boolean));
  if (paused.size) out.push({ key: 'ai_limit_paused', n: paused.size });
  if (pending + unread > 0) out.push({ key: 'waiting', pending, unread });
  // 15 分動いていない（late）か、直前の回が失敗した（lastError・plugin が止まった時など）
  const late = launcher === 'down' || Object.values(launcher?.rounds || {}).some(r => r?.late || r?.lastError);
  if (late) out.push({ key: 'rounds_late' });
  if (launcher && launcher !== 'down' && !launcher.timeZone && Array.isArray(notices)) out.push({ key: 'tz_unset' });
  // 形の合わない event を捨てた（本体の版と plugin が合っていない・保証 8）
  if (Object.values(launcher?.rounds || {}).some(r => r?.dropped > 0)) out.push({ key: 'version_mismatch' });
  // 使用率を読めない（Claude の担当がいて読めなかった・ChatGPT が ok:false・追加料金の残り・run の一覧）: notify が出し続ける知らせがある間は出す（閉じても次に開いた時に出る・G2a）
  if (list.some(n => n.kind === 'ai_quota_unreadable')) out.push({ key: 'ai_quota_unreadable' });
  // 上限の後は追加料金で続く設定（G9b）
  if (limits?.overageEnabled === true) out.push({ key: 'ai_overage_enabled' });
  // API キーの担当に予算が無い（G7b）。予算が決まれば notify が知らせを消す
  if (list.some(n => n.kind === 'budget_unset')) out.push({ key: 'budget_unset' });
  if (slackFailing(slack)) out.push({ key: 'slack_failed' });
  if (mail && !mail.on && mail.offCode === 'test_ca_env') out.push({ key: 'mail_ca_env' });
  else if (mailFailing(mail)) out.push({ key: 'mail_failed' });
  if (mail?.on && mail.dayBlocked) out.push({ key: 'mail_day' });
  if (mail?.on && mail.badCount > 0) out.push({ key: 'mail_skipped' });
  return out;
}

// 帯の見た目（tone: alert=赤のボタン・warn=黄のボタン・info=案内の色・err=今までの赤）と、押した時に開く欄（to。無い帯は押せない）
export const BANNER_LOOK = {
  ai_limit_paused: { tone: 'alert', to: 'inbox' }, waiting: { tone: 'warn', to: 'inbox' },
  rounds_late: { tone: 'err' }, tz_unset: { tone: 'err' }, version_mismatch: { tone: 'err' },
  ai_quota_unreadable: { tone: 'info' }, ai_overage_enabled: { tone: 'info' }, budget_unset: { tone: 'info' },
  // 「Slack に届いていません」は押すと受信箱の Slack の欄に飛ぶ（S6・押した時の動きは ui.mjs で focus を足す）
  slack_failed: { tone: 'warn', to: 'inbox' },
  mail_failed: { tone: 'warn', to: 'inbox' }, mail_ca_env: { tone: 'warn', to: 'inbox' }, mail_day: { tone: 'info' }, mail_skipped: { tone: 'warn', to: 'inbox' },
};
export const bannerLook = key => BANNER_LOOK[key] || { tone: 'err' };
// 帯の文: 辞書の文の {n}・{pending}・{unread} を埋める
export const bannerText = (t, b) => t(`banner_${b.key}`).replace('{pending}', String(b.pending ?? 0)).replace('{unread}', String(b.unread ?? 0)).replace('{n}', String(b.n ?? 0));

// 受信箱の「止めた担当」の知らせの「再開」で一緒に戻す担当（G6: まとめて止めた担当は 1 押しでまとめて再開）。
// notify の記録（limits.pauses）に無い担当（本体の予算で止まった物・人が止めた物）には再開を出さない（null）。
// 同じ契約の記録の担当を全員返す（契約が無い記録はその担当だけ）
export function limitGroup(limits, agentId) {
  const pauses = Array.isArray(limits?.pauses) ? limits.pauses : [];
  const rec = pauses.find(p => p.agentId === agentId);
  if (!rec) return null;
  const ids = rec.contract ? pauses.filter(p => p.contract === rec.contract).map(p => p.agentId) : [agentId];
  return [...new Set([agentId, ...ids])];
}

// 「再開」: 担当ごとに本体の担当を読み直し、notify の記録の pausedAt（agentPausedAt）と同じ時刻で paused の担当だけを
// 本体の resume（持ち主の cookie）で戻し、続けて notify に記録を閉じさせる（G6・7 の 7）。
// limits.pauses は最後の見回りの写しで最大 5 分古いので、その後に予算や人が止め直した担当（pausedAt が違う）は戻さず changed に入れる
// （人の停止・予算の停止を外さない・実装レビュー r1 の M3）。記録に pausedAt が無い担当も確かめられないので戻さない。
// 本体が断った・読めなかった担当は failed に入れ、記録は閉じない（notify も paused のままの担当は閉じない）。
// 返り値 { resumed, failed, changed, closed, stillPaused }
const sameAt = (a, b) => a != null && b != null && Date.parse(a) === Date.parse(b);
export async function resumeLimitGroup({ api, companyId, agentIds, limits }) {
  const pauses = Array.isArray(limits?.pauses) ? limits.pauses : [];
  const resumed = [], failed = [], changed = [];
  for (const id of agentIds || []) {
    const rec = pauses.find(p => p.agentId === id);
    if (!rec || rec.agentPausedAt == null) { changed.push(id); continue; }
    let a;
    try { a = await api.getAgent(id); } catch (e) { failed.push({ id, status: e?.status ?? null }); continue; }
    if (!a || a.status !== 'paused' || !sameAt(a.pausedAt, rec.agentPausedAt)) { changed.push(id); continue; }
    try { await api.resumeAgent(id); resumed.push(id); } catch (e) { failed.push({ id, status: e?.status ?? null }); }
  }
  let closed = [], stillPaused = [];
  if (resumed.length) { const r = await api.limitResume(companyId, resumed); closed = r?.closed || []; stillPaused = r?.stillPaused || []; }
  return { resumed, failed, changed, closed, stillPaused };
}

// 担当の欄の「AI の上限で停止中（〜まで）」: notify の記録から、その担当の止め続ける期限を返す（記録が無ければ null・期限が無ければ untilAt: null）
export function limitPauseOf(limits, agentId) {
  const rec = (Array.isArray(limits?.pauses) ? limits.pauses : []).find(p => p.agentId === agentId);
  return rec ? { reason: rec.reason ?? null, untilAt: rec.untilAt ?? null } : null;
}

// 使用率の表示の 1 行（「AI の契約」の欄）: 窓の種類ごとの % と期限。読んだ時刻は observedAt
export function usageRows(view) {
  const byKind = Object.fromEntries((Array.isArray(view?.windows) ? view.windows : []).map(w => [w.kind, w]));
  return ['week', 'h5'].map(kind => ({ kind, usedPercent: typeof byKind[kind]?.usedPercent === 'number' ? Math.round(byKind[kind].usedPercent) : null, resetsAt: byKind[kind]?.resetsAt ?? null }));
}

// 上限の設定の欄の入力（文字）を起動係の口の body にする。止める % が空なら止めない（null）。数でない・範囲外は error の key を返す
// 追加料金の扱い（範囲 9 節の Q4・10 節）: 1 円も使わない（never・既定）・使い始めたら止める（stop）・続けてよい（allow）
export const LIMIT_SPEND_MODES = ['never', 'stop', 'allow'];
export const LIMIT_SPEND_DEFAULT = 'never';
export function limitsBody(form) {
  const pct = v => { const s = String(v ?? '').trim(); if (!s) return null; const n = Number(s); return Number.isInteger(n) && n >= 1 && n <= 100 ? n : NaN; };
  if (!LIMIT_SPEND_MODES.includes(form.spend)) return { error: 'limits_bad_spend' };
  const body = { guard: !!form.guard, spend: form.spend };
  for (const p of ['openai', 'anthropic']) {
    body[p] = {};
    for (const w of ['h5', 'week']) {
      const warn = pct(form[p]?.[w]?.warnPct), stop = pct(form[p]?.[w]?.stopPct);
      if (warn === null || Number.isNaN(warn) || Number.isNaN(stop)) return { error: 'limits_bad_pct' };
      if (stop !== null && warn > stop) return { error: 'limits_warn_over_stop' };
      body[p][w] = { warnPct: warn, stopPct: stop };
    }
  }
  return { body };
}
// 起動係の値（normalizeAiLimits の形）を欄の入力の形（文字）にする
export function limitsForm(v) {
  const f = { guard: v?.guard !== false, spend: LIMIT_SPEND_MODES.includes(v?.spend) ? v.spend : LIMIT_SPEND_DEFAULT };
  for (const p of ['openai', 'anthropic']) {
    f[p] = {};
    for (const w of ['h5', 'week']) f[p][w] = { warnPct: String(v?.[p]?.[w]?.warnPct ?? 80), stopPct: v?.[p]?.[w]?.stopPct == null ? '' : String(v[p][w].stopPct) };
  }
  return f;
}

// 受信箱の「知らせ」の欄に出す物（承認は「承認」の欄に出るので除く）
export const inboxNotices = list => (list || []).filter(n => n.kind !== 'approval');
export function browserTimeZone() { try { return Intl.DateTimeFormat().resolvedOptions().timeZone || null; } catch { return null; } }

// 意味の近さの検索が 30 分以上続けて使えない（止めている時は出さない）
export const SEMANTIC_DOWN_MS = 30 * 60 * 1000;
export const semanticDown = (sem, now = Date.now()) => !!sem && !sem.ok && sem.reason !== 'off' && !!sem.since && now - Date.parse(sem.since) >= SEMANTIC_DOWN_MS;

// 聞くの返事を問い直すか（開発元の記録 docs/review/2026-11-17-library-ask-scope.md 作り方 10）: 'poll' | 'done' | 'timeout'
export const ASK_POLL = { everyMs: 3000, maxMs: 180_000 };
// state が null（一時的に届かなかった）時も、3 分までは問い直す（実装レビュー P3-d）
export const askNext = (state, elapsedMs) => (state === 'waiting' || state === 'handed_to' || state == null) ? (elapsedMs < ASK_POLL.maxMs ? 'poll' : 'timeout') : 'done';

// 聞くの問い合わせの係: 問いごとの番号を持ち、古い問いの返事は捨てる。stop で止める（部屋を閉じた時・実装レビュー P2-2）
// onUpdate(patch) は今の問いの返事だけで呼ばれる
export function askRunner({ fetchAnswer, onUpdate, setTimer = setTimeout, clearTimer = clearTimeout, now = Date.now }) {
  let gen = 0, timer = null;
  const poll = (issue, started, g) => {
    const step = r => {
      if (g !== gen) return;
      if (r) onUpdate({ ...r, issue });
      const next = askNext(r ? r.state : null, now() - started);
      if (next === 'poll') timer = setTimer(() => poll(issue, started, g), ASK_POLL.everyMs);
      else if (next === 'timeout') onUpdate({ timedOut: true });
    };
    fetchAnswer(issue.id).then(step, () => step(null));
  };
  return {
    next() { gen++; clearTimer(timer); return gen; },
    isCurrent: g => g === gen,
    follow(issue, g) { if (g === gen) poll(issue, now(), g); },
    stop() { gen++; clearTimer(timer); },
  };
}
