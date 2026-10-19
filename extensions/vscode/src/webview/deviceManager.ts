import * as vscode from 'vscode';
import type { DeviceEntry } from '@adb-connect/core';
import { webviewHtml, localResourceRoots } from './html';

export type ManagerAction = 'pairQr' | 'pairCode' | 'connect' | 'discover' | 'reconnectAll' | 'settings' | 'logs';
export type DeviceOp = 'connect' | 'disconnect' | 'reconnect' | 'prefer' | 'forget' | 'copySerial' | 'copyCommands' | 'toggleAuto';

export interface ManagerState {
  entries: DeviceEntry[];
  activity: string;
  preferredId?: string;
  adb?: string;
  error?: string;
}

export interface ManagerHandlers {
  action(a: ManagerAction): unknown;
  device(op: DeviceOp, id: string): unknown;
}

const ACTIONS: ManagerAction[] = ['pairQr', 'pairCode', 'connect', 'discover', 'reconnectAll', 'settings', 'logs'];
const OPS: DeviceOp[] = ['connect', 'disconnect', 'reconnect', 'prefer', 'forget', 'copySerial', 'copyCommands', 'toggleAuto'];

/** Single-instance Device Manager webview. State is pushed as data; the page renders it with DOM APIs (no HTML injection). */
export class DeviceManagerPanel implements vscode.Disposable {
  static readonly viewType = 'adbConnect.deviceManager';
  private static current?: DeviceManagerPanel;
  private readonly disposables: vscode.Disposable[] = [];
  private lastState?: ManagerState;

  static show(extensionUri: vscode.Uri, handlers: ManagerHandlers, state: ManagerState): DeviceManagerPanel {
    if (DeviceManagerPanel.current) {
      DeviceManagerPanel.current.panel.reveal();
      DeviceManagerPanel.current.post(state);
      return DeviceManagerPanel.current;
    }
    const panel = vscode.window.createWebviewPanel(DeviceManagerPanel.viewType, 'ADB Connect — Devices', vscode.ViewColumn.Active, {
      enableScripts: true,
      retainContextWhenHidden: false,
      localResourceRoots: localResourceRoots(extensionUri),
    });
    DeviceManagerPanel.current = new DeviceManagerPanel(panel, extensionUri, handlers);
    DeviceManagerPanel.current.post(state);
    return DeviceManagerPanel.current;
  }

  static update(state: ManagerState) {
    DeviceManagerPanel.current?.post(state);
  }

  private constructor(private readonly panel: vscode.WebviewPanel, extensionUri: vscode.Uri, handlers: ManagerHandlers) {
    panel.iconPath = vscode.Uri.joinPath(extensionUri, 'media', 'icon.png');
    panel.webview.html = webviewHtml(panel.webview, extensionUri, {
      title: 'ADB Connect — Devices',
      styles: ['common.css', 'manager.css'],
      scripts: ['icons.js', 'manager.js'],
      body: '<main id="app" aria-live="polite"></main>',
    });
    this.disposables.push(
      panel.webview.onDidReceiveMessage((m: unknown) => {
        const msg = m as { type?: string; action?: string; op?: string; id?: string };
        if (msg?.type === 'ready' && this.lastState) return this.post(this.lastState);
        if (msg?.type === 'action' && ACTIONS.includes(msg.action as ManagerAction)) return handlers.action(msg.action as ManagerAction);
        if (msg?.type === 'device' && OPS.includes(msg.op as DeviceOp) && typeof msg.id === 'string') return handlers.device(msg.op as DeviceOp, msg.id);
      }),
      // Re-send state when the panel becomes visible again (retainContextWhenHidden is off to save memory).
      panel.onDidChangeViewState(e => { if (e.webviewPanel.visible && this.lastState) this.post(this.lastState); }),
      panel.onDidDispose(() => this.dispose()),
    );
  }

  private post(state: ManagerState) {
    this.lastState = state;
    void this.panel.webview.postMessage({ type: 'state', state });
  }

  dispose() {
    DeviceManagerPanel.current = undefined;
    while (this.disposables.length) this.disposables.pop()?.dispose();
  }
}
