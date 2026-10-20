import test from 'node:test';
import assert from 'node:assert/strict';
import { mergeServices, SystemMdns } from '../src/discovery/system';
import { MdnsService, serviceKey } from '../src/discovery/parse';

const svc = (over: Partial<MdnsService> & Pick<MdnsService, 'name' | 'endpoint'>): MdnsService => {
  const [host, port] = over.endpoint.split(':');
  return { type: 'connect', host, port: Number(port), ...over };
};

test('mergeServices: adb wins on conflicts, system-only entries are added, sorted by serviceKey', () => {
  const fromAdb = [
    svc({ name: 'adb-A-1', endpoint: '192.168.1.10:5555' }),
    svc({ name: 'adb-B-2', endpoint: '192.168.1.20:5555' }),
  ];
  const fromSystem = [
    // Same type+name as an adb entry but a different endpoint: adb must win.
    svc({ name: 'adb-A-1', endpoint: '10.0.0.1:9999' }),
    // System-only entry: added.
    svc({ name: 'adb-C-3', endpoint: '192.168.1.30:5555' }),
  ];

  const merged = mergeServices(fromAdb, fromSystem);

  assert.equal(merged.length, 3);
  const a = merged.find(s => s.name === 'adb-A-1')!;
  assert.equal(a.endpoint, '192.168.1.10:5555', 'adb endpoint wins on conflict');
  assert.ok(merged.some(s => s.name === 'adb-C-3'), 'system-only entry added');

  const keys = merged.map(serviceKey);
  assert.deepEqual(keys, [...keys].sort((x, y) => x.localeCompare(y)), 'sorted by serviceKey');
});

test('mergeServices: a pairing and a connect service with the same name are distinct keys', () => {
  const merged = mergeServices(
    [svc({ name: 'adb-A-1', type: 'connect', endpoint: '192.168.1.10:5555' })],
    [svc({ name: 'adb-A-1', type: 'pairing', endpoint: '192.168.1.10:43210' })],
  );
  assert.equal(merged.length, 2, 'type is part of the identity');
});

test('SystemMdns: supported only on darwin/linux, reports an empty list before start', () => {
  const noop = () => undefined;
  assert.equal(new SystemMdns(noop, { platform: 'darwin' }).supported, true);
  assert.equal(new SystemMdns(noop, { platform: 'linux' }).supported, true);
  assert.equal(new SystemMdns(noop, { platform: 'win32' }).supported, false);
  assert.deepEqual(new SystemMdns(noop, { platform: 'darwin' }).list, []);
});

test('SystemMdns: start is a no-op on an unsupported platform', () => {
  let changes = 0;
  const sys = new SystemMdns(() => changes++, { platform: 'win32' });
  sys.start();
  assert.equal(changes, 0);
  assert.deepEqual(sys.list, []);
  sys.stop();
});
