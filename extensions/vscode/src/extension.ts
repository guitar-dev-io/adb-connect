import * as vscode from 'vscode';
import { spawnSync } from 'child_process';
import path from 'path';

function callCore(cmd: string): any {
  try {
    const node = process.execPath;
    // In dev, expect monorepo layout. Packaged extension should bundle core or use an IPC executable.
    const cli = path.join(__dirname, '..', '..', '..', 'packages', 'core', 'dist', 'cli.js');
    const res = spawnSync(node, [cli, cmd], { encoding: 'utf8', timeout: 5000 });
    if (res.status !== 0) return null;
    const out = res.stdout && res.stdout.trim();
    if (!out) return null;
    return JSON.parse(out);
  } catch (err) {
    return null;
  }
}

export function activate(context: vscode.ExtensionContext) {
  const status = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 100);
  status.text = 'ADB: Initializing...';
  status.command = 'adbConnect.showStatus';
  status.show();

  async function update() {
    const s = callCore('status');
    if (!s) {
      status.text = 'ADB: Error';
      return;
    }
    if (!s.ok) {
      status.text = 'ADB: Disconnected';
      return;
    }
    const devices = s.devices || [];
    if (devices.length === 0) {
      status.text = 'ADB: No devices';
    } else if (devices.length === 1) {
      const d = devices[0];
      status.text = `ADB: ${d.serial}`;
    } else {
      status.text = `ADB: ${devices.length} Devices`; 
    }
  }

  context.subscriptions.push(status);

  const disposable = vscode.commands.registerCommand('adbConnect.showStatus', async () => {
    const s = callCore('status');
    if (!s) {
      vscode.window.showErrorMessage('ADB core not available — ensure packages/core is built and adb is installed');
      return;
    }
    if (!s.ok) {
      vscode.window.showInformationMessage('ADB not found on PATH');
      return;
    }
    const devices = s.devices || [];
    const items = [
      { label: 'Discover Devices', description: '' },
      { label: 'Pair via QR Code', description: '' },
      { label: 'Pair via Code', description: '' },
      { label: 'Manage Devices', description: '' }
    ];
    const pick = await vscode.window.showQuickPick(items, { placeHolder: `Devices: ${devices.length}` });
    if (!pick) return;
    vscode.window.showInformationMessage(`Selected: ${pick.label}`);
  });

  context.subscriptions.push(disposable);

  // initial update and periodic refresh
  update();
  const interval = setInterval(update, 5000);
  context.subscriptions.push({ dispose: () => clearInterval(interval) });
}

export function deactivate() {}
