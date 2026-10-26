import { closeSync, existsSync, fstatSync, openSync, readdirSync, renameSync, statSync, unlinkSync, writeSync } from 'node:fs';
import { join } from 'node:path';
import pino, { type DestinationStream, type Logger } from 'pino';
import { LOG_LEVEL_VALUES, type LogFile, type LogLevel, type LogPage, type LogQuery, type LogRecord } from '@arclight/shared';
import type { AppConfig } from './config.js';

// Logger construction. Every record goes to three places through a pino multistream:
// stdout (pretty in dev), an in-memory ring buffer (GET /log, /log/stream) and a size-rotated
// file in the config's log folder. The buffer and file writer are kept on a module-level
// registry so the logs module can read them without app.ts passing them around.

export const LOG_FILE_NAME = 'arclight.log';
export const DEFAULT_BUFFER_SIZE = 5_000;
export const DEFAULT_MAX_FILE_BYTES = 10 * 1024 * 1024;
export const DEFAULT_KEEP_FILES = 5;

const LEVELS = Object.entries(LOG_LEVEL_VALUES) as [LogLevel, number][];
const LEVEL_BY_VALUE = new Map<number, LogLevel>(LEVELS.map(([name, value]) => [value, name]));
/** pino fields that become first-class LogRecord fields or are noise in the UI. */
const RESERVED = new Set(['level', 'time', 'msg', 'pid', 'hostname', 'v', 'component', 'module']);

function levelName(value: unknown): LogLevel {
  if (typeof value === 'string' && value in LOG_LEVEL_VALUES) return value as LogLevel;
  if (typeof value === 'number') {
    const exact = LEVEL_BY_VALUE.get(value);
    if (exact) return exact;
    // Custom numeric levels: round down to the nearest known one.
    let best: LogLevel = 'trace';
    for (const [name, v] of LEVELS) if (v <= value) best = name;
    return best;
  }
  return 'info';
}

type Listener = (record: LogRecord) => void;

/** Fixed-capacity ring of the most recent log records. Also a pino destination (`write`). */
export class LogBuffer implements DestinationStream {
  private readonly slots: (LogRecord | undefined)[];
  private head = 0; // index of the next write
  private count = 0;
  private nextId = 1;
  private readonly listeners = new Set<Listener>();

  constructor(readonly capacity: number = DEFAULT_BUFFER_SIZE) {
    if (!Number.isInteger(capacity) || capacity < 1) throw new RangeError('capacity must be a positive integer');
    this.slots = new Array<LogRecord | undefined>(capacity);
  }

  get size(): number {
    return this.count;
  }

  /** pino calls this with one or more newline-terminated JSON lines. */
  write(chunk: string): void {
    for (const line of chunk.split('\n')) {
      if (line.trim() === '') continue;
      let obj: unknown;
      try {
        obj = JSON.parse(line);
      } catch {
        obj = { msg: line };
      }
      if (obj && typeof obj === 'object') this.add(obj as Record<string, unknown>);
    }
  }

  /** Normalise a pino object into a LogRecord, store it and notify subscribers. */
  add(raw: Record<string, unknown>): LogRecord {
    const context: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(raw)) if (!RESERVED.has(k)) context[k] = v;
    const rawTime = raw['time'];
    const time = typeof rawTime === 'number' || typeof rawTime === 'string' ? new Date(rawTime) : new Date();
    const component = raw['component'] ?? raw['module'];
    const msg = raw['msg'];
    const record: LogRecord = {
      id: this.nextId++,
      time: Number.isNaN(time.getTime()) ? new Date().toISOString() : time.toISOString(),
      level: levelName(raw['level']),
      message: typeof msg === 'string' ? msg : msg === undefined ? '' : String(msg),
      ...(typeof component === 'string' ? { component } : {}),
      ...(Object.keys(context).length > 0 ? { context } : {}),
    };
    this.slots[this.head] = record;
    this.head = (this.head + 1) % this.capacity;
    this.count = Math.min(this.count + 1, this.capacity);
    for (const l of this.listeners) {
      try {
        l(record);
      } catch {
        // A broken subscriber must never break logging.
      }
    }
    return record;
  }

  /** All records, newest first. */
  newestFirst(): LogRecord[] {
    const out: LogRecord[] = [];
    for (let i = 1; i <= this.count; i++) {
      const r = this.slots[(this.head - i + this.capacity) % this.capacity];
      if (r) out.push(r);
    }
    return out;
  }

  query(q: Partial<LogQuery> = {}): LogPage {
    const page = q.page ?? 1;
    const pageSize = q.pageSize ?? 50;
    const matching = this.newestFirst().filter(recordFilter(q));
    const start = (page - 1) * pageSize;
    return { page, pageSize, totalRecords: matching.length, records: matching.slice(start, start + pageSize) };
  }

  clear(): void {
    this.slots.fill(undefined);
    this.head = 0;
    this.count = 0;
  }

  subscribe(listener: Listener): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }
}

/** Predicate for a level minimum + case-insensitive text search over message, component and context. */
export function recordFilter(q: Pick<Partial<LogQuery>, 'level' | 'search'>): (r: LogRecord) => boolean {
  const min = q.level ? LOG_LEVEL_VALUES[q.level] : 0;
  const needle = q.search?.trim().toLowerCase() ?? '';
  return (r) => {
    if (LOG_LEVEL_VALUES[r.level] < min) return false;
    if (!needle) return true;
    if (r.message.toLowerCase().includes(needle)) return true;
    if (r.component?.toLowerCase().includes(needle)) return true;
    return r.context !== undefined && JSON.stringify(r.context).toLowerCase().includes(needle);
  };
}

export interface RotatingFileOptions {
  dir: string;
  fileName?: string;
  /** Rotate before a write would take the active file past this many bytes. */
  maxBytes?: number;
  /** Rotated files kept besides the active one (`.1` newest ... `.keep` oldest). */
  keep?: number;
}

/**
 * Append-only log file with size-based rotation: `arclight.log` is active; on rotation it
 * becomes `arclight.log.1`, `.1` becomes `.2` and so on, and the file past `keep` is deleted.
 * Writes are synchronous so a crash never loses the line that explains it.
 */
export class RotatingFileStream implements DestinationStream {
  readonly dir: string;
  readonly fileName: string;
  readonly maxBytes: number;
  readonly keep: number;
  private fd: number | null = null;
  private bytes = 0;

  constructor(opts: RotatingFileOptions) {
    this.dir = opts.dir;
    this.fileName = opts.fileName ?? LOG_FILE_NAME;
    this.maxBytes = opts.maxBytes ?? DEFAULT_MAX_FILE_BYTES;
    this.keep = Math.max(0, opts.keep ?? DEFAULT_KEEP_FILES);
    this.open();
  }

  get path(): string {
    return join(this.dir, this.fileName);
  }

  /** Bytes in the active file. */
  get size(): number {
    return this.bytes;
  }

  write(chunk: string): void {
    const data = Buffer.from(chunk, 'utf8');
    if (this.bytes > 0 && this.bytes + data.length > this.maxBytes) this.rotate();
    const fd = this.fd ?? this.open();
    writeSync(fd, data);
    this.bytes += data.length;
  }

  rotate(): void {
    this.closeFd();
    const base = this.path;
    if (this.keep === 0) {
      if (existsSync(base)) unlinkSync(base);
    } else {
      const oldest = `${base}.${this.keep}`;
      if (existsSync(oldest)) unlinkSync(oldest);
      for (let i = this.keep - 1; i >= 1; i--) {
        const from = `${base}.${i}`;
        if (existsSync(from)) renameSync(from, `${base}.${i + 1}`);
      }
      if (existsSync(base)) renameSync(base, `${base}.1`);
    }
    this.open();
  }

  /** Active file first, then rotated files newest to oldest. */
  list(): LogFile[] {
    return listLogFiles(this.dir, this.fileName);
  }

  close(): void {
    this.closeFd();
  }

  private open(): number {
    const fd = openSync(this.path, 'a');
    this.fd = fd;
    this.bytes = fstatSync(fd).size;
    return fd;
  }

  private closeFd(): void {
    if (this.fd !== null) {
      closeSync(this.fd);
      this.fd = null;
    }
  }
}

/** True for `arclight.log` and its numbered rotations; the only names /log/file serves. */
export function isLogFileName(name: string, fileName: string = LOG_FILE_NAME): boolean {
  if (name === fileName) return true;
  if (!name.startsWith(`${fileName}.`)) return false;
  return /^\d+$/.test(name.slice(fileName.length + 1));
}

export function listLogFiles(dir: string, fileName: string = LOG_FILE_NAME): LogFile[] {
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return [];
  }
  const rank = (n: string) => (n === fileName ? 0 : Number(n.slice(fileName.length + 1)));
  return names
    .filter((n) => isLogFileName(n, fileName))
    .sort((a, b) => rank(a) - rank(b))
    .flatMap((name) => {
      try {
        const s = statSync(join(dir, name));
        return s.isFile() ? [{ name, sizeBytes: s.size, lastModified: s.mtime.toISOString() }] : [];
      } catch {
        return [];
      }
    });
}

// ---- registry --------------------------------------------------------------------------

export interface LogRegistry {
  buffer: LogBuffer;
  logDir: string;
  fileName: string;
  files: RotatingFileStream | null;
}

let registry: LogRegistry | null = null;

export function getLogRegistry(): LogRegistry | null {
  return registry;
}

export function setLogRegistry(next: LogRegistry | null): void {
  registry = next;
}

// ---- construction ----------------------------------------------------------------------

export interface CreateLoggerOptions {
  /** Pretty stdout through pino-pretty (dev). Default: NODE_ENV !== 'production'. */
  pretty?: boolean;
  /** Replace stdout (tests); null drops stdout. */
  stdout?: DestinationStream | null;
  bufferSize?: number;
  maxFileBytes?: number;
  keepFiles?: number;
  /** Store the buffer/file writer on the module registry. Default true. */
  register?: boolean;
}

export interface CreatedLogger {
  log: Logger;
  buffer: LogBuffer;
  files: RotatingFileStream;
}

export function createLogger(config: Pick<AppConfig, 'logDir' | 'logLevel'>, opts: CreateLoggerOptions = {}): CreatedLogger {
  const buffer = new LogBuffer(opts.bufferSize ?? DEFAULT_BUFFER_SIZE);
  const files = new RotatingFileStream({
    dir: config.logDir,
    fileName: LOG_FILE_NAME,
    maxBytes: opts.maxFileBytes ?? DEFAULT_MAX_FILE_BYTES,
    keep: opts.keepFiles ?? DEFAULT_KEEP_FILES,
  });

  let stdout: DestinationStream | null;
  if (opts.stdout !== undefined) stdout = opts.stdout;
  else if (opts.pretty ?? process.env['NODE_ENV'] !== 'production') {
    // pino-pretty runs in a worker thread; the returned ThreadStream is a plain destination.
    stdout = pino.transport({ target: 'pino-pretty', options: { colorize: true, translateTime: 'HH:MM:ss' } });
  } else stdout = pino.destination(1);

  // Streams accept everything; the logger's own level does the filtering.
  const streams: pino.StreamEntry[] = [
    { level: 'trace', stream: buffer },
    { level: 'trace', stream: files },
  ];
  if (stdout) streams.push({ level: 'trace', stream: stdout });

  const log = pino({ level: config.logLevel }, pino.multistream(streams));
  if (opts.register ?? true) setLogRegistry({ buffer, logDir: config.logDir, fileName: LOG_FILE_NAME, files });
  return { log, buffer, files };
}
