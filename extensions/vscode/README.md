# ADB Connect - VS Code extension

TypeScript extension for VS Code and compatible hosts. All adb work goes through `@adb-connect/core` (`packages/core`).

**Working:** adb detection, status bar, device manager webview, pair with Android's 6-digit pairing code, IP:Port connect, mDNS discovery, auto-reconnect to remembered endpoints, disconnect.

**Not yet implemented:** native QR pairing. "Pair via QR" shows a guide and falls back to code pairing; it never shows a fake QR.

**Settings:** `adbConnect.adbPath`, `adbConnect.autoReconnect`, `adbConnect.showStatusBar`, `adbConnect.refreshIntervalSeconds`, `adbConnect.knownEndpoints` (endpoints are added after a successful connect and removed when you disconnect manually).

**Security:** No pairing without user action. Pairing codes are never logged or persisted. Webview uses a per-render CSP nonce and only accepts known actions.

## Develop

From the repo root: `npm install && npm run build`, then open the repo in VS Code and launch an Extension Development Host with `extensions/vscode` as the extension path.

Packaging note: the extension imports `@adb-connect/core` through the npm workspace link. Before `vsce package`, add a bundler (e.g. esbuild) so core is included in the VSIX.
