// 話（チャット）・会社・号の決め事（RN に依らない部分）。画面の文言は mock docs/mocks/app-chat-mock.html のもの。
// 仕様: docs/review/2026-11-14-app-chat-spec.md
import { isCommonAction, type Card } from '../card.ts';
import type { AgentDirectory, ChatAgent, ChatMessage, NotifyClient, Overview, ThreadStatus, Thread } from '../notify/client';

export const THINKING = '考えています…';
export const MAX_TEXT = 4000; // 発言は 4000 字まで（仕様 11）
export const POLL_MS = 5000; // 話を開いていて返事待ちの間だけ 5 秒おきに読み直す（仕様 7）
export const POLL_MAX_MS = 3 * 60 * 1000; // 最長 3 分で止め、あとは push と引いて読み直し

// 送る前の確かめ。送れない時は画面に出す文、送れる時は null
export const checkText = (text: string): string | null =>
  !text.trim() ? '話す中身を書いてください' : text.length > MAX_TEXT ? `発言は ${MAX_TEXT} 字までです（今 ${text.length} 字）` : null;

export const statusLabel = (s: ThreadStatus): string =>
  s === 'waiting' ? '返事待ち' : s === 'done' ? '済み' : s === 'failed' ? '返事できませんでした' : '';

const sameDay = (a: Date, b: Date) => a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();
// 「今日 10:02」「昨日」「11/12」
export function dayLabel(iso: string, now = Date.now()): string {
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return '';
  const d = new Date(t); const n = new Date(now);
  if (sameDay(d, n)) return `今日 ${d.getHours()}:${String(d.getMinutes()).padStart(2, '0')}`;
  const y = new Date(now); y.setDate(y.getDate() - 1);
  if (sameDay(d, y)) return '昨日';
  return `${d.getMonth() + 1}/${d.getDate()}`;
}

export const handedNote = (name: string) => `${name}に回した`;
export const rulesNote = (name: string) => `${name}の決まりとスキルに従って答えています`;
export const talkPlaceholder = (name: string, secretary: boolean) => `${name}に話す${secretary ? '（マイクで話して書ける）' : ''}`;

// 話の一覧の 2 行目（mock ②: 「今日 10:02・事務担当に回した・済み」）
export const threadMeta = (t: Thread, now = Date.now()): string =>
  [dayLabel(t.lastMessageAt, now), t.handedTo ? handedNote(t.handedTo) : '', statusLabel(t.status)].filter(Boolean).join('・');

// 「考えています…」を出すか: 自分の発言が最後の間（「返事できませんでした」の話へ続きを送った直後で、状態がまだ failed の時を含む）か、
// 返事待ちの間（秘書が担当に回して待つ間を含む）。失敗の発言が最後の時は出さない
export function showThinking(messages: ChatMessage[], status: ThreadStatus): boolean {
  if (messages.length === 0) return false;
  if (messages[messages.length - 1].role === 'me') return true;
  return status === 'waiting';
}

// 次の読み直しまでの時間（読み直さない時は null）。startedAt = 話を開いた・発言した時
export const nextPoll = (thinking: boolean, startedAt: number, now: number): number | null =>
  thinking && now - startedAt < POLL_MAX_MS ? POLL_MS : null;

// 読み直した発言を合わせる（同じ id は 1 つ・古い順）
export function mergeMessages(cur: ChatMessage[], add: ChatMessage[]): ChatMessage[] {
  const m = new Map<string, ChatMessage>();
  for (const x of [...cur, ...add]) m.set(x.id, x);
  return [...m.values()].sort((a, b) => Date.parse(a.at) - Date.parse(b.at));
}
export const lastAt = (messages: ChatMessage[]): string | undefined => messages[messages.length - 1]?.at;

// ---- 判断の件の「決められない — 担当と話す」（仕様 10）
export const CARD_PREFIX = '判断カードから: ';
// 前の版のアプリが書いた印（読むだけ。書くのは CARD_PREFIX）
export const CARD_PREFIX_OLD = '判断の件から: ';
export const isCardStart = (text: string): boolean => text.startsWith(CARD_PREFIX) || text.startsWith(CARD_PREFIX_OLD);
// 画面に出す時は前の印を今の印にする（前の版で始めた話の題・札。保存された記録は書き換えない）
export const showCardText = (text: string): string => text.startsWith(CARD_PREFIX_OLD) ? `${CARD_PREFIX}${text.slice(CARD_PREFIX_OLD.length)}` : text;
export const DEFAULT_ASK = 'まだ決められません。決めるのを手伝ってください。';

// 最初の発言: 件の題・要約・詳細（本文の先頭）・選択肢（説明し直さなくてよいように）。最初の行は ④ の札と話の題になる。
// 外への送信・お金・取り消せない件は詳細を入れない（題・要約・選択肢だけ）。said: カードの画面の入力欄に書いた一言（あれば最後に足す）
export function cardChatText(card: Card, said = ''): string {
  const opts = (card.options.length ? card.options : card.actions).filter(o => !isCommonAction(o.id)).map(o => `・${o.label}`).join('\n');
  const head = `${CARD_PREFIX}${card.title}`;
  const ask = said.trim() || DEFAULT_ASK;
  const tail = [opts ? `選択肢:\n${opts}` : '', card.recommendation ? `AI の推奨: ${card.recommendation}` : '', ask].filter(Boolean).join('\n\n');
  const body = card.risk === 'internal' ? (card.sections.find(x => x.text?.trim())?.text.trim() ?? '') : '';
  const summary = [card.summaryDerived ? (card.from ?? '') : card.summary, body ? `詳細:\n${body}` : ''].filter(Boolean).join('\n\n');
  const room = MAX_TEXT - head.length - tail.length - 4;
  const mid = summary.length > room ? `${summary.slice(0, Math.max(0, room - 1))}…` : summary;
  return [head, mid, tail].filter(Boolean).join('\n\n').slice(0, MAX_TEXT);
}

// 話の id から元の判断カードを探す（card に付いた話・この端末で始めた話）。見つからなければ null（もう受信箱に無い）
export function cardOfThread(cards: Card[], threadId: string | null, local: Map<string, { threadId: string }>): Card | null {
  if (!threadId) return null;
  return cards.find(c => c.thread?.id === threadId || local.get(c.id)?.threadId === threadId) ?? null;
}

// ④ の上の札（判断カードから始めた話なら、最初の発言の 1 行目）。前の版の印で始めた話も、札は今の印で出す
export function cardChip(messages: ChatMessage[]): string | null {
  const first = messages[0];
  if (first?.role !== 'me' || !isCardStart(first.text)) return null;
  return showCardText(first.text.split('\n')[0]);
}

const allAgents = (d: AgentDirectory | null): ChatAgent[] => (d?.departments ?? []).flatMap(x => x.agents);
export const findAgent = (d: AgentDirectory | null, id: string): ChatAgent | undefined => allAgents(d).find(a => a.id === id);

// 話す相手: 件を作った・依頼した担当（その会社の担当の一覧にいる時）。分からなければ秘書
export function cardAgent(card: Card, d: AgentDirectory): { id: string; name: string } {
  const by = card.requestedBy && 'agentId' in card.requestedBy ? findAgent(d, card.requestedBy.agentId) : undefined;
  if (by) return { id: by.id, name: by.name };
  return { id: d.secretaryId, name: findAgent(d, d.secretaryId)?.name ?? '秘書' };
}

export type CardChatResult = { ok: true; threadId: string; thread: Thread; agent: { id: string; name: string } } | { ok: false; message: string };
// cardId つきで新しい話を作る。開く話と担当を返す（失敗は画面に出す文）
export async function startCardChat(client: Pick<NotifyClient, 'chatAgents' | 'createThread'>, card: Card, said = ''): Promise<CardChatResult> {
  const bindingId = card.bindingId;
  if (!bindingId) return { ok: false, message: 'この判断の結びつけが分かりません' };
  let d: AgentDirectory;
  try { d = await client.chatAgents(bindingId); } catch { return { ok: false, message: '担当の一覧を読めませんでした。もう一度押してください' }; }
  const agent = cardAgent(card, d);
  if (!agent.id) return { ok: false, message: 'この会社には話せる担当がいません' };
  const r = await client.createThread(bindingId, { agentId: agent.id, text: cardChatText(card, said), cardId: card.id });
  return r.ok ? { ok: true, threadId: r.thread.id, thread: r.thread, agent } : { ok: false, message: r.message };
}

// ---- 会社（mock ③・③-2）
export type DeptRow = { key: string; name: string; summary: string; caution?: string; working: number; agents: ChatAgent[] };
// サマリーの部署に担当の一覧を合わせる。サマリーに無い部署も担当の一覧から出す
export function deptRows(ov: Overview | null, d: AgentDirectory | null): DeptRow[] {
  const agentsOf = (key: string) => d?.departments.find(x => x.key === key)?.agents ?? [];
  const rows: DeptRow[] = (ov?.departments ?? []).map(x => ({ key: x.key, name: x.name, summary: x.summary, ...(x.caution ? { caution: x.caution } : {}), working: x.working.length, agents: agentsOf(x.key) }));
  for (const x of d?.departments ?? []) if (!rows.some(r => r.key === x.key)) rows.push({ key: x.key, name: x.name, summary: '', working: 0, agents: x.agents });
  return rows;
}

// ---- 号（mock ⑥）
export const editionLabel = (edition: string) => (/号$/.test(edition.trim()) ? edition.trim() : `${edition.trim()} 号`);
export function todayMeta(today: string[]): string {
  const due = today.filter(x => x.includes('期限きょう')).length;
  return `${today.length} 件${due ? `・期限きょう ${due}` : ''}`;
}
