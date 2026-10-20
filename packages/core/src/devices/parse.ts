import { validEndpoint } from '../connection/endpoint';
import { normalizeServiceName } from '../discovery/parse';

export type DeviceState =
  | 'device'
  | 'offline'
  | 'unauthorized'
  | 'authorizing'
  | 'connecting'
  | 'recovery'
  | 'rescue'
  | 'sideload'
  | 'bootloader'
  | 'host'
  | 'no permissions';

export type Transport = 'wifi' | 'usb';

export interface Device {
  serial: string;
  state: DeviceState;
  /** Human-readable model ("Pixel 9 Pro"), falls back to the serial. */
  model: string;
  transport: Transport;
  /** ip:port when the serial is a TCP endpoint. */
  endpoint?: string;
  /** mDNS instance name ("adb-XXXX-yyyy") when adb connected through mDNS. */
  mdnsName?: string;
  attrs: Record<string, string>;
}

const STATES = 'device|offline|unauthorized|authorizing|connecting|recovery|rescue|sideload|bootloader|host|no permissions';
// Serials can contain spaces: mDNS conflict renames give "adb-XXX-yyy (2)._adb-tls-connect._tcp".
const LINE_RE = new RegExp(`^(.+?)\\s+(${STATES})(?:\\s+(.*))?$`);
const MDNS_SERIAL_RE = /^(adb-.+?)\._adb-tls-connect\._tcp\.?$/;

export function parseDeviceLine(line: string): Device | null {
  const m = line.trim().match(LINE_RE);
  if (!m) return null;
  const [, serial, state, rest] = m;
  const attrs: Record<string, string> = {};
  // "no permissions" lines carry a free-text hint in brackets; only key:value tokens are attributes.
  for (const token of (rest ?? '').split(/\s+/)) {
    const p = token.indexOf(':');
    if (p > 0 && /^[a-z_]+$/.test(token.slice(0, p))) attrs[token.slice(0, p)] = token.slice(p + 1);
  }
  const mdns = serial.match(MDNS_SERIAL_RE);
  const endpoint = validEndpoint(serial) ? serial : undefined;
  return {
    serial,
    state: state as DeviceState,
    model: (attrs.model ?? attrs.device ?? serial).replace(/_/g, ' '),
    transport: endpoint || mdns ? 'wifi' : 'usb',
    endpoint,
    mdnsName: mdns ? normalizeServiceName(mdns[1]) : undefined,
    attrs,
  };
}

/** Parse `adb devices -l` (with header) or a `track-devices -l` payload (without header). */
export function parseDevices(text: string): Device[] {
  const out: Device[] = [];
  for (const line of String(text).split(/\r?\n/)) {
    if (!line.trim() || /^List of devices/i.test(line) || line.startsWith('*')) continue;
    const d = parseDeviceLine(line);
    if (d) out.push(d);
  }
  return out;
}

/**
 * Decodes the `adb track-devices` stream: repeated frames of a 4-hex-digit length followed by
 * that many bytes of device list. Handles frames split across chunks.
 */
export class TrackDevicesDecoder {
  private buf = Buffer.alloc(0);

  push(chunk: Buffer | string): string[] {
    this.buf = Buffer.concat([this.buf, typeof chunk === 'string' ? Buffer.from(chunk) : chunk]);
    const frames: string[] = [];
    for (;;) {
      if (this.buf.length < 4) break;
      const len = parseInt(this.buf.subarray(0, 4).toString('ascii'), 16);
      if (Number.isNaN(len)) {
        // Not a framed stream (unexpected output). Drop it rather than spin.
        this.buf = Buffer.alloc(0);
        break;
      }
      if (this.buf.length < 4 + len) break;
      frames.push(this.buf.subarray(4, 4 + len).toString('utf8'));
      this.buf = this.buf.subarray(4 + len);
    }
    return frames;
  }
}
