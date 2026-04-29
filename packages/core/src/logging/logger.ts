import type { Writable } from 'node:stream';

import pino from 'pino';
import pinoPretty from 'pino-pretty';

export type LogLevel = pino.Level;
export type LogLevelWithSilent = pino.LevelWithSilent;
export type LogBindings = Readonly<Record<string, unknown>>;
export type LogFormat = 'pretty' | 'json';
export type LogDestination = 'stderr' | 'stdout' | Writable;
export type Logger = pino.Logger;

export interface CreateLoggerOptions {
  level?: LogLevelWithSilent;
  format?: LogFormat;
  destination?: LogDestination;
  bindings?: LogBindings;
}

function resolveDestination(dest: LogDestination): NodeJS.WritableStream {
  if (dest === 'stderr') {
    return process.stderr;
  }
  if (dest === 'stdout') {
    return process.stdout;
  }
  return dest;
}

export function createLogger(options: CreateLoggerOptions = {}): Logger {
  const level: LogLevelWithSilent = options.level ?? 'info';
  const destination = resolveDestination(options.destination ?? 'stderr');
  const isTty = process.stdout.isTTY === true;
  const format: LogFormat = options.format ?? (isTty ? 'pretty' : 'json');
  const bindings = options.bindings;
  const base: Record<string, unknown> | null =
    bindings !== undefined && Object.keys(bindings).length > 0 ? { ...bindings } : null;

  const pinoOptions: pino.LoggerOptions = {
    level,
    base,
    timestamp: pino.stdTimeFunctions.isoTime,
  };

  if (format === 'pretty') {
    // pino-pretty's `colorize` is gated on `process.stdout.isTTY === true` per
    // the M0-02 acceptance criterion: no ANSI when stdout is not a TTY, even
    // though the logger usually writes to stderr.
    const pretty = pinoPretty({
      colorize: isTty,
      destination,
      sync: true,
    });
    return pino(pinoOptions, pretty);
  }
  return pino(pinoOptions, destination);
}

export function createNoopLogger(): Logger {
  return pino({ level: 'silent' });
}
