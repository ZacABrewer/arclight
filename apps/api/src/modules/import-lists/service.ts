import { randomUUID } from 'node:crypto';
import { resolve as resolvePath } from 'node:path';
import { and, asc, eq, inArray } from 'drizzle-orm';
import { createTmdbClient, type TmdbClient, type TmdbClientOptions } from '@media-tron/metadata';
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
  type ImportListSchema,
  type ImportListSettings,
  type ImportListSyncResult,
  type ImportListTestRequest,
  type ImportListTestResult,
  type TraktDeviceResponse,
  type TraktPollRequest,
  type TraktPollResponse,
} from '@media-tron/shared';
import type { Logger } from 'pino';
import type { Db } from '../../db/index.js';
import { importExclusions, movies, qualityProfiles, rootFolders, series } from '../../db/schema.js';
import type { EventBus } from '../../events.js';
import { libraryService, type MetadataLookup } from '../library/index.js';
import { settingsService } from '../settings/index.js';
import { ImportListFetchError, ImportListsError } from './errors.js';
import {
  createTmdbAccess,
  providers,
  traktDeviceCode,
  traktPollToken,
  withTmdbErrors,
  type FetchedItem,
  type FetchLike,
  type Provider,
  type ProviderContext,
  type TmdbAccess,
  type TraktTokens,
} from './providers/index.js';
import { importListItems, importLists } from './schema.js';
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
}

/** Token-bearing settings fields the server manages; kept when a client omits them. */
const KEPT_FIELDS: readonly string[] = [...IMPORT_LIST_SECRET_FIELDS, 'tokenExpiresAt'];
/** Pending Trakt authorizations (for lists not saved yet) live this long. */
const PENDING_AUTH_TTL_MS = 30 * 60 * 1000;
/** A list counts as due slightly early so an hourly tick does not drift past the interval. */
const DUE_SLACK_MS = 2 * 60 * 1000;
const TEST_PREVIEW_COUNT = 10;

interface PendingAuth {
  clientId: string;
  clientSecret: string;
  tokens: TraktTokens;
  expiresAt: number;
}

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
      .values({ ...columnsFrom(input), settings, addedAt: this.now().toISOString() })
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
      .set({ ...columnsFrom(input), settings })
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
      const items = await this.fetchItems(req.implementation, settings, req.mediaType, (patch) => {
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

  // ---- fetch & sync ---------------------------------------------------------------------

  /** Fetch one list and store its items. Failures are recorded on the list and rethrown. */
  async fetchList(id: number, signal?: AbortSignal): Promise<ResolvedItem[]> {
    const row = this.row(id);
    const fetchedAt = this.now().toISOString();
    try {
      const items = await this.fetchItems(
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
    const intervalMs = settings.syncIntervalHours * 3_600_000;
    const rows = this.db
      .select()
      .from(importLists)
      .where(eq(importLists.enabled, true))
      .orderBy(asc(importLists.name))
      .all()
      .filter((r) => opts.force || !r.lastSyncAt || nowMs - Date.parse(r.lastSyncAt) >= intervalMs - DUE_SLACK_MS);

    const result: ImportListSyncResult = {
      lists: rows.length,
      fetched: 0,
      added: 0,
      skippedExisting: 0,
      skippedExcluded: 0,
      failed: 0,
      cleaned: 0,
      errors: [],
    };
    const seen = new Set<string>();
    const toSearch: Array<{ seriesId: number } | { movieId: number }> = [];
    let anyFetched = false;

    for (const row of rows) {
      if (opts.signal?.aborted) break;
      let items: ResolvedItem[];
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
      if (!row.enableAutomaticAdd) continue;

      for (const item of items) {
        const key = `${item.mediaType}:${item.tmdbId}`;
        if (seen.has(key)) continue;
        seen.add(key);
        if (this.inLibrary(item.mediaType, item.tmdbId)) {
          result.skippedExisting++;
          continue;
        }
        if (libraryService.isExcluded(this.db, item.mediaType, item.tmdbId)) {
          result.skippedExcluded++;
          continue;
        }
        try {
          const id = await this.add(row, item);
          if (id === null) {
            result.failed++;
            continue;
          }
          result.added++;
          if (row.searchOnAdd) toSearch.push(item.mediaType === 'series' ? { seriesId: id } : { movieId: id });
        } catch (err) {
          result.failed++;
          this.log.warn({ err, importListId: row.id, tmdbId: item.tmdbId, title: item.title }, 'import list add failed');
        }
      }
    }

    if (toSearch.length && this.search) {
      const search = this.search;
      // Detached: indexer searches must not hold up the sync job.
      void (async () => {
        for (const target of toSearch) {
          await search(target).catch((err: unknown) => this.log.warn({ err, target }, 'search on add failed'));
        }
      })();
    }

    if (anyFetched) result.cleaned = await this.cleanLibrary();
    return result;
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
      clientId: req.clientId,
      clientSecret,
      tokens: outcome.tokens,
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
      if (!pending) throw new ImportListsError('VALIDATION', 'the Trakt authorization expired; authenticate again');
      if (opts.consumeAuthRef) this.pendingAuth.delete(ref);
      merged['clientId'] ??= pending.clientId;
      merged['clientSecret'] ??= pending.clientSecret;
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
    const apiKey = stored.tmdbApiKey ?? this.env['MEDIATRON_TMDB_API_KEY']?.trim();
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
  ): Promise<ResolvedItem[]> {
    const parsed = importListSettingsSchemas[implementation].safeParse(rawSettings);
    if (!parsed.success) throw new ImportListFetchError('bad-response', `stored settings are invalid: ${parsed.error.issues[0]?.message}`);
    const ctx: ProviderContext = {
      fetch: this.fetch,
      log: this.log.child({ importList: implementation }),
      now: this.now,
      tmdb: () => this.tmdb(),
      saveSettings: save,
      ...(signal ? { signal } : {}),
    };
    // The registry is keyed by implementation; TypeScript cannot correlate the key with the
    // parsed settings type, so widen the provider once here.
    const provider = providers[implementation] as Provider<ImportListImplementation>;
    const fetched = await withTmdbErrors(() => provider(parsed.data as never, mediaType, ctx));
    return this.resolve(fetched, mediaType);
  }

  private async resolve(items: FetchedItem[], mediaType: ImportListMediaType): Promise<ResolvedItem[]> {
    const out: ResolvedItem[] = [];
    const seen = new Set<string>();
    const push = (i: FetchedItem, tmdbId: number) => {
      const key = `${i.mediaType}:${tmdbId}`;
      if (seen.has(key)) return;
      seen.add(key);
      out.push({ mediaType: i.mediaType, tmdbId, imdbId: i.imdbId ?? null, title: i.title, year: i.year ?? null });
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
    return out;
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
  return implementation === 'trakt' || implementation === 'traktPopular' || implementation === 'traktUser';
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
    lastSyncAt: row.lastSyncAt,
    lastSyncError: row.lastSyncError,
  };
}

function columnsFrom(input: ImportListCreate) {
  return {
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
