import { and, eq, lt } from 'drizzle-orm';
import {
  MUSICBRAINZ_DEFAULT_CACHE_TTLS,
  type MbArtist,
  type MbBrowseReleaseGroupsOptions,
  type MbRelease,
  type MbReleaseGroup,
  type MbReleaseSummary,
  type MusicBrainzCacheTtls,
  type MusicBrainzClient,
  type RequestOptions,
} from '@arclight/metadata';
import type { Db } from '../../db/index.js';
import { metadataCache } from '../../db/schema.js';

// Persistent metadata cache (design 5.3) over the `metadata_cache` table. The MusicBrainz client
// keeps its own short-lived in-memory cache for searches; the entity calls (artist, release-group
// browse, release browse, release) go through this store instead, so a restart does not cost a
// cold crawl at 1 request per second. Hits never touch the rate limiter. Rows are kept 30 days
// past their expiry (MetadataCacheCleanup), so an outage can fall back to stale data.

const DAY_MS = 24 * 60 * 60 * 1000;
/** Rows are pruned this long after they expire. */
export const CACHE_RETENTION_MS = 30 * DAY_MS;

export interface CachedEntry<T> {
  body: T;
  fetchedAt: string;
  expiresAt: string;
}

export interface MetadataCacheStore {
  /** The entry when present and not expired (or any entry with `allowStale`). */
  get<T>(provider: string, key: string, opts?: { allowStale?: boolean }): CachedEntry<T> | undefined;
  set(provider: string, key: string, body: unknown, ttlMs: number): void;
  delete(provider: string, key: string): void;
  /** Deletes rows that expired more than `retentionMs` ago; returns how many. */
  prune(retentionMs?: number): number;
}

export function createMetadataCacheStore(db: Db, now: () => Date = () => new Date()): MetadataCacheStore {
  return {
    get<T>(provider: string, key: string, opts: { allowStale?: boolean } = {}) {
      const row = db
        .select()
        .from(metadataCache)
        .where(and(eq(metadataCache.provider, provider), eq(metadataCache.key, key)))
        .get();
      if (!row) return undefined;
      if (!opts.allowStale && Date.parse(row.expiresAt) <= now().getTime()) return undefined;
      return { body: row.body as T, fetchedAt: row.fetchedAt, expiresAt: row.expiresAt };
    },
    set(provider, key, body, ttlMs) {
      if (ttlMs <= 0) return;
      const at = now();
      const values = {
        provider,
        key,
        body,
        etag: null,
        fetchedAt: at.toISOString(),
        expiresAt: new Date(at.getTime() + ttlMs).toISOString(),
      };
      db.insert(metadataCache)
        .values(values)
        .onConflictDoUpdate({
          target: [metadataCache.provider, metadataCache.key],
          set: { body: values.body, etag: null, fetchedAt: values.fetchedAt, expiresAt: values.expiresAt },
        })
        .run();
    },
    delete(provider, key) {
      db.delete(metadataCache).where(and(eq(metadataCache.provider, provider), eq(metadataCache.key, key))).run();
    },
    prune(retentionMs = CACHE_RETENTION_MS) {
      const cutoff = new Date(now().getTime() - retentionMs).toISOString();
      return db.delete(metadataCache).where(lt(metadataCache.expiresAt, cutoff)).returning({ key: metadataCache.key }).all().length;
    },
  };
}

/** `fresh` skips the stored entry (the answer is still stored); manual refreshes use it. */
export type CachedRequestOptions = RequestOptions & { fresh?: boolean };

/** The MusicBrainz entity calls, cached in `metadata_cache`. Searches pass straight through. */
export interface CachedMusicBrainzClient extends MusicBrainzClient {
  getArtist(mbid: string, options?: CachedRequestOptions): Promise<MbArtist>;
  browseReleaseGroups(artistMbid: string, options?: MbBrowseReleaseGroupsOptions & { fresh?: boolean }): Promise<MbReleaseGroup[]>;
  browseReleases(releaseGroupMbid: string, options?: CachedRequestOptions): Promise<MbReleaseSummary[]>;
  getRelease(mbid: string, options?: CachedRequestOptions): Promise<MbRelease>;
}

/**
 * Wraps a client so its entity calls read and write `store` under `provider` (the client's
 * limiter bucket, so a self-hosted mirror never shares rows with the public server).
 * Create the inner client with entity TTLs of 0: this layer is the cache.
 */
export function withPersistentCache(
  client: MusicBrainzClient,
  store: MetadataCacheStore,
  ttls: Partial<MusicBrainzCacheTtls> = {},
): CachedMusicBrainzClient {
  const ttl: MusicBrainzCacheTtls = { ...MUSICBRAINZ_DEFAULT_CACHE_TTLS, ...ttls };
  const provider = client.providerKey;

  async function cached<T>(key: string, ttlMs: number, fresh: boolean | undefined, load: () => Promise<T>): Promise<T> {
    if (!fresh) {
      const hit = store.get<T>(provider, key);
      if (hit) return hit.body;
    }
    const value = await load();
    store.set(provider, key, value, ttlMs);
    return value;
  }

  const strip = <O extends { fresh?: boolean }>(options: O | undefined): Omit<O, 'fresh'> => {
    if (!options) return {} as Omit<O, 'fresh'>;
    const { fresh: _fresh, ...rest } = options;
    return rest;
  };

  return {
    ...client,
    providerKey: provider,
    searchArtists: (query, options) => client.searchArtists(query, options),
    searchReleaseGroups: (query, options) => client.searchReleaseGroups(query, options),
    clearCache: () => client.clearCache(),
    getArtist: (mbid, options) =>
      cached(`artist/${mbid.toLowerCase()}`, ttl.artist, options?.fresh, () => client.getArtist(mbid, strip(options))),
    browseReleaseGroups: (mbid, options) => {
      const types = [...(options?.types ?? ['album', 'ep', 'single'])].sort().join('|');
      return cached(`release-groups/${mbid.toLowerCase()}?type=${types}`, ttl.releaseGroups, options?.fresh, () =>
        client.browseReleaseGroups(mbid, strip(options)),
      );
    },
    browseReleases: (mbid, options) =>
      cached(`releases/${mbid.toLowerCase()}`, ttl.releases, options?.fresh, () => client.browseReleases(mbid, strip(options))),
    getRelease: (mbid, options) =>
      cached(`release/${mbid.toLowerCase()}`, ttl.release, options?.fresh, () => client.getRelease(mbid, strip(options))),
  };
}
