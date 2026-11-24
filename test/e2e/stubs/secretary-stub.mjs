#!/usr/bin/env node
// 秘書の気づきの e2e だけで使う偽の秘書（配る image には入れない。CI で container の /tmp にだけ docker cp で写し、process 型の担当の command で指す）
// 範囲: docs/review/2026-11-21-secretary-awareness-scope.md（開発元の記録）保証 7
// run ごとに本体が渡す鍵（PAPERCLIP_API_KEY）で、自分に割り当てられた見回りの課題を読み、提案の json を書いて done にする（本物の秘書と同じ指示）。
// 本文に「出来事が何件あったか」と、前の回の持ち主の返事（Owner preferences の柵の中）を読み取れたかを提案の題に入れる（e2e がそれを見る）
const API = (process.env.PAPERCLIP_API_URL || 'http://127.0.0.1:3101').replace(/\/$/, '') + '/api';
const KEY = process.env.PAPERCLIP_API_KEY || '';
const ORIGIN = 'plugin:aioffice.secretary:round';
const call = async (method, p, body) => {
  const r = await fetch(API + p, { method, headers: { authorization: `Bearer ${KEY}`, 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
  const t = await r.text();
  if (!r.ok) throw new Error(`${method} ${p} → ${r.status} ${t.slice(0, 300)}`);
  return t ? JSON.parse(t) : null;
};
const me = await call('GET', '/agents/me');
const list = x => (Array.isArray(x) ? x : x?.items || []);
const mine = list(await call('GET', `/companies/${me.companyId}/issues?assigneeAgentId=${encodeURIComponent(me.id)}`));
for (const it of mine.filter(i => i.originKind === ORIGIN && ['todo', 'in_progress', 'backlog'].includes(i.status))) {
  const issue = await call('GET', `/issues/${it.id}`); // 一覧には本文が入らない
  const body = String(issue.description || '');
  const events = ((body.split(/## (?:Events|出来事)/)[1] || '').match(/^\d+\. /gm) || []).length;
  const pref = (body.match(/E2E-PREF-[a-z0-9]+/) || [null])[0];
  const proposals = [{ title: `e2e: ${events} events${pref ? ` / saw ${pref}` : ''}`, detail: 'stub proposal', evidence: [], deep: false }];
  await call('POST', `/issues/${issue.id}/comments`, { body: `1. ${proposals[0].title}\n\n\`\`\`json\n${JSON.stringify({ proposals })}\n\`\`\`` });
  await call('PATCH', `/issues/${issue.id}`, { status: 'done' }); // in_review には plugin が動かす（担当の in_review は本体が断る）
  console.log(`answered ${issue.identifier || issue.id}: ${proposals[0].title}`);
}
