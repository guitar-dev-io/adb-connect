import * as vscode from 'vscode';
import { KnownDevice, KnownDeviceStore, Logger, sanitizeKnownDevices } from '@adb-connect/core';

export const SECTION = 'adbConnect';

export interface Settings {
  adbPath: string;
  autoDiscover: boolean;
  autoReconnect: boolean;
  reconnectOnStartup: boolean;
  showStatusBar: boolean;
  preferredDevice: string;
  debugLogging: boolean;
}

export function readSettings(): Settings {
  const c = vscode.workspace.getConfiguration(SECTION);
  return {
    adbPath: c.get<string>('adbPath', '') ?? '',
    autoDiscover: c.get<boolean>('autoDiscover', true),
    autoReconnect: c.get<boolean>('autoReconnect', true),
    reconnectOnStartup: c.get<boolean>('reconnectOnStartup', true),
    showStatusBar: c.get<boolean>('showStatusBar', true),
    preferredDevice: c.get<string>('preferredDevice', '') ?? '',
    debugLogging: c.get<boolean>('debugLogging', false),
  };
}

/** Adapts core's structured logger to a VS Code LogOutputChannel. */
export function channelLogger(channel: vscode.LogOutputChannel, debugEnabled: () => boolean): Logger {
  return {
    log(level, message, fields) {
      const text = fields && Object.keys(fields).length ? `${message} ${JSON.stringify(fields)}` : message;
      switch (level) {
        case 'debug': if (debugEnabled()) channel.info(`[debug] ${text}`); else channel.debug(text); return;
        case 'info': return channel.info(text);
        case 'warn': return channel.warn(text);
        case 'error': return channel.error(text);
      }
    },
  };
}

/**
 * Known devices live in extension global state (VS Code's internal storage), not in settings.json.
 * They contain no secrets — adb keeps pairing keys in ~/.android.
 */
export class GlobalStateStore implements KnownDeviceStore {
  private static readonly KEY = 'adbConnect.knownDevices.v1';
  constructor(private readonly memento: vscode.Memento) {}
  load(): KnownDevice[] {
    return sanitizeKnownDevices(this.memento.get(GlobalStateStore.KEY));
  }
  async save(devices: KnownDevice[]): Promise<void> {
    await this.memento.update(GlobalStateStore.KEY, devices);
  }
}
