// Test helpers for the book catalogue: an in-memory BookCatalogCache with expiry, a fake fetch
// that routes by host, and record builders. Lives in src so it is typechecked, but is not
// exported from index.ts.

import type { FetchLike } from '../tmdb/client.js';
import type { BookCatalogCache, BookCatalogConfig, BookRecord } from './types.js';

export const BOOK_TEST_USER_AGENT = 'ArclightTest/1.0 ( https://example.com )';

export interface MemoryBookCache extends BookCatalogCache {
  entries: Map<string, { body: unknown; expiresAt: number }>;
  /** Writes an entry with an explicit expiry (negative ttl = already expired). */
  put(provider: string, key: string, body: unknown, ttlMs: number): void;
}

export function createMemoryBookCache(now: () => number): MemoryBookCache {
  const entries = new Map<string, { body: unknown; expiresAt: number }>();
  const id = (provider: string, key: string) => `${provider}\u0000${key}`;
  const put = (provider: string, key: string, body: unknown, ttlMs: number) => {
    entries.set(id(provider, key), { body: structuredClone(body), expiresAt: now() + ttlMs });
  };
  return {
    entries,
    put,
    get<T>(provider: string, key: string, opts?: { allowStale?: boolean }) {
      const entry = entries.get(id(provider, key));
      if (!entry) return undefined;
      if (entry.expiresAt <= now() && !opts?.allowStale) return undefined;
      return { body: structuredClone(entry.body) as T, expiresAt: new Date(entry.expiresAt).toISOString() };
    },
    set: put,
  };
}

export type HostRoute = (url: URL, init: RequestInit | undefined) => Response | Promise<Response>;

export interface HostFakeFetch {
  fetch: FetchLike;
  calls: { url: URL; init: RequestInit | undefined }[];
  hosts(): string[];
}

/** Fetch that hands each request to the route for its host; unknown hosts answer 404. */
export function createHostFetch(routes: Record<string, HostRoute>): HostFakeFetch {
  const calls: HostFakeFetch['calls'] = [];
  const fetch: FetchLike = async (input, init) => {
    const url = new URL(input);
    calls.push({ url, init });
    const route = routes[url.host];
    return route ? route(url, init) : new Response('{}', { status: 404 });
  };
  return { fetch, calls, hosts: () => calls.map((c) => c.url.host) };
}

export function bookConfig(overrides: Partial<BookCatalogConfig> = {}): BookCatalogConfig {
  return {
    openLibrary: true,
    googleBooks: true,
    hardcover: true,
    hardcoverApiKey: 'test-token',
    comicVine: true,
    comicVineApiKey: 'test-cv-key',
    metron: true,
    metronUsername: 'tester',
    metronPassword: 'secret',
    languages: [],
    ...overrides,
  };
}

/** A minimal BookRecord for merge tests. */
export function bookRecord(overrides: Partial<BookRecord> & Pick<BookRecord, 'title' | 'sources'>): BookRecord {
  return {
    key: 'gb:x',
    keys: [],
    authors: [],
    isbns: [],
    genres: [],
    series: [],
    ...overrides,
  };
}
