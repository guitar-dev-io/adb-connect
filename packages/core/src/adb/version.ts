export interface AdbVersionInfo {
  /** Protocol version, e.g. "1.0.41". */
  adb: string;
  /** Platform-tools release, e.g. "37.0.1". Missing on very old builds. */
  platformTools?: string;
}

/** Wireless pairing (`adb pair`) landed in platform-tools 30; reliable `adb mdns services` in 31. */
export const MIN_PLATFORM_TOOLS = '31.0.0';

export function parseAdbVersion(text: string): AdbVersionInfo | null {
  const adb = text.match(/Android Debug Bridge version (\d+\.\d+\.\d+)/i);
  if (!adb) return null;
  const pt = text.match(/^Version (\d+\.\d+\.\d+)/im);
  return { adb: adb[1], platformTools: pt?.[1] };
}

export function compareVersions(a: string, b: string): number {
  const pa = a.split('.').map(Number);
  const pb = b.split('.').map(Number);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (d) return Math.sign(d);
  }
  return 0;
}

export function supportsWirelessPairing(v: AdbVersionInfo): boolean {
  return !!v.platformTools && compareVersions(v.platformTools, MIN_PLATFORM_TOOLS) >= 0;
}
