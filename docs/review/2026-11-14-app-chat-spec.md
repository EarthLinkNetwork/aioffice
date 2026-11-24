# アプリの「秘書と話す」「担当と話す」「Daily Times」「会社」の仕様（v1）

画面の契約: `docs/mocks/app-chat-mock.html`（2026-11-14 開発元が「この形で作る」で承認）。
作る所: Paperclip（開発元の会社）・plugin「mobile」（aioffice）・通知 API（開発元）・アプリ（aioffice/apps/mobile）。

## 保証すること

### 話（チャット）
1. 話 1 件 = Paperclip の課題 1 件。**新しい話**は、最初の発言を課題の本文（description）に入れ、担当を割り当てた `todo` で作る（割り当てで担当が 1 回起きる。最初の発言を comment にしない）。題は最初の発言の先頭 40 字。
2. **続きの発言**は、その課題への利用者の名前の comment（`ctx.issues.createComment(..., { actorUserId: 結びつけの持ち主 })`）。課題が閉じている（`done`・`cancelled`）時は、先に `ctx.issues.update(..., { status: 'todo' })` で開き直してから comment を書く（閉じていない課題への人の名前の comment は、Paperclip の決まりで担当を起こす）。`requestWakeup` は毎回は呼ばない（comment で起きた分と合わせて 2 回動くため）。5 の読み直しで、発言から 3 分たっても返事も担当の実行も無い時だけ、`requestWakeup(issueId, { idempotencyKey: 発言の id })` を 1 回呼ぶ。
3. **担当の返事**は、話の課題に担当が書いた comment だけ。見分け方: その課題が plugin の話の索引（state `chatIssues`）にあり、comment の `authorType` が担当（agent）で、`authorAgentId` がその課題の担当。利用者の名前の comment・system の comment・ほかの課題（秘書が回した子の課題を含む）の comment は返事にしない。plugin は出来事 `issue.comment.created` で受け、`ctx.issues.listComments` で書き手を確かめてから通知 API に渡す。
4. 通知 API は返事を comment の id で 1 回だけ保存する（同じ id は条件つきの書き込みで捨てる）。保存した時だけ push（題 = 担当の名前、本文 = 返事の先頭 120 字）。この push は承認・判断の通知の設定でも静かな時間でも止めず、いつもどおり音つきで送る（本人が待っている返事のため・2026-11-14 開発元の裁定「いつもどおり鳴らす」・開発元の通知 API の ADR-0009）。出来事と下の読み直しが同じ comment を見つけても push は 1 回。
5. 出来事の取りこぼしに備え、`what=sync`（毎分）で、直近 24 時間に発言があった話の課題だけ comment を読み直し、まだ渡していない返事を渡す（読み直す話は最大 20 件）。
6. アプリの発言は、通知 API に「担当へ未送」として保存する。plugin は `what=poll`（15 秒おき）で未送の発言を取り（判断の件が無くても取る）、1・2 の形で Paperclip に書き、課題の id を添えて「送った」にする。書く前に plugin の state に「発言の id → 課題の id・comment の id」を書き、やり直しの時は state を見て二重に作らない（何度やり直しても結果は 1 つ）。返事の遅れには、この最大 15 秒が足される。
7. アプリは話の一覧（担当ごと・新しい順）と、話の中の発言（古い順）を出す。返事を待つ間は「考えています…」。返事は push か、話を開いていて返事待ちの間だけの 5 秒おきの読み直し（最長 3 分で止め、あとは push と引いて読み直し）。担当の実行が失敗した時（5 の読み直しで、課題の最後の実行が失敗）は、通知 API に「返事できませんでした」の system の発言を入れ、アプリは「考えています…」をやめてそれを出す。
8. 話の状態（mock ②）: 課題の状態から作る（`todo`・`in_progress` = 返事待ち、`done` = 済み）。秘書が担当に回した時は、課題の子の課題（`ctx.issues.getSubtree`）から「<担当> に回した」を出す。
9. 秘書: 開発元の会社に担当「秘書」を 1 人足す（決まり `kit/agents/secretary.md`）。秘書は自分で答えられる事は答え、できない事は担当に子の課題で回し、子が片付いたら結果を元の話に comment で返す（元の話は子が片付くまで `in_progress` のまま）。下のタブ「秘書」は、開くと直前の話の続き。「＋ 新しい話」で新しい課題を作る。
10. 判断の件の「決められない — 担当と話す」: 件を作った担当（承認なら依頼した担当、判断カードなら作った担当、分からなければ秘書）と話す。その件の話がまだ無ければ新しい話を作り、本文に件の題・要約・詳細・選択肢を入れる。あれば続きを開く（card の `thread` と端末の対応で探す）。カードの画面の下に「この件の話」（直近の発言と入力欄）を出し、話の画面の札から元のカードへ戻れる。担当の「結論:」の返事は元のカードに「話の結論」として出る（2026-11-22 に改めた・docs/design/2026-11-22-app-card-ux.md）。
11. 発言は 4000 字まで。話は消さない（Paperclip の課題として残る）。通知 API の話の行（話の一覧に出る題・担当・状態）は消えない（ttl なし）。発言の写しは 90 日で消える（TTL）ので、90 日より前の発言は Paperclip の課題で読む（開発元の通知 API の ADR-0009）。
### 担当の一覧と会社
12. plugin は定期の処理（`what=sync`）で、担当の一覧（id・名前・役割・部署）を通知 API に渡す。部署は plugin の設定 `departments`（会社の id ごとに、部署の名前と担当の id の組）で決める。設定に無い担当は「その他」。一緒に、その結びつけの会社の id（`companyId`・Paperclip の会社の id）も送る。通知 API は結びつけと会社の対応をこれでしか知らないので、13 の会社のサマリーと Daily Times は `companyId` を送った結びつけにだけ出る（送らない結びつけの「会社」「Daily Times」は空）。
13. 会社のサマリーと Daily Times は、開発元の会社にしかない機能のため開発元のサーバーの cron（`ops/mobile-overview.mjs`・10 分おき）が通知 API に渡す（plugin の鍵）。中身は部署ごとの要約・注意・作業中の担当、と今日の Daily Times の号（今日すること・新着・会社のできごと・Web の号の URL）。
14. アプリの下のタブは「受信箱・秘書・Daily Times・会社」。設定は右上の ⚙️。会社 → 部署 → 担当の一覧 → 担当と話す。

### 安全
15. アプリの口はすべてアプリの token（30 日）で、その人の active な結びつけの物だけを読み書きする。アプリから届く id は 1 つずつ確かめる: 話の id はその結びつけの話か／担当の id はその結びつけの会社の担当の一覧にあるか／判断の件の id はその結びつけに送った件か。違えば 404。plugin の口は plugin の鍵。
16. 利用者の名前の comment は、plugin が結びつけの持ち主（`userId`）として書く。Paperclip が会社の有効な利用者かを確かめる（SDK の決まり）。他人の名前では書けない。
17. 記録・ログに、発言の全文と token を出さない。push の本文（返事の先頭 120 字）は Apple の APNs を通り、端末の設定によってはロック画面に出る（ADR-0008 Amendment 1 と同じ扱い）。

## 口の形（契約・3 か所で同じものを使う）
通知 API（開発元）。保存は今の table に足す（PK は今と同じ project）。

アプリの口（アプリの token・`/api/v1/app`）:
- `GET /bindings/:b/agents` → `{ departments: [{ key, name, agents: [{ id, name, role, blurb }] }], secretaryId }`
- `GET /bindings/:b/threads?agentId=` → `{ threads: [{ id, agentId, title, status: 'waiting'|'done'|'failed', handedTo?: string, lastMessageAt }] }`（新しい順・最大 50）
- `POST /bindings/:b/threads` `{ agentId, text, cardId? }` → `201 { thread }`（cardId は「決められない — 担当と話す」の時。その結びつけに送った件だけ）
- `GET /bindings/:b/threads/:t/messages?after=<ISO>` → `{ messages: [{ id, role: 'me'|'agent'|'system', text, at }], status }`
- `POST /bindings/:b/threads/:t/messages` `{ text }` → `201 { message }`
- `GET /bindings/:b/overview` → `{ departments: [{ key, name, summary, caution?, working: [name] }], whole: { summary }, dailyTimes: { edition, url, today: [..], news: [..], events: [..] } | null, at }`

plugin の口（plugin の鍵・`/api/v1/plugin`）:
- `PUT /bindings/:b/agents` `{ departments, secretaryId, companyId }`（中身が変わった時だけ送る。`companyId` はその結びつけの Paperclip の会社の id。`GET /bindings/:b/overview` はこの会社の `PUT /companies/:companyId/overview` を返す）
- `GET /chat/pending` → `{ messages: [{ id, bindingId, threadId, agentId, text, cardId?, threadIssueId? }] }`
- `POST /chat/messages/:id/sent` `{ issueId, commentId? }`
- `PUT /bindings/:b/threads/:t/status` `{ status, handedTo? }`
- `POST /bindings/:b/threads/:t/replies` `{ commentId, text, role: 'agent'|'system' }`（commentId で 1 回だけ保存・保存した時だけ push）
- `PUT /companies/:companyId/overview` `{ departments, whole, dailyTimes }`（開発元の cron。その会社の active な結びつけ全部に出す）

## 保証しないこと
- 返事の速さ（担当は起こされてから動くので 30 秒〜数分）。返事の文字単位の流し込み（v1 は comment 単位）。
- 秘書が担当に回した先の課題の進み具合の画面（Paperclip で見る）。
- 開発元以外の会社の秘書・部署の設定（plugin の設定で後から足せる）。
- 会社のサマリーと Daily Times を 開発元以外の会社に出すこと（開発元の cron だけが作る）。

## 前提
- plugin の SDK（2026.1001.0）が次の権限と口を持つ（README・types.d.ts で確認）: `issues.read`・`issues.create`・`issues.update`・`issues.wakeup`（`requestWakeup`）・`issue.comments.read`（`listComments`・書き手の `authorType`/`authorAgentId`）・`issue.comments.create`・`issue.comments.create_human_attributed`・`issue.subtree.read`・`issues.orchestration.read`（実行の結果 `ctx.issues.summaries.getOrchestration` の `runs`・保証 2 と 7 で使う）・`agents.read`・`events.subscribe`（`issue.comment.created`）。権限が増えるので plugin は upgrade_pending を経て入れ替える（id と記録は保たれる）。
- 人の名前の comment が担当を起こすのは、課題が閉じていない時だけ（SDK の README・types.d.ts）。だから 2 で開き直しと `requestWakeup` をする。
- 出来事の handler は会社の付いた呼び出しとして動く（2026-11-13 の実機の学び: setInterval は断られ、出来事・API の口は通る）。
- 通知 API は tag `notify-admin-v0.5.1` 以降（鍵の期限切れの直しが入っている。版は tag で判定する。package.json の version は使わない）。
- 担当は開発元のサーバーの codex CLI（adapter `codex_local`・開発元の契約の定額）で動く。Paperclip の開発元の会社の費用の記録は 0 セント（2026-11-14 実測 `GET /api/companies/<開発元の会社>/costs/summary`）。

## 費用（DynamoDB・通知 API の table・on-demand・東京）
- 式: 月額 ≒ 読み（RRU）× 0.1425 USD / 100 万 ＋ 書き（WRU）× 0.7125 USD / 100 万（単価は東京の on-demand の公開価格の私の記憶・未検証。10 倍違っても 1 USD/月 未満）。
- 読み: plugin の未送の発言の取りに行き 15 秒おき = 5,760 回/日 → 約 17.3 万回/月。話を開いている間の 5 秒おきの読み直し（返事待ちの間だけ・最長 3 分）= 1 回の話で最大 36 回、1 日 30 回の発言で約 1,080 回/日 → 約 3.2 万回/月。sync の読み直し 最大 20 話 × 毎分 は Paperclip 側の読みで table は読まない。合計 約 21 万 RRU/月 → 約 0.03 USD/月。
- 書き: 発言 30 回/日 ＋ 返事 30 回/日 ＋ 送った印 30 回/日 ＋ 会社と Daily Times 144 回/日（10 分おき）＋ 担当の一覧 1,440 回/日（毎分の sync・変わった時だけ書く形にすれば大きく減る）≒ 1,674 回/日 → 約 5 万 WRU/月 → 約 0.04 USD/月。
- 保存: 発言 1 件 1KB 以下 × 90 日で消える → 数 MB → 0.01 USD/月 未満。
- 合計 約 0.08 USD/月（1 USD/月 を大きく下回る）。話が増えても、15 秒おきの取りに行きは会社ごとに 1 回で全部を取るので増えない（会社の数に比例する）。
- 担当の実行: 発言 1 回ごとに担当が 1 回動く。担当は開発元の契約の定額の codex CLI で動き、従量の USD は 0（上の実測）。契約の使用枠を使う。配備の後 7 日、開発元の会社の費用の記録と codex の使用量を測って報告する。
- 費用ゼロの案: 5 秒おきの読み直しをやめ、push と引いて読み直しだけにする（読みが約 3.2 万回/月 減る）。差は 0.005 USD/月 なので、返事の出方を良くする方を採る。

## 受け入れる限界
- 発言 1 回ごとに担当が 1 回動く（担当の実行の費用がかかる）。上の『user の裁定』の 2 つ目のとおり、開発元はこの前提を読んで「この形で作る」を選んだ。
- 出来事を取りこぼした時は、5 の読み直しで最大 1 分遅れて届く。直近 24 時間に発言が無い話の取りこぼしは届かない（話を開いた時に Paperclip から読み直す口は v2）。
- 会社のサマリーと Daily Times を送る 開発元の cron は、plugin と同じ鍵（開発元の秘密の置き場の NOTIFY_PLUGIN_KEY）を使う。鍵を入れ替える時は、通知 API で新しい鍵を作り、plugin の秘密と 開発元の秘密の置き場 の両方を替えてから古い鍵を消す。

## user の裁定
- 2026-11-14（開発元）: 担当を選んでチャットできる・履歴をたどれる・担当の決まりとスキルに従って答える・Paperclip を挟む・秘書がメインで秘書が担当に回せる・判断の件から担当と話せる。下のタブは毎日使う「受信箱・秘書・Daily Times・会社」、会社は部署ごとのサマリー、担当は会社の部署・判断の件・秘書から。mock を「この形で作る」で承認。
- 2026-11-14（開発元・選択肢）: 前提「発言ごとに担当が 1 回動くので、担当の実行の費用が発言の数だけかかります」を書いた問いに「この形で作る (推奨)」を選んだ。
