import type { DeviceEntry } from '@adb-connect/core';

export type Activity = 'idle' | 'searching' | 'reconnecting' | 'pairing' | 'no-adb' | 'starting';

export interface StatusInput {
  activity: Activity;
  entries: DeviceEntry[];
  preferredId?: string;
}

/** Pure: text + tooltip for the status item, so it can be unit tested. */
export function statusText(s: StatusInput): { text: string; tooltip: string } {
  const connected = s.entries.filter(e => e.status === 'connected');
  const active = connected.find(e => e.id === s.preferredId || e.serial === s.preferredId) ?? connected[0];
  const tip = connected.length
    ? connected.map(e => `${e.name} — ${e.endpoint ?? e.serial} (${e.transport === 'wifi' ? 'Wi-Fi' : 'USB'})`).join('\n')
    : 'No Android device connected';

  switch (s.activity) {
    case 'no-adb':
      return { text: '$(warning) ADB: Not found', tooltip: 'adb was not found. Click to set the adb path.' };
    case 'starting':
      return { text: '$(sync~spin) ADB: Starting...', tooltip: 'Starting ADB Connect' };
    case 'reconnecting':
      return { text: '$(sync~spin) ADB: Reconnecting...', tooltip: tip };
    case 'pairing':
      return { text: '$(sync~spin) ADB: Pairing...', tooltip: tip };
    case 'searching':
      if (!connected.length) return { text: '$(search) ADB: Searching...', tooltip: 'Looking for Android devices on the network' };
  }
  if (connected.length === 0) return { text: '$(device-mobile) ADB: Disconnected', tooltip: `${tip}\nClick for ADB Connect actions` };
  if (connected.length === 1) return { text: `$(device-mobile) ADB: ${active!.name}`, tooltip: `${tip}\nClick for ADB Connect actions` };
  return { text: `$(device-mobile) ADB: ${connected.length} Devices Connected`, tooltip: `${tip}\nClick for ADB Connect actions` };
}
