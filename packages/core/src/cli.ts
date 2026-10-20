#!/usr/bin/env node
/**
 * adb-connect helper CLI. Every stdout line is one JSON object (JSON Lines), so it can serve as an
 * IPC helper for other tools; human-readable output (QR code, hints) goes to stderr.
 * See docs/IPC.md for the protocol.
 */
import { AdbClient } from './adb/client';
import { AdbError } from './adb/runner';
import { AdbEngine } from './engine';
import fs from 'fs';
import { renderQrSvg, renderQrTerminal } from './pairing/render';
import { pairWithCode } from './pairing/session';
import { MdnsBrowser } from './discovery/browser';
import { Logger } from './log';

const PROTOCOL = 1;

function emit(obj: Record<string, unknown>) {
  process.stdout.write(JSON.stringify({ v: PROTOCOL, ...obj }) + '\n');
}

function parseArgs(argv: string[]) {
  const flags: Record<string, string | boolean> = {};
  const positional: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const [k, v] = a.slice(2).split('=', 2);
      if (v !== undefined) flags[k] = v;
      else if (argv[i + 1] && !argv[i + 1].startsWith('--')) flags[k] = argv[++i];
      else flags[k] = true;
    } else positional.push(a);
  }
  return { flags, positional };
}

/** Read one line; on a TTY prompt on stderr (the code is typed by the user, never passed as an argument). */
async function readLine(prompt: string): Promise<string> {
  if (!process.stdin.isTTY) return readStdin();
  const rl = (await import('readline')).createInterface({ input: process.stdin, output: process.stderr, terminal: true });
  const answer = await new Promise<string>(resolve => rl.question(prompt, resolve));
  rl.close();
  return answer.trim();
}

async function readStdin(): Promise<string> {
  if (process.stdin.isTTY) return '';
  let s = '';
  for await (const chunk of process.stdin) s += chunk;
  return s.trim();
}

const stderrLogger = (verbose: boolean): Logger => ({
  log(level, message, fields) {
    if (verbose || level === 'error') process.stderr.write(`[${level}] ${message}${fields ? ' ' + JSON.stringify(fields) : ''}\n`);
  },
});

const USAGE = `usage: adb-connect [--adb PATH] [--verbose] <command>
  status                    adb info and devices
  devices                   devices (adb devices -l)
  discover [--wait S]       mDNS services (adb + OS resolver)
  connect <host:port>
  disconnect <serial>
  pair [host:port]          six-digit code pairing; endpoint auto-discovered, code prompted (or $ADB_CONNECT_PAIR_CODE / stdin)
  qr [--timeout S] [--html FILE]  QR pairing; QR on stderr (and FILE), progress events on stdout
  track                     stream device list changes until interrupted`;

async function main() {
  const { flags, positional } = parseArgs(process.argv.slice(2));
  const [cmd = 'status', arg] = positional;
  if (cmd === 'help' || flags.help) {
    process.stderr.write(USAGE + '\n');
    return;
  }
  const logger = stderrLogger(!!flags.verbose);
  const configuredPath = typeof flags.adb === 'string' ? flags.adb : undefined;

  let client: AdbClient;
  try {
    client = await AdbClient.create({ configuredPath, logger });
  } catch (e) {
    const kind = e instanceof AdbError ? e.kind : 'error';
    emit({ type: 'error', ok: false, error: kind === 'not-found' ? 'adb-not-found' : kind, message: (e as Error).message });
    process.exitCode = 2;
    return;
  }

  switch (cmd) {
    case 'status': {
      const devices = await client.devices().catch(() => []);
      return emit({ type: 'status', ok: true, adb: client.info, devices });
    }
    case 'version':
      return emit({ type: 'version', ok: true, adb: client.info });
    case 'devices':
    case 'list-devices':
      return emit({ type: 'devices', ok: true, devices: await client.devices() });
    case 'discover': {
      // adb's mDNS backend plus the OS resolver, collected for --wait seconds (default 4).
      const browser = new MdnsBrowser(client, { logger });
      const lease = browser.acquire();
      await new Promise(r => setTimeout(r, (Number(flags.wait) > 0 ? Number(flags.wait) : 4) * 1000));
      const services = browser.services;
      lease.dispose();
      browser.dispose();
      return emit({ type: 'services', ok: true, services });
    }
    case 'connect':
      return emit({ type: 'result', ...(await client.connect(arg ?? '')) });
    case 'disconnect':
      return emit({ type: 'result', ...(await client.disconnect(arg ?? '')) });
    case 'pair': {
      const browser = new MdnsBrowser(client, { logger });
      let endpoint = arg;
      if (!endpoint) {
        // The phone's "Pair device with pairing code" dialog advertises a pairing service; use it.
        process.stderr.write('Waiting for a phone showing "Pair device with pairing code" (60 s)…\n');
        const svc = await browser.waitFor(s => s.type === 'pairing' && !s.name.startsWith('adbconnect-'), { timeoutMs: 60_000 }).catch(() => undefined);
        if (!svc) {
          browser.dispose();
          emit({ type: 'result', ok: false, state: 'timeout', message: 'No phone in pairing-code mode was found. Pass the IP address & Port explicitly.' });
          return;
        }
        endpoint = svc.endpoint;
        emit({ type: 'discovered', service: svc });
        process.stderr.write(`Found ${svc.name} at ${svc.endpoint}\n`);
      }
      const code = process.env.ADB_CONNECT_PAIR_CODE || (await readLine(`Six-digit Wi-Fi pairing code for ${endpoint}: `));
      const r = await pairWithCode(client, browser, endpoint, code, { onUpdate: u => emit({ type: 'pairing', ...u }) });
      browser.dispose();
      emit({ type: 'result', ok: r.state === 'connected' || r.state === 'paired', ...r });
      return;
    }
    case 'qr': {
      const engine = await AdbEngine.create({ configuredPath, logger });
      const timeout = Number(flags.timeout) > 0 ? Number(flags.timeout) * 1000 : 120_000;
      const session = engine.createQrSession({ scanTimeoutMs: timeout, onUpdate: u => emit({ type: 'pairing', ...u }) });
      process.stderr.write(await renderQrTerminal(session.payload));
      if (typeof flags.html === 'string') {
        // Standalone page with the QR (for showing in a browser). Holds the one-time password; delete after use.
        const svg = await renderQrSvg(session.payload);
        fs.writeFileSync(flags.html, `<!doctype html><meta charset="utf-8"><title>ADB Connect QR</title><body style="font:16px system-ui;text-align:center;padding:24px"><h2>Pair via QR Code</h2><div style="width:320px;margin:auto">${svg}</div><p>Phone: Settings › Developer options › Wireless debugging › <b>Pair device with QR code</b></p></body>`, { mode: 0o600 });
      }
      process.stderr.write('\nScan with: Settings > Developer options > Wireless debugging > Pair device with QR code\n');
      process.once('SIGINT', () => session.cancel());
      const r = await session.run();
      emit({ type: 'result', ok: r.state === 'connected' || r.state === 'paired', ...r });
      engine.dispose();
      if (typeof flags.html === 'string') fs.rmSync(flags.html, { force: true });
      return;
    }
    case 'track': {
      const engine = await AdbEngine.create({ configuredPath, logger });
      engine.tracker.on('devices', devices => emit({ type: 'devices', devices }));
      engine.tracker.on('lost', reason => emit({ type: 'lost', reason }));
      engine.start();
      await new Promise<void>(resolve => process.once('SIGINT', () => resolve()));
      engine.dispose();
      return;
    }
    default:
      emit({ type: 'error', ok: false, error: 'unknown-command', message: `Unknown command: ${cmd}` });
      process.stderr.write(USAGE + '\n');
      process.exitCode = 64;
  }
}

main().catch(err => {
  emit({ type: 'error', ok: false, error: 'internal', message: String((err as Error)?.message ?? err) });
  process.exitCode = 1;
});
