# Implementation handoff for Kiro / Claude

Continue building from this code, don't overwrite it with a mockup.

1. Install Android Platform Tools and verify `adb version`, `adb mdns services`, `adb devices -l` on Windows/macOS/Linux.
2. Verify real code pairing; note the pairing port and connect port differ.
3. Implement **real** QR pairing server and mDNS pairing service advertisement; investigate Android adb pairing TLS/PAKE requirements and interop; test Android 11–latest. Do NOT replace with a generic QR code.
4. Replace simplistic endpoint caching with device-key/mDNS identity where possible; bound retries and respect manual disconnect; handle network changes safely.
5. Add detailed VS Code integration tests and webview CSP nonce randomization, accessibility and localization.
6. Achieve JetBrains feature parity, integrate native status indicator and tool window; use Kotlin's asynchronous process APIs and test target products.
7. Add signed/verified Marketplace metadata, publisher identity, proper icon, compliance docs and automated release build.
8. Run on real Android devices and in each claimed IDE. Do not call it production-ready until verified.

Proposed name: **ADB Connect — Wireless Android Debugging**.
