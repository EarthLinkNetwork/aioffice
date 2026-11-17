# AI オフィスの公開の package（仕様 docs/design/2026-11-15-public-package.md）
# build: repo の直下で `docker build -f packages/aioffice/Dockerfile -t aioffice:dev .`
# 起動の正式の行は packages/aioffice/RUN.txt にだけ書く
# 版は全部固定する（base image は digest・本体と Codex は runtime/package-lock.json）。版上げは package の版上げとして CI を通す
ARG NODE_IMAGE=node:24-bookworm@sha256:9d266751ca3d7fdbe651c878ffd5ad0a42fed49a18c283509267c97f025b7496

# ---- 段 1（配らない）: 本体と Codex を入れ、独自の許諾の部品を stub に替え、許諾の一覧を作る ----
# 本物の @cursor/sdk・@anthropic-ai/claude-agent-sdk はこの段の層にだけ入り、最後の image の層には入らない
FROM ${NODE_IMAGE} AS runtime
COPY packages/aioffice/runtime/package.json packages/aioffice/runtime/package-lock.json /opt/aioffice/runtime/
# npm ci は使えない（本体の中で入れ子の esbuild の optional が lock に載らない npm の崩れで、ci が「lock と合わない」と止まる）。
# lock を読む npm install で入れ、本体と Codex の版が lock どおりかを確かめる
RUN cd /opt/aioffice/runtime && npm install --omit=dev --no-fund --no-audit \
 && node -e "const l=require('./package-lock.json').packages;for(const n of ['paperclipai','@openai/codex','@paperclipai/server']){const got=require('./node_modules/'+n+'/package.json').version,want=l['node_modules/'+n].version;if(got!==want){console.error(n,got,'!=',want);process.exit(1)}}"
# 独自の許諾（All rights reserved）で配れない部品は stub に替える（runtime/stubs/README.md）。本体が import する名前が stub に全部あるかもここで確かめる
COPY packages/aioffice/runtime/stubs /opt/aioffice/runtime/stubs
COPY packages/aioffice/runtime/notices.mjs /opt/aioffice/runtime/notices.mjs
# 本体の不具合の直し（runtime/fixes/apply.mjs の頭の説明）。当てる所が見つからなければ build を落とす
COPY packages/aioffice/runtime/fixes /opt/aioffice/runtime/fixes
RUN node /opt/aioffice/runtime/fixes/apply.mjs /opt/aioffice/runtime/node_modules \
 && node /opt/aioffice/runtime/stubs/apply.mjs /opt/aioffice/runtime/node_modules \
 && node /opt/aioffice/runtime/notices.mjs /opt/aioffice/runtime/node_modules /opt/aioffice/THIRD_PARTY_NOTICES.txt

# ---- plugin の段（配らない）: plugins の下の許した plugin（office・design・notify・library・secretary・relay）を build し、中身の hash（BUILD_ID）と key を書く ----
# 起動の時に BUILD_ID が前と違えば plugin を upgrade する（packages/aioffice/launcher/lib/plugins.mjs）
FROM ${NODE_IMAGE} AS plugins
WORKDIR /src
COPY package.json package-lock.json /src/
RUN npm ci --no-fund --no-audit --ignore-scripts
COPY plugins/build.mjs /src/plugins/build.mjs
COPY plugins/office /src/plugins/office
COPY plugins/design /src/plugins/design
COPY plugins/notify /src/plugins/notify
COPY plugins/library /src/plugins/library
# 秘書の気づき（範囲 docs/review/2026-11-21-secretary-awareness-scope.md）
COPY plugins/secretary /src/plugins/secretary
# 回覧（office の間の質問と多段の承認・docs/design/2026-11-21-office-relay.md）
COPY plugins/relay /src/plugins/relay
# 図書室の部屋のフォルダ選びは wizard と同じ純粋な関数の file を取り込む（写さない・フォルダの欄の範囲 作り方 3）
COPY packages/aioffice/launcher/public/folder-pick.js /src/packages/aioffice/launcher/public/folder-pick.js
# 知らせの plugin の Slack の宛先の形の確かめは、起動係と同じ関数の file を取り込む（範囲 docs/review/2026-11-18-slack-notify-scope.md S3）
COPY packages/aioffice/launcher/lib/slack-url.mjs /src/packages/aioffice/launcher/lib/slack-url.mjs
# メールの文の形（件名の辞書・アドレスの形・見本の hash）も同じ file を取り込む（範囲 docs/review/2026-11-19-mail-notify-scope.md）
COPY packages/aioffice/launcher/lib/mail-core.mjs /src/packages/aioffice/launcher/lib/mail-core.mjs
RUN set -e; for p in office design notify library secretary relay; do \
      node plugins/build.mjs "$p"; \
      mkdir -p "/opt/aioffice/plugins/$p"; \
      cp -R "plugins/$p/dist" "plugins/$p/package.json" "/opt/aioffice/plugins/$p/"; \
      if [ -d "plugins/$p/migrations" ]; then cp -R "plugins/$p/migrations" "/opt/aioffice/plugins/$p/"; fi; \
      (cd "/opt/aioffice/plugins/$p" && find dist package.json $(test -d migrations && echo migrations) -type f | LC_ALL=C sort | xargs sha256sum | sha256sum | cut -c1-32 > BUILD_ID); \
      node --input-type=module -e "const m=(await import('/opt/aioffice/plugins/$p/dist/manifest.js')).default;process.stdout.write(JSON.stringify({key:m.id}))" > "/opt/aioffice/plugins/$p/PLUGIN_KEY"; \
    done

# ---- 埋め込みの段（配らない）: 図書室の意味の近さの検索の Ollama（CPU の部品だけ）と bge-m3 を、版と sha256 を固定して取る ----
# 範囲: 開発元の記録 docs/review/2026-11-17-library-embedding-scope.md（作り方 1・2）
FROM ${NODE_IMAGE} AS embed
ARG TARGETARCH
RUN apt-get update && apt-get install -y --no-install-recommends zstd && rm -rf /var/lib/apt/lists/*
COPY packages/aioffice/embed/fetch-embed.sh /opt/embed-src/fetch-embed.sh
RUN sh /opt/embed-src/fetch-embed.sh "${TARGETARCH}" /opt/embed
# 書き込みを外す mode は fetch-embed.sh が付ける（COPY は mode を運ぶ。最後の段で chmod -R すると model の 1.1GB が層に写り直る）

# ---- 段 2（配る image）: stub に替えた後の node_modules だけを写す ----
FROM ${NODE_IMAGE}
RUN apt-get update \
 && apt-get install -y --no-install-recommends tini \
 && rm -rf /var/lib/apt/lists/*
# 本体と Codex は image に焼き込む（起動の時に網へ取りに行かない）
COPY --from=runtime /opt/aioffice/runtime/node_modules /opt/aioffice/runtime/node_modules
COPY --from=runtime /opt/aioffice/runtime/package.json /opt/aioffice/runtime/package-lock.json /opt/aioffice/runtime/
COPY --from=runtime /opt/aioffice/THIRD_PARTY_NOTICES.txt /opt/aioffice/THIRD_PARTY_NOTICES.txt
ENV PATH=/opt/aioffice/runtime/node_modules/.bin:$PATH

COPY packages/aioffice/launcher /opt/aioffice/launcher
# wizard の AI の表に無い adapter の型が Paperclip の更新で増えたら、ここで build を落とす（範囲: docs/review/2026-11-17-wizard-ai-choice-scope.md の作り方 7）
RUN node /opt/aioffice/launcher/lib/check-adapters.mjs
COPY packages/aioffice/templates /opt/aioffice/templates
COPY packages/aioffice/bin /opt/aioffice/bin
COPY packages/aioffice/RUN.txt /opt/aioffice/RUN.txt
# office と design の plugin（起動の時に本体へ入れる・網には取りに行かない）
COPY --from=plugins /opt/aioffice/plugins /opt/aioffice/plugins
# 図書室の意味の近さの検索（Ollama は loopback だけで起こす・launcher/lib/ollama.mjs）。許諾の文は THIRD_PARTY_NOTICES.txt の末尾に足す
COPY --from=embed /opt/embed/ollama /opt/aioffice/ollama
# model の置き場は root の物で読み取りだけ（担当の user から /api/delete・/api/pull で書き換えられない・独立レビュー P2-4）。
# Ollama が起動の時に作る manifests-v2 と metadata の dir だけを node の物にする（blobs と manifests には書かない・実測）
COPY --from=embed /opt/embed/models /opt/aioffice/models
COPY --from=embed /opt/embed/licenses /opt/aioffice/ollama/licenses
RUN set -e; mkdir -p /opt/aioffice/models/manifests-v2 /opt/aioffice/models/metadata; \
    chown node:node /opt/aioffice/models/manifests-v2 /opt/aioffice/models/metadata; \
    N=/opt/aioffice/THIRD_PARTY_NOTICES.txt; \
    for f in /opt/aioffice/ollama/licenses/* /opt/aioffice/ollama/lib/ollama/*_LICENSE; do printf '\n\n==== %s ====\n' "$(basename "$f")" >> "$N"; cat "$f" >> "$N"; done; \
    printf '\n\n==== bge-m3 model license as published with the model on registry.ollama.ai ====\n' >> "$N"; cat /opt/aioffice/models/blobs/sha256-a406579cd136771c705c521db86ca7d60a6f3de7c9b5460e6193a2df27861bde >> "$N"; \
    printf '\n\n==== libgomp (GCC runtime, GPL-3.0 with GCC Runtime Library Exception) ====\n' >> "$N"; cat /usr/share/doc/libgomp1/copyright >> "$N"
RUN chmod 0755 /opt/aioffice/bin/*.mjs \
 && ln -s /opt/aioffice/bin/aioffice-reset-owner.mjs /usr/local/bin/aioffice-reset-owner \
 && mkdir -p /data && chown node:node /data

# 本体は root では組み込みの PostgreSQL が起動しない（段 1 の実測 2）。名前つきの volume は初回にこの持ち主を引き継ぐ
USER node
ENV HOME=/home/node
VOLUME /data
EXPOSE 3100
STOPSIGNAL SIGTERM
HEALTHCHECK --interval=30s --timeout=5s --start-period=120s CMD node -e "fetch('http://127.0.0.1:3100/setup/api/state',{headers:{host:'localhost:3100'}}).then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"
ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["node", "/opt/aioffice/bin/aioffice-start.mjs"]
