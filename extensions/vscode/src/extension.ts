import * as vscode from 'vscode';
import * as core from '@adb-connect/core';
import type { Device } from '@adb-connect/core';
import { showManager, DeviceManager } from './ui';

const COMMANDS = ['menu', 'devices', 'pairCode', 'pairQr', 'connect', 'discover', 'reconnect', 'disconnect', 'logs'] as const;
type CommandId = typeof COMMANDS[number];

const MAX_KNOWN_ENDPOINTS = 30;

let output: vscode.OutputChannel;
let status: vscode.StatusBarItem;
let manager: DeviceManager | undefined;
let devices: Device[] = [];
let busy = false;

const config = () => vscode.workspace.getConfiguration('adbConnect');
const adbPath = () => config().get<string>('adbPath') || 'adb';

function log(msg: string) {
  output.appendLine(`[${new Date().toISOString()}] ${msg}`);
}

function updateStatus() {
  const connected = devices.filter(d => d.status === 'device');
  if (!busy) {
    status.text = connected.length
      ? `$(device-mobile) ${connected.length === 1 ? connected[0].model : `${connected.length} devices`}`
      : '$(device-mobile) ADB: Disconnected';
  }
  status.tooltip = `${connected.length} connected Android device(s)\nClick for Quick Actions`;
  if (config().get<boolean>('showStatusBar', true)) status.show();
  else status.hide();
  manager?.refresh();
}

async function refresh() {
  const r = await core.listDevices(adbPath());
  if (!r.ok) log(`adb devices failed: ${r.raw ?? ''}`);
  devices = r.devices;
  updateStatus();
}

/** Run one user-initiated adb operation at a time, with a spinner and result notification. */
async function withBusy(title: string, op: () => Promise<core.OpResult>): Promise<core.OpResult | undefined> {
  if (busy) {
    vscode.window.showInformationMessage('An ADB operation is already running');
    return undefined;
  }
  busy = true;
  status.text = `$(sync~spin) ${title}`;
  try {
    const r = await op();
    log(`${title}: ${r.ok ? 'ok' : 'failed'} — ${r.message}`);
    if (r.ok) vscode.window.showInformationMessage(r.message.slice(0, 500));
    else vscode.window.showErrorMessage(`${title}: ${r.message.slice(0, 500)}`);
    return r;
  } catch (e) {
    const message = (e as Error).message;
    log(`${title} failed: ${message}`);
    vscode.window.showErrorMessage(`${title}: ${message}`);
    return undefined;
  } finally {
    busy = false;
    await refresh();
  }
}

function knownEndpoints(): string[] {
  return config().get<string[]>('knownEndpoints', []).filter(core.validEndpoint);
}

async function setKnownEndpoints(list: string[]) {
  await config().update('knownEndpoints', list.slice(-MAX_KNOWN_ENDPOINTS), vscode.ConfigurationTarget.Global);
}

async function remember(endpoint: string) {
  const saved = knownEndpoints();
  if (!saved.includes(endpoint)) await setKnownEndpoints([...saved, endpoint]);
}

async function forget(endpoint: string) {
  const saved = knownEndpoints();
  if (saved.includes(endpoint)) await setKnownEndpoints(saved.filter(e => e !== endpoint));
}

async function connect(endpoint?: string) {
  endpoint ??= await vscode.window.showInputBox({
    title: 'ADB Connect: IP and connect port',
    prompt: 'Use the Wireless debugging device address (not the pairing port)',
    placeHolder: '192.168.1.20:37123',
    validateInput: v => (core.validEndpoint(v) ? null : 'Enter a valid host:port'),
  });
  if (!endpoint) return;
  const target = endpoint.trim();
  const r = await withBusy('Connect', () => core.connect(adbPath(), target));
  if (r?.ok) await remember(target);
}

async function pairCode() {
  const endpoint = await vscode.window.showInputBox({
    title: 'Pair Android with pairing code',
    prompt: 'On your phone: Developer options > Wireless debugging > Pair device with pairing code',
    placeHolder: '192.168.1.20:42761',
    validateInput: v => (core.validEndpoint(v) ? null : 'Enter the pairing IP:port shown on Android'),
  });
  if (!endpoint) return;
  const code = await vscode.window.showInputBox({
    title: '6-digit pairing code',
    placeHolder: '123456',
    password: true,
    validateInput: v => (core.validPairingCode(v) ? null : 'Enter exactly 6 digits'),
  });
  if (!code) return;
  // The code is passed to adb only; core redacts it from messages and it is never persisted.
  const r = await withBusy('Pair', () => core.pair(adbPath(), endpoint.trim(), code));
  if (r?.ok) {
    const pick = await vscode.window.showInformationMessage(
      'Pairing completed. Now discover the device or enter its connect IP:port (it differs from the pairing port).',
      'Discover',
      'Connect by IP:Port',
    );
    if (pick === 'Discover') await discover();
    else if (pick === 'Connect by IP:Port') await connect();
  }
}

async function discover() {
  const r = await core.discover(adbPath());
  if (!r.ok) {
    vscode.window.showWarningMessage(`mDNS discovery unavailable: ${r.message ?? ''}`);
    return;
  }
  const found = r.services.filter(s => s.service === '_adb-tls-connect._tcp');
  if (!found.length) {
    vscode.window.showInformationMessage('No discoverable ADB connect services. Check Wi-Fi and Wireless debugging, or use IP:Port.');
    return;
  }
  const choice = await vscode.window.showQuickPick(
    found.map(s => ({ label: s.name, description: s.endpoint, endpoint: s.endpoint })),
    { placeHolder: 'Select an Android device' },
  );
  if (choice) await connect(choice.endpoint);
}

async function reconnect(quiet = false) {
  const known = knownEndpoints();
  if (!known.length) {
    if (!quiet) vscode.window.showInformationMessage('No saved endpoints yet. Connect once by IP:Port or discover devices.');
    return;
  }
  const already = new Set(devices.filter(d => d.status === 'device').map(d => d.serial));
  for (const endpoint of known) {
    if (already.has(endpoint)) continue;
    try {
      const r = await core.connect(adbPath(), endpoint, 9_000);
      log(`Reconnect ${endpoint}: ${r.ok ? 'connected' : `failed — ${r.message}`}`);
    } catch (e) {
      log(`Reconnect ${endpoint}: failed — ${(e as Error).message}`);
    }
  }
  await refresh();
}

async function disconnect(serial?: string) {
  if (!serial) {
    const wireless = devices.filter(d => d.transport === 'Wi-Fi');
    if (!wireless.length) {
      vscode.window.showInformationMessage('No wireless Android devices are connected.');
      return;
    }
    const choice = await vscode.window.showQuickPick(
      wireless.map(d => ({ label: d.model, description: d.serial, serial: d.serial })),
      { placeHolder: 'Disconnect which wireless Android device?' },
    );
    if (!choice) return;
    serial = choice.serial;
  }
  const target = serial;
  const r = await withBusy('Disconnect', () => core.disconnect(adbPath(), target));
  // A manual disconnect means "don't bring this back automatically".
  if (r?.ok) await forget(target);
}

async function qrGuide() {
  const pick = await vscode.window.showInformationMessage(
    'QR pairing needs an ADB pairing server plus an _adb-tls-pairing._tcp mDNS advertisement, which is not implemented yet. ' +
    'This preview does not show a non-functional QR code. Use Pair with 6-digit Code instead.',
    'Pair with Code',
  );
  if (pick === 'Pair with Code') await pairCode();
}

async function menu() {
  const items: { label: string; id: CommandId }[] = [
    { label: '$(device-mobile) Device Manager', id: 'devices' },
    { label: '$(key) Pair with 6-digit Code', id: 'pairCode' },
    { label: '$(qr-code) QR Pairing (Guide)', id: 'pairQr' },
    { label: '$(plug) Connect by IP:Port', id: 'connect' },
    { label: '$(search) Discover Devices', id: 'discover' },
    { label: '$(sync) Reconnect Saved Devices', id: 'reconnect' },
    { label: '$(debug-disconnect) Disconnect', id: 'disconnect' },
    { label: '$(output) Show ADB Logs', id: 'logs' },
  ];
  const pick = await vscode.window.showQuickPick(items, { placeHolder: 'ADB Connect • Select an action' });
  if (pick) await dispatch(pick.id);
}

function openManager() {
  if (manager) {
    manager.panel.reveal();
    manager.refresh();
    return;
  }
  manager = showManager(() => devices, (action, id) => dispatch(action, id));
  manager.panel.onDidDispose(() => { manager = undefined; });
}

async function dispatch(id: CommandId, arg?: string): Promise<void> {
  switch (id) {
    case 'menu': return menu();
    case 'devices': return openManager();
    case 'pairCode': return pairCode();
    case 'pairQr': return qrGuide();
    case 'connect': return connect();
    case 'discover': return discover();
    case 'reconnect': return reconnect();
    case 'disconnect': return disconnect(arg);
    case 'logs': return output.show(true);
  }
}

function startPolling(context: vscode.ExtensionContext): vscode.Disposable {
  const raw = Number(config().get<number>('refreshIntervalSeconds', 15)) || 15;
  const seconds = Math.max(5, Math.min(300, raw));
  const timer = setInterval(() => { if (!busy) void refresh(); }, seconds * 1000);
  const d = { dispose: () => clearInterval(timer) };
  context.subscriptions.push(d);
  return d;
}

export async function activate(context: vscode.ExtensionContext) {
  output = vscode.window.createOutputChannel('ADB Connect');
  status = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 80);
  status.command = 'adbConnect.menu';
  context.subscriptions.push(output, status);

  for (const name of COMMANDS) {
    context.subscriptions.push(vscode.commands.registerCommand(`adbConnect.${name}`, (arg?: unknown) =>
      dispatch(name, typeof arg === 'string' ? arg : undefined)));
  }

  let polling = startPolling(context);
  context.subscriptions.push(vscode.workspace.onDidChangeConfiguration(e => {
    if (e.affectsConfiguration('adbConnect.refreshIntervalSeconds')) {
      polling.dispose();
      polling = startPolling(context);
    }
    if (e.affectsConfiguration('adbConnect.adbPath')) void refresh();
    if (e.affectsConfiguration('adbConnect.showStatusBar')) updateStatus();
  }));

  await refresh();
  if (config().get<boolean>('autoReconnect', true)) await reconnect(true);
  log('ADB Connect ready');
}

export function deactivate() {}
