import * as vscode from 'vscode';
import { randomBytes } from 'crypto';
import type { Device } from '@adb-connect/core';

export type ManagerAction = 'pairCode' | 'pairQr' | 'connect' | 'discover' | 'reconnect' | 'disconnect';

const ACTIONS: readonly ManagerAction[] = ['pairCode', 'pairQr', 'connect', 'discover', 'reconnect', 'disconnect'];

export interface DeviceManager {
  panel: vscode.WebviewPanel;
  refresh(): void;
}

function escapeHtml(s: unknown): string {
  return String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!));
}

function deviceCard(d: Device): string {
  const disconnect = d.transport === 'Wi-Fi'
    ? `<button data-act="disconnect" data-id="${escapeHtml(d.serial)}">Disconnect</button>`
    : '';
  return `<div class="device">
    <div><strong>${escapeHtml(d.model)}</strong><small>${escapeHtml(d.serial)} · ${escapeHtml(d.transport)}</small></div>
    <span class="state ${d.status === 'device' ? 'ok' : ''}">${escapeHtml(d.status)}</span>
    ${disconnect}
  </div>`;
}

function render(devices: Device[], cspSource: string): string {
  const nonce = randomBytes(16).toString('base64');
  const cards = devices.length
    ? devices.map(deviceCard).join('')
    : '<div class="empty">No connected devices. Pair or discover a device to get started.</div>';
  return `<!doctype html>
<html>
<head>
<meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${cspSource} 'nonce-${nonce}'; script-src 'nonce-${nonce}';">
<meta name="viewport" content="width=device-width,initial-scale=1">
<style nonce="${nonce}">
  body { font: var(--vscode-font-size) var(--vscode-font-family); padding: 18px; color: var(--vscode-foreground); }
  header { display: flex; justify-content: space-between; align-items: center; margin-bottom: 18px; }
  h1 { font-size: 19px; margin: 0; }
  .actions { display: flex; gap: 8px; flex-wrap: wrap; margin: 16px 0; }
  button { padding: 8px 12px; color: var(--vscode-button-foreground); background: var(--vscode-button-background); border: 0; border-radius: 5px; cursor: pointer; }
  button:hover { background: var(--vscode-button-hoverBackground); }
  button:focus-visible { outline: 1px solid var(--vscode-focusBorder); outline-offset: 2px; }
  .device { display: flex; align-items: center; gap: 14px; background: var(--vscode-editorWidget-background); border: 1px solid var(--vscode-widget-border); border-radius: 9px; padding: 14px; margin: 8px 0; }
  .device > div { flex: 1; }
  small { display: block; opacity: .75; margin-top: 5px; }
  .state { padding: 5px 9px; border-radius: 15px; background: var(--vscode-badge-background); color: var(--vscode-badge-foreground); }
  .state.ok { color: var(--vscode-testing-iconPassed); }
  .empty { padding: 25px; border: 1px dashed var(--vscode-widget-border); border-radius: 9px; opacity: .8; }
</style>
</head>
<body>
<header><h1>ADB Connect</h1><span>Wireless Android Debugging</span></header>
<div class="actions">
  <button data-act="pairCode">Pair with code</button>
  <button data-act="connect">Connect IP:Port</button>
  <button data-act="discover">Discover</button>
  <button data-act="reconnect">Reconnect</button>
  <button data-act="pairQr">QR pairing info</button>
</div>
<h2>Connected devices</h2>
<div role="list">${cards}</div>
<script nonce="${nonce}">
  const vscode = acquireVsCodeApi();
  document.querySelectorAll('button[data-act]').forEach(b =>
    b.addEventListener('click', () => vscode.postMessage({ action: b.dataset.act, id: b.dataset.id || '' })));
</script>
</body>
</html>`;
}

export function showManager(
  getDevices: () => Device[],
  onAction: (action: ManagerAction, id?: string) => unknown,
): DeviceManager {
  const panel = vscode.window.createWebviewPanel(
    'adbConnectDevices',
    'ADB Connect - Devices',
    vscode.ViewColumn.Active,
    { enableScripts: true, retainContextWhenHidden: true, localResourceRoots: [] },
  );
  let lastKey: string | undefined;
  // Only re-render when the device list changed, so periodic polling doesn't steal keyboard focus.
  const refresh = () => {
    const devices = getDevices();
    const key = JSON.stringify(devices.map(d => [d.serial, d.status, d.model]));
    if (key === lastKey) return;
    lastKey = key;
    panel.webview.html = render(devices, panel.webview.cspSource);
  };
  panel.webview.onDidReceiveMessage((m: unknown) => {
    const msg = m as { action?: unknown; id?: unknown } | undefined;
    if (typeof msg?.action !== 'string' || !ACTIONS.includes(msg.action as ManagerAction)) return;
    onAction(msg.action as ManagerAction, typeof msg.id === 'string' && msg.id ? msg.id : undefined);
  });
  refresh();
  return { panel, refresh };
}
