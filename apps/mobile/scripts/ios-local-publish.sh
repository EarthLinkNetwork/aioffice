#!/usr/bin/env bash
#
# ios-local-publish.sh — Expo / EAS を使わず、Xcode だけで .ipa を作って TestFlight へ出す。
# 開発元のほかのアプリの ios-local-publish.sh（2026-07-01 に実証）を写したもの。違いは:
#   - scheme は prebuild が作った ios/*.xcworkspace から読む（アプリの名前に依らない）
#   - 共有 package の symlink と Sentry の段は無い（このアプリは使っていない）
#
# 前提: Apple Silicon の Mac + Xcode・CocoaPods（brew install cocoapods）
#       App Store Connect API キー(.p8) を ~/.appstoreconnect/private_keys/AuthKey_<KEYID>.p8 に置く
# 環境変数: ASC_API_KEY_ID・ASC_API_ISSUER_ID（~/.appstoreconnect/config.env があれば補う）
#           EXPORT_PROFILE（任意・App Store 用プロファイルの名前。あれば手動の署名で書き出す）・XCODE_JOBS（既定 6）
#           APPLE_TEAM_ID（既定 6XC66ZV9WK）・MACOS_KEYCHAIN_PASSWORD（あれば keychain を開ける）
# 版: app.json の expo.version と expo.ios.buildNumber を上げてから流す。
set -euo pipefail

# --- ~/.appstoreconnect/config.env の読み込み（存在すれば）---
# 目的: "error: exportArchive No Accounts" は Xcode GUI の Apple ID セッション（アカウント token）
# 依存の自動署名が原因。ASC API キー認証に切り替えて CI/runner を人の GUI セッションから独立させる
# （恒久対策）。値は echo しない。
ASC_CONFIG_ENV="$HOME/.appstoreconnect/config.env"
if [ -f "$ASC_CONFIG_ENV" ]; then
  # 呼び出し元（CI の GitHub Actions secrets 経由等）が既に export 済みの値を優先し、
  # 未設定の項目だけ config.env で補完する（config.env が別鍵を指していても CI 側を壊さない）。
  _asc_key_id_pre="${ASC_API_KEY_ID:-}"
  _asc_issuer_id_pre="${ASC_API_ISSUER_ID:-}"
  _asc_key_p8_pre="${ASC_API_KEY_P8:-}"
  set -a
  # shellcheck source=/dev/null
  source "$ASC_CONFIG_ENV"
  set +a
  [ -n "$_asc_key_id_pre" ] && ASC_API_KEY_ID="$_asc_key_id_pre"
  [ -n "$_asc_issuer_id_pre" ] && ASC_API_ISSUER_ID="$_asc_issuer_id_pre"
  if [ -n "$_asc_key_p8_pre" ]; then
    ASC_API_KEY_P8="$_asc_key_p8_pre"
  elif [ -n "$_asc_key_id_pre" ]; then
    # 呼び出し元が ASC_API_KEY_ID を明示していた場合（CI 等）、config.env の ASC_API_KEY_P8 は
    # 別の鍵 ID を指している可能性があるため信用しない。未設定に戻し、後段の規約パス
    # （$HOME/.appstoreconnect/private_keys/AuthKey_<呼び出し元の ASC_API_KEY_ID>.p8）へ委ねる。
    ASC_API_KEY_P8=""
  fi
  unset _asc_key_id_pre _asc_issuer_id_pre _asc_key_p8_pre
fi

: "${ASC_API_KEY_ID:?ASC_API_KEY_ID を設定してください}"
: "${ASC_API_ISSUER_ID:?ASC_API_ISSUER_ID を設定してください}"
TEAM="${APPLE_TEAM_ID:-6XC66ZV9WK}"

# --- ASC API キー(.p8) のパス解決 + archive/exportArchive 用の認証引数を組み立てる ---
# ASC_API_KEY_P8 が未設定の場合は Apple 標準の配置規約（CI の「place ASC API key (.p8)」ステップも
# この規約パスに書く）にフォールバックする。
if [ -n "${ASC_API_KEY_P8:-}" ]; then
  ASC_API_KEY_P8_RESOLVED="$ASC_API_KEY_P8"
else
  ASC_API_KEY_P8_RESOLVED="$HOME/.appstoreconnect/private_keys/AuthKey_${ASC_API_KEY_ID}.p8"
fi

# 見つかった場合だけ authenticationKey* 引数を付与し、GUI Apple ID セッションから独立させる。
# 見つからない場合は従来どおり Xcode アカウントセッション依存の自動署名にフォールバックする
# （後方互換。ただし No Accounts で断続的に失敗する可能性が残る旨を warn する）。
# 注: AUTH_KEY_ARGS の展開は macOS 既定 bash（3.2, set -u 下で空配列展開が unbound 扱いになる）
#     でも安全なように "${AUTH_KEY_ARGS[@]+"${AUTH_KEY_ARGS[@]}"}" イディオムを使うこと。
AUTH_KEY_ARGS=()
if [ -f "$ASC_API_KEY_P8_RESOLVED" ]; then
  AUTH_KEY_ARGS=(-authenticationKeyPath "$ASC_API_KEY_P8_RESOLVED" -authenticationKeyID "$ASC_API_KEY_ID" -authenticationKeyIssuerID "$ASC_API_ISSUER_ID")
  echo "ASC API キー認証を使用します（Apple ID セッション非依存）: keyID=$ASC_API_KEY_ID path=$ASC_API_KEY_P8_RESOLVED"
else
  echo "警告: ASC API キー(.p8) が見つかりません ($ASC_API_KEY_P8_RESOLVED) → 従来どおり Xcode アカウントセッション依存の自動署名にフォールバックします（No Accounts で失敗する可能性あり）。"
fi

cd "$(dirname "$0")/.."            # → apps/mobile
WORK="$(mktemp -d)"
AR="$WORK/app.xcarchive"
export PATH="/opt/homebrew/bin:$PATH"

echo "### 0/5 keychain 準備（再起動後の login keychain ロック対策）###"
# runner Mac の再起動等で login keychain がロックされたまま／新規署名鍵の
# partition-list が未設定のままだと、無人 codesign が秘密鍵にアクセスできず
# 「No signing certificate "iOS Distribution" found」「No Accounts」で失敗する。
# MACOS_KEYCHAIN_PASSWORD が渡された時だけ、unlock → partition-list → search-list →
# no-timeout を毎回冪等に実行して復旧させる（未設定なら何もせず warn のみ、fail しない）。
# 注: security -p/-k はパスワードを argv 経由で受け取る仕様のため、プロセス実行中は
#     `ps` 等から argv が見える（既知の制約）。単一テナントの self-hosted runner 前提で許容する。
KEYCHAIN_PATH="$HOME/Library/Keychains/login.keychain-db"
if [ -n "${MACOS_KEYCHAIN_PASSWORD:-}" ]; then
  # パスワードをログに出さないため、この区間だけ xtrace を止める（元の状態へ復元する）
  _xtrace_was_on=0
  case "$-" in *x*) _xtrace_was_on=1 ;; esac
  set +x

  security unlock-keychain -p "$MACOS_KEYCHAIN_PASSWORD" "$KEYCHAIN_PATH"
  # 既に partition-list が設定済みでも失敗させない（冪等）
  security set-key-partition-list -S apple-tool:,apple:,codesign: -s -k "$MACOS_KEYCHAIN_PASSWORD" "$KEYCHAIN_PATH" \
    || echo "警告: set-key-partition-list に失敗しました（設定済み、または対象キーなしの可能性）"

  [ "$_xtrace_was_on" = "1" ] && set -x
  unset _xtrace_was_on

  # login keychain だけでなく System keychain も search list に含める
  # (login だけだと証明書チェーンの検証に失敗することがある)
  security list-keychains -d user -s "$KEYCHAIN_PATH" "/Library/Keychains/System.keychain"
  # keychain の自動ロック(timeout)を無効化し、長時間ビルド中の再ロックを防ぐ
  security set-keychain-settings "$KEYCHAIN_PATH"
  echo "keychain 準備完了: unlock + partition-list + search-list + no-timeout"
else
  echo "警告: MACOS_KEYCHAIN_PASSWORD 未設定 → keychain 準備をスキップします。runner の ambient 状態（既にログイン中でロック解除済み）に依存するため、再起動直後は署名に失敗する可能性があります。"
fi

echo "### 2/5 expo prebuild (ios 再生成) ###"
CI=1 npx expo prebuild -p ios --clean

echo "### 3/5 pod install ###"
( cd ios && pod install )
SCHEME="$(basename "$(ls -d ios/*.xcworkspace | head -1)" .xcworkspace)"
echo "scheme: $SCHEME"

echo "### 3.5/5 iOS 27 のシミュレーターで起動を確かめる（SKIP_SIM_LAUNCH_CHECK=1 で飛ばす）###"
# 1.0.0 build 1 は iOS 27 で起動直後に落ちた。提出の前に止める（scripts/ios-sim-launch-check.sh）。
if [ "${SKIP_SIM_LAUNCH_CHECK:-0}" != "1" ]; then
  OUT_DIR="$WORK/simcheck" bash scripts/ios-sim-launch-check.sh
else
  echo "警告: SKIP_SIM_LAUNCH_CHECK=1 → 起動の確認を飛ばす"
fi

echo "### 4/5 xcodebuild archive（自動署名。ASC API キーがあれば付与）###"
xcodebuild -workspace "ios/$SCHEME.xcworkspace" -scheme "$SCHEME" \
  -configuration Release -destination 'generic/platform=iOS' \
  -archivePath "$AR" -allowProvisioningUpdates DEVELOPMENT_TEAM="$TEAM" -jobs "${XCODE_JOBS:-6}" \
  "${AUTH_KEY_ARGS[@]+"${AUTH_KEY_ARGS[@]}"}" \
  clean archive

cat > "$WORK/ExportOptions.plist" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>method</key><string>app-store-connect</string>
<key>teamID</key><string>$TEAM</string>
<key>signingStyle</key><string>automatic</string>
<key>destination</key><string>export</string>
</dict></plist>
PLIST
# EXPORT_PROFILE があれば手動の署名で書き出す（ASC API キーに cloud 署名の権限が無い時。
# プロファイルは App Store Connect API で作り ~/Library/MobileDevice/Provisioning Profiles に入れておく）
if [ -n "${EXPORT_PROFILE:-}" ]; then
  BUNDLE_ID="$(node -p "require('./app.json').expo.ios.bundleIdentifier")"
  cat > "$WORK/ExportOptions.plist" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>method</key><string>app-store-connect</string>
<key>teamID</key><string>$TEAM</string>
<key>signingStyle</key><string>manual</string>
<key>signingCertificate</key><string>Apple Distribution</string>
<key>provisioningProfiles</key><dict><key>$BUNDLE_ID</key><string>$EXPORT_PROFILE</string></dict>
<key>destination</key><string>export</string>
</dict></plist>
PLIST
  echo "手動の署名で書き出す: profile=$EXPORT_PROFILE"
fi

echo "### 5/5 export(.ipa) → altool で TestFlight 提出 ###"
# 重要: exportArchive は SYSTEM の /usr/bin/rsync を使う必要がある。
#       Homebrew rsync 3.4.x が PATH 先頭にあると "Copy failed" で落ちるため、
#       export ステップだけ /usr/bin を先頭に固定する。
PATH="/usr/bin:$PATH" xcodebuild -exportArchive -archivePath "$AR" \
  -exportPath "$WORK/ipa" -exportOptionsPlist "$WORK/ExportOptions.plist" \
  -allowProvisioningUpdates "${AUTH_KEY_ARGS[@]+"${AUTH_KEY_ARGS[@]}"}"

IPA="$(ls "$WORK/ipa/"*.ipa | head -1)"
echo "IPA: $IPA"

xcrun altool --upload-app --file "$IPA" --type ios \
  --apiKey "$ASC_API_KEY_ID" --apiIssuer "$ASC_API_ISSUER_ID"

echo "### PUBLISHED → TestFlight (Apple 処理後に出現) ###"
echo "artifact: $IPA"
