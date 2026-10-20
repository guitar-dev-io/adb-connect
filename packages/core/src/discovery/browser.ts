import { EventEmitter } from 'events';
import { AdbClient } from '../adb/client';
import { MdnsService, serviceKey } from './parse';
import { SystemMdns, mergeServices } from './system';
import { Logger, nullLogger } from '../log';

export interface MdnsBrowserOptions {
  logger?: Logger;
  /** Poll interval while at least one lease is held. Default 3s. */
  intervalMs?: number;
  /** Cap for the interval after repeated failures. Default 60s. */
  maxIntervalMs?: number;
  /** Also browse with the OS resolver (dns-sd / avahi). Default true. */
  systemResolver?: boolean;
}

export interface MdnsBrowserEvents {
  services: (all: MdnsService[]) => void;
  added: (s: MdnsService) => void;
  removed: (s: MdnsService) => void;
  failure: (message: string) => void;
}

export declare interface MdnsBrowser {
  on<E extends keyof MdnsBrowserEvents>(event: E, listener: MdnsBrowserEvents[E]): this;
  off<E extends keyof MdnsBrowserEvents>(event: E, listener: MdnsBrowserEvents[E]): this;
  emit<E extends keyof MdnsBrowserEvents>(event: E, ...args: Parameters<MdnsBrowserEvents[E]>): boolean;
}

export interface Lease {
  dispose(): void;
}

/**
 * Watches `_adb-tls-pairing._tcp` / `_adb-tls-connect._tcp` through the adb server's own mDNS
 * backend. adb exposes no event stream for mDNS, so this polls — but only while someone holds a
 * lease, never with overlapping calls, and with backoff on errors.
 */
export class MdnsBrowser extends EventEmitter {
  private leases = 0;
  private timer?: NodeJS.Timeout;
  private inFlight = false;
  private known = new Map<string, MdnsService>();
  private failures = 0;
  private readonly logger: Logger;
  private readonly interval: number;
  private readonly maxInterval: number;
  private readonly system?: SystemMdns;
  private fromAdb: MdnsService[] = [];

  constructor(private readonly client: AdbClient, opts: MdnsBrowserOptions = {}) {
    super();
    this.logger = opts.logger ?? nullLogger;
    this.interval = opts.intervalMs ?? 3_000;
    this.maxInterval = opts.maxIntervalMs ?? 60_000;
    if (opts.systemResolver !== false) {
      const sys = new SystemMdns(() => this.apply(mergeServices(this.fromAdb, sys.list)), { logger: this.logger });
      if (sys.supported) this.system = sys;
    }
  }

  get services(): MdnsService[] {
    return [...this.known.values()];
  }

  get active(): boolean {
    return this.leases > 0;
  }

  /** Start (or keep) browsing until the returned lease is disposed. */
  acquire(): Lease {
    this.leases++;
    if (this.leases === 1) {
      this.system?.start();
      this.schedule(0);
    }
    let disposed = false;
    return {
      dispose: () => {
        if (disposed) return;
        disposed = true;
        this.leases--;
        if (this.leases === 0) {
          clearTimeout(this.timer);
          this.timer = undefined;
          this.system?.stop();
        }
      },
    };
  }

  /** Poll once now (shares an in-flight poll). */
  async refresh(): Promise<MdnsService[]> {
    await this.poll();
    return this.services;
  }

  /**
   * Resolve with the first service matching `predicate`, holding a lease meanwhile.
   * Rejects on timeout or abort.
   */
  waitFor(predicate: (s: MdnsService) => boolean, opts: { timeoutMs: number; signal?: AbortSignal }): Promise<MdnsService> {
    return new Promise((resolve, reject) => {
      const existing = this.services.find(predicate);
      if (existing) return resolve(existing);
      const lease = this.acquire();
      const cleanup = () => {
        lease.dispose();
        clearTimeout(timer);
        this.off('services', onServices);
        opts.signal?.removeEventListener('abort', onAbort);
      };
      const onServices = (all: MdnsService[]) => {
        const hit = all.find(predicate);
        if (hit) {
          cleanup();
          resolve(hit);
        }
      };
      const onAbort = () => {
        cleanup();
        reject(Object.assign(new Error('cancelled'), { code: 'cancelled' }));
      };
      const timer = setTimeout(() => {
        cleanup();
        reject(Object.assign(new Error('timeout'), { code: 'timeout' }));
      }, opts.timeoutMs);
      if (opts.signal?.aborted) return onAbort();
      opts.signal?.addEventListener('abort', onAbort, { once: true });
      this.on('services', onServices);
    });
  }

  dispose(): void {
    this.system?.stop();
    this.leases = 0;
    clearTimeout(this.timer);
    this.timer = undefined;
    this.removeAllListeners();
  }

  private schedule(delay: number) {
    clearTimeout(this.timer);
    this.timer = setTimeout(async () => {
      await this.poll();
      if (this.leases > 0) {
        const backoff = Math.min(this.interval * 2 ** Math.min(this.failures, 6), this.maxInterval);
        this.schedule(this.failures ? backoff : this.interval);
      }
    }, delay);
  }

  private pending?: Promise<void>;

  private poll(): Promise<void> {
    if (this.inFlight && this.pending) return this.pending;
    this.inFlight = true;
    this.pending = (async () => {
      try {
        this.fromAdb = await this.client.mdnsServices();
        this.failures = 0;
        this.apply(mergeServices(this.fromAdb, this.system?.list ?? []));
      } catch (e) {
        this.failures++;
        const msg = (e as Error).message;
        this.logger.log('warn', 'mDNS discovery failed', { error: msg, failures: this.failures });
        this.emit('failure', msg);
      } finally {
        this.inFlight = false;
      }
    })();
    return this.pending;
  }

  private apply(list: MdnsService[]) {
    const prev = this.known;
    const next = new Map(list.map(s => [serviceKey(s), s]));
    // Update first so listeners reading `services` see the new state.
    this.known = next;
    for (const [k, s] of prev) if (!next.has(k)) this.emit('removed', s);
    for (const [k, s] of next) if (!prev.has(k)) this.emit('added', s);
    this.emit('services', list);
  }
}
