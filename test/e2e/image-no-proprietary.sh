#!/usr/bin/env bash
# 配る image の全部の層に、独自の許諾（All rights reserved）の部品の本物が入っていないかを確かめる
# 使い方: bash test/e2e/image-no-proprietary.sh <image>
# stub（index.js と package.json だけ）は通す。本物の中身（dist・sdk.mjs・arch ごとの binary の部品）があれば落とす
# 調べる層は docker save の manifest.json に載った全部。1 つでも読めなければ（調べずに通さないため）落とす
set -euo pipefail
img="$1"; work="$(mktemp -d)"; trap 'rm -rf "$work"' EXIT
docker save "$img" -o "$work/image.tar"
tar -xf "$work/image.tar" -C "$work"
mapfile -t layers < <(node -e 'const m=require(process.argv[1]);for(const l of m[0].Layers)console.log(l)' "$work/manifest.json")
[ "${#layers[@]}" -gt 0 ] || { echo "manifest.json に層が無い"; exit 1; }
bad=0
for layer in "${layers[@]}"; do
  if ! list=$(tar -tf "$work/$layer" 2>/dev/null); then echo "層 $layer を読めない（調べずに通さない）"; bad=1; continue; fi
  hits=$(printf '%s\n' "$list" | grep -E 'node_modules/(@cursor/sdk|@anthropic-ai/claude-agent-sdk)(-[^/]+)?/' | grep -vE 'node_modules/(@cursor/sdk|@anthropic-ai/claude-agent-sdk)/(index\.js|package\.json)?$' | grep -v '/\.wh\.' || true)
  if [ -n "$hits" ]; then echo "層 $layer に本物が入っている:"; echo "$hits" | head -5; bad=1; fi
  # 試験だけの claude の CLI の stub（test/e2e/stubs/claude-quota-cli）は配る image に入れない（AI の使用量の上限の範囲 7 の 10）
  stub=$(printf '%s\n' "$list" | grep -E '(^|/)claude-quota-cli(\.json)?$' || true)
  if [ -n "$stub" ]; then echo "層 $layer に試験の stub が入っている:"; echo "$stub" | head -5; bad=1; fi
done
[ "$bad" = 0 ] && echo "ok: ${#layers[@]} 層すべてに独自の許諾の部品の本物は無い ($img)"
exit "$bad"
