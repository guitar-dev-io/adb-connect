const test = require('node:test');
const assert = require('node:assert/strict');
const { validEndpoint, validPairingCode, parseDevices, parseMdns } = require('../dist');

test('validates endpoints', () => {
  assert.equal(validEndpoint('192.168.1.50:37123'), true);
  assert.equal(validEndpoint('pixel.local:5555'), true);
  assert.equal(validEndpoint('[fe80::1%wlan0]:5555'), true);
  assert.equal(validEndpoint('abc;rm -rf /:4'), false);
  assert.equal(validEndpoint('host:99999'), false);
  assert.equal(validEndpoint('host:0'), false);
  assert.equal(validEndpoint('192.168.1.50'), false);
  assert.equal(validEndpoint('-oProxy:5555'), false);
});

test('validates pairing codes', () => {
  assert.equal(validPairingCode('123456'), true);
  assert.equal(validPairingCode('12345'), false);
  assert.equal(validPairingCode('12345a'), false);
});

test('parses adb devices -l', () => {
  const d = parseDevices('List of devices attached\n192.168.1.10:35555 device product:foo model:Pixel_9 device:foo\nUSB123 unauthorized\n\n');
  assert.equal(d.length, 2);
  assert.equal(d[0].model, 'Pixel 9');
  assert.equal(d[0].transport, 'Wi-Fi');
  assert.equal(d[1].status, 'unauthorized');
  assert.equal(d[1].transport, 'USB');
});

test('parses adb mdns services', () => {
  const d = parseMdns('List of discovered mdns services\nadb-123\t_adb-tls-connect._tcp.\t192.168.1.10:36661\nadb-123 _adb-tls-pairing._tcp. 192.168.1.10:40001\nbogus _adb-tls-connect._tcp. not-an-endpoint\n');
  assert.equal(d.length, 2);
  assert.equal(d[0].service, '_adb-tls-connect._tcp');
  assert.equal(d[0].endpoint, '192.168.1.10:36661');
  assert.equal(d[1].service, '_adb-tls-pairing._tcp');
});
