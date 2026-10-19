export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

export type LogFields = Record<string, unknown>;

/** Structured logger. IDE integrations adapt this to their own output channel / log. */
export interface Logger {
  log(level: LogLevel, message: string, fields?: LogFields): void;
}

export const nullLogger: Logger = { log() {} };

/** Replace every occurrence of each secret in `text`. Empty secrets are ignored. */
export function redact(text: string, secrets: readonly string[]): string {
  let out = text;
  for (const s of secrets) {
    if (s) out = out.split(s).join('[REDACTED]');
  }
  return out;
}

/** Render adb args for logs, hiding the pairing secret (`adb pair <endpoint> <secret>`). */
export function describeArgs(args: readonly string[]): string {
  return args.map((a, i) => (args[0] === 'pair' && i === 2 ? '[REDACTED]' : a)).join(' ');
}
