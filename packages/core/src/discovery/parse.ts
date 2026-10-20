import { parseEndpoint } from '../connection/endpoint';

export type MdnsServiceType = 'connect' | 'pairing';

export interface MdnsService {
  /** Instance name: "adb-<serial>-<suffix>" for connect services, the QR service name for QR pairing. */
  name: string;
  type: MdnsServiceType;
  endpoint: string;
  host: string;
  port: number;
}

const LINE_RE = /^(.*?)\s+_adb-tls-(connect|pairing)\._tcp\.?\s+(\S+:\d+)\s*$/;

const RENAME_RE = / \((\d+)\)$/;

/**
 * mDNS renames a service "name (2)" when a (often stale, cached) record with the same name exists.
 * The device GUID adb reports is the base name, so identity uses the normalised name.
 */
export function normalizeServiceName(name: string): string {
  return name.replace(RENAME_RE, '');
}

/**
 * Parse `adb mdns services`. Ignores the header and the legacy `_adb._tcp` service.
 * When a device appears both as "name" and "name (N)", the highest N is the live advertisement.
 */
export function parseMdns(text: string): MdnsService[] {
  const best = new Map<string, { s: MdnsService; rank: number }>();
  for (const line of String(text).split(/\r?\n/)) {
    const m = line.match(LINE_RE);
    if (!m) continue;
    const ep = parseEndpoint(m[3]);
    if (!ep) continue;
    const raw = m[1].trim();
    const rank = Number(raw.match(RENAME_RE)?.[1] ?? 0);
    const s: MdnsService = { name: normalizeServiceName(raw), type: m[2] as MdnsServiceType, endpoint: m[3], host: ep.host, port: ep.port };
    const key = `${s.type}|${s.name}`;
    const prev = best.get(key);
    if (!prev || rank > prev.rank) best.set(key, { s, rank });
  }
  return [...best.values()].map(v => v.s);
}

export function serviceKey(s: MdnsService): string {
  return `${s.type}|${s.name}|${s.endpoint}`;
}
