import { Device, Transport } from './parse';
import { MdnsService } from '../discovery/parse';
import { KnownDevice } from '../connection/known';

export type EntryStatus =
  | 'connected'
  | 'offline'
  | 'unauthorized'
  | 'connecting'
  /** Advertising a connect service but not connected. */
  | 'available'
  /** Known, not connected and not advertising. */
  | 'disconnected'
  | 'other';

/** One row in a device manager: merges live adb devices, remembered devices and mDNS advertisements. */
export interface DeviceEntry {
  /** Stable key: KnownDevice.id, else adb serial, else mDNS instance name. */
  id: string;
  name: string;
  serial?: string;
  endpoint?: string;
  transport: Transport;
  status: EntryStatus;
  /** Raw adb state when connected/visible to adb. */
  adbState?: string;
  /** Remembered (paired or previously connected) device. */
  known: boolean;
  paired: boolean;
  preferred: boolean;
  autoReconnect?: boolean;
  userDisconnected?: boolean;
  /** Present for unknown advertising devices: connecting needs an explicit user action. */
  advertisedName?: string;
}

function statusOf(d: Device): EntryStatus {
  switch (d.state) {
    case 'device': return 'connected';
    case 'offline': return 'offline';
    case 'unauthorized': return 'unauthorized';
    case 'authorizing':
    case 'connecting': return 'connecting';
    default: return 'other';
  }
}

export function buildDeviceEntries(
  devices: Device[],
  known: KnownDevice[],
  services: MdnsService[],
  match: (d: Device) => KnownDevice | undefined,
  preferredId?: string,
): DeviceEntry[] {
  const entries: DeviceEntry[] = [];
  const seenKnown = new Set<string>();
  const seenGuids = new Set<string>();

  for (const d of devices) {
    const k = match(d);
    if (k && d.transport === 'wifi') seenKnown.add(k.id);
    if (d.mdnsName) seenGuids.add(d.mdnsName);
    const advertised = d.mdnsName ? services.find(s => s.type === 'connect' && s.name === d.mdnsName) : undefined;
    // USB and Wi-Fi transports of the same phone are separate rows; both are useful.
    const id = k && d.transport === 'wifi' ? k.id : d.serial;
    entries.push({
      id,
      name: k?.name && d.model === d.serial ? k.name : d.model,
      serial: d.serial,
      endpoint: d.endpoint ?? advertised?.endpoint ?? (d.transport === 'wifi' ? k?.lastEndpoint : undefined),
      transport: d.transport,
      status: statusOf(d),
      adbState: d.state,
      known: !!k,
      paired: !!k?.pairedAt || d.transport === 'wifi',
      preferred: id === preferredId || d.serial === preferredId,
      autoReconnect: k?.autoReconnect,
      userDisconnected: k?.userDisconnected,
    });
  }

  for (const k of known) {
    if (seenKnown.has(k.id)) continue;
    if (k.guid) seenGuids.add(k.guid);
    const advertised = k.guid ? services.find(s => s.type === 'connect' && s.name === k.guid) : undefined;
    entries.push({
      id: k.id,
      name: k.name,
      endpoint: advertised?.endpoint ?? k.lastEndpoint,
      transport: 'wifi',
      status: advertised ? 'available' : 'disconnected',
      known: true,
      paired: !!k.pairedAt || !!k.guid,
      preferred: k.id === preferredId,
      autoReconnect: k.autoReconnect,
      userDisconnected: k.userDisconnected,
    });
  }

  for (const s of services) {
    if (s.type !== 'connect' || seenGuids.has(s.name)) continue;
    if (entries.some(e => e.endpoint === s.endpoint)) continue;
    entries.push({
      id: `mdns:${s.name}`,
      name: s.name,
      endpoint: s.endpoint,
      transport: 'wifi',
      status: 'available',
      known: false,
      paired: false,
      preferred: false,
      advertisedName: s.name,
    });
  }

  const order: Record<EntryStatus, number> = { connected: 0, connecting: 1, unauthorized: 2, offline: 3, available: 4, disconnected: 5, other: 6 };
  return entries.sort((a, b) => Number(b.preferred) - Number(a.preferred) || order[a.status] - order[b.status] || a.name.localeCompare(b.name));
}

/** Copyable commands for advanced users. */
export function adbCommandsFor(e: DeviceEntry): { label: string; command: string }[] {
  const out: { label: string; command: string }[] = [];
  const target = e.serial ?? e.endpoint;
  if (e.endpoint && e.transport === 'wifi') out.push({ label: 'Connect', command: `adb connect ${e.endpoint}` });
  if (target) {
    out.push({ label: 'Shell', command: `adb -s ${target} shell` });
    out.push({ label: 'Logcat', command: `adb -s ${target} logcat` });
    out.push({ label: 'Install APK', command: `adb -s ${target} install -r app.apk` });
  }
  if (e.serial && e.transport === 'wifi') out.push({ label: 'Disconnect', command: `adb disconnect ${e.serial}` });
  return out;
}
