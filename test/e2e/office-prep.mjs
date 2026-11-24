// office の e2e の準備: 受信箱に承認 2 件と判断 1 件を置く。container の中で本体（127.0.0.1:3101・ログイン無しのモード）に直に頼む。
// 使い方: docker exec -i aioffice node --input-type=module - < test/e2e/office-prep.mjs   → 1 行の JSON {companyId, approvals, decision}
// 判断は「課題に結び付いた担当の実行」+ 担当の鍵でしか作れない（実測 2026-11-15）。担当に課題を割り当てると実行の記録ができる
// （AI の契約が無いので実行は失敗で残り、担当の状態も失敗になる。オフィスの画面を撮るのはこの準備の前にする）
const PC = 'http://127.0.0.1:3101/api';
// ログインのある形の本体には、起動係の鍵（持ち主の board の鍵）で頼む。担当の鍵を渡した呼び出しはそちらが勝つ
import fs from 'node:fs';
const BOARD = (() => { try { return `Bearer ${JSON.parse(fs.readFileSync('/data/aioffice/board-key.json', 'utf8')).token}`; } catch { return null; } })();
const sleep = ms => new Promise(r => setTimeout(r, ms));
async function call(method, p, body, headers = {}) {
  const r = await fetch(`${PC}${p}`, { method, headers: { 'content-type': 'application/json', ...(BOARD ? { authorization: BOARD } : {}), ...headers }, body: body ? JSON.stringify(body) : undefined });
  const t = await r.text(); let j = null; try { j = JSON.parse(t); } catch { j = null; }
  if (!r.ok) throw new Error(`${method} ${p} → ${r.status} ${t.slice(0, 200)}`);
  return j;
}
const [co] = await call('GET', '/companies');
const approvals = [];
for (const n of [1, 2]) approvals.push((await call('POST', `/companies/${co.id}/approvals`, { type: 'request_board_approval', payload: { title: `E2E approval ${n}`, summary: `Check https://example.com/${n} before approving.` } })).id);
const agents = await call('GET', `/companies/${co.id}/agents`);
const agent = agents[0];
const issue = await call('POST', `/companies/${co.id}/issues`, { title: 'E2E decision source', description: 'prepared by the e2e test', status: 'todo', assigneeAgentId: agent.id });
let run = null;
for (let i = 0; i < 60 && !run; i++) { const runs = await call('GET', `/issues/${issue.id}/runs`); run = (Array.isArray(runs) ? runs : runs.items || [])[0] || null; if (!run) await sleep(1000); }
if (!run) throw new Error('課題に結び付いた実行ができない');
const key = await call('POST', `/agents/${agent.id}/keys`, { name: 'e2e-decision' });
const token = key.token || key.key || key.apiKey;
if (!token) throw new Error(`鍵の返事に token が無い: ${Object.keys(key).join(',')}`);
const decision = await call('POST', `/companies/${co.id}/decisions`, { title: 'E2E decision', body: 'Pick one option.', options: [{ id: 'a', label: 'Option A', effects: [] }, { id: 'b', label: 'Option B', effects: [] }] },
  { authorization: `Bearer ${token}`, 'x-paperclip-run-id': run.id ?? run.runId });
// AI の契約の欄で ChatGPT の行が「つながっている」を見るため、Codex の資格の置き場に偽の auth.json を置く（範囲 2026-11-18 F7）。
// 本物がある時（AIO_CODEX=1 でつないだ後）は上書きしない。起動係は置き場の auth.json を読んで「つないだ」とする
const { mkdirSync, writeFileSync, existsSync } = await import('node:fs');
const codexHome = `${process.env.AIOFFICE_DATA_ROOT || '/data'}/codex-home`;
let fakeAuth = false;
if (!existsSync(`${codexHome}/auth.json`)) { mkdirSync(codexHome, { recursive: true, mode: 0o700 }); writeFileSync(`${codexHome}/auth.json`, JSON.stringify({ OPENAI_API_KEY: null, tokens: { e2e: 'fake' } }), { mode: 0o600 }); fakeAuth = true; }
console.log(JSON.stringify({ companyId: co.id, approvals, decision: decision.id, fakeAuth }));
