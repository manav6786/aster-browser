# Aster for iOS and Android

The mobile preview provides an animated New Tab page, HTTPS navigation, Google search on submit, Back and Forward, tab overview, and up to eight saved tabs. It stores tab addresses and selection locally. Each restored tab loads when selected, with a fresh native history stack.

From this directory, use Node.js 24 LTS to run the preview and build both platform bundles.

```sh
npm ci
npm run check
npm test
npm run export
npm start
```

`npm start` serves the project to an SDK-compatible Expo client. `npm run ios` builds with Xcode and `npm run android` builds with Android Studio’s SDK and emulator tooling. The dependency versions follow [Expo SDK 58](https://docs.expo.dev/versions/latest/).

| Platform | Web engine | Preview target |
| --- | --- | --- |
| iOS | System WebKit (`WKWebView`) | iOS 16.4+, Xcode 26.4+ |
| Android | System Android WebView | Android 7+, target API 36 |

The desktop blocker, VPN controls, and local automation are desktop features. Mobile development builds need device testing before store submission. A store release needs signed builds, developer accounts, privacy disclosures, and platform review. The identifiers in `app.json` are intended for development configuration. See [Apple’s review guidelines](https://developer.apple.com/app-store/review/guidelines/#software-requirements) and [Google Play’s target API requirements](https://developer.android.com/google/play/requirements/target-sdk).
