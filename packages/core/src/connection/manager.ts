import { EventEmitter } from 'events';
import { AdbClient } from '../adb/client';
import { DeviceTracker } from '../devices/tracker';
import { Device } from '../devices/parse';
import { MdnsBrowser } from '../discovery/browser';
import { MdnsService } from '../discovery/parse';
import { PairingResult } from '../pairing/session';
import { KnownDevice, KnownDeviceStore } from './known';
import { validEndpoint } from './endpoint';
import { Logger, nullLogger } from '../log';

export type ReconnectReason = 'manual' | 'startup' | 'advertised' | 'dropped';

export interface ConnectionManagerOptions {
  autoReconnect: boolean;
  logger?: Logger;
  /** Consecutive automatic failures before giving up on a device. Default 3. */
  maxAttempts?: number;
  /** First retry delay after a drop; doubles per attempt. Default 2s. */
  retryDelayMs?: number;
}

export interface ConnectionManagerEvents {
  /** Known-device list changed. */
  known: (devices: KnownDevice[]) => void;
  /** Number of automatic reconnects currently running changed. */
  activity: (reconnecting: number) => void;
  /** Automatic reconnection stopped for a device after bounded failures. */
  'gave-up': (device: KnownDevice, message: string) => void;
}

export declare interface ConnectionManager {
  on<E extends keyof ConnectionManagerEvents>(event: E, listener: ConnectionManagerEvents[E]): this;
  off<E extends keyof ConnectionManagerEvents>(event: E, listener: ConnectionManagerEvents[E]): this;
  emit<E extends keyof ConnectionManagerEvents>(event: E, ...args: Parameters<ConnectionManagerEvents[E]>): boolean;
}

export interface ConnectOutcome {
  ok: boolean;
  message: string;
  device?: KnownDevice;
}

/**
 * Owns manual connect/disconnect and the smart auto-reconnect policy:
 *  - only devices the user connected/paired (KnownDevice) are ever reconnected automatically;
 *  - never after a manual disconnect, never while auto-reconnect is off;
 *  - only to a device that is currently advertising its connect service (Wireless debugging on),
 *    which also follows IP/port changes; a remembered endpoint is only tried blind when the
 *    adb mDNS backend is unavailable;
 *  - one in-flight attempt per device, bounded retries with backoff.
 */
export class ConnectionManager extends EventEmitter {
  private devices: KnownDevice[];
  private inFlight = new Map<string, Promise<ConnectOutcome>>();
  private failures = new Map<string, number>();
  private retryTimers = new Map<string, NodeJS.Timeout>();
  private reconnecting = 0;
  private mdnsOk = true;
  private readonly logger: Logger;
  private readonly maxAttempts: number;
  private readonly retryDelay: number;
  private autoReconnect: boolean;
  private lastAdbDevices: Device[] = [];

  private readonly onDevices = (list: Device[]) => this.handleDevices(list);
  private readonly onAdded = (s: MdnsService) => this.handleAdvertised(s);

  constructor(
    private readonly client: AdbClient,
    private readonly tracker: DeviceTracker,
    private readonly browser: MdnsBrowser,
    private readonly store: KnownDeviceStore,
    opts: ConnectionManagerOptions,
  ) {
    super();
    this.devices = store.load();
    this.logger = opts.logger ?? nullLogger;
    this.maxAttempts = opts.maxAttempts ?? 3;
    this.retryDelay = opts.retryDelayMs ?? 2_000;
    this.autoReconnect = opts.autoReconnect;
    tracker.on('devices', this.onDevices);
    browser.on('added', this.onAdded);
  }

  get known(): KnownDevice[] {
    return this.devices;
  }

  get isReconnecting(): boolean {
    return this.reconnecting > 0;
  }

  setAutoReconnect(on: boolean): void {
    this.autoReconnect = on;
    if (!on) this.clearRetries();
  }

  dispose(): void {
    this.clearRetries();
    this.tracker.off('devices', this.onDevices);
    this.browser.off('added', this.onAdded);
    this.removeAllListeners();
  }

  /** Find the known device a live adb device belongs to. */
  match(d: Device): KnownDevice | undefined {
    return this.devices.find(k =>
      (k.guid && d.mdnsName === k.guid) ||
      (k.lastEndpoint && d.endpoint === k.lastEndpoint) ||
      (k.serialNo && d.transport === 'usb' && d.serial === k.serialNo));
  }

  isConnected(k: KnownDevice, list: Device[] = this.tracker.devices): boolean {
    return list.some(d => d.state === 'device' && d.transport === 'wifi' && this.match(d)?.id === k.id);
  }

  /** Manual "Connect by IP:Port" (or connect to a discovered service). Remembers the device on success. */
  async connectEndpoint(endpoint: string, opts: { name?: string; guid?: string } = {}): Promise<ConnectOutcome> {
    if (!validEndpoint(endpoint)) return { ok: false, message: 'Invalid host:port' };
    const r = await this.client.connect(endpoint);
    if (!r.ok) return { ok: false, message: r.message };
    const device = await this.remember(endpoint, opts);
    return { ok: true, message: r.message, device };
  }

  /** Record a device after a successful pairing flow (QR or code). */
  async recordPairing(result: PairingResult): Promise<KnownDevice | undefined> {
    if (result.state !== 'connected' && result.state !== 'paired') return undefined;
    const now = Date.now();
    let k = this.devices.find(d => result.guid && d.guid === result.guid);
    if (result.endpoint) {
      k = await this.remember(result.endpoint, { guid: result.guid, name: result.device?.model, pairedAt: now, connected: result.state === 'connected' });
    } else if (!k && result.guid) {
      k = { id: result.guid, name: result.device?.model ?? result.guid, guid: result.guid, pairedAt: now, autoReconnect: true, userDisconnected: false };
      this.devices = [...this.devices, k];
      await this.persist();
    }
    return k;
  }

  /** Manual disconnect: also suppresses automatic reconnection until the next manual connect. */
  async disconnect(serial: string): Promise<{ ok: boolean; message: string }> {
    const live = this.tracker.devices.find(d => d.serial === serial);
    const k = live ? this.match(live) : this.devices.find(d => d.lastEndpoint === serial);
    if (k) {
      this.cancelRetry(k.id);
      await this.update(k.id, { userDisconnected: true });
    }
    return this.client.disconnect(serial);
  }

  async forget(id: string): Promise<void> {
    this.cancelRetry(id);
    this.failures.delete(id);
    this.devices = this.devices.filter(d => d.id !== id);
    await this.persist();
  }

  async setDeviceAutoReconnect(id: string, on: boolean): Promise<void> {
    await this.update(id, { autoReconnect: on });
  }

  /** Reconnect one known device. `manual` overrides the automatic policy (but still needs an endpoint). */
  reconnect(id: string, reason: ReconnectReason): Promise<ConnectOutcome> {
    const existing = this.inFlight.get(id);
    if (existing) return existing;
    const p = this.doReconnect(id, reason).finally(() => this.inFlight.delete(id));
    this.inFlight.set(id, p);
    return p;
  }

  /** Reconnect every eligible known device (startup / "Reconnect" action). */
  async reconnectAll(reason: 'manual' | 'startup'): Promise<ConnectOutcome[]> {
    this.mdnsOk = await this.client.mdnsAvailable().catch(() => false);
    if (this.mdnsOk) await this.browser.refresh().catch(() => undefined);
    const out: ConnectOutcome[] = [];
    // Sequential on purpose: bounded adb load, and adb serialises connects anyway.
    for (const k of this.devices) {
      if (reason === 'manual' ? !k.userDisconnected : this.eligible(k)) out.push(await this.reconnect(k.id, reason));
    }
    return out;
  }

  private eligible(k: KnownDevice): boolean {
    return this.autoReconnect && k.autoReconnect && !k.userDisconnected && (this.failures.get(k.id) ?? 0) < this.maxAttempts;
  }

  private async doReconnect(id: string, reason: ReconnectReason): Promise<ConnectOutcome> {
    const k = this.devices.find(d => d.id === id);
    if (!k) return { ok: false, message: 'Unknown device' };
    if (reason === 'manual') {
      this.failures.delete(id);
      if (k.userDisconnected) await this.update(id, { userDisconnected: false });
    } else if (!this.eligible(k)) {
      return { ok: false, message: 'Automatic reconnection not allowed for this device', device: k };
    }
    if (this.isConnected(k)) return { ok: true, message: 'Already connected', device: k };

    // Without an active lease the service list may be stale: poll once (bounded, shared with any in-flight poll).
    if (k.guid && reason !== 'advertised' && !this.browser.active) await this.browser.refresh().catch(() => undefined);
    const advertised = k.guid ? this.browser.services.find(s => s.type === 'connect' && s.name === k.guid) : undefined;
    // Blind attempts to an old endpoint only when the user asked, or mDNS can't tell us anything.
    const endpoint = advertised?.endpoint ?? (reason === 'manual' || !this.mdnsOk ? k.lastEndpoint : undefined);
    if (!endpoint) {
      return { ok: false, message: `${k.name} is not advertising. Is Wireless debugging on and the phone on this network?`, device: k };
    }

    this.setReconnecting(+1);
    try {
      const r = await this.client.connect(endpoint);
      if (r.ok) {
        this.failures.delete(id);
        const updated = await this.update(id, { lastEndpoint: endpoint, lastConnectedAt: Date.now() });
        this.logger.log('info', 'Reconnected', { device: k.name, endpoint, reason });
        return { ok: true, message: r.message, device: updated };
      }
      return this.recordFailure(k, r.message, reason);
    } catch (e) {
      return this.recordFailure(k, (e as Error).message, reason);
    } finally {
      this.setReconnecting(-1);
    }
  }

  private recordFailure(k: KnownDevice, message: string, reason: ReconnectReason): ConnectOutcome {
    if (reason !== 'manual') {
      const n = (this.failures.get(k.id) ?? 0) + 1;
      this.failures.set(k.id, n);
      this.logger.log('warn', 'Reconnect failed', { device: k.name, attempt: n, max: this.maxAttempts, reason, error: message });
      if (n >= this.maxAttempts) this.emit('gave-up', k, message);
    }
    return { ok: false, message, device: k };
  }

  /** A known device's connect service appeared (Wireless debugging turned on, new IP/port, network change). */
  private handleAdvertised(s: MdnsService) {
    if (s.type !== 'connect') return;
    const k = this.devices.find(d => d.guid === s.name);
    if (!k) return; // never auto-connect to unknown devices
    if (s.endpoint !== k.lastEndpoint) this.failures.delete(k.id); // new address = fresh chance
    if (this.eligible(k) && !this.isConnected(k)) void this.reconnect(k.id, 'advertised');
  }

  /** A known wireless device dropped off the adb device list: retry with backoff. */
  private handleDevices(list: Device[]) {
    const before = this.lastAdbDevices;
    this.lastAdbDevices = list;
    for (const k of this.devices) {
      const was = this.isConnected(k, before);
      const is = this.isConnected(k, list);
      if (is) this.cancelRetry(k.id);
      else if (was && this.eligible(k)) this.scheduleRetry(k.id, 0);
    }
  }

  private scheduleRetry(id: string, attempt: number) {
    if (this.retryTimers.has(id)) return;
    const delay = this.retryDelay * 2 ** attempt;
    this.retryTimers.set(id, setTimeout(async () => {
      this.retryTimers.delete(id);
      const r = await this.reconnect(id, 'dropped');
      const k = this.devices.find(d => d.id === id);
      if (!r.ok && k && this.eligible(k)) this.scheduleRetry(id, attempt + 1);
    }, delay));
  }

  private cancelRetry(id: string) {
    clearTimeout(this.retryTimers.get(id));
    this.retryTimers.delete(id);
  }

  private clearRetries() {
    for (const t of this.retryTimers.values()) clearTimeout(t);
    this.retryTimers.clear();
  }

  private setReconnecting(delta: number) {
    this.reconnecting += delta;
    this.emit('activity', this.reconnecting);
  }

  private async remember(
    endpoint: string,
    opts: { name?: string; guid?: string; pairedAt?: number; connected?: boolean },
  ): Promise<KnownDevice> {
    const live = (await this.client.devices().catch(() => [] as Device[]))
      .find(d => d.endpoint === endpoint || (opts.guid && d.mdnsName === opts.guid));
    const guid = opts.guid ?? live?.mdnsName ??
      this.browser.services.find(s => s.type === 'connect' && s.endpoint === endpoint)?.name;
    const serialNo = live && live.state === 'device'
      ? await this.client.getProp(live.serial, 'ro.serialno').catch(() => undefined)
      : undefined;
    const name = opts.name ?? live?.model ?? endpoint;
    const existing = this.devices.find(d =>
      (guid && d.guid === guid) || (serialNo && d.serialNo === serialNo) || d.lastEndpoint === endpoint);
    const now = Date.now();
    const next: KnownDevice = {
      id: existing?.id ?? guid ?? serialNo ?? endpoint,
      name,
      guid: guid ?? existing?.guid,
      serialNo: serialNo ?? existing?.serialNo,
      lastEndpoint: endpoint,
      pairedAt: opts.pairedAt ?? existing?.pairedAt,
      lastConnectedAt: opts.connected === false ? existing?.lastConnectedAt : now,
      autoReconnect: existing?.autoReconnect ?? true,
      userDisconnected: false,
    };
    this.failures.delete(next.id);
    this.devices = existing ? this.devices.map(d => (d.id === existing.id ? next : d)) : [...this.devices, next];
    await this.persist();
    return next;
  }

  private async update(id: string, patch: Partial<KnownDevice>): Promise<KnownDevice | undefined> {
    let updated: KnownDevice | undefined;
    this.devices = this.devices.map(d => (d.id === id ? (updated = { ...d, ...patch }) : d));
    if (updated) await this.persist();
    return updated;
  }

  private async persist() {
    await this.store.save(this.devices);
    this.emit('known', this.devices);
  }
}
