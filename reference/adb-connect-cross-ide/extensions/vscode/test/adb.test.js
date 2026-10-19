const test=require('node:test'); const assert=require('node:assert/strict');
const {validEndpoint,parseDevices,parseMdns}=require('../src/adb');
test('validates endpoint',()=>{assert.equal(validEndpoint('192.168.1.50:37123'),true);assert.equal(validEndpoint('abc;rm -rf /:4'),false);assert.equal(validEndpoint('host:99999'),false);});
test('parses adb devices',()=>{const d=parseDevices('List of devices attached\n192.168.1.10:35555 device product:foo model:Pixel_9 device:foo\nUSB123 unauthorized\n');assert.equal(d.length,2);assert.equal(d[0].model,'Pixel_9');assert.equal(d[1].status,'unauthorized');});
test('parses adb mdns services',()=>{const d=parseMdns('adb-123 _adb-tls-connect._tcp. 192.168.1.10:36661\n');assert.equal(d.length,1);assert.equal(d[0].endpoint,'192.168.1.10:36661');});
