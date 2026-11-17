# plugin「mobile」v0.2.0 — notify へ送る・押された操作を反映する（段 1）の範囲

対象: plugins/mobile（src/notify-client.mjs・src/relay.mjs・src/decisions-client.mjs・src/cards.mjs・worker.mjs・manifest.mjs）と test/mobile-relay.test.mjs・test/mobile-worker.test.mjs。設計は 開発元の docs/design/2026-11-10-mobile-app.md の節「2026-11-10 改」と「会社ごとの判断の扱い方」（承認済み）。

## 保証すること
- 他人の名義で決められない: 反映するのは許可の一覧 1〜6（plugin 自身が送った card・押した人が宛先の本人で結びつけが有効・中身の hash が今と一致・actions[] にある・押してから 24 時間以内で未使用・本体が確かめ直す）を全部満たす操作だけ。会社ごとの判断は押した人の key だけで決める。
- 二重に反映しない（操作の id を反映の前に記録する）。
- 初めて入れる回・後から結びついた人への既存の件・中身が変わった件・key を承認した時点で open の判断は push しない。
- 取りに行くのは片付いていない card がある間と、最後の card が片付いた後の 1 回だけ 15 秒ごと。片付いた件の操作には「もう決まっている」を返す。課題ごとの判断カードは 30 秒ごとに探す。
- 片付いたとみなすのは 2 回続けて見えなかった件だけ（1 回取りこぼしても card を消さず、次の回に新しい件として push しない）。
- 中身が変わった card の送り直しは送り先ごとの版で記録し、失敗した送り先には次の回に送り直す。
- card の id は `<種類>:<会社の id>:<件の id>`。同じ通知 API のキーを複数の会社が使っても、自分の会社の分でない操作には結果を返さない。
- project のキーと判断の key をログ・例外・戻り値に出さない。メンバーから外れた人の結びつけは失効させ、card を消し、判断の key を消す。

## 保証しないこと
- notify の口の形（開発元が作業中・plugin 側の仮の形）。実物の notify との E2E。
- 結びつけの画面・判断の key を出す／入れ替える／失効させる仕組み・key の無い人への「承認してください」の 1 件。これらは最初の版（段 1）の中の次の PR で入れる（段 2 に送るのではない。開発元 2026-11-11「判断は最初から入れるで」のとおり、判断は最初の版に入る。この PR は key を置く・外す部品と、key がある人の分だけ読む・押した人の key で決める所まで）。
- 課題ごとの判断カードのうち「確認」以外の種類（SDK の respondInteraction が accept / reject しか受けないため web で答える）。

## 前提
- Paperclip 本体 2026.1001.0 の plugin SDK（approvals.decide・listInteractions・respondInteraction は actorUserId を本体が確かめ直す）。会社ごとの判断の口は board の名義（key）だけを受ける。
- notify は project のキーで認証し、結びつけが無効な宛先には 404/410 を返す。
- `hostUrl` は `https://` だけを受ける（http は設定の時点で断る）。本体の `ctx.http.fetch` は loopback・private の IP への呼び出しを拒むので、plugin から本体を呼ぶには公開の URL が要る（`http://127.0.0.1` などは使えない）。
- 本体が Cloudflare Access の後ろにある時は、board の key（Bearer）だけでは Access を通れないかもしれない。その時は Access の service token か、plugin からの経路を Access の対象から外す設定が要る（実物で確かめるのは結びつけの PR の E2E）。

## 受け入れる限界
- plugin は notify から来た「押した」を許可の一覧の範囲で信じる。
- 結びついた人ごとの判断の key を plugin の状態に持つ（本体の DB と backup に入る）。

## user の裁定
- 開発元 2026-11-10: アプリは 配る側の共有アプリ 1 つ・各社の AI company から 配る側の API に送り API サーバーが push する・中身も 配る側の API を通す（A）。
- 開発元 2026-11-11:「判断は最初から入れるで」（問い: 1. 最初の版から外す／2. plugin に本体の API の鍵を持たせて最初の版から扱う → 2）。
- 管理者が会社の全員の結びつけを見られ、外せること（`link.list`・`link.remove`）: 開発元の docs/design/2026-11-10-mobile-app.md の節「2026-11-10 改」の「結びつけ」の項（「plugin の画面に、結びついている開発元の SSO のアカウントの一覧を出し、本人と会社の管理者が外せる」・開発元の裁定 2026-11-10 で確定した設計）による。
