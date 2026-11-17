// with-scene-lifecycle — iOS 27 は scene の仕組み（UIApplicationSceneManifest）を使っていないアプリを
// 起動時に終了させる（EXC_BREAKPOINT・_UIApplicationEvaluateRuntimeIssueForNoSceneLifecycleAdoption）。
// 1.0.0 build 1 が iPhone で起動直後に落ちたのはこれ（iOS 27 のシミュレーターで再現）。直し方:
//   - Info.plist: window の scene を 1 つ宣言し、delegate は Expo 57 の EXExpoAppSceneDelegate
//   - AppDelegate: ExpoReactNativeFactoryProvider に準拠し、window を作らない（scene の delegate が作る）
// ios/ は prebuild で毎回作り直すので、この plugin で入れる。型が変わって当てられない時は止める（黙って抜けない）。
const { withInfoPlist, withAppDelegate } = require('expo/config-plugins');

const SCENE_MANIFEST = {
  UIApplicationSupportsMultipleScenes: false,
  UISceneConfigurations: {
    UIWindowSceneSessionRoleApplication: [
      {
        UISceneConfigurationName: 'Default',
        UISceneDelegateClassName: 'EXExpoAppSceneDelegate',
      },
    ],
  },
};

const CLASS_LINE = 'class AppDelegate: ExpoAppDelegate {';
const CLASS_LINE_NEW = 'class AppDelegate: ExpoAppDelegate, ExpoReactNativeFactoryProvider {';
const WINDOW_BLOCK =
  /#if os\(iOS\) \|\| os\(tvOS\)\n\s*window = UIWindow\(frame: UIScreen\.main\.bounds\)\n\s*factory\.startReactNative\(\n\s*withModuleName: "main",\n\s*in: window,\n\s*launchOptions: launchOptions\)\n#endif\n/;
const WINDOW_COMMENT = `    // The window is created by the scene delegate (EXExpoAppSceneDelegate, Info.plist
    // UIApplicationSceneManifest), which starts React Native into it: iOS 27 terminates an app at
    // launch unless it adopts the scene life cycle.
`;

function patchAppDelegate(src) {
  if (src.includes(CLASS_LINE_NEW)) return src; // 当て済み
  if (!src.includes(CLASS_LINE) || !WINDOW_BLOCK.test(src)) {
    throw new Error(
      'with-scene-lifecycle: AppDelegate.swift の形が想定と違う（Expo の template が変わった）。plugin を見直すこと',
    );
  }
  return src.replace(CLASS_LINE, CLASS_LINE_NEW).replace(WINDOW_BLOCK, WINDOW_COMMENT);
}

const withSceneLifecycle = (config) => {
  config = withInfoPlist(config, (c) => {
    c.modResults.UIApplicationSceneManifest = SCENE_MANIFEST;
    return c;
  });
  config = withAppDelegate(config, (c) => {
    if (c.modResults.language !== 'swift') {
      throw new Error(`with-scene-lifecycle: AppDelegate が swift でない（${c.modResults.language}）`);
    }
    c.modResults.contents = patchAppDelegate(c.modResults.contents);
    return c;
  });
  return config;
};

module.exports = withSceneLifecycle;
module.exports.patchAppDelegate = patchAppDelegate;
module.exports.SCENE_MANIFEST = SCENE_MANIFEST;
