# aioffice

**Getting started / 始め方:** [English](docs/getting-started.md) · [日本語](docs/getting-started.ja.md)

AI オフィス（Paperclip の上で AI の担当が働く会社）の、**共有のスマホアプリ**と、各社の Paperclip に入れる **plugin** です。

- アプリは 1 つだけで、どの会社の AI オフィスでも使えます。各社がアプリを作ったり、Apple・Google の開発者の仕組みを持ったりしなくて済みます。
- 判断待ち（承認・課題ごとの判断カード）が出たら、スマホに push で届きます。アプリから中身を全文で読み、承認・却下を押せます。

今は private です。公開できると確かめてから public にします。

## 仕組み

```
各社の Paperclip
  └─ plugin「mobile」（この repo の plugins/mobile）
       ├─ 判断待ちを card（v1）にして通知 API へ送る・片付いたら消す
       ├─ 押された操作を通知 API から取りに行き、押した人の名義で反映する（外への呼び出しだけ）
       └─ 結びつけの画面（Paperclip の人 ↔ アプリにログインした人。両方向の確認・一覧と解除）
            │ HTTPS（project のキー）
            ▼
通知 API（アプリを出した会社が運用する。iPhone は APNs、Android は FCM へ送る）
            ▲
共有のスマホアプリ（この repo の apps/mobile。iPhone が先・Android は後）
```

- push の中身は件の id と件数だけです。アプリはログインした本人の名義で通知 API から中身を読みます。
- plugin が反映するのは、次をすべて満たす操作だけです。
  - plugin 自身が送った card である。
  - 押した人が、その card の宛先の本人である。
  - 押した時の中身が今の件と同じである。
  - card の選択肢にある操作である。
  - 期限内で、まだ使われていない。
  - そのうえで、Paperclip 本体が押した人の権限を確かめ直す。

## 置き場

| 場所 | 中身 |
|---|---|
| `plugins/mobile` | Paperclip の plugin（card の型・通知 API へ送る・押された操作の反映・結びつけの画面・会社ごとの判断の key） |
| `apps/mobile` | 共有のスマホアプリ（これから作る） |
| `test/` | `npm test`。特定の会社の運用の語が入ったら落ちる test を含む |
| `docs/mocks` | 画面の mock（見た目の契約）と索引 |

## plugin（plugins/mobile・v0.3.0）

| ファイル | 役目 |
|---|---|
| `src/cards.mjs` | 承認・課題ごとの判断カード（確認）・会社ごとの判断を card（v1）にする |
| `src/notify-client.mjs` | 通知 API の口を project のキーで呼ぶ。口の path は `NOTIFY_API` の 1 か所だけ |
| `src/decisions-client.mjs` | 会社ごとの判断を、結びついた人の board API key で読む・決める（口はこの 2 つだけ） |
| `src/host-auth-client.mjs` | 判断の key の依頼（本体の CLI のログインの仕組み）・持ち主の確かめ・入れ替え・失効。key で呼ぶ口は 4 つだけ |
| `src/ui.mjs` | 本体の画面「AI Office」（`/<会社の prefix>/ai-office`）: スマホとつなぐ・判断を受けるために承認する・つないでいるスマホ。mock は `docs/mocks/plugin-link-page-mock.html` |
| `src/relay.mjs` | 送る・消す・押された操作を許可の一覧で確かめて反映する・結びつけ・判断の key の手入れ・key の無い人へのお知らせ |
| `src/worker.mjs` | 出来事（approval.created・decided）・30 秒ごとに探す・15 秒ごとに取りに行く（片付いていない card がある間だけ） |

- 初めて入れる回は、今ある件を受信箱に入れるだけで push しません。後から結びついた人・中身の更新・key を承認した時点で open の判断にも push しません。
- 課題ごとの判断カードは「確認」（accept / reject）だけを card にします。選ぶ・答える種類は、答えの中身を渡す口が本体の SDK に無いため web で答えます。
- 設定: `notifyUrl`・`notifyKey`（secret の参照）・`notifyKeysByCompany`（会社ごとに別のキーにする時）・`hostUrl`（会社ごとの判断を読む時だけ・`https://` の公開の URL だけ）。キーと key はログ・card・通知 API に出しません。
- 共有のキー: 1 つの Paperclip の複数の会社が同じ `notifyKey` を使うと、通知 API の「押された操作」の一覧には全部の会社の分が入ります。card の id を `<種類>:<会社の id>:<件の id>` にしてあり、各会社は自分の会社の id の操作だけを確かめて結果を返し、ほかの会社の分は結果を返さずに飛ばします（その会社が返す）。
- 片付いたとみなすのは、2 回続けて見えなかった件だけです（課題は状態ごと・offset で読むので、途中で並びが変わると 1 回取りこぼすことがある）。web で決まった件の card は、長くて 30 秒ほど残ります。
- 押された操作を取りに行くのは、片付いていない card がある間と、最後の card が片付いた後の 1 回です。片付いた件の操作には「もう決まっている」（`already-resolved`）を返します。
- 通知 API の口の path と形は、通知 API の側でまだ決まっていません。今は仮の形で、決まったら `NOTIFY_API` を差し替えます。

会社ごとの判断の key（v0.3.0）
- 結びついた本人が画面の「判断を受けるために承認する」を押すと、本体の CLI のログインの依頼（`AI Office: <メールアドレス> との結びつけ`）を作り、承認の画面をその人にだけ開く。承認されたら key の持ち主が本人かを確かめ、違えばその key を失効させる。
- 期限（30 日）の 7 日前に、その key で同じ人の新しい key を作り、古い key を失効させる。結びつけを外した・メンバーから外れた人の key は失効させる。
- key の無い人には、その人の受信箱にだけ「承認が要ります」のお知らせを置く（押す操作なし・push しない）。入れ替えに失敗した時は「あと n 日」、切れた後は「承認し直して」。お知らせしか無い間は押された操作を取りに行かない。
- plugin を外す前に、会社の管理者が画面の「全員の判断の承認を取り消す」を押す（外す時に key を失効させる口が本体に無いため）。
- 画面の mock は `docs/mocks/plugin-link-page-mock.html`（2026-11-11 承認）。`src/manifest.mjs` の `UI_APPROVED` を false にすると画面を本体から外せる（その間は key の依頼もお知らせも出ない）。
- 管理者が押し忘れて plugin を外した時は、判断の key は最長 30 日（key の期限）で切れる。

## iPhone のアプリを TestFlight へ出す

1. `apps/mobile/app.json` の `expo.ios.buildNumber`（版を変える時は `expo.version` も）を上げる。
2. `EXPORT_PROFILE="AI Office App Store" XCODE_JOBS=6 nice -n 10 bash apps/mobile/scripts/ios-local-publish.sh`
   - 途中で `apps/mobile/scripts/ios-sim-launch-check.sh` が、Release を iOS 27 のシミュレーターで起動し、12 秒落ちないことを確かめる。落ちたら提出しない。
   - その段だけを先に回す時は `bash apps/mobile/scripts/ios-sim-launch-check.sh`（iOS を変える時は `SIM_IOS_MAJOR=28` など）。
- iOS 27 は scene の仕組み（Info.plist の `UIApplicationSceneManifest`）を使っていないアプリを起動時に終了させる。`ios/` は prebuild で毎回作り直すので、宣言と AppDelegate の形は `apps/mobile/plugins/with-scene-lifecycle.js` が入れる（Expo SDK 57 以上の `EXExpoAppSceneDelegate` を使う）。

## 守ること

- この repo には、どの会社でも使える汎用の部分だけを置きます。特定の会社の運用（会社の名前・担当の名前・社内の仕組みの名前）は書きません。`test/no-company-words.test.mjs` が止めます。
- 画面の文言・種類の名前・担当の名前は、サーバーから受け取ります。
