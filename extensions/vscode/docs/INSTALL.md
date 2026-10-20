# Installation

ADB Connect is a VS Code extension that runs on VS Code and compatible VS Code-based IDEs.
Pick the channel that matches your IDE.

## Prerequisites

- **Android platform-tools (adb)** installed. `adb` should be on your `PATH`, or set its
  location with the `adbConnect.adbPath` setting. Platform-tools **31+** is recommended for
  Wireless debugging / QR pairing.
- An Android **11+** device for QR / Wireless debugging pairing.

## VS Code — VS Code Marketplace

1. Open the Extensions view (`Ctrl+Shift+X` / `Cmd+Shift+X`).
2. Search for **ADB Connect**.
3. Click **Install**.

Or from the command line:

```sh
code --install-extension guitar-dev-io.adb-connect-vscode
```

> `guitar-dev-io` is a placeholder publisher id; use the real Marketplace id once
> published.

## Kiro, Cursor, Windsurf and other VS Code-based IDEs — Open VSX

These IDEs install extensions from the [Open VSX Registry](https://open-vsx.org):

1. Open the Extensions view in the IDE.
2. Search for **ADB Connect** (the IDE is wired to Open VSX).
3. Click **Install**.

## Install from VSIX (any compatible IDE)

Use a `.vsix` when you build locally or install a specific release.

From the command line:

```sh
code --install-extension adb-connect-vscode-0.2.0.vsix
```

(Replace `code` with your IDE's CLI, e.g. `cursor` / `windsurf`, if available.)

Or via the UI: Extensions view › `...` menu › **Install from VSIX...** › pick the file.

### Building the VSIX yourself

From the repo root:

```sh
npm install
npm run -w extensions/vscode package
```

This produces `dist/adb-connect-vscode-0.2.0.vsix` at the repo root.

## Publishing (maintainers)

- **VS Code Marketplace** — package with `npm run -w extensions/vscode package`, then
  publish the `.vsix` with `vsce publish` using your publisher token.
- **Open VSX** — the repo provides a helper script:

  ```sh
  npm run -w extensions/vscode package:ovsx
  ```

  It packages the extension and prints the publish command:

  ```sh
  npx ovsx publish ../../dist/adb-connect-vscode-<version>.vsix -p <token>
  ```

Publisher ids, repository URLs, and tokens in this repo are placeholders — substitute your
own before publishing.
