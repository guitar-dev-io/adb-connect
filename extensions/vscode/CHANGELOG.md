# Changelog

All notable changes to the ADB Connect VS Code extension are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this
project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.2.0]

### Added

- **ADB engine** (`@adb-connect/core`): adb detection and version validation, device
  listing, event-driven discovery, connect/disconnect, and structured logging with
  secrets redacted.
- **Real QR pairing**: a valid Android Wireless Debugging pairing QR (not an arbitrary
  payload) with pairing state, result, Cancel/Retry, and help instructions.
- **Six-digit code pairing**: pair with the code shown under Android's Wireless debugging
  settings.
- **mDNS discovery**: discover devices advertising `_adb-tls-pairing._tcp` and
  `_adb-tls-connect._tcp` via the adb server; lease-gated polling, no runaway adb
  processes.
- **Device Manager** webview: device name, serial, IP:port, connection status, pairing
  status, and transport type, with per-device connection management and copyable adb
  commands.
- **Smart auto-reconnect**: reconnect only remembered/approved devices, a single in-flight
  attempt per device, bounded retries with backoff, respect for user disconnects, and no
  reconnection when auto-reconnect is disabled.
- **Multi-device support**: manage several devices at once and choose a preferred active
  device for the status bar.
- **Status bar**: active device and connection state (Disconnected, Searching,
  Reconnecting, device name, or connected count), with a quick-actions menu.
- **Settings**: `adbPath`, `autoDiscover`, `autoReconnect`, `reconnectOnStartup`,
  `showStatusBar`, `preferredDevice`, `debugLogging`.

### Packaging

- VS Code Marketplace packaging (`.vsix`) and Open VSX compatibility for Kiro, Cursor,
  Windsurf, and other VS Code-based IDEs (`npm run -w extensions/vscode package` and the
  `package:ovsx` script).

[0.2.0]: https://github.com/guitar-dev-io/adb-connect/releases/tag/v0.2.0
