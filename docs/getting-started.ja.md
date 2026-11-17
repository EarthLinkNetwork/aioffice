# AI オフィスの始め方

AI オフィスは、自分の PC で動く AI 社員の小さな事務所です。準備はブラウザの wizard だけで済みます。ファイルを書き換える作業はなく、Docker のほかに開発の道具は要りません。

## 用意するもの

- Docker Desktop（Mac・Windows）か Docker Engine（Linux）が入った PC（amd64 か arm64）。
- image（約 3.7 GB）のための 4 GB ほどの空きのディスクと、手元の文書の分の空き。
- ChatGPT の契約。AI 社員は、あなたの契約の Codex で動きます。仕事のたびに、契約の枠を使います。

## 1. オフィスを起こす

terminal を開いて、次の 1 行を打ちます。`VERSION` は、[package のページ](https://github.com/orgs/EarthLinkNetwork/packages/container/package/aioffice)にある一番新しい版（例 `0.1.0`）に置き換えます。最初の起動には 1〜2 分かかります。wizard の段で「オフィスはまだ起動中です。少し待ってから読み込み直してください。」と出たら、そのとおりにします。

```sh
docker run -d --name aioffice --stop-timeout 60 -p 127.0.0.1:3100:3100 -v aioffice:/data ghcr.io/earthlinknetwork/aioffice:VERSION
```

オフィスのデータは、すべて `aioffice` の volume に入ります。container を消しても、データは消えません。

## 2. wizard を開く

ブラウザで次の場所を開きます。

```text
http://localhost:3100/
```

wizard は短い 8 つの段です。

1. **言語** — 英語か日本語。あとで変えられます。
2. **持ち主の合言葉** — このブラウザでこの合言葉を入れた人だけが、オフィスを開けます。
3. **会社の名前** — オフィスの名前です。
4. **使う AI を選ぶ** — AI 社員が使う AI（たとえば ChatGPT や Claude）を選び、それぞれ自分の契約でつなぎます。ダウンロードし、サインインのリンクを開いて、code を入れるか貼ります。2 つ以上使い、社員ごとに選ぶこともできます。あとでオフィスの **AI の契約** からつなぐこともできますが、つなぐまで AI 社員は動きません。
5. **秘書** — 最初の AI 社員です。秘書に話しかけると、ほかの担当へ仕事を回します。
6. **ほかの AI 社員** — 今入れたい担当を選びます。あとで足せます。
7. **手元の文書** — フォルダを選ぶと、中の `.md` と `.txt` を図書室に入れ、AI 社員が検索できるようにします。飛ばしてもかまいません。
8. **完了** — オフィスを開きます。この先の画面（オフィスが動く土台の Paperclip）は英語です。

## 3. オフィスを使う

部屋を押すと、その部屋でできることが出ます。たとえば図書室では手元の文書を検索でき、デザイン部ではロゴやチラシを作れます。段 6 でデザインの担当を入れなかった時は、デザイン部の部屋に担当を足すボタンが出ます。

## 新しい版に上げる

新しい版で、次の 1 行を打ちます。データは残り、wizard はもう出ません（別のブラウザでは持ち主の合言葉を聞かれます）。`&&` を受け付けない Windows PowerShell 5.1 では、4 つのコマンドを 1 つずつ打ちます。

```sh
docker stop aioffice && docker rm aioffice && docker pull ghcr.io/earthlinknetwork/aioffice:VERSION && docker run -d --name aioffice --stop-timeout 60 -p 127.0.0.1:3100:3100 -v aioffice:/data ghcr.io/earthlinknetwork/aioffice:VERSION
```

## 持ち主の合言葉を忘れた時

```sh
docker exec aioffice aioffice-reset-owner
```

そのあと http://localhost:3100/ を開き直し、新しい合言葉を決めます。
