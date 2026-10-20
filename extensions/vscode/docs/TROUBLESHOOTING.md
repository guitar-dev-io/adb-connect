# Troubleshooting

Open **ADB Connect: View Logs** from the status-bar quick actions to see what the engine is
doing. Enable `adbConnect.debugLogging` to log every adb invocation (secrets redacted).

## adb not found

The extension could not locate the `adb` executable.

- Install Android **platform-tools** (31+ recommended for Wireless debugging).
- Make sure `adb` is on your `PATH`, or set `adbConnect.adbPath` to its full path.
- ADB Connect auto-detects via `ANDROID_HOME`, `ANDROID_SDK_ROOT`, `PATH`, and the default
  SDK location; set one of these if adb lives elsewhere.

## Device not discovered

- Confirm the device and this computer are on the **same network** and that the network
  allows device-to-device traffic (some guest/corporate Wi-Fi blocks it).
- Enable **Wireless debugging** on the device (Developer options).
- Ensure `adbConnect.autoDiscover` is on.
- A **VPN** on either side can prevent mDNS/local discovery — try disabling it.

## adb cannot reach the device, but the computer can

If adb reports `no route to host` / `host is unreachable` while this computer can actually
reach the device, something is blocking the **adb server process** on the local network:

- **macOS:** allow "Local Network" for the app that started adb
  (System Settings › Privacy & Security › Local Network).
- Allow adb in your **firewall / endpoint-security** software.
- Then restart the adb server **yourself** (`adb kill-server`). ADB Connect never restarts
  the global adb server because other tools may be using it.

## QR / Wireless debugging pairing fails

- Requires **Android 11+**.
- Use platform-tools **31+**.
- Keep the QR pairing view open and scan from Developer options › Wireless debugging ›
  **Pair device with QR code**. If it times out, use **Retry** or fall back to the
  six-digit **Pair via Pairing Code** flow.
- Firewall / Local Network / VPN restrictions (above) also block pairing-service discovery.

## Device shows offline or unauthorized

- Re-check the **Allow USB/Wireless debugging** prompt on the device.
- Toggle Wireless debugging off and on, then reconnect.

## A device won't auto-reconnect

- `adbConnect.autoReconnect` must be enabled, and `adbConnect.reconnectOnStartup` for
  reconnecting at IDE launch.
- ADB Connect only reconnects **remembered** devices and will not reconnect a device you
  **manually disconnected** until you reconnect it yourself.
- After bounded retries it gives up; trigger **Reconnect** manually once the device is back.

See also: [INSTALL.md](./INSTALL.md), [FEATURES.md](./FEATURES.md),
[VALIDATION.md](./VALIDATION.md).
