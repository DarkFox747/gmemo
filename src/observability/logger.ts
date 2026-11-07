// Minimal leveled console logger — no external dependencies.
// Outputs newline-delimited JSON to stdout (info/debug) or stderr (warn/error).
// Swap this module for a structured logger (e.g. pino) in a later change
// without touching any call site, because the API surface is the same.

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

const LEVEL_RANK: Record<LogLevel, number> = {
  debug: 0,
  info: 1,
  warn: 2,
  error: 3,
};

let activeLevel: LogLevel = 'info';

/** Override the minimum level at runtime (called once during boot from Config). */
export function setLogLevel(level: LogLevel): void {
  activeLevel = level;
}

function emit(level: LogLevel, message: string, data?: unknown): void {
  if (LEVEL_RANK[level] < LEVEL_RANK[activeLevel]) return;

  const entry: Record<string, unknown> = {
    timestamp: new Date().toISOString(),
    level,
    message,
  };
  if (data !== undefined) {
    entry['data'] = data;
  }

  const line = JSON.stringify(entry);
  if (level === 'warn' || level === 'error') {
    console.error(line);
  } else {
    console.log(line);
  }
}

export const logger = {
  debug: (message: string, data?: unknown): void => emit('debug', message, data),
  info: (message: string, data?: unknown): void => emit('info', message, data),
  warn: (message: string, data?: unknown): void => emit('warn', message, data),
  error: (message: string, data?: unknown): void => emit('error', message, data),
};
