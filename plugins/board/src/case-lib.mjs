// 件のページの計算（担当の書いた文から「概要・決めてほしい事・私なら・なぜなら…」を取り出す・会話の並び）。画面も API も持たない。
// 設計: docs/design/2026-11-24-secretary-conversation-kanban.md §4.1。見出しの語は i18n.mjs の case_h_*（英語と日本語のどちらで書かれていても読む）

export const SECTIONS = ['summary', 'ask', 'rec', 'why', 'evidence', 'did', 'notdid', 'split'];
// 「サブタスクの案」の節の箇条（担当が「分けた方がよい事」を書いた物）。押した物だけがサブタスクになる
export const SPLIT_MAX = 8;
export function splitIdeas(text) {
  return String(text ?? '').split(/\r?\n/).map(l => l.replace(/^\s*(?:[-*・]|\d{1,2}[.)])\s*/, '').trim()).filter(l => l && l.length <= 160).slice(0, SPLIT_MAX);
}
export const SECTION_MAX = 4000;

// DICT から見出しの語の表を作る: { summary: ['summary', '概要'], … }（小文字・前後の空白なし）
export function headingTable(dict) {
  return Object.fromEntries(SECTIONS.map(k => [k, [...new Set(Object.values(dict).map(d => String(d[`case_h_${k}`] || '').trim().toLowerCase()).filter(Boolean))]]));
}

// 1 行が見出しなら、どの節かと、同じ行の続きの文を返す。形: 「## 概要」「**概要**: …」「概要: …」（全角のコロンも）
function headingOf(raw, table) {
  // 見出しの判定は、行頭の字下げ（3 桁まで）の後の先頭 120 字だけに当てる（長い行・空白の続く行で正規表現が固まらない）。
  // 続きの文は元の行から取るので、「決めてほしい事: 長い文」を 1 行で書いた件も読める
  const lead = /^[ \t]*/.exec(raw)[0];
  if (lead.length > 3) return null;
  const body = raw.slice(lead.length), head = body.slice(0, 120), ci = head.search(/[:：]/);
  if (ci < 0 && body.length > 120) return null;
  const m = /^(?:#{1,6}\s*|[-*]\s+|\d{1,2}[.)]\s+)?(?:\*\*|__)?\s*([^*_:：#]{1,40}?)\s*(?:\*\*|__)?\s*$/.exec((ci < 0 ? head : head.slice(0, ci)).replace(/[ \t]{2,}/g, ' '));
  if (!m) return null;
  const key = SECTIONS.find(k => table[k].includes(m[1].trim().toLowerCase()));
  if (!key) return null;
  // 「概要」だけの行か、「概要: 文」の行だけを見出しにする（文の途中にたまたま語がある行は見出しにしない）
  const marked = ci >= 0 || /^#{1,6}\s/.test(body) || /(\*\*|__)/.test(body);
  return marked ? { key, rest: ci < 0 ? '' : body.slice(ci + 1).trim().replace(/^(?:\*\*|__)\s*/, '').trim() } : null;
}

// 文から節を取り出す。「決めてほしい事」が無い文は件の形ではない（null）
export function parseCase(text, table) {
  // 決まり: 同じ見出しは先に出た方を使う（後ろの引用で上書きしない）・コード囲みの中は見出しとして読まない。
  // ここで拾わなかった文も、件のページの会話に元のコメントの全文が出るので、消えない
  const out = {}; let cur = null, fence = '';
  for (const line of String(text ?? '').split(/\r?\n/)) {
    const fm = /^\s{0,3}(```|~~~)/.exec(line);
    if (fm && (!fence || fence === fm[1])) { fence = fence ? '' : fm[1]; if (cur) out[cur].push(line); continue; }
    if (fence) { if (cur) out[cur].push(line); continue; }
    const hd = headingOf(line, table);
    if (hd && !(hd.key in out)) { cur = hd.key; out[cur] = hd.rest ? [hd.rest] : []; continue; }
    if (hd) { cur = null; continue; }
    if (/^\s{0,3}#{1,6}\s/.test(line)) { cur = null; continue; } // 知らない見出しで節を閉じる
    if (cur) out[cur].push(line);
  }
  const done = Object.fromEntries(Object.entries(out).map(([k, v]) => [k, v.join('\n').trim().slice(0, SECTION_MAX)]).filter(([, v]) => v));
  return done.ask ? done : null;
}

// 件の中身: 担当の書いたコメントのうち、件の形になっている一番新しい物。無ければ課題の本文。どちらも無ければ null
export function pickCase(issue, comments, table) {
  const byNew = [...(comments || [])].filter(c => c.authorAgentId && !c.deletedAt).sort((a, b) => String(b.createdAt || '').localeCompare(String(a.createdAt || '')));
  for (const c of byNew) { const p = parseCase(hideJson(c.body), table); if (p) return { ...p, from: 'comment', commentId: c.id, at: c.createdAt || null }; }
  const p = parseCase(issue?.description, table);
  return p ? { ...p, from: 'description', commentId: null, at: issue?.updatedAt || null } : null;
}

// 会話の並び（古い順）。消されたコメントは出さない。who は 'agent'（担当）・'me'（開いている人）・'person'（他の人・作者の分からない物）
export function chatItems(comments, myUserId = '') {
  return [...(comments || [])].filter(c => !c.deletedAt && String(c.body || '').trim())
    .sort((a, b) => String(a.createdAt || '').localeCompare(String(b.createdAt || '')))
    .map(c => ({ id: String(c.id), who: c.authorAgentId ? 'agent' : (myUserId && String(c.authorUserId || '') === String(myUserId) ? 'me' : 'person'), agentId: c.authorAgentId ? String(c.authorAgentId) : '', userId: c.authorUserId ? String(c.authorUserId) : '', body: String(c.body), at: c.createdAt || null }));
}

// 送る文の確かめ（空は送らない・長すぎは断る）
export const SAY_MAX = 4000;
export function checkSay(raw) {
  const body = String(raw ?? '').trim();
  if (!body) return { ok: false, why: 'empty' };
  if (body.length > SAY_MAX) return { ok: false, why: 'long' };
  return { ok: true, body };
}

// 件の id を URL の ?case= から読む・書く（札を押した先・戻るボタンで戻れる）
export function caseIdFrom(search) { const v = new URLSearchParams(String(search || '')).get('case'); return v && /^[A-Za-z0-9_-]{1,80}$/.test(v) ? v : null; }
export function caseHref(pathname, id) { return id ? `${pathname}?case=${encodeURIComponent(id)}` : pathname; }

// 秘書の画面: 「いま決めてほしい件」（確認待ち・新しい順・後回しにした件を除く）と「進めている件」に分ける
export const DESK_STEP = 12;      // 先に出す件数（件ごとにコメントを読むので、一度に全部は出さない）
export const HELD_MAX = 12;        // 「止まっている」から件の形を探す件数（件ごとにコメントを読むので絞る）
export const LATER_HOURS = 20;    // 「後で」で隠す時間（次の日の同じ頃にはまた出る）
export function deskSplit(rows, later = {}, now = Date.now()) {
  const byNew = (a, b) => String(b.issue.updatedAt || '').localeCompare(String(a.issue.updatedAt || ''));
  const review = (rows || []).filter(r => r.column === 'review').sort(byNew);
  const hidden = r => Number(later[r.id]) > now;
  // held: 担当が「止まっている」にして持ち主の番にした件の候補（担当つき・新しい順・先の HELD_MAX 件）。
  // 事務などの担当は、持ち主の操作待ちを blocked で表す。画面は、このうち件の形のコメントがある物だけを「決めてほしい件」に足す
  const heldAll = (rows || []).filter(r => r.column === 'blocked' && r.agentId);
  const held = heldAll.filter(r => !hidden(r)).sort(byNew).slice(0, HELD_MAX);
  return { decide: review.filter(r => !hidden(r)), later: [...review, ...heldAll].filter(hidden), going: (rows || []).filter(r => r.column === 'doing').sort(byNew), held };
}
// 「後で」を押した記録（id → 隠す終わりの時刻）。過ぎた記録は捨てる
export function laterAfter(later, id, now = Date.now()) {
  const keep = Object.fromEntries(Object.entries(later || {}).filter(([, until]) => Number(until) > now));
  return id ? { ...keep, [String(id)]: now + LATER_HOURS * 3600000 } : keep;
}

// 件の形で書かれていない件の、札に出す文: 担当の一番新しいコメント（無ければ課題の本文）の冒頭。
// 実物の会社で、確認待ちの新しい 40 件のうち件の形の物は 0 件だった（2026-11-24）ので、形が無くても中身が分かるようにする
export const EXCERPT_MAX = 280;
export function excerptOf(issue, comments) {
  const last = [...(comments || [])].filter(c => c.authorAgentId && !c.deletedAt && String(c.body || '').trim()).sort((a, b) => String(b.createdAt || '').localeCompare(String(a.createdAt || '')))[0];
  // 担当の文が提案の json だけの時は、課題の本文を出す
  const text = (hideJson(String(last?.body || '')) || String(issue?.description || '')).replace(/\r/g, '').replace(/\n{3,}/g, '\n\n').trim();
  return text.length > EXCERPT_MAX ? `${text.slice(0, EXCERPT_MAX)}…` : text;
}

// 秘書の見回りの提案。秘書は、コメントの最後を ```json {"proposals":[{title, detail, ask, recommend, why, evidence, deep}]} ``` で終える（秘書の plugin の決まり）。
// 読み方は秘書の plugin の parseProposals と同じにする（試験で同じ入力の結果を突き合わせる）
export const PROPOSAL_MAX = 20;
export function parseProposalList(body) {
  const blocks = [...String(body ?? '').matchAll(/```json\s*([\s\S]*?)```/gi)];
  if (!blocks.length) return null;
  let j;
  try { j = JSON.parse(blocks[blocks.length - 1][1]); } catch { return null; }
  const list = Array.isArray(j) ? j : Array.isArray(j?.proposals) ? j.proposals : null;
  if (!list) return null;
  const clip = (v, n) => (typeof v === 'string' ? v : '').replace(/\s+$/g, '').slice(0, n);
  return list.filter(x => x && typeof x === 'object' && clip(x.title, 160).trim()).slice(0, PROPOSAL_MAX).map(x => ({
    title: clip(x.title, 160).trim(), detail: clip(x.detail, 2000),
    ask: clip(x.ask, 400).trim(), recommend: clip(x.recommend, 400).trim(), why: clip(x.why, 800).trim(),
    evidence: (Array.isArray(x.evidence) ? x.evidence : []).map(e => clip(e, 300)).filter(Boolean).slice(0, 5),
  }));
}
// 秘書の見回りの課題（origin が秘書の plugin の見回り）の、秘書本人（課題の担当）の一番新しい json つきのコメントの提案。
// 見回りでない課題・他の担当のコメントは読まない。新しい回が「提案なし」なら、古い提案へさかのぼらない（秘書の plugin の proposalsFrom と同じ）
export const ROUND_ORIGIN = 'plugin:aioffice.secretary:round';
export function proposalsOf(issue, comments) {
  if (issue?.originKind !== ROUND_ORIGIN || !issue.assigneeAgentId) return null;
  const byNew = [...(comments || [])].filter(c => c.authorAgentId && String(c.authorAgentId) === String(issue.assigneeAgentId) && !c.deletedAt).sort((a, b) => String(b.createdAt || '').localeCompare(String(a.createdAt || '')));
  for (const c of byNew) { const list = parseProposalList(c.body); if (list) return list.length ? list : null; }
  return null;
}
// 人に見せる文から、提案の json の囲み（最後の囲みが提案として読める時の、その囲み）だけを外す。他の json は消さない
export function hideJson(text) {
  const t = String(text ?? '');
  const all = [...t.matchAll(/```json\s*([\s\S]*?)```/gi)], last = all[all.length - 1];
  if (!last) return t.trim();
  let j;
  try { j = JSON.parse(last[1]); } catch { return t.trim(); }
  // 外すのは、提案として読める囲み（parseProposalList が 1 件以上を返す = 秘書の plugin が子の課題にする物）と、「提案なし」の {"proposals":[]} だけ。id の配列や他の json は人に見せる
  const list = parseProposalList(t);
  const shaped = (!!list && list.length > 0) || (!!j && typeof j === 'object' && !Array.isArray(j) && Array.isArray(j.proposals) && j.proposals.length === 0 && Object.keys(j).length === 1);
  if (!shaped) return t.trim();
  return (t.slice(0, last.index) + t.slice(last.index + last[0].length)).replace(/\n{3,}/g, '\n\n').trim();
}
// 「これを進める」で残す一言（番号と題を入れる。題の中の $ や {title} はそのままの文字として入れる）
export function doComment(template, n, title) { return String(template).replace(/\{n\}|\{title\}/g, m => (m === '{n}' ? String(n) : String(title))); }

// 「進める」は、未着手に戻す更新と持ち主の一言を 1 回の更新で送る。
// コメントと状態を別々に送ると、本体が担当を 2 回起こす（確認待ちの件への人のコメントだけで 1 回・未着手に戻してもう 1 回）。1 回なら、一言だけ書けて状態が変わらない半端も起きない
export const goPatch = comment => ({ status: 'todo', comment: String(comment || '') });
// 受け入れる限界: 本体は更新したのに返事を受け取れなかった時、押し直すと一言が 2 つになる
// 送った後に、件が持ち主の番を離れたか（本体は未着手にした後、担当が拾うと進行中にする）
export const goDone = res => ['todo', 'in_progress'].includes((res?.issue || res)?.status);
// 「止まっている」の件を持ち主の番として出してよいか: 件の形が担当のコメントから取れていて、そのコメントが課題の（消されていない）一番新しいコメントである時だけ。
// 答え済みの古い件・別の理由で止めた件・本文だけが件の形の件は出さない
export function isOpenAsk(kase, comments) {
  if (!kase || kase.from !== 'comment' || !kase.commentId) return false;
  const last = [...(comments || [])].filter(c => !c.deletedAt && String(c.body || '').trim()).sort((a, b) => String(b.createdAt || '').localeCompare(String(a.createdAt || '')))[0];
  return !!last && String(last.id) === String(kase.commentId);
}

// 取り下げる（件カード）: 出すのは確認待ちの件だけ。「止まっている」の件は担当の作業そのものなので出さない（開いて話す）。
// 提案が 2 つ以上まとまった古い形のカードも出さない（課題ごと全部の提案が消える）。読み終わる前（c が無い）・コメントを読めなかった時（古い形かどうかが分からない）も出さない
export const canDrop = (r, c) => !!r && !!c && !c.failed && r.column !== 'blocked' && !(c.props && c.props.length > 1);
// 取り消しと持ち主の一言を 1 回の更新で送る（別々に送ると、取り消した件へのコメントが件を未着手に戻す）
export const dropPatch = comment => ({ status: 'cancelled', comment: String(comment || '') });
// 本体の返事で、取り消しになった事を確かめる
export const dropDone = res => (res?.issue || res)?.status === 'cancelled';

// ── サブタスクと会話の画面（会話の画面の標準 docs/design/2026-11-25-chat-screen-standard.md・モック docs/mocks/case-subtasks.html）
// 3-1: 最初に出す発言の数。古い物は「前の n 個の発言を見る」で読み足す
export const FIRST_MESSAGES = 20;
export const firstShown = (count, shown) => Math.max(0, Number(count || 0) - Math.max(0, Number(shown || 0)));

// 子孫の課題（descendantOf で読んだ物）を、すぐ下の子と、その下の数に分ける。取り消した課題は数えない
export function subtaskTree(rootId, issues) {
  const live = (issues || []).filter(i => i && i.id && i.status !== 'cancelled' && String(i.id) !== String(rootId));
  const kidsOf = id => live.filter(i => String(i.parentId || '') === String(id));
  const below = id => kidsOf(id).flatMap(k => [k, ...below(k.id)]);
  const kids = kidsOf(rootId).sort((a, b) => String(a.createdAt || '').localeCompare(String(b.createdAt || '')));
  return {
    kids: kids.map(k => { const b = below(k.id); return { issue: k, below: b.length, belowDone: b.filter(x => x.status === 'done').length }; }),
    done: kids.filter(k => k.status === 'done').length,
    all: below(rootId).length,
  };
}

// 5-2・5-3: PC は Enter で送る（Shift+Enter は改行・日本語の変換を確定する Enter では送らない）。携帯は改行キーで改行し、送るボタンだけで送る
export const enterSends = (e, touch) => !touch && e?.key === 'Enter' && !e.shiftKey && !e.isComposing && e.keyCode !== 229;

// 5-4: 添付の上限（本体の既定と同じ 10MB・1 回に 8 個まで）
export const ATTACH_MAX_BYTES = 10 * 1024 * 1024;
export const ATTACH_MAX_FILES = 8;
// 足す物のうち、受けられる物と断る物（大きすぎ・空・数の超過）に分ける
export function attachSplit(current, adding) {
  const ok = [], ng = [];
  for (const f of adding || []) {
    if (!f || !(f.size > 0)) ng.push({ name: f?.name || '', why: 'empty' });
    else if (f.size > ATTACH_MAX_BYTES) ng.push({ name: f.name, why: 'big' });
    else if ((current?.length || 0) + ok.length >= ATTACH_MAX_FILES) ng.push({ name: f.name, why: 'many' });
    else ok.push(f);
  }
  return { ok, ng };
}
// 送る文に、添付した物の名前を足す（担当が課題の添付と結び付けられるように）
export function withAttachNote(body, names, label) {
  const list = (names || []).filter(Boolean);
  const text = String(body || '').trim();
  if (!list.length) return text;
  return `${text}${text ? '\n\n' : ''}${label} ${list.join('、')}`;
}

// 「完了にして親に返す」: 子は完了にして決まった事を書き、親の会話に「サブタスク『題』が完了: 決まった事」を書く
export const RESULT_MAX = 1000;
export function checkResult(raw) {
  const v = String(raw ?? '').trim();
  if (!v) return { ok: false, why: 'empty' };
  if (v.length > RESULT_MAX) return { ok: false, why: 'long' };
  return { ok: true, body: v };
}
export const childDonePatch = (label, result) => ({ status: 'done', comment: `${label} ${String(result || '').trim()}` });
export const parentNote = (template, title, result) => String(template).replace(/\{title\}|\{result\}/g, m => (m === '{title}' ? String(title) : String(result)));

// 3-3: 担当の書いた Markdown を、HTML を通さずに描くための塊に分ける（見出し・箇条・番号・引用・表・コード・段落）。
// 文字は全部「文字」として扱い、画面は React の要素で組み立てる（担当の文を HTML として解釈しない）
export function mdBlocks(text) {
  const out = [], lines = String(text ?? '').replace(/\r/g, '').split('\n');
  let i = 0;
  const isTable = l => /^\s*\|.*\|\s*$/.test(l);
  const cells = l => l.trim().replace(/^\||\|$/g, '').split('|').map(c => c.trim());
  while (i < lines.length) {
    const l = lines[i];
    const fence = /^\s{0,3}(```|~~~)/.exec(l);
    if (fence) { const body = []; i++; while (i < lines.length && !lines[i].trim().startsWith(fence[1])) body.push(lines[i++]); i++; out.push({ type: 'code', text: body.join('\n') }); continue; }
    if (!l.trim()) { i++; continue; }
    const hd = /^\s{0,3}(#{1,6})\s+(.*)$/.exec(l);
    if (hd) { out.push({ type: 'h', level: hd[1].length, text: hd[2].replace(/\s+#+\s*$/, '') }); i++; continue; }
    if (isTable(l) && i + 1 < lines.length && /^\s*\|?\s*:?-{2,}/.test(lines[i + 1])) {
      const rows = [cells(l)]; i += 2; while (i < lines.length && isTable(lines[i])) rows.push(cells(lines[i++]));
      out.push({ type: 'table', rows }); continue;
    }
    const bullet = /^\s*(?:[-*+・])\s+(.*)$/, num = /^\s*\d{1,3}[.)]\s+(.*)$/;
    if (bullet.test(l) || num.test(l)) {
      const kind = bullet.test(l) ? 'ul' : 'ol', re = kind === 'ul' ? bullet : num, items = [];
      while (i < lines.length && re.test(lines[i])) items.push(re.exec(lines[i++])[1]);
      out.push({ type: kind, items }); continue;
    }
    if (/^\s*>\s?/.test(l)) { const q = []; while (i < lines.length && /^\s*>\s?/.test(lines[i])) q.push(lines[i++].replace(/^\s*>\s?/, '')); out.push({ type: 'quote', text: q.join('\n') }); continue; }
    const p = []; while (i < lines.length && lines[i].trim() && !/^\s{0,3}(```|~~~|#{1,6}\s)/.test(lines[i]) && !bullet.test(lines[i]) && !num.test(lines[i]) && !/^\s*>/.test(lines[i]) && !isTable(lines[i])) p.push(lines[i++]);
    out.push({ type: 'p', text: p.join('\n') });
  }
  return out;
}
// 行の中の **太字** と `コード` を分ける（ほかの記号は文字のまま）
export function mdInline(text) {
  const out = [], re = /\*\*([^*\n]+)\*\*|`([^`\n]+)`/g; let last = 0, m;
  const s = String(text ?? '');
  while ((m = re.exec(s))) { if (m.index > last) out.push({ t: 'text', v: s.slice(last, m.index) }); out.push(m[1] != null ? { t: 'b', v: m[1] } : { t: 'code', v: m[2] }); last = re.lastIndex; }
  if (last < s.length) out.push({ t: 'text', v: s.slice(last) });
  return out;
}

// 3-4: 時刻（HH:mm）と日付の区切り（今日・昨日・月日）
export const hhmm = at => { const d = new Date(at); return Number.isNaN(d.getTime()) ? '' : `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`; };
export function dayKey(at) { const d = new Date(at); return Number.isNaN(d.getTime()) ? '' : `${d.getFullYear()}-${d.getMonth() + 1}-${d.getDate()}`; }
export function dayLabel(at, now, words) {
  const d = new Date(at); if (Number.isNaN(d.getTime())) return '';
  const n = new Date(now), y = new Date(n.getFullYear(), n.getMonth(), n.getDate() - 1);
  if (dayKey(d) === dayKey(n)) return words.today;
  if (dayKey(d) === dayKey(y)) return words.yesterday;
  return String(words.date).replace('{m}', String(d.getMonth() + 1)).replace('{d}', String(d.getDate())).replace('{y}', String(d.getFullYear()));
}

// 2-1: 未読の区切り。開いた時点の既読の時刻より後の、自分以外の最初の発言の id（区切りは開いている間は動かさない）
export function firstUnread(chat, readAt) {
  if (!readAt) return null;
  const hit = (chat || []).find(m => m.who !== 'me' && String(m.at || '') > String(readAt));
  return hit ? hit.id : null;
}
// 3-1 と 2-2: 表示の始まりを id で持つ（新しい発言が来ても、上の発言を消さない）。見つからなければ新しい方の n 個
export function startIndex(chat, startId, first = FIRST_MESSAGES) {
  const at = startId ? (chat || []).findIndex(m => m.id === startId) : -1;
  return at >= 0 ? at : Math.max(0, (chat?.length || 0) - first);
}

// 1-1: タスクのページの高さ。画面の高さから、ページの上端と、画面の下に固定された外の物（本体の携帯の下のメニューなど）を除く。
// covers は画面の下端に重なっている固定の物の上端（px）の並び。どれも無ければ画面の下端まで使う
export const PAGE_MIN_H = 320;
export function fitHeight({ viewH, top, covers = [] }) {
  const tops = covers.filter(x => Number.isFinite(x) && x > 0 && x < viewH);
  const bottom = Math.min(viewH, ...tops);
  return Math.max(PAGE_MIN_H, Math.floor(bottom - Math.max(0, top || 0) - 8));
}
