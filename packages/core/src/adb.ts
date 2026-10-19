import { execFile, spawn } from 'child_process';
import net from 'net';
import { promisify } from 'util';

const execFileAsync = promisify(execFile);

export interface AdbResult {
  code: number | null;
  stdout: string;
  stderr: string;
  /** stdout and stderr joined, trimmed. adb prints many failures to stdout with exit code 0. */
  text: string;
}

export type DeviceStatus =
  | 'device'
  | 'offline'
  | 'unauthorized'
  | 'recovery'
  | 'sideload'
  | 'bootloader'
  | 'no permissions';

export interface Device {
  serial: string;
  status: DeviceStatus;
  model: string;
  transport: 'Wi-Fi' | 'USB';
  attrs: Record<string, string>;
}

export interface MdnsService {
  service: '_adb-tls-connect._tcp' | '_adb-tls-pairing._tcp';
  name: string;
  endpoint: string;
}

export interface OpResult {
  ok: boolean;
  message: string;
}

const MAX_OUTPUT = 100_000;

/** host:port where host is IPv4, bracketed IPv6, or a plain DNS name. Rejects anything shell-like. */
export function validEndpoint(value: unknown): boolean {
  const s = String(value ?? '').trim();
  const m = s.match(/^(\[[0-9a-fA-F:.]+(?:%[A-Za-z0-9_.-]+)?\]|[A-Za-z0-9.-]+):(\d{1,5})$/);
  if (!m) return false;
  const host = m[1];
  const port = Number(m[2]);
  if (port < 1 || port > 65535) return false;
  if (host.startsWith('[')) return net.isIP(host.slice(1, -1).split('%')[0]) === 6;
  return net.isIP(host) === 4 || /^(?=.{1,253}$)[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?$/i.test(host);
}

export function validPairingCode(value: unknown): boolean {
  return /^\d{6}$/.test(String(value ?? ''));
}

export function runAdb(adbPath: string | undefined, args: string[], timeoutMs = 12_000): Promise<AdbResult> {
  const adb = adbPath || 'adb';
  return new Promise((resolve, reject) => {
    let done = false;
    let out = '';
    let err = '';
    const cp = spawn(adb, args, { windowsHide: true, shell: false, stdio: ['ignore', 'pipe', 'pipe'] });
    const finish = (error: Error | null, result?: AdbResult) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      if (error) reject(error);
      else resolve(result!);
    };
    const timer = setTimeout(() => {
      cp.kill();
      finish(new Error(`adb ${args[0] ?? ''} timed out after ${timeoutMs} ms`));
    }, timeoutMs);
    cp.stdout.on('data', (b: Buffer) => { out = (out + b.toString()).slice(-MAX_OUTPUT); });
    cp.stderr.on('data', (b: Buffer) => { err = (err + b.toString()).slice(-MAX_OUTPUT); });
    cp.on('error', e => finish(new Error(`Cannot run adb (${adb}): ${e.message}`)));
    cp.on('close', code => finish(null, { code, stdout: out, stderr: err, text: `${out}\n${err}`.trim() }));
  });
}

export function parseDevices(text: string): Device[] {
  const devices: Device[] = [];
  for (const line of String(text).split(/\r?\n/).slice(1)) {
    const m = line.trim().match(/^(\S+)\s+(device|offline|unauthorized|recovery|sideload|bootloader|no permissions)(?:\s+(.*))?$/);
    if (!m) continue;
    const attrs: Record<string, string> = {};
    for (const token of (m[3] || '').split(/\s+/)) {
      const p = token.indexOf(':');
      if (p > 0) attrs[token.slice(0, p)] = token.slice(p + 1);
    }
    devices.push({
      serial: m[1],
      status: m[2] as DeviceStatus,
      model: (attrs.model || attrs.device || m[1]).replace(/_/g, ' '),
      transport: m[1].includes(':') || m[1].includes('._adb-tls-connect.') ? 'Wi-Fi' : 'USB',
      attrs,
    });
  }
  return devices;
}

export function parseMdns(text: string): MdnsService[] {
  const services: MdnsService[] = [];
  for (const line of String(text).split(/\r?\n/)) {
    const m = line.match(/^(.*?)\s+(_adb-tls-(?:connect|pairing)\._tcp)\.?\s+(\S+:\d+)\s*$/);
    if (m && validEndpoint(m[3])) {
      services.push({ service: m[2] as MdnsService['service'], name: m[1].trim(), endpoint: m[3] });
    }
  }
  return services;
}

/** adb exits 0 on many failures; look at the text too. */
function looksFailed(r: AdbResult): boolean {
  return r.code !== 0 || /failed to|cannot connect|unable to|error:/i.test(r.text);
}

export async function findAdb(): Promise<string | null> {
  try {
    const cmd = process.platform === 'win32' ? 'where' : 'which';
    const { stdout } = await execFileAsync(cmd, ['adb']);
    return stdout.split(/\r?\n/)[0].trim() || null;
  } catch {
    return null;
  }
}

export async function adbVersion(adbPath?: string): Promise<{ ok: boolean; version?: string; raw?: string }> {
  try {
    const r = await runAdb(adbPath, ['version'], 5_000);
    const m = r.text.match(/Android Debug Bridge version ([0-9.]+)/i);
    return { ok: r.code === 0, version: m ? m[1] : undefined, raw: r.text };
  } catch (err) {
    return { ok: false, raw: String((err as Error).message ?? err) };
  }
}

export async function listDevices(adbPath?: string): Promise<{ ok: boolean; devices: Device[]; raw?: string }> {
  try {
    const r = await runAdb(adbPath, ['devices', '-l'], 8_000);
    if (r.code !== 0) return { ok: false, devices: [], raw: r.text };
    return { ok: true, devices: parseDevices(r.stdout), raw: r.stdout };
  } catch (err) {
    return { ok: false, devices: [], raw: String((err as Error).message ?? err) };
  }
}

/** Pair using Android's "Pair device with pairing code". The code is never included in the returned message. */
export async function pair(adbPath: string | undefined, endpoint: string, code: string): Promise<OpResult> {
  if (!validEndpoint(endpoint)) return { ok: false, message: 'Invalid pairing host:port' };
  if (!validPairingCode(code)) return { ok: false, message: 'Pairing code must be exactly 6 digits' };
  const r = await runAdb(adbPath, ['pair', endpoint, code], 30_000);
  const message = r.text.split(code).join('[REDACTED]');
  return { ok: !looksFailed(r) && /successfully paired/i.test(r.text), message: message || 'adb pair failed' };
}

export async function connect(adbPath: string | undefined, endpoint: string, timeoutMs = 15_000): Promise<OpResult> {
  if (!validEndpoint(endpoint)) return { ok: false, message: 'Invalid host:port' };
  const r = await runAdb(adbPath, ['connect', endpoint], timeoutMs);
  return { ok: !looksFailed(r) && /connected to/i.test(r.text), message: r.text || 'adb connect failed' };
}

export async function disconnect(adbPath: string | undefined, endpoint: string): Promise<OpResult> {
  if (!validEndpoint(endpoint)) return { ok: false, message: 'Only wireless host:port endpoints can be disconnected' };
  const r = await runAdb(adbPath, ['disconnect', endpoint], 10_000);
  return { ok: !looksFailed(r), message: r.text || 'adb disconnect failed' };
}

export async function discover(adbPath?: string): Promise<{ ok: boolean; services: MdnsService[]; message?: string }> {
  try {
    const r = await runAdb(adbPath, ['mdns', 'services'], 10_000);
    if (r.code !== 0) return { ok: false, services: [], message: r.text };
    return { ok: true, services: parseMdns(r.stdout) };
  } catch (err) {
    return { ok: false, services: [], message: String((err as Error).message ?? err) };
  }
}
