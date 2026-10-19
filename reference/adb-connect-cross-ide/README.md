# ADB Connect — Cross-IDE (Developer Preview)

A minimal, offline-first Android ADB wireless debugging developer plugin. Works against locally installed Android `adb` executable.

## What is included

- `extensions/vscode`: **functional developer-preview extension** for VS Code and compatible derivative IDEs (Cursor, Windsurf, Kiro, etc. subject to IDE/version compatibility), status bar, simple device webview, code pairing, discovery, connect/reconnect/disconnect.
- `extensions/jetbrains`: **early plugin scaffold** with a working-source action to list ADB devices; not built or tested yet. Not full feature parity.
- `docs`: usage, constraints and next-stage implementation requirements.
- `ui-reference.png`: visual UI concept only, not a verified screenshot of implemented software.

## Requirements

1. Android 11 or newer for Wireless Debugging pairing.
2. Android SDK Platform Tools `adb` on PATH (or configure `adbConnect.adbPath`).
3. Phone and development computer on compatible network, Wireless debugging enabled.

## VS Code: run locally

1. Open `extensions/vscode` in VS Code.
2. Press F5 to launch Extension Development Host (with VS Code JS Debugger installed).
3. Click `ADB: Disconnected` in the status bar or run `ADB Connect: Quick Actions`.
4. On Android: Settings > Developer options > Wireless debugging > Pair device with pairing code.
5. Enter the pairing endpoint and six-digit code. Then use Discover Devices or enter the separate **connect** address from Wireless Debugging.

## Build / publish

```
cd extensions/vscode
npm test
npm run lint
npm run package
```

Update package.json publisher placeholder, add actual icon and Marketplace artwork/metadata, test real devices, and conduct security/privacy review before publish.

## Important limitations

Native QR pairing is **not implemented**. Proper QR requires a pairing server and `_adb-tls-pairing._tcp` mDNS advertisement (and more than encoding an IP address in a QR). UI provides a truthful fallback to pairing code. Android QR screenshot illustration is reference only.

Cross-IDE support means **separate builds**. VS Code-compatible hosts may load VSIX (test per host). JetBrains IDEs require a distinct IntelliJ Platform plugin.

No real Android device, VS Code GUI extension host, or JetBrains build was available in this packaging environment. Test results cover Node parser/validation only.

No telemetry, online backend, user account, or device data upload is implemented.
