# ADB Connect — Cross-IDE Wireless Debugging

This repository implements ADB Connect, an open-source cross-IDE extension to simplify Android wireless debugging.

Goals
- Provide a shared core ADB engine exposing a stable, tested interface.
- Provide IDE integrations for VS Code (and compatibles) and JetBrains platforms.
- Implement QR pairing, six-digit pairing, discovery, connect/disconnect, and smart auto-reconnect while respecting user consent.

This initial commit scaffolds the monorepo and implements a minimal working core CLI that:
- Detects the adb executable on PATH
- Reports adb version
- Lists connected devices (via `adb devices -l`)

It also includes a minimal VS Code extension skeleton that shows a status bar item and calls the core CLI.

Development workflow
1. Install dependencies at repo root (npm 8+ or pnpm):
   - npm install
   - npm run -w packages/core build
   - npm run -w extensions/vscode build
2. In development, build core and the extension and run the extension in the Extension Development Host from VS Code.

Next steps
- Implement discovery of _adb-tls-pairing._tcp and _adb-tls-connect._tcp
- Implement secure QR pairing and six-digit pairing flows
- Add JetBrains plugin skeleton and IPC strategy between TypeScript and Kotlin
- Add tests and CI workflows

See packages/core/README.md and extensions/vscode/README.md for more details.


## Phases
Phase 1: Completed — repository scaffold and basic core CLI + VS Code extension skeleton.
Phase 2+: Implementing features incrementally (I'll proceed with Phase 2 next unless you want a different priority).
