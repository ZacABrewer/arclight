import Database from 'better-sqlite3';
import { existsSync } from 'node:fs';
import { MigrateError } from './errors.js';

// Read-only access to another application's SQLite database. Schemas drift across upstream
// versions (columns are added, renamed or dropped), so every read is `SELECT *` and rows come
// back with lower-cased keys: a reader asks for `row.tmdbid` and gets `undefined` when that
// version has no such column instead of a SQL error. Nothing here ever writes.

export type ForeignRow = Record<string, unknown>;

export class ForeignDb {
  private readonly tables: Map<string, string>;

  private constructor(private readonly sqlite: Database.Database) {
    const rows = sqlite.prepare("SELECT name FROM sqlite_master WHERE type IN ('table', 'view')").all() as Array<{ name: string }>;
    this.tables = new Map(rows.map((r) => [r.name.toLowerCase(), r.name]));
  }

  static open(path: string): ForeignDb {
    if (!existsSync(path)) throw new MigrateError('SOURCE_NOT_FOUND', `database not found: ${path}`);
    let sqlite: Database.Database | undefined;
    try {
      sqlite = new Database(path, { readonly: true, fileMustExist: true });
      // Fails fast when the file is not a SQLite database.
      sqlite.prepare('SELECT count(*) FROM sqlite_master').get();
    } catch (err) {
      sqlite?.close();
      throw new MigrateError('SOURCE_UNREADABLE', `cannot open ${path} as SQLite: ${err instanceof Error ? err.message : String(err)}`);
    }
    return new ForeignDb(sqlite);
  }

  /** The table's real name (case-insensitive match), or null. */
  table(...candidates: string[]): string | null {
    for (const c of candidates) {
      const hit = this.tables.get(c.toLowerCase());
      if (hit) return hit;
    }
    return null;
  }

  hasTable(...candidates: string[]): boolean {
    return this.table(...candidates) !== null;
  }

  columns(table: string): Set<string> {
    const real = this.table(table);
    if (!real) return new Set();
    const rows = this.sqlite.prepare(`PRAGMA table_info("${real.replace(/"/g, '""')}")`).all() as Array<{ name: string }>;
    return new Set(rows.map((r) => r.name.toLowerCase()));
  }

  /** Every row of the first existing candidate table, keys lower-cased. Missing table: []. */
  rows(...candidates: string[]): ForeignRow[] {
    const real = this.table(...candidates);
    if (!real) return [];
    const raw = this.sqlite.prepare(`SELECT * FROM "${real.replace(/"/g, '""')}"`).all() as ForeignRow[];
    return raw.map(lowerKeys);
  }

  /** A single scalar from an arbitrary read-only query; null on any error. */
  scalar(sql: string): unknown {
    try {
      const row = this.sqlite.prepare(sql).raw(true).get() as unknown[] | undefined;
      return row?.[0] ?? null;
    } catch {
      return null;
    }
  }

  close(): void {
    this.sqlite.close();
  }
}

function lowerKeys(row: ForeignRow): ForeignRow {
  const out: ForeignRow = {};
  for (const [k, v] of Object.entries(row)) out[k.toLowerCase()] = v;
  return out;
}

// ---- value coercion ----------------------------------------------------------------------

export function str(v: unknown): string | null {
  if (v === null || v === undefined) return null;
  if (typeof v === 'string') return v;
  if (typeof v === 'number' || typeof v === 'bigint' || typeof v === 'boolean') return String(v);
  return null;
}

export function num(v: unknown): number | null {
  if (v === null || v === undefined || v === '') return null;
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  if (typeof v === 'bigint') return Number(v);
  if (typeof v === 'boolean') return v ? 1 : 0;
  if (typeof v === 'string') {
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

export function int(v: unknown): number | null {
  const n = num(v);
  return n === null ? null : Math.trunc(n);
}

export function bool(v: unknown, fallback = false): boolean {
  if (v === null || v === undefined) return fallback;
  if (typeof v === 'boolean') return v;
  if (typeof v === 'number' || typeof v === 'bigint') return Number(v) !== 0;
  if (typeof v === 'string') {
    const s = v.trim().toLowerCase();
    if (['true', '1', 'yes', 'on'].includes(s)) return true;
    if (['false', '0', 'no', 'off', ''].includes(s)) return false;
  }
  return fallback;
}

/** Parse a JSON text column; anything unparsable becomes `fallback`. */
export function json<T>(v: unknown, fallback: T): T {
  if (v === null || v === undefined) return fallback;
  if (typeof v !== 'string') return v as T;
  if (v.trim() === '') return fallback;
  try {
    return JSON.parse(v) as T;
  } catch {
    return fallback;
  }
}

/** A JSON object column as a record (non-objects become `{}`), keys lower-cased one level. */
export function jsonObject(v: unknown): Record<string, unknown> {
  const parsed = json<unknown>(v, {});
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
  return Object.fromEntries(Object.entries(parsed as Record<string, unknown>).map(([k, val]) => [k.toLowerCase(), val]));
}

export function jsonArray(v: unknown): unknown[] {
  const parsed = json<unknown>(v, []);
  return Array.isArray(parsed) ? parsed : [];
}

/** Integer ids from a JSON array column (tags, episode ids). */
export function idList(v: unknown): number[] {
  return jsonArray(v)
    .map((x) => int(x))
    .filter((x): x is number => x !== null);
}

/** Upstream timestamps are `YYYY-MM-DD HH:MM:SSZ`-ish; return ISO-8601 or null. */
export function isoDate(v: unknown): string | null {
  const s = str(v);
  if (!s) return null;
  let normalised = /^\d{4}-\d{2}-\d{2} \d/.test(s) ? s.replace(' ', 'T') : s;
  // Timestamps without an offset are stored in UTC upstream.
  if (/T\d/.test(normalised) && !/([zZ]|[+-]\d{2}:?\d{2})$/.test(normalised)) normalised += 'Z';
  const ms = Date.parse(normalised);
  return Number.isNaN(ms) ? null : new Date(ms).toISOString();
}

/** `YYYY-MM-DD` part of a date column, or null. */
export function dayOnly(v: unknown): string | null {
  const s = str(v);
  const m = s ? /^(\d{4}-\d{2}-\d{2})/.exec(s) : null;
  return m?.[1] ?? null;
}

/** Case-insensitive property read from a settings object. */
export function field(obj: Record<string, unknown>, ...names: string[]): unknown {
  for (const n of names) {
    const lower = n.toLowerCase();
    for (const [k, v] of Object.entries(obj)) if (k.toLowerCase() === lower) return v;
  }
  return undefined;
}
