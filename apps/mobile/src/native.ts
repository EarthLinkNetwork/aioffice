// 端末の部品（保存・ブラウザ・乱数・push）。ここだけが expo の native module を import する。
import * as SecureStore from 'expo-secure-store';
import * as WebBrowser from 'expo-web-browser';
import * as Crypto from 'expo-crypto';
import * as Notifications from 'expo-notifications';
import * as Application from 'expo-application';
import Constants from 'expo-constants';
import { createHttpClient, type HttpClient, type TokenStore } from './notify/http';
import { makePkce } from './notify/pkce';
import { pushEnv, tapTargetOf, type PushDeps, type PushTarget } from './notify/push-logic';

const KEY = 'aioffice.appToken';
const store: TokenStore = {
  get: () => SecureStore.getItemAsync(KEY),
  set: t => SecureStore.setItemAsync(KEY, t),
  clear: () => SecureStore.deleteItemAsync(KEY),
};

// 通知 API の URL（app.json の extra.notifyBaseUrl）。空なら null → fake を使う
export const notifyBaseUrl = (): string | null => {
  const u = (Constants.expoConfig?.extra as { notifyBaseUrl?: string } | undefined)?.notifyBaseUrl;
  return u && u.trim() ? u.trim() : null;
};

export const createRealClient = (baseUrl: string): HttpClient => createHttpClient({
  baseUrl, store,
  deviceToken: async () => String((await Notifications.getDevicePushTokenAsync()).data),
  pkce: () => makePkce({
    randomBytes: n => Crypto.getRandomBytesAsync(n),
    sha256: async d => new Uint8Array(await Crypto.digest(Crypto.CryptoDigestAlgorithm.SHA256, d as BufferSource)),
  }),
  openAuth: async (url, redirect) => {
    const r = await WebBrowser.openAuthSessionAsync(url, redirect);
    return r.type === 'success' ? r.url : null;
  },
});

export const pushDeps = (client: HttpClient): PushDeps => ({
  async requestPermission() {
    let s = await Notifications.getPermissionsAsync();
    if (s.status !== 'granted' && s.canAskAgain) s = await Notifications.requestPermissionsAsync({ ios: { allowAlert: true, allowBadge: true, allowSound: true } });
    return s.status === 'granted';
  },
  // Expo の push サービスの token ではなく、APNs の生の device token
  async getToken() { return String((await Notifications.getDevicePushTokenAsync()).data); },
  async env() { return pushEnv(await Application.getIosPushNotificationServiceEnvironmentAsync().catch(() => null), __DEV__); },
  register: (t, e, b) => client.registerDevice(t, e, b),
});

// token が変わった時に呼ばれる（APNs が token を替えた時）
export const onPushTokenChange = (cb: (token: string) => void) => {
  const s = Notifications.addPushTokenListener(t => cb(String(t.data)));
  return () => s.remove();
};

// 通知を押した時。閉じていたアプリを押して開いた時は、起動の最初に 1 回だけ返す
export function onNotificationOpen(cb: (t: PushTarget) => void): () => void {
  const handled = new Set<string>();
  const handle = (r: Notifications.NotificationResponse | null) => {
    if (!r || handled.has(r.notification.request.identifier)) return;
    handled.add(r.notification.request.identifier);
    const t = tapTargetOf(r.notification.request.content, r.notification.request.trigger);
    if (t) cb(t);
  };
  Notifications.getLastNotificationResponseAsync().then(handle);
  const s = Notifications.addNotificationResponseReceivedListener(handle);
  return () => s.remove();
}

// アプリを開いている間に届いた通知（話の返事なら、開いている話を読み直す）
export function onNotificationReceived(cb: (t: PushTarget) => void): () => void {
  const s = Notifications.addNotificationReceivedListener(n => {
    const t = tapTargetOf(n.request.content, n.request.trigger);
    if (t) cb(t);
  });
  return () => s.remove();
}

// ホーム画面のバッジを件数に合わせる（0 で消す）。失敗しても画面は止めない
export const setBadge = (n: number): Promise<unknown> => Notifications.setBadgeCountAsync(n).catch(() => undefined);
