// 画面の確かめ用の fake。中身は架空の会社の見本（どの会社の語も入れない・test/no-company-words.test.mjs）。
import { isUrgent, type Card } from '../card.ts';
import { checkText } from '../chat/logic.ts';
import type { AgentDirectory, Binding, ChatMessage, Me, NotifyClient, Office, Overview, Prefs, Thread } from './client';

const ago = (min: number) => new Date(Date.now() - min * 60000).toISOString();
const inDays = (d: number) => new Date(Date.now() + d * 24 * 60 * 60000).toISOString();
const base = { v: 1 as const, summary: '', recommendation: '', options: [], deadline: null, sections: [], links: [], tags: [] };

const SAMPLE: Card[] = [
  {
    ...base, id: 'c1', kind: 'approval', risk: 'external-send', title: '返信の承認：Example Cloud への返事', ref: 'OPS-101',
    summary: 'Example Cloud（hello@example.com）から GPU の貸し出しの提携の問い合わせ。担当が返事の案を作った。',
    recommendation: '承認してよい。事実だけを書き、約束をしていない。', deadline: inDays(1), createdAt: ago(0),
    sections: [
      { kind: 'original', label: '元のメール', fields: [{ label: '差出人', value: 'Example Cloud <hello@example.com>' }, { label: '件名', value: 'Partnership inquiry – GPU capacity' }, { label: '受信', value: '11/1 18:04' }], url: { label: 'メールで開く', href: 'https://mail.example.com/' }, text: 'Hi,\n\nWe run a GPU cloud and noticed your work on AI agents. Would you be open to a short call?\n\nBest,\nExample Cloud team' },
      { kind: 'outgoing', label: 'Outgoing text', fields: [{ label: '宛先', value: 'hello@example.com' }, { label: '差出人', value: '自分（me@example.org）' }], text: 'Example Cloud team 様\n\nご連絡ありがとうございます。\n\n現在は社内の GPU で足りており、外部の GPU の利用は検討していません。料金表をお送りいただければ、必要になった時に拝見します。\n\n今後ともよろしくお願いいたします。' },
    ],
    actions: [{ id: 'approve', label: 'Approve' }, { id: 'reject', label: 'Reject', needsNote: true }],
  },
  {
    ...base, id: 'c2', kind: 'approval', risk: 'external-send', title: '返信の承認：技術ブログのコメントへの返事', ref: 'OPS-103',
    summary: '相手の招待コードの宣伝だった。', recommendation: '却下（返信しない）', createdAt: ago(8),
    tags: [{ tone: 'sns', label: 'SNS の通知' }],
    sections: [{ kind: 'outgoing', label: 'Outgoing text', text: 'コメントありがとうございます。' }],
    actions: [{ id: 'approve', label: 'Approve' }, { id: 'reject', label: 'Reject', needsNote: true }],
  },
  {
    ...base, id: 'c3', kind: 'decision', risk: 'internal', title: '判断カード：サービス名の投票に参加する?',
    summary: '取引先から、新しいサービスの名前の投票への参加の依頼がメールで来た。締切は 2 日後。', recommendation: '参加しない', deadline: inDays(2), createdAt: ago(5),
    options: [
      { id: 'no', label: '参加しない', style: 'primary', note: '社外の投票に会社の名前を出さない' },
      { id: 'yes', label: '参加する', style: 'default', note: '自分の名前で投票する' },
    ],
    inputs: [{ id: 'note', label: 'ひとこと（任意）', required: false, maxLength: 2000 }],
    sections: [{ kind: 'caution', label: '注意', text: '参加すると自分の名前が投票の一覧に出る。' }],
    actions: [{ id: 'no', label: '参加しない' }, { id: 'yes', label: '参加する' }],
  },
  {
    ...base, id: 'c4', kind: 'approval', risk: 'money', title: 'クラウドの費用の上限の決め', summary: '月の上限の値を決めてほしい（今は 1 日 $12）。',
    recommendation: '月 $400 で承認', createdAt: ago(60 * 26), tags: [{ tone: 'urgent', label: '急ぎ' }],
    actions: [{ id: 'approve', label: 'Approve' }, { id: 'reject', label: 'Reject', needsNote: true }],
  },
  {
    ...base, id: 'c5', kind: 'approval', risk: 'internal', title: '週次の点検の手順を変える', ref: 'OPS-98', summary: '点検を月曜の朝に移す案。',
    recommendation: '承認', createdAt: ago(60 * 50),
    actions: [{ id: 'approve', label: 'Approve' }, { id: 'reject', label: 'Reject', needsNote: true }],
  },
];

const NOTICE: Card = {
  ...base, id: 'n1', kind: 'notice', risk: 'internal', title: 'お知らせ：会社ごとの判断を受けるには承認が要ります', createdAt: ago(60 * 72),
  summary: '全社の会社ごとの判断を受けるには、Paperclip で 1 回承認が要ります。今は承認・判断カードだけが届いています。',
  sections: [{ kind: 'steps', label: 'すること', text: 'Paperclip の「AI Office」の画面を開く\n「判断を受けるために承認する」を押し、出てきた画面で承認する', url: { label: 'Paperclip で開く', href: 'https://paperclip.example.com/' } }],
  actions: [],
};

// 話の見本（担当の一覧・会社のサマリー・号）。返事は発言の少し後に「見本の返事」を返す
const DIRECTORY: AgentDirectory = {
  secretaryId: 'a-sec',
  departments: [
    { key: 'office', name: '事務', agents: [{ id: 'a-sec', name: '秘書', role: 'secretary', blurb: '話を聞いて担当に回す' }, { id: 'a-office', name: '事務担当', role: 'office', blurb: 'メールとカレンダー' }] },
    { key: 'pr', name: '広報（SNS・Blog）', agents: [{ id: 'a-sns', name: 'SNS', role: 'sns', blurb: '投稿と確認・残件 2' }, { id: 'a-blog', name: 'Blog', role: 'blog', blurb: '記事の予定と公開' }] },
    { key: 'tech', name: '技術（PR Review・Alerts）', agents: [{ id: 'a-security', name: 'セキュリティ', role: 'security', blurb: '秘密の扱いと漏えいの確かめ' }] },
  ],
};
const OVERVIEW = (): Overview => ({
  whole: { summary: '担当 5 人のうち 1 人が作業中。判断待ち 3 件。止まっている課題 1 件。' },
  departments: [
    { key: 'office', name: '事務', summary: 'メール 4 件を片付け・カレンダーに 1 件登録', working: ['事務担当'] },
    { key: 'pr', name: '広報（SNS・Blog）', summary: '今週の記事 2 本を公開。SNS は 1 つだけ失敗が続く。', caution: '投稿が 3 回続けて API_ERROR。記事 1 本が公開待ち', working: [] },
    { key: 'tech', name: '技術（PR Review・Alerts）', summary: 'PR 2 本をレビュー・警報 0', working: [] },
  ],
  dailyTimes: { edition: `${new Date().getMonth() + 1}/${new Date().getDate()}`, url: 'https://news.example.com/', today: ['料金の確認（期限きょう）', '投票（あと 2 日）', '請求書の確認', '会議の準備'], news: ['クラウドの請求の案内', '展示会の案内', 'a', 'b', 'c', 'd'], events: ['記事 1 本を公開', 'PR 2 本をレビュー'] },
  at: new Date().toISOString(),
});

export function createFakeClient(opts: { replyAfterMs?: number } = {}): NotifyClient {
  let cards = [...SAMPLE, NOTICE];
  let me: Me | null = null;
  let bindings: Binding[] = [
    { id: 'b1', company: '自分', decisions: 'approved', keyDaysLeft: 23 },
    { id: 'b2', company: '全社', decisions: 'pending' },
  ];
  let prefs: Prefs = { approvals: true, decisions: true, quiet: { from: '23:00', to: '7:00' } };
  const pending = new Map<string, { company: string; at: number }>();
  let done = { ai: 9, me: 3 };
  const offices = (): Office[] => [
    { id: 'o1', name: '自分', pending: cards.length, canView: true },
    { id: 'o2', name: '全社', pending: 2, canView: true },
    { id: 'o3', name: '別の部署', pending: 0, canView: false },
  ];
  const remove = (id: string) => { cards = cards.filter(c => c.id !== id); done = { ...done, me: done.me + 1 }; };
  const threads: Thread[] = [];
  const messages = new Map<string, ChatMessage[]>();
  let seq = 0;
  const now = () => new Date().toISOString();
  const nameOf = (id: string) => DIRECTORY.departments.flatMap(d => d.agents).find(a => a.id === id)?.name ?? '担当';
  // 発言を足し、少し後に見本の返事を足して「済み」にする
  const say = (t: Thread, text: string): ChatMessage => {
    const m: ChatMessage = { id: `m${++seq}`, role: 'me', text, at: now() };
    messages.set(t.id, [...(messages.get(t.id) ?? []), m]);
    t.status = 'waiting'; t.lastMessageAt = m.at;
    setTimeout(() => {
      const r: ChatMessage = { id: `m${++seq}`, role: 'agent', text: `（見本の返事）${nameOf(t.agentId)}です。「${text.split('\n')[0].slice(0, 30)}」について調べて答えます。`, at: now() };
      messages.set(t.id, [...(messages.get(t.id) ?? []), r]);
      t.status = 'done'; t.lastMessageAt = r.at;
    }, opts.replyAfterMs ?? 3000);
    return m;
  };
  return {
    async authProvider() { return 'サンプル ID'; },
    async me() { return me; },
    async signIn() { me = { email: 'me@example.org', provider: 'サンプル ID' }; return me; },
    async signOut() { me = null; },
    async listBindings() { return bindings; },
    async startBind(code) {
      if (!/^[A-Z0-9]{4}-[A-Z0-9]{4}-[A-Z0-9]{4}$/.test(code.trim().toUpperCase())) return { ok: false, message: 'code の形が違います（XXXX-XXXX-XXXX）' };
      const id = `b${Date.now()}`; pending.set(id, { company: '別の会社', at: Date.now() });
      return { ok: true, bindingId: id, company: '別の会社' };
    },
    // 見本: 入れてから 4 秒で「確かめられた」になる
    async bindState(id) {
      const p = pending.get(id); if (!p) return 'expired';
      if (Date.now() - p.at < 4000) return 'waiting';
      pending.delete(id); bindings = [...bindings, { id, company: p.company, decisions: 'pending' }]; return 'bound';
    },
    async unbind(id) { bindings = bindings.filter(b => b.id !== id); return { ok: true }; },
    async prefs() { return prefs; },
    async setPrefs(p) { prefs = p; },
    async listOffices() { return offices(); },
    async listCards(officeId) { return officeId === 'o1' ? cards : []; },
    async summary(officeId) {
      if (officeId !== 'o1') return { pending: 0, urgent: 0 };
      return { pending: cards.length, urgent: cards.filter(c => isUrgent(c)).length, resolvedToday: done };
    },
    async act(card, actionId, values) {
      const a = card.actions.find(x => x.id === actionId);
      if (!a) return { ok: false, message: 'この操作はできません' };
      if (a.needsNote && !values?.note?.trim()) return { ok: false, message: '理由を書いてください' };
      remove(card.id);
      return { ok: true };
    },
    async markSeen(card) { remove(card.id); return { ok: true }; },
    async chatAgents() { return DIRECTORY; },
    async listThreads(_b, agentId) { return threads.filter(t => t.agentId === agentId).sort((a, b) => b.lastMessageAt.localeCompare(a.lastMessageAt)); },
    async createThread(_b, input) {
      const bad = checkText(input.text); if (bad) return { ok: false, message: bad };
      const t: Thread = { id: `t${++seq}`, agentId: input.agentId, title: input.text.slice(0, 40), status: 'waiting', lastMessageAt: now() };
      threads.push(t); say(t, input.text);
      return { ok: true, thread: { ...t } };
    },
    async listMessages(_b, threadId, after) {
      const t = threads.find(x => x.id === threadId); if (!t) throw new Error('thread-not-found');
      const all = messages.get(threadId) ?? [];
      return { messages: after ? all.filter(m => m.at > after) : all, status: t.status };
    },
    async sendMessage(_b, threadId, text) {
      const bad = checkText(text); if (bad) return { ok: false, message: bad };
      const t = threads.find(x => x.id === threadId); if (!t) return { ok: false, message: 'この話は見つかりません' };
      return { ok: true, sent: say(t, text) };
    },
    async overview() { return OVERVIEW(); },
  };
}
