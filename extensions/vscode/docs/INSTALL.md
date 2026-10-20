# Installation

ADB Connect is a VS Code extension that runs on VS Code and compatible VS Code-based IDEs.
Pick the channel that matches your IDE.

## Prerequisites

- **Android platform-tools (adb)** installed. `adb` should be on your `PATH`, or set its
  location with the `adbConnect.adbPath` setting. Platform-tools **31+** is recommended for
  Wireless debugging / QR pairing.
- An Android **11+** device for QR / Wireless debugging pairing.

## VS Code — VS Code Marketplace

In the editor:

1. Open the **Extensions** view — click the Extensions icon in the Activity Bar, or press
   `Ctrl+Shift+X` (Windows/Linux) / `Cmd+Shift+X` (macOS).
2. In the search box at the top, type one of these:
   - `ADB Connect` — the display name.
   - `adb wireless` or `wireless debugging` — if several results appear, look for the one
     published by **guitar-dev-io**.
   - `guitar-dev-io.adb-connect-vscode` — the exact id, to jump straight to it.
3. Click **ADB Connect — Wireless Android Debugging** in the results.
4. Click the blue **Install** button.
5. After it installs, an **ADB** item appears in the status bar (bottom of the window) —
   click it to open Quick Actions.

Or install from the command line:

```sh
code --install-extension guitar-dev-io.adb-connect-vscode
```

You can also open the Marketplace page directly in a browser and click **Install**:
<https://marketplace.visualstudio.com/items?itemName=guitar-dev-io.adb-connect-vscode>

> **Can't find it by searching?** Right after a new release the Marketplace can take a few
> minutes to index. Meanwhile, search by the exact id
> `guitar-dev-io.adb-connect-vscode`, open the Marketplace link above, or install from a
> `.vsix` (see below).

## Kiro, Cursor, Windsurf and other VS Code-based IDEs — Open VSX

These IDEs install extensions from the [Open VSX Registry](https://open-vsx.org) instead of
the VS Code Marketplace:

1. Open the **Extensions** view in the IDE (`Ctrl+Shift+X` / `Cmd+Shift+X`).
2. In the search box, type `ADB Connect` (or the exact id
   `guitar-dev-io.adb-connect-vscode`). These IDEs are wired to Open VSX, so the search
   runs against that registry.
3. Click the result, then click **Install**.

> If it doesn't show up, the extension may not be published to Open VSX yet — install from
> a `.vsix` (below) in the meantime.

## Install from VSIX (any compatible IDE)

Use a `.vsix` when you build locally or install a specific release.

From the command line:

```sh
code --install-extension adb-connect-vscode-<version>.vsix
```

(Replace `code` with your IDE's CLI, e.g. `cursor` / `windsurf` / `kiro`, if available.)

Or via the UI: Extensions view › `...` menu › **Install from VSIX...** › pick the file.

### Building the VSIX yourself

From the repo root:

```sh
npm install
npm run -w extensions/vscode package
```

This produces `dist/adb-connect-vscode-<version>.vsix` at the repo root.

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
