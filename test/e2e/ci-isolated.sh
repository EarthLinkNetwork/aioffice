#!/bin/bash
# container の段を回す。自前の runner では使い捨ての隔てた container の中で回し（2026-11-20）、GitHub の runner では host で直に回す（下の分岐・2026-11-25）。
# なぜ: 自前の runner は host の docker を共有するので、試験が使う決まった名前（aioffice・slack-fake・mail-fake）・網（198.18.0.0/24）・port（3100 など）・volume が、
#   ほかの repo の job や host の container にぶつかる。また Actions の job の container（jobs.<id>.container）には runner が host の docker の socket を必ず渡すので、
#   その中で「専用の docker」を起こしても host の docker を見てしまう（独立レビュー 2026-11-20）。
# どうする: host の docker には、run ごとに名前が違う container を 1 つだけ作る（socket も host の path も渡さない・中身は docker cp で入れる）。
#   その中で dockerd を起こし、中の docker が host と別の daemon であることを確かめてから、test/e2e/container-stage.sh を回す。最後に container と匿名の volume を消す。
# 使い方: ci-isolated.sh <arch>（env: TAG・RUNNER_TEMP・GITHUB_RUN_ID・GITHUB_RUN_ATTEMPT。cwd は checkout の写し）
set -euo pipefail
ARCH=$1
NAME="aioffice-ci-${GITHUB_RUN_ID}-${GITHUB_RUN_ATTEMPT}-${ARCH}"
EMBED="$RUNNER_TEMP/embed.tar"  # 埋め込みの部品の cache は 1 つの tar（中の model の置き場は書き込みを外す mode なので、host に展開すると runner が temp を消せない）

# GitHub の runner（public にした 0.1.0 から・2026-11-25）: job ごとの使い捨ての VM で、ほかの job と docker を共有しないので、隔てた container を作らず host で直に回す。
# 隔てた container の中の 40GB の門と CPU の上限（自前の機械向け）は、GitHub の runner では必ず落ちる・遅すぎる（独立レビュー 2026-11-25 P1-1）
if [ "${RUNNER_ENVIRONMENT:-}" = github-hosted ]; then
  # 元から入っている使わない道具を消して disk の空きを作る（2026-11-17 amd64 で no space left on device）。使い捨ての VM なので片付けは要らない
  df -h / | tail -1
  sudo rm -rf /usr/share/dotnet /usr/local/lib/android /opt/ghc /usr/local/.ghcup /opt/hostedtoolcache/CodeQL /usr/local/share/boost || true
  df -h / | tail -1
  D="$RUNNER_TEMP/embed-ctx/opt/embed"
  if [ -s "$EMBED" ] && [ ! -f "$D/SHA256SUMS" ]; then tar -C "$RUNNER_TEMP" -xf "$EMBED"; fi
  test -f "$D/SHA256SUMS" || sh packages/aioffice/embed/fetch-embed.sh "$ARCH" "$D"
  (cd "$D" && sha256sum -c --quiet SHA256SUMS)
  for f in "$D"/models/blobs/sha256-*; do echo "${f##*/sha256-}  $f" | sha256sum -c - >/dev/null; done
  if [ ! -s "$EMBED" ]; then tar -C "$RUNNER_TEMP" -cf "$EMBED" embed-ctx; fi
  # 前の版の source（移し替えと戻しの e2e で前の版の image を作る・container-stage.sh は "$RUNNER_TEMP/old-src" を読む）
  if [ -s "$RUNNER_TEMP/old-src.tar" ]; then mkdir -p "$RUNNER_TEMP/old-src" && tar -C "$RUNNER_TEMP/old-src" -xf "$RUNNER_TEMP/old-src.tar"; fi
  # image・build の cache・docker save の tar で 1 回に十数 GB を使う。空きが 20GB を切っていたら始めない
  free_kb=$(df -Pk / | awk 'NR==2{print $4}')
  if [ "$free_kb" -lt 20971520 ]; then echo "::error::runner の disk の空きが 20GB を切っている（$((free_kb / 1048576))GB）"; exit 1; fi
  export SHOTS="$PWD/shots" PW_DIR="$RUNNER_TEMP/pw"
  exec bash test/e2e/container-stage.sh
fi
cleanup() { docker kill "$NAME" >/dev/null 2>&1 || true; docker rm -fv "$NAME" >/dev/null 2>&1 || true; } # 先に止めてから、大きな匿名の volume ごと消す
trap cleanup EXIT
trap 'exit 130' INT TERM
# 長い docker exec は裏で回して wait する（前で子が動いている間は bash が trap を動かさないので、取り消しの SIGINT・SIGTERM で片付けられなくなる）
run_bg() { "$@" & wait $!; }

# 前の回が取り消されて残した物を片付ける（この印の付いた container で、作って 5 時間を過ぎた物だけ。job の上限は 4 時間）
now=$(date +%s)
for id in $(docker ps -aq --filter label=aioffice-ci=1); do
  c=$(date -d "$(docker inspect -f '{{.Created}}' "$id")" +%s 2>/dev/null || echo "$now")
  if [ $((now - c)) -gt 18000 ]; then docker rm -fv "$id" >/dev/null || true; fi
done

host_id=$(docker info --format '{{.ID}}')
# --rm と sleep 15000（job の上限 4 時間より長い）: runner が step を SIGKILL して trap が動かなくても、時間が来れば container と匿名の volume が自分で消える
# --cpuset-cpus・--memory: host の本番と取り合わないよう上限を付ける。CPU は host の数から 2 を引いた数（最大 8）。4 では上限の e2e の 1 段が 43 分かかった（2026-11-20 自前の arm64 の機械）
# --cpus（時間の枠）にしない: 中の製品の container は自分の cgroup の cpu.max しか見えず、Ollama が host の全部の core の数でスレッドを立てて枠の中で取り合い、
# 1 行に 24 秒かかって図書室の L7 が時間切れになった（2026-11-20 amd64・numThread 16 に枠 8）。cpuset なら中の cpuset.cpus.effective にも出て、スレッドの数が合う
# 前提: host は cgroup v2 で、container の cgroupns は private（中の dockerd の孫が外側の cgroup の下にできる）。v1 か host の cgroupns だと cpuset も memory も孫に届かない
# core は daemon から見た online の一覧から、性能の目安（cpu_capacity・無ければ 1024）の高い順に選ぶ（番号の飛び・大小の core の混在に備える）
ncpu=$(docker info --format '{{.NCPU}}'); cpus=$(( ncpu - 2 )); if [ "$cpus" -gt 8 ]; then cpus=8; fi; if [ "$cpus" -lt 2 ]; then cpus=2; fi; if [ "$cpus" -gt "$ncpu" ]; then cpus=$ncpu; fi
cpuset=$(docker run --rm --network none node:24-trixie node -e '
const fs = require("fs"), rd = p => { try { return fs.readFileSync(p, "utf8").trim(); } catch { return null; } };
const ids = [];
for (const part of (rd("/sys/devices/system/cpu/online") || "").split(",").filter(Boolean)) { const [a, b = a] = part.split("-").map(Number); for (let i = a; i <= b; i++) ids.push(i); }
const cap = i => Number(rd(`/sys/devices/system/cpu/cpu${i}/cpu_capacity`)) || 1024;
console.log(ids.map(i => [cap(i), i]).sort((x, y) => y[0] - x[0] || y[1] - x[1]).slice(0, Number(process.argv[1])).map(x => x[1]).sort((x, y) => x - y).join(","));
' "$cpus")
if [ -z "$cpuset" ]; then echo "::error::online の CPU の一覧が読めない"; exit 1; fi
echo "隔てた container の CPU: $cpuset（$cpus 個）"
docker run -d --rm --init --name "$NAME" --label aioffice-ci=1 --privileged --cpuset-cpus "$cpuset" --memory 12g -v /var/lib/docker \
  -e TAG -e SHOTS=/w/shots -e PW_DIR=/pw -e RUNNER_TEMP=/rt -e GITHUB_STEP_SUMMARY=/rt/summary.md node:24-trixie sleep 15000 >/dev/null
# image・build の cache・docker save の tar・埋め込みの部品で 1 回に十数 GB を使う。host の disk の空きが 40GB を切っていたら始めない
free_kb=$(docker exec "$NAME" df -Pk /var/lib/docker | awk 'NR==2{print $4}')
if [ "$free_kb" -lt 41943040 ]; then echo "::error::host の disk の空きが 40GB を切っている（$((free_kb / 1048576))GB）"; exit 1; fi
docker exec "$NAME" mkdir -p /w /rt
run_bg docker cp . "$NAME":/w >/dev/null
# 裏の command の標準入力は /dev/null になるので、入力の付け替えは sh -c の中で行う
if [ -s "$EMBED" ]; then run_bg sh -c 'docker exec -i "$1" tar -C /rt -xf - < "$2"' _ "$NAME" "$EMBED"; fi
# 前の版の source（移し替えと戻しの e2e で前の版の image を作る）
if [ -s "$RUNNER_TEMP/old-src.tar" ]; then run_bg sh -c 'docker exec "$1" mkdir -p /rt/old-src && docker exec -i "$1" tar -C /rt/old-src -xf - < "$2"' _ "$NAME" "$RUNNER_TEMP/old-src.tar"; fi

run_bg docker exec "$NAME" bash -euo pipefail -c '
  test ! -e /var/run/docker.sock || { echo "中に docker の socket が先にある（host の socket が渡っている）"; exit 1; }
  export DEBIAN_FRONTEND=noninteractive
  apt-get update -qq && apt-get install -y -qq --no-install-recommends docker.io docker-cli docker-buildx zstd iptables >/dev/null
  (dockerd > /rt/dockerd.log 2>&1 &)
  for _ in $(seq 1 60); do docker info >/dev/null 2>&1 && break; sleep 1; done
  docker info --format "{{.Driver}} {{.Architecture}}" >/dev/null || { tail -30 /rt/dockerd.log; exit 1; }'
inner_id=$(docker exec "$NAME" docker info --format '{{.ID}}')
if [ -z "$inner_id" ] || [ "$inner_id" = "$host_id" ]; then echo "中の docker が host の docker と同じ（隔てられていない）"; exit 1; fi
echo "隔てた docker: $(docker exec "$NAME" docker info --format '{{.Driver}} {{.Architecture}}')（host と別の daemon）"

# 埋め込みの部品は cache に無い時だけ中で取り、host の cache の置き場へ戻す（次の回は actions/cache が戻す）
run_bg docker exec -w /w -e ARCH="$ARCH" "$NAME" bash -euo pipefail -c '
  D=/rt/embed-ctx/opt/embed
  test -f "$D/SHA256SUMS" || sh packages/aioffice/embed/fetch-embed.sh "$ARCH" "$D"
  (cd "$D" && sha256sum -c --quiet SHA256SUMS)
  for f in "$D"/models/blobs/sha256-*; do echo "${f##*/sha256-}  $f" | sha256sum -c - >/dev/null; done
  test -z "$(find "$D/models/blobs" -maxdepth 0 -perm /222)" || { echo "model の置き場に書き込みを外す mode が付いていない"; exit 1; }'  # 中は root なので test -w でなく mode を見る
if [ ! -s "$EMBED" ]; then mkdir -p "$RUNNER_TEMP" && run_bg sh -c 'docker exec "$1" tar -C /rt -cf - embed-ctx > "$2"' _ "$NAME" "$EMBED"; fi

rc=0
run_bg docker exec -w /w "$NAME" bash test/e2e/container-stage.sh || rc=$?
mkdir -p shots && { docker cp "$NAME":/w/shots/. shots/ >/dev/null 2>&1 || true; }
if [ -n "${GITHUB_STEP_SUMMARY:-}" ]; then docker exec "$NAME" cat /rt/summary.md >> "$GITHUB_STEP_SUMMARY" 2>/dev/null || true; fi
exit $rc
