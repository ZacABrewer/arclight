import {
  createAudnexusClient,
  createDefaultAudiobookCatalog,
  createOpenLibraryClient,
  defaultRateLimiter,
  openLibraryAuthorPhotoUrl,
  type AudibleRegion,
  type AudiobookCatalog,
  type AudnexusClient,
  type CatalogAuthor,
  type CatalogAuthorRef,
  type CatalogAuthorWithBooks,
  type CatalogBook,
  type CatalogBookRef,
  type CatalogChapters,
  type CatalogRequestOptions,
  type FetchLike,
  type OpenLibraryClient,
  type RateLimiter,
  type RequestPriority,
} from '@arclight/metadata';
import type { AudiobookMetadataSettings } from '@arclight/shared';
import type { Logger } from 'pino';
import type { Db } from '../../db/index.js';
import { VERSION } from '../../version.js';
import { getSection } from '../settings/service.js';
import { createMetadataCacheStore, type MetadataCacheStore } from './cache.js';
import { PROJECT_URL } from './music-service.js';

// Audiobook metadata (design 5.2, 5.3) from the `audiobookMetadata` settings section: the
// default AudiobookCatalog (Audible catalogue + Audnexus + OpenLibrary) on the process-wide rate
// limiter, plus direct Audnexus / OpenLibrary author lookups for POST /author (one call, so the
// request can answer before the bibliography is read).
//
// Persistent cache: the catalog takes no cache of its own (each client keeps a short in-memory
// TTL cache), so this service wraps the catalog calls the jobs repeat (author bibliography, book,
// chapters, author record) in `metadata_cache`, like the MusicBrainz entity calls. Searches stay
// in memory only. Keys carry the region, and bibliographies the language filter.

const DAY_MS = 24 * 60 * 60 * 1000;

/** Persistent TTLs (design 5.3): Audnexus records 7 d, Audible bibliography 1 d. */
export const AUDIOBOOK_CACHE_TTLS = {
  author: 7 * DAY_MS,
  bibliography: DAY_MS,
  book: 7 * DAY_MS,
  chapters: 30 * DAY_MS,
} as const;

/** `metadata_cache.provider` of the audiobook rows. */
export const AUDIOBOOK_CACHE_PROVIDER = 'audiobook-catalog';

/** Test seams: no live network in tests. */
export interface AudiobookProviderOverrides {
  fetchImpl?: FetchLike;
  rateLimiter?: RateLimiter;
  now?: () => Date;
  /** Replaces the whole catalog (tests that script answers). */
  catalog?: AudiobookCatalog;
}

/** `Arclight/<version> ( <project url> )`; OpenLibrary asks for a User-Agent. */
export function audiobookUserAgent(): string {
  return `Arclight/${VERSION} ( ${PROJECT_URL} )`;
}

export interface CachedCallOptions {
  priority?: RequestPriority;
  signal?: AbortSignal;
  region?: AudibleRegion;
  /** Skip the stored answer (it is still stored); manual refreshes use it. */
  fresh?: boolean;
}

/** One author record, whichever source it came from (enough to create the library row). */
export type AuthorRecord = CatalogAuthor;

interface Clients {
  catalog: AudiobookCatalog;
  audnexus: AudnexusClient | null;
  openLibrary: OpenLibraryClient | null;
}

export class AudiobookMetadataService {
  readonly store: MetadataCacheStore;
  private clients: { key: string; value: Clients } | null = null;

  constructor(private readonly deps: { db: Db; log: Logger; overrides?: AudiobookProviderOverrides }) {
    this.store = createMetadataCacheStore(deps.db, deps.overrides?.now);
  }

  settings(): AudiobookMetadataSettings {
    return getSection(this.deps.db, 'audiobookMetadata');
  }

  private build(): Clients {
    const s = this.settings();
    const key = JSON.stringify([s.audibleRegion, s.audnexusBaseUrl, s.openLibraryFallback, s.audnexusRateLimitPerSecond, s.audibleRateLimitPerSecond, s.openLibraryRateLimitPerSecond]);
    if (this.clients?.key === key) return this.clients.value;
    const o = this.deps.overrides ?? {};
    const shared = {
      userAgent: audiobookUserAgent(),
      rateLimiter: o.rateLimiter ?? defaultRateLimiter,
      ...(o.fetchImpl ? { fetchImpl: o.fetchImpl } : {}),
      ...(o.now ? { now: o.now } : {}),
    };
    const value: Clients = o.catalog
      ? { catalog: o.catalog, audnexus: null, openLibrary: null }
      : {
          catalog: createDefaultAudiobookCatalog({
            ...shared,
            region: s.audibleRegion,
            audnexusBaseUrl: s.audnexusBaseUrl,
            openLibraryFallback: s.openLibraryFallback,
            // The language filter is passed per call (an author may override the setting).
            languages: [],
            requestsPerSecond: { audnexus: s.audnexusRateLimitPerSecond, audible: s.audibleRateLimitPerSecond, openLibrary: s.openLibraryRateLimitPerSecond },
          }),
          audnexus: createAudnexusClient({ ...shared, baseUrl: s.audnexusBaseUrl, region: s.audibleRegion, requestsPerSecond: s.audnexusRateLimitPerSecond }),
          openLibrary: createOpenLibraryClient({ ...shared, requestsPerSecond: s.openLibraryRateLimitPerSecond }),
        };
    this.clients = { key, value };
    return value;
  }

  /** The catalog for the current settings (searches go straight through; not cached persistently). */
  catalog(): AudiobookCatalog {
    return this.build().catalog;
  }

  private region(opts: CachedCallOptions): AudibleRegion {
    return opts.region ?? this.settings().audibleRegion;
  }

  private request(opts: CachedCallOptions, extra: Partial<CatalogRequestOptions> = {}): CatalogRequestOptions {
    return {
      region: this.region(opts),
      ...(opts.priority ? { priority: opts.priority } : {}),
      ...(opts.signal ? { signal: opts.signal } : {}),
      ...extra,
    };
  }

  private async cached<T>(key: string, ttlMs: number, fresh: boolean | undefined, load: () => Promise<T>): Promise<T> {
    if (!fresh) {
      const hit = this.store.get<T>(AUDIOBOOK_CACHE_PROVIDER, key);
      if (hit) return hit.body;
    }
    const value = await load();
    this.store.set(AUDIOBOOK_CACHE_PROVIDER, key, value, ttlMs);
    return value;
  }

  /** The author and their bibliography, kept to `languages` (empty keeps every language). */
  getAuthorWithBooks(ref: CatalogAuthorRef, languages: readonly string[], opts: CachedCallOptions = {}): Promise<CatalogAuthorWithBooks> {
    const id = ref.asin ? `asin:${ref.asin.toUpperCase()}` : ref.olid ? `ol:${ref.olid.toUpperCase()}` : `name:${(ref.name ?? '').toLowerCase()}`;
    const langs = [...languages].map((l) => l.toLowerCase()).sort().join(',');
    return this.cached(`author-books/${this.region(opts)}/${id}?languages=${langs}`, AUDIOBOOK_CACHE_TTLS.bibliography, opts.fresh, () =>
      this.catalog().getAuthorWithBooks(ref, this.request(opts, { languages: [...languages] })),
    );
  }

  getBook(ref: CatalogBookRef, opts: CachedCallOptions = {}): Promise<CatalogBook> {
    const id = ref.asin ? `asin:${ref.asin.toUpperCase()}` : ref.isbn ? `isbn:${ref.isbn}` : `ol:${ref.olWorkId ?? ''}`;
    return this.cached(`book/${this.region(opts)}/${id}`, AUDIOBOOK_CACHE_TTLS.book, opts.fresh, () => this.catalog().getBook(ref, this.request(opts)));
  }

  getChapters(asin: string, opts: CachedCallOptions = {}): Promise<CatalogChapters> {
    return this.cached(`chapters/${this.region(opts)}/${asin.toUpperCase()}`, AUDIOBOOK_CACHE_TTLS.chapters, opts.fresh, () =>
      this.catalog().getChapters(asin, this.request(opts)),
    );
  }

  /**
   * One author record by ASIN (Audnexus) or OpenLibrary id, without the bibliography. With an
   * injected catalog (tests) the catalog's author is used instead.
   */
  authorRecord(ref: { asin?: string; olid?: string }, opts: CachedCallOptions = {}): Promise<AuthorRecord> {
    const region = this.region(opts);
    const request = { ...(opts.priority ? { priority: opts.priority } : {}), ...(opts.signal ? { signal: opts.signal } : {}) };
    const { audnexus, openLibrary } = this.build();
    if (ref.asin) {
      const asin = ref.asin.toUpperCase();
      return this.cached(`author/${region}/asin:${asin}`, AUDIOBOOK_CACHE_TTLS.author, opts.fresh, async () => {
        if (!audnexus) return (await this.catalog().getAuthorWithBooks({ asin }, this.request(opts))).author;
        const a = await audnexus.getAuthor(asin, { ...request, region });
        return {
          name: a.name,
          asin: a.asin.toUpperCase(),
          ...(a.description ? { description: a.description } : {}),
          ...(a.image ? { image: a.image } : {}),
          genres: a.genres.filter((g) => g.type === 'genre').map((g) => g.name),
          similar: [],
          region: a.region,
          sources: ['audnexus'],
        } satisfies CatalogAuthor;
      });
    }
    const olid = (ref.olid ?? '').toUpperCase();
    return this.cached(`author/ol:${olid}`, AUDIOBOOK_CACHE_TTLS.author, opts.fresh, async () => {
      if (!openLibrary) return (await this.catalog().getAuthorWithBooks({ olid }, this.request(opts))).author;
      const a = await openLibrary.getAuthor(olid, request);
      const photo = a.photoIds[0];
      return {
        name: a.name,
        olid: a.olid.toUpperCase(),
        ...(a.amazonAsin ? { asin: a.amazonAsin.toUpperCase() } : {}),
        ...(a.bio ? { description: a.bio } : {}),
        ...(photo !== undefined ? { image: openLibraryAuthorPhotoUrl({ id: photo }, { size: 'L' }) } : {}),
        genres: [],
        similar: [],
        sources: ['openlibrary'],
      } satisfies CatalogAuthor;
    });
  }
}
