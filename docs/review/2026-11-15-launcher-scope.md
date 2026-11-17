# 範囲: 起動係・日英の wizard・Docker の image（PR #17）

仕様は `docs/design/2026-11-15-public-package.md`。この範囲はその段 2（起動係と image）。

## 保証すること
- container の外に出るのは起動係（3100）だけ。本体（Paperclip・local_trusted）は中の loopback の 3101。起動係を通らずに本体へは届かない。
- 起動係は Host の許可の一覧（localhost・127.0.0.1・[::1]）・状態を変える要求と WebSocket の Origin の完全一致・持ち主の cookie（HMAC・世代・30 日・HttpOnly・SameSite=Strict）の 3 つを通った要求だけを本体へ中継する。wizard が済む前は本体へ通さない。
- 持ち主の登録は 1 回だけ。合言葉は scrypt で持ち、失敗は 10 分で 10 回まで。`aioffice-reset-owner` で登録を消すと前の cookie は全部通らなくなる。
- Codex の device login は 1 本だけの状態機械。出力から URL と code だけを取り、ほかは捨てる。
- どんな要求でも起動係の process を落とさない。ブラウザが切った中継は本体側も切る。
- 本体と Codex の版は lock で固定。docker stop で組み込みの PostgreSQL を正しく止める。

## 保証しないこと
- Cursor・Claude の担当（独自の許諾の部品は image に入れず stub に替える。呼ばれたら「入っていない」と止まる）。
- 同じ docker の network の別の container・手元の別の利用者の process からの接続（手元の 1 台の利用者を信じる）。
- 外への公開・TLS・複数の利用者。
- plugin（office・design）の焼き込み、CI（次の PR）。
- Paperclip 本体の中の守り（本体は local_trusted のまま）。

## 前提
- 起動は `RUN.txt` の行（`-p 127.0.0.1:3100:3100`・`-v aioffice:/data`・`--stop-timeout 60`）。
- ブラウザは別の場所からの POST・WebSocket に Origin を付ける。
- 本体 2026.1001.0 の実測（`docs/review/2026-11-15-fresh-install/README.md`）。

## 受け入れる限界
- Origin の無い要求（ブラウザでない手元の道具）は通す。cookie は要る。
- 合言葉の試行の制限は process の中の記憶で、起動し直すと数え直す。
- 本体から何も流れない中継は 15 分で切る。

## user の裁定
- 2026-11-15 /goal: 公開の package を wizard だけで使い始められる形にする。英語と日本語の両方。
- 仕様（PR #14）の「守りは 3 つ。開始用の token のような wizard 以外の操作を要る仕組みは入れない」。
- 2026-11-15 開発元（AskUserQuestion「担当の決まり」→「このまま既定にする」）: wizard が入れる 3 人の指示書の雛形に、次の決まりを既定で入れる。秘書 — オフィスの外へは何も送らない（メール・投稿・支払い）、必要な時は全文を書いて先に持ち主の承認を取る、持ち主が終わりと言った時だけ done。デザイン課 — Codex に入っている画像の生成だけを使い有料の画像の API は呼ばない、持ち主が「決定」と言った時だけ done、画像を課題の外へ出さない。調べもの係 — 申し込み・購入・オフィスの外への送信をしない。使う人は後から指示書を直して外せる。
- 2026-11-15 開発元（「部品の許諾」への返答）: 独自の許諾の部品（@cursor/sdk・@anthropic-ai/claude-agent-sdk）は package に入れて配るのは避け、使う人が wizard・install の段で自分で取ってくる形なら検討の余地がある、という理解。v1 は入れずに stub に替え、担当は Codex だけにする（規約の本文の確認と、取ってくる形は後の段）。
