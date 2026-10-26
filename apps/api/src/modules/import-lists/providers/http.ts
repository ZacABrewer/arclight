import { ImportListFetchError } from '../errors.js';
import type { ProviderContext } from './types.js';

const TIMEOUT_MS = 20_000;

/** GET/POST with uniform error mapping. `what` names the service in messages. */
export async function request(
  ctx: Pick<ProviderContext, 'fetch' | 'signal'>,
  what: string,
  url: string,
  init: RequestInit = {},
): Promise<Response> {
  const signal = ctx.signal ? AbortSignal.any([ctx.signal, AbortSignal.timeout(TIMEOUT_MS)]) : AbortSignal.timeout(TIMEOUT_MS);
  let res: Response;
  try {
    res = await ctx.fetch(url, { ...init, signal });
  } catch (cause) {
    throw new ImportListFetchError('unreachable', `${what} is unreachable`, { cause });
  }
  if (res.status === 401 || res.status === 403) {
    throw new ImportListFetchError('auth', `${what} rejected the credentials (HTTP ${res.status})`);
  }
  if (res.status === 404) throw new ImportListFetchError('not-found', `${what} has no such list (HTTP 404)`);
  if (res.status === 429) throw new ImportListFetchError('rate-limited', `${what} rate limit exceeded`);
  if (!res.ok) throw new ImportListFetchError('bad-response', `${what} answered HTTP ${res.status}`);
  return res;
}

export async function getJson(
  ctx: Pick<ProviderContext, 'fetch' | 'signal'>,
  what: string,
  url: string,
  init: RequestInit = {},
): Promise<unknown> {
  const res = await request(ctx, what, url, { ...init, headers: { Accept: 'application/json', ...headersOf(init) } });
  try {
    return await res.json();
  } catch (cause) {
    throw new ImportListFetchError('bad-response', `${what} returned non-JSON content`, { cause });
  }
}

export async function getText(
  ctx: Pick<ProviderContext, 'fetch' | 'signal'>,
  what: string,
  url: string,
  init: RequestInit = {},
): Promise<string> {
  return (await request(ctx, what, url, init)).text();
}

function headersOf(init: RequestInit): Record<string, string> {
  const h = init.headers;
  if (!h) return {};
  if (h instanceof Headers) return Object.fromEntries(h.entries());
  if (Array.isArray(h)) return Object.fromEntries(h);
  return h as Record<string, string>;
}

// Small readers for untyped JSON; providers parse defensively rather than with full schemas
// because these services add and drop fields freely.
export function asRecord(v: unknown): Record<string, unknown> | null {
  return v !== null && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
}

export function asArray(v: unknown): unknown[] {
  return Array.isArray(v) ? v : [];
}

export function str(v: unknown): string | null {
  return typeof v === 'string' && v.trim() !== '' ? v.trim() : null;
}

export function int(v: unknown): number | null {
  if (typeof v === 'number' && Number.isInteger(v)) return v;
  if (typeof v === 'string' && /^\d+$/.test(v.trim())) return Number.parseInt(v.trim(), 10);
  return null;
}

export function imdbIdOf(v: unknown): string | null {
  const s = str(v);
  return s && /^tt\d{5,}$/.test(s) ? s : null;
}
