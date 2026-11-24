// wizard で選べる AI の表。Paperclip（2026.1001.0）の built-in の adapter の 16 種を全部載せ、選べる物と外す物を理由つきで持つ
// 範囲: docs/review/2026-11-17-wizard-ai-choice-scope.md（作り方 1〜3・7）
// 表に無い adapter が Paperclip の更新で増えたら、試験（lock の照合）と image の build（BUILTIN_ADAPTER_TYPES の照合）が落ちる
//
// 各行:
//   type      Paperclip の adapterType
//   include   wizard で選べるか
//   reason    外す理由（include が false の時）
//   name      画面の名前（en・ja）
//   pkg       adapter の npm package（server の中にある型は null）。lock の照合に使う
//   install   CLI の入れ方。npm（package@版）・script（公式の install の URL）・image（image に入っている）
//   bin       入れた後の CLI の名前（adapterConfig.command に絶対パスで書く）
//   login     つなぎ方。device（画面に URL と code を出す）・browser（URL だけを出し、ブラウザで許可すると CLI が終わる）・browser_code（利用者がブラウザの code を貼る）・api_key（鍵だけ）
//   connect   device・browser の時に PTY で起こすサインインの命令（args）と、出力から URL を拾う形（url）。2026-11-20 に arm64 のまっさらな container で実測した形
//             （docs/review/2026-11-17-wizard-ai-choice-scope.md の「実測」）。pi と opencode は束ねる CLI なので ChatGPT の契約（OpenAI の device code）でつなぐ
//   homeEnv   AI ごとの資格の置き場の env（/data/aitools/<type>/home に向ける）
//   keyEnv    API の鍵で入れる時の env
//   engine    adapterConfig.engine の既定（要らない adapter は null）

export const AI_ROOT = `${process.env.AIOFFICE_DATA_ROOT || '/data'}/aitools`; // 起動係（bin/aioffice-start.mjs）と同じ置き場の env に従う

export const AI_CATALOG = Object.freeze([
  { type: 'codex_local', include: true, name: { en: 'ChatGPT (Codex)', ja: 'ChatGPT（Codex）' }, pkg: '@paperclipai/adapter-codex-local', install: { kind: 'image' }, bin: 'codex', login: 'device', homeEnv: 'CODEX_HOME', keyEnv: 'OPENAI_API_KEY', engine: 'cli' },
  { type: 'claude_local', include: true, name: { en: 'Claude (Claude Code)', ja: 'Claude（Claude Code）' }, pkg: '@paperclipai/adapter-claude-local', install: { kind: 'npm', spec: '@anthropic-ai/claude-code@2.1.326' }, bin: 'claude', login: 'browser_code', homeEnv: null, keyEnv: 'ANTHROPIC_API_KEY', engine: 'cli' },
  { type: 'grok_local', include: true, name: { en: 'Grok', ja: 'Grok' }, pkg: '@paperclipai/adapter-grok-local', install: { kind: 'npm', spec: '@xai-official/grok@1.0.88' }, bin: 'grok', login: 'device', connect: { args: ['login', '--device-auth'], url: 'https://accounts.x.ai/' }, homeEnv: 'GROK_HOME', keyEnv: null, engine: null },
  { type: 'gemini_local', include: true, name: { en: 'Gemini', ja: 'Gemini' }, pkg: '@paperclipai/adapter-gemini-local', install: { kind: 'npm', spec: '@google/gemini-cli@0.68.0' }, bin: 'gemini', login: 'api_key', homeEnv: 'GEMINI_CLI_HOME', keyEnv: 'GEMINI_API_KEY', engine: null },
  { type: 'kimi_local', include: true, name: { en: 'Kimi', ja: 'Kimi' }, pkg: '@paperclipai/adapter-kimi-local', install: { kind: 'npm', spec: '@moonshot-ai/kimi-code@2.6.2' }, bin: 'kimi', login: 'device', connect: { args: ['login'], url: 'https://www.kimi.com/' }, homeEnv: 'KIMI_CODE_HOME', keyEnv: 'KIMI_MODEL_API_KEY', engine: null },
  { type: 'cursor', include: true, name: { en: 'Cursor', ja: 'Cursor' }, pkg: '@paperclipai/adapter-cursor-local', install: { kind: 'script', url: 'https://cursor.com/install' }, bin: 'agent', login: 'browser', connect: { args: ['login'], url: 'https://cursor.com/' }, homeEnv: 'HOME', keyEnv: 'CURSOR_API_KEY', engine: null },
  { type: 'opencode_local', include: true, name: { en: 'OpenCode', ja: 'OpenCode' }, pkg: '@paperclipai/adapter-opencode-local', install: { kind: 'npm', spec: 'opencode-ai@1.19.5' }, bin: 'opencode', login: 'device', connect: { args: ['auth', 'login', '-p', 'openai', '-m', 'ChatGPT Pro/Plus (headless)'], url: 'https://auth.openai.com/' }, homeEnv: 'HOME', keyEnv: null, engine: null },
  { type: 'pi_local', include: true, name: { en: 'Pi', ja: 'Pi' }, pkg: '@paperclipai/adapter-pi-local', install: { kind: 'npm', spec: '@earendil-works/pi-coding-agent@1.5.2' }, bin: 'pi', login: 'device', connect: { args: ['auth', 'login', 'openai-codex', '--no-browser'], url: 'https://auth.openai.com/' }, homeEnv: 'HOME', keyEnv: null, engine: null },
  { type: 'hermes_local', include: false, reason: 'AI の契約で動くかを all-ai-v1 m03 で実測するまで外す', name: { en: 'Hermes', ja: 'Hermes' }, pkg: null },
  { type: 'cursor_cloud', include: false, reason: '要る @cursor/sdk が image で stub（動かない）', name: { en: 'Cursor Cloud', ja: 'Cursor Cloud' }, pkg: '@paperclipai/adapter-cursor-cloud' },
  { type: 'acpx_local', include: false, reason: 'Paperclip の登録で廃止の墓標', name: { en: 'ACPX', ja: 'ACPX' }, pkg: null },
  { type: 'hermes_gateway', include: false, reason: '外の gateway につなぐ物で、AI の契約ではない', name: { en: 'Hermes gateway', ja: 'Hermes gateway' }, pkg: null },
  { type: 'openclaw_gateway', include: false, reason: '外の gateway につなぐ物で、AI の契約ではない', name: { en: 'OpenClaw gateway', ja: 'OpenClaw gateway' }, pkg: '@paperclipai/adapter-openclaw-gateway' },
  { type: 'paperclip_runner', include: false, reason: 'Paperclip の中の実行の仕組みで、AI の契約ではない', name: { en: 'Paperclip runner', ja: 'Paperclip runner' }, pkg: null },
  { type: 'process', include: false, reason: 'Paperclip の中の実行の仕組みで、AI の契約ではない', name: { en: 'Process', ja: 'Process' }, pkg: null },
  { type: 'http', include: false, reason: 'Paperclip の中の実行の仕組みで、AI の契約ではない', name: { en: 'HTTP', ja: 'HTTP' }, pkg: null },
]);

// adapter の部品でない package（adapter の共通の道具）
export const NON_ADAPTER_PACKAGES = Object.freeze(['@paperclipai/adapter-utils']);

export const catalogEntry = type => AI_CATALOG.find(e => e.type === type) || null;

// GET /api/adapters の結果を、wizard の選択肢に並べる。表に無い型は「出るが選べない」
export function aiChoices(adapters) {
  return adapters.filter(a => !a.disabled).flatMap(a => {
    const e = catalogEntry(a.type);
    if (!e) return [{ type: a.type, name: { en: a.label || a.type, ja: a.label || a.type }, selectable: false, why: 'unknown' }];
    if (!e.include) return [];
    return [{ type: e.type, name: e.name, selectable: true, login: e.login }];
  });
}

// 入れた CLI の絶対パスと資格の置き場
export const aiHome = type => `${AI_ROOT}/${type}/home`;
export const aiBin = type => {
  const e = catalogEntry(type);
  if (!e || !e.include) throw new Error(`not selectable: ${type}`);
  if (e.install.kind === 'image') return e.bin;
  // npm は --prefix の下の node_modules/.bin、公式の install の script は HOME の下の .local/bin に入れる
  if (e.install.kind === 'npm') return `${AI_ROOT}/${type}/node_modules/.bin/${e.bin}`;
  return `${aiHome(type)}/.local/bin/${e.bin}`;
};

// 担当を作る時の adapterConfig（表の既定）
export function agentAdapterConfig(type) {
  const e = catalogEntry(type);
  if (!e || !e.include) throw new Error(`not selectable: ${type}`);
  const cfg = { command: aiBin(type) };
  if (e.engine) cfg.engine = e.engine;
  if (e.homeEnv && e.install.kind !== 'image') cfg.env = { [e.homeEnv]: aiHome(type) };
  return cfg;
}

// 担当の AI の設定（担当を作る時・割り当て直す時の両方で使う）。
// Codex は前の版と同じ形（engine cli）。ほかの AI は表の既定で、Claude は env で token の秘密（secret_ref）を指す
// keySecretId は API の鍵の秘密（契約でつないでいない AI だけ server が渡す）。鍵は表の keyEnv に secret_ref で入れる
export function deskAdapterConfig(type, { claudeSecretId, keySecretId } = {}) {
  const e = catalogEntry(type);
  const key = keySecretId && e?.keyEnv ? { [e.keyEnv]: { type: 'secret_ref', secretId: keySecretId } } : null;
  if (type === 'codex_local') return key ? { engine: 'cli', env: key } : { engine: 'cli' };
  const cfg = agentAdapterConfig(type);
  if (type === 'claude_local' && claudeSecretId) cfg.env = { ...(cfg.env || {}), CLAUDE_CODE_OAUTH_TOKEN: { type: 'secret_ref', secretId: claudeSecretId } };
  if (key) cfg.env = { ...(cfg.env || {}), ...key };
  return cfg;
}

// AI に関わる env の key（資格の置き場・API の鍵・Claude の token）。割り当て直す時はこれだけを入れ替える
export const AI_ENV_KEYS = Object.freeze([...new Set(AI_CATALOG.flatMap(e => [e.homeEnv, e.keyEnv]).filter(Boolean).concat('CLAUDE_CODE_OAUTH_TOKEN'))]);

// AI を替える時に本体の PATCH へ送る adapterConfig: 新しい AI の設定（next）と、今の env から AI の key を抜いて next.env を足した env だけ。
// 今の設定の丸ごとは送らない。本体（Paperclip 2026.1001.0 routes/agents.js）は種類が変わる時、送らなかった種類によらない key
// （ADAPTER_AGNOSTIC_KEYS: cwd・promptTemplate・指示書の置き場など）を自分で持ち越し、それ以外の前の種類の key は捨てる。
// env は必ず送る（空でも）。送らないと本体が前の env（前の AI の key を含む）を持ち越すため。
// current は本体の担当一覧の値で、env の値は伏せ字（{ type: 'plain', value: '***REDACTED***' }）。伏せ字のまま送り返すと、本体の
// restoreRedactedAgentEnv が保存してある元の値に戻す（secret_ref はそのまま返ってくる）
// 範囲: docs/review/2026-11-18-office-ai-panel-ux-scope.md F1（独立レビュー r2 の 1・2）
export function swapAdapterConfig(current, next) {
  const curEnv = current && typeof current === 'object' && current.env && typeof current.env === 'object' && !Array.isArray(current.env) ? current.env : {};
  const env = { ...curEnv };
  for (const k of AI_ENV_KEYS) delete env[k];
  // 本体が文字の '***REDACTED***' に伏せた値（文字・plain・secret_ref のどれでもない形の env）は、送り返すとその文字で上書きされるので送らない（独立レビュー r3 の B）。
  // 送らない key は本体が持ち越さない（env を送ると env は丸ごと替わる）
  for (const [k, v] of Object.entries(env)) if (v === '***REDACTED***') delete env[k];
  const { env: nextEnv, ...rest } = next;
  return { ...rest, env: { ...env, ...(nextEnv || {}) } };
}
