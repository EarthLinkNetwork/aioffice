// 「スマホとつなぐ」の表示の判定（純関数・ui.mjs が使う）。待っている結びつけの一覧（link.pending）から、画面に出すものを決める。
// 名乗り出た（claimed）ものを新しい順に確認として出し、無ければ待っている（waiting）新しいものを出す。
export function linkView(pending, nowMs = Date.now()) {
  const live = (Array.isArray(pending) ? pending : []).filter(p => p && (p.state === 'claimed' || p.state === 'waiting' || p.state === 'unknown') && (!p.expiresAt || Date.parse(p.expiresAt) > nowMs))
    .sort((a, b) => Date.parse(b.createdAt || 0) - Date.parse(a.createdAt || 0));
  const claimed = live.filter(p => p.state === 'claimed');
  if (claimed.length) return { kind: 'claimed', items: claimed };
  const waiting = live.find(p => p.state === 'waiting' || p.state === 'unknown');
  if (waiting) return { kind: 'waiting', item: waiting, minutesLeft: waiting.expiresAt ? Math.max(1, Math.ceil((Date.parse(waiting.expiresAt) - nowMs) / 60_000)) : null };
  return { kind: 'none' };
}
