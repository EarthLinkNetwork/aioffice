// 知らせの plugin の見回りの口（/tick）を e2e から呼ぶ。口は同時に 1 つで、起動係の 5 分ごとの見回りと重なると 409 notify_busy を返すので、
// その時だけ待ってやり直す（2026-11-24 amd64 の公開の CI・notify・mail・slack の e2e で共有）
import assert from 'node:assert/strict';

export function makeNotifyTick({ ctx, BASE, NB, getState, defaultCompanyId }) {
  return async (cid = defaultCompanyId()) => {
    for (let i = 0; ; i++) {
      const s = await getState();
      const r = await ctx.request.fetch(`${NB}/tick?companyId=${encodeURIComponent(cid)}`, { method: 'POST', data: { lang: s.lang, ...(s.timeZone ? { timeZone: s.timeZone } : {}) }, headers: { origin: BASE, 'content-type': 'application/json' }, timeout: 60000 });
      const j = await r.json().catch(() => null);
      if (r.status() === 409 && j?.error === 'notify_busy' && i < 20) { await new Promise(res => setTimeout(res, 3000)); continue; }
      assert.ok(r.ok(), `POST tick → ${r.status()} ${JSON.stringify(j).slice(0, 200)}`);
      return j;
    }
  };
}
