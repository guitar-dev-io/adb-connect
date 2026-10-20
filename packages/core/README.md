# @adb-connect/core

Node/TypeScript core for talking to the locally installed `adb`. Used as a library by the VS Code extension, and exposes a small JSON CLI for other integrations during development.

Library (`import ... from '@adb-connect/core'`)
- `runAdb(adbPath, args, timeoutMs)` — spawn adb without a shell, bounded output and timeout
- `listDevices`, `pair`, `connect`, `disconnect`, `discover` — high-level operations; inputs are validated and pairing codes never appear in returned messages
- `parseDevices`, `parseMdns`, `validEndpoint`, `validPairingCode` — pure helpers

CLI (`node dist/cli.js <command>`, prints JSON)
- `status` (default) — adb path, version and device list
- `version`, `list-devices`, `discover`
- `connect <host:port>`, `disconnect <host:port>`

Build / test
- `npm run build`
- `npm test`
