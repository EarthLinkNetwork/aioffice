# AI オフィスの始め方

AI オフィスは、自分の PC で動く AI 社員の小さな事務所です。準備はブラウザの wizard だけで済みます。ファイルを書き換える作業はなく、Docker のほかに開発の道具は要りません。

使い方は 3 つを想定しています。この PC で自分だけで使う、社内のネットワークで自分と同僚が使う、Cloudflare Tunnel を通して外から自分だけで使う、の 3 つです。インターネットの誰にでも開く使い方は想定していません。

## 用意するもの

- Docker Desktop（Mac・Windows）か Docker Engine（Linux）が入った PC（amd64 か arm64）。
- image（約 3.7 GB）のための 4 GB ほどの空きのディスクと、手元の文書の分の空き。
- ChatGPT の契約。AI 社員は、あなたの契約の Codex で動きます。仕事のたびに、契約の枠を使います。

## 1. オフィスを起こす

terminal を開いて、次の 1 行を打ちます。`VERSION` は、[package のページ](https://github.com/orgs/EarthLinkNetwork/packages/container/package/aioffice)にある一番新しい版（例 `0.1.0`）に置き換えます。末尾に `-amd64`・`-arm64` の付いた物は選ばないでください（PC の種類は docker が自分で選びます）。最初の起動には 1〜2 分かかります。wizard の段で「オフィスはまだ起動中です。少し待ってから読み込み直してください。」と出たら、そのとおりにします。

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
2. **持ち主のアカウント** — 持ち主のアカウント（名前・メール・パスワード）を作ります。最初の 1 回だけ、container を起こした人にしか見えない code を聞かれます。`docker logs aioffice` を打ち、`first-owner code` の行の code を写します。
3. **会社の名前** — オフィスの名前です。
4. **使う AI を選ぶ** — AI 社員が使う AI（たとえば ChatGPT や Claude）を選び、それぞれ自分の契約でつなぎます。ダウンロードし、サインインのリンクを開いて、code を入れるか貼ります。2 つ以上使い、社員ごとに選ぶこともできます。あとでオフィスの **AI の契約** からつなぐこともできますが、つなぐまで AI 社員は動きません。
5. **秘書** — 最初の AI 社員です。秘書に話しかけると、ほかの担当へ仕事を回します。
6. **ほかの AI 社員** — 今入れたい担当を選びます。あとで足せます。
7. **手元の文書** — フォルダを選ぶと、中の `.md` と `.txt` を図書室に入れ、AI 社員が検索できるようにします。飛ばしてもかまいません。
8. **完了** — オフィスを開きます。この先の画面（オフィスが動く土台の Paperclip）は英語です。

## 3. オフィスを使う

部屋を押すと、その部屋でできることが出ます。たとえば図書室では手元の文書を検索でき、デザイン部ではロゴやチラシを作れます。段 6 でデザインの担当を入れなかった時は、デザイン部の部屋に担当を足すボタンが出ます。

## 新しい版に上げる

新しい版で、次の 1 行を打ちます。データは残り、wizard はもう出ません（別のブラウザではサインインを聞かれます）。持ち主の合言葉を使う版から上げた時は、オフィスがその合言葉を 1 回だけ聞き、backup を取ってから、持ち主のアカウントの形に移します。アカウントを作ると、前の持ち主に割り当てた課題があなたに移ります。この移し替えは、この PC で http://localhost:3100/ を開いて行います。済むまでは、ほかの PC と Cloudflare の住所からは断られます。`AIOFFICE_HOSTS` を付けて起こしていた時（ほかの PC や Cloudflare Tunnel）は、行の `-p` と `-e AIOFFICE_HOSTS=...` を同じにします。`&&` を受け付けない Windows PowerShell 5.1 では、4 つのコマンドを 1 つずつ打ちます。

```sh
docker stop aioffice && docker rm aioffice && docker pull ghcr.io/earthlinknetwork/aioffice:VERSION && docker run -d --name aioffice --stop-timeout 60 -p 127.0.0.1:3100:3100 -v aioffice:/data ghcr.io/earthlinknetwork/aioffice:VERSION
```

上げた後に前の形へ戻したい時は、次の 1 行で backup の一覧を出し、戻したい file を付けてもう一度打ちます（`docker exec aioffice aioffice-restore <file>`）。戻した後は `docker restart aioffice` で起こし直します。

```sh
docker exec aioffice aioffice-restore
```

## 人を招く

持ち主がオフィスの **人** を開き、**招く** を押して、出たリンクを相手に渡します。相手はそのリンクで自分のアカウントを作ります。持ち主は人ごとに肩書きと上の人を決めます。承認はこの順に上がり、戻ってきます。

持ち主がメールの知らせを ON にしていて、人の欄でその人のメールを確かめてあれば、その人に回覧が回ってきた時に、持ち主の Gmail から 1 通知らせが届きます。

招くのは社内の同僚です。AI 社員は持ち主の権限で動くので、招いた人は AI 社員を通して、持ち主と同じことができます（設定を変える・つないだアカウントを読むなど）。事務所の共有の AI スタッフを同僚に使ってもらうのと同じ形です。

## ほかの PC から使う

最初の起こし方では、オフィスはこの PC からしか開けません。社内のネットワークのほかの PC からも使う時は、container を消してから（データは volume に残ります）、次の行で起こし直します。`office-pc.local` は、この PC の名前か IP アドレスに替えます。ほかの PC からは `http://office-pc.local:3100/` を開きます。

```sh
docker run -d --name aioffice --stop-timeout 60 -p 3100:3100 -e AIOFFICE_HOSTS=office-pc.local:3100 -v aioffice:/data ghcr.io/earthlinknetwork/aioffice:VERSION
```

ほかの PC からは http のままなので、パスワードは暗号化されずに社内のネットワークを流れます。この形は社内のネットワークの中だけで使ってください。外から使う時は、port を開けずに、次の Cloudflare Tunnel を使います。

## 外から自分だけで使う（Cloudflare Tunnel）

Cloudflare Tunnel を使うと、ルーターの port を開けずに、オフィスに https の住所が付きます。Cloudflare のアカウントと、そこに載せたドメインが要ります。

1. Cloudflare Zero Trust で tunnel を作り、`office.example.com` のような public hostname を足して、service を type **HTTP**、URL `localhost:3100` にします。画面に出る `cloudflared` の connector を、この PC で動かします。
2. Cloudflare Zero Trust で `office.example.com` の Access application を足し、自分のメールだけを許します。これで、sign-in の画面まで届くのは自分だけになります。
3. https の住所を付けてオフィスを起こします。`127.0.0.1:` を付けると、3100 の port は社内のネットワークにも開きません。

```sh
docker run -d --name aioffice --stop-timeout 60 -p 127.0.0.1:3100:3100 -e AIOFFICE_HOSTS=https://office.example.com -v aioffice:/data ghcr.io/earthlinknetwork/aioffice:VERSION
```

`https://office.example.com/` を開きます。`AIOFFICE_HOSTS` にはカンマで区切って複数の住所を書けます（例: `https://office.example.com,office-pc.local:3100`）。

## 持ち主のパスワードを忘れた時

```sh
docker exec aioffice aioffice-reset-owner
```

リンクが出ます。それを開いて新しい持ち主のアカウントを作り、そのアカウントで http://localhost:3100/ に入ります。Cloudflare Tunnel を通して使っている時は、https の住所の同じリンクも出るので、そちらを開いても構いません。会社・AI 社員・設定は残ります。

新しい持ち主が入るまで、オフィスは AI 社員の定期の仕事を止めます。ただ、Slack などつないだ経路からの依頼では AI 社員が起きることがあり、その間に誰かが仕事を頼むと AI の使用量（費用）が進みます。
