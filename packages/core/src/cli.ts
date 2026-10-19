#!/usr/bin/env node
import path from 'path';
import { findAdb, adbVersion, listDevices } from './adb';

async function main() {
  const cmd = process.argv[2] || 'status';
  if (cmd === 'version') {
    const adb = await findAdb();
    if (!adb) {
      console.log(JSON.stringify({ ok: false, error: 'adb-not-found' }));
      process.exit(0);
    }
    const v = await adbVersion(adb);
    console.log(JSON.stringify({ ok: true, adbPath: adb, version: v }));
    process.exit(0);
  }

  if (cmd === 'list-devices') {
    const adb = await findAdb();
    if (!adb) {
      console.log(JSON.stringify({ ok: false, error: 'adb-not-found' }));
      process.exit(0);
    }
    const r = await listDevices(adb);
    console.log(JSON.stringify(Object.assign({ adbPath: adb }, r)));
    process.exit(0);
  }

  // default: status
  const adb = await findAdb();
  if (!adb) {
    console.log(JSON.stringify({ ok: false, status: 'adb-not-found' }));
    process.exit(0);
  }
  const v = await adbVersion(adb);
  const d = await listDevices(adb);
  console.log(JSON.stringify({ ok: true, adbPath: adb, version: v, devices: d.devices || [] }));
  process.exit(0);
}

main().catch(err => {
  console.error(JSON.stringify({ ok: false, error: String(err) }));
  process.exit(1);
});
