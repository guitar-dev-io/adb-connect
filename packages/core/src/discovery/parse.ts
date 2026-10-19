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

/** Parse `adb mdns services`. Ignores the header and the legacy `_adb._tcp` service. */
export function parseMdns(text: string): MdnsService[] {
  const out: MdnsService[] = [];
  for (const line of String(text).split(/\r?\n/)) {
    const m = line.match(LINE_RE);
    if (!m) continue;
    const ep = parseEndpoint(m[3]);
    if (!ep) continue;
    out.push({ name: m[1].trim(), type: m[2] as MdnsServiceType, endpoint: m[3], host: ep.host, port: ep.port });
  }
  return out;
}

export function serviceKey(s: MdnsService): string {
  return `${s.type}|${s.name}|${s.endpoint}`;
}
