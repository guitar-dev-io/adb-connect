import * as vscode from 'vscode';
import {
  AdbEngine, AdbError, DeviceEntry, Lease, MdnsService, PairingResult,
  adbCommandsFor, validEndpoint, validPairingCode,
} from '@adb-connect/core';
import { StatusBar, Activity } from './statusBar';
import { DeviceManagerPanel, DeviceOp, ManagerAction, ManagerState } from './webview/deviceManager';
import { QrPairingPanel } from './webview/qrPairing';
import { channelLogger, GlobalStateStore, readSettings, Settings, SECTION } from './support';

const PLATFORM_TOOLS_URL = 'https://developer.android.com/tools/releases/platform-tools';

type PickItem<T> = vscode.QuickPickItem & { run?: () => unknown; value?: T };

export class Controller implements vscode.Disposable {
  private engine?: AdbEngine;
  private settings: Settings = readSettings();
  private readonly status = new StatusBar();
  private readonly log: vscode.LogOutputChannel;
  private discoverLease?: Lease;
  private searching = 0;
  private pairing = false;
  private startError?: string;
  private readonly disposables: vscode.Disposable[] = [];
  private engineDisposables: (() => void)[] = [];
  private refreshTimer?: NodeJS.Timeout;

  constructor(private readonly context: vscode.ExtensionContext) {
    this.log = vscode.window.createOutputChannel('ADB Connect', { log: true });
    this.disposables.push(this.log, this.status);
  }

  // ---------- lifecycle ----------

  async start(): Promise<void> {
    this.render('starting');
    await this.createEngine();
    this.disposables.push(vscode.workspace.onDidChangeConfiguration(e => this.onConfigChanged(e)));
    if (this.engine && this.settings.autoReconnect && this.settings.reconnectOnStartup) {
      void this.withActivity(() => this.engine!.connections.reconnectAll('startup')).then(rs => {
        const ok = rs.filter(r => r.ok).length;
        if (rs.length) this.log.info(`Startup reconnect: ${ok}/${rs.length} device(s) connected`);
      });
    }
  }

  private async createEngine() {
    this.disposeEngine();
    const logger = channelLogger(this.log, () => this.settings.debugLogging);
    try {
      const engine = await AdbEngine.create({
        configuredPath: this.settings.adbPath,
        store: new GlobalStateStore(this.context.globalState),
        autoReconnect: this.settings.autoReconnect,
        logger,
      });
      this.engine = engine;
      this.startError = undefined;
      const info = engine.client.info;
      this.log.info(`Using adb ${info.version.adb} (platform-tools ${info.version.platformTools ?? 'unknown'}) at ${info.location.path} [${info.location.source}]`);
      if (!info.wirelessPairing) {
        this.log.warn('This adb is too old for wireless pairing (needs platform-tools 31+). Connect by IP still works.');
      }
      const onChange = () => this.scheduleRender();
      const onGaveUp = (k: { name: string }, msg: string) => this.log.warn(`Stopped reconnecting ${k.name} after repeated failures: ${msg}`);
      engine.tracker.on('devices', onChange).on('lost', onChange);
      engine.browser.on('services', onChange);
      engine.connections.on('known', onChange).on('activity', onChange).on('gave-up', onGaveUp);
      this.engineDisposables.push(() => {
        engine.tracker.off('devices', onChange).off('lost', onChange);
        engine.browser.off('services', onChange);
        engine.connections.off('known', onChange).off('activity', onChange).off('gave-up', onGaveUp);
      });
      engine.start();
      this.applyDiscovery();
    } catch (e) {
      this.engine = undefined;
      this.startError = (e as Error).message;
      this.log.error(this.startError);
      if (!(e instanceof AdbError)) this.log.error(String((e as Error).stack ?? e));
    }
    this.render();
  }

  private disposeEngine() {
    this.discoverLease?.dispose();
    this.discoverLease = undefined;
    for (const d of this.engineDisposables) d();
    this.engineDisposables = [];
    this.engine?.dispose();
    this.engine = undefined;
  }

  private onConfigChanged(e: vscode.ConfigurationChangeEvent) {
    if (!e.affectsConfiguration(SECTION)) return;
    const prev = this.settings;
    this.settings = readSettings();
    if (prev.adbPath !== this.settings.adbPath) {
      void this.createEngine();
      return;
    }
    this.engine?.connections.setAutoReconnect(this.settings.autoReconnect);
    this.applyDiscovery();
    this.render();
  }

  /** "Auto discover" keeps one mDNS lease for the IDE session (bounded polling inside core). */
  private applyDiscovery() {
    if (this.settings.autoDiscover && this.engine && !this.discoverLease) this.discoverLease = this.engine.browser.acquire();
    if (!this.settings.autoDiscover && this.discoverLease) {
      this.discoverLease.dispose();
      this.discoverLease = undefined;
    }
  }

  dispose() {
    clearTimeout(this.refreshTimer);
    this.disposeEngine();
    while (this.disposables.length) this.disposables.pop()?.dispose();
  }

  // ---------- rendering ----------

  private entries(): DeviceEntry[] {
    return this.engine?.entries(this.settings.preferredDevice || undefined) ?? [];
  }

  private activity(): Activity {
    if (!this.engine) return this.startError ? 'no-adb' : 'starting';
    if (this.pairing) return 'pairing';
    if (this.engine.connections.isReconnecting) return 'reconnecting';
    if (this.searching > 0) return 'searching';
    return 'idle';
  }

  /** Coalesce bursts of tracker/mDNS events into one render. */
  private scheduleRender() {
    if (this.refreshTimer) return;
    this.refreshTimer = setTimeout(() => {
      this.refreshTimer = undefined;
      this.render();
    }, 50);
  }

  private render(forced?: Activity) {
    const entries = this.entries();
    const activity = forced ?? this.activity();
    this.status.update({ activity, entries, preferredId: this.settings.preferredDevice }, this.settings.showStatusBar);
    DeviceManagerPanel.update(this.managerState(entries, activity));
    void vscode.commands.executeCommand('setContext', 'adbConnect.connectedCount', entries.filter(e => e.status === 'connected').length);
  }

  private managerState(entries = this.entries(), activity = this.activity()): ManagerState {
    const info = this.engine?.client.info;
    return {
      entries,
      activity,
      preferredId: this.settings.preferredDevice || undefined,
      adb: info ? `adb ${info.version.adb} · platform-tools ${info.version.platformTools ?? '?'}` : undefined,
      error: this.startError,
    };
  }

  private async withActivity<T>(fn: () => Promise<T>, kind: 'searching' | 'none' = 'none'): Promise<T> {
    if (kind === 'searching') this.searching++;
    this.render();
    try {
      return await fn();
    } finally {
      if (kind === 'searching') this.searching--;
      this.render();
    }
  }

  /** Returns the engine, or explains how to fix a missing adb. */
  private requireEngine(): AdbEngine | undefined {
    if (this.engine) return this.engine;
    void this.showAdbMissing();
    return undefined;
  }

  private async showAdbMissing() {
    const pick = await vscode.window.showErrorMessage(
      `ADB Connect: ${this.startError ?? 'adb is not available.'}`,
      'Set adb Path…', 'Get Platform-Tools', 'Retry',
    );
    if (pick === 'Set adb Path…') await this.chooseAdbPath();
    if (pick === 'Get Platform-Tools') await vscode.env.openExternal(vscode.Uri.parse(PLATFORM_TOOLS_URL));
    if (pick === 'Retry') await this.createEngine();
  }

  private async chooseAdbPath() {
    const picked = await vscode.window.showOpenDialog({ canSelectMany: false, openLabel: 'Use this adb', title: 'Select the adb executable' });
    if (picked?.[0]) await vscode.workspace.getConfiguration(SECTION).update('adbPath', picked[0].fsPath, vscode.ConfigurationTarget.Global);
  }

  /** Read-only view used by integration tests and diagnostics. */
  snapshot() {
    const entries = this.entries();
    const activity = this.activity();
    return { activity, entries, adb: this.engine?.client.info, error: this.startError };
  }

  // ---------- commands ----------

  async menu() {
    if (!this.engine) return this.showAdbMissing();
    const entries = this.entries();
    const connected = entries.filter(e => e.status === 'connected');
    const items: PickItem<never>[] = [];
    for (const e of connected) {
      items.push({
        label: `$(circle-filled) ${e.name}`,
        description: `${e.endpoint ?? e.serial}${e.preferred ? ' · preferred' : ''}`,
        detail: undefined,
        run: () => this.deviceMenu(e),
      });
    }
    if (connected.length) items.push({ label: '', kind: vscode.QuickPickItemKind.Separator });
    items.push(
      { label: '$(plug) Connect Device', run: () => this.connect() },
      { label: '$(sync) Reconnect', description: 'Reconnect remembered devices', run: () => this.reconnect() },
      { label: '$(debug-disconnect) Disconnect', run: () => this.disconnect() },
      { label: 'Pair', kind: vscode.QuickPickItemKind.Separator },
      { label: '$(device-camera) Pair via QR Code', run: () => this.pairQr() },
      { label: '$(key) Pair via Pairing Code', run: () => this.pairCode() },
      { label: '$(search) Discover Devices', run: () => this.discover() },
      { label: '', kind: vscode.QuickPickItemKind.Separator },
      { label: '$(list-unordered) Manage Devices', run: () => this.devices() },
      { label: '$(gear) Settings', run: () => this.openSettings() },
      { label: '$(output) View Logs', run: () => this.showLogs() },
    );
    const pick = await vscode.window.showQuickPick(items, { title: 'ADB Connect', placeHolder: connected.length ? `${connected.length} device(s) connected` : 'No device connected' });
    await pick?.run?.();
  }

  private async deviceMenu(e: DeviceEntry) {
    const items: PickItem<never>[] = [];
    if (e.transport === 'wifi' && e.status === 'connected') items.push({ label: '$(debug-disconnect) Disconnect', run: () => this.deviceOp('disconnect', e.id) });
    if (!e.preferred) items.push({ label: '$(star-empty) Set as Preferred Device', run: () => this.deviceOp('prefer', e.id) });
    items.push(
      { label: '$(copy) Copy Serial', description: e.serial, run: () => this.deviceOp('copySerial', e.id) },
      { label: '$(terminal) Copy adb Command…', run: () => this.deviceOp('copyCommands', e.id) },
    );
    const pick = await vscode.window.showQuickPick(items, { title: e.name, placeHolder: e.endpoint ?? e.serial });
    await pick?.run?.();
  }

  /**
   * Connect Device: one picker that lists advertised devices live (known first) plus manual entry.
   * Connecting to an advertised device requires this explicit selection.
   */
  async connect(opts: { title?: string } = {}) {
    const engine = this.requireEngine();
    if (!engine) return;
    const qp = vscode.window.createQuickPick<PickItem<string>>();
    qp.title = opts.title ?? 'Connect Device';
    qp.placeholder = 'Pick a device on your network or type IP:Port';
    qp.matchOnDescription = true;
    qp.busy = true;
    const lease = engine.browser.acquire();
    this.searching++;
    this.render();
    const manualItem = (value: string): PickItem<string> => ({ label: `$(plug) Connect to ${value}`, value: `manual:${value}`, alwaysShow: true });
    const build = () => {
      const entries = this.entries().filter(e => e.transport === 'wifi' && e.status !== 'connected' && e.endpoint);
      const items: PickItem<string>[] = entries.map(e => ({
        label: `${e.known ? '$(device-mobile)' : '$(broadcast)'} ${e.name}`,
        description: e.endpoint,
        detail: e.known ? (e.status === 'available' ? 'Remembered · advertising now' : 'Remembered · not advertising (last address)') : 'Discovered on network · must already be paired with this computer',
        value: `entry:${e.id}`,
      }));
      if (validEndpoint(qp.value.trim())) items.unshift(manualItem(qp.value.trim()));
      items.push({ label: '$(edit) Enter IP address and port…', value: 'enter', alwaysShow: true });
      qp.items = items;
    };
    build();
    const subs = [
      qp.onDidChangeValue(build),
      { dispose: () => engine.browser.off('services', build) },
    ];
    engine.browser.on('services', build);
    setTimeout(() => { qp.busy = false; }, 6_000);
    const choice = await new Promise<string | undefined>(resolve => {
      subs.push(qp.onDidAccept(() => resolve(qp.selectedItems[0]?.value)), qp.onDidHide(() => resolve(undefined)));
      qp.show();
    });
    qp.dispose();
    subs.forEach(s => s.dispose());
    lease.dispose();
    this.searching--;
    this.render();
    if (!choice) return;

    if (choice === 'enter') {
      const ep = await vscode.window.showInputBox({
        title: 'Connect by IP:Port',
        prompt: 'IP address & Port from Wireless debugging (not the pairing port)',
        placeHolder: '192.168.1.45:37123',
        validateInput: v => (validEndpoint(v.trim()) ? null : 'Enter host:port, e.g. 192.168.1.45:37123'),
      });
      if (ep) await this.connectEndpoint(ep.trim());
    } else if (choice.startsWith('manual:')) {
      await this.connectEndpoint(choice.slice(7));
    } else if (choice.startsWith('entry:')) {
      await this.deviceOp('connect', choice.slice(6));
    }
  }

  private async connectEndpoint(endpoint: string, name?: string) {
    const engine = this.requireEngine();
    if (!engine) return;
    const r = await vscode.window.withProgress(
      { location: vscode.ProgressLocation.Notification, title: `Connecting to ${endpoint}…` },
      () => engine.connections.connectEndpoint(endpoint, { name }),
    );
    this.render();
    if (r.ok) vscode.window.setStatusBarMessage(`$(check) Connected to ${r.device?.name ?? endpoint}`, 4000);
    else this.reportFailure('Connect failed', r.message);
  }

  async reconnect() {
    const engine = this.requireEngine();
    if (!engine) return;
    if (!engine.connections.known.length) {
      const pick = await vscode.window.showInformationMessage('No remembered devices yet. Pair or connect a device first.', 'Pair via QR Code', 'Connect Device');
      if (pick === 'Pair via QR Code') return this.pairQr();
      if (pick === 'Connect Device') return this.connect();
      return;
    }
    const rs = await this.withActivity(() => engine.connections.reconnectAll('manual'));
    const ok = rs.filter(r => r.ok);
    const failed = rs.filter(r => !r.ok);
    if (failed.length) {
      this.reportFailure(`Reconnected ${ok.length} of ${rs.length}`, failed.map(f => `${f.device?.name ?? '?'}: ${f.message}`).join('\n'));
    } else if (ok.length) {
      vscode.window.setStatusBarMessage(`$(check) Reconnected ${ok.length} device(s)`, 4000);
    }
  }

  async disconnect(serial?: string) {
    const engine = this.requireEngine();
    if (!engine) return;
    if (!serial) {
      const wifi = this.entries().filter(e => e.transport === 'wifi' && e.status !== 'disconnected' && e.status !== 'available' && e.serial);
      if (!wifi.length) {
        vscode.window.showInformationMessage('No wireless device is connected.');
        return;
      }
      if (wifi.length === 1) serial = wifi[0].serial;
      else {
        const pick = await vscode.window.showQuickPick(
          wifi.map(e => ({ label: e.name, description: e.endpoint ?? e.serial, serial: e.serial })),
          { title: 'Disconnect Device' },
        );
        serial = pick?.serial;
      }
    }
    if (!serial) return;
    const r = await engine.connections.disconnect(serial);
    this.render();
    if (r.ok) vscode.window.setStatusBarMessage(`$(debug-disconnect) Disconnected ${serial}`, 4000);
    else this.reportFailure('Disconnect failed', r.message);
  }

  async pairQr() {
    const engine = this.requireEngine();
    if (!engine) return;
    QrPairingPanel.show(this.context.extensionUri, engine, {
      onResult: async (r: PairingResult) => {
        await engine.connections.recordPairing(r);
        this.render();
        if (r.state === 'connected') this.log.info(`QR pairing: connected to ${r.device?.model ?? r.endpoint}`);
      },
      useCode: () => void this.pairCode(),
      setActivity: on => {
        this.pairing = on;
        this.render();
      },
    });
  }

  /**
   * Six-digit code pairing. The phone's "Pair with pairing code" dialog advertises a pairing service,
   * so the endpoint is usually picked from a live list instead of typed.
   */
  async pairCode() {
    const engine = this.requireEngine();
    if (!engine) return;
    if (!engine.client.info.wirelessPairing) {
      this.reportFailure('Pairing unavailable', 'Wireless pairing needs Android SDK Platform-Tools 31 or newer. Update platform-tools or set a newer adb path.');
      return;
    }
    const endpoint = await this.pickPairingEndpoint(engine);
    if (!endpoint) return;
    const code = await vscode.window.showInputBox({
      title: `Pairing code for ${endpoint}`,
      prompt: 'Enter the six-digit Wi-Fi pairing code shown on the phone',
      placeHolder: '123456',
      password: true,
      ignoreFocusOut: true,
      validateInput: v => (validPairingCode(v.trim()) ? null : 'Enter exactly 6 digits'),
    });
    if (!code) return;
    this.pairing = true;
    this.render();
    try {
      const r = await vscode.window.withProgress(
        { location: vscode.ProgressLocation.Notification, title: 'ADB Connect', cancellable: true },
        (progress, token) => {
          const ac = new AbortController();
          token.onCancellationRequested(() => ac.abort());
          return engine.pairWithCode(endpoint, code.trim(), { signal: ac.signal, onUpdate: u => progress.report({ message: u.message }) });
        },
      );
      if (r.state === 'connected') vscode.window.showInformationMessage(`Paired and connected: ${r.device?.model ?? r.endpoint}`);
      else if (r.state === 'paired') vscode.window.showWarningMessage(r.message, 'Connect Device').then(p => p && this.connect());
      else if (r.state !== 'cancelled') this.reportFailure('Pairing failed', r.message);
    } finally {
      this.pairing = false;
      this.render();
    }
  }

  private async pickPairingEndpoint(engine: AdbEngine): Promise<string | undefined> {
    const qp = vscode.window.createQuickPick<PickItem<string>>();
    qp.title = 'Pair via Pairing Code';
    qp.placeholder = 'On the phone: Wireless debugging › Pair device with pairing code. Pick it below or type IP:Port';
    qp.busy = true;
    const lease = engine.browser.acquire();
    this.searching++;
    this.render();
    const build = (services: MdnsService[] = engine.browser.services) => {
      const items: PickItem<string>[] = services
        .filter(s => s.type === 'pairing' && !s.name.startsWith('adbconnect-'))
        .map(s => ({ label: `$(broadcast) ${s.name}`, description: s.endpoint, detail: 'Phone is showing a pairing code', value: s.endpoint }));
      const typed = qp.value.trim();
      if (validEndpoint(typed)) items.unshift({ label: `$(key) Pair with ${typed}`, value: typed, alwaysShow: true });
      if (!items.length) items.push({ label: '$(loading~spin) Waiting for a phone in pairing mode…', detail: 'Or type the IP address & Port shown in the pairing dialog', value: '', alwaysShow: true });
      qp.items = items;
    };
    build();
    engine.browser.on('services', build);
    const subs = [qp.onDidChangeValue(() => build())];
    const choice = await new Promise<string | undefined>(resolve => {
      subs.push(qp.onDidAccept(() => { const v = qp.selectedItems[0]?.value; if (v) resolve(v); }), qp.onDidHide(() => resolve(undefined)));
      qp.show();
    });
    engine.browser.off('services', build);
    subs.forEach(s => s.dispose());
    qp.dispose();
    lease.dispose();
    this.searching--;
    this.render();
    return choice;
  }

  async discover() {
    await this.connect({ title: 'Discover Devices' });
  }

  async devices() {
    DeviceManagerPanel.show(this.context.extensionUri, {
      action: (a: ManagerAction) => this.managerAction(a),
      device: (op: DeviceOp, id: string) => this.deviceOp(op, id),
    }, this.managerState());
  }

  private managerAction(a: ManagerAction) {
    switch (a) {
      case 'pairQr': return this.pairQr();
      case 'pairCode': return this.pairCode();
      case 'connect': return this.connect();
      case 'discover': return this.discover();
      case 'reconnectAll': return this.reconnect();
      case 'settings': return this.openSettings();
      case 'logs': return this.showLogs();
    }
  }

  async deviceOp(op: DeviceOp, id: string) {
    const engine = this.requireEngine();
    if (!engine) return;
    const e = this.entries().find(x => x.id === id);
    if (!e) return;
    switch (op) {
      case 'connect':
      case 'reconnect':
        if (e.known) {
          const r = await this.withActivity(() => engine.connections.reconnect(e.id, 'manual'));
          if (!r.ok) this.reportFailure(`Could not connect ${e.name}`, r.message);
        } else if (e.endpoint) {
          await this.connectEndpoint(e.endpoint, e.advertisedName ? undefined : e.name);
        }
        return;
      case 'disconnect':
        if (e.serial) await this.disconnect(e.serial);
        return;
      case 'prefer':
        await vscode.workspace.getConfiguration(SECTION).update('preferredDevice', e.preferred ? '' : e.id, vscode.ConfigurationTarget.Global);
        return;
      case 'forget': {
        const ok = await vscode.window.showWarningMessage(
          `Forget ${e.name}? It will no longer reconnect automatically. The phone stays paired with adb until you revoke it on the phone.`,
          { modal: true }, 'Forget',
        );
        if (ok === 'Forget') await engine.connections.forget(e.id);
        return;
      }
      case 'toggleAuto':
        if (e.known) await engine.connections.setDeviceAutoReconnect(e.id, !(e.autoReconnect ?? true));
        return;
      case 'copySerial':
        await vscode.env.clipboard.writeText(e.serial ?? e.endpoint ?? e.id);
        vscode.window.setStatusBarMessage('$(copy) Copied', 2000);
        return;
      case 'copyCommands': {
        const cmds = adbCommandsFor(e);
        const pick = await vscode.window.showQuickPick(cmds.map(c => ({ label: c.label, description: c.command, command: c.command })), { title: `adb commands for ${e.name}` });
        if (pick) {
          await vscode.env.clipboard.writeText(pick.command);
          vscode.window.setStatusBarMessage(`$(copy) Copied: ${pick.command}`, 3000);
        }
        return;
      }
    }
  }

  openSettings() {
    return vscode.commands.executeCommand('workbench.action.openSettings', `@ext:${this.context.extension.id}`);
  }

  showLogs() {
    this.log.show(true);
  }

  private reportFailure(title: string, detail: string) {
    this.log.warn(`${title}: ${detail}`);
    void vscode.window.showErrorMessage(`${title}: ${detail.split('\n')[0].slice(0, 300)}`, 'View Logs').then(p => p && this.showLogs());
  }
}
