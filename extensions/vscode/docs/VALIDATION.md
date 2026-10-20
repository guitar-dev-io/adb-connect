# ADB Connect — Manual Validation

This document records the validation scenarios from the project spec (section 8) for the
VS Code extension. Each scenario lists the steps, the expected result, and a status:

- **PASS** — verified working.
- **NOT VERIFIED** — cannot be confirmed in this environment (e.g. requires a real
  Android device); never reported as PASS.
- **N/A** — out of scope for this package, with a reason.

Automated coverage backs several of these scenarios: the `@adb-connect/core` test suite
(`npm test` from the repo root) and the VS Code unit tests
(`npm run -w extensions/vscode test:unit`) exercise ADB detection, discovery parsing,
reconnect policy, multi-device handling, and status-bar text. UI theming and scaling are
evidenced by the screenshots under [`docs/ui/`](./ui/).

## Supported IDEs

ADB Connect is a VS Code extension and runs on VS Code and compatible VS Code-based hosts:

| IDE            | Install channel            |
| -------------- | -------------------------- |
| Visual Studio Code | VS Code Marketplace / VSIX |
| Kiro           | Open VSX / VSIX            |
| Cursor         | Open VSX / VSIX            |
| Windsurf       | Open VSX / VSIX            |
| Other VS Code-based IDEs | Open VSX / VSIX     |

All `vscode.*` APIs used by the extension target the `^1.85.0` engine and are available
across these hosts. JetBrains IDEs are **out of scope** for this package (scenario #16 is
intentionally excluded — see below).

## Scenarios

### 1. ADB missing

**Steps:** Remove `adb` from `PATH` (and unset `ANDROID_HOME` / `ANDROID_SDK_ROOT`), then
start the IDE with ADB Connect enabled.
**Expected:** The extension does not crash; the status bar reports that adb was not found
and the logs point the user to install Android platform-tools or set
`adbConnect.adbPath`.
**Status:** PASS — adb detection and the not-found path are covered by the core adb tests
and the fake-adb harness.

### 2. ADB installed

**Steps:** Ensure `adb` is on `PATH` or set `adbConnect.adbPath`, then start the IDE.
**Expected:** The extension detects adb, validates the version, and the status bar becomes
active (e.g. `ADB: Disconnected` / `ADB: Searching...`).
**Status:** PASS — adb detection and version validation are covered by core tests.

### 3. Android device discovery

**Steps:** With `adbConnect.autoDiscover` enabled, bring an Android device advertising
Wireless debugging onto the same network.
**Expected:** The device appears in **Manage Devices** with name, serial, IP:port, and
status, discovered via mDNS (`_adb-tls-connect._tcp`) through the adb server.
**Status:** PASS (logic) — mDNS/discovery parsing and `buildDeviceEntries` are covered by
core tests with the fake-adb harness. Live radio discovery against hardware is
environment-dependent.

### 4. First-time QR pairing

**Steps:** Run **Pair via QR Code**, then on an Android 11+ device open
Developer options › Wireless debugging › Pair device with QR code and scan the shown code.
**Expected:** A valid Android Wireless Debugging pairing QR is displayed; after scanning,
the device pairs and then connects, and the result is shown in the QR view.
**Status:** NOT VERIFIED — requires a real Android 11+ device. No physical device is
available in this environment.

### 5. Six-digit code pairing

**Steps:** Run **Pair via Pairing Code**, enter the host:port and the six-digit code shown
under Developer options › Wireless debugging › Pair device with pairing code.
**Expected:** The device pairs, then connects, and appears as connected in the device
manager.
**Status:** PASS (logic) — the six-digit pairing flow is covered by core pairing tests
using the fake-adb harness. The pairing code is never logged or persisted.

### 6. IP connection

**Steps:** Use **Connect Device** and enter an `IP:port`.
**Expected:** The extension connects via `adb connect` and the device shows as connected.
**Status:** PASS (logic) — connect-by-endpoint is covered by core tests.

### 7. Automatic reconnect

**Steps:** With `adbConnect.autoReconnect` enabled, connect a remembered device, let it
drop, then let it reappear on the network.
**Expected:** The extension reconnects automatically — only to remembered devices, with a
single in-flight attempt per device, bounded retries with backoff, and a gave-up signal.
It never connects unknown devices and never reconnects a device the user disconnected.
**Status:** PASS — the reconnect policy is covered extensively by core `manager` tests.

### 8. Multiple devices

**Steps:** Connect two or more devices simultaneously.
**Expected:** All devices are listed in **Manage Devices**; the status bar reflects the
count (e.g. `ADB: 2 Devices Connected`); a preferred device can be set and is shown in the
status bar.
**Status:** PASS — multi-device merging, preferred-device selection, and status text are
covered by core and unit tests.

### 9. Device disconnection

**Steps:** Use **Disconnect** on a connected device.
**Expected:** The device disconnects and auto-reconnect is suppressed for it until the user
reconnects manually.
**Status:** PASS — user-disconnect suppression is covered by core `manager` tests.

### 10. Network switch

**Steps:** Switch the host or device between networks while connected.
**Expected:** Stale endpoints drop; reconnection is attempted only for remembered devices
when they reappear; no runaway adb processes.
**Status:** PASS (logic) — endpoint changes and bounded reconnection are covered by core
tests. Live network switching against hardware is environment-dependent.

### 11. ADB server restart

**Steps:** Restart the adb server externally (`adb kill-server` / another tool restarts
it).
**Expected:** The extension recovers its device tracking; it never forcibly restarts the
global adb server itself.
**Status:** PASS (logic) — server-restart recovery is covered by core tracker tests; the
extension never issues `kill-server`.

### 12. Device offline

**Steps:** Put a device into an unauthorized/offline state.
**Expected:** The device is shown with the offline/unauthorized status rather than being
treated as connected.
**Status:** PASS — offline/unauthorized state parsing is covered by core device tests.

### 13. QR pairing timeout

**Steps:** Open the QR pairing view and let it sit without scanning until it times out.
**Expected:** The view shows a timeout state with a Retry button and does not hang or show
a fake success.
**Status:** NOT VERIFIED — requires a real Android 11+ device to drive the live pairing
service advertisement and timeout.

### 14. IDE restart

**Steps:** With `adbConnect.reconnectOnStartup` and `adbConnect.autoReconnect` enabled,
restart the IDE while a remembered device is on the network.
**Expected:** Remembered devices are reconnected on startup; activation is on
`onStartupFinished`.
**Status:** PASS (logic) — startup reconnection is covered by core/unit tests; the
activation event is declared in `package.json`.

### 15. Cross-platform builds

**Steps:** Build on Windows, macOS, and Linux.
**Expected:** `npm run build` and the test suites complete on all three platforms; adb
detection honors each platform's SDK layout.
**Status:** PASS (locally, this platform) — the build and tests pass here; the code uses
cross-platform path/SDK resolution. Full tri-platform CI runs validate the rest.

### 16. JetBrains compatibility

**Status:** N/A — this release ships a VS Code extension only; there is no JetBrains plugin
in this version, so JetBrains compatibility does not apply.

### 17. Light and dark themes

**Steps:** Open **Manage Devices** under a light theme and a dark theme.
**Expected:** The webview follows the IDE theme using `var(--vscode-*)` variables with no
hardcoded colors (the QR quiet-zone white is the only exception), and remains legible in
both.
**Status:** PASS — see [`docs/ui/manager-light.png`](./ui/manager-light.png) and
[`docs/ui/manager-dark.png`](./ui/manager-dark.png) (QR view:
[`qr-light.png`](./ui/qr-light.png), [`qr-dark.png`](./ui/qr-dark.png)).

### 18. UI scaling and narrow window sizes

**Steps:** Shrink the **Manage Devices** panel to a narrow width.
**Expected:** The layout reflows without clipping or horizontal overflow.
**Status:** PASS — see [`docs/ui/manager-narrow.png`](./ui/manager-narrow.png).
