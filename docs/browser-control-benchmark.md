# Browser control benchmark

## Results

Measured on 26 November 2026 on an Apple A18 Pro Mac with 8 GB of memory and macOS 27.0.1. Each tested browser had three separate launches with 10 warm-ups and 60 timed samples per task in each launch. The browser order rotated between launches. All 180 timed samples per task and browser passed the effect check.

| Browser and control path | Click p50 | Click p95 | Form p50 | Form p95 |
| --- | ---: | ---: | ---: | ---: |
| Aster 0.5.0, local HTTP | 2.36 ms | 6.90 ms | 3.10 ms | 8.06 ms |
| Chrome 158.0.8127.38, raw CDP | 0.78 ms | 2.34 ms | 1.84 ms | 7.73 ms |
| Brave 158.1.100.59, raw CDP with Chromium 158.0.8127.92 | 0.78 ms | 2.54 ms | 1.77 ms | 7.39 ms |

Median form time across individual launches ranged from 2.10 to 3.73 ms for Aster, 1.75 to 1.92 ms for Chrome, and 1.48 to 2.28 ms for Brave. Safari 27.0.1 is awaiting the local automation opt-in for a timed run. Arc is included for its documented control options.

## What was timed

The fixture runs on the same machine as each browser. Each sample starts with the page visible, the control connection warm, and the form cleared. The timer starts just before the control request and stops after a fresh read verifies the page result. Browser launch, fixture loading, and resets are outside the timer.

| Task | Expected result |
| --- | --- |
| Click | The button increments the counter exactly once. |
| Form | The browser enters the supplied value, submits once, and displays that value. |

Every sample checks that the page received trusted input events. The median (p50) is the middle of the sorted times. The p95 is the time that at least 95% of the samples finish within. These are local control-path measurements for simple, ready elements. Real sites add network time, page readiness, and more complex elements.

## Control options

| Browser | Local control |
| --- | --- |
| **Aster** | Opt-in Model Context Protocol (MCP), terminal client, and authenticated loopback HTTP. Supports shared tab IDs, per-tab claims, ordered batches, background input, and in-browser activity. [Local control guide](local-automation.md) |
| Chrome | Chrome DevTools Protocol (CDP) and ChromeDriver. Chrome DevTools MCP can connect to an existing session after approval. Flag-based CDP uses a separate profile. [Remote debugging](https://developer.chrome.com/blog/remote-debugging-port) · [Existing-session access](https://developer.chrome.com/blog/chrome-devtools-mcp-debug-your-browser-session) |
| Brave | Chromium CDP with an isolated profile, verified against the installed desktop build. The tested route uses direct browser protocol commands. |
| Safari | WebDriver Classic and a local MCP interface as of Safari 27. The developer setting permits automation in a dedicated test window. [WebDriver setup](https://developer.apple.com/documentation/safari-developer-tools/macos-enabling-webdriver) · [Safari MCP](https://webkit.org/blog/18136/introducing-the-safari-mcp-server-for-web-developers/) |
| Arc | On macOS, AppleScript can query tabs and spaces and create tabs and windows. [Arc release notes](https://resources.arc.net/hc/en-us/articles/20498377604887-Arc-for-macOS-2023-Release-Notes) |

## Reproduce

Use Node.js 24 or newer and the installed macOS browser builds. The runner creates its own temporary profiles and serves the fixture on loopback. Safari uses the automation window created by the system driver. Its Developer settings require explicit opt-in.

```sh
node scripts/browser-control-benchmark.cjs aster "/Applications/Aster.app/Contents/MacOS/Aster" 60
node scripts/browser-control-benchmark.cjs chrome "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" 60
node scripts/browser-control-benchmark.cjs brave "/Applications/Brave Browser.app/Contents/MacOS/Brave Browser" 60
node scripts/browser-control-benchmark.cjs safari /usr/bin/safaridriver 60
```

Aster uses the shipped terminal client’s HTTP transport and its batch command for the form task. Chrome and Brave use persistent raw CDP with selector resolution and trusted pointer and text input. Safari uses standard WebDriver element lookup, click, and text entry. Each route verifies the result through a separate read.

The runner prints individual samples, percentiles, and browser versions. Aster’s run also tests a separate second client, a rejected write to a claimed tab, and input in a background tab.

## Inspection evidence

REA confirmed the counter changed from 0 to 1 on the same fixture in isolated Chrome and Brave scenarios. It also inspected the local control and page action modules in the shipped Aster bundle.

| Check | Evidence ID |
| --- | --- |
| Chrome fixture click | `ev_741d07d1e57fd630a59a7130a1d4ea1d3e6a3237f0727b8b1fe6802504fc7337` |
| Brave fixture click | `ev_324b9098d67f244e9ca9aeaf52b41c4a117f4b34b50502e5cb9c74c6e8e8a1be` |
| Aster bundle modules | `ev_63bb23656f9776523327b82da78e9f7e3d10a6393c4f74ea2d2462a4bc2e579e` |
