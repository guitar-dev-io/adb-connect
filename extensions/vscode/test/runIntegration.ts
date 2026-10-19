/**
 * Runs the integration suite in a real VS Code instance against a fake adb.
 * Uses $VSCODE_EXECUTABLE (e.g. a locally installed VS Code / Cursor / Kiro) or downloads stable.
 */
import fs from 'fs';
import os from 'os';
import path from 'path';
import { runTests, downloadAndUnzipVSCode } from '@vscode/test-electron';

async function main() {
  const root = path.resolve(__dirname, '..', '..');
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'adbc-it-'));
  const fakeJs = require.resolve('@adb-connect/core/dist/test/fake-adb.js');
  const stateFile = path.join(tmp, 'state.json');
  const logFile = path.join(tmp, 'calls.log');
  fs.writeFileSync(logFile, '');
  fs.writeFileSync(stateFile, JSON.stringify({
    devices: ['R58N12345AB device product:dm3 model:Galaxy_S24 device:dm3 transport_id:1'],
    mdns: ['adb-PIXEL9-abc\t_adb-tls-connect._tcp\t192.168.1.45:37123'],
    connect: { '192.168.1.45:37123': '192.168.1.45:37123 device product:caiman model:Pixel_9_Pro device:caiman transport_id:2' },
    logFile,
  }));
  const adb = path.join(tmp, process.platform === 'win32' ? 'adb.cmd' : 'adb');
  fs.writeFileSync(adb, process.platform === 'win32'
    ? `@set FAKE_ADB_STATE=${stateFile}\r\n@"${process.execPath}" "${fakeJs}" %*\r\n`
    : `#!/bin/sh\nFAKE_ADB_STATE="${stateFile}" exec "${process.execPath}" "${fakeJs}" "$@"\n`, { mode: 0o755 });

  const userData = path.join(tmp, 'user-data');
  fs.mkdirSync(path.join(userData, 'User'), { recursive: true });
  fs.writeFileSync(path.join(userData, 'User', 'settings.json'), JSON.stringify({
    'adbConnect.adbPath': adb,
    'adbConnect.autoDiscover': true,
    'adbConnect.reconnectOnStartup': false,
    'workbench.startupEditor': 'none',
  }));

  const vscodeExecutablePath = process.env.VSCODE_EXECUTABLE || (await downloadAndUnzipVSCode('stable'));
  try {
    await runTests({
      vscodeExecutablePath,
      extensionDevelopmentPath: root,
      extensionTestsPath: path.join(__dirname, 'integration', 'index.js'),
      extensionTestsEnv: { ADBC_FAKE_STATE: stateFile, ADBC_FAKE_LOG: logFile },
      launchArgs: ['--user-data-dir', userData, '--disable-extensions', '--disable-workspace-trust', '--skip-welcome', '--skip-release-notes', tmp],
    });
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
