// Shared JSON-over-HTTP transport for the keyless/rate-limited providers (MusicBrainz,
// Wikidata, Fanart.tv): rate limiter, timeout, abort, in-memory TTL cache, in-flight
// de-duplication, Zod validation and HTTP → MetadataError mapping. TMDB keeps its own
// transport in ./tmdb/client.ts.

import type { z } from 'zod';
import type { FetchLike } from './tmdb/client.js';
import { MetadataError } from './types.js';
import { isThrottleStatus, type RateLimiter, type RequestPriority } from './rate-limit.js';

export interface RequestOptions {
  /** Interactive requests (UI lookups) jump ahead of background ones (refresh jobs). */
  priority?: RequestPriority;
  signal?: AbortSignal;
}

export interface JsonTransportOptions {
  /** Human-readable provider name for error messages. */
  label: string;
  /** Rate limiter bucket. */
  providerKey: string;
  limiter: RateLimiter;
  fetchImpl: FetchLike;
  headers: Record<string, string>;
  timeoutMs: number;
  maxRetries: number;
  now: () => Date;
  defaultPriority: RequestPriority;
  maxCacheEntries?: number;
}

export interface GetOptions extends RequestOptions {
  ttlMs: number;
}

export interface JsonTransport {
  /** GET `url` and validate it. Throws `MetadataError` (`not-found` on 404). */
  get<S extends z.ZodType>(url: string, schema: S, options: GetOptions): Promise<z.infer<S>>;
  /** Like `get` but resolves `undefined` on 404. */
  getOptional<S extends z.ZodType>(
    url: string,
    schema: S,
    options: GetOptions,
  ): Promise<z.infer<S> | undefined>;
  clearCache(): void;
}

interface CacheEntry {
  expiresAt: number;
  value: unknown;
}

const DEFAULT_MAX_CACHE_ENTRIES = 2_000;
const NOT_FOUND = Symbol('not-found');

async function errorDetail(response: Response): Promise<string> {
  try {
    const text = await response.text();
    const body = JSON.parse(text) as { error?: unknown; message?: unknown };
    const detail = typeof body.error === 'string' ? body.error : body.message;
    return typeof detail === 'string' && detail.length > 0 ? `: ${detail}` : '';
  } catch {
    return '';
  }
}

export function createJsonTransport(options: JsonTransportOptions): JsonTransport {
  const { label, providerKey, limiter, fetchImpl, headers, timeoutMs, maxRetries, now } = options;
  const { defaultPriority } = options;
  const maxEntries = options.maxCacheEntries ?? DEFAULT_MAX_CACHE_ENTRIES;
  const cache = new Map<string, CacheEntry>();
  const inflight = new Map<string, Promise<unknown>>();

  function cacheGet(key: string): unknown {
    const entry = cache.get(key);
    if (!entry) return undefined;
    if (entry.expiresAt <= now().getTime()) {
      cache.delete(key);
      return undefined;
    }
    return entry.value;
  }

  function cacheSet(key: string, value: unknown, ttlMs: number): void {
    if (cache.size >= maxEntries && !cache.has(key)) {
      const oldest = cache.keys().next().value;
      if (oldest !== undefined) cache.delete(oldest);
    }
    cache.set(key, { expiresAt: now().getTime() + ttlMs, value });
  }

  async function fetchOnce(url: string, signal: AbortSignal | undefined): Promise<Response> {
    const timeout = AbortSignal.timeout(timeoutMs);
    const combined = signal ? AbortSignal.any([signal, timeout]) : timeout;
    try {
      return await fetchImpl(url, { headers, signal: combined });
    } catch (cause) {
      if (signal?.aborted) throw cause;
      const timedOut = cause instanceof Error && cause.name === 'TimeoutError';
      throw new MetadataError(
        'unreachable',
        timedOut ? `${label} request timed out after ${timeoutMs}ms` : `${label} is unreachable`,
        { cause },
      );
    }
  }

  async function fetchValidated(
    url: string,
    schema: z.ZodType,
    options: GetOptions,
  ): Promise<unknown> {
    const { signal } = options;
    const priority = options.priority ?? defaultPriority;
    const scheduleOptions = signal ? { priority, signal, maxRetries } : { priority, maxRetries };
    const response = await limiter.schedule(
      providerKey,
      () => fetchOnce(url, signal),
      scheduleOptions,
    );
    const path = new URL(url).pathname;

    if (response.status === 404) {
      await response.body?.cancel().catch(() => {});
      return NOT_FOUND;
    }
    if (isThrottleStatus(response.status)) {
      throw new MetadataError(
        'rate-limited',
        `${label} is throttling requests (HTTP ${response.status})${await errorDetail(response)}`,
        { httpStatus: response.status },
      );
    }
    if (response.status === 401 || response.status === 403) {
      throw new MetadataError('unauthorized', `${label} rejected the request`, {
        httpStatus: response.status,
      });
    }
    if (!response.ok) {
      throw new MetadataError(
        'bad-response',
        `${label} answered HTTP ${response.status} for ${path}${await errorDetail(response)}`,
        { httpStatus: response.status },
      );
    }

    let body: unknown;
    try {
      body = await response.json();
    } catch (cause) {
      throw new MetadataError('bad-response', `${label} returned non-JSON content`, {
        httpStatus: response.status,
        cause,
      });
    }
    const parsed = schema.safeParse(body);
    if (!parsed.success) {
      throw new MetadataError('bad-response', `${label} payload for ${path} has unexpected shape`, {
        httpStatus: response.status,
        cause: parsed.error,
      });
    }
    if (options.ttlMs > 0) cacheSet(url, parsed.data, options.ttlMs);
    return parsed.data;
  }

  function load(url: string, schema: z.ZodType, options: GetOptions): Promise<unknown> {
    const cached = cacheGet(url);
    if (cached !== undefined) return Promise.resolve(cached);
    // A caller with its own abort signal gets its own request so aborting it cannot fail
    // anyone else waiting on the same URL.
    if (options.signal) return fetchValidated(url, schema, options);
    const pending = inflight.get(url);
    if (pending) return pending;
    const promise = fetchValidated(url, schema, options).finally(() => inflight.delete(url));
    inflight.set(url, promise);
    return promise;
  }

  return {
    async get(url, schema, options) {
      const value = await load(url, schema, options);
      if (value === NOT_FOUND) {
        throw new MetadataError('not-found', `${label} has no resource at ${new URL(url).pathname}`, {
          httpStatus: 404,
        });
      }
      return value as z.infer<typeof schema>;
    },
    async getOptional(url, schema, options) {
      const value = await load(url, schema, options);
      return value === NOT_FOUND ? undefined : (value as z.infer<typeof schema>);
    },
    clearCache() {
      cache.clear();
    },
  };
}
