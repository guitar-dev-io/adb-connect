import net from 'net';

export interface Endpoint {
  host: string;
  port: number;
}

const ENDPOINT_RE = /^(\[[0-9a-fA-F:.]+(?:%[A-Za-z0-9_.-]+)?\]|[A-Za-z0-9.-]+):(\d{1,5})$/;
const HOSTNAME_RE = /^(?=.{1,253}$)[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?$/i;

/** Parse host:port where host is IPv4, bracketed IPv6, or a DNS name. Rejects anything shell- or flag-like. */
export function parseEndpoint(value: unknown): Endpoint | null {
  const s = String(value ?? '').trim();
  const m = s.match(ENDPOINT_RE);
  if (!m) return null;
  const host = m[1];
  const port = Number(m[2]);
  if (port < 1 || port > 65535) return null;
  if (host.startsWith('[')) {
    return net.isIP(host.slice(1, -1).split('%')[0]) === 6 ? { host, port } : null;
  }
  // All-numeric hosts must be real IPv4 ("999.1.1.1" is not a hostname).
  if (/^[\d.]+$/.test(host)) return net.isIP(host) === 4 ? { host, port } : null;
  return HOSTNAME_RE.test(host) ? { host, port } : null;
}

export function validEndpoint(value: unknown): boolean {
  return parseEndpoint(value) !== null;
}

export function validPairingCode(value: unknown): boolean {
  return /^\d{6}$/.test(String(value ?? ''));
}
