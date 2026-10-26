import { and, asc, desc, eq, inArray, ne, sql, type SQL } from 'drizzle-orm';
import type { TmdbClient } from '@arclight/metadata';
import {
  CreateRequest,
  OverrideRuleInput,
  Permission,
  RequestListQuery,
  REQUEST_SECRET_MASK,
  RequestsSettings,
  UserQuota,
  UserRequestSettings,
  type ApproveRequest,
  type BulkRequestResult,
  type MediaRequest,
  type MediaStatus,
  type MediaType,
  type OverrideRule,
  type RequestCount,
  type RequestPage,
  type RequestStatus,
  type UpdateRequest,
  type UserNotificationTestResult,
  type UserPermissions,
  type UserQuotaResponse,
  type ServerEvent,
} from '@arclight/shared';
import type { Logger } from 'pino';
import type { Db } from '../../db/index.js';
import { qualityProfiles, rootFolders } from '../../db/schema.js';
import type { EventBus } from '../../events.js';
import { libraryService, type MovieMetadataInput, type SeriesMetadataInput } from '../library/index.js';
import type { SearchTarget } from '../releases/index.js';
import { getSection, setSection } from '../settings/service.js';
import { RequestsError } from './errors.js';
import { libraryOnlyAvailability, type MediaServerAvailability } from './media-server.js';
import type { RequestNotifier } from './notify.js';
import {
  type Actor,
  can,
  canAutoApprove,
  canManageRequests,
  canManageSettings,
  canManageUsers,
  canRequest,
  canRequestAdvanced,
  canViewAllRequests,
  isQuotaExempt,
} from './permissions.js';
import { quotaFor } from './quota.js';
import { mediaRequests, overrideRules, requestMediaStatus, seasonRequests, issues, issueComments, watchlistItems } from './schema.js';
import { libraryAvailability, overlayRequests, seasonStatusMap, type LibraryAvailability } from './status.js';
import {
  allUserRows,
  findUserRow,
  ownerUser,
  patchUserSettings,
  requestSettingsOf,
  requestUsers,
  setUserPermissions,
  userPermissions,
  userRow,
  type UserRow,
} from './users.js';

// Requests (docs/spec/requests.md sections 4-10): permissions, quotas, creation with
// auto-approval and override rules, approval into the library, decline/retry/delete, and
// the status sync that completes requests once the library has the files.

export type RequestRow = typeof mediaRequests.$inferSelect;
type OverrideRow = typeof overrideRules.$inferSelect;

/** TMDB access and library-shaped lookups (the metadata module in production, fakes in tests). */
export interface TitleSource {
  /** Throws when no TMDB key is configured. */
  client(): TmdbClient;
  lookupSeries(tmdbId: number): Promise<SeriesMetadataInput | null>;
  lookupMovie(tmdbId: number): Promise<MovieMetadataInput | null>;
}

export interface RequestsServiceOptions {
  db: Db;
  bus: EventBus;
  log?: Logger;
  titles: TitleSource;
  notifier: RequestNotifier;
  /** Indexer search after a title was added for a request. */
  search?: (target: SearchTarget) => Promise<unknown>;
  /** Media-server availability used when settings.useMediaServerAvailability is on. */
  mediaServer?: MediaServerAvailability;
  now?: () => Date;
}

export type CreateOutcome = { kind: 'created'; request: MediaRequest } | { kind: 'accepted'; message: string };

const ACTIVE: RequestStatus[] = ['pending', 'approved', 'failed'];
/** TMDB keyword that marks anime; rules skip anime unless they name it (section 8.2.3). */
export const ANIME_KEYWORD = 210024;

interface TitleFacts {
  title: string;
  year: number | null;
  poster: string | null;
  backdrop: string | null;
  tvdbId: number | null;
  originalLanguage: string;
  /** Series: TMDB seasons with episode counts. */
  seasons: { seasonNumber: number; episodeCount: number }[];
  genreIds: number[] | null;
  keywordIds: number[] | null;
}

export interface TitleStatus {
  status: MediaStatus;
  status4k: MediaStatus;
  libraryId: number | null;
  seasons: { seasonNumber: number; status: MediaStatus; status4k: MediaStatus }[];
  /** Newest active request per track. */
  request: RequestRow | null;
  request4k: RequestRow | null;
  activeRequests: RequestRow[];
}

export class RequestsService {
  readonly db: Db;
  private readonly bus: EventBus;
  private readonly log: Logger | undefined;
  readonly titles: TitleSource;
  readonly notifier: RequestNotifier;
  private readonly search: ((target: SearchTarget) => Promise<unknown>) | undefined;
  private readonly mediaServer: MediaServerAvailability;
  readonly now: () => Date;

  constructor(opts: RequestsServiceOptions) {
    this.db = opts.db;
    this.bus = opts.bus;
    this.log = opts.log;
    this.titles = opts.titles;
    this.notifier = opts.notifier;
    this.search = opts.search;
    this.mediaServer = opts.mediaServer ?? libraryOnlyAvailability;
    this.now = opts.now ?? (() => new Date());
    this.notifier.seasonLookup = (id) => this.seasonRows(id).map((s) => s.seasonNumber);
  }

  private iso(): string {
    return this.now().toISOString();
  }

  private publish(action: Extract<ServerEvent, { type: 'request' }>['action'], id: number): void {
    this.bus.publish({ type: 'request', action, id });
  }

  // -------------------------------------------------------------------------------------
  // settings
  // -------------------------------------------------------------------------------------

  settings(): RequestsSettings {
    return getSection(this.db, 'requests');
  }

  updateSettings(actor: Actor, value: RequestsSettings): RequestsSettings {
    if (!canManageSettings(actor.permissions)) throw RequestsError.forbidden();
    const saved = setSection(this.db, 'requests', RequestsSettings.parse(value), this.iso());
    this.bus.publish({ type: 'settings', section: 'requests' });
    return saved;
  }

  // -------------------------------------------------------------------------------------
  // resource mapping
  // -------------------------------------------------------------------------------------

  private seasonRows(requestId: number) {
    return this.db.select().from(seasonRequests).where(eq(seasonRequests.requestId, requestId)).orderBy(asc(seasonRequests.seasonNumber)).all();
  }

  row(id: number): RequestRow {
    const row = this.db.select().from(mediaRequests).where(eq(mediaRequests.id, id)).get();
    if (!row) throw RequestsError.notFound('request', id);
    return row;
  }

  /** Status of many titles of one type, with requests overlaid. */
  titleStatuses(type: MediaType, tmdbIds: readonly number[]): Map<number, TitleStatus> {
    const out = new Map<number, TitleStatus>();
    const ids = [...new Set(tmdbIds)];
    if (ids.length === 0) return out;
    const lib = libraryAvailability(this.db, type, ids, { now: this.now(), includeSpecials: this.settings().enableSpecialEpisodes });
    const active = this.db
      .select()
      .from(mediaRequests)
      .where(and(eq(mediaRequests.type, type), inArray(mediaRequests.tmdbId, ids), inArray(mediaRequests.status, ACTIVE)))
      .orderBy(desc(mediaRequests.id))
      .all();
    const seasonsByRequest = this.seasonsFor(active.map((r) => r.id));
    for (const tmdbId of ids) {
      const entry: LibraryAvailability | undefined = lib.get(tmdbId);
      const mine = active.filter((r) => r.tmdbId === tmdbId);
      const normal = mine.filter((r) => !r.is4k);
      const uhd = mine.filter((r) => r.is4k);
      const seasons = (entry?.seasons ?? []).map((s) => ({ ...s }));
      // Seasons only known through requests still get an entry so the UI can show "requested".
      for (const req of mine) {
        for (const sr of seasonsByRequest.get(req.id) ?? []) {
          let season = seasons.find((s) => s.seasonNumber === sr.seasonNumber);
          if (!season) {
            season = { seasonNumber: sr.seasonNumber, status: 'unknown', status4k: 'unknown' };
            seasons.push(season);
          }
          if (req.is4k) season.status4k = overlayRequests(season.status4k, [req.status]);
          else season.status = overlayRequests(season.status, [req.status]);
        }
      }
      seasons.sort((a, b) => a.seasonNumber - b.seasonNumber);
      out.set(tmdbId, {
        status: overlayRequests(entry?.status ?? 'unknown', normal.map((r) => r.status)),
        status4k: overlayRequests(entry?.status4k ?? 'unknown', uhd.map((r) => r.status)),
        libraryId: entry?.libraryId ?? null,
        seasons,
        request: normal[0] ?? null,
        request4k: uhd[0] ?? null,
        activeRequests: mine,
      });
    }
    return out;
  }

  private seasonsFor(requestIds: number[]): Map<number, (typeof seasonRequests.$inferSelect)[]> {
    const out = new Map<number, (typeof seasonRequests.$inferSelect)[]>();
    if (requestIds.length === 0) return out;
    for (const row of this.db.select().from(seasonRequests).where(inArray(seasonRequests.requestId, requestIds)).orderBy(asc(seasonRequests.seasonNumber)).all()) {
      const list = out.get(row.requestId) ?? [];
      list.push(row);
      out.set(row.requestId, list);
    }
    return out;
  }

  toResources(rows: RequestRow[], actor: Actor): MediaRequest[] {
    if (rows.length === 0) return [];
    const usersById = requestUsers(this.db, rows.flatMap((r) => [r.requestedById, r.modifiedById]));
    const seasons = this.seasonsFor(rows.map((r) => r.id));
    const statuses = new Map<string, TitleStatus>();
    for (const type of ['movie', 'series'] as const) {
      const ids = rows.filter((r) => r.type === type).map((r) => r.tmdbId);
      for (const [tmdbId, status] of this.titleStatuses(type, ids)) statuses.set(`${type}:${tmdbId}`, status);
    }
    const manage = canManageRequests(actor.permissions);
    return rows.map((r) => {
      const status = statuses.get(`${r.type}:${r.tmdbId}`);
      const resource: MediaRequest = {
        id: r.id,
        type: r.type,
        status: r.status,
        is4k: r.is4k,
        mediaTmdbId: r.tmdbId,
        mediaTvdbId: r.tvdbId,
        mediaTitle: r.title,
        mediaYear: r.year,
        mediaPoster: r.poster,
        mediaBackdrop: r.backdrop,
        seasons: (seasons.get(r.id) ?? []).map((s) => ({ seasonNumber: s.seasonNumber, status: s.status })),
        requestedBy: usersById.get(r.requestedById) ?? { id: r.requestedById, username: `deleted user ${r.requestedById}` },
        modifiedBy: r.modifiedById === null ? null : (usersById.get(r.modifiedById) ?? null),
        rootFolderPath: r.rootFolderPath,
        qualityProfileId: r.qualityProfileId,
        tags: r.tags,
        ignoreQuota: r.ignoreQuota,
        isAutoRequest: r.isAutoRequest,
        declineReason: r.declineReason,
        failureReason: r.failureReason,
        createdAt: r.createdAt,
        updatedAt: r.updatedAt,
        mediaStatus: (r.is4k ? status?.status4k : status?.status) ?? 'unknown',
        libraryId: r.libraryId ?? status?.libraryId ?? null,
        canRemove: manage || (r.requestedById === actor.userId && r.status === 'pending'),
      };
      return resource;
    });
  }

  toResource(row: RequestRow, actor: Actor): MediaRequest {
    return this.toResources([row], actor)[0]!;
  }

  // -------------------------------------------------------------------------------------
  // reading
  // -------------------------------------------------------------------------------------

  private assertCanSee(actor: Actor, row: RequestRow): void {
    if (row.requestedById !== actor.userId && !canViewAllRequests(actor.permissions)) throw RequestsError.forbidden();
  }

  get(actor: Actor, id: number): MediaRequest {
    const row = this.row(id);
    this.assertCanSee(actor, row);
    return this.toResource(row, actor);
  }

  /** Visibility filter: own requests unless the actor may view everyone's. */
  private scope(actor: Actor, requestedBy?: number): SQL | undefined {
    if (canViewAllRequests(actor.permissions)) return requestedBy === undefined ? undefined : eq(mediaRequests.requestedById, requestedBy);
    if (requestedBy !== undefined && requestedBy !== actor.userId) throw RequestsError.forbidden('you may only view your own requests');
    return eq(mediaRequests.requestedById, actor.userId ?? -1);
  }

  list(actor: Actor, rawQuery: RequestListQuery): RequestPage {
    const q = RequestListQuery.parse(rawQuery);
    const where: SQL[] = [];
    const scope = this.scope(actor, q.requestedBy);
    if (scope) where.push(scope);
    if (q.mediaType !== 'all') where.push(eq(mediaRequests.type, q.mediaType));
    const statusFilter: Partial<Record<typeof q.filter, RequestStatus[]>> = {
      pending: ['pending'],
      approved: ['approved'],
      processing: ['approved'],
      unavailable: ['pending', 'approved'],
      declined: ['declined'],
      failed: ['failed'],
      completed: ['completed'],
      available: ['completed'],
    };
    const statuses = statusFilter[q.filter];
    if (statuses) where.push(inArray(mediaRequests.status, statuses));
    const order = q.sort === 'modified' ? mediaRequests.updatedAt : mediaRequests.id;
    let rows = this.db
      .select()
      .from(mediaRequests)
      .where(where.length ? and(...where) : undefined)
      .orderBy(q.sortDirection === 'asc' ? asc(order) : desc(order), q.sortDirection === 'asc' ? asc(mediaRequests.id) : desc(mediaRequests.id))
      .all();
    // Media-status restrictions need the computed status, so they filter after the query.
    if (q.filter === 'processing' || q.filter === 'unavailable' || q.filter === 'available') {
      const resources = this.toResources(rows, actor);
      const keep = new Set(
        resources
          .filter((r) => (q.filter === 'available' ? r.mediaStatus === 'available' : r.mediaStatus !== 'available'))
          .map((r) => r.id),
      );
      rows = rows.filter((r) => keep.has(r.id));
    }
    const page = rows.slice(q.skip, q.skip + q.take);
    return { pageInfo: { total: rows.length, take: q.take, skip: q.skip }, results: this.toResources(page, actor) };
  }

  count(actor: Actor): RequestCount {
    const scope = this.scope(actor);
    const rows = this.db.select().from(mediaRequests).where(scope).all();
    const resources = this.toResources(
      rows.filter((r) => r.status === 'approved' || r.status === 'completed' || r.status === 'pending'),
      actor,
    );
    const statusOf = new Map(resources.map((r) => [r.id, r.mediaStatus]));
    const by = (s: RequestStatus) => rows.filter((r) => r.status === s).length;
    return {
      total: rows.length,
      movie: rows.filter((r) => r.type === 'movie').length,
      series: rows.filter((r) => r.type === 'series').length,
      pending: by('pending'),
      approved: by('approved'),
      declined: by('declined'),
      failed: by('failed'),
      processing: rows.filter((r) => r.status === 'approved' && statusOf.get(r.id) !== 'available').length,
      available: rows.filter((r) => (r.status === 'completed' || r.status === 'approved') && statusOf.get(r.id) === 'available').length,
      completed: by('completed'),
    };
  }

  /** Requests for one title the actor may see (title pages). */
  forTitle(actor: Actor, type: MediaType, tmdbId: number): MediaRequest[] {
    const where = [eq(mediaRequests.type, type), eq(mediaRequests.tmdbId, tmdbId)];
    const scope = this.scope(actor);
    if (scope) where.push(scope);
    return this.toResources(this.db.select().from(mediaRequests).where(and(...where)).orderBy(desc(mediaRequests.id)).all(), actor);
  }

  // -------------------------------------------------------------------------------------
  // creation
  // -------------------------------------------------------------------------------------

  private async facts(type: MediaType, tmdbId: number, needTaxonomy: boolean): Promise<TitleFacts> {
    let client: TmdbClient;
    try {
      client = this.titles.client();
    } catch (err) {
      throw new RequestsError('NOT_CONFIGURED', err instanceof Error ? err.message : 'TMDB is not configured');
    }
    try {
      if (type === 'movie') {
        const [movie, extras] = await Promise.all([client.getMovie(tmdbId), needTaxonomy ? client.getMovieExtras(tmdbId) : Promise.resolve(null)]);
        return {
          title: movie.title,
          year: movie.year ?? null,
          poster: movie.images.poster ?? null,
          backdrop: movie.images.backdrop ?? null,
          tvdbId: null,
          originalLanguage: movie.originalLanguage,
          seasons: [],
          genreIds: extras ? extras.genres.map((g) => g.tmdbId) : null,
          keywordIds: extras ? extras.keywords.map((k) => k.tmdbId) : null,
        };
      }
      const [show, extras] = await Promise.all([client.getSeries(tmdbId), needTaxonomy ? client.getSeriesExtras(tmdbId) : Promise.resolve(null)]);
      return {
        title: show.title,
        year: show.year ?? null,
        poster: show.images.poster ?? null,
        backdrop: show.images.backdrop ?? null,
        tvdbId: show.tvdbId ?? null,
        originalLanguage: show.originalLanguage,
        seasons: show.seasons.map((s) => ({ seasonNumber: s.seasonNumber, episodeCount: s.episodeCount })),
        genreIds: extras ? extras.genres.map((g) => g.tmdbId) : null,
        keywordIds: extras ? extras.keywords.map((k) => k.tmdbId) : null,
      };
    } catch (err) {
      if (err instanceof Error && 'code' in err && (err as { code: unknown }).code === 'not-found') {
        throw RequestsError.notFound(type === 'movie' ? 'TMDB movie' : 'TMDB series', tmdbId);
      }
      throw err;
    }
  }

  private resolveRequester(actor: Actor, userId: number | undefined): UserRow {
    if (userId !== undefined && userId !== actor.userId) {
      if (!(canManageUsers(actor.permissions) || canManageRequests(actor.permissions))) {
        throw RequestsError.forbidden('requesting on behalf of another user needs Manage users or Manage requests');
      }
      return userRow(this.db, userId);
    }
    if (actor.userId === null) return ownerUser(this.db);
    return userRow(this.db, actor.userId);
  }

  /** Season numbers covered by active requests of the track (optionally ignoring one request). */
  private coveredSeasons(tmdbId: number, is4k: boolean, exceptId?: number): Set<number> {
    const where = [eq(mediaRequests.type, 'series'), eq(mediaRequests.tmdbId, tmdbId), eq(mediaRequests.is4k, is4k), inArray(mediaRequests.status, ACTIVE)];
    if (exceptId !== undefined) where.push(ne(mediaRequests.id, exceptId));
    const ids = this.db.select({ id: mediaRequests.id }).from(mediaRequests).where(and(...where)).all().map((r) => r.id);
    const out = new Set<number>();
    for (const list of this.seasonsFor(ids).values()) for (const s of list) out.add(s.seasonNumber);
    return out;
  }

  /** Seasons the library already has (or wants) on the track. */
  private librarySeasons(tmdbId: number, is4k: boolean): Set<number> {
    const entry = libraryAvailability(this.db, 'series', [tmdbId], { now: this.now() }).get(tmdbId);
    if (!entry) return new Set();
    const map = seasonStatusMap(entry.seasons, is4k);
    return new Set([...map].filter(([, status]) => status !== 'unknown').map(([n]) => n));
  }

  /** Section 5.5: the seasons a series request would actually cover. */
  private requestableSeasons(
    facts: TitleFacts,
    wanted: number[] | 'all' | undefined,
    tmdbId: number,
    is4k: boolean,
    settings: RequestsSettings,
    exceptId?: number,
  ): number[] {
    const eligible = facts.seasons
      .filter((s) => (settings.enableSpecialEpisodes || s.seasonNumber > 0) && s.episodeCount > 0)
      .map((s) => s.seasonNumber);
    const base =
      wanted === undefined || wanted === 'all' || !settings.partialRequestsEnabled ? eligible : wanted.filter((n) => eligible.includes(n));
    const covered = this.coveredSeasons(tmdbId, is4k, exceptId);
    const inLibrary = this.librarySeasons(tmdbId, is4k);
    return [...new Set(base)].filter((n) => !covered.has(n) && !inLibrary.has(n)).sort((a, b) => a - b);
  }

  /** Section 8: the best matching override rule, or null. */
  matchRule(
    rules: OverrideRow[],
    ctx: { type: MediaType; is4k: boolean; userId: number; genreIds: number[]; keywordIds: number[]; language: string },
  ): OverrideRow | null {
    const anime = ctx.keywordIds.includes(ANIME_KEYWORD);
    let best: { rule: OverrideRow; score: number } | null = null;
    for (const rule of rules) {
      if (!rule.enabled || rule.mediaType !== ctx.type) continue;
      if (rule.is4k !== null && rule.is4k !== ctx.is4k) continue;
      if (anime && !rule.keywords.includes(ANIME_KEYWORD)) continue;
      if (rule.users.length > 0 && !rule.users.includes(ctx.userId)) continue;
      if (rule.genres.length > 0 && !rule.genres.some((g) => ctx.genreIds.includes(g))) continue;
      if (rule.languages.length > 0 && !rule.languages.includes(ctx.language)) continue;
      if (rule.keywords.length > 0 && !rule.keywords.some((k) => ctx.keywordIds.includes(k))) continue;
      const score = (rule.genres.length > 0 ? 1 : 0) + (rule.languages.length > 0 ? 1 : 0) + (rule.keywords.length > 0 ? 1 : 0);
      if (!best || score > best.score) best = { rule, score };
    }
    return best?.rule ?? null;
  }

  async create(actor: Actor, raw: CreateRequest, opts: { isAutoRequest?: boolean } = {}): Promise<CreateOutcome> {
    const input = CreateRequest.parse(raw);
    const settings = this.settings();
    const requester = this.resolveRequester(actor, input.userId);
    const held = userPermissions(requester);
    const type = input.mediaType;
    const is4k = input.is4k;

    if (!canRequest(held, type, is4k)) throw RequestsError.forbidden(`not allowed to request ${is4k ? '4K ' : ''}${type === 'movie' ? 'movies' : 'series'}`);
    if (is4k && !(type === 'movie' ? settings.movie4k.enabled : settings.series4k.enabled)) {
      throw new RequestsError('VALIDATION', `4K ${type === 'movie' ? 'movie' : 'series'} requests are disabled`);
    }
    if (libraryService.isExcluded(this.db, type, input.tmdbId)) throw RequestsError.forbidden('this title is on the exclusion list');
    if (opts.isAutoRequest) {
      const dup = this.db
        .select({ id: mediaRequests.id })
        .from(mediaRequests)
        .where(and(eq(mediaRequests.type, type), eq(mediaRequests.tmdbId, input.tmdbId), eq(mediaRequests.requestedById, requester.id), eq(mediaRequests.isAutoRequest, true)))
        .get();
      if (dup) throw new RequestsError('CONFLICT', 'already auto-requested');
    }

    // Movie duplicates are decided before talking to TMDB.
    if (type === 'movie') {
      const existing = this.db
        .select({ id: mediaRequests.id })
        .from(mediaRequests)
        .where(and(eq(mediaRequests.type, 'movie'), eq(mediaRequests.tmdbId, input.tmdbId), eq(mediaRequests.is4k, is4k), inArray(mediaRequests.status, ACTIVE)))
        .get();
      if (existing) throw new RequestsError('CONFLICT', `this movie already has an active request (#${existing.id})`);
      const lib = libraryAvailability(this.db, 'movie', [input.tmdbId]).get(input.tmdbId);
      const track = is4k ? lib?.status4k : lib?.status;
      if (track && track !== 'unknown') throw new RequestsError('CONFLICT', 'this movie is already in the library');
    }

    const rules = this.db.select().from(overrideRules).orderBy(asc(overrideRules.id)).all();
    const needTaxonomy = rules.some((r) => r.enabled && r.mediaType === type && (r.genres.length > 0 || r.keywords.length > 0));
    const facts = await this.facts(type, input.tmdbId, needTaxonomy);

    let seasons: number[] = [];
    if (type === 'series') {
      seasons = this.requestableSeasons(facts, input.seasons, input.tmdbId, is4k, settings);
      if (seasons.length === 0) return { kind: 'accepted', message: 'no seasons available to request' };
    }

    // Quota (section 4 / 5.4).
    let ignoreQuota = false;
    if (input.ignoreQuota) {
      if (!canManageRequests(actor.permissions)) throw RequestsError.forbidden('ignoreQuota needs Manage requests');
      ignoreQuota = true;
    }
    if (!ignoreQuota && !isQuotaExempt(held)) {
      const quota = quotaFor(this.db, { id: requester.id, permissions: held, settings: requester.settings }, settings.defaultQuotas, this.now()).status;
      if (type === 'movie' && quota.movie.restricted) throw RequestsError.forbidden('Movie Quota exceeded.');
      if (type === 'series' && quota.series.remaining !== null && seasons.length > quota.series.remaining) {
        throw RequestsError.forbidden('Series Quota exceeded.');
      }
    }

    // Overrides: advanced callers keep theirs (rules fill gaps); others get the rule's.
    const advanced = canRequestAdvanced(actor.permissions);
    let rootFolderPath = advanced ? (input.rootFolderPath ?? null) : null;
    let qualityProfileId = advanced ? (input.qualityProfileId ?? null) : null;
    let tags = advanced ? [...(input.tags ?? [])] : [];
    const rule = this.matchRule(rules, {
      type,
      is4k,
      userId: requester.id,
      genreIds: facts.genreIds ?? [],
      keywordIds: facts.keywordIds ?? [],
      language: facts.originalLanguage,
    });
    if (rule) {
      if (rule.rootFolderPath && (!advanced || rootFolderPath === null)) rootFolderPath = rule.rootFolderPath;
      if (rule.qualityProfileId !== null && (!advanced || qualityProfileId === null)) qualityProfileId = rule.qualityProfileId;
      tags = [...new Set([...tags, ...rule.tags])];
    }

    const autoApproved =
      canAutoApprove(held, type, is4k) ||
      settings.autoApprove[type === 'movie' ? (is4k ? 'movie4k' : 'movie') : is4k ? 'series4k' : 'series'] ||
      Boolean(rule?.autoApprove);
    const status: RequestStatus = autoApproved ? 'approved' : 'pending';
    const now = this.iso();
    const row = this.db
      .insert(mediaRequests)
      .values({
        type,
        status,
        is4k,
        tmdbId: input.tmdbId,
        tvdbId: facts.tvdbId,
        title: facts.title,
        year: facts.year,
        poster: facts.poster,
        backdrop: facts.backdrop,
        requestedById: requester.id,
        modifiedById: autoApproved ? requester.id : null,
        rootFolderPath,
        qualityProfileId,
        tags,
        ignoreQuota,
        isAutoRequest: opts.isAutoRequest ?? false,
        createdAt: now,
        updatedAt: now,
      })
      .returning()
      .get();
    for (const seasonNumber of seasons) {
      this.db.insert(seasonRequests).values({ requestId: row.id, seasonNumber, status }).run();
    }
    this.log?.info({ requestId: row.id, type, tmdbId: input.tmdbId, status, rule: rule?.id }, 'request created');
    this.publish('created', row.id);
    await this.notifier.request('created', row).catch((err: unknown) => this.log?.warn({ err }, 'request notification failed'));

    let final = row;
    if (autoApproved) final = await this.sendToLibrary(row);
    return { kind: 'created', request: this.toResource(final, actor) };
  }

  // -------------------------------------------------------------------------------------
  // approval: into the library (section 9, adapted to Arclight's own library)
  // -------------------------------------------------------------------------------------

  private firstRootFolder(type: MediaType): string | null {
    return this.db.select().from(rootFolders).where(eq(rootFolders.mediaType, type)).orderBy(asc(rootFolders.id)).limit(1).get()?.path ?? null;
  }

  private firstProfile(): number | null {
    return this.db.select({ id: qualityProfiles.id }).from(qualityProfiles).orderBy(asc(qualityProfiles.id)).limit(1).get()?.id ?? null;
  }

  /** Where and how a request lands in the library. */
  resolveTarget(row: RequestRow): { rootFolderPath: string; qualityProfileId: number; tags: number[] } {
    const settings = this.settings();
    const defaults = settings[row.type];
    const uhd = row.is4k ? settings[row.type === 'movie' ? 'movie4k' : 'series4k'] : null;
    const rootFolderPath = row.rootFolderPath ?? uhd?.rootFolderPath ?? defaults.rootFolderPath ?? this.firstRootFolder(row.type);
    if (!rootFolderPath) throw new RequestsError('VALIDATION', `no ${row.type} root folder is configured`);
    const qualityProfileId = row.qualityProfileId ?? uhd?.qualityProfileId ?? defaults.qualityProfileId ?? this.firstProfile();
    if (qualityProfileId === null) throw new RequestsError('VALIDATION', 'no quality profile is configured');
    const tags = [...new Set([...defaults.tags, ...(uhd?.tags ?? []), ...row.tags])];
    return { rootFolderPath, qualityProfileId, tags };
  }

  private runSearch(target: SearchTarget): void {
    if (!this.search) return;
    // Detached: an indexer search must not hold up the approval.
    this.search(target).catch((err: unknown) => this.log?.warn({ err, target }, 'search after request approval failed'));
  }

  /**
   * Adds (or re-monitors) the title in the library for an approved request. Series are added
   * with monitor "none" and then exactly the requested seasons are monitored. Failures mark
   * the request failed (retry re-runs this). Returns the updated row.
   */
  async sendToLibrary(row: RequestRow): Promise<RequestRow> {
    const settings = this.settings();
    const defaults = settings[row.type];
    try {
      const target = this.resolveTarget(row);
      let libraryId: number;
      let alreadyAvailable = false;
      if (row.type === 'movie') {
        const existing = libraryService.findMovieByTmdbId(this.db, row.tmdbId);
        if (existing) {
          libraryId = existing.id;
          libraryService.updateMovie(this.db, existing.id, { monitored: true, ...(row.is4k ? { qualityProfileId: target.qualityProfileId } : {}) });
          this.bus.publish({ type: 'library', action: 'updated', mediaType: 'movie', id: existing.id });
          const lib = libraryAvailability(this.db, 'movie', [row.tmdbId]).get(row.tmdbId);
          alreadyAvailable = (row.is4k ? lib?.status4k : lib?.status) === 'available';
        } else {
          const meta = await this.titles.lookupMovie(row.tmdbId);
          if (!meta) throw RequestsError.notFound('TMDB movie', row.tmdbId);
          const movie = libraryService.addMovie(this.db, meta, {
            tmdbId: row.tmdbId,
            rootFolderPath: target.rootFolderPath,
            qualityProfileId: target.qualityProfileId,
            monitored: true,
            minimumAvailability: defaults.minimumAvailability,
            tags: target.tags,
            searchOnAdd: defaults.searchOnAdd,
          });
          libraryId = movie.id;
          this.bus.publish({ type: 'library', action: 'added', mediaType: 'movie', id: movie.id });
        }
        if (!alreadyAvailable && defaults.searchOnAdd) this.runSearch({ movieId: libraryId });
      } else {
        const seasons = this.seasonRows(row.id).map((s) => s.seasonNumber);
        let seriesId: number;
        const existing = libraryService.findSeriesByTmdbId(this.db, row.tmdbId);
        if (existing) {
          seriesId = existing.id;
          libraryService.updateSeries(this.db, existing.id, { monitored: true, ...(row.is4k ? { qualityProfileId: target.qualityProfileId } : {}) });
        } else {
          const meta = await this.titles.lookupSeries(row.tmdbId);
          if (!meta) throw RequestsError.notFound('TMDB series', row.tmdbId);
          const added = libraryService.addSeries(this.db, meta, {
            tmdbId: row.tmdbId,
            rootFolderPath: target.rootFolderPath,
            qualityProfileId: target.qualityProfileId,
            monitored: true,
            monitorOption: 'none',
            monitorNewItems: defaults.monitorNewItems,
            seriesType: defaults.seriesType,
            seasonFolder: defaults.seasonFolder,
            tags: target.tags,
            searchOnAdd: false,
          });
          seriesId = added.id;
          // monitorOption "none" leaves the series unmonitored; the request wants it watched.
          libraryService.updateSeries(this.db, seriesId, { monitored: true });
          this.bus.publish({ type: 'library', action: 'added', mediaType: 'series', id: seriesId });
        }
        const known = new Set(libraryService.getSeries(this.db, seriesId, { includeStatistics: false }).seasons.map((s) => s.seasonNumber));
        for (const n of seasons) if (known.has(n)) libraryService.setSeasonMonitored(this.db, seriesId, n, true);
        this.bus.publish({ type: 'library', action: 'updated', mediaType: 'series', id: seriesId });
        libraryId = seriesId;
        const lib = libraryAvailability(this.db, 'series', [row.tmdbId], { now: this.now() }).get(row.tmdbId);
        const map = seasonStatusMap(lib?.seasons ?? [], row.is4k);
        alreadyAvailable = seasons.length > 0 && seasons.every((n) => map.get(n) === 'available');
        if (!alreadyAvailable && defaults.searchOnAdd) {
          for (const n of seasons) if (known.has(n) && map.get(n) !== 'available') this.runSearch({ seriesId, seasonNumber: n });
        }
      }
      const updated = this.db
        .update(mediaRequests)
        .set({ libraryId, failureReason: null, updatedAt: this.iso() })
        .where(eq(mediaRequests.id, row.id))
        .returning()
        .get()!;
      this.upsertMediaStatus(row.type, row.tmdbId, { libraryId });
      if (alreadyAvailable) return await this.complete(updated);
      return updated;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.log?.warn({ err, requestId: row.id }, 'sending request to the library failed');
      const failed = this.db
        .update(mediaRequests)
        .set({ status: 'failed', failureReason: message, updatedAt: this.iso() })
        .where(eq(mediaRequests.id, row.id))
        .returning()
        .get()!;
      this.db.update(seasonRequests).set({ status: 'failed' }).where(eq(seasonRequests.requestId, row.id)).run();
      this.publish('failed', row.id);
      return failed;
    }
  }

  private async complete(row: RequestRow): Promise<RequestRow> {
    const done = this.db
      .update(mediaRequests)
      .set({ status: 'completed', updatedAt: this.iso() })
      .where(eq(mediaRequests.id, row.id))
      .returning()
      .get()!;
    this.db.update(seasonRequests).set({ status: 'completed' }).where(eq(seasonRequests.requestId, row.id)).run();
    this.publish('completed', row.id);
    await this.notifier.request('available', done).catch((err: unknown) => this.log?.warn({ err }, 'available notification failed'));
    return done;
  }

  private requirePending(row: RequestRow): void {
    if (row.status !== 'pending') throw new RequestsError('CONFLICT', `request ${row.id} is ${row.status}, not pending`);
  }

  async approve(actor: Actor, id: number, overrides: ApproveRequest = {}): Promise<MediaRequest> {
    if (!canManageRequests(actor.permissions)) throw RequestsError.forbidden();
    const row = this.row(id);
    this.requirePending(row);
    const patch: Partial<typeof mediaRequests.$inferInsert> = {
      status: 'approved',
      modifiedById: actor.userId,
      updatedAt: this.iso(),
    };
    if (overrides.rootFolderPath !== undefined) patch.rootFolderPath = overrides.rootFolderPath;
    if (overrides.qualityProfileId !== undefined) patch.qualityProfileId = overrides.qualityProfileId;
    if (overrides.tags !== undefined) patch.tags = overrides.tags;
    const approved = this.db.update(mediaRequests).set(patch).where(eq(mediaRequests.id, id)).returning().get()!;
    this.db.update(seasonRequests).set({ status: 'approved' }).where(eq(seasonRequests.requestId, id)).run();
    this.publish('approved', id);
    const sent = await this.sendToLibrary(approved);
    if (sent.status === 'approved') {
      await this.notifier.request('approved', sent).catch((err: unknown) => this.log?.warn({ err }, 'approved notification failed'));
    }
    return this.toResource(sent, actor);
  }

  async decline(actor: Actor, id: number, reason?: string): Promise<MediaRequest> {
    if (!canManageRequests(actor.permissions)) throw RequestsError.forbidden();
    const row = this.row(id);
    this.requirePending(row);
    const declined = this.db
      .update(mediaRequests)
      .set({ status: 'declined', modifiedById: actor.userId, declineReason: reason ?? null, updatedAt: this.iso() })
      .where(eq(mediaRequests.id, id))
      .returning()
      .get()!;
    this.db.update(seasonRequests).set({ status: 'declined' }).where(eq(seasonRequests.requestId, id)).run();
    this.publish('declined', id);
    await this.notifier.request('declined', declined, reason ? { reason } : {}).catch((err: unknown) => this.log?.warn({ err }, 'declined notification failed'));
    return this.toResource(declined, actor);
  }

  async retry(actor: Actor, id: number): Promise<MediaRequest> {
    if (!canManageRequests(actor.permissions)) throw RequestsError.forbidden();
    const row = this.row(id);
    if (row.status !== 'failed') throw new RequestsError('CONFLICT', `request ${id} is ${row.status}, not failed`);
    const approved = this.db
      .update(mediaRequests)
      .set({ status: 'approved', modifiedById: actor.userId, failureReason: null, updatedAt: this.iso() })
      .where(eq(mediaRequests.id, id))
      .returning()
      .get()!;
    this.db.update(seasonRequests).set({ status: 'approved' }).where(eq(seasonRequests.requestId, id)).run();
    this.publish('approved', id);
    return this.toResource(await this.sendToLibrary(approved), actor);
  }

  async bulk(actor: Actor, ids: number[], action: 'approve' | 'decline'): Promise<BulkRequestResult> {
    const result: BulkRequestResult = { ok: [], failed: [] };
    for (const id of ids) {
      try {
        const res = action === 'approve' ? await this.approve(actor, id) : await this.decline(actor, id);
        if (res.status === 'failed') result.failed.push({ id, error: res.failureReason ?? 'failed' });
        else result.ok.push(id);
      } catch (err) {
        result.failed.push({ id, error: err instanceof Error ? err.message : String(err) });
      }
    }
    return result;
  }

  async update(actor: Actor, id: number, input: UpdateRequest): Promise<MediaRequest> {
    const row = this.row(id);
    const manage = canManageRequests(actor.permissions);
    if (!manage && row.requestedById !== actor.userId) throw RequestsError.forbidden();
    this.requirePending(row);
    const advanced = canRequestAdvanced(actor.permissions);
    const patch: Partial<typeof mediaRequests.$inferInsert> = { updatedAt: this.iso(), modifiedById: actor.userId };
    if (input.rootFolderPath !== undefined || input.qualityProfileId !== undefined || input.tags !== undefined) {
      if (!advanced) throw RequestsError.forbidden('changing root folder, profile or tags needs Advanced requests');
      if (input.rootFolderPath !== undefined) patch.rootFolderPath = input.rootFolderPath;
      if (input.qualityProfileId !== undefined) patch.qualityProfileId = input.qualityProfileId;
      if (input.tags !== undefined) patch.tags = input.tags;
    }
    let owner = row.requestedById;
    if (input.userId !== undefined && input.userId !== row.requestedById) {
      if (!(manage || canManageUsers(actor.permissions))) throw RequestsError.forbidden('changing the requester needs Manage requests');
      owner = userRow(this.db, input.userId).id;
      patch.requestedById = owner;
    }
    let newSeasons: number[] | null = null;
    if (input.seasons !== undefined) {
      if (row.type !== 'series') throw new RequestsError('VALIDATION', 'seasons apply to series requests only');
      const settings = this.settings();
      const facts = await this.facts('series', row.tmdbId, false);
      newSeasons = this.requestableSeasons(facts, input.seasons, row.tmdbId, row.is4k, settings, row.id);
      if (newSeasons.length === 0) throw new RequestsError('VALIDATION', 'no seasons available to request');
      const current = new Set(this.seasonRows(id).map((s) => s.seasonNumber));
      const added = newSeasons.filter((n) => !current.has(n)).length;
      const ownerRow = userRow(this.db, owner);
      const held = userPermissions(ownerRow);
      if (added > 0 && !row.ignoreQuota && !isQuotaExempt(held)) {
        const quota = quotaFor(this.db, { id: owner, permissions: held, settings: ownerRow.settings }, settings.defaultQuotas, this.now()).status;
        if (quota.series.remaining !== null && added > quota.series.remaining) throw RequestsError.forbidden('Series Quota exceeded.');
      }
    }
    const updated = this.db.update(mediaRequests).set(patch).where(eq(mediaRequests.id, id)).returning().get()!;
    if (newSeasons) {
      this.db.delete(seasonRequests).where(eq(seasonRequests.requestId, id)).run();
      for (const seasonNumber of newSeasons) this.db.insert(seasonRequests).values({ requestId: id, seasonNumber, status: 'pending' }).run();
    }
    this.publish('updated', id);
    return this.toResource(updated, actor);
  }

  remove(actor: Actor, id: number): void {
    const row = this.row(id);
    const allowed = canManageRequests(actor.permissions) || (row.requestedById === actor.userId && row.status === 'pending');
    if (!allowed) throw RequestsError.forbidden('only pending requests of your own can be deleted');
    this.db.delete(mediaRequests).where(eq(mediaRequests.id, id)).run();
    this.publish('deleted', id);
  }

  // -------------------------------------------------------------------------------------
  // status sync (RequestsStatusSync)
  // -------------------------------------------------------------------------------------

  private upsertMediaStatus(
    type: MediaType,
    tmdbId: number,
    patch: Partial<Pick<typeof requestMediaStatus.$inferInsert, 'status' | 'status4k' | 'seasons' | 'libraryId' | 'lastSyncedAt'>>,
  ): void {
    const now = this.iso();
    const existing = this.db
      .select()
      .from(requestMediaStatus)
      .where(and(eq(requestMediaStatus.mediaType, type), eq(requestMediaStatus.tmdbId, tmdbId)))
      .get();
    if (existing) {
      this.db.update(requestMediaStatus).set({ ...patch, updatedAt: now }).where(eq(requestMediaStatus.id, existing.id)).run();
    } else {
      this.db
        .insert(requestMediaStatus)
        .values({ mediaType: type, tmdbId, status: 'unknown', status4k: 'unknown', seasons: [], updatedAt: now, ...patch })
        .run();
    }
  }

  /** Drops rows that belong to users who no longer exist (no cross-module foreign keys). */
  purgeOrphans(): number {
    const ids = allUserRows(this.db).map((u) => u.id);
    const keep = ids.length ? ids : [-1];
    let removed = 0;
    removed += this.db.delete(mediaRequests).where(sql`${mediaRequests.requestedById} not in (${sql.join(keep.map((id) => sql`${id}`), sql`, `)})`).run().changes;
    removed += this.db.delete(issues).where(sql`${issues.createdById} not in (${sql.join(keep.map((id) => sql`${id}`), sql`, `)})`).run().changes;
    removed += this.db.delete(issueComments).where(sql`${issueComments.userId} not in (${sql.join(keep.map((id) => sql`${id}`), sql`, `)})`).run().changes;
    removed += this.db.delete(watchlistItems).where(sql`${watchlistItems.userId} not in (${sql.join(keep.map((id) => sql`${id}`), sql`, `)})`).run().changes;
    return removed;
  }

  /**
   * Recomputes availability of every title with an open request (or a cached status), stores
   * it, and completes approved/pending requests whose track became available. Series
   * requests complete when every requested season is available.
   */
  async syncStatuses(signal?: AbortSignal): Promise<string> {
    const purged = this.purgeOrphans();
    const settings = this.settings();
    const open = this.db.select().from(mediaRequests).where(inArray(mediaRequests.status, ACTIVE)).all();
    const cached = this.db.select().from(requestMediaStatus).all();
    const useServer = settings.useMediaServerAvailability;
    let checked = 0;
    let completed = 0;
    for (const type of ['movie', 'series'] as const) {
      const ids = [...new Set([...open.filter((r) => r.type === type).map((r) => r.tmdbId), ...cached.filter((c) => c.mediaType === type).map((c) => c.tmdbId)])];
      if (ids.length === 0) continue;
      const lib = libraryAvailability(this.db, type, ids, { now: this.now(), includeSpecials: settings.enableSpecialEpisodes });
      for (const tmdbId of ids) {
        if (signal?.aborted) throw new Error('cancelled');
        checked++;
        const entry = lib.get(tmdbId);
        let status: MediaStatus = entry?.status ?? 'unknown';
        const seasons = (entry?.seasons ?? []).map((s) => ({ ...s }));
        let onServer = false;
        if (useServer && status !== 'available') {
          const mine = open.find((r) => r.type === type && r.tmdbId === tmdbId);
          onServer = (await this.mediaServer.isAvailable({ mediaType: type, tmdbId, tvdbId: mine?.tvdbId ?? null }, signal)) === true;
          if (onServer) status = 'available';
        }
        this.upsertMediaStatus(type, tmdbId, {
          status,
          status4k: entry?.status4k ?? 'unknown',
          seasons,
          libraryId: entry?.libraryId ?? null,
          lastSyncedAt: this.iso(),
        });
        for (const req of open.filter((r) => r.type === type && r.tmdbId === tmdbId && (r.status === 'approved' || r.status === 'pending'))) {
          if (entry && req.libraryId === null) {
            this.db.update(mediaRequests).set({ libraryId: entry.libraryId }).where(eq(mediaRequests.id, req.id)).run();
          }
          let done: boolean;
          if (type === 'movie') {
            done = (req.is4k ? entry?.status4k : status) === 'available';
          } else {
            const map = seasonStatusMap(seasons, req.is4k);
            const requested = this.seasonRows(req.id);
            for (const sr of requested) {
              if (map.get(sr.seasonNumber) === 'available' && sr.status !== 'completed') {
                this.db.update(seasonRequests).set({ status: 'completed' }).where(eq(seasonRequests.id, sr.id)).run();
              }
            }
            done =
              requested.length > 0 &&
              ((onServer && !req.is4k) || requested.every((sr) => map.get(sr.seasonNumber) === 'available'));
          }
          if (done) {
            await this.complete(this.row(req.id));
            completed++;
          }
        }
      }
    }
    return `${checked} titles checked, ${completed} requests completed${purged ? `, ${purged} orphaned rows removed` : ''}`;
  }

  // -------------------------------------------------------------------------------------
  // users: permissions, quotas, personal settings
  // -------------------------------------------------------------------------------------

  private assertSelfOrManager(actor: Actor, userId: number): void {
    if (actor.userId !== userId && !canManageUsers(actor.permissions)) throw RequestsError.forbidden();
  }

  permissions(actor: Actor, userId: number): UserPermissions {
    this.assertSelfOrManager(actor, userId);
    return { permissions: userPermissions(userRow(this.db, userId)) };
  }

  setPermissions(actor: Actor, userId: number, permissions: number): UserPermissions {
    if (!canManageUsers(actor.permissions)) throw RequestsError.forbidden();
    const target = userRow(this.db, userId);
    if (target.role === 'admin' && (actor.permissions & Permission.ADMIN) === 0) throw RequestsError.forbidden('only admins can change an admin');
    const saved = setUserPermissions(this.db, userId, permissions, this.iso());
    return { permissions: userPermissions(saved) };
  }

  quota(actor: Actor, userId: number): UserQuotaResponse {
    this.assertSelfOrManager(actor, userId);
    const row = userRow(this.db, userId);
    return quotaFor(this.db, { id: row.id, permissions: userPermissions(row), settings: row.settings }, this.settings().defaultQuotas, this.now());
  }

  setQuota(actor: Actor, userId: number, quota: UserQuota): UserQuotaResponse {
    if (!canManageUsers(actor.permissions)) throw RequestsError.forbidden();
    patchUserSettings(this.db, userId, { quota: UserQuota.parse(quota) }, this.iso());
    return this.quota(actor, userId);
  }

  requestSettings(actor: Actor, userId: number): UserRequestSettings {
    this.assertSelfOrManager(actor, userId);
    const settings = requestSettingsOf(userRow(this.db, userId));
    return settings.plexToken ? { ...settings, plexToken: REQUEST_SECRET_MASK } : settings;
  }

  setRequestSettings(actor: Actor, userId: number, input: UserRequestSettings): UserRequestSettings {
    this.assertSelfOrManager(actor, userId);
    const parsed = UserRequestSettings.parse(input);
    const url = parsed.notifications.discordWebhookUrl;
    if (url && !/^https?:\/\//.test(url)) throw new RequestsError('VALIDATION', 'the Discord webhook must be an http(s) URL');
    const stored = requestSettingsOf(userRow(this.db, userId));
    const plexToken = parsed.plexToken === REQUEST_SECRET_MASK ? stored.plexToken : parsed.plexToken || undefined;
    patchUserSettings(
      this.db,
      userId,
      {
        notifications: parsed.notifications,
        plexToken,
        watchlistSyncMovies: parsed.watchlistSyncMovies,
        watchlistSyncSeries: parsed.watchlistSyncSeries,
      },
      this.iso(),
    );
    return this.requestSettings(actor, userId);
  }

  async testNotifications(actor: Actor, userId: number): Promise<UserNotificationTestResult> {
    this.assertSelfOrManager(actor, userId);
    userRow(this.db, userId);
    return this.notifier.testUser(userId);
  }

  // -------------------------------------------------------------------------------------
  // override rules
  // -------------------------------------------------------------------------------------

  private toRule(row: OverrideRow): OverrideRule {
    return {
      id: row.id,
      name: row.name,
      mediaType: row.mediaType,
      is4k: row.is4k,
      enabled: row.enabled,
      users: row.users,
      genres: row.genres,
      languages: row.languages,
      keywords: row.keywords,
      qualityProfileId: row.qualityProfileId,
      rootFolderPath: row.rootFolderPath,
      tags: row.tags,
      autoApprove: row.autoApprove,
    };
  }

  listRules(actor: Actor): OverrideRule[] {
    if (!canManageSettings(actor.permissions)) throw RequestsError.forbidden();
    return this.db.select().from(overrideRules).orderBy(asc(overrideRules.id)).all().map((r) => this.toRule(r));
  }

  createRule(actor: Actor, raw: OverrideRuleInput): OverrideRule {
    if (!canManageSettings(actor.permissions)) throw RequestsError.forbidden();
    const input = OverrideRuleInput.parse(raw);
    const now = this.iso();
    return this.toRule(this.db.insert(overrideRules).values({ ...input, createdAt: now, updatedAt: now }).returning().get());
  }

  updateRule(actor: Actor, id: number, raw: OverrideRuleInput): OverrideRule {
    if (!canManageSettings(actor.permissions)) throw RequestsError.forbidden();
    const input = OverrideRuleInput.parse(raw);
    const row = this.db.update(overrideRules).set({ ...input, updatedAt: this.iso() }).where(eq(overrideRules.id, id)).returning().get();
    if (!row) throw RequestsError.notFound('override rule', id);
    return this.toRule(row);
  }

  deleteRule(actor: Actor, id: number): void {
    if (!canManageSettings(actor.permissions)) throw RequestsError.forbidden();
    const res = this.db.delete(overrideRules).where(eq(overrideRules.id, id)).run();
    if (res.changes === 0) throw RequestsError.notFound('override rule', id);
  }

  /** Users the given actor may see by id (for findUserRow-based checks elsewhere). */
  userExists(id: number): boolean {
    return findUserRow(this.db, id) !== undefined;
  }
}
