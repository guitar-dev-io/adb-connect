import { randomInt } from 'crypto';

/**
 * Android Wireless Debugging QR pairing (Android 11+), as used by Android Studio:
 *
 *   1. Host shows a QR encoding  WIFI:T:ADB;S:<serviceName>;P:<password>;;
 *   2. Phone (Wireless debugging > Pair device with QR code) scans it, starts its pairing server
 *      and advertises `_adb-tls-pairing._tcp` with instance name <serviceName>.
 *   3. Host finds that service through the adb server's mDNS and runs `adb pair <ip:port> <password>`
 *      (SPAKE2 + TLS is handled entirely by adb/adbd).
 *   4. The phone then advertises `_adb-tls-connect._tcp` named after the device GUID, which the host connects to.
 *
 * The QR therefore carries only a one-time service name and password — never an IP address.
 */
export interface QrCredentials {
  serviceName: string;
  password: string;
}

const LOWER_ALNUM = 'abcdefghijklmnopqrstuvwxyz0123456789';
const ALNUM = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789';

function randomString(alphabet: string, length: number): string {
  let s = '';
  for (let i = 0; i < length; i++) s += alphabet[randomInt(alphabet.length)];
  return s;
}

/** Fresh one-time credentials. Characters are restricted so no escaping is needed in the WIFI: payload. */
export function createQrCredentials(): QrCredentials {
  return {
    serviceName: `adbconnect-${randomString(LOWER_ALNUM, 10)}`,
    password: randomString(ALNUM, 12),
  };
}

export function qrPayload(c: QrCredentials): string {
  if (!/^[A-Za-z0-9-]+$/.test(c.serviceName) || !/^[A-Za-z0-9]+$/.test(c.password)) {
    throw new Error('QR credentials contain characters that would need escaping');
  }
  return `WIFI:T:ADB;S:${c.serviceName};P:${c.password};;`;
}
