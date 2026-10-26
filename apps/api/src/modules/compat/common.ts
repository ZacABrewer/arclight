import { z } from 'zod';

// Small helpers shared by the compat mappers and routes. Upstream (Sonarr/Radarr) serialises
// with "ignore nulls", so optional fields are omitted rather than sent as null.

/** A JSON object as served by the compatibility API. */
export type Json = Record<string, unknown>;

/** Drops keys whose value is null or undefined (one level deep). */
export function compact<T extends Json>(obj: T): T {
  const out: Json = {};
  for (const [k, v] of Object.entries(obj)) if (v !== null && v !== undefined) out[k] = v;
  return out as T;
}

/** `The Office (US)` -> `the-office-us`. */
export function slugify(title: string): string {
  return title
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/&/g, ' and ')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

/** Milliseconds as a .NET TimeSpan string: `hh:mm:ss`, or `d.hh:mm:ss` past a day. */
export function timeSpan(ms: number | null | undefined): string | undefined {
  if (ms === null || ms === undefined || !Number.isFinite(ms) || ms < 0) return undefined;
  const total = Math.floor(ms / 1000);
  const days = Math.floor(total / 86400);
  const h = Math.floor((total % 86400) / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const pad = (n: number) => String(n).padStart(2, '0');
  const clock = `${pad(h)}:${pad(m)}:${pad(s)}`;
  return days > 0 ? `${days}.${clock}` : clock;
}

/** Upstream's "no date" placeholder, used where a non-null DateTime is required. */
export const MIN_DATE = '0001-01-01T00:00:00Z';

/** Last path segment, either separator. */
export function baseName(path: string): string {
  const parts = path.split(/[\/]+/).filter((p) => p !== '');
  return parts[parts.length - 1] ?? path;
}

// ---- query-string coercion ---------------------------------------------------------------

/** Accepts true/false/1/0 (any case) and real booleans; anything else is undefined. */
export const qsBool = z.preprocess((v) => {
  if (typeof v === 'boolean') return v;
  if (typeof v !== 'string') return undefined;
  const s = v.toLowerCase();
  if (s === 'true' || s === '1') return true;
  if (s === 'false' || s === '0') return false;
  return undefined;
}, z.boolean().optional());

/** `1,2,3`, repeated params or a single number. */
export const qsIntList = z.preprocess((value) => {
  if (value === undefined || value === null || value === '') return undefined;
  const parts = (Array.isArray(value) ? value : [value]).flatMap((v) => String(v).split(','));
  return parts.map((p) => p.trim()).filter((p) => p !== '').map(Number);
}, z.array(z.number().int()).optional());

export const qsInt = z.coerce.number().int().optional();

/** Sonarr-style validation failure (400 bodies are arrays of these). */
export interface ValidationFailure {
  propertyName: string;
  errorMessage: string;
  attemptedValue?: unknown;
  severity: 'error' | 'warning';
  isWarning: boolean;
}

export function validationFailure(propertyName: string, errorMessage: string, attemptedValue?: unknown): ValidationFailure {
  return {
    propertyName,
    errorMessage,
    ...(attemptedValue !== undefined ? { attemptedValue } : {}),
    severity: 'error',
    isWarning: false,
  };
}

/** Thrown by compat handlers; the compat error handler turns it into an upstream-shaped body. */
export class CompatError extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly failures?: ValidationFailure[],
  ) {
    super(message);
    this.name = 'CompatError';
  }

  static notFound(what = 'NotFound'): CompatError {
    return new CompatError(404, what);
  }

  static validation(propertyName: string, errorMessage: string, attemptedValue?: unknown): CompatError {
    return new CompatError(400, errorMessage, [validationFailure(propertyName, errorMessage, attemptedValue)]);
  }
}

/** Parse with zod, raising a Sonarr-shaped 400 on failure. */
export function parseOr400<T extends z.ZodTypeAny>(schema: T, value: unknown): z.output<T> {
  const parsed = schema.safeParse(value ?? {});
  if (parsed.success) return parsed.data as z.output<T>;
  const failures = parsed.error.issues.map((i) => validationFailure(i.path.join('.') || 'body', i.message));
  throw new CompatError(400, failures.map((f) => f.errorMessage).join('; '), failures);
}
