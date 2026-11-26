# Third-party notices

Aster source is available under the MIT license. Dependencies and filter lists keep their upstream licenses.

- [Electron and its Chromium notices](https://github.com/electron/electron). Electron distributions include their license and accompanying Chromium notices.
- [Ghostery Adblocker](https://github.com/ghostery/adblocker/tree/c18718adc33e82a086d996d0b0f75deb3d01745a), MPL-2.0. The package lock identifies the exact dependencies, which include their respective licenses.
- [tldts](https://github.com/remusao/tldts), MIT, with upstream public suffix data terms.
- [EasyList and EasyPrivacy](https://easylist.to/pages/licence.html), [Peter Lowe’s list](https://pgl.yoyo.org/adservers/policy.php), and [uBlock Origin filters and resources](https://github.com/uBlockOrigin/uAssets), GPL-3.0 for the uBlock Origin collection. `npm run build:filters` compiles the Ghostery subscription preset locally.
- [Zen Browser](https://github.com/zen-browser/desktop/tree/d6d3fc65dea9025a05650dceeb06b49c9a1be3da), MPL-2.0, referenced for workspace behavior and session restoration. Aster implements these behaviors independently. A reference copy of its license is in `assets/licenses/`.
- AppKit is supplied by macOS. Aster uses its public APIs for visual effects and wheel phase handling.
- [Cloudflare WARP](https://developers.cloudflare.com/warp-client/legal/) is a separately installed provider.
