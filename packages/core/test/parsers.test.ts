import test from 'node:test';
import assert from 'node:assert/strict';
import { fixtures } from './helpers';
import { parseDevices, TrackDevicesDecoder } from '../src/devices/parse';
import { parseMdns } from '../src/discovery/parse';
import { parsePairOutput, parseConnectOutput } from '../src/pairing/parse';
import { parseAdbVersion, supportsWirelessPairing } from '../src/adb/version';
import { validEndpoint, validPairingCode } from '../src/connection/endpoint';
import { qrPayload, createQrCredentials } from '../src/pairing/qr';
import { redact, describeArgs } from '../src/log';

const pick = (o: Record<string, unknown>, keys: string[]) =>
  Object.fromEntries(keys.filter(k => o[k] !== undefined).map(k => [k, o[k]]));

for (const c of fixtures.devices) {
  test(`parseDevices: ${c.name}`, () => {
    const got = parseDevices(c.input).map(d => pick(d as never, ['serial', 'state', 'model', 'transport', 'endpoint', 'mdnsName']));
    assert.deepEqual(got, c.expected);
  });
}

test('TrackDevicesDecoder handles frames split at every byte', () => {
  for (const c of fixtures.trackDevicesFrames) {
    const dec = new TrackDevicesDecoder();
    const frames: string[] = [];
    for (const ch of Buffer.from(c.input)) frames.push(...dec.push(Buffer.from([ch])));
    assert.equal(frames.length, c.expectedFrames);
    assert.deepEqual(frames.map(f => parseDevices(f).length), c.expectedDeviceCounts);
  }
});

for (const c of fixtures.mdns) {
  test(`parseMdns: ${c.name}`, () => {
    assert.deepEqual(parseMdns(c.input).map(s => pick(s as never, ['name', 'type', 'endpoint'])), c.expected);
  });
}

test('parsePairOutput', () => {
  for (const c of fixtures.pair) {
    assert.deepEqual(pick(parsePairOutput(c.input) as never, ['ok', 'endpoint', 'guid']), c.expected, c.input);
  }
});

test('parseConnectOutput', () => {
  for (const c of fixtures.connect) {
    assert.deepEqual(pick(parseConnectOutput(c.input) as never, ['ok', 'already']), c.expected, c.input);
  }
});

test('parseAdbVersion / supportsWirelessPairing', () => {
  for (const c of fixtures.version) {
    const v = parseAdbVersion(c.input)!;
    assert.deepEqual({ ...pick(v as never, ['adb', 'platformTools']), wirelessPairing: supportsWirelessPairing(v) }, c.expected);
  }
  assert.equal(parseAdbVersion('garbage'), null);
});

test('endpoint and pairing-code validation', () => {
  for (const e of fixtures.endpoints.valid) assert.equal(validEndpoint(e), true, e);
  for (const e of fixtures.endpoints.invalid) assert.equal(validEndpoint(e), false, e);
  assert.equal(validPairingCode('123456'), true);
  for (const c of ['12345', '1234567', '12345a', '', ' 123456']) assert.equal(validPairingCode(c), false, c);
});

test('QR payload format matches Android Wireless Debugging', () => {
  assert.equal(qrPayload(fixtures.qr.credentials), fixtures.qr.payload);
  const a = createQrCredentials();
  const b = createQrCredentials();
  assert.notEqual(a.password, b.password);
  assert.match(a.serviceName, /^adbconnect-[a-z0-9]{10}$/);
  assert.match(a.password, /^[A-Za-z0-9]{12}$/);
  assert.match(qrPayload(a), /^WIFI:T:ADB;S:adbconnect-[a-z0-9]{10};P:[A-Za-z0-9]{12};;$/);
  assert.throws(() => qrPayload({ serviceName: 'x;y', password: 'p' }));
});

test('secrets are redacted', () => {
  assert.equal(redact('code 123456 and 123456', ['123456']), 'code [REDACTED] and [REDACTED]');
  assert.equal(describeArgs(['pair', '1.2.3.4:5', '123456']), 'pair 1.2.3.4:5 [REDACTED]');
  assert.equal(describeArgs(['connect', '1.2.3.4:5']), 'connect 1.2.3.4:5');
});
