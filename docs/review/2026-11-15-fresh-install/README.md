# まっさらな container で Paperclip を起動した記録（2026-11-15・段 1）

公開の package（`docs/design/2026-11-15-public-package.md`）の段 1。手元の Docker（OrbStack 29.8.2）で `node:24-bookworm` を起こし、Paperclip 2026.1001.0 を npm から取ってきて起動した。

## 手順と結果
| # | したこと | 結果 |
|---|---|---|
| 1 | `npx paperclipai@2026.1001.0 --help` | 約 2 分で取れる |
| 2 | root のまま `onboard --yes -d /data` | **起動しない**。組み込みの PostgreSQL が「root では動かない」で止まる |
| 3 | 利用者 `node` で `onboard --yes -d /data --no-install-service` | 起動する。`deploymentMode: local_trusted`・`127.0.0.1:3100` だけで待ち受け |
| 4 | `docker exec` を抜けると server も止まる | 常駐は `run -d /data` を container の主の process にする |
| 5 | container の中で `socat TCP-LISTEN:3190 → 127.0.0.1:3100`、手元から `127.0.0.1:3190` を開く | 画面・API とも 200。本体は loopback からの接続とみなし、ログインなしのまま使える |
| 6 | 初めて開く | `/onboarding` の案内。Step 1: 会社の名前（`en_01-org-name.png`） |
| 7 | 会社の名前を入れる | Step 1 of 3: 最初の担当の名前（`en_02-first-agent.png`） |
| 8 | 担当の名前を入れる | Step 2 of 3: Connect a model（Claude の契約・OpenAI の契約・API key）（`en_03-connect-model.png`） |
| 9 | OpenAI の契約を選ぶ | **「Paperclip が動いている機械の terminal で次を打つ」**: `CODEX_HOME=<データの下の場所> codex … login --device-auth`（`en_04-codex-terminal-command.png`）。container には `codex` も入っていない |

## 公開の package で埋める穴
1. 利用者 `node` で動かす（image の `USER`）。
2. `run` を主の process にし、外への受け渡しは loopback への中継で行う（ログインなしの mode を保つ。外へは手元の 127.0.0.1 にだけ出す）。
3. image に Codex CLI（と Claude Code）を入れる。
4. **契約のつなぎを terminal なしにする**: wizard の画面から、裏で本体が示したコマンド（`login --device-auth`）を動かし、出てきた URL と code を画面に出す。使う人はブラウザで code を入れるだけ。本体の「Connect」は自動で確かめる。
5. 本体の案内は英語だけ。日本語は、こちらの wizard（本体の案内の前に出す言語の選択と、各段の説明）で受け持つ。

## 段 2 の最初の実測（2026-11-15・同じ container・Paperclip 2026.1001.0）
| # | 確かめたこと | 結果 | 仕様への効き目 |
|---|---|---|---|
| 1 | 本体の画面が初回の案内（`/onboarding`）へ送る条件 | 画面の source では「会社が 0 件」の時だけ `/onboarding` へ送る。ただし会社があっても担当が 0 人なら、会社の画面の上に案内（Create your first agent）が出る（`en_05-company-without-agent.png`） | wizard は会社と担当（秘書）を作り終える |
| 2 | API で担当を作った後（`POST /api/companies/:id/agents`・`adapterType: codex_local`） | localStorage の空のブラウザで `/` を開くと会社の dashboard へ行き、案内は出ない（`en_06-after-api-agent.png`） | 本体の案内を飛ばして起動係の wizard だけにできる |
| 3 | 本体の device login の口（`POST /api/companies/:id/adapters/:type/login-sessions`） | sandbox の環境（`environmentId` と疑似端末の能力）専用。手元で動かす担当（local の adapter）には使えない | 起動係が `codex login --device-auth` を裏で動かす設計のまま |
| 4 | adapter の確かめの口 | `POST /api/companies/:id/adapters/:type/test-environment` がある | つないだ後の確かめに使う（中身は次に実測） |
| 5 | 本体の画面の言語 | i18n の仕組みはあるが、資源は `lng:"en"`・`fallbackLng:"en"` だけ | 本体の画面は英語のまま（前の結論と同じ） |
| 6 | 許諾 | `paperclipai`・`@paperclipai/server`・`@paperclipai/adapter-codex-local`・`@paperclipai/db` は MIT | image に入れて配れる。LICENSE の表示を image に入れる |
| 7 | 担当を作った後の画面 | 「Introducing Connectors」（Gmail・GitHub・Notion・Slack を担当につなぐ）の知らせが出る | メール・Slack のつなぎ込みは本体の Connectors を先に調べる（連載のメールの回の前提） |
| 8 | `CODEX_HOME` の単位（`@paperclipai/adapter-codex-local` の `dist/server/codex-home.js`） | 本体が管理する codex-home は会社ごと（`<instance>/companies/<会社>/codex-home`）と担当ごと（`…/agents/<担当>/codex-home`）。`auth.json` はそこへ写さず、共有の場所（環境変数 `CODEX_HOME`、無ければ利用者の `~/.codex`）から **symlink** で配る。設定のファイル（config.toml など）は写す | ログインは共有の場所に 1 回だけ。起動係はその場所で `codex login --device-auth` を動かせば、全部の担当が同じログインを使う（仕様の「1 か所を共有・写しは作らない」と同じ作り）。token の更新の後も動くかは本物の契約で確かめる |

| 9 | 本体の Host の扱い（`curl -H "Host: …"` で GET） | `127.0.0.1:<port>` は 200、`evil.example`・`192.168.1.50:<port>` は **403** | 本体が Host を見て断る（DNS rebinding への守りが本体にある）。起動係は中継の時に Host を本体の待ち受けに合わせ、起動係の側でも許可の一覧で断る（二重） |
| 10 | 本体の Origin の扱い（別の Origin からの POST） | `Origin: http://evil.example`・`http://localhost:8080` で `content-type: application/json` の POST は **201（作られた）**。`text/plain` は 400。CORS の preflight（OPTIONS）は 200 だが `Access-Control-Allow-Origin` を返さない | ブラウザからの JSON の POST は preflight で止まるので今は CSRF になりにくいが、本体は Origin を確かめていない。起動係の Origin の確かめ（仕様の守り 3）は要る |
| 11 | package の Codex（0.169.0）の画像の機能 | `codex features list` で `image_generation` は stable・true（ログインなしで確かめた）。本物の生成は、本番の開発元のサーバーの Codex 0.163.0 でロゴ 3 案・チラシ 2 案を作れた（開発元の課題 2 件） | 画像の生成は package の Codex でも有効。package での本物の生成は、人の契約で 1 回流すリリース前の手順で確かめる |

まだの実測: token の更新の後も全部の担当が動くか（本物の契約）・偽の AI の向け先（段 4 で偽の server を作る時）・`test-environment` の中身。
