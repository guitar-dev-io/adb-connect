/**
 * Scriptable stand-in for the adb CLI, driven by a JSON state file ($FAKE_ADB_STATE).
 * Simulates the phone side of pairing: a successful `pair` publishes the device's connect service.
 * Every invocation is appended to state.logFile.
 */
import fs from 'fs';

export interface FakeState {
  version?: string;
  devices: string[];
  mdns: string[];
  mdnsAvailable?: boolean;
  /** endpoint -> pairing behaviour */
  pair?: Record<string, { secret: string; guid?: string; connectEndpoint?: string }>;
  /** endpoint -> device line added on connect; absent = connection fails */
  connect?: Record<string, string>;
  /** Increment to make running track-devices processes exit (simulated adb server restart). */
  trackGeneration?: number;
  delayMs?: Record<string, number>;
  logFile: string;
}

const file = process.env.FAKE_ADB_STATE!;
const read = (): FakeState => JSON.parse(fs.readFileSync(file, 'utf8'));
const write = (s: FakeState) => fs.writeFileSync(file, JSON.stringify(s));
const args = process.argv.slice(2);
const state = read();
fs.appendFileSync(state.logFile, JSON.stringify(args) + '\n');

const out = (s: string) => process.stdout.write(s);
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

async function main() {
  const cmd = args[0] === '-s' ? args[2] : args[0];
  const delay = state.delayMs?.[cmd];
  if (delay) await sleep(delay);

  switch (cmd) {
    case 'version':
      return out(state.version ?? 'Android Debug Bridge version 1.0.41\nVersion 37.0.1-15733141\n');
    case 'devices':
      return out(`List of devices attached\n${state.devices.map(l => l + '\n').join('')}\n`);
    case 'mdns':
      if (args[1] === 'check') {
        if (state.mdnsAvailable === false) { out('ERROR: mdns daemon unavailable\n'); process.exitCode = 1; return; }
        return out('mdns daemon version [adb discovery 0.0.0]\n');
      }
      return out(`List of discovered mdns services\n${state.mdns.map(l => l + '\n').join('')}\n`);
    case 'pair': {
      const [, endpoint, secret] = args;
      const p = state.pair?.[endpoint];
      if (!p || p.secret !== secret) { out('Failed: Wrong password or connection was dropped.\n'); process.exitCode = 1; return; }
      const s = read();
      s.mdns = s.mdns.filter(l => !l.includes(endpoint));
      if (p.guid && p.connectEndpoint) s.mdns.push(`${p.guid}\t_adb-tls-connect._tcp\t${p.connectEndpoint}`);
      write(s);
      return out(`Successfully paired to ${endpoint}${p.guid ? ` [guid=${p.guid}]` : ''}\n`);
    }
    case 'connect': {
      const endpoint = args[1];
      const line = state.connect?.[endpoint];
      if (!line) return out(`failed to connect to '${endpoint}': Connection refused\n`);
      const s = read();
      if (s.devices.some(l => l.startsWith(endpoint + ' ') || l.startsWith(line.split(/\s/)[0] + ' '))) return out(`already connected to ${endpoint}\n`);
      s.devices.push(line);
      write(s);
      return out(`connected to ${endpoint}\n`);
    }
    case 'disconnect': {
      const serial = args[1];
      const s = read();
      const before = s.devices.length;
      s.devices = s.devices.filter(l => !l.startsWith(serial + ' '));
      write(s);
      if (s.devices.length === before) { out(`error: no such device '${serial}'\n`); process.exitCode = 1; return; }
      return out(`disconnected ${serial}\n`);
    }
    case 'shell':
      // -s <serial> shell getprop ro.serialno
      return out(`${(args[1] ?? '').replace(/[^A-Za-z0-9]/g, '').toUpperCase()}\n`);
    case 'track-devices': {
      const gen = state.trackGeneration ?? 0;
      let last = '';
      const frame = () => {
        const s = read();
        if ((s.trackGeneration ?? 0) !== gen) process.exit(1);
        const body = s.devices.map(l => l + '\n').join('');
        if (body !== last) {
          last = body;
          out(Buffer.byteLength(body).toString(16).padStart(4, '0') + body);
        }
      };
      frame();
      setInterval(frame, 25);
      return;
    }
    default:
      out(`error: unknown command ${cmd}\n`);
      process.exitCode = 1;
  }
}

void main();
