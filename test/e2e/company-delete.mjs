// e2e の片付けで会社を消す共有の口。本体は会社を消す時に activity_log などの行を先に消してから会社の行を消すが、
// その間に担当の run や plugin が新しい行を書くと外部キーで 500 になる（2026-11-25 公開の CI run 45453114734 amd64 の秘書の段・
// activity_log_company_id_companies_id_fk）。500 の時だけ間を置いて消し直し、404 は消せたとみなす。それ以外の 4xx はそのまま落とす
const sleepSync = ms => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

// request(method, path) は { status, text } を返す
export function deleteCompany(request, id, { tries = 6, waitMs = 5000, sleep = sleepSync, log = console.log } = {}) {
  for (let i = 1; ; i++) {
    const r = request('DELETE', `/companies/${id}`);
    if (r.status < 400 || r.status === 404) break;
    if (r.status !== 500 || i >= tries) throw new Error(`会社を消す → ${r.status} ${String(r.text || '').slice(0, 200)}（${i}/${tries} 回目）`);
    log(`[e2e] 会社を消す → 500（${i}/${tries}）。消している間に行が書かれた見込み。${waitMs}ms 後に消し直す`);
    sleep(waitMs);
  }
  const g = request('GET', '/companies');
  // 配列でも items の配列でもない形は「消えた」と見なさず落とす（本体の返事の形が変わった時に確かめが空振りしない・独立レビュー 32 回目 P3-1）
  let rows = null; try { const j = JSON.parse(g.text); rows = Array.isArray(j) ? j : Array.isArray(j?.items) ? j.items : null; } catch { rows = null; }
  if (g.status >= 400 || !rows) throw new Error(`会社の一覧を読めない → ${g.status}`);
  if (rows.some(c => c.id === id)) throw new Error(`会社を消した後も一覧に残っている（${id}）`);
}
