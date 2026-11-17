// 解いた秘密を短い時間だけ覚えておく。本体は plugin 1 つ・会社ごとに秘密を解く回数を 1 分 30 回までに絞るので、
// card を送るたび・本体を呼ぶたびに解き直すと上限に当たり、送れない・本体を呼べない（2026-11-13 に実機の会社で起きた）。
// 鍵は (会社・secretId・version) ごと。同時に来た分は 1 回の解きを共有する。失敗は覚えない（次で解き直す）。
export function createSecretCache({ resolve, ttlMs = 5 * 60_000, now = () => Date.now() }) {
  const hits = new Map(); // key -> { value, at } または { pending, gen }
  const gens = new Map(); // key -> 捨てた回数（解いている途中で捨てた時に、古い値を書き戻さないため）
  const keyOf = (ref, companyId) => `${companyId}|${ref && typeof ref === 'object' ? `${ref.secretId}@${ref.version ?? 'latest'}` : String(ref)}`;
  return {
    async get(ref, companyId) {
      const k = keyOf(ref, companyId);
      const h = hits.get(k);
      if (h?.pending) return h.pending;
      if (h && now() - h.at < ttlMs) return h.value;
      const gen = gens.get(k) ?? 0;
      const pending = Promise.resolve().then(() => resolve(ref, { companyId }));
      hits.set(k, { pending, gen });
      try {
        const value = await pending;
        // 途中で捨てられていたら覚えない。空の値も覚えない（次で解き直す）
        if ((gens.get(k) ?? 0) === gen && hits.get(k)?.pending === pending) {
          if (value) hits.set(k, { value, at: now() }); else hits.delete(k);
        }
        return value;
      } catch (e) {
        if (hits.get(k)?.pending === pending) hits.delete(k);
        throw e;
      }
    },
    // 呼び先が鍵を断った時（401・403）に、その秘密だけ解き直させる
    forget(ref, companyId) { const k = keyOf(ref, companyId); hits.delete(k); gens.set(k, (gens.get(k) ?? 0) + 1); },
  };
}
