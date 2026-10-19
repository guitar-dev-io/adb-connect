import { execFile } from 'child_process';
import { promisify } from 'util';

const execFileAsync = promisify(execFile);

export async function findAdb(): Promise<string | null> {
  try {
    const cmd = process.platform === 'win32' ? 'where' : 'which';
    const { stdout } = await execFileAsync(cmd, ['adb']);
    const p = stdout.split(/\r?\n/)[0].trim();
    return p || null;
  } catch (err) {
    return null;
  }
}

export async function adbVersion(adbPath?: string): Promise<{ ok: boolean; version?: string; raw?: string }> {
  const adb = adbPath || 'adb';
  try {
    const { stdout } = await execFileAsync(adb, ['version']);
    const raw = stdout.toString();
    const m = raw.match(/Android Debug Bridge version ([0-9.]+)/i);
    return { ok: true, version: m ? m[1] : undefined, raw };
  } catch (err: any) {
    return { ok: false, raw: (err && err.message) ? String(err.message) : String(err) };
  }
}

export async function listDevices(adbPath?: string): Promise<{ ok: boolean; devices?: any[]; raw?: string }> {
  const adb = adbPath || 'adb';
  try {
    const { stdout } = await execFileAsync(adb, ['devices', '-l']);
    const raw = stdout.toString();
    const lines = raw.split(/\r?\n/).slice(1).map(l => l.trim()).filter(Boolean);
    const devices = lines.map(line => {
      const parts = line.split(/\s+/);
      const serial = parts[0];
      const props: any = { serial };
      for (let i = 1; i < parts.length; i++) {
        const p = parts[i];
        if (p.includes(':')) {
          const [k, v] = p.split(':');
          props[k] = v;
        } else if (p === 'device' || p === 'unauthorized' || p === 'offline') {
          props.state = p;
        }
      }
      return props;
    });
    return { ok: true, devices, raw };
  } catch (err: any) {
    return { ok: false, raw: (err && err.message) ? String(err.message) : String(err) };
  }
}
