import { eq } from 'drizzle-orm';
import type { z } from 'zod';
import type { Logger } from 'pino';
import {
  createIndexer,
  createRateLimiter,
  IndexerError,
  newznab,
  SEARCH_PARAMS,
  STANDARD_CATEGORIES,
  torznab,
  type ClientOptions,
  type IndexerCapabilities,
  type IndexerDefinition,
  type ReleaseInfo,
  type SearchParam,
  type SearchRequest,
} from '@media-tron/indexers';
import {
  IndexerCreate,
  IndexerSettings,
  IndexerUpdate,
  INDEXER_PRIORITY_DEFAULT,
  protocolForImplementation,
  type Indexer,
  type IndexerCapabilitiesResource,
  type IndexerCategory,
  type IndexerErrorCode,
  type IndexerImplementation,
  type IndexerStatus,
  type IndexerTemplate,
  type IndexerTestAllItem,
  type IndexerTestResult,
  type ManualSearchRequest,
  type ReleaseResource,
} from '@media-tron/shared';
import type { Db } from '../../db/index.js';
import { indexerCapsCache, indexerRssState, indexers, indexerStatus } from './schema.js';

// ---- errors -------------------------------------------------------------------------

export type IndexersErrorCode = 'NOT_FOUND' | 'VALIDATION' | 'CONFLICT';

export class IndexersError extends Error {
  constructor(
    public readonly code: IndexersErrorCode,
    message: string,
    public readonly details?: unknown,
  ) {
    super(message);
    this.name = 'IndexersError';
  }
}

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
}

// ---- constants ----------------------------------------------------------------------

const MINUTE = 60_000;
/** Disable duration after the Nth consecutive failure; the last step repeats. */
export const BACKOFF_STEPS_MS: readonly number[] = [5, 15, 30, 60, 180, 360, 720, 1440].map((m) => m * MINUTE);
export const CAPS_TTL_MS = 24 * 60 * MINUTE;
/** Releases dated this far before the newest one seen still count as new if their guid is unseen. */
export const RSS_DATE_TOLERANCE_MS = 6 * 60 * MINUTE;
export const RSS_GUID_MEMORY = 1000;
const DAY = 24 * 60 * MINUTE;

export function backoffFor(failureCount: number): number {
  const idx = Math.min(Math.max(failureCount, 1), BACKOFF_STEPS_MS.length) - 1;
  return BACKOFF_STEPS_MS[idx] ?? BACKOFF_STEPS_MS[BACKOFF_STEPS_MS.length - 1]!;
}

type IndexerRow = typeof indexers.$inferSelect;
type StatusRow = typeof indexerStatus.$inferSelect;

// ---- service ------------------------------------------------------------------------

export class IndexersService {
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
  private manualResolver: ManualSearchResolver | undefined;

  constructor(opts: IndexersServiceOptions) {
    this.db = opts.db;
    this.log = opts.log;
    this.fetchImpl = opts.fetch;
    this.now = opts.now ?? Date.now;
    this.sleep = opts.sleep;
    this.indexerTimeoutMs = opts.indexerTimeoutMs ?? 60_000;
    this.requestTimeoutMs = opts.requestTimeoutMs ?? 30_000;
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
      .map((row) => toResource(row, statuses.get(row.id)));
  }

  get(id: number): Indexer {
    const row = this.requireRow(id);
    return toResource(row, this.statusRow(id));
  }

  create(input: IndexerCreate): Indexer {
    const data = parseOrThrow(IndexerCreate, input);
    const settings = validateSettings(data.settings);
    this.assertUniqueName(data.name);
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
        tags: data.tags,
        settings,
        addedAt: this.isoNow(),
      })
      .returning()
      .get();
    return toResource(row, undefined);
  }

  update(id: number, input: IndexerUpdate): Indexer {
    const current = this.requireRow(id);
    const patch = parseOrThrow(IndexerUpdate, input);
    const name = patch.name ?? current.name;
    if (name.toLowerCase() !== current.name.toLowerCase()) this.assertUniqueName(name, id);

    const mergedRaw = { ...current.settings, ...withoutUndefined(patch.settings ?? {}) };
    const settings = validateSettings(parseOrThrow(IndexerSettings, mergedRaw));
    const implementation = patch.implementation ?? current.implementation;

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
      settings.apiKey !== current.settings.apiKey;
    if (endpointChanged) {
      this.db.delete(indexerCapsCache).where(eq(indexerCapsCache.indexerId, id)).run();
      this.db.delete(indexerStatus).where(eq(indexerStatus.indexerId, id)).run();
    }
    this.limiters.delete(id);
    return toResource(row, this.statusRow(id));
  }

  delete(id: number): void {
    this.requireRow(id);
    this.db.delete(indexerCapsCache).where(eq(indexerCapsCache.indexerId, id)).run();
    this.db.delete(indexerStatus).where(eq(indexerStatus.indexerId, id)).run();
    this.db.delete(indexerRssState).where(eq(indexerRssState.indexerId, id)).run();
    this.db.delete(indexers).where(eq(indexers.id, id)).run();
    this.limiters.delete(id);
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
    const settings = validateSettings(data.settings);
    const result = await this.probe({ id: 0, name: data.name, implementation: data.implementation, settings }, signal);
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
    const results = await Promise.allSettled(
      rows.map((row) =>
        this.guarded(row, opts.signal, async (signal) => {
          const caps = await this.loadCaps(row, signal, false);
          const def = toDefinition(row, opts.categories);
          return protocolOf(row.implementation).search(def, request, toPackageCaps(caps), this.clientOptions(row, signal));
        }),
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
      request.seriesId !== undefined || request.episodeId !== undefined || request.movieId !== undefined;
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
            : 'nothing to search: pass query or tvdbId/tmdbId/imdbId',
        );
      }
    }
    return this.search(resolved, {
      mode: 'interactive',
      ...(request.indexerIds?.length ? { indexerIds: request.indexerIds } : {}),
      ...(request.categories?.length ? { categories: request.categories } : {}),
      ...(signal ? { signal } : {}),
    });
  }

  // ---- RSS --------------------------------------------------------------------------

  /** Fetch every RSS-enabled, available indexer and return releases not seen by previous syncs. */
  async rss(opts: { signal?: AbortSignal } = {}): Promise<ReleaseResource[]> {
    const rows = this.eligible('enableRss');
    const started = this.now();
    const results = await Promise.allSettled(
      rows.map((row) =>
        this.guarded(row, opts.signal, async (signal) => {
          const caps = await this.loadCaps(row, signal, false);
          const infos = await protocolOf(row.implementation).search(
            toDefinition(row),
            { kind: 'rss' },
            toPackageCaps(caps),
            this.clientOptions(row, signal),
          );
          return this.advanceRssMarker(row.id, infos);
        }),
      ),
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
    row: Pick<IndexerRow, 'id' | 'name' | 'implementation' | 'settings'>,
    signal: AbortSignal | undefined,
  ): Promise<
    { ok: true; caps: IndexerCapabilitiesResource; releaseCount: number } | { ok: false; error: IndexerError }
  > {
    try {
      return await withTimeout(this.indexerTimeoutMs, signal, row.name, async (s) => {
        const client = createIndexer(toDefinition(row), {
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
    const caps = await protocolOf(row.implementation).fetchCaps(toDefinition(row), this.clientOptions(row, signal));
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
    return { ...this.baseClientOptions(signal), beforeRequest: limiter.wait, indexerId: row.id };
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

function parseOrThrow<S extends z.ZodType>(schema: S, value: unknown): z.output<S> {
  const result = schema.safeParse(value);
  if (!result.success) {
    const message = result.error.issues.map((i) => `${i.path.map(String).join('.') || '(root)'}: ${i.message}`).join('; ');
    throw new IndexersError('VALIDATION', message, result.error.issues);
  }
  return result.data;
}

function withoutUndefined<T extends object>(obj: T): { [K in keyof T]?: Exclude<T[K], undefined> } {
  return Object.fromEntries(Object.entries(obj).filter(([, v]) => v !== undefined)) as {
    [K in keyof T]?: Exclude<T[K], undefined>;
  };
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
  if (categories.length + animeCategories.length === 0) {
    throw new IndexersError('VALIDATION', 'settings.categories: select at least one category');
  }
  const out: IndexerSettings = { baseUrl, apiPath, categories, animeCategories };
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
  return implementation === 'torznab' ? torznab : newznab;
}

function toDefinition(
  row: Pick<IndexerRow, 'name' | 'implementation' | 'settings'>,
  categoryOverride?: readonly number[],
): IndexerDefinition {
  const s = row.settings;
  const def: IndexerDefinition = {
    name: row.name,
    baseUrl: s.baseUrl,
    apiPath: s.apiPath,
    categories: categoryOverride ? [...categoryOverride] : s.categories,
    animeCategories: categoryOverride ? [] : s.animeCategories,
    protocol: protocolForImplementation(row.implementation),
  };
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
    },
    categories: caps.categories.map((c) => ({ id: c.id, name: c.name, subcats: c.subcats.map((s) => ({ ...s })) })),
  };
}

function toPackageCaps(caps: IndexerCapabilitiesResource): IndexerCapabilities {
  const known = new Set<string>(SEARCH_PARAMS);
  const mode = (m: IndexerCapabilitiesResource['searching']['search']) => ({
    available: m.available,
    supportedParams: m.supportedParams.filter((p): p is SearchParam => known.has(p)),
  });
  return {
    ...(caps.serverTitle !== undefined ? { serverTitle: caps.serverTitle } : {}),
    limits: caps.limits,
    searching: {
      search: mode(caps.searching.search),
      tvSearch: mode(caps.searching.tvSearch),
      movieSearch: mode(caps.searching.movieSearch),
    },
    categories: caps.categories,
  };
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

function toResource(row: IndexerRow, status: StatusRow | undefined): Indexer {
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
    settings: row.settings,
  };
  if (row.downloadClientId !== null) out.downloadClientId = row.downloadClientId;
  if (status && (status.failureCount > 0 || status.lastFailure)) {
    const { indexerId: _id, lastRssSyncAt: _rss, ...summary } = toStatus(row.id, status, undefined);
    out.status = summary;
  }
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
    rejections: [],
    approved: false,
  };
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

function toSearchRequest(req: ManualSearchRequest): SearchRequest | null {
  const tvHints = req.tvdbId !== undefined || req.season !== undefined || req.episode !== undefined || req.airDate !== undefined;
  const movieHints = req.tmdbId !== undefined || req.imdbId !== undefined || req.year !== undefined;
  const type = req.type ?? (tvHints ? 'tv' : movieHints ? 'movie' : req.query ? 'search' : undefined);
  switch (type) {
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
