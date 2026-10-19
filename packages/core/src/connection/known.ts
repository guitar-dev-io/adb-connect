/**
 * A device the user explicitly connected to or paired. Only these are ever reconnected automatically.
 * Contains no secrets: adb keeps the pairing keys in ~/.android itself.
 */
export interface KnownDevice {
  /** Stable id: the device GUID when known, otherwise ro.serialno, otherwise the first endpoint. */
  id: string;
  name: string;
  /** Device GUID = instance name of its `_adb-tls-connect._tcp` service ("adb-XXXX-yyyy"). Survives IP/port changes. */
  guid?: string;
  /** ro.serialno; also matches the USB serial of the same phone. */
  serialNo?: string;
  lastEndpoint?: string;
  pairedAt?: number;
  lastConnectedAt?: number;
  /** User approved automatic reconnection for this device. */
  autoReconnect: boolean;
  /** Set when the user disconnects manually; cleared by any manual connect. */
  userDisconnected: boolean;
}

export interface KnownDeviceStore {
  load(): KnownDevice[];
  save(devices: KnownDevice[]): void | Promise<void>;
}

export class MemoryKnownDeviceStore implements KnownDeviceStore {
  constructor(private devices: KnownDevice[] = []) {}
  load(): KnownDevice[] {
    return this.devices.map(d => ({ ...d }));
  }
  save(devices: KnownDevice[]): void {
    this.devices = devices.map(d => ({ ...d }));
  }
}

/** Drop malformed entries from persisted data. */
export function sanitizeKnownDevices(raw: unknown): KnownDevice[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .filter((d): d is KnownDevice => !!d && typeof d === 'object' && typeof (d as KnownDevice).id === 'string')
    .map(d => ({
      id: d.id,
      name: typeof d.name === 'string' ? d.name : d.id,
      guid: typeof d.guid === 'string' ? d.guid : undefined,
      serialNo: typeof d.serialNo === 'string' ? d.serialNo : undefined,
      lastEndpoint: typeof d.lastEndpoint === 'string' ? d.lastEndpoint : undefined,
      pairedAt: typeof d.pairedAt === 'number' ? d.pairedAt : undefined,
      lastConnectedAt: typeof d.lastConnectedAt === 'number' ? d.lastConnectedAt : undefined,
      autoReconnect: d.autoReconnect !== false,
      userDisconnected: d.userDisconnected === true,
    }));
}
