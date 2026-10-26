// A small TTL cache for TMDB-backed discover data. Discover pages are browsed by many people
// at once (the public portal especially), so identical lookups share one TMDB call while it is
// in flight and the result is kept for a while: list pages for minutes, title/person/collection
// details for hours, vocabularies (genres, providers, certifications) for a day. Only raw TMDB
// data is cached; library and request status is overlaid fresh on every response.

export const LIST_TTL_MS = 5 * 60 * 1000;
export const DETAIL_TTL_MS = 6 * 60 * 60 * 1000;
export const STATIC_TTL_MS = 24 * 60 * 60 * 1000;
const DEFAULT_MAX_ENTRIES = 1_000;

export interface DiscoverCacheOptions {
  maxEntries?: number;
  now?: () => number;
}

export class DiscoverCache {
  private readonly entries = new Map<string, { value: unknown; expiresAt: number }>();
  private readonly inflight = new Map<string, Promise<unknown>>();
  private readonly maxEntries: number;
  private readonly now: () => number;
  /** Bumped by clear() so a lookup that started before it does not store a stale value. */
  private generation = 0;

  constructor(opts: DiscoverCacheOptions = {}) {
    this.maxEntries = opts.maxEntries ?? DEFAULT_MAX_ENTRIES;
    this.now = opts.now ?? Date.now;
  }

  /** The cached value for `key`, else the result of `load` (shared by concurrent callers). Failures are not cached. */
  async get<T>(key: string, ttlMs: number, load: () => Promise<T>): Promise<T> {
    const hit = this.entries.get(key);
    if (hit) {
      if (hit.expiresAt > this.now()) {
        // Refresh recency so the cap evicts the least recently used entry.
        this.entries.delete(key);
        this.entries.set(key, hit);
        return hit.value as T;
      }
      this.entries.delete(key);
    }
    const pending = this.inflight.get(key);
    if (pending) return pending as Promise<T>;
    const generation = this.generation;
    const promise = load()
      .then((value) => {
        if (generation === this.generation) this.store(key, value, ttlMs);
        return value;
      })
      .finally(() => {
        if (this.inflight.get(key) === promise) this.inflight.delete(key);
      });
    this.inflight.set(key, promise);
    return promise;
  }

  clear(): void {
    this.generation += 1;
    this.entries.clear();
    this.inflight.clear();
  }

  get size(): number {
    return this.entries.size;
  }

  private store(key: string, value: unknown, ttlMs: number): void {
    if (ttlMs <= 0) return;
    while (this.entries.size >= this.maxEntries) {
      const oldest = this.entries.keys().next().value;
      if (oldest === undefined) break;
      this.entries.delete(oldest);
    }
    this.entries.set(key, { value, expiresAt: this.now() + ttlMs });
  }
}
