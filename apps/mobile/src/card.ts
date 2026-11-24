// card の型（v1）。plugin の plugins/mobile/src/cards.mjs が作るものと同じ形。
// アプリは中身の意味を知らず、この型を描くだけにする（新しい種類が増えてもアプリの版を上げない）。
export type Risk = 'internal' | 'external-send' | 'money' | 'irreversible';
export type CardKind = 'approval' | 'decision' | 'interaction' | string;

// fields: 差出人・件名・宛先などの見出しと値（mock の .kv）。url: その欄から元を開く（例: メールで開く）
export type CardSection = { kind: 'outgoing' | 'body' | 'field' | 'original' | 'caution' | string; label: string; text: string; fields?: { label: string; value: string }[]; url?: { label: string; href: string } };
export type CardOption = { id: string; label: string; style?: 'primary' | 'default' | 'destructive'; note?: string };
export type CardInput = { id: string; label: string; required: boolean; maxLength: number };
export type CardAction = { id: string; label: string; needsNote?: boolean };
// サーバーが付ける見出しの札（例: 「SNS の通知」）。アプリは色の種類だけを知る。
export type CardTag = { tone: 'urgent' | 'money' | 'sns' | 'ok'; label: string };

export type Card = {
  v: 1;
  id: string;
  kind: CardKind;
  risk: Risk;
  title: string;
  summary: string;
  recommendation: string;
  options: CardOption[];
  inputs?: CardInput[];
  deadline: string | null;
  sections: CardSection[];
  links: { label: string; url: string }[];
  createdAt: string | null;
  actions: CardAction[];
  tags?: CardTag[];
  ref?: string; // 元の課題の番号など（一覧の 2 行目に出す）
  bindingId?: string; // サーバーが付ける。どの会社の結びつけの件か（押す・見たにする時の宛先）
  requestedBy?: { agentId: string } | { userId: string } | null; // 件を作った・依頼した担当（「決められない — 担当と話す」の相手）
  origin?: { issueId: string } | null; // 元の課題
  // 送る card の飾り（plugin が人ごとに付ける・docs/design/2026-11-22-app-card-ux.md 2.0）
  from?: string | null; // 「会社 · 担当」
  summaryDerived?: boolean; // 要約が本文の先頭から作ったもの（画面では本文と 2 回出さない）
  status?: CardStatus | null; // 未解決・話の結論・最新にしています
  thread?: { id: string; agentId: string | null } | null; // この人がこの件で始めた話
  day?: string | null; // お知らせの日（閉じても翌日また出る形の印）
};
export type CardStatus = { state: 'open' | 'talked' | 'refreshing' | string; text: string };

// 共通の操作（どれでもない・解決にする・判断を最新にする）。本体の選択肢と混ぜずに別の並びに出す
export const isCommonAction = (id: string) => id.startsWith('aio:');
export const commonActions = (c: Card): CardAction[] => c.actions.filter(a => isCommonAction(a.id));
// 画面に出す要約: 頭の「会社 · 担当」は別の行に出すので外す。本文の先頭から作った要約は出さない（本文と 2 回出さない）
export function shownSummary(c: Card): string {
  if (c.summaryDerived) return '';
  const s = c.summary || '';
  return c.from && s.startsWith(`${c.from}\n`) ? s.slice(c.from.length + 1) : c.from && s === c.from ? '' : s;
}

// 外への送信・お金・取り消せない件は、開いて全文を見てから決める（一覧から見たにしない・確かめの画面を挟む）
export const isGuarded = (c: Card) => c.risk !== 'internal';
// お知らせ（ボタンで決める件ではない）は一覧から払わない。開いて「閉じる」で見たにする（承認するまでは翌日また出る）
export const isNotice = (c: Card) => c.kind === 'notice';

const DAY = 24 * 60 * 60 * 1000;
const dayOf = (t: number) => { const d = new Date(t); return Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()) / DAY; };
// 急ぎ: サーバーが急ぎの札を付けたもの、または期限が今日か明日のもの（mock: 期限 11/11 は急ぎ・締切 11/12 は急ぎでない・11/10 の時点）
export const isUrgent = (c: Card, now = Date.now()) => {
  if (c.tags?.some(t => t.tone === 'urgent')) return true;
  const t = c.deadline ? Date.parse(c.deadline) : NaN;
  return Number.isFinite(t) && dayOf(t) - dayOf(now) <= 1;
};
export const shortDate = (iso: string | null) => { const t = iso ? Date.parse(iso) : NaN; if (!Number.isFinite(t)) return ''; const d = new Date(t); return `${d.getMonth() + 1}/${d.getDate()}`; };

export const pillsOf = (c: Card, now = Date.now()): CardTag[] => {
  const p: CardTag[] = [];
  if (isUrgent(c, now)) p.push({ tone: 'urgent', label: '急ぎ' });
  if (c.risk === 'external-send') p.push({ tone: 'money', label: '外への送信' });
  if (c.risk === 'money') p.push({ tone: 'money', label: 'お金' });
  if (c.risk === 'irreversible') p.push({ tone: 'money', label: '取り消せない' });
  for (const t of c.tags ?? []) if (!p.some(x => x.label === t.label)) p.push(t);
  return p;
};

export const kindIcon = (c: Card) =>
  c.kind === 'notice' ? 'ℹ️' : c.kind === 'decision' || c.kind === 'interaction' ? '🗳' : c.risk === 'money' ? '💰' : c.risk === 'external-send' ? '📧' : '✅';

export const kindTitle = (c: Card) =>
  c.kind === 'notice' ? 'お知らせ' : c.kind === 'decision' || c.kind === 'interaction' ? '判断カード' : c.risk === 'external-send' ? '送信の承認' : '承認';

export function relTime(iso: string | null, now = Date.now()) {
  const t = iso ? Date.parse(iso) : NaN;
  if (!Number.isFinite(t)) return '';
  const m = Math.floor((now - t) / 60000);
  if (m < 1) return '今';
  if (m < 60) return `${m}分前`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}時間前`;
  const d = Math.floor(h / 24);
  return d === 1 ? '昨日' : `${d}日前`;
}

export const sectionTitle = (s: CardSection) =>
  s.kind === 'outgoing' ? '送る本文（全文）' : s.kind === 'original' ? s.label || '元の文' : s.kind === 'caution' ? '注意' : s.kind === 'steps' ? s.label || 'すること' : s.kind === 'body' ? '詳細' : s.label;
