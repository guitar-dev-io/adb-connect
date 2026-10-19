import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { adbCandidates, locateAdb } from '../src/adb/locate';
import { AdbClient } from '../src/adb/client';
import { AdbError } from '../src/adb/runner';
import { makeFake, sleep } from './helpers';

test('adbCandidates order: setting, ANDROID_HOME, ANDROID_SDK_ROOT, PATH, default SDK', () => {
  const c = adbCandidates({
    configuredPath: '/custom/adb',
    env: { ANDROID_HOME: '/sdk', ANDROID_SDK_ROOT: '/sdk2', PATH: '/usr/bin:/opt/bin' },
    platform: 'linux',
    homedir: '/home/u',
  });
  assert.deepEqual(c.map(x => x.path), ['/custom/adb', '/sdk/platform-tools/adb', '/sdk2/platform-tools/adb', '/usr/bin/adb', '/opt/bin/adb', '/home/u/Android/Sdk/platform-tools/adb']);
  const w = adbCandidates({ env: { Path: 'C:\\tools', LOCALAPPDATA: 'C:\\Users\\u\\AppData\\Local' }, platform: 'win32', homedir: 'C:\\Users\\u' });
  assert.deepEqual(w.map(x => x.path), ['C:\\tools\\adb.exe', 'C:\\Users\\u\\AppData\\Local\\Android\\Sdk\\platform-tools\\adb.exe']);
  // "adb" as a setting means auto-detect
  assert.equal(adbCandidates({ configuredPath: 'adb', env: {}, platform: 'darwin', homedir: '/Users/u' })[0].source, 'default-sdk');
});

test('ADB missing: locate returns null and AdbClient.create throws not-found', async () => {
  const empty = fs.mkdtempSync(path.join(os.tmpdir(), 'noadb-'));
  try {
    const opts = { env: { PATH: empty }, platform: process.platform, homedir: empty };
    assert.equal(locateAdb(opts), null);
    await assert.rejects(AdbClient.create(opts), (e: unknown) => e instanceof AdbError && e.kind === 'not-found');
    // A wrong configured path does not silently fall back to another adb
    assert.equal(locateAdb({ ...opts, configuredPath: path.join(empty, 'nope') }), null);
  } finally {
    fs.rmSync(empty, { recursive: true, force: true });
  }
});

test('ADB installed: AdbClient.create finds adb on PATH and validates version', async () => {
  const fake = makeFake();
  try {
    const client = await AdbClient.create({ env: { PATH: fake.dir }, homedir: fake.dir });
    assert.equal(client.path, fake.adbPath);
    assert.equal(client.info.version.platformTools, '37.0.1');
    assert.equal(client.info.wirelessPairing, true);
  } finally {
    fake.cleanup();
  }
});

test('old platform-tools: pairing refused with a clear message', async () => {
  const fake = makeFake({ version: 'Android Debug Bridge version 1.0.41\nVersion 30.0.5-6877874\n' });
  try {
    const client = await AdbClient.create({ configuredPath: fake.adbPath });
    assert.equal(client.info.wirelessPairing, false);
    const r = await client.pairWithCode('192.168.1.10:4000', '123456');
    assert.equal(r.ok, false);
    assert.match(r.message, /Platform-Tools 31/);
    assert.equal(fake.calls().filter(c => c[0] === 'pair').length, 0);
  } finally {
    fake.cleanup();
  }
});

test('runner: timeout, cancellation and bounded concurrency', async () => {
  const fake = makeFake({ delayMs: { devices: 300 } });
  try {
    await assert.rejects(fake.runner.run(['devices', '-l'], { timeoutMs: 50 }), (e: unknown) => (e as AdbError).kind === 'timeout');
    const ac = new AbortController();
    const p = fake.runner.run(['devices', '-l'], { signal: ac.signal });
    setTimeout(() => ac.abort(), 30);
    await assert.rejects(p, (e: unknown) => (e as AdbError).kind === 'cancelled');

    // 8 slow commands with maxConcurrent 4 take ~2 rounds, not 1
    const started = Date.now();
    await Promise.all(Array.from({ length: 8 }, () => fake.runner.run(['devices', '-l'])));
    assert.ok(Date.now() - started >= 550, `expected ≥2 rounds, took ${Date.now() - started}ms`);
  } finally {
    fake.cleanup();
  }
});

test('pairing code never reaches logs or returned text', async () => {
  const fake = makeFake({ pair: { '192.168.1.10:4000': { secret: '654321' } } });
  try {
    const bad = await fake.client.pairWithCode('192.168.1.10:4000', '111111');
    assert.equal(bad.ok, false);
    const good = await fake.client.pairWithCode('192.168.1.10:4000', '654321');
    assert.equal(good.ok, true);
    const logged = JSON.stringify(fake.logs);
    assert.ok(!logged.includes('654321') && !logged.includes('111111'), logged);
    assert.ok(!good.message.includes('654321'));
  } finally {
    fake.cleanup();
  }
});

test('connect/disconnect validate input and never run bare `adb disconnect`', async () => {
  const fake = makeFake({ connect: { '192.168.1.10:5555': '192.168.1.10:5555 device model:Pixel_9' } });
  try {
    assert.equal((await fake.client.connect('bad;endpoint:1')).ok, false);
    assert.equal((await fake.client.disconnect('')).ok, false);
    assert.equal((await fake.client.disconnect('-a')).ok, false);
    assert.equal((await fake.client.connect('192.168.1.10:5555')).ok, true);
    assert.equal((await fake.client.connect('192.168.1.10:5555')).already, true);
    assert.equal((await fake.client.connect('192.168.1.11:5555')).ok, false);
    assert.equal((await fake.client.disconnect('192.168.1.10:5555')).ok, true);
    assert.ok(fake.calls().every(c => !(c[0] === 'disconnect' && c.length === 1)));
    assert.ok(fake.calls().every(c => !(c[0] === 'kill-server' || c[0] === 'start-server')));
  } finally {
    fake.cleanup();
  }
  await sleep(0);
});
