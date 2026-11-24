// タスクボードの計算（列・絞り込み・件数・動かした時の変更）。画面も API も持たない純粋な関数だけ。
// 設計: docs/design/2026-11-24-secretary-conversation-kanban.md §6。モック: docs/mocks/secretary-board.html
// 正本は本体の課題。状態は本体の値のまま使い、「差し戻し」だけは todo ＋ 差し戻しのラベルで表す（本体に状態が無い）

export const COLUMNS = ['todo', 'doing', 'review', 'back', 'blocked', 'done'];
export const DONE_DAYS = 7;      // 完了の列は直近 7 日だけ
export const COLUMN_FOLD = 4;    // 列の件が多い時、先に出す件数
export const LIST_FOLD = 100;    // リストで先に出す件数（数千件を一度に描かない）
const STATUS_OF = { todo: 'todo', doing: 'in_progress', review: 'in_review', back: 'todo', blocked: 'blocked', done: 'done' };

const labelIdsOf = issue => (issue.labelIds?.length ? issue.labelIds : (issue.labels || []).map(l => l.id)).map(String);

// 差し戻しのラベルを名前で探す（英語と日本語のどちらの名前で作られていても同じ物として扱う）
export function findRejectLabel(labels, names) {
  const want = new Set((names || []).map(n => String(n).trim().toLowerCase()));
  return (labels || []).find(l => want.has(String(l.name || '').trim().toLowerCase())) || null;
}

// 課題がどの列か。cancelled と、直近より古い完了は出さない（null）
export function columnOf(issue, { rejectLabelId = null, now = Date.now() } = {}) {
  const s = issue.status;
  if (s === 'cancelled') return null;
  if (s === 'done') {
    const at = Date.parse(issue.completedAt || issue.updatedAt || '');
    return Number.isFinite(at) && now - at > DONE_DAYS * 86400000 ? null : 'done';
  }
  if (s === 'blocked') return 'blocked';
  if (s === 'in_review') return 'review';
  if (s === 'in_progress') return 'doing';
  if (s === 'todo' || s === 'backlog') return rejectLabelId && labelIdsOf(issue).includes(String(rejectLabelId)) ? 'back' : 'todo';
  return null;
}

// 札を列へ動かした時に本体へ送る変更。変わらない時は null。
// 差し戻しの列へ → todo ＋ 差し戻しのラベル。差し戻しの列から出す → ラベルを外す
export function movePatch(issue, to, { rejectLabelId = null, now = Date.now() } = {}) {
  if (!COLUMNS.includes(to)) return null;
  if (columnOf(issue, { rejectLabelId, now }) === to) return null;
  if (to === 'back' && !rejectLabelId) return null; // 先に差し戻しのラベルを作ってから呼ぶ
  const before = labelIdsOf(issue);
  const rid = rejectLabelId ? String(rejectLabelId) : null;
  const without = rid ? before.filter(id => id !== rid) : before;
  const after = to === 'back' ? [...without, rid] : without;
  const patch = {};
  // backlog の課題を未着手・差し戻しの列の間で動かす時は backlog のまま（黙って todo に変えない）
  const keep = (to === 'todo' || to === 'back') && issue.status === 'backlog';
  if (!keep && STATUS_OF[to] !== issue.status) patch.status = STATUS_OF[to];
  if (after.length !== before.length || after.some((id, i) => id !== before[i])) patch.labelIds = after;
  return Object.keys(patch).length ? patch : null;
}

// すぐ絞る: decide = 持ち主が決める件（確認待ち）／ held = 差し戻し・止まっている
const QUICK = { decide: col => col === 'review', held: col => col === 'back' || col === 'blocked' };
export const QUICK_KEYS = Object.keys(QUICK);

const emptyFilter = () => ({ labels: new Set(), agents: new Set(), quick: new Set() });
export const newFilter = emptyFilter;
export const filterSize = f => f.labels.size + f.agents.size + f.quick.size;
export function toggleFilter(f, kind, value) {
  const next = { labels: new Set(f.labels), agents: new Set(f.agents), quick: new Set(f.quick) };
  if (next[kind].has(value)) next[kind].delete(value); else next[kind].add(value);
  return next;
}

// 同じ種類の中は「どれか」（すぐ絞るの 2 つも同じ）、種類の間は「どれも」。skip の種類は見ない（その種類のチップの件数を数える時に使う）
function passes(row, f, skip) {
  if (skip !== 'labels' && f.labels.size && !row.labelIds.some(id => f.labels.has(id))) return false;
  if (skip !== 'agents' && f.agents.size && !f.agents.has(row.agentId)) return false;
  if (skip !== 'quick' && f.quick.size && ![...f.quick].some(k => QUICK[k]?.(row.column))) return false;
  return true;
}

// 画面の元になる形へ。issues は本体の課題、opts.rejectLabelId は差し戻しのラベル
export function boardRows(issues, opts = {}) {
  return (issues || []).map(issue => ({ issue, id: String(issue.id), column: columnOf(issue, opts), labelIds: labelIdsOf(issue), agentId: issue.assigneeAgentId ? String(issue.assigneeAgentId) : '' }))
    .filter(r => r.column);
}

export function applyFilter(rows, f) { return rows.filter(r => passes(r, f)); }

// 列ごとの札（新しく動いた順）
export function byColumn(rows) {
  const out = Object.fromEntries(COLUMNS.map(c => [c, []]));
  for (const r of rows) out[r.column].push(r);
  for (const c of COLUMNS) out[c].sort((a, b) => String(b.issue.updatedAt || '').localeCompare(String(a.issue.updatedAt || '')));
  return out;
}

// チップの横に出す件数（自分の種類の絞り込みは外して数える。押した後に何件になるかが分かる）
export function facetCounts(rows, f) {
  const labels = {}, agents = {}, quick = Object.fromEntries(QUICK_KEYS.map(k => [k, 0]));
  for (const r of rows) {
    if (passes(r, f, 'labels')) for (const id of r.labelIds) labels[id] = (labels[id] || 0) + 1;
    if (passes(r, f, 'agents')) agents[r.agentId] = (agents[r.agentId] || 0) + 1;
    if (passes(r, f, 'quick')) for (const k of QUICK_KEYS) if (QUICK[k](r.column)) quick[k] += 1;
  }
  return { labels, agents, quick };
}

// ラベルの名前の確かめ（前後の空白を落とす・空と長すぎる物と同じ名前は断る）
export const LABEL_NAME_MAX = 30;
export function checkNewLabel(raw, labels, reserved = []) {
  const name = String(raw ?? '').trim().replace(/\s+/g, ' ');
  if (!name) return { ok: false, why: 'empty' };
  if (name.length > LABEL_NAME_MAX) return { ok: false, why: 'long' };
  const same = n => String(n || '').trim().toLowerCase() === name.toLowerCase();
  if ((labels || []).some(l => same(l.name))) return { ok: false, why: 'exists' };
  // reserved は差し戻しのラベルの名前（英語と日本語）。別の言語の名前でもう 1 つ作らせない。まだ無い会社では「もうある」と言わず、別の文を出す
  if (reserved.some(same)) return { ok: false, why: 'reserved' };
  return { ok: true, name };
}

// ラベルの色は # と 16 進だけを style に入れる（url(...) などを入れさせない）。それ以外は fallback
export const safeColor = (raw, fallback) => (/^#(?:[0-9a-f]{3,4}|[0-9a-f]{6}|[0-9a-f]{8})$/i.test(String(raw ?? '').trim()) ? String(raw).trim() : fallback);

// 携帯で出す列。人が選んだ列はそのまま出す（件が無くても）。まだ選んでいない時は、件のある最初の列
export const shownColumn = (picked, cols) => picked || COLUMNS.find(c => cols[c]?.length) || 'todo';

// 1 件を読み直した結果が課題の形か（id が合い、ラベルの並びがある）。包んだ形や空の応答を課題として扱うと、ラベルを全部消す変更を送ってしまう
export const isIssueShape = (x, id) => !!x && String(x.id) === String(id) && (Array.isArray(x.labelIds) || Array.isArray(x.labels));

// 本体が断ると分かっている動きは、送る前に理由を返す（本体 2026.1001.0 の実物で確かめた 422）:
// - 担当のいない課題は進行中にできない（in_progress issues require an assignee）
// - 止まっているにするには、止めている課題・承認などが要る（画面からは付けられない）
export function moveRefusal(issue, to) {
  if (to === 'blocked') return 'blocked_rule';
  if (to === 'doing' && !issue.assigneeAgentId && !issue.assigneeUserId) return 'need_owner';
  return null;
}
// 本体が返した断りの文から、画面に出す理由の種類を決める（知らない断りは null → 一般の文）
export function serverRefusal(err) {
  if (err?.status !== 422) return null;
  const m = String(err?.body?.error || err?.message || '');
  if (/require an assignee/i.test(m)) return 'need_owner';
  if (/Entering blocked requires/i.test(m)) return 'blocked_rule';
  return null;
}

// 画面の言語の初めの値: ブラウザの言語（セットアップの設定を読めない所でも、日本語の人には日本語で出す）
export function browserLang(nav) { return /^ja\b/i.test(String(nav?.language || '')) ? 'ja' : 'en'; }
