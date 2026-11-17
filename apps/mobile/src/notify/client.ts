// notify（通知 API）との口。本物は http.ts・fake は画面の確かめ用（何も送らない）。
import type { Card } from '../card';

export type Office = { id: string; name: string; pending: number; canView: boolean };
export type Summary = { pending: number; urgent: number; resolvedToday?: { ai: number; me: number } };
export type ActResult = { ok: true } | { ok: false; message: string };

// サインインした人（サーバーが返す OIDC の人）と、つないでいる会社（会社の Paperclip との結びつけ）
export type Me = { email: string; provider: string };
export type Binding = { id: string; company: string; decisions: 'approved' | 'pending'; keyDaysLeft?: number };
export type BindStart = { ok: true; bindingId: string; company: string } | { ok: false; message: string };
export type BindState = 'waiting' | 'bound' | 'rejected' | 'expired';
export type Prefs = { approvals: boolean; decisions: boolean; quiet: { from: string; to: string } };

// 話（チャット）・担当の一覧・会社のサマリー（docs/review/2026-11-14-app-chat-spec.md の「口の形」のアプリの口）
export type ChatAgent = { id: string; name: string; role: string; blurb: string };
export type AgentDirectory = { departments: { key: string; name: string; agents: ChatAgent[] }[]; secretaryId: string };
export type ThreadStatus = 'waiting' | 'done' | 'failed';
export type Thread = { id: string; agentId: string; title: string; status: ThreadStatus; handedTo?: string; lastMessageAt: string };
export type ChatMessage = { id: string; role: 'me' | 'agent' | 'system'; text: string; at: string };
export type MessagePage = { messages: ChatMessage[]; status: ThreadStatus };
export type DailyTimes = { edition: string; url: string; today: string[]; news: string[]; events: string[] };
export type Overview = {
  departments: { key: string; name: string; summary: string; caution?: string; working: string[] }[];
  whole: { summary: string };
  dailyTimes: DailyTimes | null;
  at: string;
};
export type NewThread = { agentId: string; text: string; cardId?: string };
export type CreateThreadResult = { ok: true; thread: Thread } | { ok: false; message: string };
export type SendResult = { ok: true; sent: ChatMessage } | { ok: false; message: string };

export interface NotifyClient {
  authProvider(): Promise<string>; // サインインの方法の名前（サーバーの OIDC の設定から）
  me(): Promise<Me | null>;
  signIn(): Promise<Me | null>;
  signOut(): Promise<void>;
  listBindings(): Promise<Binding[]>;
  startBind(code: string): Promise<BindStart>;
  bindState(bindingId: string): Promise<BindState>;
  unbind(bindingId: string): Promise<ActResult>;
  prefs(): Promise<Prefs>;
  setPrefs(p: Prefs): Promise<void>;
  listOffices(): Promise<Office[]>;
  listCards(officeId: string): Promise<Card[]>;
  summary(officeId: string): Promise<Summary | null>;
  act(card: Card, actionId: string, values?: { note?: string; inputs?: Record<string, string> }): Promise<ActResult>;
  markSeen(card: Card): Promise<ActResult>;
  // 話の口。読む口は失敗を例外にする（前の画面を残す）。送る口は失敗を画面に出す文で返す
  chatAgents(bindingId: string): Promise<AgentDirectory>;
  listThreads(bindingId: string, agentId: string): Promise<Thread[]>;
  createThread(bindingId: string, input: NewThread): Promise<CreateThreadResult>;
  listMessages(bindingId: string, threadId: string, after?: string): Promise<MessagePage>;
  sendMessage(bindingId: string, threadId: string, text: string): Promise<SendResult>;
  overview(bindingId: string): Promise<Overview | null>; // まだ届いていない会社は null
}
