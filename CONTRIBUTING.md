# Contributing to Aster

The root project is the desktop browser for macOS and Windows. `mobile/` is a separate npm project with its own dependency lockfile.

| Directory | Responsibility |
| --- | --- |
| `src/main/` | Window, page views, navigation, protection, storage, media, and local control |
| `src/renderer/` | Browser toolbar, sidebar, settings, New Tab, and Mission Control |
| `src/shared/` | Session model and shared navigation logic |
| `native/` | Optional AppKit modules |
| `bin/` | Terminal and MCP adapters |
| `mobile/src/` | Mobile interface, native web views, and saved tabs |

Use Node.js 24 LTS. The [setup commands](README.md#run-from-source) download Electron and compile the filter snapshot. On macOS, use a macOS 26 or newer SDK for native glass. Both AppKit modules use Node-API headers from your installed Node distribution. Set `ASTER_NODE_HEADERS` to its `include/node` directory if the build scripts cannot locate it.

```sh
npm test
npm run build:media-preload
```

| Build | Commands |
| --- | --- |
| Apple silicon DMG | On Apple silicon, run `npm run build:glass`, `npm run build:gesture-phases`, and `npm run dist:mac -- --arm64`. |
| Intel DMG | On an Intel Mac, run `npm run build:glass`, `npm run build:gesture-phases`, and `npm run dist:mac -- --x64`. |
| Windows x64 installer | On Windows, run `npm run dist:win`. |

Installers are written to `dist/`. The desktop release workflow installs each package on its native runner, exercises browser navigation and video playback, and publishes a preview with SHA-256 checksums after all builds pass.

The tests under `test/` cover browser state, media, navigation, suggestions, and local HTTP behavior. For changes that touch native views, run the matching `test:*` script in `package.json` on macOS. The packaged checks use a separate browser profile. Set `ASTER_AUTOMATION=1` for browser checks that exercise the local control interface, including `test:integration`, `test:agents`, and `test:agent-zoom`.

Keep a change focused on one behavior and describe the scenario you checked. Include the affected platform and steps for reproducing browser bugs. Use a fresh profile when recording a bug demo, especially when it contains browser history, tabs, or account details.
