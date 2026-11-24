// push の決め事（RN に依らない部分）。端末の部品は native.ts が渡す。
import type { DeviceEnv } from './http.ts';

export const BUNDLE_ID = 'jp.ne.eln.aioffice'; // サーバーはこの bundleId 以外を通さない

// APNs の env は端末の token がどちらの APNs のものかで決まる。
// 埋め込みの provisioning profile を読む expo-application の値を第一に使う（TestFlight・App Store = production、
// Xcode から入れた開発の build = development → sandbox）。読めない時（null）は __DEV__ で決める
// （開発の build は sandbox、配布の build は production）。間違えると APNs が BadDeviceToken を返し、サーバーが端末を消す。
export const pushEnv = (apns: 'development' | 'production' | null, isDev: boolean): DeviceEnv =>
  apns === 'development' ? 'sandbox' : apns === 'production' ? 'production' : isDev ? 'sandbox' : 'production';

// 判断の件の通知: bindingId・cardId。話の返事の通知: bindingId・threadId（agentId は載っていれば使う）。
// agentName は通知の題（= 担当の名前・仕様 4）から取り、開いた話の題に使う
export type CardTarget = { bindingId: string; cardId: string };
export type ThreadTarget = { bindingId: string; threadId: string; agentId?: string; agentName?: string };
export type PushTarget = CardTarget | ThreadTarget;
export const isThreadTarget = (t: PushTarget): t is ThreadTarget => 'threadId' in t;

const str = (v: unknown): v is string => typeof v === 'string' && v.length > 0;
// 通知の data（サーバーは bindingId と cardId か threadId だけを載せる）から開く先を取る。足りなければ null
export function tapTarget(data: unknown): PushTarget | null {
  if (typeof data !== 'object' || data === null) return null;
  const d = data as Record<string, unknown>;
  if (!str(d.bindingId)) return null;
  if (str(d.cardId)) return { bindingId: d.bindingId, cardId: d.cardId };
  if (str(d.threadId)) return { bindingId: d.bindingId, threadId: d.threadId, ...(str(d.agentId) ? { agentId: d.agentId } : {}) };
  return null;
}

// 押した通知から開く先を取る。サーバーは Expo の push サービスを通さず APNs に直接送り、bindingId・cardId（話は threadId）を payload の最上位に置く。
// expo-notifications(iOS) は remote の通知の content.data に userInfo["body"] だけを入れるので、この形では空になる。
// 元の payload は trigger.payload（iOS）にあるので、content.data → trigger.payload の順に探す。
export function tapTargetOf(content: { data?: unknown; title?: string | null } | null | undefined, trigger: unknown): PushTarget | null {
  const t = tapTarget(content?.data)
    ?? (typeof trigger === 'object' && trigger !== null ? tapTarget((trigger as { payload?: unknown }).payload) : null);
  if (t && isThreadTarget(t) && str(content?.title)) return { ...t, agentName: content.title };
  return t;
}

// push で届いた返事: 開いている話（同じ結びつけの同じ話）の時だけ読み直す
export const pushReloads = (t: PushTarget | null, open: { bindingId: string; threadId: string } | null): boolean =>
  !!t && !!open && isThreadTarget(t) && t.bindingId === open.bindingId && t.threadId === open.threadId;

export type PushDeps = {
  requestPermission(): Promise<boolean>;
  getToken(): Promise<string>;
  env(): Promise<DeviceEnv>;
  register(token: string, env: DeviceEnv, bundleId: string): Promise<boolean>;
};
// 許可 → 生の device token → 登録。許可が無ければ何もしない（null）。登録した token を返す
export async function registerForPush(d: PushDeps): Promise<string | null> {
  if (!(await d.requestPermission())) return null;
  const token = await d.getToken();
  return (await d.register(token, await d.env(), BUNDLE_ID)) ? token : null;
}
