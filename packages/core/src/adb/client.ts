import { AdbRunner, AdbError, RunOptions } from './runner';
import { locateAdb, AdbLocation, LocateOptions } from './locate';
import { parseAdbVersion, supportsWirelessPairing, AdbVersionInfo, MIN_PLATFORM_TOOLS } from './version';
import { parseDevices, Device } from '../devices/parse';
import { parseMdns, MdnsService } from '../discovery/parse';
import { parsePairOutput, parseConnectOutput, PairOutcome } from '../pairing/parse';
import { validEndpoint, validPairingCode } from '../connection/endpoint';
import { Logger, nullLogger } from '../log';
import { diagnoseUnreachable } from './diagnose';

export interface OpResult {
  ok: boolean;
  message: string;
}

export interface AdbClientOptions extends LocateOptions {
  logger?: Logger;
  maxConcurrent?: number;
}

export interface AdbInfo {
  location: AdbLocation;
  version: AdbVersionInfo;
  wirelessPairing: boolean;
}

/**
 * Thin, typed wrapper around the adb CLI. All pairing crypto (SPAKE2 + TLS) is done by adb itself;
 * this layer only orchestrates and validates inputs.
 */
export class AdbClient {
  private constructor(readonly runner: AdbRunner, readonly info: AdbInfo) {}

  /** Locate adb and validate its version. Throws AdbError('not-found' | 'version'). */
  static async create(opts: AdbClientOptions = {}): Promise<AdbClient> {
    const location = locateAdb(opts);
    if (!location) {
      throw new AdbError(
        opts.configuredPath && opts.configuredPath !== 'adb'
          ? `adb not found at configured path: ${opts.configuredPath}`
          : 'adb not found. Install Android SDK Platform-Tools or set the adb path.',
        'not-found',
      );
    }
    const runner = new AdbRunner({ adbPath: location.path, logger: opts.logger ?? nullLogger, maxConcurrent: opts.maxConcurrent });
    const r = await runner.run(['version'], { timeoutMs: 5_000 });
    const version = parseAdbVersion(r.text);
    if (!version) throw new AdbError(`Unrecognised adb version output from ${location.path}`, 'version');
    return new AdbClient(runner, { location, version, wirelessPairing: supportsWirelessPairing(version) });
  }

  /** For tests and callers that already validated the executable. */
  static fromRunner(runner: AdbRunner, info: AdbInfo): AdbClient {
    return new AdbClient(runner, info);
  }

  get path(): string {
    return this.runner.adbPath;
  }

  async devices(opts?: RunOptions): Promise<Device[]> {
    const r = await this.runner.run(['devices', '-l'], { timeoutMs: 8_000, ...opts });
    if (r.code !== 0) throw new Error(r.text || 'adb devices failed');
    return parseDevices(r.stdout);
  }

  async mdnsServices(opts?: RunOptions): Promise<MdnsService[]> {
    const r = await this.runner.run(['mdns', 'services'], { timeoutMs: 6_000, ...opts });
    if (r.code !== 0) throw new Error(r.text || 'adb mdns services failed');
    return parseMdns(r.stdout);
  }

  /** Whether the adb server's mDNS backend is running. */
  async mdnsAvailable(opts?: RunOptions): Promise<boolean> {
    try {
      const r = await this.runner.run(['mdns', 'check'], { timeoutMs: 5_000, ...opts });
      return r.code === 0 && !/error|unavailable/i.test(r.text);
    } catch {
      return false;
    }
  }

  /** `adb pair`. `secret` is a 6-digit code or a QR password; it is redacted from logs and output. */
  async pair(endpoint: string, secret: string, opts?: RunOptions): Promise<PairOutcome> {
    if (!this.info.wirelessPairing) {
      return { ok: false, message: `Wireless pairing needs Android SDK Platform-Tools ${MIN_PLATFORM_TOOLS} or newer` };
    }
    if (!validEndpoint(endpoint)) return { ok: false, message: 'Invalid pairing host:port' };
    if (!secret || /[\s;]/.test(secret)) return { ok: false, message: 'Invalid pairing secret' };
    const r = await this.runner.run(['pair', endpoint, secret], { timeoutMs: 30_000, ...opts, secrets: [secret] });
    const out = parsePairOutput(r.text);
    if (!out.ok) {
      const hint = await diagnoseUnreachable(endpoint, r.text);
      if (hint) return { ...out, message: `${out.message}\n${hint}` };
    }
    return out;
  }

  async pairWithCode(endpoint: string, code: string, opts?: RunOptions): Promise<PairOutcome> {
    if (!validPairingCode(code)) return { ok: false, message: 'Pairing code must be exactly 6 digits' };
    return this.pair(endpoint, code, opts);
  }

  async connect(endpoint: string, opts?: RunOptions): Promise<OpResult & { already: boolean }> {
    if (!validEndpoint(endpoint)) return { ok: false, already: false, message: 'Invalid host:port' };
    const r = await this.runner.run(['connect', endpoint], { timeoutMs: 15_000, ...opts });
    const out = parseConnectOutput(r.text);
    if (!out.ok) {
      const hint = await diagnoseUnreachable(endpoint, r.text);
      if (hint) return { ...out, message: `${out.message}\n${hint}` };
    }
    return out;
  }

  /** Disconnect one wireless transport. Never used with no argument (that would drop every device). */
  async disconnect(serial: string, opts?: RunOptions): Promise<OpResult> {
    // No shell is involved, so spaces (mDNS renames) are fine; reject flags and control characters.
    if (!serial || serial.startsWith('-') || /[\x00-\x1f]/.test(serial)) return { ok: false, message: 'Invalid device serial' };
    const r = await this.runner.run(['disconnect', serial], { timeoutMs: 10_000, ...opts });
    return { ok: r.code === 0 && !/error|no such device/i.test(r.text), message: r.text || 'adb disconnect failed' };
  }

  async getProp(serial: string, prop: string, opts?: RunOptions): Promise<string | undefined> {
    if (!/^[a-z0-9._]+$/i.test(prop)) throw new Error('Invalid property name');
    const r = await this.runner.run(['-s', serial, 'shell', 'getprop', prop], { timeoutMs: 6_000, ...opts });
    const v = r.stdout.trim();
    return r.code === 0 && v ? v : undefined;
  }
}
