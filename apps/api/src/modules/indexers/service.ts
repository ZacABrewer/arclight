import { eq } from 'drizzle-orm';
import type { Logger } from 'pino';
import {
  categoriesFor,
  CookieJar,
  createDefinitionIndexer,
  createIndexer,
  createProxiedFetch,
  createRateLimiter,
  IndexerError,
  newznab,
  SEARCH_PARAMS,
  STANDARD_CATEGORIES,
  torznab,
  type AccountStats,
  type ClientOptions,
  type Definition,
  type DefinitionIndexer,
  type IndexerCapabilities,
  type IndexerDefinition,
  type ProxyConfig,
  type ReleaseInfo,
  type SearchParam,
  type SearchRequest,
  type SettingsValues,
} from '@arclight/indexers';
import {
  DEFAULT_INDEXER_AUDIOBOOK_CATEGORIES,
  DEFAULT_INDEXER_MUSIC_CATEGORIES,
  indexerAudioCategories,
  IndexerCreate,
  IndexerSettings,
  IndexerUpdate,
  INDEXER_HEALTH_DEFAULT_DAYS,
  INDEXER_PRIORITY_DEFAULT,
  indexerFlagsFromVolumeFactors,
  protocolForImplementation,
  SearchGrabRequest,
  type DefinitionFieldValue,
  type Indexer,
  type IndexerCapabilitiesResource,
  type IndexerCategory,
  type IndexerErrorCode,
  type IndexerHealth,
  type IndexerImplementation,
  type IndexerStatKind,
  type IndexerStatus,
  type IndexerTemplate,
  type IndexerTestAllItem,
  type IndexerTestResult,
  type ManualSearchRequest,
  type ReleaseResource,
  type SearchGrabResponse,
} from '@arclight/shared';
import type { Db } from '../../db/index.js';
import { artists } from '../music/schema.js';
import { authors } from '../audiobooks/schema.js';
import { getFeatureSettings } from '../settings/service.js';
import { DefinitionStore } from './definitions.js';
import { IndexersError, parseOrThrow } from './errors.js';
import { ProxiesService, type TunnelOpener } from './proxies.js';
import { indexerCapsCache, indexerRssState, indexers, indexerStatus } from './schema.js';
import { summarizeHealth } from './health.js';
import { IndexerStatsRecorder } from './stats.js';

export { IndexersError, type IndexersErrorCode } from './errors.js';
/** Domain hint for a release's categories (`series | movie | music | audiobook | auto`). */
export { domainFromCategories, type CategoryDomain } from '@arclight/indexers';

// ---- public types -------------------------------------------------------------------

export type SearchMode = 'automatic' | 'interactive';

export interface SearchOptions {
  mode: SearchMode;
  /** Restrict to these indexers (still subject to the mode's enable flag and backoff). */
  indexerIds?: readonly number[];
  /** Override each indexer's configured categories for this search. */
  categories?: readonly number[];
  signal?: AbortSignal;
}

export interface IndexerStatusChange {
  kind: 'failed' | 'recovered';
  indexerId: number;
  indexerName: string;
  status: IndexerStatus;
  error?: { code: IndexerErrorCode; message: string };
}

export type IndexerStatusListener = (change: IndexerStatusChange) => void;
export type ReleasesHandler = (releases: ReleaseResource[]) => void | Promise<void>;

/** Turns library ids (series/episode/movie) into a concrete indexer request. */
export type ManualSearchResolver = (
  request: ManualSearchRequest,
) => SearchRequest | null | Promise<SearchRequest | null>;

/** What the release pipeline answers for a search-page grab. */
export type SearchGrabOutcome =
  | ({ kind: 'grabbed' } & SearchGrabResponse)
  | { kind: 'no-match'; rejections: string[] };

/** Registered by the release pipeline: decide on and grab one search result. */
export type SearchGrabber = (
  release: ReleaseResource,
  opts: { force: boolean; downloadClientId?: number },
) => Promise<SearchGrabOutcome>;

/** A release file resolved through its indexer (cookies, login and proxies applied). */
export type ReleaseDownload =
  | { kind: 'magnet'; magnetUrl: string }
  | { kind: 'file'; protocol: 'torrent' | 'usenet'; data: Uint8Array; contentType: string; fileName: string };

/**
 * Audio domains whose categories RSS (and free-text search) add to the video ones. A domain
 * is enabled when its feature flag is on and it has something monitored.
 */
export interface AudioDomains {
  music: boolean;
  audiobooks: boolean;
}

export interface IndexersServiceOptions {
  db: Db;
  log?: Logger;
  /** Injected into the protocol clients; defaults to global fetch. */
  fetch?: typeof fetch;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  /** Whole-operation budget per indexer (caps + all pages). Default 60 s. */
  indexerTimeoutMs?: number;
  /** Per-HTTP-request timeout handed to the client. Default 30 s. */
  requestTimeoutMs?: number;
  /** Definition catalogue; defaults to the bundled definitions only. */
  definitions?: DefinitionStore;
  /** Test seam for proxy connectivity checks. */
  openTunnel?: TunnelOpener;
  /** Which audio domains are enabled; defaults to the feature flags plus monitored items in the db. */
  audioDomains?: () => AudioDomains;
}

// ---- constants ----------------------------------------------------------------------

const MINUTE = 60_000;
/** Disable duration after the Nth consecutive failure; the last step repeats. */
export const BACKOFF_STEPS_MS: readonly number[] = [5, 15, 30, 60, 180, 360, 720, 1440].map((m) => m * MINUTE);
export const CAPS_TTL_MS = 24 * 60 * MINUTE;
/** Releases dated this far before the newest one seen still count as new if their guid is unseen. */
export const RSS_DATE_TOLERANCE_MS = 6 * 60 * MINUTE;
export const RSS_GUID_MEMORY = 1000;
/** Search-page results stay grabbable / downloadable this long. */
export const SEARCH_CACHE_TTL_MS = 30 * MINUTE;
export const SEARCH_CACHE_MAX = 5000;
const DAY = 24 * 60 * MINUTE;
const MAX_REDIRECTS = 10;

export function backoffFor(failureCount: number): number {
  const idx = Math.min(Math.max(failureCount, 1), BACKOFF_STEPS_MS.length) - 1;
  return BACKOFF_STEPS_MS[idx] ?? BACKOFF_STEPS_MS[BACKOFF_STEPS_MS.length - 1]!;
}

type IndexerRow = typeof indexers.$inferSelect;
type StatusRow = typeof indexerStatus.$inferSelect;
/** The parts of a row needed to talk to an indexer (saved or not). */
type ClientRow = Pick<IndexerRow, 'id' | 'name' | 'implementation' | 'settings' | 'proxyId' | 'tags'>;

// ---- service ------------------------------------------------------------------------

export class IndexersService {
  readonly definitions: DefinitionStore;
  readonly proxies: ProxiesService;
  readonly stats: IndexerStatsRecorder;
  private readonly db: Db;
  private readonly log: Logger | undefined;
  private readonly fetchImpl: typeof fetch | undefined;
  private readonly now: () => number;
  private readonly sleep: ((ms: number) => Promise<void>) | undefined;
  private readonly indexerTimeoutMs: number;
  private readonly requestTimeoutMs: number;
  private readonly limiters = new Map<number, { rateLimitMs: number; wait: () => Promise<void> }>();
  private readonly statusListeners = new Set<IndexerStatusListener>();
  private readonly releaseHandlers = new Set<ReleasesHandler>();
  private readonly definitionClients = new Map<number, { key: string; client: DefinitionIndexer }>();
  private readonly proxiedFetches = new Map<number, { key: string; fetch: typeof fetch }>();
  private readonly searchCache = new Map<string, { release: ReleaseResource; at: number }>();
  private manualResolver: ManualSearchResolver | undefined;
  private searchGrabber: SearchGrabber | undefined;
  private readonly audioDomainsOf: () => AudioDomains;

  constructor(opts: IndexersServiceOptions) {
    this.db = opts.db;
    this.log = opts.log;
    this.fetchImpl = opts.fetch;
    this.now = opts.now ?? Date.now;
    this.sleep = opts.sleep;
    this.indexerTimeoutMs = opts.indexerTimeoutMs ?? 60_000;
    this.requestTimeoutMs = opts.requestTimeoutMs ?? 30_000;
    this.definitions = opts.definitions ?? new DefinitionStore(opts.log ? { log: opts.log } : {});
    this.definitions.addReloadListener(() => this.dropClients());
    this.proxies = new ProxiesService({
      db: opts.db,
      now: this.now,
      onChange: () => this.dropClients(),
      ...(opts.fetch ? { fetch: opts.fetch } : {}),
      ...(opts.openTunnel ? { openTunnel: opts.openTunnel } : {}),
    });
    this.stats = new IndexerStatsRecorder(opts.db, this.now);
    this.audioDomainsOf = opts.audioDomains ?? (() => audioDomainsFromDb(opts.db));
  }

  /** Audio domains currently enabled for RSS (flag on and something monitored). */
  audioDomains(): AudioDomains {
    return this.audioDomainsOf();
  }

  // ---- hooks ------------------------------------------------------------------------

  /** Called on every recorded failure and on recovery after failures. Returns unsubscribe. */
  onIndexerStatusChanged(listener: IndexerStatusListener): () => void {
    this.statusListeners.add(listener);
    return () => this.statusListeners.delete(listener);
  }

  /** Receives the new releases of each RSS sync. Returns unsubscribe. */
  onReleases(handler: ReleasesHandler): () => void {
    this.releaseHandlers.add(handler);
    return () => this.releaseHandlers.delete(handler);
  }

  /** Lets the release pipeline turn library ids into indexer requests for manual search. */
  setManualSearchResolver(resolver: ManualSearchResolver | undefined): void {
    this.manualResolver = resolver;
  }

  /** Lets the release pipeline decide on and grab search-page results (POST /search/grab). */
  setSearchGrabber(grabber: SearchGrabber | undefined): void {
    this.searchGrabber = grabber;
  }

  /** Hand releases to the registered handlers (default: log the count). Handler errors are logged. */
  async dispatchReleases(releases: ReleaseResource[]): Promise<void> {
    if (this.releaseHandlers.size === 0) {
      this.log?.info({ count: releases.length }, 'rss sync found releases; no release handler registered');
      return;
    }
    for (const handler of this.releaseHandlers) {
      try {
        await handler(releases);
      } catch (err) {
        this.log?.error({ err }, 'release handler failed');
      }
    }
  }

  // ---- CRUD -------------------------------------------------------------------------

  list(): Indexer[] {
    const statuses = new Map(this.db.select().from(indexerStatus).all().map((s) => [s.indexerId, s]));
    return this.db
      .select()
      .from(indexers)
      .orderBy(indexers.id)
      .all()
      .map((row) => this.toResource(row, statuses.get(row.id)));
  }

  get(id: number): Indexer {
    const row = this.requireRow(id);
    return this.toResource(row, this.statusRow(id));
  }

  create(input: IndexerCreate): Indexer {
    const data = parseOrThrow(IndexerCreate, input);
    const settings = this.validateFor(data.implementation, data.settings);
    this.assertUniqueName(data.name);
    const proxyId = this.checkedProxyId(data.proxyId);
    const row = this.db
      .insert(indexers)
      .values({
        name: data.name,
        implementation: data.implementation,
        enableRss: data.enableRss,
        enableAutomaticSearch: data.enableAutomaticSearch,
        enableInteractiveSearch: data.enableInteractiveSearch,
        priority: data.priority,
        downloadClientId: data.downloadClientId ?? null,
        proxyId,
        tags: data.tags,
        settings,
        addedAt: this.isoNow(),
      })
      .returning()
      .get();
    return this.toResource(row, undefined);
  }

  update(id: number, input: IndexerUpdate): Indexer {
    const current = this.requireRow(id);
    const patch = parseOrThrow(IndexerUpdate, input);
    const name = patch.name ?? current.name;
    if (name.toLowerCase() !== current.name.toLowerCase()) this.assertUniqueName(name, id);

    const implementation = patch.implementation ?? current.implementation;
    const mergedRaw = { ...current.settings, ...withoutUndefined(patch.settings ?? {}) };
    const settings = this.validateFor(implementation, parseOrThrow(IndexerSettings, mergedRaw));
    const proxyId = patch.proxyId === undefined ? current.proxyId : this.checkedProxyId(patch.proxyId);

    const row = this.db
      .update(indexers)
      .set({
        name,
        implementation,
        enableRss: patch.enableRss ?? current.enableRss,
        enableAutomaticSearch: patch.enableAutomaticSearch ?? current.enableAutomaticSearch,
        enableInteractiveSearch: patch.enableInteractiveSearch ?? current.enableInteractiveSearch,
        priority: patch.priority ?? current.priority,
        downloadClientId: patch.downloadClientId === undefined ? current.downloadClientId : patch.downloadClientId,
        proxyId,
        tags: patch.tags ?? current.tags,
        settings,
      })
      .where(eq(indexers.id, id))
      .returning()
      .get();
    if (!row) throw new IndexersError('NOT_FOUND', `indexer ${id} not found`);

    // A different endpoint means different caps, rate limit and health.
    const endpointChanged =
      implementation !== current.implementation ||
      settings.baseUrl !== current.settings.baseUrl ||
      settings.apiPath !== current.settings.apiPath ||
      settings.apiKey !== current.settings.apiKey ||
      settings.definitionId !== current.settings.definitionId ||
      JSON.stringify(settings.fields ?? {}) !== JSON.stringify(current.settings.fields ?? {});
    if (endpointChanged) {
      this.db.delete(indexerCapsCache).where(eq(indexerCapsCache.indexerId, id)).run();
      this.db.delete(indexerStatus).where(eq(indexerStatus.indexerId, id)).run();
    }
    this.limiters.delete(id);
    this.dropClients(id);
    return this.toResource(row, this.statusRow(id));
  }

  delete(id: number): void {
    this.requireRow(id);
    this.db.delete(indexerCapsCache).where(eq(indexerCapsCache.indexerId, id)).run();
    this.db.delete(indexerStatus).where(eq(indexerStatus.indexerId, id)).run();
    this.db.delete(indexerRssState).where(eq(indexerRssState.indexerId, id)).run();
    this.db.delete(indexers).where(eq(indexers.id, id)).run();
    this.limiters.delete(id);
    this.dropClients(id);
  }

  // ---- templates & categories -------------------------------------------------------

  templates(): IndexerTemplate[] {
    const make = (implementation: IndexerImplementation, implementationName: string, infoLink: string): IndexerTemplate => ({
      implementation,
      implementationName,
      protocol: protocolForImplementation(implementation),
      infoLink,
      template: {
        name: '',
        implementation,
        enableRss: true,
        enableAutomaticSearch: true,
        enableInteractiveSearch: true,
        priority: INDEXER_PRIORITY_DEFAULT,
        tags: [],
        settings: {
          baseUrl: '',
          apiPath: '/api',
          apiKey: '',
          categories: [2000, 5000],
          animeCategories: [5070],
          musicCategories: [...DEFAULT_INDEXER_MUSIC_CATEGORIES],
          audiobookCategories: [...DEFAULT_INDEXER_AUDIOBOOK_CATEGORIES],
          ...(implementation === 'torznab' ? { minimumSeeders: 1 } : {}),
        },
      },
    });
    return [
      make('torznab', 'Torznab', 'https://torznab.github.io/spec-1.3-draft/'),
      make('newznab', 'Newznab', 'https://newznab.readthedocs.io/en/latest/misc/api/'),
    ];
  }

  categories(): IndexerCategory[] {
    return STANDARD_CATEGORIES.filter((c) => c.parentId === undefined).map((parent) => ({
      id: parent.id,
      name: parent.name,
      subCategories: STANDARD_CATEGORIES.filter((c) => c.parentId === parent.id).map((c) => ({ id: c.id, name: c.name })),
    }));
  }

  // ---- status -----------------------------------------------------------------------

  statuses(): IndexerStatus[] {
    const statusMap = new Map(this.db.select().from(indexerStatus).all().map((s) => [s.indexerId, s]));
    const rssMap = new Map(this.db.select().from(indexerRssState).all().map((s) => [s.indexerId, s]));
    return this.db
      .select({ id: indexers.id })
      .from(indexers)
      .orderBy(indexers.id)
      .all()
      .map(({ id }) => toStatus(id, statusMap.get(id), rssMap.get(id)?.lastSyncAt));
  }

  /** Per-indexer health summary for the last `days` days (see ./health.ts for the verdicts). */
  health(days: number = INDEXER_HEALTH_DEFAULT_DAYS): IndexerHealth {
    const now = this.now();
    const rows = this.db
      .select({
        id: indexers.id,
        name: indexers.name,
        enableRss: indexers.enableRss,
        enableAutomaticSearch: indexers.enableAutomaticSearch,
        enableInteractiveSearch: indexers.enableInteractiveSearch,
      })
      .from(indexers)
      .all();
    return summarizeHealth({
      days,
      now,
      indexers: rows.map((r) => ({ id: r.id, name: r.name, enabled: r.enableRss || r.enableAutomaticSearch || r.enableInteractiveSearch })),
      samples: this.stats.samplesSince(new Date(now - days * DAY).toISOString()),
      latest: this.stats.latestOutcomes(),
      statuses: new Map(this.db.select().from(indexerStatus).all().map((s) => [s.indexerId, s])),
    });
  }

  /** True while an indexer is inside its failure backoff window. */
  isDisabled(id: number): boolean {
    return isDisabledRow(this.statusRow(id), this.now());
  }

  /**
   * Re-probe indexers whose backoff has expired; a passing probe clears their status, a
   * failing one escalates the backoff. Returns a one-line summary.
   */
  async statusCheck(signal?: AbortSignal): Promise<string> {
    const now = this.now();
    const rows = this.db.select().from(indexers).all();
    const failing = rows.filter((row) => {
      const s = this.statusRow(row.id);
      return s !== undefined && s.failureCount > 0 && !isDisabledRow(s, now);
    });
    await Promise.allSettled(
      failing.map(async (row) => {
        const result = await this.probe(row, signal);
        if (result.ok) {
          this.storeCaps(row.id, result.caps);
          this.recordSuccess(row);
        } else if (!signal?.aborted) {
          this.recordFailure(row, result.error);
        }
      }),
    );
    const unavailable = rows.filter((row) => this.isDisabled(row.id)).length;
    if (rows.length > 0 && unavailable === rows.length) this.log?.warn('all indexers are unavailable');
    return `${unavailable} of ${rows.length} indexers unavailable; probed ${failing.length}`;
  }

  // ---- testing ----------------------------------------------------------------------

  /** Test an unsaved definition: fresh caps + an RSS query. Never throws for indexer errors. */
  async test(input: IndexerCreate, signal?: AbortSignal): Promise<IndexerTestResult> {
    const data = parseOrThrow(IndexerCreate, input);
    if (data.implementation === 'definition') await this.definitions.ready();
    const settings = this.validateFor(data.implementation, data.settings);
    const result = await this.probe(
      { id: 0, name: data.name, implementation: data.implementation, settings, proxyId: data.proxyId ?? null, tags: data.tags },
      signal,
    );
    return result.ok
      ? { ok: true, caps: result.caps, releaseCount: result.releaseCount }
      : { ok: false, error: { code: result.error.code, message: result.error.message } };
  }

  /** Test every saved indexer. Successes refresh the caps cache and clear failure status. */
  async testAll(signal?: AbortSignal): Promise<IndexerTestAllItem[]> {
    const rows = this.db.select().from(indexers).orderBy(indexers.id).all();
    return Promise.all(
      rows.map(async (row): Promise<IndexerTestAllItem> => {
        const result = await this.probe(row, signal);
        if (result.ok) {
          this.storeCaps(row.id, result.caps);
          this.recordSuccess(row);
          return { id: row.id, name: row.name, ok: true, caps: result.caps, releaseCount: result.releaseCount };
        }
        return { id: row.id, name: row.name, ok: false, error: { code: result.error.code, message: result.error.message } };
      }),
    );
  }

  // ---- caps -------------------------------------------------------------------------

  /** Capabilities from the 24 h cache, fetched (and failure-tracked) when stale or `refresh`. */
  async getCaps(id: number, opts: { refresh?: boolean; signal?: AbortSignal } = {}): Promise<IndexerCapabilitiesResource> {
    const row = this.requireRow(id);
    if (!opts.refresh) {
      const cached = this.cachedCaps(id);
      if (cached) return cached;
    }
    return this.guarded(row, opts.signal, (signal) => this.loadCaps(row, signal, true));
  }

  // ---- search -----------------------------------------------------------------------

  /** Cross-indexer search. Failing indexers are isolated and recorded; results are merged and de-duplicated. */
  async search(request: SearchRequest, opts: SearchOptions): Promise<ReleaseResource[]> {
    const rows = this.eligible(opts.mode === 'automatic' ? 'enableAutomaticSearch' : 'enableInteractiveSearch', opts.indexerIds);
    const started = this.now();
    // Only free-text searches mix domains; typed searches pick their own list.
    const domains = request.kind === 'search' && !opts.categories && rows.length > 0 ? this.audioDomainsOf() : NO_AUDIO_DOMAINS;
    const results = await Promise.allSettled(
      rows.map((row) =>
        this.timed(row, 'query', opts.signal, () =>
          this.guarded(row, opts.signal, async (signal) => {
            if (row.implementation === 'definition') {
              const client = await this.definitionClient(row);
              const categories = opts.categories ?? definitionCategories(row, request.kind, domains);
              return client.search({ ...request, ...(categories ? { categories } : {}) });
            }
            const caps = await this.loadCaps(row, signal, false);
            const def = toDefinition(row, { kind: request.kind, domains, ...(opts.categories ? { override: opts.categories } : {}) });
            return protocolOf(row.implementation).search(def, request, toPackageCaps(caps), this.clientOptions(row, signal));
          }),
          (infos) => infos.length,
        ),
      ),
    );
    const merged: ReleaseResource[] = [];
    results.forEach((result, i) => {
      const row = rows[i]!;
      if (result.status === 'fulfilled') {
        for (const info of result.value) merged.push(toRelease(info, row, started));
      } else {
        this.log?.debug({ indexer: row.name, err: result.reason }, 'indexer search failed');
      }
    });
    return dedupe(merged);
  }

  /** Interactive search from the API: raw ids/query search directly, library ids go through the resolver. */
  async manualSearch(request: ManualSearchRequest, signal?: AbortSignal): Promise<ReleaseResource[]> {
    const usesLibraryIds =
      request.seriesId !== undefined ||
      request.episodeId !== undefined ||
      request.movieId !== undefined ||
      request.artistId !== undefined ||
      request.albumId !== undefined;
    let resolved: SearchRequest | null = null;
    if (usesLibraryIds && this.manualResolver) {
      resolved = await this.manualResolver(request);
      if (!resolved) throw new IndexersError('VALIDATION', 'could not resolve the requested library item');
    } else {
      resolved = toSearchRequest(request);
      if (!resolved) {
        throw new IndexersError(
          'VALIDATION',
          usesLibraryIds
            ? 'searching by library id is not available yet; pass query or tvdbId/tmdbId/imdbId'
            : 'nothing to search: pass query, tvdbId/tmdbId/imdbId, artist/album or author/title',
        );
      }
    }
    const releases = await this.search(resolved, {
      mode: 'interactive',
      ...(request.indexerIds?.length ? { indexerIds: request.indexerIds } : {}),
      ...(request.categories?.length ? { categories: request.categories } : {}),
      ...(signal ? { signal } : {}),
    });
    this.cacheResults(releases);
    return releases;
  }

  /** A result of a recent manual search, by indexer + guid. */
  cachedResult(indexerId: number, guid: string): ReleaseResource | undefined {
    const hit = this.searchCache.get(`${indexerId}:${guid}`);
    if (!hit) return undefined;
    if (this.now() - hit.at > SEARCH_CACHE_TTL_MS) {
      this.searchCache.delete(`${indexerId}:${guid}`);
      return undefined;
    }
    return hit.release;
  }

  /**
   * POST /search/grab: re-run the decision engine on a cached search result and grab it.
   * Without a library match the grab needs `force`.
   */
  async searchGrab(input: SearchGrabRequest): Promise<SearchGrabResponse> {
    const req = parseOrThrow(SearchGrabRequest, input);
    const release = this.cachedResult(req.indexerId, req.guid);
    if (!release) throw new IndexersError('NOT_FOUND', 'Release not found; search again before grabbing');
    if (!this.searchGrabber) throw new IndexersError('VALIDATION', 'grabbing is not available: the release pipeline is not loaded');
    const outcome = await this.searchGrabber(release, {
      force: req.force,
      ...(req.downloadClientId !== undefined ? { downloadClientId: req.downloadClientId } : {}),
    });
    if (outcome.kind === 'no-match') {
      const why = outcome.rejections.length > 0 ? ` (${outcome.rejections.join('; ')})` : '';
      throw new IndexersError('NO_MATCH', `No library item matches this release${why}; grab with force to send it anyway`, {
        rejections: outcome.rejections,
      });
    }
    const { kind: _kind, ...response } = outcome;
    return response;
  }

  // ---- downloads --------------------------------------------------------------------

  /**
   * Resolve a release link through its indexer: definition indexers use the site's download
   * rules (login cookies, details-page scraping); Torznab/Newznab links are fetched through the
   * indexer's proxies, following redirects (a redirect to a magnet returns the magnet).
   * Every call is recorded as a grab in the stats.
   */
  async downloadRelease(indexerId: number, url: string, opts: { signal?: AbortSignal } = {}): Promise<ReleaseDownload> {
    const row = this.requireRow(indexerId);
    const protocol = protocolForImplementation(row.implementation);
    const started = this.now();
    try {
      const result = await this.resolveDownload(row, protocol, url, opts.signal);
      this.stats.record(row.id, 'grab', this.now() - started, true);
      return result;
    } catch (err) {
      this.stats.record(row.id, 'grab', this.now() - started, false, { error: statsErrorMessage(err) });
      if (err instanceof IndexersError) throw err;
      const status = err instanceof IndexerError ? err.status : undefined;
      const message = err instanceof Error ? err.message : String(err);
      if (status === 404 || status === 410) {
        throw new IndexersError('UNAVAILABLE', `Release is no longer available at the indexer (HTTP ${status})`);
      }
      throw new IndexersError('DOWNLOAD_FAILED', `Downloading the release failed: ${message}`);
    }
  }

  /**
   * GET /indexer/:id/download: like `downloadRelease`, but only for links that belong to the
   * indexer (a recent search result of it, or a URL on one of its hosts), so the endpoint cannot
   * be used to send the indexer's cookies elsewhere.
   */
  async downloadForUser(indexerId: number, url: string): Promise<ReleaseDownload> {
    const row = this.requireRow(indexerId);
    if (!url.startsWith('magnet:') && !this.isIndexerLink(row, url)) {
      throw new IndexersError('VALIDATION', 'url does not belong to this indexer; search again and use a result link');
    }
    return this.downloadRelease(indexerId, url);
  }

  // ---- account statistics (tracker-stats module) -------------------------------------

  /** True when the indexer is a definition indexer whose definition has an `account` page. */
  hasAccountPage(id: number): boolean {
    const row = this.requireRow(id);
    if (row.implementation !== 'definition' || !row.settings.definitionId) return false;
    return this.definitions.get(row.settings.definitionId)?.account !== undefined;
  }

  /**
   * Scrape the user's ratio, upload, download, buffer and H&R count from the definition's
   * `account` page (logged in like a search). Not recorded as an indexer failure: an account
   * page that moved says nothing about searching.
   */
  async accountStats(id: number, signal?: AbortSignal): Promise<AccountStats> {
    const row = this.requireRow(id);
    if (!this.hasAccountPage(id)) throw new IndexersError('VALIDATION', `${row.name} has no account statistics page`);
    return withTimeout(this.indexerTimeoutMs, signal, row.name, async () => (await this.definitionClient(row)).accountStats());
  }

  /** Host names the indexer lives on: the configured base URL plus the definition's links. */
  siteHosts(id: number): string[] {
    const row = this.requireRow(id);
    const hosts = new Set<string>();
    const add = (u: string | undefined) => {
      try {
        if (u) hosts.add(new URL(u).hostname.toLowerCase());
      } catch {
        // not a URL
      }
    };
    add(row.settings.baseUrl);
    if (row.implementation === 'definition' && row.settings.definitionId) {
      const def = this.definitions.get(row.settings.definitionId);
      for (const link of [...(def?.links ?? []), ...(def?.legacylinks ?? [])]) add(link);
    }
    return [...hosts];
  }

  // ---- RSS --------------------------------------------------------------------------

  /** Fetch every RSS-enabled, available indexer and return releases not seen by previous syncs. */
  async rss(opts: { signal?: AbortSignal } = {}): Promise<ReleaseResource[]> {
    const rows = this.eligible('enableRss');
    const started = this.now();
    const domains = rows.length > 0 ? this.audioDomainsOf() : NO_AUDIO_DOMAINS;
    const results = await Promise.allSettled(
      rows.map((row) => {
        // Results are counted before the RSS marker drops releases seen by earlier syncs.
        let fetched = 0;
        return this.timed(
          row,
          'rss',
          opts.signal,
          () =>
            this.guarded(row, opts.signal, async (signal) => {
              let infos: ReleaseInfo[];
              if (row.implementation === 'definition') {
                // Site definitions list their whole RSS page (already a superset of every domain).
                infos = await (await this.definitionClient(row)).rss();
              } else {
                const caps = await this.loadCaps(row, signal, false);
                infos = await protocolOf(row.implementation).search(
                  toDefinition(row, { kind: 'rss', domains }),
                  { kind: 'rss' },
                  toPackageCaps(caps),
                  this.clientOptions(row, signal),
                );
              }
              fetched = infos.length;
              return this.advanceRssMarker(row.id, infos);
            }),
          () => fetched,
        );
      }),
    );
    const merged: ReleaseResource[] = [];
    results.forEach((result, i) => {
      const row = rows[i]!;
      if (result.status === 'fulfilled') {
        for (const info of result.value) merged.push(toRelease(info, row, started));
      }
    });
    return dedupe(merged);
  }

  // ---- internals --------------------------------------------------------------------

  private async resolveDownload(
    row: IndexerRow,
    protocol: 'torrent' | 'usenet',
    url: string,
    signal: AbortSignal | undefined,
  ): Promise<ReleaseDownload> {
    if (url.startsWith('magnet:')) {
      if (protocol === 'usenet') throw new IndexersError('DOWNLOAD_FAILED', 'A usenet release cannot be a magnet link');
      return { kind: 'magnet', magnetUrl: url };
    }
    const title = this.titleForLink(row.id, url);
    if (row.implementation === 'definition') {
      const client = await this.definitionClient(row);
      const result = await withTimeout(this.indexerTimeoutMs, signal, row.name, () => client.download(url));
      if (result.kind === 'magnet') return { kind: 'magnet', magnetUrl: result.magnetUrl };
      return {
        kind: 'file',
        protocol: 'torrent',
        data: result.data,
        contentType: 'application/x-bittorrent',
        fileName: fileNameFor(title, 'torrent'),
      };
    }
    const doFetch = this.proxiedFetch(row) ?? this.fetchImpl ?? fetch;
    let current = url;
    for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
      const res = await doFetch(current, {
        redirect: 'manual',
        signal: anySignal(signal, AbortSignal.timeout(this.requestTimeoutMs)),
      });
      if (res.status >= 300 && res.status < 400) {
        const location = res.headers.get('location');
        if (!location) break;
        if (location.startsWith('magnet:')) {
          if (protocol === 'usenet') throw new IndexersError('DOWNLOAD_FAILED', 'Indexer redirected a usenet release to a magnet link');
          return { kind: 'magnet', magnetUrl: location };
        }
        current = new URL(location, current).toString();
        continue;
      }
      if (res.status === 404 || res.status === 410) {
        throw new IndexersError('UNAVAILABLE', `Release is no longer available at the indexer (HTTP ${res.status})`);
      }
      if (!res.ok) throw new IndexersError('DOWNLOAD_FAILED', `Downloading the release failed (HTTP ${res.status})`);
      const data = new Uint8Array(await res.arrayBuffer());
      if (data.length === 0) throw new IndexersError('DOWNLOAD_FAILED', 'Indexer returned an empty file');
      const ext = protocol === 'usenet' ? 'nzb' : 'torrent';
      return {
        kind: 'file',
        protocol,
        data,
        contentType: protocol === 'usenet' ? 'application/x-nzb' : 'application/x-bittorrent',
        fileName: fileNameFor(title ?? dispositionName(res.headers.get('content-disposition')), ext),
      };
    }
    throw new IndexersError('DOWNLOAD_FAILED', 'Too many redirects downloading the release');
  }

  private cacheResults(releases: readonly ReleaseResource[]): void {
    const now = this.now();
    for (const [key, v] of this.searchCache) if (now - v.at > SEARCH_CACHE_TTL_MS) this.searchCache.delete(key);
    for (const r of releases) {
      const key = `${r.indexerId}:${r.guid}`;
      this.searchCache.delete(key);
      this.searchCache.set(key, { release: r, at: now });
    }
    while (this.searchCache.size > SEARCH_CACHE_MAX) {
      const oldest = this.searchCache.keys().next().value;
      if (oldest === undefined) break;
      this.searchCache.delete(oldest);
    }
  }

  private titleForLink(indexerId: number, url: string): string | undefined {
    for (const { release } of this.searchCache.values()) {
      if (release.indexerId === indexerId && (release.downloadUrl === url || release.magnetUrl === url)) return release.title;
    }
    return undefined;
  }

  private isIndexerLink(row: IndexerRow, url: string): boolean {
    if (this.titleForLink(row.id, url) !== undefined) return true;
    let host: string;
    try {
      const parsed = new URL(url);
      if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return false;
      host = parsed.hostname.toLowerCase();
    } catch {
      return false;
    }
    const hosts = new Set<string>();
    const add = (u: string | undefined) => {
      try {
        if (u) hosts.add(new URL(u).hostname.toLowerCase());
      } catch {
        // not a URL
      }
    };
    add(row.settings.baseUrl);
    if (row.implementation === 'definition' && row.settings.definitionId) {
      const def = this.definitions.get(row.settings.definitionId);
      for (const link of [...(def?.links ?? []), ...(def?.legacylinks ?? [])]) add(link);
    }
    return hosts.has(host);
  }

  /**
   * Run an indexer operation and append a stats row (requests the indexer cannot serve are not
   * counted). `count` gives the number of releases the operation returned.
   */
  private async timed<T>(
    row: IndexerRow,
    kind: IndexerStatKind,
    parent: AbortSignal | undefined,
    op: () => Promise<T>,
    count?: (value: T) => number,
  ): Promise<T> {
    const started = this.now();
    try {
      const value = await op();
      this.stats.record(row.id, kind, this.now() - started, true, count ? { results: count(value) } : {});
      return value;
    } catch (err) {
      const unsupported = err instanceof IndexerError && err.code === 'unsupported-search';
      if (!parent?.aborted && !unsupported) this.stats.record(row.id, kind, this.now() - started, false, { error: statsErrorMessage(err) });
      throw err;
    }
  }

  private advanceRssMarker(indexerId: number, infos: ReleaseInfo[]): ReleaseInfo[] {
    const state = this.db.select().from(indexerRssState).where(eq(indexerRssState.indexerId, indexerId)).get();
    let fresh: ReleaseInfo[];
    if (!state) {
      fresh = infos;
    } else {
      const seen = new Set(state.recentGuids);
      const last = state.lastPublishDate ? Date.parse(state.lastPublishDate) : Number.NaN;
      const cutoff = Number.isNaN(last) ? Number.NEGATIVE_INFINITY : last - RSS_DATE_TOLERANCE_MS;
      fresh = infos.filter((r) => {
        if (seen.has(r.guid)) return false;
        const t = Date.parse(r.publishDate);
        return Number.isNaN(t) || t >= cutoff;
      });
    }

    let newest: ReleaseInfo | undefined;
    for (const r of infos) {
      const t = Date.parse(r.publishDate);
      if (Number.isNaN(t)) continue;
      if (!newest || t > Date.parse(newest.publishDate)) newest = r;
    }
    const prevLast = state?.lastPublishDate ? Date.parse(state.lastPublishDate) : Number.NaN;
    const advance = newest !== undefined && (Number.isNaN(prevLast) || Date.parse(newest.publishDate) > prevLast);
    const currentGuids = infos.map((r) => r.guid);
    const currentSet = new Set(currentGuids);
    const recentGuids = [...currentGuids, ...(state?.recentGuids ?? []).filter((g) => !currentSet.has(g))].slice(
      0,
      RSS_GUID_MEMORY,
    );
    const values = {
      lastGuid: advance ? newest!.guid : (state?.lastGuid ?? null),
      lastPublishDate: advance ? new Date(Date.parse(newest!.publishDate)).toISOString() : (state?.lastPublishDate ?? null),
      recentGuids,
      lastSyncAt: this.isoNow(),
    };
    this.db
      .insert(indexerRssState)
      .values({ indexerId, ...values })
      .onConflictDoUpdate({ target: indexerRssState.indexerId, set: values })
      .run();
    return fresh;
  }

  /** Enabled (for the given flag), not in backoff, optionally restricted to ids; priority order. */
  private eligible(
    flag: 'enableRss' | 'enableAutomaticSearch' | 'enableInteractiveSearch',
    ids?: readonly number[],
  ): IndexerRow[] {
    const now = this.now();
    const wanted = ids && ids.length > 0 ? new Set(ids) : undefined;
    const statuses = new Map(this.db.select().from(indexerStatus).all().map((s) => [s.indexerId, s]));
    return this.db
      .select()
      .from(indexers)
      .orderBy(indexers.priority, indexers.id)
      .all()
      .filter((row) => row[flag] && (!wanted || wanted.has(row.id)) && !isDisabledRow(statuses.get(row.id), now));
  }

  /** Run one indexer operation under the per-indexer timeout and record its health. */
  private async guarded<T>(
    row: IndexerRow,
    parent: AbortSignal | undefined,
    op: (signal: AbortSignal) => Promise<T>,
  ): Promise<T> {
    try {
      const value = await withTimeout(this.indexerTimeoutMs, parent, row.name, op);
      this.recordSuccess(row);
      return value;
    } catch (err) {
      if (parent?.aborted) throw err;
      const error = toIndexerError(err);
      // A request the indexer cannot serve says nothing about its health.
      if (error.code !== 'unsupported-search') this.recordFailure(row, error);
      throw error;
    }
  }

  private async probe(
    row: ClientRow,
    signal: AbortSignal | undefined,
  ): Promise<
    { ok: true; caps: IndexerCapabilitiesResource; releaseCount: number } | { ok: false; error: IndexerError }
  > {
    try {
      return await withTimeout(this.indexerTimeoutMs, signal, row.name, async (s) => {
        const proxy = this.proxies.resolve(row, this.proxyOptions(row));
        const client =
          row.implementation === 'definition'
            ? await this.buildDefinitionClient(row, proxy)
            : createIndexer(proxy ? { ...toDefinition(row), proxy } : toDefinition(row), {
                ...this.baseClientOptions(s),
                ...(row.id > 0 ? { indexerId: row.id } : {}),
                ...(this.sleep ? { sleep: this.sleep } : {}),
              });
        const result = await client.test();
        if (!result.ok) return { ok: false as const, error: result.error };
        return { ok: true as const, caps: toCapsResource(result.caps), releaseCount: result.releaseCount };
      });
    } catch (err) {
      return { ok: false, error: toIndexerError(err) };
    }
  }

  private async loadCaps(row: IndexerRow, signal: AbortSignal, refresh: boolean): Promise<IndexerCapabilitiesResource> {
    if (!refresh) {
      const cached = this.cachedCaps(row.id);
      if (cached) return cached;
    }
    const caps =
      row.implementation === 'definition'
        ? await (await this.definitionClient(row)).caps()
        : await protocolOf(row.implementation).fetchCaps(toDefinition(row), this.clientOptions(row, signal));
    return this.storeCaps(row.id, toCapsResource(caps));
  }

  private cachedCaps(id: number): IndexerCapabilitiesResource | undefined {
    const cached = this.db.select().from(indexerCapsCache).where(eq(indexerCapsCache.indexerId, id)).get();
    if (!cached) return undefined;
    const age = this.now() - Date.parse(cached.fetchedAt);
    return age >= 0 && age < CAPS_TTL_MS ? { ...cached.caps, fetchedAt: cached.fetchedAt } : undefined;
  }

  private storeCaps(id: number, caps: IndexerCapabilitiesResource): IndexerCapabilitiesResource {
    const fetchedAt = this.isoNow();
    const { fetchedAt: _drop, ...stored } = caps;
    this.db
      .insert(indexerCapsCache)
      .values({ indexerId: id, caps: stored, fetchedAt })
      .onConflictDoUpdate({ target: indexerCapsCache.indexerId, set: { caps: stored, fetchedAt } })
      .run();
    return { ...stored, fetchedAt };
  }

  private baseClientOptions(signal: AbortSignal): Omit<ClientOptions, 'beforeRequest'> {
    return {
      timeoutMs: this.requestTimeoutMs,
      signal,
      now: this.now,
      ...(this.fetchImpl ? { fetch: this.fetchImpl } : {}),
    };
  }

  private clientOptions(row: IndexerRow, signal: AbortSignal): ClientOptions {
    const rateLimitMs = Math.round((row.settings.rateLimitSeconds ?? 0) * 1000);
    let limiter = this.limiters.get(row.id);
    if (!limiter || limiter.rateLimitMs !== rateLimitMs) {
      limiter = { rateLimitMs, wait: createRateLimiter(rateLimitMs, this.now, this.sleep) };
      this.limiters.set(row.id, limiter);
    }
    const proxied = this.proxiedFetch(row);
    return {
      ...this.baseClientOptions(signal),
      ...(proxied ? { fetch: proxied } : {}),
      beforeRequest: limiter.wait,
      indexerId: row.id,
    };
  }

  /**
   * Fetch through the indexer's proxies (Torznab/Newznab), with a cookie jar that keeps
   * FlareSolverr clearance cookies across requests. Undefined when no proxy applies.
   */
  private proxiedFetch(row: IndexerRow): typeof fetch | undefined {
    const proxy = this.proxies.resolve(row, this.proxyOptions(row));
    if (!proxy) {
      this.proxiedFetches.delete(row.id);
      return undefined;
    }
    const key = JSON.stringify(proxy);
    const cached = this.proxiedFetches.get(row.id);
    if (cached?.key === key) return cached.fetch;
    const jar = new CookieJar();
    const inner = createProxiedFetch(proxy, { jar, ...(this.fetchImpl ? { fetchImpl: this.fetchImpl } : {}) });
    const wrapped: typeof fetch = (input, init) => {
      const headers = new Headers(init?.headers);
      const cookie = jar.header();
      if (cookie && !headers.has('cookie')) headers.set('cookie', cookie);
      return inner(input, { ...init, headers });
    };
    this.proxiedFetches.set(row.id, { key, fetch: wrapped });
    return wrapped;
  }

  /**
   * Definitions that set `requiresFlareSolverr: true` default to the first FlareSolverr proxy
   * when none applies. The key is new in the definition schema, so it is read defensively:
   * anything but `true` (including absent) means no.
   */
  private proxyOptions(row: Pick<ClientRow, 'implementation' | 'settings'>): { needsSolver?: boolean } {
    if (row.implementation !== 'definition' || !row.settings.definitionId) return {};
    const def: unknown = this.definitions.get(row.settings.definitionId);
    // The definition parser lowercases keys, so the parsed form is `requiresflaresolverr`.
    const flag = def as { requiresFlareSolverr?: unknown; requiresflaresolverr?: unknown } | null;
    const needs = typeof flag === 'object' && flag !== null && (flag.requiresflaresolverr === true || flag.requiresFlareSolverr === true);
    return needs ? { needsSolver: true } : {};
  }

  /** The cached definition client of a saved indexer (one per row, so login cookies persist). */
  private async definitionClient(row: IndexerRow): Promise<DefinitionIndexer> {
    await this.definitions.ready();
    const proxy = this.proxies.resolve(row, this.proxyOptions(row));
    const key = JSON.stringify({ name: row.name, settings: row.settings, proxy: proxy ?? null });
    const cached = this.definitionClients.get(row.id);
    if (cached?.key === key) return cached.client;
    const client = await this.buildDefinitionClient(row, proxy);
    this.definitionClients.set(row.id, { key, client });
    return client;
  }

  private async buildDefinitionClient(row: ClientRow, proxy: ProxyConfig[] | undefined): Promise<DefinitionIndexer> {
    await this.definitions.ready();
    const id = row.settings.definitionId;
    const def = id ? this.definitions.get(id) : undefined;
    if (!def) throw new IndexerError('bad-response', `definition "${id ?? ''}" is not in the catalogue`);
    const rateLimitMs = Math.round((row.settings.rateLimitSeconds ?? 0) * 1000);
    const log = this.log?.child({ indexer: row.name });
    return createDefinitionIndexer(def, toSettingsValues(def, row.settings), {
      name: row.name,
      timeoutMs: this.requestTimeoutMs,
      now: this.now,
      ...(rateLimitMs > 0 ? { rateLimitMs } : {}),
      ...(row.id > 0 ? { indexerId: row.id } : {}),
      ...(this.fetchImpl ? { fetchImpl: this.fetchImpl } : {}),
      ...(this.sleep ? { sleep: this.sleep } : {}),
      ...(proxy ? { proxy } : {}),
      ...(log ? { log: (level, message) => log[level](message) } : {}),
    });
  }

  /** Forget cached clients (all, or one indexer's) so the next call rebuilds them. */
  private dropClients(id?: number): void {
    if (id === undefined) {
      this.definitionClients.clear();
      this.proxiedFetches.clear();
    } else {
      this.definitionClients.delete(id);
      this.proxiedFetches.delete(id);
    }
  }

  private validateFor(implementation: IndexerImplementation, settings: IndexerSettings): IndexerSettings {
    return implementation === 'definition' ? this.validateDefinitionSettings(settings) : validateSettings(settings);
  }

  /** Known definition, typed field values, site link resolved into `baseUrl`. */
  private validateDefinitionSettings(input: IndexerSettings): IndexerSettings {
    const definitionId = input.definitionId?.trim();
    if (!definitionId) throw new IndexersError('VALIDATION', 'settings.definitionId: required for definition indexers');
    const def = this.definitions.get(definitionId);
    if (!def) throw new IndexersError('VALIDATION', `settings.definitionId: unknown definition "${definitionId}"`);
    const fields = normalizeFields(def, input.fields ?? {});
    const sitelink = typeof fields['sitelink'] === 'string' ? fields['sitelink'] : undefined;
    let baseUrl = def.links[0] ?? '';
    for (const candidate of [sitelink, input.baseUrl]) {
      const trimmed = candidate?.trim();
      if (!trimmed) continue;
      if (!isHttpUrl(trimmed)) throw new IndexersError('VALIDATION', `settings: "${trimmed}" is not a valid http(s) site link`);
      baseUrl = trimmed;
      break;
    }
    if (sitelink === undefined && baseUrl !== (def.links[0] ?? '')) fields['sitelink'] = baseUrl;
    const out: IndexerSettings = {
      baseUrl,
      apiPath: '',
      categories: [...new Set(input.categories)],
      animeCategories: [...new Set(input.animeCategories)],
      ...audioCategoryLists(input),
      definitionId,
      fields,
    };
    if (input.minimumSeeders !== undefined) out.minimumSeeders = input.minimumSeeders;
    if (input.seedRatio !== undefined) out.seedRatio = input.seedRatio;
    if (input.seedTime !== undefined) out.seedTime = input.seedTime;
    if (input.seasonPackSeedTime !== undefined) out.seasonPackSeedTime = input.seasonPackSeedTime;
    if (input.rateLimitSeconds !== undefined) out.rateLimitSeconds = input.rateLimitSeconds;
    return out;
  }

  private checkedProxyId(proxyId: number | null | undefined): number | null {
    if (proxyId === undefined || proxyId === null) return null;
    if (!this.proxies.exists(proxyId)) throw new IndexersError('VALIDATION', `proxyId: indexer proxy ${proxyId} not found`);
    return proxyId;
  }

  private toResource(row: IndexerRow, status: StatusRow | undefined): Indexer {
    const out: Indexer = {
      id: row.id,
      name: row.name,
      implementation: row.implementation,
      protocol: protocolForImplementation(row.implementation),
      enableRss: row.enableRss,
      enableAutomaticSearch: row.enableAutomaticSearch,
      enableInteractiveSearch: row.enableInteractiveSearch,
      priority: row.priority,
      tags: row.tags,
      settings: withAudioCategories(row.settings),
    };
    if (row.downloadClientId !== null) out.downloadClientId = row.downloadClientId;
    if (row.proxyId !== null) out.proxyId = row.proxyId;
    if (status && (status.failureCount > 0 || status.lastFailure)) {
      const { indexerId: _id, lastRssSyncAt: _rss, ...summary } = toStatus(row.id, status, undefined);
      out.status = summary;
    }
    if (row.implementation === 'definition' && row.settings.definitionId) {
      const def = this.definitions.get(row.settings.definitionId);
      if (def) {
        out.definitionName = def.name;
        out.privacy = def.type;
      }
    }
    const proxyNames = this.proxies.applicable(row, this.proxyOptions(row)).map((p) => p.name);
    if (proxyNames.length > 0) out.proxyNames = proxyNames;
    return out;
  }

  private recordFailure(row: IndexerRow | Pick<IndexerRow, 'id' | 'name'>, error: IndexerError): void {
    if (!this.db.select({ id: indexers.id }).from(indexers).where(eq(indexers.id, row.id)).get()) return;
    const now = this.now();
    const nowIso = new Date(now).toISOString();
    const prev = this.statusRow(row.id);
    // Requests already in flight when the indexer was disabled do not escalate further.
    const alreadyDisabled = isDisabledRow(prev, now);
    const failureCount = alreadyDisabled ? prev!.failureCount : (prev?.failureCount ?? 0) + 1;
    const disabledTill = alreadyDisabled ? prev!.disabledTill : new Date(now + backoffFor(failureCount)).toISOString();
    const values = {
      failureCount,
      initialFailure: prev?.failureCount ? (prev.initialFailure ?? nowIso) : nowIso,
      lastFailure: nowIso,
      disabledTill,
      mostRecentFailure: `${error.code}: ${error.message}`,
    };
    this.db
      .insert(indexerStatus)
      .values({ indexerId: row.id, ...values })
      .onConflictDoUpdate({ target: indexerStatus.indexerId, set: values })
      .run();
    this.log?.warn({ indexer: row.name, failureCount, disabledTill, err: error.message }, 'indexer failed');
    if (!alreadyDisabled) {
      this.emit({
        kind: 'failed',
        indexerId: row.id,
        indexerName: row.name,
        status: toStatus(row.id, this.statusRow(row.id), undefined),
        error: { code: error.code, message: error.message },
      });
    }
  }

  private recordSuccess(row: Pick<IndexerRow, 'id' | 'name'>): void {
    const prev = this.statusRow(row.id);
    if (!prev || (prev.failureCount === 0 && !prev.disabledTill)) return;
    this.db
      .update(indexerStatus)
      .set({ failureCount: 0, disabledTill: null, initialFailure: null })
      .where(eq(indexerStatus.indexerId, row.id))
      .run();
    this.log?.info({ indexer: row.name }, 'indexer recovered');
    this.emit({
      kind: 'recovered',
      indexerId: row.id,
      indexerName: row.name,
      status: toStatus(row.id, this.statusRow(row.id), undefined),
    });
  }

  private emit(change: IndexerStatusChange): void {
    for (const listener of this.statusListeners) {
      try {
        listener(change);
      } catch (err) {
        this.log?.error({ err }, 'indexer status listener failed');
      }
    }
  }

  private statusRow(id: number): StatusRow | undefined {
    return this.db.select().from(indexerStatus).where(eq(indexerStatus.indexerId, id)).get();
  }

  private requireRow(id: number): IndexerRow {
    const row = this.db.select().from(indexers).where(eq(indexers.id, id)).get();
    if (!row) throw new IndexersError('NOT_FOUND', `indexer ${id} not found`);
    return row;
  }

  private assertUniqueName(name: string, exceptId?: number): void {
    const wanted = name.trim().toLowerCase();
    const clash = this.db
      .select({ id: indexers.id, name: indexers.name })
      .from(indexers)
      .all()
      .find((r) => r.id !== exceptId && r.name.toLowerCase() === wanted);
    if (clash) throw new IndexersError('CONFLICT', `an indexer named "${clash.name}" already exists`);
  }

  private isoNow(): string {
    return new Date(this.now()).toISOString();
  }
}

// ---- helpers ------------------------------------------------------------------------

function withoutUndefined<T extends object>(obj: T): { [K in keyof T]?: Exclude<T[K], undefined> } {
  return Object.fromEntries(Object.entries(obj).filter(([, v]) => v !== undefined)) as {
    [K in keyof T]?: Exclude<T[K], undefined>;
  };
}

function isHttpUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === 'http:' || url.protocol === 'https:';
  } catch {
    return false;
  }
}

/**
 * Check definition field values against the definition's settings: checkboxes are booleans
 * (`"true"`/`"false"` accepted), selects must name an option, the rest are strings. Unknown
 * keys are dropped except `sitelink`.
 */
export function normalizeFields(def: Definition, input: Record<string, DefinitionFieldValue>): Record<string, DefinitionFieldValue> {
  const out: Record<string, DefinitionFieldValue> = {};
  const sitelink = input['sitelink'] ?? input['baseUrl'];
  if (typeof sitelink === 'string' && sitelink.trim()) out['sitelink'] = sitelink.trim();
  for (const s of def.settings) {
    if (s.type.startsWith('info') || s.type === 'cardigannCaptcha') continue;
    const value = input[s.name];
    if (value === undefined) continue;
    const label = `settings.fields.${s.name}`;
    switch (s.type) {
      case 'checkbox':
        if (typeof value === 'boolean') out[s.name] = value;
        else if (value === 'true' || value === 'false') out[s.name] = value === 'true';
        else throw new IndexersError('VALIDATION', `${label}: expected true or false`);
        break;
      case 'select': {
        if (typeof value !== 'string') throw new IndexersError('VALIDATION', `${label}: expected one of the options`);
        const keys = Object.keys(s.options ?? {});
        if (keys.length > 0 && !keys.includes(value)) {
          throw new IndexersError('VALIDATION', `${label}: "${value}" is not one of ${keys.join(', ')}`);
        }
        out[s.name] = value;
        break;
      }
      default:
        if (typeof value !== 'string') throw new IndexersError('VALIDATION', `${label}: expected text`);
        out[s.name] = value;
    }
  }
  return out;
}

/** Stored field values → runtime settings values (multi-select comma lists become arrays). */
function toSettingsValues(def: Definition, settings: IndexerSettings): SettingsValues {
  const values: SettingsValues = {};
  const fields = settings.fields ?? {};
  for (const [key, value] of Object.entries(fields)) values[key] = value;
  for (const s of def.settings) {
    const v = fields[s.name];
    if (s.type === 'multi-select' && typeof v === 'string') {
      values[s.name] = v
        .split(',')
        .map((p) => p.trim())
        .filter((p) => p !== '');
    }
  }
  if (settings.baseUrl && settings.baseUrl !== def.links[0]) values['sitelink'] = settings.baseUrl;
  return values;
}

function fileNameFor(title: string | undefined, ext: string): string {
  const base = (title ?? 'release')
    .replace(/[\\/:*?"<>|\u0000-\u001f]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 200);
  const name = base || 'release';
  return name.toLowerCase().endsWith(`.${ext}`) ? name : `${name}.${ext}`;
}

function dispositionName(header: string | null): string | undefined {
  if (!header) return undefined;
  const star = /filename\*\s*=\s*(?:UTF-8'')?([^;]+)/i.exec(header);
  if (star?.[1]) {
    try {
      return decodeURIComponent(star[1].trim().replace(/^"|"$/g, ''));
    } catch {
      // fall through
    }
  }
  const plain = /filename\s*=\s*"?([^";]+)"?/i.exec(header);
  return plain?.[1]?.trim();
}

function anySignal(...signals: (AbortSignal | undefined)[]): AbortSignal {
  const list = signals.filter((s): s is AbortSignal => s !== undefined);
  return list.length === 1 ? list[0]! : AbortSignal.any(list);
}

/** URL shape, path normalization, at least one category; drops empty optional strings. */
function validateSettings(input: IndexerSettings): IndexerSettings {
  const baseUrl = input.baseUrl.trim().replace(/\/+$/, '');
  let url: URL;
  try {
    url = new URL(baseUrl);
  } catch {
    throw new IndexersError('VALIDATION', `settings.baseUrl: "${input.baseUrl}" is not a valid URL`);
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new IndexersError('VALIDATION', 'settings.baseUrl: must start with http:// or https://');
  }
  if (url.search || url.hash) {
    throw new IndexersError('VALIDATION', 'settings.baseUrl: must not contain a query string or fragment');
  }
  const rawPath = input.apiPath.trim();
  const apiPath = rawPath === '' ? '/api' : rawPath.startsWith('/') ? rawPath : `/${rawPath}`;
  const categories = [...new Set(input.categories)];
  const animeCategories = [...new Set(input.animeCategories)];
  const audio = audioCategoryLists(input);
  if (categories.length + animeCategories.length + audio.musicCategories.length + audio.audiobookCategories.length === 0) {
    throw new IndexersError('VALIDATION', 'settings.categories: select at least one category');
  }
  const out: IndexerSettings = { baseUrl, apiPath, categories, animeCategories, ...audio };
  const apiKey = input.apiKey?.trim();
  if (apiKey) out.apiKey = apiKey;
  const extra = input.additionalParameters?.trim();
  if (extra) out.additionalParameters = extra;
  if (input.minimumSeeders !== undefined) out.minimumSeeders = input.minimumSeeders;
  if (input.seedRatio !== undefined) out.seedRatio = input.seedRatio;
  if (input.seedTime !== undefined) out.seedTime = input.seedTime;
  if (input.seasonPackSeedTime !== undefined) out.seasonPackSeedTime = input.seasonPackSeedTime;
  if (input.rateLimitSeconds !== undefined) out.rateLimitSeconds = input.rateLimitSeconds;
  return out;
}

function protocolOf(implementation: IndexerImplementation): typeof torznab | typeof newznab {
  return implementation === 'newznab' ? newznab : torznab;
}

const NO_AUDIO_DOMAINS: AudioDomains = { music: false, audiobooks: false };

/**
 * Feature flags plus "something monitored". Audiobooks have no library tables yet, so the
 * flag alone enables them.
 */
function audioDomainsFromDb(db: Db): AudioDomains {
  let features: { music: boolean; audiobooks: boolean };
  try {
    features = getFeatureSettings(db);
  } catch {
    return NO_AUDIO_DOMAINS; // settings table missing (module-only schema in tests)
  }
  let music = false;
  if (features.music) {
    try {
      music = db.select({ id: artists.id }).from(artists).where(eq(artists.monitored, true)).limit(1).get() !== undefined;
    } catch {
      music = false; // music tables missing (module-only schema in tests)
    }
  }
  let audiobooks = false;
  if (features.audiobooks) {
    try {
      audiobooks = db.select({ id: authors.id }).from(authors).where(eq(authors.monitored, true)).limit(1).get() !== undefined;
    } catch {
      audiobooks = false; // audiobook tables missing (module-only schema in tests)
    }
  }
  return { music, audiobooks };
}

type ResolvedSettings = IndexerSettings & { musicCategories: number[]; audiobookCategories: number[] };

/** Saved settings from before music support have no audio lists; fill in the defaults. */
export function withAudioCategories(s: IndexerSettings): ResolvedSettings {
  return { ...s, ...audioCategoryLists(s) };
}

function audioCategoryLists(s: Pick<IndexerSettings, 'musicCategories' | 'audiobookCategories'>): {
  musicCategories: number[];
  audiobookCategories: number[];
} {
  const lists = indexerAudioCategories(s);
  return {
    musicCategories: [...new Set(lists.musicCategories)],
    audiobookCategories: [...new Set(lists.audiobookCategories)],
  };
}

/** How a request picks categories: by kind, with RSS / free text adding enabled audio domains. */
export interface CategorySelection {
  kind: SearchRequest['kind'];
  domains: AudioDomains;
  /** Replaces every configured list. */
  override?: readonly number[];
}

/**
 * Categories a definition indexer is searched with: the music / audiobook list for those
 * kinds, the video list otherwise, plus enabled audio domains for free text. `undefined`
 * lets the site use its defaults.
 */
export function definitionCategories(
  row: Pick<IndexerRow, 'settings'>,
  kind: SearchRequest['kind'],
  domains: AudioDomains,
): number[] | undefined {
  const s = withAudioCategories(row.settings);
  let list: number[];
  if (kind === 'music') list = s.musicCategories;
  else if (kind === 'book') list = s.audiobookCategories;
  else if (s.categories.length === 0) return undefined;
  else if (kind === 'search') {
    list = [
      ...new Set([
        ...s.categories,
        ...(domains.music ? s.musicCategories : []),
        ...(domains.audiobooks ? s.audiobookCategories : []),
      ]),
    ];
  } else list = s.categories;
  return list.length > 0 ? list : undefined;
}

/** The `cat=` list a Torznab/Newznab request sends for this selection. */
export function selectCategories(
  row: Pick<IndexerRow, 'name' | 'implementation' | 'settings'>,
  selection: CategorySelection,
): number[] {
  return categoriesFor(toDefinition(row, selection), selection.kind);
}

export function toDefinition(
  row: Pick<IndexerRow, 'name' | 'implementation' | 'settings'>,
  selection: Partial<CategorySelection> = {},
): IndexerDefinition {
  const s = withAudioCategories(row.settings);
  const override = selection.override;
  const kind = selection.kind ?? 'rss';
  const domains = selection.domains ?? NO_AUDIO_DOMAINS;
  const def: IndexerDefinition = {
    name: row.name,
    baseUrl: s.baseUrl,
    apiPath: s.apiPath,
    categories: override ? [...override] : s.categories,
    animeCategories: override ? [] : s.animeCategories,
    protocol: protocolForImplementation(row.implementation),
  };
  // Typed audio searches always carry their list; RSS / free text only for enabled domains.
  if (override) {
    if (kind === 'music') def.musicCategories = [...override];
    if (kind === 'book') def.audiobookCategories = [...override];
  } else {
    if (kind === 'music' || domains.music) def.musicCategories = s.musicCategories;
    if (kind === 'book' || domains.audiobooks) def.audiobookCategories = s.audiobookCategories;
  }
  if (s.apiKey) def.apiKey = s.apiKey;
  if (s.minimumSeeders !== undefined) def.minimumSeeders = s.minimumSeeders;
  if (s.seedRatio !== undefined) def.seedRatio = s.seedRatio;
  if (s.seedTime !== undefined) def.seedTime = s.seedTime;
  if (s.additionalParameters) def.additionalParameters = s.additionalParameters;
  if (s.rateLimitSeconds) def.rateLimitMs = Math.round(s.rateLimitSeconds * 1000);
  return def;
}

function toCapsResource(caps: IndexerCapabilities): IndexerCapabilitiesResource {
  const mode = (m: IndexerCapabilities['searching']['search']) => ({
    available: m.available,
    supportedParams: [...m.supportedParams],
  });
  return {
    ...(caps.serverTitle !== undefined ? { serverTitle: caps.serverTitle } : {}),
    limits: { max: caps.limits.max, default: caps.limits.default },
    searching: {
      search: mode(caps.searching.search),
      tvSearch: mode(caps.searching.tvSearch),
      movieSearch: mode(caps.searching.movieSearch),
      musicSearch: mode(caps.searching.musicSearch),
      bookSearch: mode(caps.searching.bookSearch),
    },
    categories: caps.categories.map((c) => ({ id: c.id, name: c.name, subcats: c.subcats.map((s) => ({ ...s })) })),
  };
}

function toPackageCaps(caps: IndexerCapabilitiesResource): IndexerCapabilities {
  const known = new Set<string>(SEARCH_PARAMS);
  // Caps cached before music support have no music/book modes: unavailable.
  const mode = (m: IndexerCapabilitiesResource['searching']['search'] | undefined) => ({
    available: m?.available ?? false,
    supportedParams: (m?.supportedParams ?? []).filter((p): p is SearchParam => known.has(p)),
  });
  return {
    ...(caps.serverTitle !== undefined ? { serverTitle: caps.serverTitle } : {}),
    limits: caps.limits,
    searching: {
      search: mode(caps.searching.search),
      tvSearch: mode(caps.searching.tvSearch),
      movieSearch: mode(caps.searching.movieSearch),
      musicSearch: mode(caps.searching.musicSearch),
      bookSearch: mode(caps.searching.bookSearch),
    },
    categories: caps.categories,
  };
}

/** `code: message` for indexer errors, the plain message otherwise. */
function statsErrorMessage(err: unknown): string {
  if (err instanceof IndexerError) return `${err.code}: ${err.message}`;
  return err instanceof Error ? err.message : String(err);
}

function isDisabledRow(status: StatusRow | undefined, now: number): boolean {
  if (!status?.disabledTill) return false;
  const till = Date.parse(status.disabledTill);
  return !Number.isNaN(till) && till > now;
}

function toStatus(indexerId: number, s: StatusRow | undefined, lastRssSyncAt: string | undefined): IndexerStatus {
  const out: IndexerStatus = { indexerId, failureCount: s?.failureCount ?? 0 };
  if (s?.disabledTill) out.disabledTill = s.disabledTill;
  if (s?.lastFailure) out.lastFailure = s.lastFailure;
  if (s?.mostRecentFailure) out.mostRecentFailure = s.mostRecentFailure;
  if (lastRssSyncAt) out.lastRssSyncAt = lastRssSyncAt;
  return out;
}

function toRelease(info: ReleaseInfo, row: IndexerRow, now: number): ReleaseResource {
  const published = Date.parse(info.publishDate);
  const ageMs = Number.isNaN(published) ? 0 : Math.max(0, now - published);
  return {
    ...info,
    indexerId: row.id,
    indexerName: row.name,
    indexerPriority: row.priority,
    age: Math.floor(ageMs / DAY),
    ageHours: ageMs / (60 * MINUTE),
    ageMinutes: ageMs / MINUTE,
    ...flagsOf(info),
    rejections: [],
    approved: false,
  };
}

/** `indexerFlags` from the volume factors; omitted when there are none. */
function flagsOf(info: ReleaseInfo): { indexerFlags?: ReleaseResource['indexerFlags'] } {
  const flags = indexerFlagsFromVolumeFactors(info);
  return flags.length > 0 ? { indexerFlags: flags } : {};
}

/**
 * One entry per guid / info hash. The copy from the higher-priority indexer (lower number)
 * wins, then the one with more seeders. Output is newest first.
 */
export function dedupe(releases: ReleaseResource[]): ReleaseResource[] {
  const ranked = [...releases].sort(
    (a, b) => a.indexerPriority - b.indexerPriority || (b.seeders ?? -1) - (a.seeders ?? -1) || a.indexerId - b.indexerId,
  );
  const seen = new Set<string>();
  const kept: ReleaseResource[] = [];
  for (const r of ranked) {
    const keys = [`guid:${r.guid}`];
    if (r.infoHash) keys.push(`hash:${r.infoHash.toLowerCase()}`);
    if (keys.some((k) => seen.has(k))) continue;
    for (const k of keys) seen.add(k);
    kept.push(r);
  }
  return kept.sort(
    (a, b) => Date.parse(b.publishDate) - Date.parse(a.publishDate) || a.indexerPriority - b.indexerPriority,
  );
}

export function toSearchRequest(req: ManualSearchRequest): SearchRequest | null {
  const musicHints = req.artist !== undefined || req.album !== undefined || req.label !== undefined;
  const bookHints = req.author !== undefined || req.title !== undefined;
  const tvHints = req.tvdbId !== undefined || req.season !== undefined || req.episode !== undefined || req.airDate !== undefined;
  const movieHints = req.tmdbId !== undefined || req.imdbId !== undefined || req.year !== undefined;
  const type =
    req.type ??
    (musicHints ? 'music' : bookHints ? 'book' : tvHints ? 'tv' : movieHints ? 'movie' : req.query ? 'search' : undefined);
  switch (type) {
    case 'music':
      if (!req.query && !req.artist && !req.album) return null;
      return {
        kind: 'music',
        ...withoutUndefined({ query: req.query, artist: req.artist, album: req.album, year: req.year, label: req.label }),
      };
    case 'book':
      if (!req.query && !req.author && !req.title) return null;
      return { kind: 'book', ...withoutUndefined({ query: req.query, author: req.author, title: req.title }) };
    case 'tv':
      if (!req.query && req.tvdbId === undefined && req.tmdbId === undefined && req.imdbId === undefined) return null;
      return {
        kind: 'tv',
        ...withoutUndefined({
          query: req.query,
          tvdbId: req.tvdbId,
          tmdbId: req.tmdbId,
          imdbId: req.imdbId,
          season: req.season,
          episode: req.episode,
          airDate: req.airDate,
        }),
      };
    case 'movie':
      if (!req.query && req.tmdbId === undefined && req.imdbId === undefined) return null;
      return {
        kind: 'movie',
        ...withoutUndefined({ query: req.query, tmdbId: req.tmdbId, imdbId: req.imdbId, year: req.year }),
      };
    case 'search':
      return req.query ? { kind: 'search', query: req.query } : null;
    default:
      return null;
  }
}

function toIndexerError(err: unknown): IndexerError {
  if (err instanceof IndexerError) return err;
  const message = err instanceof Error ? err.message : String(err);
  return new IndexerError('unreachable', message, { cause: err });
}

/** Race `op` against a timeout; the signal handed to `op` aborts on timeout or parent abort. */
async function withTimeout<T>(
  ms: number,
  parent: AbortSignal | undefined,
  label: string,
  op: (signal: AbortSignal) => Promise<T>,
): Promise<T> {
  if (parent?.aborted) throw parent.reason ?? new Error('aborted');
  const ctrl = new AbortController();
  const onParentAbort = () => ctrl.abort(parent?.reason ?? new Error('aborted'));
  parent?.addEventListener('abort', onParentAbort, { once: true });
  let timer: ReturnType<typeof setTimeout> | undefined;
  const guard = new Promise<never>((_, reject) => {
    timer = setTimeout(() => ctrl.abort(new IndexerError('unreachable', `${label} timed out after ${ms} ms`)), ms);
    ctrl.signal.addEventListener('abort', () => reject(ctrl.signal.reason ?? new Error('aborted')), { once: true });
  });
  try {
    return await Promise.race([op(ctrl.signal), guard]);
  } finally {
    clearTimeout(timer);
    parent?.removeEventListener('abort', onParentAbort);
  }
}
