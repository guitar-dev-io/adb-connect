import test from 'node:test';
import assert from 'node:assert/strict';
import { DeviceTracker } from '../src/devices/tracker';
import { MdnsBrowser } from '../src/discovery/browser';
import { ConnectionManager } from '../src/connection/manager';
import { KnownDevice, MemoryKnownDeviceStore, sanitizeKnownDevices } from '../src/connection/known';
import { buildDeviceEntries, adbCommandsFor } from '../src/devices/model';
import { makeFake, until, sleep, Fake } from './helpers';

const GUID = 'adb-SERIAL1-abc';
const known = (over: Partial<KnownDevice> = {}): KnownDevice => ({
  id: GUID, name: 'Pixel 9 Pro', guid: GUID, lastEndpoint: '192.168.1.10:37123',
  autoReconnect: true, userDisconnected: false, ...over,
});

function setup(fake: Fake, devices: KnownDevice[], autoReconnect = true) {
  const tracker = new DeviceTracker(fake.runner, { minBackoffMs: 50 });
  const browser = new MdnsBrowser(fake.client, { intervalMs: 20, systemResolver: false });
  const store = new MemoryKnownDeviceStore(devices);
  const mgr = new ConnectionManager(fake.client, tracker, browser, store, { autoReconnect, retryDelayMs: 30, maxAttempts: 3 });
  return {
    tracker, browser, store, mgr,
    dispose: () => { mgr.dispose(); browser.dispose(); tracker.stop(); },
  };
}

const connects = (fake: Fake) => fake.calls().filter(c => c[0] === 'connect');

test('startup reconnect: only known, approved, advertising devices; follows a changed IP/port', async () => {
  const fake = makeFake({
    mdns: [
      `${GUID}\t_adb-tls-connect._tcp\t192.168.1.77:40555`, // same phone, new IP and port
      'adb-STRANGER-zzz\t_adb-tls-connect._tcp\t192.168.1.50:41000', // unknown device: must be ignored
    ],
    connect: {
      '192.168.1.77:40555': '192.168.1.77:40555 device model:Pixel_9_Pro',
      '192.168.1.50:41000': '192.168.1.50:41000 device model:Stranger',
    },
  });
  const t = setup(fake, [known(), known({ id: 'adb-OFF-1', guid: 'adb-OFF-1', name: 'Off phone', lastEndpoint: '192.168.1.20:5555' })]);
  try {
    const results = await t.mgr.reconnectAll('startup');
    assert.deepEqual(connects(fake), [['connect', '192.168.1.77:40555']]);
    assert.equal(results.find(r => r.device?.id === GUID)?.ok, true);
    assert.match(results.find(r => r.device?.id === 'adb-OFF-1')!.message, /not advertising/);
    assert.equal(t.mgr.known.find(k => k.id === GUID)?.lastEndpoint, '192.168.1.77:40555');
  } finally {
    t.dispose();
    fake.cleanup();
  }
});

test('respects auto-reconnect off, per-device opt-out and manual disconnect', async () => {
  const fake = makeFake({
    mdns: [`${GUID}\t_adb-tls-connect._tcp\t192.168.1.10:37123`],
    connect: { '192.168.1.10:37123': '192.168.1.10:37123 device model:Pixel_9_Pro' },
  });
  const off = setup(fake, [known()], false);
  try {
    await off.mgr.reconnectAll('startup');
    assert.equal(connects(fake).length, 0, 'global auto-reconnect off');
  } finally { off.dispose(); }

  const optOut = setup(fake, [known({ autoReconnect: false })]);
  try {
    await optOut.mgr.reconnectAll('startup');
    assert.equal(connects(fake).length, 0, 'device not approved');
  } finally { optOut.dispose(); }

  const t = setup(fake, [known({ userDisconnected: true })]);
  try {
    await t.mgr.reconnectAll('startup');
    assert.equal(connects(fake).length, 0, 'user disconnected');
    // a manual reconnect clears the flag
    const r = await t.mgr.reconnect(GUID, 'manual');
    assert.equal(r.ok, true);
    assert.equal(t.mgr.known[0].userDisconnected, false);
  } finally {
    t.dispose();
    fake.cleanup();
  }
});

test('manual disconnect marks the device and stops automatic retries', async () => {
  const fake = makeFake({
    devices: ['192.168.1.10:37123 device model:Pixel_9_Pro'],
    mdns: [`${GUID}\t_adb-tls-connect._tcp\t192.168.1.10:37123`],
    connect: { '192.168.1.10:37123': '192.168.1.10:37123 device model:Pixel_9_Pro' },
  });
  const t = setup(fake, [known()]);
  try {
    t.tracker.start();
    await until(() => t.tracker.devices.length === 1, 3000, 'tracked');
    await sleep(50);
    const r = await t.mgr.disconnect('192.168.1.10:37123');
    assert.equal(r.ok, true);
    assert.equal(t.mgr.known[0].userDisconnected, true);
    await sleep(300);
    assert.equal(connects(fake).length, 0, 'no reconnect after user disconnect');
  } finally {
    t.dispose();
    fake.cleanup();
  }
});

test('dropped device (network blip / server restart) is retried with bounded attempts', async () => {
  const fake = makeFake({
    devices: ['192.168.1.10:37123 device model:Pixel_9_Pro'],
    mdns: [`${GUID}\t_adb-tls-connect._tcp\t192.168.1.10:37123`],
    connect: {}, // all reconnects fail
  });
  const t = setup(fake, [known()]);
  let gaveUp = 0;
  t.mgr.on('gave-up', () => gaveUp++);
  try {
    t.tracker.start();
    await until(() => t.tracker.devices.length === 1, 3000, 'tracked');
    await sleep(50);
    fake.set({ devices: [] }); // device drops
    await until(() => gaveUp === 1, 5000, 'gave up');
    await sleep(400);
    assert.equal(connects(fake).length, 3, 'exactly maxAttempts automatic attempts');
  } finally {
    t.dispose();
    fake.cleanup();
  }
});

test('concurrent reconnects for the same device share one adb connect', async () => {
  const fake = makeFake({
    mdns: [`${GUID}\t_adb-tls-connect._tcp\t192.168.1.10:37123`],
    connect: { '192.168.1.10:37123': '192.168.1.10:37123 device model:Pixel_9_Pro' },
    delayMs: { connect: 100 },
  });
  const t = setup(fake, [known()]);
  try {
    await t.browser.refresh();
    const rs = await Promise.all([t.mgr.reconnect(GUID, 'manual'), t.mgr.reconnect(GUID, 'manual'), t.mgr.reconnect(GUID, 'startup')]);
    assert.ok(rs.every(r => r.ok));
    assert.equal(connects(fake).length, 1);
  } finally {
    t.dispose();
    fake.cleanup();
  }
});

test('advertisement of a known device triggers reconnect; unknown never does', async () => {
  const fake = makeFake({
    connect: {
      '192.168.1.30:40000': '192.168.1.30:40000 device model:Pixel_9_Pro',
      '192.168.1.50:41000': '192.168.1.50:41000 device model:Stranger',
    },
  });
  const t = setup(fake, [known()]);
  try {
    const lease = t.browser.acquire(); // "auto discover" on
    fake.set({ mdns: ['adb-STRANGER-zzz\t_adb-tls-connect._tcp\t192.168.1.50:41000'] });
    await sleep(150);
    assert.equal(connects(fake).length, 0);
    fake.set(s => { s.mdns.push(`${GUID}\t_adb-tls-connect._tcp\t192.168.1.30:40000`); });
    await until(() => connects(fake).length === 1, 3000, 'reconnect on advertise');
    assert.deepEqual(connects(fake)[0], ['connect', '192.168.1.30:40000']);
    lease.dispose();
  } finally {
    t.dispose();
    fake.cleanup();
  }
});

test('manual connect remembers the device with GUID and serial number', async () => {
  const fake = makeFake({
    mdns: [`${GUID}\t_adb-tls-connect._tcp\t192.168.1.10:37123`],
    connect: { '192.168.1.10:37123': '192.168.1.10:37123 device model:Pixel_9_Pro' },
  });
  const t = setup(fake, []);
  try {
    await t.browser.refresh();
    const r = await t.mgr.connectEndpoint('192.168.1.10:37123');
    assert.equal(r.ok, true);
    assert.equal(r.device?.guid, GUID);
    assert.equal(r.device?.name, 'Pixel 9 Pro');
    assert.ok(r.device?.serialNo);
    assert.equal(t.store.load().length, 1);
    assert.equal((await t.mgr.connectEndpoint('nope')).ok, false);
  } finally {
    t.dispose();
    fake.cleanup();
  }
});

test('device entries merge live, known and advertised devices; preferred first', () => {
  const k = known();
  const entries = buildDeviceEntries(
    [
      { serial: 'USB123', state: 'device', model: 'Galaxy S24', transport: 'usb', attrs: {} },
      { serial: '192.168.1.40:5555', state: 'offline', model: '192.168.1.40:5555', transport: 'wifi', endpoint: '192.168.1.40:5555', attrs: {} },
    ],
    [k],
    [
      { name: GUID, type: 'connect', endpoint: '192.168.1.10:40000', host: '192.168.1.10', port: 40000 },
      { name: 'adb-OTHER-1', type: 'connect', endpoint: '192.168.1.60:40000', host: '192.168.1.60', port: 40000 },
    ],
    () => undefined,
    GUID,
  );
  assert.deepEqual(entries.map(e => [e.name, e.status, e.preferred, e.known]), [
    ['Pixel 9 Pro', 'available', true, true],
    ['Galaxy S24', 'connected', false, false],
    ['192.168.1.40:5555', 'offline', false, false],
    ['adb-OTHER-1', 'available', false, false],
  ]);
  assert.equal(entries[0].endpoint, '192.168.1.10:40000', 'shows the currently advertised address');
  const cmds = adbCommandsFor(entries[1]).map(c => c.command);
  assert.ok(cmds.includes('adb -s USB123 shell'));
});

test('sanitizeKnownDevices drops malformed persisted data', () => {
  assert.deepEqual(sanitizeKnownDevices('x'), []);
  const out = sanitizeKnownDevices([{ id: 'a' }, null, { name: 'no id' }, { id: 'b', autoReconnect: false, userDisconnected: true, lastEndpoint: 5 }]);
  assert.equal(out.length, 2);
  assert.equal(out[0].autoReconnect, true);
  assert.equal(out[1].autoReconnect, false);
  assert.equal(out[1].lastEndpoint, undefined);
});
