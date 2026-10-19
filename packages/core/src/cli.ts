#!/usr/bin/env node
import { findAdb, adbVersion, listDevices, connect, disconnect, discover } from './adb';

function print(obj: unknown): never {
  console.log(JSON.stringify(obj));
  process.exit(0);
}

async function main() {
  const [cmd = 'status', arg] = process.argv.slice(2);
  const adb = await findAdb();
  if (!adb) print({ ok: false, error: 'adb-not-found' });

  switch (cmd) {
    case 'version':
      print({ ok: true, adbPath: adb, version: await adbVersion(adb) });
    case 'list-devices':
      print({ adbPath: adb, ...(await listDevices(adb)) });
    case 'discover':
      print(await discover(adb));
    case 'connect':
      print(await connect(adb, arg ?? ''));
    case 'disconnect':
      print(await disconnect(adb, arg ?? ''));
    case 'status': {
      const v = await adbVersion(adb);
      const d = await listDevices(adb);
      print({ ok: true, adbPath: adb, version: v, devices: d.devices });
    }
    default:
      print({ ok: false, error: `unknown-command: ${cmd}` });
  }
}

main().catch(err => {
  console.error(JSON.stringify({ ok: false, error: String(err) }));
  process.exit(1);
});
