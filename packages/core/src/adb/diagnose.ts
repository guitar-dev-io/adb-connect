import net from 'net';
import { parseEndpoint } from '../connection/endpoint';

/** Can *this* process open a TCP connection to the endpoint? */
export function tcpReachable(endpoint: string, timeoutMs = 2_500): Promise<boolean> {
  const ep = parseEndpoint(endpoint);
  if (!ep) return Promise.resolve(false);
  const host = ep.host.replace(/^\[|\]$/g, '').split('%')[0];
  return new Promise(resolve => {
    const s = net.connect({ host, port: ep.port });
    const done = (ok: boolean) => { s.destroy(); resolve(ok); };
    s.setTimeout(timeoutMs, () => done(false));
    s.once('connect', () => done(true));
    s.once('error', () => done(false));
  });
}

export const ADB_BLOCKED_HINT =
  'adb cannot reach the local network, but this computer can. Something is blocking the adb server process: ' +
  'on macOS allow "Local Network" for the app that started adb (System Settings › Privacy & Security › Local Network), ' +
  'or allow adb in your firewall / endpoint-security software. Then restart the adb server yourself ' +
  '(`adb kill-server`) — ADB Connect never restarts it because other tools may be using it.';

/**
 * If adb reports the host as unreachable while we can reach it, return an actionable explanation.
 * Returns undefined when the failure is not that pattern.
 */
export async function diagnoseUnreachable(endpoint: string, adbText: string): Promise<string | undefined> {
  if (!/no route to host|host is unreachable|EHOSTUNREACH|network is unreachable/i.test(adbText)) return undefined;
  return (await tcpReachable(endpoint)) ? ADB_BLOCKED_HINT : undefined;
}
