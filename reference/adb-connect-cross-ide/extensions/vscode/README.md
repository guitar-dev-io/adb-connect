# ADB Connect - VS Code extension

Install as a VSIX or run the extension host from VS Code (open this directory, press F5).

**Working:** adb detection, status bar, list devices, device manager, pair with Android's 6-digit pairing code, IP:Port connect, mDNS discovery, remembered endpoint reconnect and disconnect.

**Not yet implemented:** native QR pairing. The 'Pair via QR' command presents the safe fallback; it does **not** produce a fake pairing QR. Real pairing QR requires hosting Android's pairing protocol plus mDNS advertising a correctly named `_adb-tls-pairing._tcp` service.

**Security:** No device pairing without user action. Codes are not persisted. Known IP:Port endpoints are stored in normal VS Code global settings and are not secrets.

Run `npm test`, `npm run lint`. Set a real `publisher` in package.json before publishing.
