// @anthropic-ai/claude-agent-sdk はこの image に入れていない（独自の許諾で再配布できない）。Claude の担当（ACP）は使えない
const missing = () => { throw new Error('@anthropic-ai/claude-agent-sdk is not included in the AI Office package. Use the Codex employees.'); };
export const USAGE_LIMIT_ERROR_PREFIXES = [];
export const query = missing;
export const createSdkMcpServer = missing;
export const deleteSession = missing;
export const getSessionMessages = missing;
export const listSessions = missing;
export const forkSession = missing;
export const getSessionInfo = missing;
export const resolveSettings = missing;
export const filterEscalatingDefaultMode = missing;
