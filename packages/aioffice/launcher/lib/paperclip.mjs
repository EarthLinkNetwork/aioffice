// 本体（Paperclip）への呼び出し。container の中の loopback で、ログインなしの mode（local_trusted）の本体を叩く
// 使う口（段 2 の実測・Paperclip 2026.1001.0）:
//   POST /api/companies                       会社を作る
//   POST /api/companies/:id/agents            担当を作る（adapterType は選んだ AI・既定 codex_local）。応答の adapterConfig.instructionsFilePath に指示書を書く
//   POST /api/companies/:id/adapters/:type/test-environment  つないだ後の確かめ
// 会社と担当が 1 つずつあれば、本体の初回の案内（/onboarding）は出ない（実測 1・2）
import fs from 'node:fs';
import path from 'node:path';

export const LIBRARY_PUT_MS = 60_000;
export function createPaperclip({ base, fetchFn = fetch }) {
  const host = new URL(base).host;
  async function call(method, p, body, { timeoutMs } = {}) {
    let r;
    try { r = await fetchFn(new URL(p, base), { method, headers: { 'content-type': 'application/json', host }, body: body == null ? undefined : JSON.stringify(body), ...(timeoutMs ? { signal: AbortSignal.timeout(timeoutMs) } : {}) }); }
    catch { throw Object.assign(new Error('not_ready'), { status: 503 }); } // 本体がまだ起きていない（wizard は「まだ起動中」と出す）
    const text = await r.text(); let json = null; try { json = text ? JSON.parse(text) : null; } catch { /* 本文が JSON でない */ }
    if (!r.ok) { const e = new Error(`paperclip ${method} ${p} → ${r.status}`); e.status = r.status; e.body = json; throw e; }
    return json;
  }
  return {
    health: () => call('GET', '/api/health'),
    companies: () => call('GET', '/api/companies'),
    createCompany: name => call('POST', '/api/companies', { name }),
    company: companyId => call('GET', `/api/companies/${companyId}`),
    agents: companyId => call('GET', `/api/companies/${companyId}/agents`),
    // 担当は選んだ AI の adapter で作る（既定は Codex）。adapterConfig は wizard の AI の表の既定（ai-catalog.mjs）。ACP では担当が本体の API に毎回つながらなかったので CLI の経路にする（自社の運用 2026-11-04）
    createAgent: (companyId, { name, title, role = 'general', adapterType = 'codex_local', adapterConfig = { engine: 'cli' } }) => call('POST', `/api/companies/${companyId}/agents`, { name, title, role, adapterType, adapterConfig }),
    updateAgent: (agentId, patch) => call('PATCH', `/api/agents/${agentId}`, patch),
    adapters: () => call('GET', '/api/adapters'),
    // 会社の秘密を作る。値は応答に返らない形で本体が持つ（Claude の token など）
    createSecret: (companyId, { name, key, value }) => call('POST', `/api/companies/${companyId}/secrets`, { name, key, value }),
    secrets: companyId => call('GET', `/api/companies/${companyId}/secrets`),
    rotateSecret: (secretId, value) => call('POST', `/api/secrets/${secretId}/rotate`, { value }),
    libraryPut: (companyId, name, text) => call('POST', `/api/plugins/aioffice.library/api/documents?companyId=${encodeURIComponent(companyId)}`, { name, text }, { timeoutMs: LIBRARY_PUT_MS }), // フォルダの欄（本体が止まっても口を塞がない・実装レビュー P3-3）（図書室の口・会社は query で決まる）
    // Slack の宛先（docs/review/2026-11-18-slack-notify-scope.md 作り方 3）。設定の保存は丸ごと置き換えなので、読んでから替えて書き戻す
    deleteSecret: secretId => call('DELETE', `/api/secrets/${secretId}`),
    pluginConfig: (pluginKey, companyId) => call('GET', `/api/plugins/${encodeURIComponent(pluginKey)}/config?companyId=${encodeURIComponent(companyId)}`),
    setPluginConfig: (pluginKey, companyId, configJson) => call('POST', `/api/plugins/${encodeURIComponent(pluginKey)}/config`, { companyId, configJson }),
    // 知らせの plugin の Slack の口（URL は載せない。言語と office の URL は起動係が足す）
    notifyRoute: (method, p, companyId, { query = {}, body } = {}) => call(method, `/api/plugins/aioffice.notify/api/${p}?${new URLSearchParams({ companyId, ...query })}`, method === 'GET' ? undefined : (body ?? {}), { timeoutMs: 35_000 }),
    testEnvironment: (companyId, adapterType = 'codex_local') => call('POST', `/api/companies/${companyId}/adapters/${adapterType}/test-environment`, {}),
  };
}

// 担当の指示書を書く。本体が決めた置き場（instructionsFilePath）が無い時は書かずに知らせる
export function writeInstructions(agent, text) {
  const p = agent?.adapterConfig?.instructionsFilePath;
  if (!p) return false;
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, text);
  return true;
}
