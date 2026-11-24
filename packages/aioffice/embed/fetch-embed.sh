#!/bin/sh
# 図書室の意味の近さの検索に使う Ollama（CPU の部品だけ）と bge-m3 を、版と sha256 を固定して取り、決めた置き場に並べる
# 使い方: sh packages/aioffice/embed/fetch-embed.sh <arch: amd64|arm64> <置き場>（image の段 embed と、測りの workflow embed-bench が使う）
#   <置き場>/ollama/bin/ollama・<置き場>/ollama/lib/ollama/*.so（GPU の部品は入れない）
#   <置き場>/models/{manifests,blobs}（Ollama の model の置き場の形）
#   <置き場>/licenses/（Ollama 本体と、arm64 の libomp の許諾の文・版と sha256 を固定）
# 範囲: docs/review/2026-11-17-library-embedding-scope.md（作り方 1・2）
set -eu
ARCH=$1; OUT=$2
OLLAMA_VERSION=v0.40.16
case "$ARCH" in
  amd64) OLLAMA_SHA=87bfafb2acbc89b2e6a1be0a9043de6aa75fb450696f86bc426e65fc448f788d ;;
  arm64) OLLAMA_SHA=e45b8e6dcb86cb9f3057396351655079c9a4879b4ced2678c9350d375dcbc224 ;;
  *) echo "arch は amd64 か arm64" >&2; exit 2 ;;
esac
# bge-m3（registry.ollama.ai の library/bge-m3:latest = 567m-fp16）の層を digest で固定する
MODEL_CONFIG=sha256:0c4c9c2a325fb1cdafec606e6809cb745f1cb26a6d919994400d27372303e276
MODEL_BLOB=sha256:daec91ffb5dd0c27411bd71f29932917c49cf529a641d0168496c3a501e3062c
MODEL_LICENSE=sha256:a406579cd136771c705c521db86ca7d60a6f3de7c9b5460e6193a2df27861bde
REG=https://registry.ollama.ai/v2/library/bge-m3

mkdir -p "$OUT/ollama" "$OUT/licenses" "$OUT/models/blobs" "$OUT/models/manifests/registry.ollama.ai/library/bge-m3"
TMP=$(mktemp -d); trap 'rm -rf "$TMP"' EXIT

# Ollama: 配布物を取り sha256 を確かめ、CPU の部品だけを取り出す（tarball は置き場に残さない）
command -v zstd >/dev/null || { echo "zstd が要る" >&2; exit 1; }
curl -fsSL --retry 3 --retry-all-errors -o "$TMP/ollama.tar.zst" "https://github.com/ollama/ollama/releases/download/${OLLAMA_VERSION}/ollama-linux-${ARCH}.tar.zst"
echo "${OLLAMA_SHA}  $TMP/ollama.tar.zst" | sha256sum -c - >/dev/null
zstd -dc "$TMP/ollama.tar.zst" | tar -C "$OUT/ollama" -xf - --exclude='lib/ollama/cuda*' --exclude='lib/ollama/vulkan*' --exclude='lib/ollama/*jetpack*' --exclude='lib/ollama/rocm*'
rm -f "$TMP/ollama.tar.zst"
test -x "$OUT/ollama/bin/ollama"
# 展開が途中で欠けていないこと・GPU の部品の dir が残っていないこと（sh には pipefail が無いので後から確かめる）
test -f "$OUT/ollama/lib/ollama/libggml-base.so"
ls "$OUT/ollama/lib/ollama"/libggml-cpu*.so >/dev/null
if find "$OUT/ollama/lib/ollama" -mindepth 1 -type d | grep -q .; then echo "lib/ollama に dir が残っている（GPU の部品が増えた版）" >&2; exit 1; fi

# bge-m3: manifest を取り、固定した sha256 と一致するかを確かめる（registry は digest での manifest の取得を受けないので、
# 札 latest を取り、中身の sha256 で固定する。上流が札を付け替えたら、ここで止まる）。層は digest で取り sha256 を確かめる
MANIFEST_SHA=7907646426070047a77226ac3e684fbbe8410524f7b4a74d02837e43f2146bab
M="$OUT/models/manifests/registry.ollama.ai/library/bge-m3/latest"
curl -fsSL --retry 3 --retry-all-errors -o "$TMP/manifest" "$REG/manifests/latest"
echo "${MANIFEST_SHA}  $TMP/manifest" | sha256sum -c - >/dev/null || { echo "bge-m3 の manifest が固定した物と違う（上流が札を付け替えた）" >&2; exit 1; }
mv "$TMP/manifest" "$M"
fetch_blob() {
  d=$1; f="$OUT/models/blobs/sha256-${d#sha256:}"
  grep -q "\"$d\"" "$M" || { echo "manifest に $d が無い" >&2; exit 1; }
  curl -fsSL --retry 3 --retry-all-errors -o "$TMP/blob" "$REG/blobs/$d"
  echo "${d#sha256:}  $TMP/blob" | sha256sum -c - >/dev/null
  mv "$TMP/blob" "$f"   # 確かめた物だけを置き場に入れる
}
fetch_blob "$MODEL_CONFIG"; fetch_blob "$MODEL_BLOB"; fetch_blob "$MODEL_LICENSE"
# 許諾の文: 配布物の lib/ollama には llama.cpp などの許諾が入っているが、Ollama 本体と libomp（arm64 だけ・LLVM）の文は無い
fetch_lic() {
  curl -fsSL --retry 3 --retry-all-errors -o "$TMP/lic" "$2"
  echo "$3  $TMP/lic" | sha256sum -c - >/dev/null
  mv "$TMP/lic" "$OUT/licenses/$1"
}
fetch_lic OLLAMA_LICENSE "https://raw.githubusercontent.com/ollama/ollama/${OLLAMA_VERSION}/LICENSE" 5934ed2ce0d15154bcdb9c85203210abac0da4314af34081e36df4599f90b226
# bge-m3（BAAI・FlagEmbedding）と、元の model の XLM-RoBERTa（fairseq）の許諾（どちらも MIT・commit で固定）
fetch_lic BGE_M3_LICENSE https://raw.githubusercontent.com/FlagOpen/FlagEmbedding/897baa67c0ffddbfccf4e6776ff55310d67809d4/LICENSE 587a673933425dbc36ec61268d3b954051b2d3ef3c9b322ede357976055ffdd5
fetch_lic XLM_ROBERTA_FAIRSEQ_LICENSE https://raw.githubusercontent.com/facebookresearch/fairseq/3d262bb25690e4eb2e7d3c1309b1e9c406ca4b99/LICENSE 52412d7bc7ce4157ea628bbaacb8829e0a9cb3c58f57f99176126bc8cf2bfc85
if [ -e "$OUT/ollama/lib/ollama/libomp.so" ]; then
  fetch_lic LLVM_OPENMP_LICENSE https://raw.githubusercontent.com/llvm/llvm-project/llvmorg-19.1.7/openmp/LICENSE.TXT fdad1758a9e1f9d5a81e18879b3406772115edc92c24bfa36b70c654f325e8e4
fi
# 書き込みを外す（担当の user から model を書き換えられない）。image の段でも CI の cache の道でも同じ形になる
chmod -R a-w "$OUT/models/blobs" "$OUT/models/manifests"
# 取った物の sha256 の一覧（CI の cache から戻した時に照らす）
(cd "$OUT" && find ollama licenses models -type f | LC_ALL=C sort | xargs sha256sum) > "$OUT/SHA256SUMS"
du -sh "$OUT/ollama" "$OUT/models"
