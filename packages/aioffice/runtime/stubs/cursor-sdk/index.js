// @cursor/sdk はこの image に入れていない（独自の許諾で再配布できない）。Cursor の担当は使えない
const missing = () => { throw new Error('@cursor/sdk is not included in the AI Office package. Use the Codex employees.'); };
export class Agent { constructor() { missing(); } }
export class Cursor { constructor() { missing(); } }
export default { Agent, Cursor };
