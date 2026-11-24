#!/usr/bin/env bash
#
# ios-sim-launch-check.sh — 今の ios/（prebuild 済み・pod install 済み）を Release でシミュレーター向けに作り、
# iOS <major> のシミュレーターで起動して、LAUNCH_WATCH 秒（既定 12）落ちないことを確かめる。
# 1.0.0 build 1 は iOS 27 で起動直後に落ちた（scene の仕組みを使っていない・plugins/with-scene-lifecycle.js）。
# 手元のシミュレーターが古い iOS だと見つからないので、提出の前にこの段で止める。
#
# 使い方: bash scripts/ios-sim-launch-check.sh            （ios/ が無ければ prebuild から）
# 環境変数: SIM_IOS_MAJOR（既定 27）・LAUNCH_WATCH（既定 12）・XCODE_JOBS（既定 6）
# 結果: 成功で exit 0。スクリーンショットを ${OUT_DIR}（既定 一時の場所）に残し、path を出す。
# シミュレーターは専用の「AIOffice iPhone 17 iOS <major>」だけを使う（ほかの project の機器に触らない）。
set -euo pipefail
cd "$(dirname "$0")/.."            # → apps/mobile
export PATH="/opt/homebrew/bin:$PATH"

MAJOR="${SIM_IOS_MAJOR:-27}"
WATCH="${LAUNCH_WATCH:-12}"
SIM_NAME="AIOffice iPhone 17 iOS $MAJOR"
OUT_DIR="${OUT_DIR:-$(mktemp -d)}"
mkdir -p "$OUT_DIR"
DD="$OUT_DIR/dd"
BUNDLE_ID="$(node -p "require('./app.json').expo.ios.bundleIdentifier")"

if [ ! -d ios ] || ! ls -d ios/*.xcworkspace >/dev/null 2>&1; then
  echo "### ios/ が無い → prebuild ###"
  CI=1 npx expo prebuild -p ios --clean
fi
SCHEME="$(basename "$(ls -d ios/*.xcworkspace | head -1)" .xcworkspace)"

UDID="$(xcrun simctl list devices | grep -F "    $SIM_NAME (" | grep -oE '[0-9A-F-]{36}' | head -1 || true)"
if [ -z "$UDID" ]; then
  RT="$(xcrun simctl list runtimes | grep -oE "com\.apple\.CoreSimulator\.SimRuntime\.iOS-${MAJOR}-[0-9-]+" | head -1 || true)"
  [ -n "$RT" ] || { echo "iOS $MAJOR のシミュレーターの runtime が無い（Xcode の Settings > Components で入れる）"; exit 2; }
  UDID="$(xcrun simctl create "$SIM_NAME" com.apple.CoreSimulator.SimDeviceType.iPhone-17 "$RT")"
fi
echo "simulator: $SIM_NAME ($UDID)"

echo "### Release をシミュレーター向けに作る ###"
xcodebuild -workspace "ios/$SCHEME.xcworkspace" -scheme "$SCHEME" -configuration Release \
  -sdk iphonesimulator -destination "id=$UDID" -derivedDataPath "$DD" -jobs "${XCODE_JOBS:-6}" \
  build > "$OUT_DIR/build.log" 2>&1 || { tail -40 "$OUT_DIR/build.log"; echo "シミュレーター向けの build に失敗: $OUT_DIR/build.log"; exit 1; }
APP="$(ls -d "$DD/Build/Products/Release-iphonesimulator/"*.app | head -1)"

xcrun simctl boot "$UDID" 2>/dev/null || true
xcrun simctl bootstatus "$UDID" -b >/dev/null
xcrun simctl terminate "$UDID" "$BUNDLE_ID" 2>/dev/null || true
xcrun simctl uninstall "$UDID" "$BUNDLE_ID" 2>/dev/null || true
xcrun simctl install "$UDID" "$APP"

REPORTS="$HOME/Library/Logs/DiagnosticReports"
before="$(ls "$REPORTS" 2>/dev/null | grep -c "^$SCHEME-" || true)"
xcrun simctl launch "$UDID" "$BUNDLE_ID"
for ((i = 1; i <= WATCH; i++)); do
  sleep 1
  # grep -q は途中で読むのをやめ、pipefail で SIGPIPE が失敗に見えるので、一度 変数に取ってから調べる
  procs="$(xcrun simctl spawn "$UDID" launchctl list)"
  if ! grep -qF "UIKitApplication:${BUNDLE_ID}[" <<<"$procs"; then
    echo "失敗: 起動して ${i} 秒で終了した（iOS ${MAJOR}）"
    after="$(ls -t "$REPORTS" 2>/dev/null | grep "^$SCHEME-" | head -1 || true)"
    if [ -n "$after" ]; then
      echo "crash report: $REPORTS/$after"
      grep -oE '"exception" : \{[^}]*\}' "$REPORTS/$after" | head -1 || true
      grep -oE '"symbol":"[^"]*"' "$REPORTS/$after" | head -5 || true
    fi
    exit 1
  fi
done
now="$(ls "$REPORTS" 2>/dev/null | grep -c "^$SCHEME-" || true)"
[ "$now" = "$before" ] || { echo "失敗: 起動中に crash report が増えた"; exit 1; }

xcrun simctl io "$UDID" screenshot "$OUT_DIR/launch.png" >/dev/null
xcrun simctl terminate "$UDID" "$BUNDLE_ID" 2>/dev/null || true
xcrun simctl shutdown "$UDID" 2>/dev/null || true
echo "OK: iOS $MAJOR のシミュレーターで ${WATCH} 秒落ちなかった。screenshot: $OUT_DIR/launch.png"
