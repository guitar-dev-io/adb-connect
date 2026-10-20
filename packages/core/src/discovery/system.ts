import { spawn, ChildProcessWithoutNullStreams } from 'child_process';
import net from 'net';
import { MdnsService, MdnsServiceType, serviceKey } from './parse';
import { Logger, nullLogger } from '../log';

const TYPES: Record<MdnsServiceType, string> = { connect: '_adb-tls-connect._tcp', pairing: '_adb-tls-pairing._tcp' };

/**
 * Event-driven discovery through the operating system's mDNS resolver, used next to `adb mdns services`.
 * Some adb builds/environments see nothing (e.g. a firewall or endpoint-security product drops the adb
 * server's own multicast, or the adb mDNS backend is disabled) while the OS resolver works.
 *
 *  - macOS:  dns-sd -B (browse, streaming) → dns-sd -L (resolve host:port) → dns-sd -G v4 (address)
 *  - Linux:  avahi-browse -p -r -k (browse + resolve, streaming)
 *  - other:  not available (adb's backend only)
 */
export class SystemMdns {
  private procs: ChildProcessWithoutNullStreams[] = [];
  private services = new Map<string, MdnsService>();
  private running = false;
  private readonly logger: Logger;

  constructor(private readonly onChange: () => void, opts: { logger?: Logger; platform?: NodeJS.Platform } = {}) {
    this.logger = opts.logger ?? nullLogger;
    this.platform = opts.platform ?? process.platform;
  }

  private readonly platform: NodeJS.Platform;

  get supported(): boolean {
    return this.platform === 'darwin' || this.platform === 'linux';
  }

  get list(): MdnsService[] {
    return [...this.services.values()];
  }

  start(): void {
    if (this.running || !this.supported) return;
    this.running = true;
    for (const type of Object.keys(TYPES) as MdnsServiceType[]) {
      if (this.platform === 'darwin') this.browseDnsSd(type);
      else this.browseAvahi(type);
    }
  }

  stop(): void {
    this.running = false;
    for (const p of this.procs) p.kill();
    this.procs = [];
    this.services.clear();
  }

  private spawnTool(cmd: string, args: string[]): ChildProcessWithoutNullStreams | undefined {
    try {
      const p = spawn(cmd, args, { stdio: 'pipe', windowsHide: true });
      p.on('error', e => this.logger.log('debug', `${cmd} unavailable`, { error: e.message }));
      return p;
    } catch {
      return undefined;
    }
  }

  private lines(p: ChildProcessWithoutNullStreams, onLine: (l: string) => void) {
    let buf = '';
    p.stdout.on('data', (b: Buffer) => {
      buf += b.toString();
      let i;
      while ((i = buf.indexOf('\n')) >= 0) {
        onLine(buf.slice(0, i).replace(/\r$/, ''));
        buf = buf.slice(i + 1);
      }
    });
  }

  private set(s: MdnsService | undefined, removeKeyPrefix?: string) {
    if (removeKeyPrefix) {
      for (const k of [...this.services.keys()]) if (k.startsWith(removeKeyPrefix)) this.services.delete(k);
    }
    if (s) this.services.set(`${s.type}|${s.name}|`, s);
    this.onChange();
  }

  // ---- macOS (mDNSResponder) ----

  private browseDnsSd(type: MdnsServiceType) {
    const p = this.spawnTool('dns-sd', ['-B', TYPES[type], 'local.']);
    if (!p) return;
    this.procs.push(p);
    // "18:10:19.983  Add        3  14 local.               _adb-tls-connect._tcp. adb-67d277cf-nR0Tpv"
    const re = /^\S+\s+(Add|Rmv)\s+\d+\s+\d+\s+\S+\s+_adb-tls-(?:connect|pairing)\._tcp\.\s+(.+)$/;
    this.lines(p, line => {
      const m = line.match(re);
      if (!m) return;
      // mDNS conflict renames ("name (2)") happen when a stale cached record of the same device exists.
      const name = m[2].trim().replace(/ \(\d+\)$/, '');
      if (m[1] === 'Rmv') this.set(undefined, `${type}|${name}|`);
      else void this.resolveDnsSd(type, name);
    });
  }

  /** Run a dns-sd query until the first matching line (dns-sd never exits on its own). */
  private dnsSdOnce(args: string[], re: RegExp, timeoutMs = 4_000): Promise<RegExpMatchArray | undefined> {
    return new Promise(resolve => {
      const p = this.spawnTool('dns-sd', args);
      if (!p) return resolve(undefined);
      const timer = setTimeout(() => { p.kill(); resolve(undefined); }, timeoutMs);
      this.lines(p, l => {
        const m = l.match(re);
        if (m) { clearTimeout(timer); p.kill(); resolve(m); }
      });
      p.on('close', () => { clearTimeout(timer); resolve(undefined); });
    });
  }

  private async resolveDnsSd(type: MdnsServiceType, name: string) {
    // Resolve the newest instance first (the renamed one), falling back to the base name.
    const srv = await this.dnsSdOnce(['-L', `${name} (2)`, TYPES[type], 'local.'], /can be reached at (\S+?)\.?:(\d+)/, 1_500)
      ?? await this.dnsSdOnce(['-L', name, TYPES[type], 'local.'], /can be reached at (\S+?)\.?:(\d+)/);
    if (!srv || !this.running) return;
    const [, host, port] = srv;
    const addr = net.isIP(host) ? host : (await this.dnsSdOnce(['-G', 'v4', host], /\s(\d+\.\d+\.\d+\.\d+)\s/))?.[1];
    if (!addr || !this.running) return;
    const endpoint = `${addr}:${port}`;
    this.logger.log('debug', 'System mDNS resolved', { type, name, endpoint });
    this.set({ name, type, endpoint, host: addr, port: Number(port) }, `${type}|${name}|`);
  }

  // ---- Linux (Avahi) ----

  private browseAvahi(type: MdnsServiceType) {
    const p = this.spawnTool('avahi-browse', ['-p', '-r', '-k', TYPES[type]]);
    if (!p) return;
    this.procs.push(p);
    // "=;wlan0;IPv4;adb-XXX-yyy;_adb-tls-connect._tcp;local;Android.local;192.168.1.10;37123;"
    this.lines(p, line => {
      const f = line.split(';');
      if (f[0] === '-' && f.length >= 4) this.set(undefined, `${type}|${f[3]}|`);
      if (f[0] !== '=' || f[2] !== 'IPv4' || f.length < 9 || !net.isIP(f[7])) return;
      const name = f[3].replace(/\\(\d{3})/g, (_, d) => String.fromCharCode(Number(d)));
      this.set({ name, type, endpoint: `${f[7]}:${f[8]}`, host: f[7], port: Number(f[8]) }, `${type}|${name}|`);
    });
  }
}

/** Merge adb's and the system's view; adb wins on conflicts (it is what `adb pair/connect` will use). */
export function mergeServices(fromAdb: MdnsService[], fromSystem: MdnsService[]): MdnsService[] {
  const out = new Map(fromAdb.map(s => [`${s.type}|${s.name}`, s]));
  for (const s of fromSystem) if (!out.has(`${s.type}|${s.name}`)) out.set(`${s.type}|${s.name}`, s);
  return [...out.values()].sort((a, b) => serviceKey(a).localeCompare(serviceKey(b)));
}
