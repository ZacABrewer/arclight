import { randomUUID } from 'node:crypto';
import { resolve as resolvePath } from 'node:path';
import { and, asc, eq, inArray, ne } from 'drizzle-orm';
import { createTmdbClient, type TmdbClient, type TmdbClientOptions } from '@arclight/metadata';
import {
  IMPORT_LIST_SECRET_FIELDS,
  importListSettingsSchemas,
  SECRET_MASK,
  type ImportList,
  type ImportListCreate,
  type ImportListExclusion,
  type ImportListExclusionCreate,
  type ImportListFoundItem,
  type ImportListImplementation,
  type ImportListItem,
  type ImportListItemsQuery,
  type ImportListMediaType,
  type ImportListPreviewItem,
  type ImportListPreviewOutcome,
  type ImportListPreviewResult,
  type ImportListSchema,
  type ImportListSettings,
  type ImportListSyncResult,
  type ImportListTestRequest,
  type ImportListTestResult,
  type TraktDeviceResponse,
  type TraktPollRequest,
  type TraktPollResponse,
  type SimklPinResponse,
  type SimklPollRequest,
  type SimklPollResponse,
  type ImportListFilters,
  type ImportListStreamingRule,
} from '@arclight/shared';
import type { Logger } from 'pino';
import type { Db } from '../../db/index.js';
import { importExclusions, movies, qualityProfiles, rootFolders, series } from '../../db/schema.js';
import type { EventBus } from '../../events.js';
import { libraryService, type MetadataLookup } from '../library/index.js';
import { settingsService } from '../settings/index.js';
import { ImportListFetchError, ImportListsError } from './errors.js';
import {
  createDatasetCache,
  createTmdbAccess,
  providers,
  simklPin,
  simklPollPin,
  traktDeviceCode,
  traktPollToken,
  withTmdbErrors,
  type FetchedItem,
  type FetchLike,
  type Provider,
  type ProviderContext,
  type CachedId,
  type DatasetCache,
  type IdCache,
  type TmdbAccess,
} from './providers/index.js';
import { mapLimit } from './providers/http.js';
import { importListAdditions, importListIdCache, importListItems, importLists } from './schema.js';
import { importListSchemas, supportedMediaTypes } from './templates.js';

type Row = typeof importLists.$inferSelect;
type Settings = Record<string, unknown>;
type Kind = 'series' | 'movie';

/** A fetched item with its TMDB id resolved. */
export interface ResolvedItem {
  mediaType: Kind;
  tmdbId: number;
  imdbId: string | null;
  title: string;
  year: number | null;
  /** TMDB vote average/count when the source carried them. */
  rating?: number | null;
  votes?: number | null;
}

export type SearchTrigger = (target: { seriesId: number } | { movieId: number }) => Promise<unknown>;

export interface ImportListsServiceOptions {
  db: Db;
  log: Logger;
  /** Metadata for adds (the metadata module's lookup in production). */
  metadata: MetadataLookup;
  bus?: EventBus;
  /** Search for a newly added title ("search on add"). */
  search?: SearchTrigger;
  fetch?: FetchLike;
  env?: NodeJS.ProcessEnv;
  now?: () => Date;
  createTmdbClient?: (options: TmdbClientOptions) => TmdbClient;
  /** Directory for downloaded datasets (anime id mapping, IMDb ratings); null/omitted = memory only. */
  cacheDir?: string | null;
}

/** Token-bearing settings fields the server manages; kept when a client omits them. */
const KEPT_FIELDS: readonly string[] = [...IMPORT_LIST_SECRET_FIELDS, 'tokenExpiresAt'];
/** Pending Trakt authorizations (for lists not saved yet) live this long. */
const PENDING_AUTH_TTL_MS = 30 * 60 * 1000;
/** A list counts as due slightly early so an hourly tick does not drift past the interval. */
const DUE_SLACK_MS = 2 * 60 * 1000;
const TEST_PREVIEW_COUNT = 10;
/** Preview responses list at most this many items. */
const PREVIEW_MAX_ITEMS = 500;
/** Parallel TMDB lookups when filters or the streaming rule need data the list did not carry. */
const LOOKUP_CONCURRENCY = 6;
/** A cached "no TMDB match" is retried after this long. */
const ID_MISS_TTL_MS = 7 * 24 * 3_600_000;

/** OAuth/PIN results for lists not saved yet, keyed by the authRef handed to the client. */
interface PendingAuth {
  provider: 'trakt' | 'simkl';
  clientId: string;
  clientSecret?: string;
  /** Settings fields filled in on create (tokens). */
  tokens: Record<string, string>;
  expiresAt: number;
}

/** Filter/streaming configuration of one list. */
interface ListRules {
  mediaType: ImportListMediaType;
  filters: ImportListFilters;
  streaming: ImportListStreamingRule;
}

type Outcome = ImportListPreviewOutcome;

export class ImportListsService {
  private readonly db: Db;
  private readonly log: Logger;
  private readonly metadata: MetadataLookup;
  private readonly bus: EventBus | undefined;
  private readonly search: SearchTrigger | undefined;
  private readonly fetch: FetchLike;
  private readonly env: NodeJS.ProcessEnv;
  private readonly now: () => Date;
  private readonly createClient: (options: TmdbClientOptions) => TmdbClient;
  private readonly pendingAuth = new Map<string, PendingAuth>();
  private tmdbCache: { fingerprint: string; access: TmdbAccess } | null = null;
  private readonly datasets: DatasetCache;
  private readonly ids: IdCache;

  constructor(opts: ImportListsServiceOptions) {
    this.db = opts.db;
    this.log = opts.log;
    this.metadata = opts.metadata;
    this.bus = opts.bus;
    this.search = opts.search;
    this.fetch = opts.fetch ?? ((input, init) => globalThis.fetch(input, init));
    this.env = opts.env ?? process.env;
    this.now = opts.now ?? (() => new Date());
    this.createClient = opts.createTmdbClient ?? createTmdbClient;
    this.datasets = createDatasetCache({ fetch: this.fetch, log: this.log, now: this.now, dir: opts.cacheDir ?? null });
    this.ids = this.idCache();
  }

  // ---- CRUD -----------------------------------------------------------------------------

  list(): ImportList[] {
    return this.db.select().from(importLists).orderBy(asc(importLists.name)).all().map(toResource);
  }

  get(id: number): ImportList {
    return toResource(this.row(id));
  }

  schemas(): ImportListSchema[] {
    return importListSchemas();
  }

  create(input: ImportListCreate): ImportList {
    const settings = this.prepareSettings(input, null, { consumeAuthRef: true });
    this.validateDefaults(input);
    this.assertNameFree(input.name);
    const row = this.db
      .insert(importLists)
      .values({ ...columnsFrom(input, null), settings, addedAt: this.now().toISOString() })
      .returning()
      .get();
    return toResource(row);
  }

  update(id: number, input: ImportListCreate): ImportList {
    const current = this.row(id);
    const settings = this.prepareSettings(input, current, { consumeAuthRef: true });
    this.validateDefaults(input);
    this.assertNameFree(input.name, id);
    const row = this.db
      .update(importLists)
      .set({ ...columnsFrom(input, current), settings })
      .where(eq(importLists.id, id))
      .returning()
      .get();
    if (!row) throw ImportListsError.notFound('import list', id);
    return toResource(row);
  }

  delete(id: number): void {
    const row = this.db.delete(importLists).where(eq(importLists.id, id)).returning().get();
    if (!row) throw ImportListsError.notFound('import list', id);
  }

  // ---- items ----------------------------------------------------------------------------

  /** Items the list returned on its last fetch, flagged against the library and exclusions. */
  items(id: number): ImportListItem[] {
    this.row(id);
    const rows = this.db
      .select()
      .from(importListItems)
      .where(eq(importListItems.importListId, id))
      .orderBy(asc(importListItems.title))
      .all();
    const flags = this.flagger();
    return rows.map((r) => ({
      importListId: r.importListId,
      mediaType: r.mediaType,
      tmdbId: r.tmdbId,
      imdbId: r.imdbId,
      title: r.title,
      year: r.year,
      ...flags(r.mediaType, r.tmdbId),
    }));
  }

  /** Every list a title was found in, for "found in list" chips. */
  foundIn(query: ImportListItemsQuery): ImportListFoundItem[] {
    const where = [];
    if (query.mediaType) where.push(eq(importListItems.mediaType, query.mediaType));
    if (query.tmdbId !== undefined) where.push(eq(importListItems.tmdbId, query.tmdbId));
    const rows = this.db
      .select({ item: importListItems, name: importLists.name })
      .from(importListItems)
      .innerJoin(importLists, eq(importLists.id, importListItems.importListId))
      .where(where.length ? and(...where) : undefined)
      .orderBy(asc(importListItems.title))
      .all();
    const flags = this.flagger();
    return rows.map(({ item, name }) => ({
      importListId: item.importListId,
      importListName: name,
      mediaType: item.mediaType,
      tmdbId: item.tmdbId,
      imdbId: item.imdbId,
      title: item.title,
      year: item.year,
      ...flags(item.mediaType, item.tmdbId),
    }));
  }

  // ---- test -----------------------------------------------------------------------------

  async test(req: ImportListTestRequest): Promise<ImportListTestResult> {
    const current = req.id !== undefined ? this.row(req.id) : null;
    const settings = this.prepareSettings(req, current, { consumeAuthRef: false });
    try {
      const { items } = await this.fetchItems(req.implementation, settings, req.mediaType, (patch) => {
        if (current) this.saveSettings(current.id, patch);
      });
      const flags = this.flagger();
      return {
        ok: true,
        itemCount: items.length,
        items: items.slice(0, TEST_PREVIEW_COUNT).map((i) => ({ ...i, ...flags(i.mediaType, i.tmdbId) })),
      };
    } catch (err) {
      if (err instanceof ImportListFetchError) return { ok: false, error: { code: err.code, message: err.message } };
      throw err;
    }
  }

  // ---- preview --------------------------------------------------------------------------

  /**
   * What a list would do right now: fetch it with the submitted settings (nothing is stored)
   * and run every item through the library, exclusion, filter and streaming checks a sync uses.
   */
  async preview(req: ImportListTestRequest): Promise<ImportListPreviewResult> {
    const current = req.id !== undefined ? this.row(req.id) : null;
    const settings = this.prepareSettings(req, current, { consumeAuthRef: false });
    let fetched: { items: ResolvedItem[]; unresolved: number };
    try {
      fetched = await this.fetchItems(req.implementation, settings, req.mediaType, (patch) => {
        if (current) this.saveSettings(current.id, patch);
      });
    } catch (err) {
      if (err instanceof ImportListFetchError) return { ok: false, error: { code: err.code, message: err.message } };
      throw err;
    }
    const rules: ListRules = {
      mediaType: req.mediaType,
      filters: req.filters ?? current?.filters ?? {},
      streaming: req.streaming ?? current?.streaming ?? { enabled: false, providerIds: [] },
    };
    const flags = this.flagger();
    const evaluated = await mapLimit(fetched.items, LOOKUP_CONCURRENCY, async (item) => {
      const f = flags(item.mediaType, item.tmdbId);
      if (f.inLibrary) return { item, f, outcome: 'inLibrary' as Outcome };
      if (f.excluded) return { item, f, outcome: 'excluded' as Outcome };
      const verdict = await this.evaluate(item, rules);
      return { item, f, outcome: verdict.outcome, streamingOn: verdict.streamingOn };
    });
    const counts: Partial<Record<Outcome, number>> = {};
    for (const e of evaluated) counts[e.outcome] = (counts[e.outcome] ?? 0) + 1;
    const order = (o: Outcome) => (o === 'add' ? 0 : 1);
    const items: ImportListPreviewItem[] = evaluated
      .slice()
      .sort((a, b) => order(a.outcome) - order(b.outcome))
      .slice(0, PREVIEW_MAX_ITEMS)
      .map((e) => ({
        mediaType: e.item.mediaType,
        tmdbId: e.item.tmdbId,
        imdbId: e.item.imdbId,
        title: e.item.title,
        year: e.item.year,
        ...e.f,
        outcome: e.outcome,
        ...(e.streamingOn?.length ? { streamingOn: e.streamingOn } : {}),
      }));
    return {
      ok: true,
      itemCount: fetched.items.length,
      wouldAdd: counts.add ?? 0,
      counts,
      items,
      unresolved: fetched.unresolved,
    };
  }

  /**
   * The list's own rules for one title not yet in the library: year, rating and vote filters
   * (from the list's data, else from TMDB), then "skip if streaming on my services".
   */
  private async evaluate(item: ResolvedItem, rules: ListRules): Promise<{ outcome: Outcome; streamingOn?: string[] }> {
    const { minRating, minVotes, yearFrom, yearTo } = rules.filters;
    const needsRating = (minRating !== undefined && item.rating == null) || (minVotes !== undefined && item.votes == null);
    const needsYear = (yearFrom !== undefined || yearTo !== undefined) && item.year == null;
    let { rating, votes, year } = { rating: item.rating ?? null, votes: item.votes ?? null, year: item.year };
    if (needsRating || needsYear) {
      const looked = await this.lookupRating(item);
      rating ??= looked.rating;
      votes ??= looked.votes;
      year ??= looked.year;
    }
    if (yearFrom !== undefined && (year === null || year < yearFrom)) return { outcome: 'year' };
    if (yearTo !== undefined && (year === null || year > yearTo)) return { outcome: 'year' };
    if (minRating !== undefined && (rating === null || rating < minRating)) return { outcome: 'rating' };
    if (minVotes !== undefined && (votes === null || votes < minVotes)) return { outcome: 'votes' };
    if (rules.streaming.enabled && rules.streaming.providerIds.length) {
      const on = await this.streamingOn(item, rules.streaming);
      if (on.length) return { outcome: 'streaming', streamingOn: on };
    }
    return { outcome: 'add' };
  }

  private async lookupRating(item: ResolvedItem): Promise<{ rating: number | null; votes: number | null; year: number | null }> {
    try {
      const { client } = this.tmdb();
      const meta = await withTmdbErrors<{ ratings: { tmdb: { value: number; votes: number } }; year?: number }>(() =>
        item.mediaType === 'series' ? client.getSeries(item.tmdbId) : client.getMovie(item.tmdbId),
      );
      const r = meta.ratings.tmdb;
      return { rating: r.votes > 0 ? r.value : null, votes: r.votes, year: meta.year ?? null };
    } catch (err) {
      this.log.debug({ err, tmdbId: item.tmdbId }, 'import list filter lookup failed');
      return { rating: null, votes: null, year: null };
    }
  }

  /** Names of the chosen subscription services the title is included with (flatrate) in the region. */
  private async streamingOn(item: ResolvedItem, rule: ImportListStreamingRule): Promise<string[]> {
    try {
      const { client } = this.tmdb();
      const region = rule.region ?? settingsService.getSection(this.db, 'metadata').region;
      const kind = item.mediaType === 'series' ? 'tv' : 'movie';
      const providersFor = await withTmdbErrors(() => client.getTitleWatchProviders(kind, item.tmdbId, region));
      const wanted = new Set(rule.providerIds);
      return providersFor.flatrate.filter((p) => wanted.has(p.tmdbId)).map((p) => p.name);
    } catch (err) {
      // Unknown availability never blocks an add.
      this.log.debug({ err, tmdbId: item.tmdbId }, 'import list streaming lookup failed');
      return [];
    }
  }

  // ---- fetch & sync ---------------------------------------------------------------------

  /** Fetch one list and store its items. Failures are recorded on the list and rethrown. */
  async fetchList(id: number, signal?: AbortSignal): Promise<ResolvedItem[]> {
    const row = this.row(id);
    const fetchedAt = this.now().toISOString();
    try {
      const { items } = await this.fetchItems(
        row.implementation,
        row.settings,
        row.mediaType,
        (patch) => this.saveSettings(row.id, patch),
        signal,
      );
      this.db.transaction((tx) => {
        tx.delete(importListItems).where(eq(importListItems.importListId, row.id)).run();
        for (const item of items) {
          tx.insert(importListItems)
            .values({ importListId: row.id, ...item, fetchedAt })
            .onConflictDoNothing()
            .run();
        }
        tx.update(importLists).set({ lastSyncAt: fetchedAt, lastSyncError: null }).where(eq(importLists.id, row.id)).run();
      });
      return items;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.db.update(importLists).set({ lastSyncAt: fetchedAt, lastSyncError: message }).where(eq(importLists.id, row.id)).run();
      throw err;
    }
  }

  /**
   * Fetch enabled lists (all of them when `force`, otherwise those due per the sync interval),
   * add new titles with each list's defaults, then run "clean library" when configured.
   * A title on several lists is added once, with the defaults of the first list (by name).
   */
  async sync(opts: { force?: boolean; signal?: AbortSignal } = {}): Promise<ImportListSyncResult> {
    const settings = this.getSettings();
    const nowMs = this.now().getTime();
    // A list's own interval overrides the global one.
    const intervalMs = (r: Row) => (r.syncIntervalHours ?? settings.syncIntervalHours) * 3_600_000;
    const rows = this.db
      .select()
      .from(importLists)
      .where(eq(importLists.enabled, true))
      .orderBy(asc(importLists.name))
      .all()
      .filter((r) => opts.force || !r.lastSyncAt || nowMs - Date.parse(r.lastSyncAt) >= intervalMs(r) - DUE_SLACK_MS);

    const result: ImportListSyncResult = {
      lists: rows.length,
      fetched: 0,
      added: 0,
      skippedExisting: 0,
      skippedExcluded: 0,
      failed: 0,
      cleaned: 0,
      skippedFiltered: 0,
      errors: [],
    };
    const seen = new Set<string>();
    const toSearch: Array<{ seriesId: number } | { movieId: number }> = [];
    let anyFetched = false;
    // Clean-up runs once every due list has fetched, so "still on another list" sees fresh items.
    const cleanups: Array<{ row: Row; previous: Set<string>; items: ResolvedItem[] }> = [];

    for (const row of rows) {
      if (opts.signal?.aborted) break;
      let items: ResolvedItem[];
      const previous = this.storedItemKeys(row.id);
      try {
        items = await this.fetchList(row.id, opts.signal);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        this.log.warn({ err, importListId: row.id, name: row.name }, 'import list fetch failed');
        result.errors.push({ importListId: row.id, name: row.name, message });
        continue;
      }
      anyFetched = true;
      result.fetched += items.length;
      cleanups.push({ row, previous, items });
      if (!row.enableAutomaticAdd) continue;

      for (const item of items) {
        const key = `${item.mediaType}:${item.tmdbId}`;
        if (seen.has(key)) continue;
        if (this.inLibrary(item.mediaType, item.tmdbId)) {
          seen.add(key);
          result.skippedExisting++;
          continue;
        }
        if (libraryService.isExcluded(this.db, item.mediaType, item.tmdbId)) {
          seen.add(key);
          result.skippedExcluded++;
          continue;
        }
        // Filtered titles stay unseen: another list with looser rules may still add them.
        const verdict = await this.evaluate(item, row);
        if (verdict.outcome !== 'add') {
          result.skippedFiltered++;
          this.log.debug({ importList: row.name, tmdbId: item.tmdbId, title: item.title, reason: verdict.outcome }, 'import list item filtered');
          continue;
        }
        seen.add(key);
        try {
          const id = await this.add(row, item);
          if (id === null) {
            result.failed++;
            continue;
          }
          this.recordAddition(row.id, item);
          result.added++;
          if (row.searchOnAdd) toSearch.push(item.mediaType === 'series' ? { seriesId: id } : { movieId: id });
        } catch (err) {
          result.failed++;
          this.log.warn({ err, importListId: row.id, tmdbId: item.tmdbId, title: item.title }, 'import list add failed');
        }
      }
    }

    for (const c of cleanups) result.cleaned += await this.cleanUpList(c.row, c.previous, c.items);

    if (toSearch.length && this.search) {
      const search = this.search;
      // Detached: indexer searches must not hold up the sync job.
      void (async () => {
        for (const target of toSearch) {
          await search(target).catch((err: unknown) => this.log.warn({ err, target }, 'search on add failed'));
        }
      })();
    }

    if (anyFetched) result.cleaned += await this.cleanLibrary();
    return result;
  }

  private storedItemKeys(listId: number): Set<string> {
    return new Set(
      this.db
        .select({ mediaType: importListItems.mediaType, tmdbId: importListItems.tmdbId })
        .from(importListItems)
        .where(eq(importListItems.importListId, listId))
        .all()
        .map((r) => `${r.mediaType}:${r.tmdbId}`),
    );
  }

  private recordAddition(listId: number, item: ResolvedItem): void {
    this.db
      .insert(importListAdditions)
      .values({ importListId: listId, mediaType: item.mediaType, tmdbId: item.tmdbId, addedAt: this.now().toISOString() })
      .onConflictDoNothing()
      .run();
  }

  /**
   * Per-list clean-up: titles this list added that dropped off it since the last fetch (and are
   * on no other enabled list) are unmonitored or removed per the list's `cleanupAction`. A fetch
   * that suddenly returns nothing is treated as a source problem, not an emptied list.
   */
  private async cleanUpList(row: Row, previous: Set<string>, items: ResolvedItem[]): Promise<number> {
    if (row.cleanupAction === 'none' || previous.size === 0) return 0;
    if (items.length === 0) {
      this.log.warn({ importList: row.name }, 'list clean-up skipped: the list came back empty');
      return 0;
    }
    const current = new Set(items.map((i) => `${i.mediaType}:${i.tmdbId}`));
    const dropped = [...previous].filter((k) => !current.has(k));
    if (!dropped.length) return 0;
    const additions = this.db.select().from(importListAdditions).where(eq(importListAdditions.importListId, row.id)).all();
    const added = new Map(additions.map((a) => [`${a.mediaType}:${a.tmdbId}`, a]));
    const elsewhere = new Set(
      this.db
        .select({ mediaType: importListItems.mediaType, tmdbId: importListItems.tmdbId })
        .from(importListItems)
        .innerJoin(importLists, eq(importLists.id, importListItems.importListId))
        .where(and(eq(importLists.enabled, true), ne(importListItems.importListId, row.id)))
        .all()
        .map((r) => `${r.mediaType}:${r.tmdbId}`),
    );
    let cleaned = 0;
    for (const key of dropped) {
      const addition = added.get(key);
      if (!addition || elsewhere.has(key)) continue;
      const kind = addition.mediaType;
      const target =
        kind === 'series'
          ? this.db.select({ id: series.id, title: series.title, monitored: series.monitored }).from(series).where(eq(series.tmdbId, addition.tmdbId)).get()
          : this.db.select({ id: movies.id, title: movies.title, monitored: movies.monitored }).from(movies).where(eq(movies.tmdbId, addition.tmdbId)).get();
      try {
        if (target) {
          if (row.cleanupAction === 'unmonitor') {
            if (target.monitored) {
              if (kind === 'series') libraryService.updateSeries(this.db, target.id, { monitored: false });
              else libraryService.updateMovie(this.db, target.id, { monitored: false });
              this.bus?.publish({ type: 'library', action: 'updated', mediaType: kind, id: target.id });
              cleaned++;
            }
          } else {
            const opts = { deleteFiles: row.cleanupAction === 'removeAndDeleteFiles', addExclusion: false };
            if (kind === 'series') await libraryService.deleteSeries(this.db, target.id, opts);
            else await libraryService.deleteMovie(this.db, target.id, opts);
            this.bus?.publish({ type: 'library', action: 'deleted', mediaType: kind, id: target.id });
            cleaned++;
          }
          this.log.info({ importList: row.name, mediaType: kind, id: target.id, title: target.title, action: row.cleanupAction }, 'list clean-up: dropped off the list');
        }
        // Handled (or already gone from the library): this list no longer owns the title.
        this.db.delete(importListAdditions).where(eq(importListAdditions.id, addition.id)).run();
      } catch (err) {
        this.log.warn({ err, importList: row.name, mediaType: kind, tmdbId: addition.tmdbId }, 'list clean-up action failed');
      }
    }
    return cleaned;
  }

  /**
   * Unmonitor or remove library items that are on no enabled list. Skipped unless every enabled
   * list has a successful last fetch (a failed fetch must not look like an emptied list), and
   * restricted to the media types the enabled lists cover and to `cleanLibraryTags` when set.
   */
  async cleanLibrary(): Promise<number> {
    const { cleanLibraryLevel: level, cleanLibraryTags: tags } = this.getSettings();
    if (level === 'disabled') return 0;
    const enabled = this.db.select().from(importLists).where(eq(importLists.enabled, true)).all();
    if (enabled.length === 0) return 0;
    const stale = enabled.filter((r) => !r.lastSyncAt || r.lastSyncError);
    if (stale.length) {
      this.log.info({ lists: stale.map((r) => r.name) }, 'clean library skipped: not every enabled list fetched successfully');
      return 0;
    }
    const covers = (kind: Kind) => enabled.some((r) => r.mediaType === 'both' || r.mediaType === kind);
    const wanted = new Set(
      this.db
        .select({ mediaType: importListItems.mediaType, tmdbId: importListItems.tmdbId })
        .from(importListItems)
        .where(
          inArray(
            importListItems.importListId,
            enabled.map((r) => r.id),
          ),
        )
        .all()
        .map((r) => `${r.mediaType}:${r.tmdbId}`),
    );
    const tagFilter = new Set(tags);
    const eligible = (r: { tmdbId: number; tags: number[] }, kind: Kind) =>
      !wanted.has(`${kind}:${r.tmdbId}`) && (tagFilter.size === 0 || r.tags.some((t) => tagFilter.has(t)));

    const candidates: Array<{ kind: Kind; id: number; title: string; monitored: boolean }> = [];
    if (covers('series')) {
      for (const r of this.db.select().from(series).all()) {
        if (eligible(r, 'series')) candidates.push({ kind: 'series', id: r.id, title: r.title, monitored: r.monitored });
      }
    }
    if (covers('movie')) {
      for (const r of this.db.select().from(movies).all()) {
        if (eligible(r, 'movie')) candidates.push({ kind: 'movie', id: r.id, title: r.title, monitored: r.monitored });
      }
    }

    let cleaned = 0;
    for (const c of candidates) {
      try {
        switch (level) {
          case 'logOnly':
            this.log.info({ mediaType: c.kind, id: c.id, title: c.title }, 'clean library: no longer on any import list');
            break;
          case 'unmonitor':
            if (!c.monitored) break;
            if (c.kind === 'series') libraryService.updateSeries(this.db, c.id, { monitored: false });
            else libraryService.updateMovie(this.db, c.id, { monitored: false });
            this.bus?.publish({ type: 'library', action: 'updated', mediaType: c.kind, id: c.id });
            cleaned++;
            break;
          case 'remove':
          case 'removeAndDeleteFiles': {
            const opts = { deleteFiles: level === 'removeAndDeleteFiles', addExclusion: false };
            if (c.kind === 'series') await libraryService.deleteSeries(this.db, c.id, opts);
            else await libraryService.deleteMovie(this.db, c.id, opts);
            this.bus?.publish({ type: 'library', action: 'deleted', mediaType: c.kind, id: c.id });
            this.log.info({ mediaType: c.kind, id: c.id, title: c.title }, 'clean library: removed');
            cleaned++;
            break;
          }
        }
      } catch (err) {
        this.log.warn({ err, mediaType: c.kind, id: c.id }, 'clean library action failed');
      }
    }
    return cleaned;
  }

  // ---- trakt device flow ----------------------------------------------------------------

  async traktDevice(clientId: string): Promise<TraktDeviceResponse> {
    return traktDeviceCode(this.fetch, clientId);
  }

  async traktPoll(req: TraktPollRequest): Promise<TraktPollResponse> {
    const row = req.importListId !== undefined ? this.row(req.importListId) : null;
    if (row && !isTrakt(row.implementation)) {
      throw new ImportListsError('VALIDATION', `import list ${row.id} is not a Trakt list`);
    }
    let clientSecret = req.clientSecret;
    if ((clientSecret === undefined || clientSecret === SECRET_MASK) && row) {
      clientSecret = typeof row.settings['clientSecret'] === 'string' ? row.settings['clientSecret'] : undefined;
    }
    if (!clientSecret || clientSecret === SECRET_MASK) {
      throw new ImportListsError('VALIDATION', 'a Trakt client secret is required to authenticate');
    }
    const outcome = await traktPollToken(this.fetch, { deviceCode: req.deviceCode, clientId: req.clientId, clientSecret }, this.now());
    if (outcome.status !== 'authorized') return { status: outcome.status };
    if (row) {
      const settings = { ...row.settings, clientId: req.clientId, clientSecret, ...outcome.tokens };
      const updated = this.db.update(importLists).set({ settings }).where(eq(importLists.id, row.id)).returning().get();
      return { status: 'authorized', importList: toResource(updated ?? row) };
    }
    this.prunePendingAuth();
    const authRef = randomUUID();
    this.pendingAuth.set(authRef, {
      provider: 'trakt',
      clientId: req.clientId,
      clientSecret,
      tokens: { ...outcome.tokens },
      expiresAt: this.now().getTime() + PENDING_AUTH_TTL_MS,
    });
    return { status: 'authorized', authRef };
  }

  // ---- simkl PIN flow -------------------------------------------------------------------

  async simklPin(clientId: string): Promise<SimklPinResponse> {
    return simklPin(this.fetch, clientId);
  }

  async simklPoll(req: SimklPollRequest): Promise<SimklPollResponse> {
    const row = req.importListId !== undefined ? this.row(req.importListId) : null;
    if (row && row.implementation !== 'simkl') {
      throw new ImportListsError('VALIDATION', `import list ${row.id} is not a Simkl list`);
    }
    const outcome = await simklPollPin(this.fetch, req.clientId, req.userCode);
    if (outcome.status !== 'authorized') return { status: outcome.status };
    if (row) {
      const settings = { ...row.settings, clientId: req.clientId, accessToken: outcome.accessToken };
      const updated = this.db.update(importLists).set({ settings }).where(eq(importLists.id, row.id)).returning().get();
      return { status: 'authorized', importList: toResource(updated ?? row) };
    }
    this.prunePendingAuth();
    const authRef = randomUUID();
    this.pendingAuth.set(authRef, {
      provider: 'simkl',
      clientId: req.clientId,
      tokens: { accessToken: outcome.accessToken },
      expiresAt: this.now().getTime() + PENDING_AUTH_TTL_MS,
    });
    return { status: 'authorized', authRef };
  }

  // ---- exclusions -----------------------------------------------------------------------

  listExclusions(): ImportListExclusion[] {
    return this.db.select().from(importExclusions).orderBy(asc(importExclusions.title)).all();
  }

  getExclusion(id: number): ImportListExclusion {
    const row = this.db.select().from(importExclusions).where(eq(importExclusions.id, id)).get();
    if (!row) throw ImportListsError.notFound('import list exclusion', id);
    return row;
  }

  createExclusion(input: ImportListExclusionCreate): ImportListExclusion {
    this.assertExclusionFree(input);
    return this.db
      .insert(importExclusions)
      .values({ mediaType: input.mediaType, tmdbId: input.tmdbId, title: input.title, year: input.year ?? null })
      .returning()
      .get();
  }

  updateExclusion(id: number, input: ImportListExclusionCreate): ImportListExclusion {
    this.getExclusion(id);
    this.assertExclusionFree(input, id);
    const row = this.db
      .update(importExclusions)
      .set({ mediaType: input.mediaType, tmdbId: input.tmdbId, title: input.title, year: input.year ?? null })
      .where(eq(importExclusions.id, id))
      .returning()
      .get();
    if (!row) throw ImportListsError.notFound('import list exclusion', id);
    return row;
  }

  deleteExclusion(id: number): void {
    const row = this.db.delete(importExclusions).where(eq(importExclusions.id, id)).returning().get();
    if (!row) throw ImportListsError.notFound('import list exclusion', id);
  }

  // ---- settings section -----------------------------------------------------------------

  getSettings(): ImportListSettings {
    return settingsService.getSection(this.db, 'importLists');
  }

  updateSettings(value: ImportListSettings): ImportListSettings {
    try {
      return settingsService.setSection(this.db, 'importLists', value);
    } catch (err) {
      if (err instanceof settingsService.SettingsError) throw new ImportListsError('VALIDATION', err.message);
      throw err;
    }
  }

  // ---- internals ------------------------------------------------------------------------

  private row(id: number): Row {
    const row = this.db.select().from(importLists).where(eq(importLists.id, id)).get();
    if (!row) throw ImportListsError.notFound('import list', id);
    return row;
  }

  private assertNameFree(name: string, exceptId?: number): void {
    const clash = this.db.select({ id: importLists.id }).from(importLists).where(eq(importLists.name, name)).get();
    if (clash && clash.id !== exceptId) throw new ImportListsError('CONFLICT', `an import list named "${name}" already exists`);
  }

  private assertExclusionFree(input: ImportListExclusionCreate, exceptId?: number): void {
    const clash = this.db
      .select({ id: importExclusions.id })
      .from(importExclusions)
      .where(and(eq(importExclusions.mediaType, input.mediaType), eq(importExclusions.tmdbId, input.tmdbId)))
      .get();
    if (clash && clash.id !== exceptId) {
      throw new ImportListsError('CONFLICT', `${input.mediaType} ${input.tmdbId} is already excluded`);
    }
  }

  /** Root folders must be registered for the right media type; the quality profile must exist. */
  private validateDefaults(input: ImportListCreate): void {
    if (!supportedMediaTypes(input.implementation).includes(input.mediaType)) {
      throw new ImportListsError('VALIDATION', `${input.implementation} lists cannot provide media type ${input.mediaType}`);
    }
    const requireRoot = (path: string, kind: Kind) => {
      const ok = this.db
        .select({ path: rootFolders.path })
        .from(rootFolders)
        .where(eq(rootFolders.mediaType, kind))
        .all()
        .some((r) => resolvePath(r.path) === resolvePath(path));
      if (!ok) throw new ImportListsError('VALIDATION', `${path} is not a registered ${kind} root folder`);
    };
    if (input.mediaType === 'both') {
      requireRoot(input.rootFolderPath, 'series');
      if (!input.movieRootFolderPath) {
        throw new ImportListsError('VALIDATION', 'movieRootFolderPath is required when mediaType is both');
      }
      requireRoot(input.movieRootFolderPath, 'movie');
    } else {
      requireRoot(input.rootFolderPath, input.mediaType);
    }
    const profile = this.db
      .select({ id: qualityProfiles.id })
      .from(qualityProfiles)
      .where(eq(qualityProfiles.id, input.qualityProfileId))
      .get();
    if (!profile) throw new ImportListsError('VALIDATION', `quality profile ${input.qualityProfileId} does not exist`);
  }

  /**
   * Merge submitted settings with the stored ones (the mask or an omitted token keeps the stored
   * value; null or '' clears it), resolve a pending Trakt `authRef`, then validate.
   */
  private prepareSettings(
    input: Pick<ImportListCreate, 'implementation' | 'settings'>,
    current: Row | null,
    opts: { consumeAuthRef: boolean },
  ): Settings {
    const merged: Settings = { ...input.settings };
    const stored = current && current.implementation === input.implementation ? current.settings : {};
    for (const key of KEPT_FIELDS) {
      const v = merged[key];
      if (v === SECRET_MASK || (v === undefined && stored[key] !== undefined)) {
        if (stored[key] !== undefined) merged[key] = stored[key];
        else delete merged[key];
      }
    }
    for (const [k, v] of Object.entries(merged)) if (v === null || v === '') delete merged[k];

    const ref = merged['authRef'];
    delete merged['authRef'];
    if (typeof ref === 'string') {
      this.prunePendingAuth();
      const pending = this.pendingAuth.get(ref);
      if (!pending) throw new ImportListsError('VALIDATION', 'the authorization expired; authenticate again');
      if (opts.consumeAuthRef) this.pendingAuth.delete(ref);
      merged['clientId'] ??= pending.clientId;
      if (pending.clientSecret !== undefined) merged['clientSecret'] ??= pending.clientSecret;
      Object.assign(merged, pending.tokens);
    }

    const parsed = importListSettingsSchemas[input.implementation].safeParse(merged);
    if (!parsed.success) {
      const issue = parsed.error.issues[0];
      const where = issue?.path.length ? `settings.${issue.path.join('.')}: ` : 'settings: ';
      throw new ImportListsError('VALIDATION', `${where}${issue?.message ?? 'invalid'}`);
    }
    return parsed.data as Settings;
  }

  private saveSettings(id: number, patch: Settings): void {
    const row = this.db.select({ settings: importLists.settings }).from(importLists).where(eq(importLists.id, id)).get();
    if (!row) return;
    this.db.update(importLists).set({ settings: { ...row.settings, ...patch } }).where(eq(importLists.id, id)).run();
  }

  private prunePendingAuth(): void {
    const now = this.now().getTime();
    for (const [ref, p] of this.pendingAuth) if (p.expiresAt <= now) this.pendingAuth.delete(ref);
  }

  private tmdb(): TmdbAccess {
    const stored = settingsService.getSection(this.db, 'metadata');
    const apiKey = stored.tmdbApiKey ?? this.env['ARCLIGHT_TMDB_API_KEY']?.trim();
    if (!apiKey) {
      this.tmdbCache = null;
      throw new ImportListFetchError('not-configured', 'TMDB API key is not configured; set it in Settings > Metadata');
    }
    const fingerprint = [apiKey, stored.language, stored.region].join('|');
    if (this.tmdbCache?.fingerprint !== fingerprint) {
      this.tmdbCache = {
        fingerprint,
        access: createTmdbAccess({
          apiKey,
          language: stored.language,
          region: stored.region,
          fetch: this.fetch,
          createClient: this.createClient,
        }),
      };
    }
    return this.tmdbCache.access;
  }

  /** Run the provider, resolve missing TMDB ids, drop duplicates. */
  private async fetchItems(
    implementation: ImportListImplementation,
    rawSettings: Settings,
    mediaType: ImportListMediaType,
    save: (patch: Settings) => void,
    signal?: AbortSignal,
  ): Promise<{ items: ResolvedItem[]; unresolved: number }> {
    const parsed = importListSettingsSchemas[implementation].safeParse(rawSettings);
    if (!parsed.success) throw new ImportListFetchError('bad-response', `stored settings are invalid: ${parsed.error.issues[0]?.message}`);
    const ctx: ProviderContext = {
      fetch: this.fetch,
      log: this.log.child({ importList: implementation }),
      now: this.now,
      tmdb: () => this.tmdb(),
      saveSettings: save,
      datasets: this.datasets,
      ids: this.ids,
      ...(signal ? { signal } : {}),
    };
    // The registry is keyed by implementation; TypeScript cannot correlate the key with the
    // parsed settings type, so widen the provider once here.
    const provider = providers[implementation] as Provider<ImportListImplementation>;
    const fetched = await withTmdbErrors(() => provider(parsed.data as never, mediaType, ctx));
    return this.resolve(fetched, mediaType);
  }

  private async resolve(items: FetchedItem[], mediaType: ImportListMediaType): Promise<{ items: ResolvedItem[]; unresolved: number }> {
    const out: ResolvedItem[] = [];
    const seen = new Set<string>();
    const push = (i: FetchedItem, tmdbId: number) => {
      const key = `${i.mediaType}:${tmdbId}`;
      if (seen.has(key)) return;
      seen.add(key);
      out.push({
        mediaType: i.mediaType,
        tmdbId,
        imdbId: i.imdbId ?? null,
        title: i.title,
        year: i.year ?? null,
        ...(i.rating != null ? { rating: i.rating } : {}),
        ...(i.votes != null ? { votes: i.votes } : {}),
      });
    };
    const unresolved = items.filter((i) => !i.tmdbId && (i.imdbId || i.tvdbId));
    const tmdb = unresolved.length ? this.tmdb() : null;
    let dropped = 0;
    for (const item of items) {
      if (mediaType !== 'both' && item.mediaType !== mediaType) continue;
      if (item.tmdbId) {
        push(item, item.tmdbId);
        continue;
      }
      if (!tmdb || (!item.imdbId && !item.tvdbId)) {
        dropped++;
        continue;
      }
      const results = await withTmdbErrors(() =>
        item.imdbId ? tmdb.client.findByImdbId(item.imdbId) : tmdb.client.findByTvdbId(item.tvdbId!),
      );
      const match = results.find((r) => r.mediaType === item.mediaType);
      if (match) push({ ...item, title: item.title || match.title, year: item.year ?? match.year ?? null }, match.tmdbId);
      else dropped++;
    }
    if (dropped) this.log.debug({ dropped }, 'import list items without a resolvable TMDB id were skipped');
    return { items: out, unresolved: dropped };
  }

  /** IdCache over import_list_id_cache; misses expire after a week so they are retried. */
  private idCache(): IdCache {
    return {
      get: (namespace, key) => {
        const row = this.db
          .select()
          .from(importListIdCache)
          .where(and(eq(importListIdCache.namespace, namespace), eq(importListIdCache.key, key)))
          .get();
        if (!row) return undefined;
        if (row.tmdbId === null && this.now().getTime() - Date.parse(row.fetchedAt) > ID_MISS_TTL_MS) return undefined;
        return { mediaType: row.mediaType, tmdbId: row.tmdbId, imdbId: row.imdbId, title: row.title, year: row.year };
      },
      set: (namespace, key, value: CachedId) => {
        const values = { ...value, fetchedAt: this.now().toISOString() };
        this.db
          .insert(importListIdCache)
          .values({ namespace, key, ...values })
          .onConflictDoUpdate({ target: [importListIdCache.namespace, importListIdCache.key], set: values })
          .run();
      },
    };
  }

  private inLibrary(kind: Kind, tmdbId: number): boolean {
    return kind === 'series'
      ? !!this.db.select({ id: series.id }).from(series).where(eq(series.tmdbId, tmdbId)).get()
      : !!this.db.select({ id: movies.id }).from(movies).where(eq(movies.tmdbId, tmdbId)).get();
  }

  /** Builds an in-library/excluded flagger from one read of each table. */
  private flagger(): (kind: Kind, tmdbId: number) => { inLibrary: boolean; excluded: boolean } {
    const lib = new Set([
      ...this.db.select({ tmdbId: series.tmdbId }).from(series).all().map((r) => `series:${r.tmdbId}`),
      ...this.db.select({ tmdbId: movies.tmdbId }).from(movies).all().map((r) => `movie:${r.tmdbId}`),
    ]);
    const excluded = new Set(this.listExclusions().map((e) => `${e.mediaType}:${e.tmdbId}`));
    return (kind, tmdbId) => ({ inLibrary: lib.has(`${kind}:${tmdbId}`), excluded: excluded.has(`${kind}:${tmdbId}`) });
  }

  /** Add one title with the list's defaults. Returns the new id, or null when TMDB has no such title. */
  private async add(row: Row, item: ResolvedItem): Promise<number | null> {
    if (item.mediaType === 'series') {
      const meta = await this.metadata.series(item.tmdbId);
      if (!meta) return null;
      const added = libraryService.addSeries(this.db, meta, {
        tmdbId: item.tmdbId,
        rootFolderPath: row.rootFolderPath,
        qualityProfileId: row.qualityProfileId,
        monitored: row.monitorOption !== 'none',
        monitorOption: row.monitorOption,
        monitorNewItems: row.monitorOption === 'none' ? 'none' : 'all',
        seriesType: row.seriesType,
        seasonFolder: row.seasonFolder,
        tags: row.tags,
        searchOnAdd: row.searchOnAdd,
      });
      this.bus?.publish({ type: 'library', action: 'added', mediaType: 'series', id: added.id });
      this.log.info({ importList: row.name, seriesId: added.id, title: added.title }, 'added series from import list');
      return added.id;
    }
    const meta = await this.metadata.movie(item.tmdbId);
    if (!meta) return null;
    const added = libraryService.addMovie(this.db, meta, {
      tmdbId: item.tmdbId,
      rootFolderPath: row.mediaType === 'both' && row.movieRootFolderPath ? row.movieRootFolderPath : row.rootFolderPath,
      qualityProfileId: row.qualityProfileId,
      monitored: row.monitorOption !== 'none',
      minimumAvailability: row.minimumAvailability,
      tags: row.tags,
      searchOnAdd: row.searchOnAdd,
    });
    this.bus?.publish({ type: 'library', action: 'added', mediaType: 'movie', id: added.id });
    this.log.info({ importList: row.name, movieId: added.id, title: added.title }, 'added movie from import list');
    return added.id;
  }
}

// ---- mapping --------------------------------------------------------------------------

function isTrakt(implementation: ImportListImplementation): boolean {
  return (
    implementation === 'trakt' ||
    implementation === 'traktPopular' ||
    implementation === 'traktUser' ||
    implementation === 'traktLists'
  );
}

export function maskSettings(settings: Settings): Settings {
  const out: Settings = { ...settings };
  for (const key of IMPORT_LIST_SECRET_FIELDS) if (out[key]) out[key] = SECRET_MASK;
  return out;
}

function toResource(row: Row): ImportList {
  return {
    id: row.id,
    name: row.name,
    implementation: row.implementation,
    enabled: row.enabled,
    enableAutomaticAdd: row.enableAutomaticAdd,
    searchOnAdd: row.searchOnAdd,
    monitorOption: row.monitorOption,
    seriesType: row.seriesType,
    seasonFolder: row.seasonFolder,
    rootFolderPath: row.rootFolderPath,
    movieRootFolderPath: row.movieRootFolderPath,
    qualityProfileId: row.qualityProfileId,
    tags: row.tags,
    minimumAvailability: row.minimumAvailability,
    mediaType: row.mediaType,
    settings: maskSettings(row.settings),
    syncIntervalHours: row.syncIntervalHours ?? null,
    filters: row.filters ?? {},
    streaming: row.streaming ?? { enabled: false, providerIds: [] },
    cleanupAction: row.cleanupAction ?? 'none',
    lastSyncAt: row.lastSyncAt,
    lastSyncError: row.lastSyncError,
  };
}

/** Columns from a create/update body; the optional list rules keep their stored value when omitted. */
function columnsFrom(input: ImportListCreate, current: Row | null) {
  return {
    syncIntervalHours: input.syncIntervalHours !== undefined ? (input.syncIntervalHours ?? null) : (current?.syncIntervalHours ?? null),
    filters: input.filters ?? current?.filters ?? {},
    streaming: input.streaming ?? current?.streaming ?? { enabled: false, providerIds: [] },
    cleanupAction: input.cleanupAction ?? current?.cleanupAction ?? 'none',
    name: input.name,
    implementation: input.implementation,
    enabled: input.enabled,
    enableAutomaticAdd: input.enableAutomaticAdd,
    searchOnAdd: input.searchOnAdd,
    monitorOption: input.monitorOption,
    seriesType: input.seriesType,
    seasonFolder: input.seasonFolder,
    rootFolderPath: input.rootFolderPath,
    movieRootFolderPath: input.mediaType === 'both' ? (input.movieRootFolderPath ?? null) : null,
    qualityProfileId: input.qualityProfileId,
    tags: input.tags,
    minimumAvailability: input.minimumAvailability,
    mediaType: input.mediaType,
  };
}
