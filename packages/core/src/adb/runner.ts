import { spawn, ChildProcessWithoutNullStreams } from 'child_process';
import { Logger, nullLogger, describeArgs, redact } from '../log';

export interface AdbResult {
  code: number | null;
  stdout: string;
  stderr: string;
  /** stdout and stderr joined, trimmed. adb prints many failures to stdout with exit code 0. */
  text: string;
}

export interface RunOptions {
  timeoutMs?: number;
  signal?: AbortSignal;
  /** Values that must never reach logs or returned text (e.g. pairing codes). */
  secrets?: readonly string[];
}

export class AdbError extends Error {
  constructor(message: string, readonly kind: 'not-found' | 'timeout' | 'cancelled' | 'spawn' | 'version') {
    super(message);
    this.name = 'AdbError';
  }
}

const MAX_OUTPUT = 100_000;

/** Small FIFO semaphore so we never fan out an unbounded number of adb processes. */
class Semaphore {
  private queue: (() => void)[] = [];
  private active = 0;
  constructor(private readonly max: number) {}

  async acquire(signal?: AbortSignal): Promise<() => void> {
    if (this.active < this.max) {
      this.active++;
      return () => this.release();
    }
    await new Promise<void>((resolve, reject) => {
      const onAbort = () => {
        this.queue = this.queue.filter(f => f !== go);
        reject(new AdbError('adb command cancelled', 'cancelled'));
      };
      const go = () => {
        signal?.removeEventListener('abort', onAbort);
        resolve();
      };
      if (signal?.aborted) return onAbort();
      signal?.addEventListener('abort', onAbort, { once: true });
      this.queue.push(go);
    });
    // The releasing caller handed its slot straight to us; `active` is unchanged.
    return () => this.release();
  }

  private release() {
    const next = this.queue.shift();
    if (next) next();
    else this.active--;
  }
}

export interface AdbRunnerOptions {
  adbPath: string;
  logger?: Logger;
  /** Upper bound on concurrently running short-lived adb commands. Default 4. */
  maxConcurrent?: number;
  defaultTimeoutMs?: number;
}

/**
 * Runs adb without a shell, with timeouts, cancellation, bounded output and bounded concurrency.
 * Never restarts the adb server.
 */
export class AdbRunner {
  readonly adbPath: string;
  private readonly logger: Logger;
  private readonly limiter: Semaphore;
  private readonly defaultTimeoutMs: number;

  constructor(opts: AdbRunnerOptions) {
    this.adbPath = opts.adbPath;
    this.logger = opts.logger ?? nullLogger;
    this.limiter = new Semaphore(opts.maxConcurrent ?? 4);
    this.defaultTimeoutMs = opts.defaultTimeoutMs ?? 12_000;
  }

  async run(args: readonly string[], opts: RunOptions = {}): Promise<AdbResult> {
    const release = await this.limiter.acquire(opts.signal);
    const started = Date.now();
    try {
      const r = await this.exec(args, opts);
      this.logger.log('debug', `adb ${describeArgs(args)}`, { exit: r.code, ms: Date.now() - started });
      return r;
    } catch (e) {
      this.logger.log('debug', `adb ${describeArgs(args)} failed`, { error: (e as Error).message, ms: Date.now() - started });
      throw e;
    } finally {
      release();
    }
  }

  /** Long-lived process (e.g. `track-devices`). Caller owns its lifetime. */
  spawnStream(args: readonly string[]): ChildProcessWithoutNullStreams {
    this.logger.log('debug', `adb ${describeArgs(args)} (stream)`);
    return spawn(this.adbPath, args as string[], { windowsHide: true, shell: false, stdio: 'pipe' });
  }

  private exec(args: readonly string[], opts: RunOptions): Promise<AdbResult> {
    const timeoutMs = opts.timeoutMs ?? this.defaultTimeoutMs;
    const secrets = opts.secrets ?? [];
    return new Promise((resolve, reject) => {
      if (opts.signal?.aborted) return reject(new AdbError('adb command cancelled', 'cancelled'));
      let done = false;
      let out = '';
      let err = '';
      const cp = spawn(this.adbPath, args as string[], { windowsHide: true, shell: false, stdio: ['ignore', 'pipe', 'pipe'] });
      const finish = (error: Error | null, result?: AdbResult) => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        opts.signal?.removeEventListener('abort', onAbort);
        if (error) reject(error);
        else resolve(result!);
      };
      const onAbort = () => {
        cp.kill();
        finish(new AdbError('adb command cancelled', 'cancelled'));
      };
      const timer = setTimeout(() => {
        cp.kill();
        finish(new AdbError(`adb ${args[0] ?? ''} timed out after ${timeoutMs} ms`, 'timeout'));
      }, timeoutMs);
      opts.signal?.addEventListener('abort', onAbort, { once: true });
      cp.stdout.on('data', (b: Buffer) => { out = (out + b.toString()).slice(-MAX_OUTPUT); });
      cp.stderr.on('data', (b: Buffer) => { err = (err + b.toString()).slice(-MAX_OUTPUT); });
      cp.on('error', e => {
        const kind = (e as NodeJS.ErrnoException).code === 'ENOENT' ? 'not-found' : 'spawn';
        finish(new AdbError(`Cannot run adb (${this.adbPath}): ${e.message}`, kind));
      });
      cp.on('close', code => {
        const stdout = redact(out, secrets);
        const stderr = redact(err, secrets);
        finish(null, { code, stdout, stderr, text: `${stdout}\n${stderr}`.trim() });
      });
    });
  }
}
