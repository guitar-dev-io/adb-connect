import fs from 'fs';
import os from 'os';
import path from 'path';
import { AdbClient } from '../src/adb/client';
import { AdbRunner } from '../src/adb/runner';
import { parseAdbVersion, supportsWirelessPairing } from '../src/adb/version';
import { Logger, LogLevel } from '../src/log';
import type { FakeState } from './fake-adb';

export const fixtures = JSON.parse(
  fs.readFileSync(path.join(__dirname, '..', '..', 'fixtures', 'adb-output.json'), 'utf8'),
);

export interface Fake {
  dir: string;
  adbPath: string;
  client: AdbClient;
  runner: AdbRunner;
  logs: { level: LogLevel; message: string; fields?: Record<string, unknown> }[];
  logger: Logger;
  state(): FakeState;
  set(patch: Partial<FakeState> | ((s: FakeState) => void)): void;
  calls(): string[][];
  cleanup(): void;
}

/** Create a fake adb executable backed by a state file. POSIX only (CI runs on Linux). */
export function makeFake(initial: Partial<FakeState> = {}): Fake {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fake-adb-'));
  const stateFile = path.join(dir, 'state.json');
  const logFile = path.join(dir, 'calls.log');
  fs.writeFileSync(logFile, '');
  const state: FakeState = { devices: [], mdns: [], logFile, ...initial };
  fs.writeFileSync(stateFile, JSON.stringify(state));
  const adbPath = path.join(dir, 'adb');
  fs.writeFileSync(adbPath, `#!/bin/sh\nFAKE_ADB_STATE="${stateFile}" exec "${process.execPath}" "${path.join(__dirname, 'fake-adb.js')}" "$@"\n`, { mode: 0o755 });

  const logs: Fake['logs'] = [];
  const logger: Logger = { log: (level, message, fields) => logs.push({ level, message, fields }) };
  const runner = new AdbRunner({ adbPath, logger });
  const version = parseAdbVersion(state.version ?? 'Android Debug Bridge version 1.0.41\nVersion 37.0.1-15733141')!;
  const client = AdbClient.fromRunner(runner, {
    location: { path: adbPath, source: 'setting' },
    version,
    wirelessPairing: supportsWirelessPairing(version),
  });
  const read = (): FakeState => JSON.parse(fs.readFileSync(stateFile, 'utf8'));
  return {
    dir,
    adbPath,
    client,
    runner,
    logs,
    logger,
    state: read,
    set(patch) {
      const s = read();
      if (typeof patch === 'function') patch(s);
      else Object.assign(s, patch);
      fs.writeFileSync(stateFile, JSON.stringify(s));
    },
    calls: () => fs.readFileSync(logFile, 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l)),
    cleanup: () => fs.rmSync(dir, { recursive: true, force: true }),
  };
}

export const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

export async function until(cond: () => boolean, timeoutMs = 3_000, label = 'condition'): Promise<void> {
  const end = Date.now() + timeoutMs;
  while (!cond()) {
    if (Date.now() > end) throw new Error(`Timed out waiting for ${label}`);
    await sleep(20);
  }
}
