// 本体へ中継する書き込みを同時に max 本までにする関所（開発元の記録 docs/review/2026-11-16-library-notify-scope.md の実測 23）。
// 本体（2026.1001.0）は comment などの書き込みが同時に十数本を超えると、DB の接続の池が transaction で埋まって止まり、
// container の再起動まで戻らない。6 本に絞ると 300 件を流しても止まらなかった。
export const WRITE_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

export function createGate({ max = 6, waitMs = 60_000, setTimer = setTimeout, clearTimer = clearTimeout } = {}) {
  let active = 0;
  const queue = [];
  const next = () => {
    while (active < max && queue.length) {
      const w = queue.shift();
      clearTimer(w.timer);
      active++;
      w.resolve(release());
    }
  };
  function release() {
    let done = false;
    return () => { if (done) return; done = true; active--; next(); };
  }
  return {
    get active() { return active; },
    get waiting() { return queue.length; },
    // 入れたら release を返す。waitMs を超えて待ったら Error('gate_timeout')。signal が abort したら列から抜けて Error('gate_aborted')
    acquire({ signal } = {}) {
      if (signal?.aborted) return Promise.reject(new Error('gate_aborted'));
      if (active < max) { active++; return Promise.resolve(release()); }
      return new Promise((resolve, reject) => {
        const leave = err => { const i = queue.indexOf(w); if (i >= 0) queue.splice(i, 1); clearTimer(w.timer); signal?.removeEventListener?.('abort', onAbort); reject(err); };
        const onAbort = () => leave(new Error('gate_aborted'));
        const w = { resolve: r => { signal?.removeEventListener?.('abort', onAbort); resolve(r); }, timer: null };
        w.timer = setTimer(() => leave(new Error('gate_timeout')), waitMs);
        signal?.addEventListener?.('abort', onAbort, { once: true });
        queue.push(w);
      });
    },
  };
}
