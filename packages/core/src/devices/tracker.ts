import { EventEmitter } from 'events';
import type { ChildProcessWithoutNullStreams } from 'child_process';
import { AdbRunner } from '../adb/runner';
import { Device, parseDevices, TrackDevicesDecoder } from './parse';
import { Logger, nullLogger } from '../log';

export interface DeviceTrackerOptions {
  logger?: Logger;
  /** First restart delay after the stream ends (adb server restart, crash). Default 1s. */
  minBackoffMs?: number;
  /** Cap for exponential restart delay. Default 30s. */
  maxBackoffMs?: number;
}

export interface DeviceTrackerEvents {
  devices: (devices: Device[]) => void;
  /** The stream to the adb server dropped; devices are unknown until it reconnects. */
  lost: (reason: string) => void;
}

export declare interface DeviceTracker {
  on<E extends keyof DeviceTrackerEvents>(event: E, listener: DeviceTrackerEvents[E]): this;
  off<E extends keyof DeviceTrackerEvents>(event: E, listener: DeviceTrackerEvents[E]): this;
  emit<E extends keyof DeviceTrackerEvents>(event: E, ...args: Parameters<DeviceTrackerEvents[E]>): boolean;
}

/**
 * Event-driven device list via one long-lived `adb track-devices -l`.
 * If the stream ends (adb server restarted by another tool, killed, etc.) it re-attaches with
 * capped exponential backoff. It never kills or restarts the adb server itself; the adb client
 * only starts a server if none is running, which is standard adb behaviour.
 */
export class DeviceTracker extends EventEmitter {
  private child?: ChildProcessWithoutNullStreams;
  private timer?: NodeJS.Timeout;
  private backoff: number;
  private running = false;
  private latest: Device[] = [];
  private readonly logger: Logger;
  private readonly minBackoff: number;
  private readonly maxBackoff: number;

  constructor(private readonly runner: AdbRunner, opts: DeviceTrackerOptions = {}) {
    super();
    this.logger = opts.logger ?? nullLogger;
    this.minBackoff = opts.minBackoffMs ?? 1_000;
    this.maxBackoff = opts.maxBackoffMs ?? 30_000;
    this.backoff = this.minBackoff;
  }

  get devices(): Device[] {
    return this.latest;
  }

  get isRunning(): boolean {
    return this.running;
  }

  start(): void {
    if (this.running) return;
    this.running = true;
    this.attach();
  }

  stop(): void {
    this.running = false;
    clearTimeout(this.timer);
    this.timer = undefined;
    const c = this.child;
    this.child = undefined;
    c?.kill();
  }

  private attach() {
    if (!this.running) return;
    const decoder = new TrackDevicesDecoder();
    let child: ChildProcessWithoutNullStreams;
    try {
      child = this.runner.spawnStream(['track-devices', '-l']);
    } catch (e) {
      return this.scheduleRestart(`spawn failed: ${(e as Error).message}`);
    }
    this.child = child;
    let stderr = '';
    child.stdout.on('data', (chunk: Buffer) => {
      for (const frame of decoder.push(chunk)) {
        this.backoff = this.minBackoff;
        this.latest = parseDevices(frame);
        this.emit('devices', this.latest);
      }
    });
    child.stderr.on('data', (b: Buffer) => { stderr = (stderr + b.toString()).slice(-2_000); });
    child.on('error', e => this.onEnd(child, e.message));
    child.on('close', code => this.onEnd(child, stderr.trim() || `track-devices exited (${code})`));
  }

  private onEnd(child: ChildProcessWithoutNullStreams, reason: string) {
    if (this.child !== child) return; // stale or stopped
    this.child = undefined;
    if (!this.running) return;
    this.latest = [];
    this.emit('lost', reason);
    this.scheduleRestart(reason);
  }

  private scheduleRestart(reason: string) {
    if (!this.running) return;
    const delay = this.backoff;
    this.backoff = Math.min(this.backoff * 2, this.maxBackoff);
    this.logger.log('warn', 'Device tracking interrupted; re-attaching', { reason, delayMs: delay });
    this.timer = setTimeout(() => this.attach(), delay);
  }
}
