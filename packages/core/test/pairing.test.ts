import test from 'node:test';
import assert from 'node:assert/strict';
import { MdnsBrowser } from '../src/discovery/browser';
import { QrPairingSession, pairWithCode, PairingUpdate } from '../src/pairing/session';
import { makeFake, sleep } from './helpers';

const GUID = 'adb-35121FDH2000AB-Qz5WvP';

test('QR pairing: phone scans, advertises our service name, adb pair with our password, then connect', async () => {
  const fake = makeFake();
  const browser = new MdnsBrowser(fake.client, { intervalMs: 20 });
  const updates: PairingUpdate[] = [];
  const session = new QrPairingSession(fake.client, browser, { scanTimeoutMs: 5000, connectTimeoutMs: 3000, onUpdate: u => updates.push(u) });
  const { serviceName, password } = session.credentials;
  try {
    // Phone side: after "scanning", advertise the pairing service under the QR service name
    fake.set({
      pair: { '192.168.1.10:42761': { secret: password, guid: GUID, connectEndpoint: '192.168.1.10:37123' } },
      connect: { '192.168.1.10:37123': '192.168.1.10:37123 device product:husky model:Pixel_9_Pro device:husky' },
    });
    setTimeout(() => fake.set(s => {
      s.mdns.push('adb-UNRELATED-1\t_adb-tls-pairing._tcp\t192.168.1.99:1111'); // someone else pairing: ignored
      s.mdns.push(`${serviceName}\t_adb-tls-pairing._tcp.\t192.168.1.10:42761`);
    }), 100);

    const r = await session.run();
    assert.equal(r.state, 'connected', r.message);
    assert.equal(r.guid, GUID);
    assert.equal(r.endpoint, '192.168.1.10:37123');
    assert.equal(r.device?.model, 'Pixel 9 Pro');
    assert.deepEqual([...new Set(updates.map(u => u.state))], ['waiting-for-scan', 'pairing', 'connecting', 'connected']);

    const pairs = fake.calls().filter(c => c[0] === 'pair');
    assert.deepEqual(pairs, [['pair', '192.168.1.10:42761', password]], 'paired only with the advertised service, using the QR password');
    assert.ok(!JSON.stringify(fake.logs).includes(password), 'QR password not logged');
  } finally {
    browser.dispose();
    fake.cleanup();
  }
});

test('QR pairing: adb auto-connects after pairing → no extra adb connect', async () => {
  const fake = makeFake();
  const browser = new MdnsBrowser(fake.client, { intervalMs: 20 });
  const session = new QrPairingSession(fake.client, browser, { scanTimeoutMs: 5000, connectTimeoutMs: 3000 });
  try {
    fake.set({ pair: { '10.0.0.5:40001': { secret: session.credentials.password, guid: GUID, connectEndpoint: '10.0.0.5:40002' } } });
    setTimeout(() => fake.set(s => {
      s.mdns.push(`${session.credentials.serviceName}\t_adb-tls-pairing._tcp\t10.0.0.5:40001`);
      s.devices.push(`${GUID}._adb-tls-connect._tcp device model:Pixel_8`);
    }), 50);
    const r = await session.run();
    assert.equal(r.state, 'connected');
    assert.equal(fake.calls().filter(c => c[0] === 'connect').length, 0);
  } finally {
    browser.dispose();
    fake.cleanup();
  }
});

test('QR pairing timeout and cancel', async () => {
  const fake = makeFake();
  const browser = new MdnsBrowser(fake.client, { intervalMs: 20 });
  try {
    const timedOut = await new QrPairingSession(fake.client, browser, { scanTimeoutMs: 150 }).run();
    assert.equal(timedOut.state, 'timeout');

    const s = new QrPairingSession(fake.client, browser, { scanTimeoutMs: 5000 });
    setTimeout(() => s.cancel(), 80);
    assert.equal((await s.run()).state, 'cancelled');
    assert.equal(fake.calls().filter(c => c[0] === 'pair').length, 0);
    await sleep(60);
    assert.equal(browser.active, false, 'lease released');
  } finally {
    browser.dispose();
    fake.cleanup();
  }
});

test('QR pairing refuses when adb mDNS backend is unavailable (no fake fallback)', async () => {
  const fake = makeFake({ mdnsAvailable: false });
  const browser = new MdnsBrowser(fake.client);
  try {
    const r = await new QrPairingSession(fake.client, browser).run();
    assert.equal(r.state, 'failed');
    assert.match(r.message, /mDNS/);
  } finally {
    browser.dispose();
    fake.cleanup();
  }
});

test('six-digit code pairing: wrong code fails, right code pairs and connects', async () => {
  const fake = makeFake({
    pair: { '192.168.1.10:42761': { secret: '482913', guid: GUID, connectEndpoint: '192.168.1.10:37123' } },
    connect: { '192.168.1.10:37123': '192.168.1.10:37123 device model:Pixel_9_Pro' },
  });
  const browser = new MdnsBrowser(fake.client, { intervalMs: 20 });
  try {
    const bad = await pairWithCode(fake.client, browser, '192.168.1.10:42761', '000000');
    assert.equal(bad.state, 'failed');
    assert.equal((await pairWithCode(fake.client, browser, '192.168.1.10:42761', '12ab56')).state, 'failed');
    const ok = await pairWithCode(fake.client, browser, '192.168.1.10:42761', '482913', { connectTimeoutMs: 3000 });
    assert.equal(ok.state, 'connected', ok.message);
    assert.equal(ok.endpoint, '192.168.1.10:37123');
  } finally {
    browser.dispose();
    fake.cleanup();
  }
});

test('paired but connect service never appears → "paired" with guidance', async () => {
  const fake = makeFake({ pair: { '192.168.1.10:42761': { secret: '482913', guid: GUID } } });
  const browser = new MdnsBrowser(fake.client, { intervalMs: 20 });
  try {
    const r = await pairWithCode(fake.client, browser, '192.168.1.10:42761', '482913', { connectTimeoutMs: 150 });
    assert.equal(r.state, 'paired');
    assert.match(r.message, /Connect by IP:Port/);
  } finally {
    browser.dispose();
    fake.cleanup();
  }
});
