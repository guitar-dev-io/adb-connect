# ADB Connect — Cross-IDE Wireless Debugging

This repository implements ADB Connect, an open-source cross-IDE extension to simplify Android wireless debugging.

Goals
- Provide a shared core ADB engine exposing a stable, tested interface.
- Provide IDE integrations for VS Code (and compatibles) and JetBrains platforms.
- Implement QR pairing, six-digit pairing, discovery, connect/disconnect, and smart auto-reconnect while respecting user consent.

What works today
- `packages/core`: TypeScript ADB engine (library + JSON CLI) — device listing, code pairing, connect/disconnect, mDNS discovery, input validation
- `extensions/vscode`: status bar, quick actions, device manager webview, pairing code flow, discovery, auto-reconnect to remembered endpoints, settings
- `reference/adb-connect-cross-ide`: the original JS developer-preview this code was ported from (plus the JetBrains scaffold), kept for reference

Development workflow
1. `npm install` at the repo root (npm workspaces)
2. `npm run build` — builds core, then the extension
3. `npm test` — core parser/validation tests
4. Open the repo in VS Code and run the extension in an Extension Development Host (extension path `extensions/vscode`)

Next steps
- Real QR pairing (pairing server + `_adb-tls-pairing._tcp` advertisement)
- Bundle core into the VSIX (esbuild) and publish metadata
- JetBrains plugin using the core CLI or a Kotlin port
- VS Code integration tests

See packages/core/README.md and extensions/vscode/README.md for more details.


## Phases
Phase 1: Completed — repository scaffold and basic core CLI + VS Code extension skeleton.
Phase 2: Completed — ported pairing, discovery, connect/reconnect/disconnect, device manager and settings from the reference project to TypeScript.
