export interface PairOutcome {
  ok: boolean;
  /** Endpoint adb reports it paired to. */
  endpoint?: string;
  /** Device GUID; equals the instance name of the device's `_adb-tls-connect._tcp` service. */
  guid?: string;
  message: string;
}

/** Parse `adb pair` output, e.g. "Successfully paired to 192.168.1.10:37099 [guid=adb-ABC123-xYz9Q]". */
export function parsePairOutput(text: string): PairOutcome {
  const m = text.match(/Successfully paired to (\S+)(?:\s+\[guid=([^\]\s]+)\])?/i);
  if (m) return { ok: true, endpoint: m[1], guid: m[2], message: text.trim() };
  return { ok: false, message: text.trim() || 'adb pair failed' };
}

/** `adb connect` exits 0 on failure; decide from the text. */
export function parseConnectOutput(text: string): { ok: boolean; already: boolean; message: string } {
  const t = text.trim();
  const already = /already connected to/i.test(t);
  const ok = !/failed|cannot|unable|error/i.test(t) && /connected to/i.test(t);
  return { ok, already, message: t || 'adb connect failed' };
}
