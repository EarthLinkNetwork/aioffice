#!/bin/bash
# container の段の中身（container.yml の container の job が回す。GitHub の runner では host で直に、自前の runner では使い捨ての隔てた container の中で。test/e2e/ci-isolated.sh から呼ぶ）
# 段ごとに別の shell で回す（前の段の変数を持ち越さない・Actions の run と同じ bash -eo pipefail）。段の名前は Actions の画面の group に出す
# 前提の env: TAG・SHOTS・PW_DIR・RUNNER_TEMP。作業の場所は checkout の写し（cwd）
set -u
: "${TAG:?}" "${SHOTS:?}" "${PW_DIR:?}" "${RUNNER_TEMP:?}"
# メモリの見張り: 1GB を超えた process を 30 秒ごとに 1 行出す（RSS・uid・名前・script の名前だけ。引数の全体と env は出さない）
# なぜ: 上限 12g の中で uid 0 の node が 1 つ 11.5GB まで膨らみ、kernel の OOM で段が Killed になった（2026-11-21・amd64 の 2 台の kernel の記録）。名前だけでは script が分からない
( while sleep 30; do for s in /proc/[0-9]*/status; do awk -v p="${s%/status}" '/^Name:/{n=$2} /^Uid:/{u=$2} /^VmRSS:/{r=$2} END{if (r>1048576) print r, u, n, p}' "$s" 2>/dev/null; done | while read -r r u n p; do f=$({ tr '\0' '\n' < "$p/cmdline"; } 2>/dev/null | grep -m1 -oE '[A-Za-z0-9._-]+\.(mjs|js)$'); echo "mem-watch $((r/1024))MB uid=$u $n ${f:-pid=${p#/proc/}}"; done; done ) &
step() { echo "::group::$1"; local t0=$SECONDS; if bash --noprofile --norc -eo pipefail -c "$2"; then echo "::endgroup::"; echo "ok ($((SECONDS-t0))s): $1"; else echo "::endgroup::"; echo "::error::段が落ちた: $1"; docker logs aioffice 2>&1 | tail -200 || true; exit 1; fi; }

step 'build（RUN.txt の名前で tag を付ける）' "$(cat <<'STEP_EOF'
docker build --provenance=false --sbom=false --build-context embed="$RUNNER_TEMP/embed-ctx" -f packages/aioffice/Dockerfile -t "ghcr.io/earthlinknetwork/aioffice:${TAG}" .
STEP_EOF
)"
step '許諾の文に Ollama・ggml・bge-m3・XLM-RoBERTa（fairseq）・libgomp が入っている（範囲 2026-11-17 作り方 4）' "$(cat <<'STEP_EOF'
docker run --rm --entrypoint cat "ghcr.io/earthlinknetwork/aioffice:${TAG}" /opt/aioffice/THIRD_PARTY_NOTICES.txt > "$RUNNER_TEMP/notices.txt"
for w in '==== OLLAMA_LICENSE' 'Copyright (c) Ollama' 'The ggml authors' '==== BGE_M3_LICENSE' '==== XLM_ROBERTA_FAIRSEQ_LICENSE' 'Facebook, Inc.' 'bge-m3 model license' 'libgomp'; do
  grep -qF "$w" "$RUNNER_TEMP/notices.txt" || { echo "許諾の文に「$w」が無い"; exit 1; }
done
STEP_EOF
)"
step 'model の置き場は担当の user から書き換えられない（範囲 2026-11-17 作り方 2）' "$(cat <<'STEP_EOF'
docker run --rm --entrypoint sh "ghcr.io/earthlinknetwork/aioffice:${TAG}" -c '! touch /opt/aioffice/models/blobs/x 2>/dev/null && ! rm /opt/aioffice/models/manifests/registry.ollama.ai/library/bge-m3/latest 2>/dev/null && ! mv /opt/aioffice/models/manifests /opt/aioffice/models/m2 2>/dev/null && test -w /opt/aioffice/models/metadata'
STEP_EOF
)"
step '配る image の全部の層に、独自の許諾の部品の本物が無い・試験の claude の CLI の stub も無い' "$(cat <<'STEP_EOF'
docker builder prune -af >/dev/null; df -h / | tail -1
bash test/e2e/image-no-proprietary.sh "ghcr.io/earthlinknetwork/aioffice:${TAG}"
STEP_EOF
)"
step 'playwright' "$(cat <<'STEP_EOF'
mkdir -p "$PW_DIR" && cd "$PW_DIR" && npm init -y >/dev/null && npm install --no-audit --no-fund playwright@1.63.0
npx playwright install --with-deps chromium
STEP_EOF
)"
step '起動を待つ道具' "$(cat <<'STEP_EOF'
cat > "$RUNNER_TEMP/wait.sh" <<'SH'
for i in $(seq 1 90); do
  docker exec aioffice node -e "fetch('http://127.0.0.1:3101/api/health').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))" 2>/dev/null && exit 0
  sleep 2
done
docker logs aioffice | tail -50; exit 1
SH
STEP_EOF
)"
step '英語 — RUN.txt の行で起動し wizard を通す' "$(cat <<'STEP_EOF'
line=$(node test/e2e/run-line.mjs start "$TAG")
test -n "$line"
eval "$line"
bash "$RUNNER_TEMP/wait.sh"
PLAYWRIGHT_MODULE="$PW_DIR/node_modules/playwright/index.mjs" AIO_BASE=http://localhost:3100 AIO_LANG=en AIO_SHOTS="$SHOTS" node test/e2e/launcher-wizard.e2e.mjs
STEP_EOF
)"
step '英語 — オフィスの画面（部屋・デザインの依頼・つなぎ・仕事・受信箱・言語・CORS）' "$(cat <<'STEP_EOF'
PLAYWRIGHT_MODULE="$PW_DIR/node_modules/playwright/index.mjs" AIO_BASE=http://localhost:3100 AIO_LANG=en AIO_CONTAINER=aioffice AIO_CODEX=1 AIO_SHOTS="$SHOTS" node test/e2e/office.e2e.mjs
STEP_EOF
)"
step '英語 — 知らせ（N1〜N6・G3・帯と受信箱・2 社目に出ない・plugin を止めると遅れの帯）' "$(cat <<'STEP_EOF'
PLAYWRIGHT_MODULE="$PW_DIR/node_modules/playwright/index.mjs" AIO_BASE=http://localhost:3100 AIO_LANG=en AIO_CONTAINER=aioffice AIO_SHOTS="$SHOTS" node test/e2e/notify.e2e.mjs
STEP_EOF
)"
step '英語 — 図書室（L1〜L6・部屋・文書を置く・秘密を伏せる・2 社目に出ない・添え書き 1 つ・こだま無し・点検）' "$(cat <<'STEP_EOF'
PLAYWRIGHT_MODULE="$PW_DIR/node_modules/playwright/index.mjs" AIO_BASE=http://localhost:3100 AIO_LANG=en AIO_CONTAINER=aioffice AIO_SHOTS="$SHOTS" node test/e2e/library.e2e.mjs
STEP_EOF
)"
step '英語 — 秘書の気づき（見回りの口・出来事→見回り→提案→in_review・返事が次の回に入る・2 社目に出ない）' "$(cat <<'STEP_EOF'
AIO_LANG=en AIO_CONTAINER=aioffice node test/e2e/secretary.e2e.mjs
STEP_EOF
)"
step '英語 — AI の使用量の上限（ChatGPT・Claude の上限の失敗・使用率・追加料金・event の落ち・再開・flag OFF の対照・予算なし・差し替え口・走っている run の取り消し）' "$(cat <<'STEP_EOF'
docker rm -f aioffice
docker run -d --name aioffice --stop-timeout 60 -p 127.0.0.1:3100:3100 -v aioffice:/data -e AIOFFICE_CI_TEST_HOOKS=1 "ghcr.io/earthlinknetwork/aioffice:${TAG}"
bash "$RUNNER_TEMP/wait.sh"
PLAYWRIGHT_MODULE="$PW_DIR/node_modules/playwright/index.mjs" AIO_BASE=http://localhost:3100 AIO_LANG=en AIO_CONTAINER=aioffice AIO_SHOTS="$SHOTS" node test/e2e/limits.e2e.mjs
docker rm -f aioffice
eval "$(node test/e2e/run-line.mjs start "$TAG")"
bash "$RUNNER_TEMP/wait.sh"
STEP_EOF
)"
step '断られるべき要求（Host・Origin・WebSocket・再登録・codex の二度押し）' "$(cat <<'STEP_EOF'
AIO_BASE=http://localhost:3100 AIO_CONTAINER=aioffice AIO_CODEX=1 node test/e2e/launcher-negative.e2e.mjs
STEP_EOF
)"
step '本物の Claude Code — ダウンロードして動く・サインインの URL を出す・本物と同じ長さの code に答えが返り、断りを拾って止まる（2026-11-18 に偽の process の試験では見つからず利用者の実機で 3 回止まった件）' "$(cat <<'STEP_EOF'
AIO_CONTAINER=aioffice node test/e2e/ai-login-real.e2e.mjs
STEP_EOF
)"
step '配る物（Dockerfile・RUN.txt・公開の README と起動の手引き）に試験の --add-host と NODE_EXTRA_CA_CERTS が無い（Slack の範囲 2026-11-18）' "$(cat <<'STEP_EOF'
if grep -nE -- '--add-host|NODE_EXTRA_CA_CERTS|AIOFFICE_CI_MAIL_TEST|AIOFFICE_CI_TEST_HOOKS' packages/aioffice/Dockerfile packages/aioffice/RUN.txt README.md docs/getting-started.md docs/getting-started.ja.md; then echo "配る物に試験の設定がある"; exit 1; fi
STEP_EOF
)"
step 'Slack の偽の受け口を起こす（試験用の CA・hooks.slack.com の証明書・198.18.0.0/24 の網）' "$(cat <<'STEP_EOF'
d="$RUNNER_TEMP/slackca"; mkdir -p "$d"
openssl req -x509 -newkey rsa:2048 -nodes -keyout "$d/ca.key" -out "$d/ca.pem" -days 2 -subj "/CN=aioffice e2e test CA"
openssl req -newkey rsa:2048 -nodes -keyout "$d/leaf.key" -out "$d/leaf.csr" -subj "/CN=hooks.slack.com"
printf 'subjectAltName=DNS:hooks.slack.com\n' > "$d/ext"
openssl x509 -req -in "$d/leaf.csr" -CA "$d/ca.pem" -CAkey "$d/ca.key" -CAcreateserial -out "$d/leaf.pem" -days 2 -extfile "$d/ext"
rm -f "$d/ca.key"; chmod 644 "$d"/*
docker network create --subnet 198.18.0.0/24 aio-slack
docker run -d --name slack-fake --network aio-slack --ip 198.18.0.10 -p 127.0.0.1:3199:3199 -v "$d:/ca:ro" -v "$PWD/test/e2e/slack-fake.mjs:/fake/slack-fake.mjs:ro" --user root --entrypoint node "ghcr.io/earthlinknetwork/aioffice:${TAG}" /fake/slack-fake.mjs
for _ in $(seq 1 30); do curl -sf http://127.0.0.1:3199/got >/dev/null && ok=1 && break; sleep 1; done
test "$ok" = 1 || { docker logs slack-fake; exit 1; }
# aioffice を試験の網と名前の付け替えと試験用の CA で起こし直す（この段の行は CI だけ。配る起動の行には入れない）
cat > "$RUNNER_TEMP/slack-run.sh" <<'SH'
docker rm -f aioffice
docker run -d --name aioffice --stop-timeout 60 -p 127.0.0.1:3100:3100 -v aioffice:/data --network aio-slack --add-host hooks.slack.com:198.18.0.10 -v "$RUNNER_TEMP/slackca/ca.pem:/ca/ca.pem:ro" -e NODE_EXTRA_CA_CERTS=/ca/ca.pem "$1"
SH
STEP_EOF
)"
step 'メールの偽の受け口を起こす（試験用の CA・smtp.gmail.com の証明書・Slack と同じ 198.18.0.0/24 の網の 198.18.0.12・465 の TLS）' "$(cat <<'STEP_EOF'
d="$RUNNER_TEMP/mailca"; mkdir -p "$d"
openssl req -x509 -newkey rsa:2048 -nodes -keyout "$d/ca.key" -out "$d/ca.pem" -days 2 -subj "/CN=aioffice e2e mail test CA"
openssl req -newkey rsa:2048 -nodes -keyout "$d/leaf.key" -out "$d/leaf.csr" -subj "/CN=smtp.gmail.com"
printf 'subjectAltName=DNS:smtp.gmail.com\n' > "$d/ext"
openssl x509 -req -in "$d/leaf.csr" -CA "$d/ca.pem" -CAkey "$d/ca.key" -CAcreateserial -out "$d/leaf.pem" -days 2 -extfile "$d/ext"
rm -f "$d/ca.key"; chmod 644 "$d"/*
docker run -d --name mail-fake --network aio-slack --ip 198.18.0.12 -p 127.0.0.1:3299:3299 -v "$d:/ca:ro" -v "$PWD/test/e2e/mail-fake.mjs:/fake/mail-fake.mjs:ro" --user root --entrypoint node "ghcr.io/earthlinknetwork/aioffice:${TAG}" /fake/mail-fake.mjs
for _ in $(seq 1 30); do curl -sf http://127.0.0.1:3299/got >/dev/null && ok=1 && break; sleep 1; done
test "$ok" = 1 || { docker logs mail-fake; exit 1; }
# aioffice を試験の網と名前の付け替えで起こし直す。mode: full（試験用の CA と試験の印の env）・no-marker（CA だけ渡し、試験の印の env が無い）・no-ca（CA を渡さない）。この段の行は CI だけ。配る起動の行には入れない
cat > "$RUNNER_TEMP/mail-run.sh" <<'SH'
docker rm -f aioffice
case "$2" in
  full) extra="-e NODE_EXTRA_CA_CERTS=/ca/ca.pem -e AIOFFICE_CI_MAIL_TEST=1 -v $RUNNER_TEMP/mailca/ca.pem:/ca/ca.pem:ro";;
  no-marker) extra="-e NODE_EXTRA_CA_CERTS=/ca/ca.pem -v $RUNNER_TEMP/mailca/ca.pem:/ca/ca.pem:ro";;
  no-ca) extra="";;
  *) echo "mode"; exit 1;;
esac
docker run -d --name aioffice --stop-timeout 60 -p 127.0.0.1:3100:3100 -v aioffice:/data --network aio-slack --add-host smtp.gmail.com:198.18.0.12 -e AIOFFICE_CI_TEST_HOOKS=1 $extra "$1"
SH
STEP_EOF
)"
step '英語 — Slack に届ける（P1・1〜11・ON と OFF・429/500/404・遅い受け口・2 社目・秘密の数え）' "$(cat <<'STEP_EOF'
bash "$RUNNER_TEMP/slack-run.sh" "ghcr.io/earthlinknetwork/aioffice:${TAG}"
bash "$RUNNER_TEMP/wait.sh"
# 待ちは状態だけでなく、記録の BUILD_ID がこの image の plugin と同じになるまで（前の container の ready の記録で通らない・2026-11-22 arm64 の日本語のメールの段で、ci-slack から元の image への upgrade の最中に試験が走り 502）
ok=; for _ in $(seq 1 60); do docker exec aioffice node -e "const fs=require('fs');const j=JSON.parse(fs.readFileSync('/data/aioffice/plugins.json','utf8'));const b=p=>fs.readFileSync('/opt/aioffice/plugins/'+p+'/BUILD_ID','utf8').trim();process.exit(['notify','office'].every(p=>j['aioffice.'+p]?.status==='ready'&&j['aioffice.'+p]?.buildId===b(p))?0:1)" 2>/dev/null && ok=1 && break; sleep 2; done
test "$ok" = 1 || { docker exec aioffice cat /data/aioffice/plugins.json; exit 1; }
PLAYWRIGHT_MODULE="$PW_DIR/node_modules/playwright/index.mjs" AIO_BASE=http://localhost:3100 AIO_LANG=en AIO_CONTAINER=aioffice AIO_SHOTS="$SHOTS" AIO_SLACK_FAKE=http://127.0.0.1:3199 AIO_SLACK_STATE="$RUNNER_TEMP/slack-en.json" node test/e2e/slack.e2e.mjs
STEP_EOF
)"
step '英語 — メールで届ける（P1・1〜12・ON と OFF・535・1 日の上限・421・DATA の後の切断・2 社目・秘密の数え。ON のまま断りの段に持ち越す）' "$(cat <<'STEP_EOF'
bash "$RUNNER_TEMP/mail-run.sh" "ghcr.io/earthlinknetwork/aioffice:${TAG}" full
bash "$RUNNER_TEMP/wait.sh"
ok=; for _ in $(seq 1 60); do docker exec aioffice node -e "const fs=require('fs');const j=JSON.parse(fs.readFileSync('/data/aioffice/plugins.json','utf8'));const b=p=>fs.readFileSync('/opt/aioffice/plugins/'+p+'/BUILD_ID','utf8').trim();process.exit(['notify','office'].every(p=>j['aioffice.'+p]?.status==='ready'&&j['aioffice.'+p]?.buildId===b(p))?0:1)" 2>/dev/null && ok=1 && break; sleep 2; done
test "$ok" = 1 || { docker exec aioffice cat /data/aioffice/plugins.json; exit 1; }
PLAYWRIGHT_MODULE="$PW_DIR/node_modules/playwright/index.mjs" AIO_BASE=http://localhost:3100 AIO_LANG=en AIO_CONTAINER=aioffice AIO_SHOTS="$SHOTS" AIO_MAIL_FAKE=http://127.0.0.1:3299 AIO_MAIL_STATE="$RUNNER_TEMP/mail-en.json" AIO_MAIL_KEEP=1 node test/e2e/mail.e2e.mjs
STEP_EOF
)"
step 'メールの断り（1）— 試験用の CA を渡さない container は TLS で失敗する（AUTH を送らない・ON のまま次の段へ）' "$(cat <<'STEP_EOF'
bash "$RUNNER_TEMP/mail-run.sh" "ghcr.io/earthlinknetwork/aioffice:${TAG}" no-ca
bash "$RUNNER_TEMP/wait.sh"
PLAYWRIGHT_MODULE="$PW_DIR/node_modules/playwright/index.mjs" AIO_BASE=http://localhost:3100 AIO_LANG=en AIO_CONTAINER=aioffice AIO_MAIL_FAKE=http://127.0.0.1:3299 AIO_MAIL_STATE="$RUNNER_TEMP/mail-en.json" AIO_MAIL_PHASE=refuse-no-ca node test/e2e/mail.e2e.mjs
STEP_EOF
)"
step 'メールの断り（2）— 試験の印の env が無い container は、試験用の CA があってもメールを断り、やり直さず OFF にして帯に直し方を出す（最後に宛先を消す）（接続しない・AUTH を送らない）' "$(cat <<'STEP_EOF'
bash "$RUNNER_TEMP/mail-run.sh" "ghcr.io/earthlinknetwork/aioffice:${TAG}" no-marker
bash "$RUNNER_TEMP/wait.sh"
PLAYWRIGHT_MODULE="$PW_DIR/node_modules/playwright/index.mjs" AIO_BASE=http://localhost:3100 AIO_LANG=en AIO_CONTAINER=aioffice AIO_MAIL_FAKE=http://127.0.0.1:3299 AIO_MAIL_STATE="$RUNNER_TEMP/mail-en.json" AIO_MAIL_PHASE=refuse-no-marker node test/e2e/mail.e2e.mjs
STEP_EOF
)"
step 'docker stop → start でデータが残り、PostgreSQL が正しく止まる' "$(cat <<'STEP_EOF'
docker stop aioffice
state=$(docker run --rm -v aioffice:/data --entrypoint od "ghcr.io/earthlinknetwork/aioffice:${TAG}" -A n -t u4 -j 16 -N 4 /data/paperclip/instances/default/db/global/pg_control | tr -d ' ')
test "$state" = 1 || { echo "pg_control の状態が 1（正しく止まった）でない: $state"; exit 1; }
docker start aioffice && bash "$RUNNER_TEMP/wait.sh"
# 本体はログインのある形なので、起動係の鍵（/data/aioffice/board-key.json）で聞く。答えが違う時は中身を出して落ちる
docker exec aioffice node -e "const k=JSON.parse(require('fs').readFileSync('/data/aioffice/board-key.json','utf8')).token;fetch('http://127.0.0.1:3101/api/companies',{headers:{authorization:'Bearer '+k}}).then(async r=>{const t=await r.text();let j=null;try{j=JSON.parse(t)}catch{}if(!r.ok||!Array.isArray(j)||j.length!==1){console.log('会社の一覧が 1 社でない:',r.status,t.slice(0,300));process.exit(1)}})"
curl -sf -H 'host: localhost:3100' http://127.0.0.1:3100/setup/api/state | grep -q '"done":true'
STEP_EOF
)"
step '更新の行（pull を除く）で container を作り直してもデータが残り、wizard が出ない' "$(cat <<'STEP_EOF'
line=$(node test/e2e/run-line.mjs update "$TAG")
line=$(printf '%s' "$line" | sed 's/docker pull [^&]*&& //')
case "$line" in *"docker rm aioffice"*"docker run "*) ;; *) echo "RUN.txt の [update] の行が想定の形でない: $line"; exit 1;; esac
before=$(docker inspect -f '{{.Id}}' aioffice)
eval "$line"
after=$(docker inspect -f '{{.Id}}' aioffice)
test "$before" != "$after" || { echo "更新の行で container が作り直されていない"; exit 1; }
bash "$RUNNER_TEMP/wait.sh"
curl -sf -H 'host: localhost:3100' http://127.0.0.1:3100/setup/api/state | grep -q '"done":true'
AIO_BASE=http://localhost:3100 AIO_CONTAINER=aioffice node test/e2e/launcher-negative.e2e.mjs
STEP_EOF
)"
step '日本語 — まっさらな volume で wizard を通す' "$(cat <<'STEP_EOF'
docker rm -f aioffice && docker volume rm aioffice
line=$(node test/e2e/run-line.mjs start "$TAG")
test -n "$line"
eval "$line"
bash "$RUNNER_TEMP/wait.sh"
PLAYWRIGHT_MODULE="$PW_DIR/node_modules/playwright/index.mjs" AIO_BASE=http://localhost:3100 AIO_LANG=ja AIO_SHOTS="$SHOTS" node test/e2e/launcher-wizard.e2e.mjs
STEP_EOF
)"
step '日本語 — オフィスの画面' "$(cat <<'STEP_EOF'
PLAYWRIGHT_MODULE="$PW_DIR/node_modules/playwright/index.mjs" AIO_BASE=http://localhost:3100 AIO_LANG=ja AIO_CONTAINER=aioffice AIO_SHOTS="$SHOTS" node test/e2e/office.e2e.mjs
STEP_EOF
)"
step '日本語 — 知らせ' "$(cat <<'STEP_EOF'
PLAYWRIGHT_MODULE="$PW_DIR/node_modules/playwright/index.mjs" AIO_BASE=http://localhost:3100 AIO_LANG=ja AIO_CONTAINER=aioffice AIO_SHOTS="$SHOTS" node test/e2e/notify.e2e.mjs
STEP_EOF
)"
step '日本語 — 図書室' "$(cat <<'STEP_EOF'
PLAYWRIGHT_MODULE="$PW_DIR/node_modules/playwright/index.mjs" AIO_BASE=http://localhost:3100 AIO_LANG=ja AIO_CONTAINER=aioffice AIO_SHOTS="$SHOTS" node test/e2e/library.e2e.mjs
STEP_EOF
)"
step '日本語 — 秘書の気づき' "$(cat <<'STEP_EOF'
AIO_LANG=ja AIO_CONTAINER=aioffice node test/e2e/secretary.e2e.mjs
STEP_EOF
)"
step '日本語 — AI の使用量の上限' "$(cat <<'STEP_EOF'
docker rm -f aioffice
docker run -d --name aioffice --stop-timeout 60 -p 127.0.0.1:3100:3100 -v aioffice:/data -e AIOFFICE_CI_TEST_HOOKS=1 "ghcr.io/earthlinknetwork/aioffice:${TAG}"
bash "$RUNNER_TEMP/wait.sh"
PLAYWRIGHT_MODULE="$PW_DIR/node_modules/playwright/index.mjs" AIO_BASE=http://localhost:3100 AIO_LANG=ja AIO_CONTAINER=aioffice AIO_SHOTS="$SHOTS" node test/e2e/limits.e2e.mjs
docker rm -f aioffice
eval "$(node test/e2e/run-line.mjs start "$TAG")"
bash "$RUNNER_TEMP/wait.sh"
STEP_EOF
)"
step '日本語 — Slack に届ける（ON のまま 12 に持ち越す）' "$(cat <<'STEP_EOF'
bash "$RUNNER_TEMP/slack-run.sh" "ghcr.io/earthlinknetwork/aioffice:${TAG}"
bash "$RUNNER_TEMP/wait.sh"
ok=; for _ in $(seq 1 60); do docker exec aioffice node -e "const fs=require('fs');const j=JSON.parse(fs.readFileSync('/data/aioffice/plugins.json','utf8'));const b=p=>fs.readFileSync('/opt/aioffice/plugins/'+p+'/BUILD_ID','utf8').trim();process.exit(['notify','office'].every(p=>j['aioffice.'+p]?.status==='ready'&&j['aioffice.'+p]?.buildId===b(p))?0:1)" 2>/dev/null && ok=1 && break; sleep 2; done
test "$ok" = 1 || { docker exec aioffice cat /data/aioffice/plugins.json; exit 1; }
PLAYWRIGHT_MODULE="$PW_DIR/node_modules/playwright/index.mjs" AIO_BASE=http://localhost:3100 AIO_LANG=ja AIO_CONTAINER=aioffice AIO_SHOTS="$SHOTS" AIO_SLACK_FAKE=http://127.0.0.1:3199 AIO_SLACK_STATE="$RUNNER_TEMP/slack-ja.json" AIO_SLACK_KEEP=1 node test/e2e/slack.e2e.mjs
STEP_EOF
)"
step 'Slack 12 — 知らせの plugin を入れ直しても ON・送りの記録が残り、送った知らせを 2 回目に送らない（最後に OFF にして宛先を消す）' "$(cat <<'STEP_EOF'
printf 'FROM %s\nUSER root\nRUN echo "// ci slack" >> /opt/aioffice/plugins/notify/dist/worker.js && echo ci-slack > /opt/aioffice/plugins/notify/BUILD_ID\nUSER node\n' "ghcr.io/earthlinknetwork/aioffice:${TAG}" | docker build -t aioffice:ci-slack -
bash "$RUNNER_TEMP/slack-run.sh" aioffice:ci-slack
bash "$RUNNER_TEMP/wait.sh"
ok=; for _ in $(seq 1 60); do docker exec aioffice node -e "const j=JSON.parse(require('fs').readFileSync('/data/aioffice/plugins.json','utf8'));process.exit(j['aioffice.notify']?.buildId==='ci-slack'&&j['aioffice.notify']?.status==='ready'?0:1)" 2>/dev/null && ok=1 && break; sleep 2; done
test "$ok" = 1 || { docker exec aioffice cat /data/aioffice/plugins.json; exit 1; }
PLAYWRIGHT_MODULE="$PW_DIR/node_modules/playwright/index.mjs" AIO_BASE=http://localhost:3100 AIO_LANG=ja AIO_CONTAINER=aioffice AIO_SLACK_FAKE=http://127.0.0.1:3199 AIO_SLACK_STATE="$RUNNER_TEMP/slack-ja.json" AIO_SLACK_PHASE=after-reinstall node test/e2e/slack.e2e.mjs
STEP_EOF
)"
step '日本語 — メールで届ける（ON のまま入れ直しに持ち越す）' "$(cat <<'STEP_EOF'
bash "$RUNNER_TEMP/mail-run.sh" "ghcr.io/earthlinknetwork/aioffice:${TAG}" full
bash "$RUNNER_TEMP/wait.sh"
ok=; for _ in $(seq 1 60); do docker exec aioffice node -e "const fs=require('fs');const j=JSON.parse(fs.readFileSync('/data/aioffice/plugins.json','utf8'));const b=p=>fs.readFileSync('/opt/aioffice/plugins/'+p+'/BUILD_ID','utf8').trim();process.exit(['notify','office'].every(p=>j['aioffice.'+p]?.status==='ready'&&j['aioffice.'+p]?.buildId===b(p))?0:1)" 2>/dev/null && ok=1 && break; sleep 2; done
test "$ok" = 1 || { docker exec aioffice cat /data/aioffice/plugins.json; exit 1; }
PLAYWRIGHT_MODULE="$PW_DIR/node_modules/playwright/index.mjs" AIO_BASE=http://localhost:3100 AIO_LANG=ja AIO_CONTAINER=aioffice AIO_SHOTS="$SHOTS" AIO_MAIL_FAKE=http://127.0.0.1:3299 AIO_MAIL_STATE="$RUNNER_TEMP/mail-ja.json" AIO_MAIL_KEEP=1 node test/e2e/mail.e2e.mjs
STEP_EOF
)"
step 'メール 12 — 知らせの plugin を入れ直しても ON・送りの記録が残り、送った知らせを 2 回目に送らない（最後に OFF にして宛先を消す）' "$(cat <<'STEP_EOF'
printf 'FROM %s\nUSER root\nRUN echo "// ci mail" >> /opt/aioffice/plugins/notify/dist/worker.js && echo ci-mail > /opt/aioffice/plugins/notify/BUILD_ID\nUSER node\n' "ghcr.io/earthlinknetwork/aioffice:${TAG}" | docker build -t aioffice:ci-mail -
bash "$RUNNER_TEMP/mail-run.sh" aioffice:ci-mail full
bash "$RUNNER_TEMP/wait.sh"
ok=; for _ in $(seq 1 60); do docker exec aioffice node -e "const j=JSON.parse(require('fs').readFileSync('/data/aioffice/plugins.json','utf8'));process.exit(j['aioffice.notify']?.buildId==='ci-mail'&&j['aioffice.notify']?.status==='ready'?0:1)" 2>/dev/null && ok=1 && break; sleep 2; done
test "$ok" = 1 || { docker exec aioffice cat /data/aioffice/plugins.json; exit 1; }
PLAYWRIGHT_MODULE="$PW_DIR/node_modules/playwright/index.mjs" AIO_BASE=http://localhost:3100 AIO_LANG=ja AIO_CONTAINER=aioffice AIO_MAIL_FAKE=http://127.0.0.1:3299 AIO_MAIL_STATE="$RUNNER_TEMP/mail-ja.json" AIO_MAIL_PHASE=after-reinstall node test/e2e/mail.e2e.mjs
STEP_EOF
)"
step 'plugin の中身が違う image（BUILD_ID が違う）で同じ volume を起動し直すと、新しい BUILD_ID で ready になり会社と担当・図書室の所蔵・添え書き・知らせの既読が残る（G2）' "$(cat <<'STEP_EOF'
node test/e2e/reinstall-check.mjs snap "$RUNNER_TEMP/before.json"
printf 'FROM %s\nUSER root\nRUN for p in office design notify library; do echo "// ci rebuilt" >> /opt/aioffice/plugins/$p/dist/worker.js && echo ci-rebuilt > /opt/aioffice/plugins/$p/BUILD_ID; done\nUSER node\n' "ghcr.io/earthlinknetwork/aioffice:${TAG}" | docker build -t aioffice:ci-rebuilt -
docker rm -f aioffice
docker run -d --name aioffice --stop-timeout 60 -p 127.0.0.1:3100:3100 -v aioffice:/data aioffice:ci-rebuilt
bash "$RUNNER_TEMP/wait.sh"
for _ in $(seq 1 60); do docker exec aioffice node -e "const j=JSON.parse(require('fs').readFileSync('/data/aioffice/plugins.json','utf8'));process.exit(['office','design','notify','library'].every(p=>j['aioffice.'+p]?.buildId==='ci-rebuilt'&&j['aioffice.'+p]?.status==='ready')?0:1)" 2>/dev/null && ok=1 && break; sleep 2; done
test "$ok" = 1 || { docker exec aioffice cat /data/aioffice/plugins.json; docker logs aioffice | tail -50; exit 1; }
docker exec aioffice node -e "(async()=>{const h={authorization:'Bearer '+JSON.parse(require('fs').readFileSync('/data/aioffice/board-key.json','utf8')).token};const c=await (await fetch('http://127.0.0.1:3101/api/companies',{headers:h})).json();const a=await (await fetch('http://127.0.0.1:3101/api/companies/'+c[0].id+'/agents',{headers:h})).json();if(c.length!==1||a.length!==2){console.log('会社か担当の数が違う:',JSON.stringify(c).slice(0,200),JSON.stringify(a).slice(0,200));process.exit(1)}})().catch(e=>{console.log(e);process.exit(1)})"
curl -sf -H 'host: localhost:3100' http://127.0.0.1:3100/setup/api/state | grep -q '"done":true'
node test/e2e/reinstall-check.mjs check "$RUNNER_TEMP/before.json"
STEP_EOF
)"
step '図書室の capability を 1 つ足した版でも、外して入れ直して ready になり中身が残る（G2）' "$(cat <<'STEP_EOF'
mkdir -p "$RUNNER_TEMP/cap"
cat > "$RUNNER_TEMP/cap/Dockerfile" <<'EOF'
FROM aioffice:ci-rebuilt
USER root
RUN sed -i 's/"events.subscribe",/"events.subscribe", "goals.read",/' /opt/aioffice/plugins/library/dist/manifest.js && grep -q goals.read /opt/aioffice/plugins/library/dist/manifest.js && echo ci-cap > /opt/aioffice/plugins/library/BUILD_ID
USER node
EOF
docker build -t aioffice:ci-cap "$RUNNER_TEMP/cap"
docker rm -f aioffice
docker run -d --name aioffice --stop-timeout 60 -p 127.0.0.1:3100:3100 -v aioffice:/data aioffice:ci-cap
bash "$RUNNER_TEMP/wait.sh"
ok=; for _ in $(seq 1 60); do docker exec aioffice node -e "const j=JSON.parse(require('fs').readFileSync('/data/aioffice/plugins.json','utf8'));process.exit(j['aioffice.library']?.buildId==='ci-cap'&&j['aioffice.library']?.status==='ready'&&j['aioffice.notify']?.status==='ready'?0:1)" 2>/dev/null && ok=1 && break; sleep 2; done
test "$ok" = 1 || { docker exec aioffice cat /data/aioffice/plugins.json; docker logs aioffice | tail -50; exit 1; }
node test/e2e/reinstall-check.mjs check "$RUNNER_TEMP/before.json"
STEP_EOF
)"
step '同じ volume を網を切って起動しても、図書室の検索と知らせが動き中身が残る（G1）' "$(cat <<'STEP_EOF'
docker rm -f aioffice
docker run -d --name aioffice --network none -v aioffice:/data aioffice:ci-cap
ok=; for _ in $(seq 1 90); do docker exec aioffice node -e "fetch('http://127.0.0.1:3101/api/health').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))" 2>/dev/null && ok=1 && break; sleep 2; done
test "$ok" = 1 || { docker logs aioffice | tail -50; exit 1; }
ok=; for _ in $(seq 1 60); do docker exec aioffice node -e "const j=JSON.parse(require('fs').readFileSync('/data/aioffice/plugins.json','utf8'));process.exit(j['aioffice.library']?.status==='ready'&&j['aioffice.notify']?.status==='ready'?0:1)" 2>/dev/null && ok=1 && break; sleep 2; done
test "$ok" = 1 || { docker exec aioffice cat /data/aioffice/plugins.json; docker logs aioffice | tail -50; exit 1; }
node test/e2e/reinstall-check.mjs check "$RUNNER_TEMP/before.json" --search
STEP_EOF
)"
step '網を切った container でも起動する' "$(cat <<'STEP_EOF'
docker run -d --name aioffice-offline --network none -v aioffice-offline:/data "ghcr.io/earthlinknetwork/aioffice:${TAG}"
for _ in $(seq 1 90); do docker exec aioffice-offline node -e "fetch('http://127.0.0.1:3101/api/health').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))" 2>/dev/null && ok=1 && break; sleep 2; done
test "$ok" = 1 || { docker logs aioffice-offline | tail -50; exit 1; }
docker exec aioffice-offline node -e "fetch('http://localhost:3100/setup/api/state').then(r=>process.exit(r.ok?0:1))"
# ログインのある形では、plugin は最初の持ち主と起動係の鍵ができてから入る。網なしでもそこまで通す
docker exec -i aioffice-offline node --input-type=module - < test/e2e/offline-owner.mjs || { docker logs aioffice-offline | tail -80; exit 1; }
ok=; for _ in $(seq 1 60); do docker exec aioffice-offline node -e "const j=JSON.parse(require('fs').readFileSync('/data/aioffice/plugins.json','utf8'));process.exit(j['aioffice.office']?.status==='ready'&&j['aioffice.design']?.status==='ready'&&j['aioffice.notify']?.status==='ready'&&j['aioffice.library']?.status==='ready'&&j['aioffice.secretary']?.status==='ready'&&j['aioffice.relay']?.status==='ready'?0:1)" 2>/dev/null && ok=1 && break; sleep 2; done
test "$ok" = 1 || { docker exec aioffice-offline cat /data/aioffice/plugins.json; docker logs aioffice-offline | tail -50; exit 1; }
STEP_EOF
)"
step 'ログインのある形: 3 人の多段の承認と人の欄（設計 2026-11-23 の e2e 1・2）' "$(cat <<'STEP_EOF'
docker rm -f aioffice aioffice-offline >/dev/null 2>&1 || true
docker run -d --name aio-chain --stop-timeout 60 -p 127.0.0.1:3163:3100 -v aio-chain:/data "ghcr.io/earthlinknetwork/aioffice:${TAG}"
PLAYWRIGHT_MODULE="$PW_DIR/node_modules/playwright/index.mjs" node test/e2e/multi-user-chain.e2e.mjs aio-chain http://127.0.0.1:3163 || { docker logs aio-chain | tail -80; exit 1; }
docker rm -f aio-chain
STEP_EOF
)"
step 'パスワードを忘れた時の戻し方（aioffice-reset-owner・設計 2.8 の e2e 8）' "$(cat <<'STEP_EOF'
docker run -d --name aio-reset --stop-timeout 60 -p 127.0.0.1:3164:3100 -v aio-reset:/data "ghcr.io/earthlinknetwork/aioffice:${TAG}"
node test/e2e/reset-owner.e2e.mjs aio-reset http://127.0.0.1:3164 || { docker logs aio-reset | tail -80; exit 1; }
docker rm -f aio-reset
STEP_EOF
)"
step 'ほかの PC から使う形（AIOFFICE_HOSTS・設計 2.1 の e2e 3）' "$(cat <<'STEP_EOF'
node test/e2e/lan.e2e.mjs "ghcr.io/earthlinknetwork/aioffice:${TAG}"
STEP_EOF
)"
step '前の版（合言葉の形）からの移し替えと backup からの戻し（前の版は test/e2e/migrate-from.sha の source から作る）' "$(cat <<'STEP_EOF'
test -f "$RUNNER_TEMP/old-src/packages/aioffice/Dockerfile" || { echo "前の版の source が無い（container.yml の「前の版の source」）"; exit 1; }
docker build --build-context embed="$RUNNER_TEMP/embed-ctx" -f "$RUNNER_TEMP/old-src/packages/aioffice/Dockerfile" -t aioffice-old:ci "$RUNNER_TEMP/old-src"
node test/e2e/migrate-auth.e2e.mjs aioffice-old:ci "ghcr.io/earthlinknetwork/aioffice:${TAG}" 3162
docker rmi -f aioffice-old:ci >/dev/null 2>&1 || true
STEP_EOF
)"
