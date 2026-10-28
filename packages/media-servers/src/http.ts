/** fetch with a timeout and non-2xx to MediaServerError mapping. Never echoes query strings (tokens). */

import { MediaServerError, type FetchLike, type MediaServerErrorCode, type MediaServerKind, type ProviderIds } from './types.js';

export const DEFAULT_TIMEOUT_MS = 30_000;

export interface RequestOptions {
  method?: 'GET' | 'POST';
  headers?: Record<string, string>;
  query?: Record<string, string>;
  body?: unknown;
  timeoutMs?: number;
}

export function joinUrl(base: string, path: string): string {
  return `${base.replace(/\/+$/, '')}/${path.replace(/^\/+/, '')}`;
}

export function normaliseBaseUrl(url: string): string {
  const trimmed = url.trim().replace(/\/+$/, '');
  return /^https?:\/\//i.test(trimmed) ? trimmed : `http://${trimmed}`;
}

export function codeForStatus(status: number): MediaServerErrorCode {
  if (status === 401 || status === 403) return 'unauthorized';
  if (status === 404) return 'notFound';
  if (status === 429) return 'rateLimited';
  return 'remoteError';
}

function describeUrl(url: string): string {
  try {
    const u = new URL(url);
    return `${u.origin}${u.pathname}`;
  } catch {
    return url;
  }
}

export async function request(fetchImpl: FetchLike, server: MediaServerKind, url: string, options: RequestOptions = {}): Promise<Response> {
  let target: URL;
  try {
    target = new URL(url);
  } catch (err) {
    throw new MediaServerError(server, 'invalidSettings', `Invalid server URL "${url}"`, { cause: err });
  }
  for (const [k, v] of Object.entries(options.query ?? {})) target.searchParams.set(k, v);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), options.timeoutMs ?? DEFAULT_TIMEOUT_MS);
  const label = describeUrl(url);
  const headers: Record<string, string> = { 'User-Agent': 'Arclight', Accept: 'application/json', ...options.headers };
  const init: RequestInit = { method: options.method ?? 'GET', headers, signal: controller.signal };
  if (options.body !== undefined) {
    headers['Content-Type'] = 'application/json';
    init.body = JSON.stringify(options.body);
  }
  let res: Response;
  try {
    res = await fetchImpl(target.toString(), init);
  } catch (err) {
    if (controller.signal.aborted) throw new MediaServerError(server, 'timeout', `Request to ${label} timed out`, { cause: err });
    const detail = err instanceof Error ? err.message : String(err);
    throw new MediaServerError(server, 'network', `Could not reach ${label}: ${detail}`, { cause: err });
  } finally {
    clearTimeout(timer);
  }
  if (res.ok) return res;
  let snippet = '';
  try {
    snippet = (await res.text()).replace(/\s+/g, ' ').trim().slice(0, 200);
  } catch {
    // body unreadable; the status is enough
  }
  throw new MediaServerError(server, codeForStatus(res.status), `${label} responded ${res.status}${snippet ? `: ${snippet}` : ''}`, {
    status: res.status,
  });
}

export async function requestJson(fetchImpl: FetchLike, server: MediaServerKind, url: string, options: RequestOptions = {}): Promise<unknown> {
  const res = await request(fetchImpl, server, url, options);
  const text = await res.text();
  if (text.trim() === '') return {};
  try {
    return JSON.parse(text) as unknown;
  } catch (err) {
    throw new MediaServerError(server, 'remoteError', `${describeUrl(url)} did not return JSON`, { cause: err });
  }
}

// ---- loose JSON readers ---------------------------------------------------------------

export function rec(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

export function list(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

export function str(value: unknown): string | null {
  if (typeof value === 'string' && value.length > 0) return value;
  if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  return null;
}

export function num(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && /^-?\d+(\.\d+)?$/.test(value)) return Number(value);
  return null;
}

/** ISO string from an ISO-ish string, or null for absent, invalid or pre-1971 placeholder values. */
export function isoDate(value: unknown): string | null {
  if (typeof value !== 'string' || value === '') return null;
  const t = Date.parse(value);
  if (!Number.isFinite(t) || t < 31_536_000_000) return null;
  return new Date(t).toISOString();
}

/** ISO string from Unix seconds. */
export function isoFromSeconds(value: unknown): string | null {
  const n = num(value);
  return n !== null && n > 0 ? new Date(n * 1000).toISOString() : null;
}

/** Later of two ISO timestamps (either may be null). */
export function laterOf(a: string | null, b: string | null): string | null {
  if (!a) return b;
  if (!b) return a;
  return a >= b ? a : b;
}

export function emptyIds(): ProviderIds {
  return { tmdbId: null, tvdbId: null, imdbId: null };
}

const sameText = (a: string | null | undefined, b: string | null | undefined): boolean =>
  Boolean(a && b && a.trim().toLowerCase() === b.trim().toLowerCase());

/** ISBN without hyphens/spaces, upper-case X. */
export function normaliseIsbn(value: string): string {
  return value.replace(/[\s-]/g, '').toUpperCase();
}

/** True when any id in the query matches the item's ids. */
export function idsMatchQuery(
  ids: ProviderIds,
  q: Partial<Pick<ProviderIds, 'tmdbId' | 'tvdbId' | 'imdbId' | 'mbReleaseGroupId' | 'mbArtistId' | 'asin' | 'isbn'>>,
): boolean {
  if (q.tmdbId && ids.tmdbId === q.tmdbId) return true;
  if (q.tvdbId && ids.tvdbId === q.tvdbId) return true;
  if (q.imdbId && ids.imdbId !== null && ids.imdbId.toLowerCase() === q.imdbId.toLowerCase()) return true;
  if (sameText(q.mbReleaseGroupId, ids.mbReleaseGroupId)) return true;
  if (sameText(q.mbArtistId, ids.mbArtistId)) return true;
  if (sameText(q.asin, ids.asin)) return true;
  if (q.isbn && ids.isbn && normaliseIsbn(q.isbn) === normaliseIsbn(ids.isbn)) return true;
  return false;
}

/** True when the query names at least one id. */
export function queryHasIds(q: FindItemsQueryIds): boolean {
  return Boolean(q.tmdbId || q.tvdbId || q.imdbId || q.mbReleaseGroupId || q.mbArtistId || q.asin || q.isbn);
}

type FindItemsQueryIds = Partial<Pick<ProviderIds, 'tmdbId' | 'tvdbId' | 'imdbId' | 'mbReleaseGroupId' | 'mbArtistId' | 'asin' | 'isbn'>>;
