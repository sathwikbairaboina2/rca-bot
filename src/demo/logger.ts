import { toIso } from "../core/time.js";

export type LogSink = (line: string) => void;

export interface Logger {
  info(message: string, extra?: Record<string, unknown>): void;
  warn(message: string, extra?: Record<string, unknown>): void;
  error(message: string, extra?: Record<string, unknown>): void;
}

export interface LoggerOptions {
  service: string;
  functionVersion: string;
  requestId: string;
  now: () => number;
  sink: LogSink;
}

/** One JSON object per line, the shape the catalog queries expect. */
export function createLogger(o: LoggerOptions): Logger {
  const emit = (level: string, message: string, extra?: Record<string, unknown>) => {
    o.sink(
      JSON.stringify({
        level,
        message,
        service: o.service,
        timestamp: toIso(o.now()),
        requestId: o.requestId,
        functionVersion: o.functionVersion,
        ...extra,
      }),
    );
  };
  return {
    info: (m, e) => emit("INFO", m, e),
    warn: (m, e) => emit("WARN", m, e),
    error: (m, e) => emit("ERROR", m, e),
  };
}
