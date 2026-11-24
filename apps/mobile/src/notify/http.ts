// 本物の NotifyClient。通知 API（/api/v1/app/*・ADR-0008）を fetch で呼ぶ。
// 端末の部品（保存・ブラウザ）は外から渡す。ここは RN に依らないので node の test で口の呼び方を確かめられる。
import type { Card } from '../card';
import { isUrgent } from '../card.ts';
import { makePkce, webPkceParts, type Pkce } from './pkce.ts';
import type { ActResult, AgentDirectory, BindState, BindStart, Binding, ChatMessage, CreateThreadResult, Me, MessagePage, NotifyClient, Office, Overview, Prefs, SendResult, Summary, Thread } from './client';
import { checkText } from '../chat/logic.ts';

export type TokenStore = { get(): Promise<string | null>; set(token: string): Promise<void>; clear(): Promise<void> };
// ブラウザでサインインを開き、戻りの URL（aioffice://auth?code=…）を返す。閉じた・やめた時は null
export type OpenAuth = (startUrl: string, redirect: string) => Promise<string | null>;
export type HttpClientOptions = {
  baseUrl: string;
  store: TokenStore;
  openAuth: OpenAuth;
  pkce?: () => Promise<Pkce>; // 既定は WebCrypto（端末では expo-crypto で作ったものを渡す）
  deviceToken?: () => Promise<string>; // 登録の記録が無い時の解除用に、今の端末 token を取り直す（サインアウトの時だけ使う）
  signOutWaitMs?: number; // サインアウトの中で待つ所（応答待ちの登録・token の取り直し・解除と signout の通信）ごとの期限。既定 5 秒
  actTimeoutMs?: number; // 押した操作の応答を待つ期限。既定 20 秒（過ぎたら止めて画面に出す）
  verifyWaitMs?: number; // 話の発言の応答が落ちた時、届いたかを読み直す前に待つ時間。既定 2 秒（サーバーが書き終えるのを待つ）
  fetch?: typeof fetch;
  now?: () => number;
};

export const AUTH_REDIRECT = 'aioffice://auth';
export type DeviceEnv = 'sandbox' | 'production';

export interface HttpClient extends NotifyClient {
  registerDevice(token: string, env: DeviceEnv, bundleId: string): Promise<boolean>;
  unregisterDevice(token: string): Promise<void>;
  hasToken(): Promise<boolean>;
  onUnauthorized(cb: () => void): () => void; // 401（token の期限切れなど）でサインイン画面へ戻す合図
}

class Unauthorized extends Error {}
class ListFailed extends Error { constructor(status: number) { super(`list failed: ${status}`); } }

const fail = (message: string): { ok: false; message: string } => ({ ok: false, message });
const MESSAGES: Record<string, string> = {
  'rate-limited': '試す回数が多すぎます。しばらくしてからもう一度',
  'code-not-found': 'この code は見つかりません。plugin が出した code か確かめてください',
  'code-expired': 'この code は期限が切れています。新しく作ってもらってください',
  'invalid-state': 'この code はもう使われています',
  'note-required': '理由を書いてください',
  'invalid-action': 'この操作はできません',
  'binding-not-found': 'この結びつけは見つかりません',
  'binding-not-active': 'この会社とはまだつながっていません',
  'card-not-found': 'この件はもうありません',
  'action-already-pending': 'この件は送信済みです。反映まで少し待ってください',
  'invalid-body': '送る中身が正しくありません。アプリを新しくしてください',
  'thread-not-found': 'この話は見つかりません',
  'agent-not-found': 'この担当は見つかりません',
  'text-too-long': '発言は 4000 字までです',
};

export function createHttpClient(opts: HttpClientOptions): HttpClient {
  const base = opts.baseUrl.replace(/\/+$/, '');
  const doFetch = opts.fetch ?? fetch;
  const listeners = new Set<() => void>();
  let lastDevice: string | null = null; // 最後に登録した端末 token（解除に使う。getDevicePushTokenAsync を呼び直さない）
  const pendingRegs = new Set<Promise<unknown>>(); // 応答待ちの登録（サインアウトは待ってから解除する）
  let signingOut = false; // サインアウト中・後は登録しない（遅れて届いた token の event が DELETE の後に登録しないため）
  const api = `${base}/api/v1/app`;

  type Res = { status: number; body: any };
  // onSend: 通信を始める直前に呼ぶ（送る口が「送る前の失敗」か「送った後の失敗」かを見分ける）
  const call = async (method: string, path: string, body?: unknown, auth = true, signal?: AbortSignal, onSend?: () => void): Promise<Res> => {
    const headers: Record<string, string> = { accept: 'application/json' };
    if (body !== undefined) headers['content-type'] = 'application/json';
    if (auth) {
      const t = await opts.store.get();
      if (!t) throw new Unauthorized();
      headers.authorization = `Bearer ${t}`;
    }
    onSend?.();
    const r = await doFetch(`${api}${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body), ...(signal ? { signal } : {}) });
    const json = await r.json().catch(() => ({}));
    if (auth && r.status === 401) throw new Unauthorized();
    return { status: r.status, body: json };
  };
  // 401 は token を消してサインイン画面へ戻す。ほかの失敗（通信など）は呼び元に返す
  // 401 を受けた時点で、持っている最後の端末 token の DELETE を試みる（token が無効で失敗してもよい。古い sub に登録が残るのを減らす）
  const dropDevice = async () => {
    if (!lastDevice) return;
    const t = lastDevice; lastDevice = null;
    try { await call('DELETE', '/devices', { token: t }); } catch { /* 失敗してよい */ }
  };
  const guarded = async <T>(f: () => Promise<T>): Promise<T> => {
    try { return await f(); } catch (e) {
      if (e instanceof Unauthorized) { await dropDevice(); await opts.store.clear(); listeners.forEach(cb => cb()); }
      throw e;
    }
  };
  const msg = (r: Res, fallback: string) => MESSAGES[r.body?.code] ?? fallback;
  const bid = (id: string) => encodeURIComponent(id);

  // GET /cards は全件を 1 回取り、結びつけごとの絞り込みは手元で行う。同時に呼ばれた分は 1 回の通信を共有する
  let inflight: Promise<Card[]> | null = null;
  const fetchAll = (): Promise<Card[]> => {
    // 200 でない時は空の一覧にせず失敗にする（空にすると件・会社が 0 に見える。呼び元は前の一覧を残す）
    inflight ??= call('GET', '/cards')
      .then(r => { if (r.status !== 200 || !Array.isArray(r.body?.cards)) throw new ListFailed(r.status); return r.body.cards as Card[]; })
      .finally(() => { inflight = null; });
    return inflight;
  };
  const fetchCards = async (bindingId?: string): Promise<Card[]> => {
    const all = await fetchAll();
    return bindingId ? all.filter(c => c.bindingId === bindingId) : all;
  };

  // guard しない形（呼び元の guarded が 401 を 1 回だけ処理する）
  const rawBindings = async (): Promise<Binding[]> => {
    const r = await call('GET', '/bindings');
    if (r.status !== 200 || !Array.isArray(r.body?.bindings)) throw new ListFailed(r.status);
    return r.body.bindings as Binding[];
  };

  // 話の発言（新しい話・続き）を送る口: 通信の失敗・応答の無さ・401 も例外にせず、画面に出す文を返す（act と同じ 20 秒の期限）。通信の失敗・期限の時は、サーバーが保存した後に応答だけ落ちたことがある。
  // 押し直すと同じ発言が 2 つでき担当が 2 回起きる（口に重複を除く鍵がまだ無い）ので、届いたかを読み直してから答える:
  // 届いていれば送れたにする／見つからない・確かめられない時は、押し直させずに引いて読み直してもらう。
  // 送った後の失敗・期限切れでは、端末が諦めてもサーバーは保存を続けていることがある（読み直しの後に保存が終わる）ので、見つからなくても「届いていない」とは言い切らない。
  // 言い切るのは通信を始める前に落ちたと分かる時だけ（token を読めない等。この時は読み直さない）
  const UNSURE = Symbol('unsure');
  const pressChat = async <T extends { ok: true }>(path: string, body: unknown, ok: (r: Res) => T | null, fallback: string, verify: (since: number) => Promise<T | null>): Promise<T | { ok: false; message: string }> => {
    const since = (opts.now ?? Date.now)();
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), opts.actTimeoutMs ?? 20_000);
    let lost: string;
    let sent = false;
    try {
      return await guarded(async () => {
        const r = await call('POST', path, body, true, ac.signal, () => { sent = true; });
        return ok(r) ?? fail(msg(r, `${fallback}（${r.status}）`));
      });
    } catch (e) {
      if (e instanceof Unauthorized) return fail('サインインし直してください');
      if (!sent) return fail(`${fallback}。届いていません。もう一度押してください`);
      lost = ac.signal.aborted ? '応答がありません' : '通信できませんでした';
    } finally { clearTimeout(timer); }
    const wait = opts.verifyWaitMs ?? 2000;
    if (wait > 0) await new Promise(res => setTimeout(res, wait));
    let found: T | null | typeof UNSURE;
    try { found = await verify(since); } catch (e) {
      if (e instanceof Unauthorized) return fail('サインインし直してください');
      found = UNSURE;
    }
    if (found === UNSURE || found === null) return fail(`${lost}。届いたか確かめられないので、電波を確かめて話を引いて読み直し、届いていない時だけもう一度送ってください`);
    return found;
  };
  // 送った時より前の発言は今回の物ではない（端末とサーバーの時計のずれは 2 分まで見る）
  const SKEW_MS = 2 * 60 * 1000;
  const isFresh = (at: string, since: number) => { const t = Date.parse(at); return Number.isFinite(t) && t >= since - SKEW_MS; };
  const findMine = (ms: ChatMessage[], text: string, since: number): ChatMessage | null =>
    [...ms].reverse().find(m => m.role === 'me' && m.text === text && isFresh(m.at, since)) ?? null;
  // 読む口: 200 でなければ失敗にする（呼び元は前の画面を残す）。応答が無い時も同じ期限で止める
  const read = async (path: string): Promise<Res> => {
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), opts.actTimeoutMs ?? 20_000);
    try { return await guarded(() => call('GET', path, undefined, true, ac.signal)); } finally { clearTimeout(timer); }
  };
  const chatBase = (b: string) => `/bindings/${bid(b)}`;

  const self: HttpClient = {
    async authProvider() {
      try { const r = await call('GET', '/auth/provider', undefined, false); return String(r.body?.name ?? ''); } catch { return ''; }
    },
    async me() {
      if (!(await opts.store.get())) return null;
      try {
        const r = await call('GET', '/me');
        return r.status === 200 ? { email: String(r.body.email), provider: String(r.body.provider) } : null;
      } catch (e) {
        if (e instanceof Unauthorized) { await dropDevice(); await opts.store.clear(); return null; }
        return null; // 通信できない時は token を残す（次に開いた時にまた試す）
      }
    },
    async signIn() {
      const { verifier, challenge } = await (opts.pkce ?? (() => makePkce(webPkceParts)))(); // 1 回ごとに作り、token を受けたら捨てる
      const back = await opts.openAuth(
        `${api}/auth/start?redirect=${encodeURIComponent(AUTH_REDIRECT)}&code_challenge=${challenge}&code_challenge_method=S256`, AUTH_REDIRECT);
      if (!back) return null;
      const code = new URL(back).searchParams.get('code'); // ?error=… の時は code が無い
      if (!code) return null;
      const r = await call('POST', '/auth/token', { code, code_verifier: verifier }, false);
      if (r.status !== 200 || typeof r.body?.token !== 'string') return null;
      await opts.store.set(r.body.token);
      signingOut = false;
      return { email: String(r.body.me.email), provider: String(r.body.me.provider) };
    },
    async signOut() {
      // 待つ所はどれも期限つき（電波が無いと通信も getDevicePushTokenAsync も返らないことがある）。期限を過ぎたら諦めて進み、token は必ず消す
      const wait = opts.signOutWaitMs ?? 5000;
      const within = <T,>(p: Promise<T>): Promise<T | undefined> =>
        Promise.race([p.catch(() => undefined), new Promise<undefined>(res => setTimeout(() => res(undefined), wait))]);
      signingOut = true; // 最初に立てる。以後の registerDevice は送らない
      await within(Promise.allSettled([...pendingRegs])); // 応答待ちの登録があれば、成否どちらでも待つ（成功すれば lastDevice に残る）
      // 記録が無い（前の起動で登録・今回の登録が失敗など）時は端末 token を取り直す。印が立っているので、そこで出る event の登録は送られない
      let dev = lastDevice; lastDevice = null;
      if (!dev && opts.deviceToken) dev = (await within(opts.deviceToken())) ?? null;
      const t = await opts.store.get();
      if (t) {
        if (dev) await within(call('DELETE', '/devices', { token: dev }));
        await within(call('POST', '/auth/signout', {}));
      }
      await opts.store.clear();
    },
    async listBindings() { return guarded(rawBindings); },
    async startBind(code): Promise<BindStart> {
      return guarded(async () => {
        const r = await call('POST', '/bindings', { code: code.trim() });
        return r.status === 201 || r.status === 200 ? { ok: true, bindingId: r.body.bindingId, company: r.body.company } : fail(msg(r, 'つなげませんでした'));
      });
    },
    async bindState(id): Promise<BindState> {
      return guarded(async () => {
        const r = await call('GET', `/bindings/${bid(id)}`);
        return r.status === 200 ? (r.body.state as BindState) : 'expired';
      });
    },
    async unbind(id): Promise<ActResult> {
      return guarded(async () => {
        const r = await call('DELETE', `/bindings/${bid(id)}`);
        return r.status === 200 ? { ok: true } : fail(msg(r, '解除できませんでした'));
      });
    },
    async prefs() {
      return guarded(async () => {
        const r = await call('GET', '/prefs');
        // 200 でない時に既定値（false）を作ると、切り替えでサーバーの設定を誤った値に上書きする。失敗にする
        if (r.status !== 200) throw new ListFailed(r.status);
        return { approvals: !!r.body.approvals, decisions: !!r.body.decisions, quiet: r.body.quiet ?? { from: '23:00', to: '7:00' } } as Prefs;
      });
    },
    async setPrefs(p) {
      await guarded(() => call('PUT', '/prefs', p));
    },
    // オフィス = 結びつけ（officeId = bindingId）。件数は未読 card をまとめて 1 回で数える
    async listOffices() {
      return guarded(async () => {
        const [bs, cards] = await Promise.all([rawBindings(), fetchCards()]);
        return bs.map((b): Office => ({
          id: b.id, name: b.company, canView: b.decisions === 'approved',
          pending: cards.filter(c => (c as Card & { bindingId?: string }).bindingId === b.id).length,
        }));
      });
    },
    async listCards(officeId) { return guarded(() => fetchCards(officeId)); },
    async summary(officeId): Promise<Summary | null> {
      return guarded(async () => {
        const cards = await fetchCards(officeId);
        return { pending: cards.length, urgent: cards.filter(c => isUrgent(c, (opts.now ?? Date.now)())).length };
      });
    },
    async act(card, actionId, values): Promise<ActResult> {
      const bindingId = card.bindingId;
      if (!bindingId) return fail('この件の結びつけが分かりません');
      // 押した操作は、通信の失敗・応答の無さも必ず画面に出す文にする（例外にすると画面は何も出さず固まる）
      const ac = new AbortController();
      const timer = setTimeout(() => ac.abort(), opts.actTimeoutMs ?? 20_000);
      try {
        return await guarded(async () => {
          const r = await call('POST', `/bindings/${bid(bindingId)}/cards/${bid(card.id)}/actions`, { actionId, ...(values ? { values } : {}) }, true, ac.signal);
          return r.status === 200 ? { ok: true } : fail(msg(r, `送れませんでした（${r.status}）`));
        });
      } catch (e) {
        if (e instanceof Unauthorized) return fail('サインインし直してください');
        return fail(ac.signal.aborted ? '応答がありません。電波を確かめて、もう一度押してください' : '通信できませんでした。電波を確かめて、もう一度押してください');
      } finally { clearTimeout(timer); }
    },
    async markSeen(card): Promise<ActResult> {
      const bindingId = card.bindingId;
      if (!bindingId) return fail('この件の結びつけが分かりません');
      return guarded(async () => {
        const r = await call('POST', `/bindings/${bid(bindingId)}/cards/${bid(card.id)}/seen`, {});
        return r.status === 200 ? { ok: true } : fail(msg(r, '見たにできませんでした'));
      });
    },
    async chatAgents(bindingId): Promise<AgentDirectory> {
      const r = await read(`${chatBase(bindingId)}/agents`);
      if (r.status !== 200 || !Array.isArray(r.body?.departments)) throw new ListFailed(r.status);
      return { departments: r.body.departments, secretaryId: String(r.body.secretaryId ?? '') };
    },
    async listThreads(bindingId, agentId): Promise<Thread[]> {
      const r = await read(`${chatBase(bindingId)}/threads?agentId=${encodeURIComponent(agentId)}`);
      if (r.status !== 200 || !Array.isArray(r.body?.threads)) throw new ListFailed(r.status);
      return r.body.threads as Thread[];
    },
    async createThread(bindingId, input): Promise<CreateThreadResult> {
      const bad = checkText(input.text);
      if (bad) return fail(bad);
      const body = { agentId: input.agentId, text: input.text, ...(input.cardId ? { cardId: input.cardId } : {}) };
      return pressChat(`${chatBase(bindingId)}/threads`, body,
        r => (r.status === 201 && r.body?.thread?.id ? { ok: true as const, thread: r.body.thread as Thread } : null), '話を始められませんでした',
        async since => {
          // 送った後に動いた話（新しい順）の最初の発言が今回の文なら、その話が作られている
          const ts = (await self.listThreads(bindingId, input.agentId)).filter(t => isFresh(t.lastMessageAt, since)).slice(0, 5);
          for (const t of ts) {
            const p = await self.listMessages(bindingId, t.id);
            const first = p.messages[0];
            if (first && first.role === 'me' && first.text === input.text && isFresh(first.at, since)) return { ok: true as const, thread: t };
          }
          return null;
        });
    },
    async listMessages(bindingId, threadId, after): Promise<MessagePage> {
      const q = after ? `?after=${encodeURIComponent(after)}` : '';
      const r = await read(`${chatBase(bindingId)}/threads/${bid(threadId)}/messages${q}`);
      if (r.status !== 200 || !Array.isArray(r.body?.messages)) throw new ListFailed(r.status);
      return { messages: r.body.messages as ChatMessage[], status: r.body.status };
    },
    async sendMessage(bindingId, threadId, text): Promise<SendResult> {
      const bad = checkText(text);
      if (bad) return fail(bad);
      return pressChat(`${chatBase(bindingId)}/threads/${bid(threadId)}/messages`, { text },
        r => (r.status === 201 && r.body?.message?.id ? { ok: true as const, sent: r.body.message as ChatMessage } : null), '送れませんでした',
        async since => {
          const sent = findMine((await self.listMessages(bindingId, threadId)).messages, text, since);
          return sent ? { ok: true as const, sent } : null;
        });
    },
    async overview(bindingId): Promise<Overview | null> {
      const r = await read(`${chatBase(bindingId)}/overview`);
      if (r.status === 404) return null;
      if (r.status !== 200 || !r.body?.whole) throw new ListFailed(r.status);
      return r.body as Overview;
    },
    async registerDevice(token, env, bundleId) {
      if (signingOut) return false;
      const p = guarded(async () => {
        const ok = (await call('POST', '/devices', { platform: 'ios', token, env, bundleId })).status === 200;
        if (ok) lastDevice = token; // サインアウト中に応答が来ても残す（サインアウトが待って解除する）
        return ok;
      });
      pendingRegs.add(p); p.then(() => pendingRegs.delete(p), () => pendingRegs.delete(p));
      return p;
    },
    async unregisterDevice(token) {
      if (lastDevice === token) lastDevice = null;
      try { await guarded(() => call('DELETE', '/devices', { token })); } catch { /* サインアウトは止めない */ }
    },
    async hasToken() { return !!(await opts.store.get()); },
    onUnauthorized(cb) { listeners.add(cb); return () => { listeners.delete(cb); }; },
  };
  return self;
}
