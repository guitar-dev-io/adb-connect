import * as vscode from 'vscode';
import { Controller } from './controller';

let controller: Controller | undefined;

export async function activate(context: vscode.ExtensionContext) {
  controller = new Controller(context);
  context.subscriptions.push(controller);
  const c = controller;
  const commands: Record<string, (...args: unknown[]) => unknown> = {
    'adbConnect.menu': () => c.menu(),
    'adbConnect.connect': () => c.connect(),
    'adbConnect.reconnect': () => c.reconnect(),
    'adbConnect.disconnect': (serial?: unknown) => c.disconnect(typeof serial === 'string' ? serial : undefined),
    'adbConnect.pairQr': () => c.pairQr(),
    'adbConnect.pairCode': () => c.pairCode(),
    'adbConnect.discover': () => c.discover(),
    'adbConnect.devices': () => c.devices(),
    'adbConnect.settings': () => c.openSettings(),
    'adbConnect.logs': () => c.showLogs(),
  };
  for (const [id, fn] of Object.entries(commands)) context.subscriptions.push(vscode.commands.registerCommand(id, fn));
  // Don't block activation on adb startup / reconnects.
  void c.start();
  return { controller: c };
}

export function deactivate() {
  controller = undefined;
}
