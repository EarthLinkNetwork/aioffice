// 下のタブ（mock docs/mocks/app-chat-mock.html・2026-11-14 承認）。毎日使う 4 つ。設定はタブに置かず右上の ⚙️。
// 「Daily Times」の名前はこのファイルにだけ置く（test/no-company-words.test.mjs が他のファイルを見張る）。
export type MainTab = 'inbox' | 'secretary' | 'daily' | 'company';

export const DAILY_TITLE = 'Daily Times';

export const MAIN_TABS: { id: MainTab; icon: string; label: string }[] = [
  { id: 'inbox', icon: '📥', label: '受信箱' },
  { id: 'secretary', icon: '💬', label: '秘書' },
  { id: 'daily', icon: '📰', label: DAILY_TITLE },
  { id: 'company', icon: '🏢', label: '会社' },
];

// ⑥ の下の一行（押すと Web の号を開く）
export const DAILY_NOTE = `今の Web の ${DAILY_TITLE} と同じ号をアプリで読む`;

export const tabLabel = (t: MainTab): string => MAIN_TABS.find(x => x.id === t)?.label ?? '';
