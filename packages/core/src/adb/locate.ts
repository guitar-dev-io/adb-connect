import fs from 'fs';
import os from 'os';
import path from 'path';

export type AdbSource = 'setting' | 'ANDROID_HOME' | 'ANDROID_SDK_ROOT' | 'PATH' | 'default-sdk';

export interface AdbLocation {
  path: string;
  source: AdbSource;
}

export interface LocateOptions {
  /** User-configured path. Empty or plain "adb" means "auto-detect". */
  configuredPath?: string;
  env?: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
  homedir?: string;
}

function exeName(platform: NodeJS.Platform) {
  return platform === 'win32' ? 'adb.exe' : 'adb';
}

function isExecutable(p: string, platform: NodeJS.Platform): boolean {
  try {
    const st = fs.statSync(p);
    if (!st.isFile()) return false;
    if (platform !== 'win32') fs.accessSync(p, fs.constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/** Candidate adb locations in priority order. Pure; does not touch the filesystem. */
export function adbCandidates(opts: LocateOptions = {}): AdbLocation[] {
  const env = opts.env ?? process.env;
  const platform = opts.platform ?? process.platform;
  const home = opts.homedir ?? os.homedir();
  const p = platform === 'win32' ? path.win32 : path.posix;
  const exe = exeName(platform);
  const out: AdbLocation[] = [];

  const configured = opts.configuredPath?.trim();
  if (configured && configured !== 'adb' && configured !== 'adb.exe') {
    out.push({ path: configured, source: 'setting' });
  }
  for (const key of ['ANDROID_HOME', 'ANDROID_SDK_ROOT'] as const) {
    if (env[key]) out.push({ path: p.join(env[key]!, 'platform-tools', exe), source: key });
  }
  const pathVar = env.PATH ?? env.Path ?? '';
  for (const dir of pathVar.split(platform === 'win32' ? ';' : ':')) {
    if (dir) out.push({ path: p.join(dir, exe), source: 'PATH' });
  }
  const defaults =
    platform === 'darwin' ? [p.join(home, 'Library', 'Android', 'sdk')]
    : platform === 'win32' ? [p.join(env.LOCALAPPDATA ?? p.join(home, 'AppData', 'Local'), 'Android', 'Sdk')]
    : [p.join(home, 'Android', 'Sdk')];
  for (const sdk of defaults) out.push({ path: p.join(sdk, 'platform-tools', exe), source: 'default-sdk' });
  return out;
}

/**
 * Find the adb executable. A configured path that does not exist is reported as missing
 * rather than silently falling back, so the user sees their setting is wrong.
 */
export function locateAdb(opts: LocateOptions = {}): AdbLocation | null {
  const platform = opts.platform ?? process.platform;
  const candidates = adbCandidates(opts);
  if (candidates[0]?.source === 'setting') {
    return isExecutable(candidates[0].path, platform) ? candidates[0] : null;
  }
  return candidates.find(c => isExecutable(c.path, platform)) ?? null;
}
