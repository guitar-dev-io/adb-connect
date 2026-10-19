import { AdbClient, AdbClientOptions } from './adb/client';
import { DeviceTracker } from './devices/tracker';
import { MdnsBrowser } from './discovery/browser';
import { ConnectionManager } from './connection/manager';
import { KnownDeviceStore, MemoryKnownDeviceStore } from './connection/known';
import { buildDeviceEntries, DeviceEntry } from './devices/model';
import { QrPairingSession, pairWithCode, PairingOptions, PairingResult } from './pairing/session';
import { Logger, nullLogger } from './log';

export interface AdbEngineOptions extends AdbClientOptions {
  store?: KnownDeviceStore;
  autoReconnect?: boolean;
  logger?: Logger;
  mdnsIntervalMs?: number;
}

/** Everything an IDE integration needs, wired together. IDE code adds UI, settings and persistence. */
export class AdbEngine {
  private constructor(
    readonly client: AdbClient,
    readonly tracker: DeviceTracker,
    readonly browser: MdnsBrowser,
    readonly connections: ConnectionManager,
    private readonly logger: Logger,
  ) {}

  static async create(opts: AdbEngineOptions = {}): Promise<AdbEngine> {
    const logger = opts.logger ?? nullLogger;
    const client = await AdbClient.create({ ...opts, logger });
    const tracker = new DeviceTracker(client.runner, { logger });
    const browser = new MdnsBrowser(client, { logger, intervalMs: opts.mdnsIntervalMs });
    const connections = new ConnectionManager(client, tracker, browser, opts.store ?? new MemoryKnownDeviceStore(), {
      autoReconnect: opts.autoReconnect ?? true,
      logger,
    });
    return new AdbEngine(client, tracker, browser, connections, logger);
  }

  start(): void {
    this.tracker.start();
  }

  entries(preferredId?: string): DeviceEntry[] {
    return buildDeviceEntries(
      this.tracker.devices,
      this.connections.known,
      this.browser.services,
      d => this.connections.match(d),
      preferredId,
    );
  }

  createQrSession(opts: Omit<PairingOptions, 'signal'> = {}): QrPairingSession {
    return new QrPairingSession(this.client, this.browser, { logger: this.logger, ...opts });
  }

  async pairWithCode(endpoint: string, code: string, opts: PairingOptions = {}): Promise<PairingResult> {
    const r = await pairWithCode(this.client, this.browser, endpoint, code, { logger: this.logger, ...opts });
    await this.connections.recordPairing(r);
    return r;
  }

  dispose(): void {
    this.connections.dispose();
    this.browser.dispose();
    this.tracker.stop();
  }
}
