# レビューの範囲: アプリを本物の通知 API につなぐ（サインイン・push の登録・通知から開く）

対象: apps/mobile の feat/app-real-notify-push（origin/main...HEAD）。通知 API の約束は 開発元の通知 API の ADR-0008（開発元の通知 API の repo・notify-admin-v0.4.0）。

## 保証すること

1. 通知 API の URL が設定されていれば本物の client を使い、空の時だけ fake を使う。秘密をアプリに焼き込まない（URL だけ）。
2. サインインは PKCE（S256）。verifier はサインインの 1 回ごとに作り、端末の外に出さない。戻り先は `aioffice://auth` だけ。
3. アプリ token は expo-secure-store にだけ保存する。401 で消してサインイン画面へ戻す。サインアウトで token と端末の登録を消す。
4. push の token は APNs の生の device token（Expo の push サービスの token を使わない）。許可が無ければ登録しない。
5. 通知を押すと、その bindingId と cardId の詳細を開く（閉じていた時も）。件が無ければ知らせる。

## 保証しないこと

1. 実機での push の受信（APNs と端末の設定に依存）。配備の後に実機で確かめる。
2. Android（段 1b）。
3. 通知のボタン・通知からの返信（段 2）。

## 前提

1. 通知 API は notify-admin-v0.4.0 以降（PKCE・端末の bundleId の許可の一覧を含む）。
2. TestFlight の build は production の APNs を使う。開発の build は sandbox。
3. 画面は承認済みの mock（docs/mocks/）のまま。新しい画面は足さない。

## 受け入れる限界

1. env（production / sandbox）の判定は provisioning profile を優先し、読めなければ `__DEV__` で決める。
2. アプリ token の有効期限は 30 日。切れたらサインインし直す。
3. ios/ は prebuild の産物で git に入らない。entitlements と Info.plist は app.json の設定から作られる。
4. 401（token 切れ）で端末の登録を外せるのは、端末 token の DELETE が通る時だけ（token が無効なら失敗し、登録は古い sub に残りうる）。サーバー側で同じ token を他の人の行から外す改善は 開発元の通知 API の後の作業。
5. サインアウトの中で待つ所は 5 秒で諦める。期限を過ぎた後に遅れて成功した端末の登録や、届かなかった解除は、サーバーに残りうる（アプリの側だけでは閉じきれない種類）。根本の直しは 開発元の通知 API で、端末を登録する時に同じ token を他の人の行から外す（後の作業）。
6. aps-environment は app.json で production に固定。TestFlight・App Store の build は production で正しい。Xcode から入れる開発の build が自動署名で development の entitlements になるか、署名が落ちるかは未確認（この環境では実機に入れていない）。

## user の裁定

- 開発元 2026-11-10: push は Expo の push サービスを使わず APNs に直接送る。ログインは開発元の SSO。
- 開発元 2026-11-12: iPhone の push に関わるものを引き取り、この session で実現する。
