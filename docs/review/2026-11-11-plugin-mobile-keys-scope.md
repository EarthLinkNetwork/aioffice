# plugin「mobile」v0.3.0 — 判断の key を出す・入れ替える・失効させる／key の無い人へのお知らせ／結びつけの画面（段 1 の次の PR）の範囲

対象: plugins/mobile（src/host-auth-client.mjs・src/relay.mjs・src/worker.mjs・src/manifest.mjs・src/ui.mjs）と plugins/build.mjs、test/mobile-keys.test.mjs・test/mobile-worker.test.mjs、docs/mocks/plugin-link-page-mock.html。設計は 開発元の docs/design/2026-11-10-mobile-app.md の「会社ごとの判断の扱い方」と「結びつけ」（承認済み）。前の PR の範囲は docs/review/2026-11-11-plugin-mobile-relay-scope.md。

## 保証すること
- key を出す: 結びつけが有効な本人だけが「判断を受けるために承認する」で依頼を作れる。承認待ちの依頼が期限内にあれば同じ依頼を返す（二重に押しても依頼は 1 つ）（本体の `POST /api/cli-auth/challenges`・`clientName` は「AI Office: <メールアドレス> との結びつけ」・`requestedCompanyId` はその会社）。承認の URL はその本人の画面にだけ返す（card・notify・ログには出さない）。
- 持ち主の確かめ: 承認された key は `GET /api/cli-auth/me` で持ち主を読み、依頼した本人と違えばその key を失効させて使わない（結びつけは有効のまま・key の段だけやり直せる）。10 分で切れた・取り消された依頼は捨てる。
- 入れ替え: 期限の 7 日前になったら、その key で同じ人の名義の新しい key（期限 30 日・期限なしは作らない）を作り、古い key を失効させる。人の操作は要らない。
- 失効: 結びつけを外した（その人の有効な結びつけが 1 つも無くなった）・会社のメンバーから外れた・入れ替えで古くなった・持ち主が違った・承認し直して前のものになった key は、失効の列に移して本体で失効させる。失効に失敗したら列に残し、失効できるか key の期限が来るまで毎回やり直す（追跡を失わない）。
- 捨てた依頼（期限内の上書き・外した人・外れた人・切れた依頼・全員の取り消しの時の依頼）は本体の期限の 1 時間後まで見張り、後から承認されたらその key を失効させる。
- 持ち主を読む時の一時的な失敗（401/403 以外）では key を失効させず、次の回にやり直す。
- 入れ替えは、新しい key を状態に置いてから古い key を失効させる。入れ替えで本体が key を断った（401/403）時は、切れた扱いにしてお知らせを出す。
- 会社の管理者は「全員の判断の承認を取り消す」で、全員の key を失効させられる（plugin を外す前に押す。外す時の呼び出しが本体に無いため）。
- key の無い人へのお知らせ: 会社ごとの判断を読む設定（`hostUrl`）がある会社で、結びつけが有効なのに有効な key が無い人には、その人の受信箱にだけ「承認が要ります」の 1 件（`kind: notice`・押す操作なし・push しない）を置く。入れ替えに失敗して期限が近い時は「あと n 日で判断を受けられなくなります」、切れた・失効した後は「判断を受けるには承認し直してください」と文言を分ける。key が有効になったら次の回に消す。
- お知らせしか無い間は、押された操作を取りに行かない（押す操作の無い card は「片付いていない card」に数えない）。
- key で呼ぶ本体の口は、判断を読む・決める（前の PR）と、key の持ち主を読む・自分の key の一覧・新しい key を作る・今の key を失効させるの 4 つだけ（test で止める）。key・依頼の秘密はログ・例外・戻り値・card・notify に出さない。
- 結びつけの画面（本体の「AI Office」の page と sidebar の入口・mock は開発元 2026-11-11 に承認。`UI_APPROVED = true`）: スマホとつなぐ（code を出す → 名乗り出たメールアドレスを出し、code を出した本人が「つなぐ」か「断る」）・判断を受けるために承認する・つないでいるスマホの一覧と「外す」（本人と会社の管理者）。人は本体のログインで決まる人だけ（画面から送る値の人は使わない）。

## 保証しないこと
- notify の口の形（仮の形のまま・`NOTIFY_API`）と、実物の notify との E2E。
- 画面の見た目の実機の確かめ（開発元のサーバーへの配備の後）。
- plugin を外した時の自動の key の失効（本体に外す時の呼び出しが無い・`onShutdown` は再起動でも呼ばれるので使えない）。代わりに、外す前に管理者が「全員の判断の承認を取り消す」を押す（開発元 2026-11-11 の裁定・下の「user の裁定」）。
- `hostUrl` を設定から外した後に外れた人の key の失効（本体を呼ぶ URL が無いので、失効の列に残し key の期限で切れる）。
- 漏れた key から作られた key の失効（board の key は自分で新しい key を作れるため、古い key を失効させても残る。設計の「受け入れる限界」のとおり）。

## 前提
- 本体 2026.1001.0 の口（開発元のサーバーの server/dist/routes/access.js で確かめた）:
  - `POST /api/cli-auth/challenges`（認証なし・`{ command, clientName, requestedAccess: 'board', requestedCompanyId }` → `{ id, token, boardApiToken, approvalPath, expiresAt }`）。承認されると `boardApiToken` がその人の名義の key になる（期限は承認から 30 日）。
  - `GET /api/cli-auth/challenges/:id?token=`（`status: pending | approved | expired | cancelled`）。承認された依頼も 10 分を過ぎると `expired` と返す（services/board-auth.js の `challengeStatusForRow` は期限を承認より先に見る）。そのため pending 以外の時と、捨てた依頼の見張りは、依頼の key そのもので `GET /api/cli-auth/me` を呼び、読めれば承認済みとみなす。
  - `GET /api/cli-auth/me`（key の持ち主の `userId`・`keyId`）・`GET /api/board-api-keys`（自分の key の期限）・`POST /api/board-api-keys`（`{ name, expiresAt, requestedCompanyId }` → `{ id, token, expiresAt }`）・`POST /api/cli-auth/revoke-current`（呼んだ key を失効）。
- 承認の画面の URL は `hostUrl` + `approvalPath`（本体が返す `approvalUrl` は plugin から呼んだ時の URL で作られるため使わない）。
- 本体の画面の page は `/:会社の prefix/ai-office`（manifest の `routePath`）。お知らせの「Paperclip で開く」はこの URL。
- `hostUrl` は `https://` だけ（前の PR のとおり）。

## 受け入れる限界
- 管理者が「全員の判断の承認を取り消す」を押し忘れて plugin を外すと、結びついた人の判断の key は失効せず、最長 30 日（key の期限）有効なまま本体の DB の plugin の状態に残る（開発元 2026-11-11 の裁定で受け入れ）。
- 依頼の秘密（`token`・`boardApiToken`）は、承認されるか、捨てた依頼として本体が断る（期限の 1 時間後以降の 401/403）まで plugin の状態に置く。本体が答えないままなら、期限の 24 時間後に捨てる。
- 本人が期限内に承認した後、本体が 1 時間以上答えない（5xx）と、その依頼は捨てた依頼になり、本体が戻った時にその key を失効させる（本人には「承認が要ります」が出て、承認し直せば戻る・安全側）。承認の URL には依頼の `token` が入る（本人の画面にだけ出す）。
- key の確かめと入れ替えは 30 秒ごとの定期の処理で行う（承認してから key が使えるまで最長 30 秒。画面を開いている本人の分は、画面の状態の読み出しでもすぐ確かめる）。
- 入れ替えで古い key の失効に失敗した時は、新しい key を使い、古い key は期限（7 日以内）で切れるのを待つ（ログに残す）。

## user の裁定
- 開発元 2026-11-11:「判断は最初から入れるで」（会社ごとの判断を最初の版から扱う・plugin に本体の API の鍵を持たせる）。
- 結びつけの両方向の確認・管理者が全員の結びつけを外せること: 設計の「結びつけ」（開発元 2026-11-10 の裁定で確定）。
- 開発元 2026-11-11: 結びつけの画面の mock（docs/mocks/plugin-link-page-mock.html・Paperclip 側の「AI Office」の画面）は「この mock でよい」→ approved・`UI_APPROVED = true`。
- 開発元 2026-11-11: key の失効は「外す前に管理者が全員の判断の承認を取り消す形でよい」→ plugin を外す時の自動の失効の代わりに `keys.revokeAll`。押し忘れた時は最長 30 日で切れる（受け入れる限界）。設計の文書（開発元の docs/design/2026-11-10-mobile-app.md）も同じ形に直した。
