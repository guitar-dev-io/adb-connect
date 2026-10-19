import test from 'node:test';
import assert from 'node:assert/strict';
import { DeviceTracker } from '../src/devices/tracker';
import { MdnsBrowser } from '../src/discovery/browser';
import { makeFake, until } from './helpers';

test('DeviceTracker: event-driven updates, multiple devices, adb server restart recovery', async () => {
  const fake = makeFake({ devices: ['USB1 device model:Pixel_9'] });
  const tracker = new DeviceTracker(fake.runner, { minBackoffMs: 50, maxBackoffMs: 200 });
  const snapshots: number[] = [];
  let lost = 0;
  tracker.on('devices', d => snapshots.push(d.length));
  tracker.on('lost', () => lost++);
  try {
    tracker.start();
    await until(() => tracker.devices.length === 1, 3000, 'first frame');

    fake.set(s => { s.devices.push('192.168.1.10:5555 device model:Pixel_8', '192.168.1.11:5555 offline'); });
    await until(() => tracker.devices.length === 3, 3000, 'multi-device frame');
    assert.deepEqual(tracker.devices.map(d => d.state), ['device', 'device', 'offline']);

    // Simulated adb server restart: stream exits, tracker re-attaches by itself
    fake.set(s => { s.trackGeneration = 1; });
    await until(() => lost === 1, 3000, 'lost event');
    await until(() => tracker.devices.length === 3, 3000, 're-attached');
    const trackStarts = fake.calls().filter(c => c[0] === 'track-devices').length;
    assert.equal(trackStarts, 2);
    assert.ok(fake.calls().every(c => c[0] !== 'kill-server'), 'never restarts the adb server');
  } finally {
    tracker.stop();
    fake.cleanup();
  }
});

test('MdnsBrowser: polls only while leased, no overlapping polls, added/removed diff', async () => {
  const fake = makeFake({ mdns: ['adb-A-1\t_adb-tls-connect._tcp\t192.168.1.10:4000'], delayMs: { mdns: 60 } });
  const browser = new MdnsBrowser(fake.client, { intervalMs: 20 });
  const added: string[] = [];
  const removed: string[] = [];
  browser.on('added', s => added.push(s.name));
  browser.on('removed', s => removed.push(s.name));
  try {
    const lease = browser.acquire();
    await until(() => added.includes('adb-A-1'), 3000, 'added');
    fake.set({ mdns: ['adb-B-1\t_adb-tls-connect._tcp\t192.168.1.11:4000'] });
    await until(() => removed.includes('adb-A-1') && added.includes('adb-B-1'), 3000, 'diff');
    lease.dispose();
    const polls = fake.calls().filter(c => c[0] === 'mdns').length;
    await new Promise(r => setTimeout(r, 200));
    const after = fake.calls().filter(c => c[0] === 'mdns').length;
    assert.ok(after - polls <= 1, 'stops polling after the last lease is released');

    // concurrent refresh() calls share one adb invocation
    const before = fake.calls().filter(c => c[0] === 'mdns').length;
    await Promise.all([browser.refresh(), browser.refresh(), browser.refresh()]);
    assert.equal(fake.calls().filter(c => c[0] === 'mdns').length - before, 1);
  } finally {
    browser.dispose();
    fake.cleanup();
  }
});
