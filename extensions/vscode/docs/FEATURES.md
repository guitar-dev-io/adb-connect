# Features

ADB Connect pairs and connects Android devices over Wi-Fi with minimal interaction, so you
rarely need to run `adb` by hand. All adb work goes through the shared
`@adb-connect/core` engine.

## Pairing and connecting

- **Pair via QR Code** — shows a valid Android Wireless Debugging pairing QR (not an
  arbitrary payload). Scan it from Developer options › Wireless debugging › Pair device
  with QR code on an Android 11+ device; the device pairs and then connects. The view shows
  pairing state, the connected result, and Cancel / Retry, with a fallback to six-digit
  code pairing.
- **Pair via Pairing Code** — enter the host:port and the six-digit code shown under
  Wireless debugging. Pairing codes are never logged or stored.
- **Connect Device** — connect directly by `IP:port`.

## Discovery

- **mDNS discovery** of devices advertising `_adb-tls-pairing._tcp` and
  `_adb-tls-connect._tcp`, through the adb server. Discovery is lease-gated so adb is not
  launched in a tight loop. Toggle with `adbConnect.autoDiscover`.

## Device management

- **Device Manager** webview lists each device's name, serial, IP:port, connection status,
  pairing status, and transport type, with one-click connect/disconnect per device.
- **Copyable adb commands** for developers who need advanced control.
- **Multi-device support** — manage several devices at once and pick a **preferred** device
  for the status bar. ADB Connect does not change other tools' device selection.

## Smart auto-reconnect

- Reconnects **only remembered/approved** devices — never unknown or arbitrary ones.
- One in-flight attempt per device; bounded retries with backoff and a gave-up signal.
- Respects manual disconnects (no auto-reconnect until you reconnect yourself).
- Honors `adbConnect.autoReconnect` and `adbConnect.reconnectOnStartup`.
- Never forcibly restarts the global adb server (other tools may be using it).

## Status bar and quick actions

- The status bar shows the active device and connection state: `ADB: Disconnected`,
  `ADB: Searching...`, `ADB: Reconnecting...`, `ADB: Pixel 9 Pro`, or
  `ADB: 2 Devices Connected`.
- Clicking it opens Quick Actions: Connect, Reconnect, Disconnect, Pair via QR Code, Pair
  via Pairing Code, Discover Devices, Manage Devices, Settings, View Logs.

## Privacy and security

- No telemetry.
- No pairing without an explicit user action.
- Pairing secrets are never logged or persisted; adb keeps pairing keys in `~/.android`.
- The webview uses a strict CSP with a per-render nonce and no inline handlers.

See also: [INSTALL.md](./INSTALL.md), [TROUBLESHOOTING.md](./TROUBLESHOOTING.md),
[VALIDATION.md](./VALIDATION.md).
