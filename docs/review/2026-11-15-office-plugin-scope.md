# 範囲: office の plugin（設計書の段 3・台帳 aioffice-public-v1 の B1 の office と design・B3 の office の画面）

設計書: `docs/design/2026-11-15-public-package.md`（「構成」の `plugins/office`・`plugins/design`、「AI の契約のつなぎ」の 66 行、「言語の持ち場」、「段階」の 3）。
移す元: 開発元の `ops/news/office/`（画面）と `ops/news/serve.mjs`（画面の API）・`ops/news/office-design-lib.mjs`。
レビュー: r1（reject・Blocking 2・P2 8・P3 6）を受けて書き直した（r2）。r2 は approve（条件 N-1・N-2 と P3 7 件をこの版に入れた）。

## 実測（2026-11-15・container aioffice-t1・本体 2026.1001.0）
試しの plugin（この branch の `plugins/office` の最初の形）を入れ、起動係ごしに確かめた。測った script は依頼文に添える。
- install: `paperclipai plugin install --local <置き場> -d /data/paperclip --api-base http://127.0.0.1:3101` が container の中で通り、plugin の一覧で `ready`。install は本体に 1 回で、page は会社の prefix の下（`/SAM/office`）に出る。
- 読み: 画面から同じ origin の `/api/companies/:id/activity`・`/decisions` が 200。worker の `ctx.agents.list` で担当 2 人。canvas は 1280×800 の窓で 977×680・JS のエラー 0。
- 承認（起動係ごし・持ち主の cookie・同じ Origin）: 作る 201・承認する 200（`decidedByUserId=local-board`）・二度目の承認 200（同じ物が返る）・断る 200（note あり・なしの両方）。
- 判断: 決める 200（`status=decided`・`local-board`）・二度目 409 `decision_already_resolved`・cookie なし 401・別の Origin 403。判断を作れるのは「課題に結び付いた担当の実行」だけ（board は 403 `Agent run context required`・課題の無い実行は 422）。CI では「担当に課題を割り当てる → 実行の記録ができる（Codex が無いので失敗で残る）→ 担当の鍵とその実行の id で作る」で用意できることを確かめた。
- CORS: 別の port の Origin からの GET に `access-control-*` の header は返らない（本体は CORS を許していない）。
- 入れ直し: `--local` は写しを作らず置き場を指す（plugin の一覧の `packagePath` が置き場）。入れ済みの所へ同じ key を `install` すると 400 `Plugin already installed`。manifest の版を変えて `plugin upgrade <key>` を流すと 200 で版が上がり `ready` のまま。

## 保証すること
1. **plugin を入れる手順**
   - image の build で `plugins/office` と `plugins/design` を build し、`/opt/aioffice/plugins/<name>` に置く。各 plugin の中身の hash（`dist` と `package.json`）を build の時に `BUILD_ID` に書く。
   - 起動の手順は、本体の health が通ってから plugin の一覧を読む。入っていなければ `plugin install --local`、`BUILD_ID` が記録と違う・状態が `ready` でなければ `plugin upgrade`、置き場（`packagePath`）が違えば uninstall（`--force` は付けない）してから install。そのあと `ready` を確かめて `<data>/aioffice/plugins.json` に `BUILD_ID` と状態を記録する。本体が起こし直された時も同じ照合をする。網には取りに行かない（`--network none` の CI で plugin が `ready` になることを確かめる）。
   - 失敗した時は起動を止めず、wizard の完了の画面と起動係の state に「オフィスの画面を入れられませんでした」を出し、「Open the office」は本体の Dashboard へ向ける。
   - 入れている途中は、完了の画面が「オフィスの画面を用意しています…」を出し、ボタンを押せない。`ready` か失敗になったら押せる。
2. **wizard の完了**: 起動係が会社を作った時の prefix を state に記録し、「Open the office」で `/<prefix>/office` を開く。
3. **office の画面**
   - 部屋（1 つのオフィスの配置図・コードで描く絵）: 社長室（持ち主）・執務室（秘書と担当の机）・デザイン部・休憩室。各部屋を押すと「ここでできること」（英日）。
   - 担当: 会社の担当がそれぞれの机に座り、状態（作業中・待ち・止まっている・失敗）が絵の上の印と、画面の端の担当の一覧（DOM・読み上げ可）に出る。試験は一覧で確かめる。
   - 受信箱: 承認と判断の一覧と、承認する・断る（note は任意）・決める（選択肢から 1 つ）。入力欄のある判断（`inputs` がある物）は office では決めず、本体の判断の画面への link を出す。操作は画面から本体の `/api` へ本体の session（持ち主・`local-board`）で送る。二重の押下は本体が同じ物か 409 を返すので、画面は返事の状態を出し直す。承認の一覧には承認の中身（題と要約・`payload` の文）を出す。
   - 仕事の掲示（作業中・未着手の課題）、課題の中身（本文と最近の comment 3 件）、出来事のログ（activity）。
   - 「AI の契約をつなぐ」入口: 見出しのボタンから起動係の `/setup/api/codex/*` を呼び、wizard と同じ code の画面を出す（wizard で飛ばした人・切れた人がつなぎ直せる）。
   - 更新: 画面が開いている間は 15 秒ごとに読み直す（手元の本体だけを読むので費用は無い）。
4. **AI の書いた文の出し方**: 課題の本文・comment・出来事・承認の中身は AI が書いた物として、text としてだけ出す（`innerHTML`・`dangerouslySetInnerHTML` を使わない）。link は `http:`・`https:` だけを link にする。試験（lint）で `innerHTML`・`dangerouslySetInnerHTML` を検出したら落とす。link の scheme の判定は関数に分け、単体試験で `javascript:`・`data:`・大文字・空白を混ぜた形を断ることを確かめる。
5. **デザイン部**
   - 部屋の依頼の欄（ロゴ・チラシ・名前・希望）から、デザインの担当に課題を作る。口は `plugins/design` の API の口（`api.routes.register`・`POST /request`）。
   - デザインの担当は、起動係の state にある「雛形 design で作った担当の id」で見分ける（名前では探さない）。画面が state から id を読んで依頼に添え、design の口は本体でその担当が同じ会社にいることを確かめる。
   - 二重に作らない: 課題の `originKind=plugin:aioffice.design:request`（本体の型は `plugin:${string}`・mobile の plugin と同じ形）・`originId=<種類と名前と希望の hash>` で、未完了の同じ依頼があればそれを返す。同時の 2 回でも 1 件（design の口の中で会社ごとに直列にする）。
   - デザインの担当が居ない時は「デザインの担当を足す」ボタン（起動係の `POST /setup/api/agents` で雛形 design を足す）。
   - 起動係の無い所（state が読めない）では、依頼の欄の代わりに「この画面の依頼の欄は AI オフィスの package の中でだけ使えます」を出す。
   - 担当の指示書の雛形は今の `packages/aioffice/templates/design.{en,ja}.md`。
6. **言語**
   - 画面の文言は辞書（key → en・ja）に集める。既定は英語。
   - 画面は起動係の `GET /setup/api/state` の `lang` を読む。読めない時（起動係の無い所）は英語。見出しの切り替えは `POST /setup/api/lang` で保存し、画面を描き直す。
   - worker・design の口が言語を要る時（課題の題・本文）は、画面が依頼に `lang` を添える。
   - 試験: 英日の key の一致。辞書の外で画面に出る文字列の検出（`createElement` の子の文字列・`title`・`placeholder`・`aria-label`・canvas の `fillText`・`textContent`・配置図と theme の json の `label`）。対象は `plugins/office/src`・`plugins/design/src`・`packages/aioffice/launcher/public`。
7. **会社の語を含まない**: `test/no-company-words.test.mjs` に、自社の URL・課題の置き場・開発元のサーバー・自社の製品名（一覧は `test/company-words.mjs`）を足し、`plugins/*/dist` も調べる。
8. **起動係の中継**: 本体の応答の `access-control-*` の header を落とす（今の版は返さないが、本体の版上げで返り始めても別の port のページから読ませない）。否定の試験に足す。
9. **CI（英語と日本語）**: wizard の後に次を確かめて撮る。
   - office の画面が開き、担当の一覧に 2 人・各部屋の「ここでできること」が出る・JS のエラー 0。
   - 受信箱: 試験の準備で承認 2 件と判断 1 件を作り（判断は上の実測の手順）、画面から承認する・断る・決めるを押して本体の状態が `approved`・`rejected`・`decided` になる。判断の準備で担当の実行が「失敗」になるので、オフィスの画面を撮るのは準備の前にする。
   - 「AI の契約をつなぐ」入口で code の画面が出る（`AIO_CODEX=1` の時）。
   - デザインの依頼の欄から課題が 1 件でき、同時の 2 回でも 1 件。
   - 網を切った container でも plugin が `ready`。
   - 入れ直し: plugin の中身を変えた image（`BUILD_ID` が違う）を同じ volume で起動し直すと、plugin が新しい `BUILD_ID` で `ready` になり、会社と担当が残る。
   - 別の port の Origin からの GET に `access-control-*` が無い。

## 保証しないこと
- 自社だけの面: 製品の状況・セキュリティ・品質の見張り・課題の置き場の掲示・作業の列・新聞・Codex の利用上限の帯・人事の名簿・問い合わせ窓口・課題の受け渡しの線・監視室。
- 図書室と知らせはこの PR に入れない（下の「順番」）。台帳 B1 は [ ] のまま。
- 柴犬の絵（画像の sprite。出どころが記録に無い）。絵はコードで描く 7 つの pack（fine-human・fine-cat・fine-bear・fine-penguin・fine-rabbit・cat・robot）だけ。
- 部屋を足す機能・3 つのオフィスの配置図。
- 2 社目以降の会社での画面の試験（本体の会社の切り替えに従う。CI は 1 社）。
- mobile の plugin を image に入れること（設計書の「保証しないこと」）。

## 順番（台帳 B1・B3 と公開 0.1.0）
1. この PR: office と design の plugin・言語・CI（B1 の office・design、B3 の office の画面）。
2. 次の範囲の文書: 図書室（会社の文書と課題を担当の仕事に添える）と知らせ（担当の結果・承認待ちを持ち主に届ける。どこへ届けるかの定義もそこで決める）。設計書は Slack などとのつなぎ込みを v1 の外にしているので、知らせの届け先は設計書と台帳を見比べて決め、狭める時は開発元に確かめる。
3. 1 と 2 が入ってから、開発元の裁定どおり版 0.1.0 として repo と image を公開する。

## 前提
- 本体 2026.1001.0 の plugin の SDK と page slot。判断と出来事は SDK に口が無いので、画面から同じ origin の `/api` を読む・書く（実測で 200）。承認も同じ道に揃える（SDK の `approvals.decide` は人の id が要り、`local-board` で通るかは未実測のため使わない）。担当と課題の読みは worker の SDK。
- 画面の fetch には起動係の持ち主の cookie が付く（同じ origin）。起動係は Origin を確かめる（別の Origin の POST は 403・実測）。
- 本体はログイン無しのモード。押した人は持ち主 1 人（`local-board`）として扱う。

## 受け入れる限界
- 画面は本体の枠（左の並び・見出し）の中に出る。全画面ではない。
- 本体の `/api` の形が版で変わると画面が壊れうる。本体の版は lock で固定し、版上げは CI を通してから。
- manifest の capabilities は、画面が `/api` で書く操作（承認・判断）を表さない（本体の session で書くため）。本体の plugin の一覧に出る権限の表示より、画面ができることが広い。
- 15 秒ごとの読み直しなので、変化が画面に出るまで最大 15 秒かかる。

## user の裁定
- 2026-11-15 開発元: 公開の package は wizard 以外の操作なしで使い始められること。英語が主、日本語も必ず。
- 2026-11-15 開発元: repo と ghcr の image の公開は、office の plugin（B1〜B3）の後に版 0.1.0 で一度に行う。
