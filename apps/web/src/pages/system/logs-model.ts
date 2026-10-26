import { LOG_LEVEL_VALUES, type LogLevel, type LogRecord } from '@arclight/shared';
import type { ChipTone } from '../../arclight/index.js';

// Log viewer helpers. The filter mirrors the api's (apps/api/src/logging.ts recordFilter) so
// records arriving over the live stream are filtered exactly like the paged ones.

export interface LogFilter {
  /** Minimum level; undefined = everything. */
  level?: LogLevel | undefined;
  search?: string | undefined;
}

/** Level chips: info = neutral, warn = warn, error/fatal = failed; trace/debug fade out. */
export const LEVEL_TONES: Record<LogLevel, ChipTone> = {
  trace: 'muted',
  debug: 'muted',
  info: 'neutral',
  warn: 'warn',
  error: 'danger',
  fatal: 'danger',
};

export const LEVEL_LABELS: Record<LogLevel, string> = {
  trace: 'Trace',
  debug: 'Debug',
  info: 'Info',
  warn: 'Warn',
  error: 'Error',
  fatal: 'Fatal',
};

export function matchesLogFilter(r: LogRecord, f: LogFilter): boolean {
  if (f.level && LOG_LEVEL_VALUES[r.level] < LOG_LEVEL_VALUES[f.level]) return false;
  const needle = f.search?.trim().toLowerCase() ?? '';
  if (!needle) return true;
  if (r.message.toLowerCase().includes(needle)) return true;
  if (r.component?.toLowerCase().includes(needle)) return true;
  return r.context !== undefined && JSON.stringify(r.context).toLowerCase().includes(needle);
}

/** Add streamed records (newest first), dropping duplicates by id and keeping at most `cap`. */
export function mergeLive(current: readonly LogRecord[], incoming: readonly LogRecord[], cap = 1000): LogRecord[] {
  const seen = new Set<number>();
  const out: LogRecord[] = [];
  for (const r of [...incoming].sort((a, b) => b.id - a.id).concat(current)) {
    if (seen.has(r.id)) continue;
    seen.add(r.id);
    out.push(r);
    if (out.length >= cap) break;
  }
  return out;
}

/**
 * The rows to show on page 1 while following: streamed records newer than the fetched page
 * (and matching the filter) on top, then the fetched page, cut to the page size.
 */
export function visibleRecords(fetched: readonly LogRecord[], live: readonly LogRecord[], filter: LogFilter, pageSize: number): LogRecord[] {
  const newest = fetched[0]?.id ?? 0;
  const fresh = live.filter((r) => r.id > newest && matchesLogFilter(r, filter));
  return mergeLive(fetched, fresh, pageSize);
}

/** Pretty-print the structured context of a record for the details row. */
export function formatContext(r: LogRecord): string {
  return r.context ? JSON.stringify(r.context, null, 2) : '';
}
