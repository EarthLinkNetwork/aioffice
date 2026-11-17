// 承認を card の型（v1）にする（通信しない・test は ops/test/mobile-plugin.test.mjs）。
// card: { v, id, kind, risk, title, summary, recommendation, options[], deadline, sections[], links[], createdAt, requestedBy }
// risk: internal | external-send | money | irreversible。payload.risk があればそれ、無ければ送る本文・宛先の項目（sendKeys）があれば external-send。
export const RISKS = ['internal', 'external-send', 'money', 'irreversible'];
export const DEFAULT_SEND_KEYS = ['replyBody', 'body', 'to', 'targetUrl', 'channel'];
const str = (v, n = 4000) => (typeof v === 'string' ? v : v == null ? '' : typeof v === 'number' || typeof v === 'boolean' ? String(v) : '').slice(0, n);
// お金の判定。担当が risk を書き忘れても、費用の判断を通知のボタンで押させない。
// 金額の形（$1・5 米ドル・300 円）は題・本文・選択肢のどこでも見る。言葉（費用・購入など）は題と選択肢だけ見る（本文の「購入できません」「費用の記載はありません」で誤って当たったため・2026-11-10）。
export const AMOUNT_RE = /[$¥€£]\s?\d|\d[\d,.]*\s?(USD|JPY|EUR|ドル|米ドル|円)/i;
export const MONEY_WORD_RE = /費用|課金|請求|支払|購入|料金|cost|price|billing|purchase|payment/i;
const moneyIn = (heads, bodies) => heads.some(x => AMOUNT_RE.test(str(x, 20000)) || MONEY_WORD_RE.test(str(x, 2000))) || bodies.some(x => AMOUNT_RE.test(str(x, 20000)));
const COMMON = new Set(['title', 'summary', 'recommendation', 'options', 'deadline', 'risk']);

export function riskOf(payload, sendKeys = DEFAULT_SEND_KEYS) {
  if (RISKS.includes(payload?.risk)) return payload.risk;
  if (sendKeys.some(k => str(payload?.[k]).trim())) return 'external-send';
  return moneyIn([payload?.title, JSON.stringify(payload?.options || '')], [payload?.summary, payload?.recommendation]) ? 'money' : 'internal';
}

export function approvalToCard(a, { sendKeys = DEFAULT_SEND_KEYS } = {}) {
  const p = a.payload && typeof a.payload === 'object' ? a.payload : {};
  const risk = riskOf(p, sendKeys);
  const sections = [];
  const sendBody = sendKeys.map(k => [k, str(p[k])]).find(([k, v]) => v.trim() && !/^https?:\/\//.test(v) && k !== 'to' && k !== 'channel');
  if (risk !== 'internal' && sendBody) sections.push({ kind: 'outgoing', label: 'Outgoing text', text: sendBody[1] });
  for (const [k, v] of Object.entries(p)) {
    if (COMMON.has(k) || (sendBody && k === sendBody[0])) continue;
    const t = str(v, 600);
    if (t && !/^https?:\/\//.test(t)) sections.push({ kind: 'field', label: k, text: t });
  }
  const links = Object.entries(p).filter(([, v]) => typeof v === 'string' && /^https?:\/\//.test(v)).map(([k, v]) => ({ label: k, url: v }));
  const options = Array.isArray(p.options) ? p.options.map(o => (typeof o === 'string' ? { id: o, label: o } : { id: str(o?.id ?? o?.value ?? o?.label, 80), label: str(o?.label ?? o?.id, 120) })).filter(o => o.id) : [];
  return {
    v: 1, id: a.id, kind: 'approval', risk,
    title: str(p.title, 200) || str(a.type, 80), summary: str(p.summary, 2000), recommendation: str(p.recommendation, 1000),
    options, deadline: str(p.deadline, 40) || null, sections, links,
    createdAt: a.createdAt || null, requestedBy: a.requestedByAgentId ? { agentId: a.requestedByAgentId } : a.requestedByUserId ? { userId: a.requestedByUserId } : null,
    actions: [{ id: 'approve', label: 'Approve' }, { id: 'reject', label: 'Reject', needsNote: true }],
  };
}

// 新しい順・期限の近い順は app 側でも並べ替えられるよう、ここでは作成の新しい順だけにする。
export const inbox = (approvals, opts) => approvals.filter(a => a.status === 'pending').map(a => approvalToCard(a, opts)).sort((x, y) => String(y.createdAt).localeCompare(String(x.createdAt)));

// 判断カード（Paperclip 本体の decisions・選択肢と入力欄つき）を card の型（v1）にする。
// 本体の SDK には判断カードを読む口が無いので、アプリは本体の口（GET /api/companies/:id/decisions?status=open・POST /api/decisions/:id/decide）を
// ログインした本人の名義でそのまま呼び、この関数で card にする（plugin とアプリで同じ部品を使う）。
// risk: metadata.risk があればそれ、無ければお金の言葉があれば money、それ以外は internal（効き目は課題へのコメント・担当を起こすなど社内のもの）。
export function decisionToCard(d) {
  const m = d.metadata && typeof d.metadata === 'object' ? d.metadata : {};
  const opts = Array.isArray(d.options) ? d.options : [];
  const inputs = Array.isArray(d.inputs) ? d.inputs : [];
  return {
    v: 1, id: d.id, kind: 'decision', risk: RISKS.includes(m.risk) ? m.risk : moneyIn([d.title, opts.map(o => o.label).join(' ')], [d.body]) ? 'money' : 'internal',
    title: str(d.title, 200), summary: '', recommendation: str(m.recommendation, 1000),
    options: opts.map(o => ({ id: str(o.id, 120), label: str(o.label, 200), style: ['primary', 'default', 'destructive'].includes(o.style) ? o.style : 'default' })).filter(o => o.id),
    inputs: inputs.map(i => ({ id: str(i.id, 120), label: str(i.label, 200), required: !!i.required, maxLength: Number.isFinite(i.maxLength) ? i.maxLength : 20000 })).filter(i => i.id),
    deadline: d.expiresAt || null,
    sections: str(d.body).trim() ? [{ kind: 'body', label: 'Details', text: str(d.body, 20000) }] : [],
    links: [], createdAt: d.createdAt || null,
    requestedBy: d.originAgentId ? { agentId: d.originAgentId } : null,
    origin: d.originIssueId ? { issueId: d.originIssueId } : null,
    actions: opts.map(o => ({ id: str(o.id, 120), label: str(o.label, 200) })).filter(a => a.id),
  };
}

// 課題ごとの判断カード（issue-thread interactions）を card の型（v1）にする。
// 確認（request_confirmation）は SDK の respondInteraction（accept / reject）で答える。
// 質問（ask_user_questions）は、問いが 1 つで 1 つを選ぶ形だけを card にし、答えは押した本人の会社ごとの key で本体の respond の口に渡す
// （SDK に答えの中身を渡す口が無いため・回覧の設計 docs/design/2026-11-21-office-relay.md 2.1-3・3 節 P3）。問いが 2 つ以上・複数を選ぶ形は web で答える。
export const INTERACTION_KINDS = ['request_confirmation', 'ask_user_questions'];
export const QUESTION_OTHER = 'otherText'; // 自由に書く選択肢の入力欄の id
export function questionOf(i) {
  const qs = Array.isArray(i?.payload?.questions) ? i.payload.questions : [];
  if (qs.length !== 1) return null;
  const q = qs[0];
  if (!q || q.selectionMode !== 'single' || typeof q.id !== 'string' || !q.id.trim() || q.id.length > 160 || !Array.isArray(q.options) || !q.options.length) return null;
  return q;
}
export function interactionToCard(i) {
  if (i?.kind === 'ask_user_questions') return questionToCard(i);
  const p = i.payload && typeof i.payload === 'object' ? i.payload : {};
  const title = str(i.title, 200) || str(p.prompt, 200);
  const details = str(p.detailsMarkdown, 20000);
  const prompt = str(p.prompt, 4000);
  const sections = [];
  if (prompt && prompt !== title) sections.push({ kind: 'body', label: 'Question', text: prompt });
  if (details.trim()) sections.push({ kind: 'body', label: 'Details', text: details });
  const accept = str(p.acceptLabel, 120) || 'Accept';
  const reject = str(p.rejectLabel, 120) || 'Reject';
  return {
    v: 1, id: i.id, kind: 'interaction',
    risk: moneyIn([title, accept, reject], [prompt, details]) ? 'money' : 'internal',
    title, summary: str(i.summary, 2000), recommendation: '',
    options: [], deadline: null, sections, links: [],
    createdAt: i.createdAt ? new Date(i.createdAt).toISOString() : null,
    requestedBy: i.createdByAgentId ? { agentId: i.createdByAgentId } : null,
    origin: i.issueId ? { issueId: i.issueId } : null,
    actions: [{ id: 'accept', label: accept }, { id: 'reject', label: reject, ...(p.rejectRequiresReason ? { needsNote: true } : {}) }],
  };
}

function questionToCard(i) {
  const q = questionOf(i);
  if (!q) return null;
  const title = str(i.title, 200) || str(q.prompt, 200);
  // カードにできない形は web に回す: id が長い・空・共通の操作（aio:）と重なる、ラベルが空、自由に書く選択肢が 2 つ以上（入力欄は 1 つだけ・PR #108 のレビュー）
  const raw = q.options;
  if (raw.some(o => typeof o?.id !== 'string' || !o.id.trim() || o.id.length > 160 || o.id.startsWith('aio:') || !str(o?.label).trim())) return null;
  if (raw.filter(o => o?.freeText).length > 1) return null;
  const opts = raw.map(o => ({ id: o.id, label: str(o.label, 200), free: !!o.freeText, description: str(o?.description, 600) }));
  const free = opts.find(o => o.free) || null;
  const sections = [];
  if (str(q.prompt) && str(q.prompt) !== title) sections.push({ kind: 'body', label: 'Question', text: str(q.prompt, 4000) });
  if (str(q.helpText).trim()) sections.push({ kind: 'body', label: 'Details', text: str(q.helpText, 4000) });
  const described = opts.filter(o => o.description).map(o => `${o.label}: ${o.description}`).join('\n');
  if (described) sections.push({ kind: 'body', label: 'Options', text: described });
  return {
    v: 1, id: i.id, kind: 'interaction',
    risk: moneyIn([title, opts.map(o => o.label).join(' ')], [q.prompt, q.helpText]) ? 'money' : 'internal',
    title, summary: str(i.summary, 2000), recommendation: '',
    options: opts.map(o => ({ id: o.id, label: o.label, style: 'default' })),
    // 自由に書く選択肢があれば入力欄を 1 つ付ける（選択肢がそれだけなら必須）
    inputs: free ? [{ id: QUESTION_OTHER, label: free.label, required: opts.length === 1, maxLength: 20000 }] : [],
    question: { id: q.id, free: free ? free.id : null },
    deadline: null, sections, links: [],
    createdAt: i.createdAt ? new Date(i.createdAt).toISOString() : null,
    requestedBy: i.createdByAgentId ? { agentId: i.createdByAgentId } : null,
    origin: i.issueId ? { issueId: i.issueId } : null,
    addressee: i.addresseeUserId || null,
    actions: opts.map(o => ({ id: o.id, label: o.label })),
  };
}

// 会社ごとの判断の key が無い人へのお知らせ（押す操作なし・その人の受信箱にだけ置く・push しない）。
// state: none（まだ承認していない）| expiring（自動の更新に失敗し、期限が近い）| lost（切れた・失効した）
export function keyNoticeCard({ id, state, daysLeft, companyName, href, day = null }) {
  const co = companyName ? `${str(companyName, 120)} の` : 'この会社の';
  const title = state === 'expiring' ? `お知らせ：あと ${daysLeft} 日で会社ごとの判断を受けられなくなります`
    : state === 'lost' ? 'お知らせ：判断を受けるには承認し直してください'
      : 'お知らせ：会社ごとの判断を受けるには承認が要ります';
  const summary = state === 'expiring' ? `${co}会社ごとの判断を受けるための承認の自動の更新に失敗しました。Paperclip で承認し直してください。`
    : state === 'lost' ? `${co}会社ごとの判断を受けるための承認が切れました。今は承認・判断カードだけが届いています。`
      : `${co}会社ごとの判断を受けるには、Paperclip で 1 回承認が要ります。今は承認・判断カードだけが届いています。`;
  const steps = { kind: 'steps', label: 'すること', text: 'Paperclip の「AI Office」の画面を開く\n「判断を受けるために承認する」を押し、出てきた画面で承認する', ...(typeof href === 'string' && /^https:\/\//.test(href) ? { url: { label: 'Paperclip で開く', href } } : {}) };
  return {
    v: 1, id, kind: 'notice', risk: 'internal', title, summary, recommendation: '',
    options: [], deadline: null, sections: [steps], links: [], createdAt: null, requestedBy: null, actions: [],
    // 日本時間の日。閉じても（見たにしても）翌日は版が変わって受信箱に戻る（承認するまで毎日 1 回出す）
    day: typeof day === 'string' ? day : null,
  };
}

// ---- 送る card の飾り（docs/design/2026-11-22-app-card-ux.md 2.0〜2.6） ----
// 元の card（本体の中身だけ）に、受け取る人ごとの飾りを足す。押した操作が古いかの照合は元の card の hash で行う（relay.mjs）。
// 共通の操作の id は 'aio:' で始め、本体の選択肢（担当が自由に付ける id）と分ける。
export const AIO = { none: 'aio:none', resolve: 'aio:resolve', refresh: 'aio:refresh' };
export const isCommonAction = id => typeof id === 'string' && id.startsWith('aio:');
const RISK_WORD = { 'external-send': '外への送信', money: 'お金', irreversible: '取り消せない' };
const SUMMARY_MAX = 160;
const oneLine = t => str(t, 20000).replace(/\s+/g, ' ').trim();
const clip = (t, n) => (t.length <= n ? t : `${t.slice(0, n - 1)}…`);

// 要約の中身の行: 本体の要約、無ければ本文の最初の節の先頭。外への送信・お金・取り消せない件は本文を入れない（ロック画面に出るため）
export function summaryLineOf(base) {
  const own = oneLine(base.summary);
  if (own) return { text: clip(own, 2000), derived: false };
  if (base.risk && base.risk !== 'internal') return { text: `（${RISK_WORD[base.risk] || '確かめの要る'}の件です。開いて確かめてください）`, derived: true };
  // 本文の節（kind 'body'）だけを使う。承認の項目（field）や送る本文（outgoing）は使わない。金額の形があれば伏せる（ロック画面に出るため）
  const first = (base.sections || []).filter(x => x?.kind === 'body').map(x => oneLine(x?.text)).find(Boolean) || '';
  if (first && AMOUNT_RE.test(first)) return { text: '（お金の件です。開いて確かめてください）', derived: true };
  return { text: clip(first, SUMMARY_MAX), derived: !!first };
}

// 日本時間の「HH:MM」（同じ入力なら同じ出力）
const jstHm = ms => { const d = new Date(ms + 9 * 3600 * 1000); return `${String(d.getUTCHours()).padStart(2, '0')}:${String(d.getUTCMinutes()).padStart(2, '0')}`; };
export const jstDay = ms => new Date(ms + 9 * 3600 * 1000).toISOString().slice(0, 10);

export function commonActionsOf(base) {
  const issue = !!base.origin?.issueId;
  if (base.kind === 'decision') return [
    { id: AIO.none, label: 'どれでもない（理由を書いて返す）', needsNote: true },
    { id: AIO.resolve, label: '解決にする' },
    ...(issue ? [{ id: AIO.refresh, label: '判断を最新にする' }] : []),
  ];
  // 確認の件には「最新にする」を付けない（担当が古い確認を取り消す口が無く、古い確認と新しい確認が並んで残るため）
  // 質問は、自由に書く選択肢がある時だけ「どれでもない」（理由をその答えの文にする）。無い時は選択肢から選ぶ
  if (base.kind === 'interaction' && base.question) return base.question.free ? [{ id: AIO.none, label: 'どれでもない（理由を書いて返す）', needsNote: true }] : [];
  if (base.kind === 'interaction') return [
    { id: AIO.none, label: 'どれでもない（理由を書いて返す）', needsNote: true },
  ];
  return [];
}

// thread: その人の話 { id, agentId }・conclusion: その人の話の「結論:」の行・refreshingAt: 「最新にする」を押した時刻（ms）
export function decorate(base, { companyName = null, agentName = null, thread = null, conclusion = null, refreshingAt = null } = {}) {
  const from = [oneLine(companyName), base.kind === 'notice' ? '' : oneLine(agentName)].filter(Boolean).join(' · ');
  const line = summaryLineOf(base);
  const summary = [from, line.text].filter(Boolean).join('\n');
  const status = base.kind === 'notice' ? null
    : Number.isFinite(refreshingAt) ? { state: 'refreshing', text: `最新にしています（${jstHm(refreshingAt)} に頼みました）` }
      : conclusion ? { state: 'talked', text: `話の結論: ${clip(oneLine(conclusion), 200)}` }
        : { state: 'open', text: '未解決' };
  return {
    ...base,
    from: from || null,
    summary,
    summaryDerived: line.derived,
    status,
    thread: thread && thread.id ? { id: String(thread.id), agentId: thread.agentId ? String(thread.agentId) : null } : null,
    actions: [...(base.actions || []), ...commonActionsOf(base)],
  };
}

// 話の課題のコメントから、担当の最後の「結論:」の行を取る。人の最後の発言より前の結論は出さない（人が続きを書いたら、結論はまだ）。無ければ null
export const CONCLUSION_RE = /^\s*結論\s*[:：]\s*(.+)/;
// 本体の plugin の listComments は新しい順で返すので、作った時刻（同じなら id）で古い順に並べ直してから見る
export function conclusionOf(comments) {
  const t = c => { const x = Date.parse(c?.createdAt); return Number.isFinite(x) ? x : 0; };
  const list = (Array.isArray(comments) ? comments : []).map((c, i) => ({ c, i })).sort((a, b) => t(a.c) - t(b.c) || String(a.c?.id ?? '').localeCompare(String(b.c?.id ?? '')) || a.i - b.i).map(x => x.c);
  for (let i = list.length - 1; i >= 0; i--) {
    const c = list[i];
    if (c?.authorType === 'user') return null;
    if (c?.authorType !== 'agent' || typeof c.body !== 'string') continue;
    const m = c.body.split('\n').map(l => l.match(CONCLUSION_RE)).find(Boolean);
    if (m) return clip(oneLine(m[1]), 200);
  }
  return null;
}
