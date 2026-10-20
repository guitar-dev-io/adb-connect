# ADB Connect — Wireless Android Debugging

This repository implements ADB Connect, an open-source extension to simplify Android
wireless debugging in VS Code and compatible VS Code-based IDEs.

Goals
- Provide a shared core ADB engine exposing a stable, tested interface.
- Provide a native VS Code integration (works in Kiro, Cursor, Windsurf and other
  VS Code-based IDEs).
- Implement QR pairing, six-digit pairing, discovery, connect/disconnect, and smart
  auto-reconnect while respecting user consent.

What works today
- `packages/core`: TypeScript ADB engine (library + JSON CLI) — device listing, QR and
  six-digit code pairing, connect/disconnect, mDNS discovery, smart reconnect policy,
  multi-device tracking, input validation
- `extensions/vscode`: status bar, quick actions, device manager webview, QR + pairing
  code flows, discovery, auto-reconnect to remembered endpoints, settings

Supported IDEs
- Visual Studio Code
- Kiro, Cursor, Windsurf and other VS Code-based IDEs (via Open VSX or a `.vsix`)

Development workflow
1. `npm install` at the repo root (npm workspaces)
2. `npm run build` — builds core, then the extension
3. `npm test` — core parser/validation/engine tests
4. Open the repo in VS Code and run the extension in an Extension Development Host
   (extension path `extensions/vscode`)

Packaging
- `npm run -w extensions/vscode package` — produces `dist/adb-connect-vscode-<version>.vsix`
- `npm run -w extensions/vscode package:ovsx` — packages and prints the Open VSX publish command

See `packages/core/README.md` and `extensions/vscode/README.md` for more details, and
`extensions/vscode/docs/` for installation and validation guides.
