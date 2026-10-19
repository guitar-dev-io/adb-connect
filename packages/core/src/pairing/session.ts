import { EventEmitter } from 'events';
import { AdbClient } from '../adb/client';
import { MdnsBrowser } from '../discovery/browser';
import { MdnsService } from '../discovery/parse';
import { Device } from '../devices/parse';
import { parseEndpoint } from '../connection/endpoint';
import { createQrCredentials, qrPayload, QrCredentials } from './qr';
import { Logger, nullLogger } from '../log';

export type PairingState =
  | 'waiting-for-scan'
  | 'pairing'
  | 'connecting'
  | 'connected'
  /** Paired, but the device's connect service did not show up in time. */
  | 'paired'
  | 'failed'
  | 'timeout'
  | 'cancelled';

export interface PairingUpdate {
  state: PairingState;
  message: string;
  guid?: string;
  /** Endpoint of the connect service once known. */
  endpoint?: string;
  device?: Device;
}

export interface PairingResult extends PairingUpdate {
  state: 'connected' | 'paired' | 'failed' | 'timeout' | 'cancelled';
}

export interface PairingOptions {
  logger?: Logger;
  /** How long to wait for the phone to scan / advertise. Default 120s. */
  scanTimeoutMs?: number;
  /** How long to wait for the connect service after pairing. Default 20s. */
  connectTimeoutMs?: number;
  signal?: AbortSignal;
  onUpdate?: (u: PairingUpdate) => void;
}

const isCancel = (e: unknown) => (e as { code?: string })?.code === 'cancelled' || /cancelled/i.test((e as Error)?.message ?? '');
const isTimeout = (e: unknown) => (e as { code?: string })?.code === 'timeout';

/**
 * After a successful `adb pair`, find the device's `_adb-tls-connect._tcp` service and make sure
 * a transport exists. adb ≥ 31 often auto-connects on its own; we only `adb connect` if not.
 */
export async function connectAfterPair(
  client: AdbClient,
  browser: MdnsBrowser,
  paired: { guid?: string; pairEndpoint: string },
  opts: PairingOptions,
): Promise<PairingResult> {
  const emit = (u: PairingUpdate) => opts.onUpdate?.(u);
  const pairHost = parseEndpoint(paired.pairEndpoint)?.host;
  emit({ state: 'connecting', message: 'Paired. Connecting…', guid: paired.guid });

  // Prefer the GUID match; without a GUID (older adb) fall back to a connect service on the same host.
  const matches = (s: MdnsService) =>
    s.type === 'connect' && (paired.guid ? s.name === paired.guid : s.host === pairHost);

  let service: MdnsService;
  try {
    service = await browser.waitFor(matches, { timeoutMs: opts.connectTimeoutMs ?? 20_000, signal: opts.signal });
  } catch (e) {
    if (isCancel(e)) return { state: 'cancelled', message: 'Cancelled after pairing', guid: paired.guid };
    return {
      state: 'paired',
      guid: paired.guid,
      message: 'Paired, but the device did not advertise a connect address. Use "Connect by IP:Port" with the address shown under Wireless debugging.',
    };
  }

  const findDevice = (list: Device[]) =>
    list.find(d => d.state === 'device' && ((paired.guid && d.mdnsName === paired.guid) || d.endpoint === service.endpoint));

  let device = findDevice(await client.devices({ signal: opts.signal }).catch(() => []));
  if (!device) {
    const r = await client.connect(service.endpoint, { signal: opts.signal });
    if (!r.ok) {
      return { state: 'paired', guid: paired.guid, endpoint: service.endpoint, message: `Paired, but connecting failed: ${r.message}` };
    }
    device = findDevice(await client.devices({ signal: opts.signal }).catch(() => []));
  }
  return {
    state: 'connected',
    guid: paired.guid,
    endpoint: service.endpoint,
    device,
    message: `Connected to ${device?.model ?? service.endpoint}`,
  };
}

/** Six-digit pairing code flow ("Pair device with pairing code"). */
export async function pairWithCode(
  client: AdbClient,
  browser: MdnsBrowser,
  endpoint: string,
  code: string,
  opts: PairingOptions = {},
): Promise<PairingResult> {
  opts.onUpdate?.({ state: 'pairing', message: `Pairing with ${endpoint}…` });
  try {
    const r = await client.pairWithCode(endpoint, code, { signal: opts.signal });
    if (!r.ok) return { state: 'failed', message: r.message };
    return await connectAfterPair(client, browser, { guid: r.guid, pairEndpoint: endpoint }, opts);
  } catch (e) {
    if (isCancel(e)) return { state: 'cancelled', message: 'Pairing cancelled' };
    return { state: 'failed', message: (e as Error).message };
  }
}

/**
 * One QR pairing attempt. Create, show `payload` as a QR code, then `run()`.
 * Credentials are single-use and kept only in memory.
 */
export class QrPairingSession extends EventEmitter {
  readonly credentials: QrCredentials;
  readonly payload: string;
  private readonly abort = new AbortController();
  private readonly logger: Logger;
  private last?: PairingUpdate;

  constructor(
    private readonly client: AdbClient,
    private readonly browser: MdnsBrowser,
    private readonly opts: Omit<PairingOptions, 'signal'> = {},
    credentials: QrCredentials = createQrCredentials(),
  ) {
    super();
    this.credentials = credentials;
    this.payload = qrPayload(credentials);
    this.logger = opts.logger ?? nullLogger;
  }

  get state(): PairingUpdate | undefined {
    return this.last;
  }

  cancel(): void {
    this.abort.abort();
  }

  async run(): Promise<PairingResult> {
    const signal = this.abort.signal;
    const update = (u: PairingUpdate) => {
      this.last = u;
      this.opts.onUpdate?.(u);
      this.emit('update', u);
    };
    const finish = (r: PairingResult) => {
      update(r);
      this.logger.log(r.state === 'connected' ? 'info' : 'warn', `QR pairing ${r.state}`, { guid: r.guid, endpoint: r.endpoint });
      return r;
    };

    if (!this.client.info.wirelessPairing) {
      return finish({ state: 'failed', message: 'QR pairing needs Android SDK Platform-Tools 31 or newer.' });
    }
    if (!(await this.client.mdnsAvailable({ signal }).catch(() => false))) {
      return finish({ state: 'failed', message: 'The adb server mDNS backend is unavailable, so QR pairing cannot discover the phone. Use the pairing code instead.' });
    }

    update({ state: 'waiting-for-scan', message: 'Scan the QR code from Wireless debugging > Pair device with QR code' });
    let service: MdnsService;
    try {
      service = await this.browser.waitFor(
        s => s.type === 'pairing' && s.name === this.credentials.serviceName,
        { timeoutMs: this.opts.scanTimeoutMs ?? 120_000, signal },
      );
    } catch (e) {
      if (isTimeout(e)) return finish({ state: 'timeout', message: 'No phone scanned the QR code in time.' });
      return finish({ state: 'cancelled', message: 'QR pairing cancelled' });
    }

    update({ state: 'pairing', message: `Pairing with ${service.endpoint}…`, endpoint: service.endpoint });
    try {
      const r = await this.client.pair(service.endpoint, this.credentials.password, { signal });
      if (!r.ok) return finish({ state: 'failed', message: r.message });
      const done = await connectAfterPair(this.client, this.browser, { guid: r.guid, pairEndpoint: service.endpoint }, {
        ...this.opts,
        signal,
        onUpdate: update,
      });
      return finish(done);
    } catch (e) {
      if (isCancel(e)) return finish({ state: 'cancelled', message: 'QR pairing cancelled' });
      return finish({ state: 'failed', message: (e as Error).message });
    }
  }
}
