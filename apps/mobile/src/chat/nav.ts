// 画面の行き来（RN に依らない部分）。タブごとに画面の積み重ね（一番下がタブの画面）を持ち、タブを押すと一番下に戻る。
// 戻るの文言は 1 つ下の画面の名前（mock: 「‹ 技術」「‹ 秘書」「‹ 受信箱」）。
import { kindTitle, type Card } from '../card.ts';
import { tabLabel, type MainTab } from './labels.ts';
import type { DeptRow } from './logic';

export type Route =
  | { name: MainTab }
  | { name: 'card'; card: Card }
  | { name: 'settings' }
  | { name: 'bind'; code?: string } // code: QR（aioffice://bind?code=…）で開いた時に入れて送る
  | { name: 'dept'; key: string; title: string; row: DeptRow; color: number }
  | { name: 'history'; agentId: string; agentName: string }
  | ChatRoute;
// open: 開くたびに振る番号（画面の鍵）。話の画面は開いた時の threadId だけを読むので、別の話を開く時は必ず別の画面にする
// cardId: 判断カードから始めた話（札を押すとそのカードへ戻る）
export type ChatRoute = { name: 'chat'; agentId: string; agentName: string; threadId: string | null; open: number; cardId?: string };
export type Stack = Route[];

export const root = (tab: MainTab): Stack => [{ name: tab }];
export const push = (s: Stack, r: Route): Stack => [...s, r];
export const pop = (s: Stack): Stack => (s.length > 1 ? s.slice(0, -1) : s);
export const top = (s: Stack): Route => s[s.length - 1];
export const tabOf = (s: Stack): MainTab => s[0].name as MainTab;

const TAB_NAMES = new Set<string>(['inbox', 'secretary', 'daily', 'company']);
export const titleOf = (r: Route): string =>
  TAB_NAMES.has(r.name) ? tabLabel(r.name as MainTab)
  : r.name === 'card' ? (r.card.kind === 'decision' || r.card.kind === 'interaction' ? '判断' : kindTitle(r.card))
  : r.name === 'settings' ? '設定'
  : r.name === 'bind' ? '会社とつなぐ'
  : r.name === 'dept' ? r.title
  : r.name === 'history' ? '履歴'
  : r.name === 'chat' ? r.agentName
  : '';

export const backLabel = (s: Stack): string | null => (s.length > 1 ? `‹ ${titleOf(s[s.length - 2])}` : null);

// 話の画面を開く（開くたびに新しい番号）。積み重ねの長さ・担当が同じでも、別に開いた話は別の画面になる
let opened = 0;
export const chatRoute = (agentId: string, agentName: string, threadId: string | null, cardId?: string): ChatRoute =>
  ({ name: 'chat', agentId, agentName, threadId, open: ++opened, ...(cardId ? { cardId } : {}) });
// 話の画面の鍵: 会社・担当・開いた番号。threadId は入れない（最初の発言で話の id が付いた時に作り直さない）
export const chatKey = (officeId: string, r: ChatRoute): string => `${officeId}:${r.agentId}:${r.open}`;
// 最初の発言で作られた話の id を、今の話の画面に付ける（開いた番号はそのまま = 作り直さない）
export const withThread = (s: Stack, threadId: string): Stack => {
  const r = top(s);
  return r.name === 'chat' ? [...s.slice(0, -1), { ...r, threadId }] : s;
};
// 話の返事の通知を押した時: 秘書のタブの上に、その話を新しい画面で開く（担当が通知に無ければ名前は「担当」）
export const openThreadStack = (t: { threadId: string; agentId?: string; agentName?: string }): Stack =>
  push(root('secretary'), chatRoute(t.agentId ?? '', t.agentName ?? '担当', t.threadId));
// 判断カードから始めた話の返事の通知を押した時: 受信箱 → そのカード → 話（戻るとカード、もう一度戻ると受信箱）
export const openCardThreadStack = (card: Card, t: { threadId: string; agentId?: string; agentName?: string }): Stack =>
  [...push(root('inbox'), { name: 'card', card }), chatRoute(t.agentId ?? card.thread?.agentId ?? '', t.agentName ?? '担当', t.threadId, card.id)];
// 話の画面の札を押した時: 一つ前がそのカードなら戻る。でなければカードを積む
export const toCardFromChat = (s: Stack, card: Card): Stack => {
  const prev = s[s.length - 2];
  return prev?.name === 'card' && prev.card.id === card.id ? pop(s) : push(s, { name: 'card', card });
};
