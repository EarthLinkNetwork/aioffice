# 公開の package — 一般の人が wizard だけで AI オフィスを使い始める

- 状態: 下書き（2026-11-15・独立レビュー 1 回目の指摘を反映）
- 依頼: 開発元 2026-11-15 の /goal。「公開用のpackageを拾ってきて、何もせずに…wizard以外は使わずに使い始められる」「次から変更updateがあったときもその形を崩さず」「英語と日本語、絶対に両方」
- 受け入れの台帳: 開発元の `docs/acceptance/open/aioffice-public-v1.md`（B・C の項目）

## 保証すること
1. 公開の package を 1 つ取ってきて、**コマンド 1 つ**で起動できる。正式の行は 1 つだけ:
   `docker run -d --name aioffice --stop-timeout 60 -p 127.0.0.1:3100:3100 -v aioffice:/data ghcr.io/earthlinknetwork/aioffice:<版>`
   - 外へ出すのは手元の 127.0.0.1 だけ。container の中で起動係（launcher）が 3100 で待ち、本体は container の中の loopback（別の port）で動く。
   - `--stop-timeout 60` は、`docker stop` で組み込みの PostgreSQL を強制終了させないため（既定の 10 秒では足りない恐れ・Dockerfile では決められない）。
   - 更新の行（`docker stop aioffice && docker rm aioffice && docker pull <新しい版> && ` + 上の起動の行）も同じ置き場に置く。
   - README・記事・CI はこれらの行を同じ 1 つの置き場（`packages/aioffice/RUN.txt`）から読む。手で写さない。
   - ほかに要るのは Docker だけ（下の「前提」）。書く設定ファイルは無い。
2. 起動したら、ブラウザで開いた最初の画面が **AI オフィスの wizard**。wizard は次だけを聞く:
   1. 言語（English / 日本語。既定は English。あとで切り替えられる）
   2. 持ち主の登録（合言葉を決める。登録は 1 回だけ。以後、cookie の無い接続には合言葉の入力画面を出し、本体へ通さない）
   3. 会社の名前
   4. 秘書を入れる（名前だけ。既定の指示書つき）
   5. 自分の AI の契約をつなぐ（ChatGPT の契約で動く Codex。画面に出る code をブラウザで入れる device login。鍵の手入力はしない）。担当を作った後に、その担当の場所でつなぐ
   6. ほかの担当を入れる（雛形から選ぶ: メール・デザイン・図書室 …。選ばなくてもよい）
   7. 完了 → AI オフィスの画面へ（「ここから先の Paperclip 本体の画面は英語です」と選んだ言語で知らせる）
3. wizard が済めば、秘書に話しかける・オフィスの画面を見る、までが Claude Code も手の設定も無しにできる。デザイン部にロゴを頼めるかは段 2 の実測で確かめ、確かめるまでは保証に入れない。
4. 画面（オフィス・wizard・plugin の画面）は英語と日本語の両方で出る。Paperclip 本体の画面は英語のまま（本体に日本語が無い・2026.1001.0 で確かめた）。
5. 変更のたびに CI が「まっさらな container で package を起動 → wizard を通す → オフィスの画面が出る」を英語と日本語で走らせ、落ちたら merge できない（中身は「CI」の節）。
6. 版を上げても、前の版で作った volume のまま起動すれば wizard は出ず、データが残る（CI の更新の試験で確かめる）。

## 保証しないこと
- Paperclip 本体の画面の日本語化。
- AI の契約そのもの（ChatGPT の契約は使う人が持つ）。契約が無い人は秘書が動かない（wizard は「つながっていない」と出し、オフィスの画面は見られる）。組織の契約で device login が止められている場合も同じ扱いで、wizard に案内を出す。
- Gmail・Slack などの外のサービスとのつなぎ込み（連載の回で 1 つずつ足す）。
- 複数台の構成・外への公開（手元の 1 台で使う形だけ）。スマホからの到達（mobile の plugin）は v1 に入れない。外へ出す認証つきの経路は別の設計にする。
- Claude Code を image に入れること（Claude の契約のつなぎは v1 に入れない）。
- 入れた後に言語を切り替えても、入れ済みの担当の指示書と返事の言語は変わらない（画面だけが変わる）。

## 前提
- Docker が入っていること（Docker Desktop・OrbStack・Linux の Docker Engine）。従業員の多い会社では Docker Desktop が有償の場合がある。
- Paperclip・Codex CLI・node の base image（digest）・plugin の版を lock で固定する。版上げは package の版上げとして CI を通してから。
- 公開の repo（aioffice）の plugin は特定の会社の運用の語を含まない（今ある test を全部の plugin に広げる）。
- 今の会社の運用（開発元のサーバーでの運用）は、この package の「設定済みの 1 社」として後から同じ plugin に寄せる。先に公開の形を作り、運用はそれを使う側に回る。
- Paperclip の利用許諾で、image に入れて再配布してよいことを段 4 の前に確かめ、image に license の表示を入れる。

## 段 1 の実測で決めたこと（2026-11-15・記録 `docs/review/2026-11-15-fresh-install/README.md`）
- 本体は利用者 `node` で動かす（root では組み込みの PostgreSQL が起動しない）。
- 本体は container の中の loopback（ログインなしの mode）で動かし、外とのやり取りは起動係が中継する。
- 本体の plugin の画面は会社ごとの住所にしか出せず、会社ができる前の最初の画面に置けない。そこで **wizard は起動係が出す**（日英）。済むまでは `/` を wizard に送り、済んだら本体へ中継する。
- 本体の初回の案内の「Connect a model」は terminal の操作（`codex login --device-auth`）を求める。起動係が同じコマンドを裏で動かし、出た URL と code を wizard に出す（実測で URL と 15 分の code が取り出せた）。image には Codex CLI を入れる。
- plugin は起動の手順の中で `paperclipai plugin install --local <置き場>` で入れる。

## 起動係の守り（接続元の IP には頼らない）
docker の port の受け渡しを通ると、container の中からは手元から来たか LAN から来たかが見分けられない。本体は loopback からの接続を全部ログインなしで通すので、起動係を通った接続は誰のものでも管理者になる。守りは起動係で次の 3 つを重ねる。
1. **持ち主の cookie**: wizard の最初で持ち主が合言葉を決め、HttpOnly・SameSite=Strict の cookie を出す。持ち主の登録は 1 回だけで、済んだ後に登録の段を開いても断る。cookie の無い要求は本体へ中継せず、登録の前は登録の段、登録の後は合言葉の入力画面と状態の画面だけを通す。
2. **Host の許可の一覧**: `localhost`・`127.0.0.1`・`[::1]`（と port）以外の Host は断る（DNS rebinding への守り）。
3. **Origin の確かめ**: 状態を変える method（POST・PUT・PATCH・DELETE）と WebSocket の upgrade は、Origin が起動係の住所と scheme・host・port まで完全に一致するものだけ通す（CSRF への守り。SameSite は port を見ないので、手元の別の port のページからの要求もここで断る）。
- 守りはこの 3 つ。開始用の token のような、wizard 以外の操作（`docker logs` を読む）を要る仕組みは入れない（裁定「wizard 以外の操作なし」）。
- 本体の `local_trusted` が Host・Origin をどう扱うかは段 2 の最初に実測し、記録に足す。
- 中継は WebSocket の upgrade・SSE・大きな upload・keep-alive を通す。本体の画面が使う通信の種類を段 2 で数え上げ、それぞれを e2e の試験に入れる。
- 本体が落ちたら起動係が状態の画面を出し、本体を起こし直す。PID 1 には tini を置き、`docker stop` の SIGTERM を本体に渡して待つ（組み込みの PostgreSQL を強制終了させない・`--stop-timeout` を長めにする）。
- `/data` に volume がつながっていなければ（`/proc/self/mountinfo` で調べる）、wizard に「container を消すとデータが消える」と警告を出す。

## AI の契約のつなぎ（Codex の device login）
- 起動係はログインを **1 本だけの状態機械**として持つ: 待機 → code 発行 → 承認待ち → 成功／期限切れ／失敗。二度押しには動いている process の code をそのまま返す。「やり直す」は前の process を止めてから新しく始める。画面を閉じても再読み込みで同じ状態に戻れる。
- `CODEX_HOME` の場所は本体から取る（固定の path を書かない）。本体の版で変わるかを CI の契約の試験で確かめる。
- `CODEX_HOME` が担当ごとか、会社または container で 1 つかを段 2 の最初に実測する。担当ごとだった時も、人が code を入れるのは 1 回にする。ログインの実体は 1 か所だけに置き、各担当の場所からはそこを指す（担当の `CODEX_HOME` を同じ 1 か所に向けるか、auth.json を symlink にする）。写しは作らない（token の更新で refresh token が回ると、写しの方が黙って切れるため）。段 2 の実測に「token の更新の後も全部の担当が動くか」を入れ、共有できない時はこの節と「受け入れる限界」を直してから進む。
- つないだ後の確かめは、本体の adapter の確かめの API（環境の試験に当たるもの）を起動係から呼ぶ。どの API かは段 2 の最初に本体の配布物から特定し、CI の契約の試験に入れる。
- 15 分の残り時間を画面に出し、切れたら取り直すボタンにする。wizard の後の「つなぎ直す」入口を office の plugin に置く。
- code の読み取りは Codex の版を固定し、版ごとの出力の見本で試験する。子 process の標準出力は URL と code 以外の行を捨て、`docker logs` に流さない。auth.json は持ち主 `node`・権限 600。

## 本体の初回の案内を出さない条件
「会社と担当があれば本体の案内は出ない」は未検証。段 2 の最初に、(a) 本体の配布物の中で案内を出す条件を読んで記録に写し、(b) API だけで会社と担当を作って、localStorage の空のブラウザで `/` と会社の画面を開き、`/onboarding` に飛ばないことを撮る。(c) 同じ確かめを CI の固定の項目にする。
- wizard が使う本体の操作は、本体の CLI（`paperclipai`）と文書に載っている API を優先する。使う API の一覧を契約の試験にする。
- wizard の状態は `/data` に残し、各段は「あれば使う・無ければ作る」にする（途中で落ちても会社が 2 つにならない）。`onboard --yes` は `/data` が空の時だけ流す。

## 言語の持ち場
- 選んだ言語は `/data` の設定 1 か所に置き、起動係・office の plugin・指示書の雛形はそこを読む。切り替えの入口は office の plugin の見出しに置く。
- plugin の画面と起動係（`packages/aioffice/launcher`）の文言は辞書の key に集める。CI で英日の key の一致と、辞書の外で画面に出る文字列（JSX の text・属性の文字列・HTML の文字列。英語も日本語も）の検出（lint）を行う。

## 構成
| 物 | 役目 |
|---|---|
| `packages/aioffice`（Docker image） | Paperclip の固定版・Codex CLI・plugin 一式・tini・起動の手順（初回の `onboard --yes`・`run`・plugin を入れる）。npx と plugin は image に焼き込み、起動の時に網へ取りに行かない |
| `packages/aioffice/RUN.txt` | 正式の起動の行（README・記事・CI が読む） |
| `packages/aioffice/launcher` | 起動係。日英の wizard・持ち主の cookie・Host と Origin の確かめ・契約のつなぎの状態機械・本体への中継。依存なしの node |
| `packages/aioffice/templates` | 担当の指示書の雛形（秘書・メール・デザイン・図書室 …・日英） |
| `plugins/office` | AI オフィスの画面（今の 開発元の `ops/news/office` を plugin に移す。データは worker が本体の API から作る）。言語の切り替えと「つなぎ直す」入口 |
| `plugins/design` | デザイン部の雛形（担当の指示書と、オフィスの部屋の依頼の欄） |
| `test/e2e/fresh-install` | まっさらな container で wizard を通す試験（Playwright・英語と日本語の画面を撮る） |

## CI
1. build: amd64 と arm64 の両方で image を作る（Codex の binary と組み込みの PostgreSQL は arch ごとに違う）。
2. 契約の試験（API）: まっさらな本体で、会社・担当の作成・`plugin install --local`・adapter の確かめ・`CODEX_HOME` の場所・案内が出ない条件。
3. e2e（英語・日本語）: `RUN.txt` と同じ行で起動し、wizard を通してオフィスの画面まで行き、キャプチャを撮る。あわせて否定の試験 — 許可の一覧に無い Host・cookie の無い接続・別の Origin（別の port を含む）からの POST と WebSocket・持ち主の登録が済んだ後の再登録が断られる・ログインの二度押しで process が 1 本のまま・`docker stop` → 起動でデータが壊れない。オフライン（網を切った container）でも起動する。
4. 偽の AI: Codex CLI の model の provider（base_url）を偽の Responses の server へ向け、本体の adapter から CLI までを本物で通す（設定ができるかは段 2 で実測。できなければ adapter の手前で代え、その範囲を記録に書く）。
5. 更新の試験: 1 つ前の公開版で作った volume を、`RUN.txt` の更新の行で新しい版に上げ、wizard が出ずデータが残ることを確かめる（最初の公開版には「1 つ前」が無いので、2 版目から有効）。
6. 公開の後の smoke: ghcr に出た digest を pull して e2e を流す。始め方の記事（docs/getting-started.md・.ja.md）の版の場所の link（組織の package のページ）を、ログインしない curl で開いて 200 で、その版が載っていることも確かめる。落ちたら `latest` の tag を動かさず、前の digest のままにする。
7. 夜間の canary: 本物の `codex login --device-auth` で URL と code が取れるかだけを確かめて止める。

## 段階
1. **試しの起動**（済）: 手元の Docker で Paperclip の固定版を起動し、本体の初回の流れを実測し、記録とキャプチャを残す。
2. **実測の残り → 起動係と wizard**（英語・日本語）: 最初に「本体の Host・Origin の扱い」「案内を出す条件」「adapter の確かめの API」「`CODEX_HOME` の場所」「偽の AI の向け先」「Codex でロゴが作れるか」を実測して記録する。そのあと起動係（守りの 3 つ・状態機械）と wizard。
3. **office の plugin**（今の画面を移す。部屋ごとの「ここでできること」を英語・日本語で）。
4. **package**（Docker image）と CI（上の 1〜7）。
5. **記事**: 使い始めるまでの記事（英語・日本語）を、段 4 の試験と同じ手順で書き、試験で撮ったキャプチャを使う。
6. **public にする**（2026-11-17 に足した）: 今の private の repo をそのまま public にしない（今の履歴・branch の名前・PR に、2026-11-17 に外す前の人の名前と社内の語が残る）。
   1. 先に写し方を作り直す（別の PR）: `git subtree split` をやめ、`public/` の木を、前回の公開の commit の上に 1 つの commit として載せる（split の出力は古い commit を祖先に持つので、公開の後に古い履歴が戻る）。写しの branch の名前も中立の名前（例 `sync/upstream`）にする。
   2. まとめる前に、木の全部の file（binary を除く）で `test/no-company-words.test.mjs` が通ることを確かめる。
   3. 公開する版の木を 1 つの commit にまとめた新しい履歴で、新しい repo として公開し、以後は 1 の写し方でその上に積む。

## 受け入れる限界
- 契約のつなぎ（device login）は人がブラウザで code を入れる 1 回が残る（AI の契約の持ち主の確認なので、なくせない）。
- 手元の PC の別の process（同じ PC の別の利用者・入っているソフト）が、持ち主より先に wizard を開けば持ち主として登録できる。手元の 1 台だけで使う前提で受け入れる。
- 合言葉を忘れた時の戻し方は wizard の外の操作になる（`docker exec aioffice aioffice-reset-owner` で持ち主の登録を消す）。README に書く。
- CI で確かめられないこと: 本物の ChatGPT の契約での承認・token の更新・利用の上限・実際の AI の出来（秘書の返事・ロゴ）・OpenAI 側の device login の画面の変化。リリースの前に人の契約で 1 回だけ流す手順で補う。

## user の裁定
- 2026-11-15 開発元: 公開の package は wizard 以外の操作なしで使い始められること。英語が主、日本語も必ず。
