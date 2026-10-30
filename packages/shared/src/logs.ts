import { z } from 'zod';
import { ListSearchParam } from './list-search.js';

// Logs contract: the in-memory ring buffer of recent log records, the rotating log files and
// the live stream (GET /log/stream, one LogRecord JSON per WebSocket message).

export const LogLevel = z.enum(['trace', 'debug', 'info', 'warn', 'error', 'fatal']);
export type LogLevel = z.infer<typeof LogLevel>;

/** Numeric severity per level (pino's scale), used for "this level and above" filtering. */
export const LOG_LEVEL_VALUES: Readonly<Record<LogLevel, number>> = {
  trace: 10,
  debug: 20,
  info: 30,
  warn: 40,
  error: 50,
  fatal: 60,
};

export const LogRecord = z.object({
  /** Monotonic per process; newer records have larger ids. */
  id: z.number().int(),
  /** ISO-8601. */
  time: z.string(),
  level: LogLevel,
  message: z.string(),
  /** `component` / `module` binding of the child logger, when present. */
  component: z.string().optional(),
  /** Remaining structured fields (err, request ids, ...). */
  context: z.record(z.string(), z.unknown()).optional(),
});
export type LogRecord = z.infer<typeof LogRecord>;

/** GET /log. `level` is a minimum: `warn` returns warn, error and fatal. Newest first. */
export const LogQuery = z.object({
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(1000).default(50),
  level: LogLevel.optional(),
  /**
   * Text search (list-search.ts) over message, component, level and context: every word must
   * match. `q` is an alias; when both are given, the words of both must match.
   */
  search: ListSearchParam,
  q: ListSearchParam,
});
export type LogQuery = z.infer<typeof LogQuery>;
export type LogQueryInput = z.input<typeof LogQuery>;

export const LogPage = z.object({
  page: z.number().int(),
  pageSize: z.number().int(),
  totalRecords: z.number().int(),
  records: z.array(LogRecord),
});
export type LogPage = z.infer<typeof LogPage>;

export const LogFile = z.object({
  name: z.string(),
  sizeBytes: z.number().int(),
  /** ISO-8601. */
  lastModified: z.string(),
});
export type LogFile = z.infer<typeof LogFile>;

export const LogsErrorResponse = z.object({ error: z.string(), code: z.string().optional() });
export type LogsErrorResponse = z.infer<typeof LogsErrorResponse>;
