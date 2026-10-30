import { and, asc, desc, eq, inArray, type SQL } from 'drizzle-orm';
import type { Logger } from 'pino';
import {
  AdditionalLanguageRequest,
  ApproveLanguageRequest,
  CreateLanguageRequest,
  LanguageRequestListQuery,
  type AdditionalAudioMode,
  type AdditionalLanguageOutcome,
  type AdditionalLanguageResult,
  type AdditionalLanguageTarget,
  type ItemLanguages,
  type ItemLanguagesQuery,
  type LanguageRequest,
  type LanguageRequestCount,
  type LanguageRequestOptions,
  type LanguageRequestOptionsQuery,
  type LanguageRequestPage,
  type MediaImage,
  type MediaType,
  type RequestStatus,
  type ServerEvent,
  type SubtitleLanguageOption,
} from '@arclight/shared';
import type { Db } from '../../db/index.js';
import { listSearchCondition } from '../../db/list-search.js';
import { additionalLanguages } from '../../db/schema.js';
import type { EventBus } from '../../events.js';
import { baseLanguages, displayLanguage, normalizeLanguage, scopeKeyOf } from '../additional-languages/audio.js';
import { libraryService } from '../library/index.js';
import { getSection } from '../settings/service.js';
import { RequestsError } from './errors.js';
import type { RequestNotifier } from './notify.js';
import { type Actor, canAutoApproveLanguage, canManageRequests, canManageUsers, canRequestLanguage, canViewAllRequests } from './permissions.js';
import { languageRequests } from './schema.js';
import { ownerUser, requestUsers, userNameSearchColumns, userPermissions, userRow, type UserRow } from './users.js';

// Subtitle and audio language requests (docs/API.md "Subtitle and language requests"). A user
// asks for subtitles in a language, or an additional audio language, on a title already in
// the library; approval hands the item to "Add additional…" (the additional-languages module)
// with a search right away. Lifecycle as for other requests:
//
//   pending → approved → completed, or declined / failed.
//
// Approved requests complete once the linked additional-language records report the language
// found / grabbed / present / a version slot added, or the item now has the language anyway
// (checked again by RequestsStatusSync and whenever the item changes). failed / noFile fail the
// request; notFound and searching keep it approved while the wanted machinery keeps trying.
// Language requests never count toward media quotas.

export type LanguageRequestRow = typeof languageRequests.$inferSelect;

/** What the service needs from "Add additional…" and the subtitles language list. */
export interface LanguagesPort {
  preview(req: AdditionalLanguageRequest): Promise<AdditionalLanguageResult>;
  apply(req: AdditionalLanguageRequest): Promise<AdditionalLanguageResult>;
  itemLanguages(q: ItemLanguagesQuery): ItemLanguages;
  /** The languages the subtitle and additional-language pickers offer. */
  languages(): SubtitleLanguageOption[];
}

export interface LanguageRequestsServiceOptions {
  db: Db;
  bus: EventBus;
  log?: Logger;
  notifier: RequestNotifier;
  /** Resolved per call: the additional-languages module may register after this one. */
  languages: () => LanguagesPort;
  now?: () => Date;
}

/** Requests that block an identical new one. */
const ACTIVE: RequestStatus[] = ['pending', 'approved'];
/** Outcomes that complete a request, and those that fail it. */
const DONE: readonly AdditionalLanguageOutcome[] = ['found', 'grabbed', 'alreadyPresent', 'versionAdded'];
const FAILED: readonly AdditionalLanguageOutcome[] = ['failed', 'noFile'];

/** One library item and the scope of a request on it. */
interface Item {
  mediaType: MediaType;
  movieId: number | null;
  seriesId: number | null;
  seasonNumber: number | null;
  tmdbId: number;
  title: string;
  year: number | null;
  poster: string | null;
}

function posterOf(images: readonly MediaImage[]): string | null {
  const poster = images.find((i) => i.coverType === 'poster');
  return poster ? (poster.remoteUrl ?? poster.url) : null;
}

function kindLabel(kind: LanguageRequestRow['kind']): string {
  return kind === 'audio' ? 'audio' : 'subtitles';
}

export class LanguageRequestsService {
  private readonly db: Db;
  private readonly bus: EventBus;
  private readonly log: Logger | undefined;
  private readonly notifier: RequestNotifier;
  private readonly port: () => LanguagesPort;
  private readonly now: () => Date;
  /** Background work: auto-approved requests being applied, re-checks after item changes. */
  private readonly pending = new Set<Promise<unknown>>();

  constructor(opts: LanguageRequestsServiceOptions) {
    this.db = opts.db;
    this.bus = opts.bus;
    this.log = opts.log;
    this.notifier = opts.notifier;
    this.port = opts.languages;
    this.now = opts.now ?? (() => new Date());
  }

  private iso(): string {
    return this.now().toISOString();
  }

  private publish(action: Extract<ServerEvent, { type: 'request' }>['action'], id: number): void {
    this.bus.publish({ type: 'request', action, id, language: true });
  }

  private notify(kind: Parameters<RequestNotifier['languageRequest']>[0], row: LanguageRequestRow, extra: { reason?: string } = {}): Promise<void> {
    return this.notifier.languageRequest(kind, row, extra).catch((err: unknown) => this.log?.warn({ err }, `language request ${kind} notification failed`));
  }

  private track<T>(work: Promise<T>): void {
    const tracked: Promise<unknown> = work.catch((err: unknown) => this.log?.warn({ err }, 'language request background work failed')).finally(() => this.pending.delete(tracked));
    this.pending.add(tracked);
  }

  /** Resolves once background applies and re-checks have settled (tests, shutdown). */
  async whenIdle(): Promise<void> {
    while (this.pending.size > 0) await Promise.allSettled([...this.pending]);
  }

  // -------------------------------------------------------------------------------------
  // resource mapping
  // -------------------------------------------------------------------------------------

  row(id: number): LanguageRequestRow {
    const row = this.db.select().from(languageRequests).where(eq(languageRequests.id, id)).get();
    if (!row) throw RequestsError.notFound('language request', id);
    return row;
  }

  toResources(rows: LanguageRequestRow[], actor: Actor): LanguageRequest[] {
    if (rows.length === 0) return [];
    const users = requestUsers(this.db, rows.flatMap((r) => [r.requestedById, r.modifiedById]));
    const manage = canManageRequests(actor.permissions);
    return rows.map((r) => ({
      id: r.id,
      kind: r.kind,
      status: r.status,
      mediaType: r.mediaType,
      movieId: r.movieId,
      seriesId: r.seriesId,
      seasonNumber: r.seasonNumber,
      tmdbId: r.tmdbId,
      title: r.title,
      year: r.year,
      poster: r.poster,
      language: r.language,
      languageName: displayLanguage(r.language),
      forced: r.forced,
      hi: r.hi,
      mode: r.mode,
      note: r.note,
      requestedBy: users.get(r.requestedById) ?? { id: r.requestedById, username: `deleted user ${r.requestedById}` },
      modifiedBy: r.modifiedById === null ? null : (users.get(r.modifiedById) ?? null),
      declineReason: r.declineReason,
      failureReason: r.failureReason,
      outcome: r.outcome,
      outcomeMessage: r.outcomeMessage,
      additionalLanguageIds: r.additionalLanguageIds,
      canRemove: manage || (r.requestedById === actor.userId && r.status === 'pending'),
      createdAt: r.createdAt,
      updatedAt: r.updatedAt,
    }));
  }

  toResource(row: LanguageRequestRow, actor: Actor): LanguageRequest {
    return this.toResources([row], actor)[0]!;
  }

  // -------------------------------------------------------------------------------------
  // reading
  // -------------------------------------------------------------------------------------

  /** Own requests unless the actor may view everyone's (as for video requests). */
  private scope(actor: Actor, requestedBy?: number): SQL | undefined {
    if (canViewAllRequests(actor.permissions)) return requestedBy === undefined ? undefined : eq(languageRequests.requestedById, requestedBy);
    if (requestedBy !== undefined && requestedBy !== actor.userId) throw RequestsError.forbidden('you may only view your own requests');
    return eq(languageRequests.requestedById, actor.userId ?? -1);
  }

  get(actor: Actor, id: number): LanguageRequest {
    const row = this.row(id);
    if (row.requestedById !== actor.userId && !canViewAllRequests(actor.permissions)) throw RequestsError.forbidden();
    return this.toResource(row, actor);
  }

  list(actor: Actor, rawQuery: LanguageRequestListQuery): LanguageRequestPage {
    const q = LanguageRequestListQuery.parse(rawQuery);
    const where: SQL[] = [];
    const scope = this.scope(actor, q.requestedBy);
    if (scope) where.push(scope);
    if (q.kind !== 'all') where.push(eq(languageRequests.kind, q.kind));
    if (q.filter !== 'all') where.push(eq(languageRequests.status, q.filter));
    const search = listSearchCondition(q.q, [
      languageRequests.title,
      languageRequests.year,
      languageRequests.kind,
      languageRequests.status,
      languageRequests.language,
      languageRequests.note,
      languageRequests.declineReason,
      languageRequests.failureReason,
      ...userNameSearchColumns(languageRequests.requestedById),
    ]);
    if (search) where.push(search);
    const rows = this.db
      .select()
      .from(languageRequests)
      .where(where.length ? and(...where) : undefined)
      .orderBy(q.sortDirection === 'asc' ? asc(languageRequests.id) : desc(languageRequests.id))
      .all();
    const page = rows.slice(q.skip, q.skip + q.take);
    return { pageInfo: { total: rows.length, take: q.take, skip: q.skip }, results: this.toResources(page, actor) };
  }

  count(actor: Actor): LanguageRequestCount {
    const rows = this.db.select({ kind: languageRequests.kind, status: languageRequests.status }).from(languageRequests).where(this.scope(actor)).all();
    return {
      total: rows.length,
      subtitle: rows.filter((r) => r.kind === 'subtitle').length,
      audio: rows.filter((r) => r.kind === 'audio').length,
      pending: rows.filter((r) => r.status === 'pending').length,
    };
  }

  /** Pending requests of everyone (the admin digest and badge). */
  pendingRows(): LanguageRequestRow[] {
    return this.db.select().from(languageRequests).where(eq(languageRequests.status, 'pending')).orderBy(asc(languageRequests.createdAt), asc(languageRequests.id)).all();
  }

  languages(): SubtitleLanguageOption[] {
    return this.port().languages();
  }

  /** The library item of a title, or null when it is not in the library. */
  private libraryItem(mediaType: MediaType, tmdbId: number): Omit<Item, 'seasonNumber'> | null {
    if (mediaType === 'movie') {
      const movie = libraryService.findMovieByTmdbId(this.db, tmdbId);
      if (!movie) return null;
      return { mediaType, movieId: movie.id, seriesId: null, tmdbId, title: movie.title, year: movie.year || null, poster: posterOf(movie.images) };
    }
    const show = libraryService.findSeriesByTmdbId(this.db, tmdbId);
    if (!show) return null;
    return { mediaType, movieId: null, seriesId: show.id, tmdbId, title: show.title, year: show.year || null, poster: posterOf(show.images) };
  }

  /** Seasons of a library series that have at least one file. */
  private seasonsWithFiles(seriesId: number): Array<{ seasonNumber: number; files: number }> {
    const counts = new Map<number, number>();
    for (const e of libraryService.listEpisodes(this.db, { seriesId })) {
      if (e.hasFile) counts.set(e.seasonNumber, (counts.get(e.seasonNumber) ?? 0) + 1);
    }
    return [...counts].sort((a, b) => a[0] - b[0]).map(([seasonNumber, files]) => ({ seasonNumber, files }));
  }

  private openRowsOf(item: Pick<Item, 'movieId' | 'seriesId'>): LanguageRequestRow[] {
    const of = item.movieId !== null ? eq(languageRequests.movieId, item.movieId) : eq(languageRequests.seriesId, item.seriesId ?? -1);
    return this.db.select().from(languageRequests).where(and(of, inArray(languageRequests.status, ACTIVE))).orderBy(asc(languageRequests.id)).all();
  }

  /** GET /request/language/options: what the request dialog shows for a title. */
  options(actor: Actor, q: LanguageRequestOptionsQuery): LanguageRequestOptions {
    const item = this.libraryItem(q.mediaType, q.tmdbId);
    const canRequest = canRequestLanguage(actor.permissions);
    const empty: LanguageRequestOptions = { inLibrary: false, mediaType: q.mediaType, movieId: null, seriesId: null, seasons: [], audio: [], subtitles: [], openRequests: [], canRequest };
    if (!item) return empty;
    const seasons = item.seriesId !== null ? this.seasonsWithFiles(item.seriesId) : [];
    const hasFiles = item.movieId !== null ? libraryService.getMovie(this.db, item.movieId).hasFile : seasons.length > 0;
    const langs = this.port().itemLanguages(item.movieId !== null ? { movieId: item.movieId } : { seriesId: item.seriesId! });
    return {
      inLibrary: hasFiles,
      mediaType: item.mediaType,
      movieId: item.movieId,
      seriesId: item.seriesId,
      seasons,
      audio: langs.audio,
      subtitles: langs.subtitles,
      openRequests: this.openRowsOf(item).map((r) => ({
        id: r.id,
        kind: r.kind,
        status: r.status,
        seasonNumber: r.seasonNumber,
        language: r.language,
        forced: r.forced,
        hi: r.hi,
        mine: r.requestedById === actor.userId,
      })),
      canRequest,
    };
  }

  // -------------------------------------------------------------------------------------
  // creation
  // -------------------------------------------------------------------------------------

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

  /** A known language as stored: the full tag for subtitles, the base tag for audio. */
  private languageOf(kind: LanguageRequestRow['kind'], input: string): string {
    const tag = normalizeLanguage(input);
    if (!tag || !this.port().languages().some((l) => l.code === tag)) throw new RequestsError('VALIDATION', `unknown language: ${input}`);
    return kind === 'audio' ? (baseLanguages([tag])[0] ?? tag) : tag;
  }

  private targetOf(r: Pick<LanguageRequestRow, 'movieId' | 'seriesId' | 'seasonNumber'>): AdditionalLanguageTarget {
    if (r.movieId !== null) return { movieId: r.movieId };
    return { seriesId: r.seriesId!, ...(r.seasonNumber !== null ? { seasonNumber: r.seasonNumber } : {}) };
  }

  private additionalRequest(r: Pick<LanguageRequestRow, 'kind' | 'movieId' | 'seriesId' | 'seasonNumber' | 'language' | 'forced' | 'hi'>, mode: AdditionalAudioMode): AdditionalLanguageRequest {
    const targets = [this.targetOf(r)];
    return AdditionalLanguageRequest.parse(
      r.kind === 'subtitle'
        ? { kind: 'subtitle', targets, languages: [{ code: r.language, forced: r.forced, hi: r.hi }], searchNow: true }
        : { kind: 'audio', targets, language: r.language, mode, searchNow: true },
    );
  }

  /** Words for messages: "Spanish subtitles", "Spanish audio". */
  private describe(r: Pick<LanguageRequestRow, 'kind' | 'language'>): string {
    return `${displayLanguage(r.language)} ${kindLabel(r.kind)}`;
  }

  async create(actor: Actor, raw: CreateLanguageRequest): Promise<LanguageRequest> {
    const input = CreateLanguageRequest.parse(raw);
    const requester = this.resolveRequester(actor, input.userId);
    const held = userPermissions(requester);
    if (!canRequestLanguage(held)) throw RequestsError.forbidden('not allowed to request subtitles or languages');
    const found = this.libraryItem(input.mediaType, input.tmdbId);
    if (!found) throw new RequestsError('VALIDATION', 'this title is not in the library');
    const language = this.languageOf(input.kind, input.language);
    const seasonNumber = input.seasonNumber ?? null;
    if (seasonNumber !== null && !this.seasonsWithFiles(found.seriesId!).some((s) => s.seasonNumber === seasonNumber)) {
      throw new RequestsError('VALIDATION', `season ${seasonNumber} has no files yet`);
    }
    // Audio has no forced / HI modes; store the additional-languages defaults.
    const forced = input.kind === 'subtitle' ? input.forced : 'never';
    const hi = input.kind === 'subtitle' ? input.hi : 'also';
    const draft = { kind: input.kind, ...found, seasonNumber, language, forced, hi };
    const what = this.describe(draft);

    // An identical open request: the same language (and modes) on the same scope or the whole series.
    const duplicate = this.openRowsOf(found).find(
      (r) => r.kind === input.kind && r.language === language && r.forced === forced && r.hi === hi && (r.seasonNumber === null || r.seasonNumber === seasonNumber),
    );
    if (duplicate) throw new RequestsError('CONFLICT', `${what} were already requested for this title (#${duplicate.id})`);

    // Already asked for with "Add additional…" on this scope (or the whole item).
    const langs = this.port().itemLanguages(found.movieId !== null ? { movieId: found.movieId } : { seriesId: found.seriesId!, ...(seasonNumber !== null ? { seasonNumber } : {}) });
    const saved = langs.records.find(
      (r) =>
        r.kind === input.kind &&
        r.status !== 'failed' &&
        r.episodeId === null &&
        (r.seasonNumber === null || r.seasonNumber === seasonNumber) &&
        (input.kind === 'audio' ? baseLanguages([r.language])[0] === language : r.language === language && r.forced === forced && r.hi === hi),
    );
    if (saved) throw new RequestsError('CONFLICT', `${what} are already being looked for on this title`);

    // Present on every file of the scope already, or nothing to add them to.
    const plan = (await this.port().preview(this.additionalRequest(draft, 'replace'))).items[0];
    if (plan?.outcome === 'alreadyPresent') throw new RequestsError('CONFLICT', `this title already has ${what}`);
    if (plan?.outcome === 'noFile') throw new RequestsError('VALIDATION', 'this title has no files yet');

    const settings = getSection(this.db, 'requests');
    const bySettings = input.kind === 'subtitle' ? settings.autoApproveSubtitleRequests : settings.autoApproveAudioRequests;
    const autoApproved = bySettings || canAutoApproveLanguage(held) || canAutoApproveLanguage(actor.permissions);
    const now = this.iso();
    const row = this.db
      .insert(languageRequests)
      .values({
        ...draft,
        status: autoApproved ? 'approved' : 'pending',
        mode: autoApproved && input.kind === 'audio' ? 'replace' : null,
        note: input.note ? input.note : null,
        requestedById: requester.id,
        modifiedById: autoApproved ? requester.id : null,
        additionalLanguageIds: [],
        createdAt: now,
        updatedAt: now,
      })
      .returning()
      .get();
    this.log?.info({ languageRequestId: row.id, kind: row.kind, language, status: row.status }, 'language request created');
    this.publish('created', row.id);
    await this.notify('created', row);
    // The search may take a while: the caller gets the approved request, the outcome follows.
    if (autoApproved) this.track(this.sendToAdditional(row, 'replace'));
    return this.toResource(row, actor);
  }

  // -------------------------------------------------------------------------------------
  // approval: into "Add additional…"
  // -------------------------------------------------------------------------------------

  private patch(id: number, values: Partial<typeof languageRequests.$inferInsert>): LanguageRequestRow {
    return this.db
      .update(languageRequests)
      .set({ ...values, updatedAt: this.iso() })
      .where(eq(languageRequests.id, id))
      .returning()
      .get()!;
  }

  private fail(row: LanguageRequestRow, reason: string, extra: Partial<typeof languageRequests.$inferInsert> = {}): LanguageRequestRow {
    const current = this.row(row.id);
    if (!ACTIVE.includes(current.status)) return current;
    this.log?.warn({ languageRequestId: row.id, reason }, 'language request failed');
    const failed = this.patch(row.id, { ...extra, status: 'failed', failureReason: reason });
    this.publish('failed', row.id);
    return failed;
  }

  private async complete(row: LanguageRequestRow, extra: Partial<typeof languageRequests.$inferInsert> = {}): Promise<LanguageRequestRow> {
    // Re-checks can overlap (several library events at once): complete and notify only once.
    const current = this.row(row.id);
    if (current.status !== 'approved') return current;
    const done = this.patch(row.id, { ...extra, status: 'completed', failureReason: null });
    this.publish('completed', row.id);
    await this.notify('available', done);
    return done;
  }

  /** The additional-language records an approval saved for the request's scope and language. */
  private linkedIds(row: LanguageRequestRow): number[] {
    const scopeKey = scopeKeyOf({ movieId: row.movieId, seriesId: row.seriesId, seasonNumber: row.seasonNumber, episodeId: null });
    return this.db
      .select({ id: additionalLanguages.id })
      .from(additionalLanguages)
      .where(and(eq(additionalLanguages.kind, row.kind), eq(additionalLanguages.scopeKey, scopeKey), eq(additionalLanguages.language, row.language)))
      .all()
      .map((r) => r.id);
  }

  /** Moves an approved request on from an outcome: completed, failed, or still approved. */
  private async settle(row: LanguageRequestRow, outcome: AdditionalLanguageOutcome, message: string, extra: Partial<typeof languageRequests.$inferInsert> = {}): Promise<LanguageRequestRow> {
    const values = { ...extra, outcome, outcomeMessage: message };
    if (DONE.includes(outcome)) return this.complete(row, values);
    if (FAILED.includes(outcome)) return this.fail(row, message || `Could not add ${this.describe(row)}`, values);
    const updated = this.patch(row.id, values);
    this.publish('updated', row.id);
    return updated;
  }

  /** Runs "Add additional…" for an approved request and records the outcome; errors fail it. */
  async sendToAdditional(row: LanguageRequestRow, mode: AdditionalAudioMode): Promise<LanguageRequestRow> {
    try {
      const result = await this.port().apply(this.additionalRequest(row, mode));
      const current = this.row(row.id);
      // Declined or deleted meanwhile: leave it alone.
      if (current.status !== 'approved') return current;
      const item = result.items[0];
      if (!item) return this.fail(current, `Could not add ${this.describe(row)}: the item was not found`);
      return await this.settle(current, item.outcome, item.message, { additionalLanguageIds: this.linkedIds(row) });
    } catch (err) {
      const current = this.db.select().from(languageRequests).where(eq(languageRequests.id, row.id)).get();
      if (current?.status !== 'approved') return current ?? row;
      return this.fail(current, err instanceof Error ? err.message : String(err));
    }
  }

  private requirePending(row: LanguageRequestRow): void {
    if (row.status !== 'pending') throw new RequestsError('CONFLICT', `request ${row.id} is ${row.status}, not pending`);
  }

  async approve(actor: Actor, id: number, raw: ApproveLanguageRequest = {}): Promise<LanguageRequest> {
    if (!canManageRequests(actor.permissions)) throw RequestsError.forbidden();
    const body = ApproveLanguageRequest.parse(raw ?? {});
    const row = this.row(id);
    this.requirePending(row);
    if (body.mode !== undefined && row.kind !== 'audio') throw new RequestsError('VALIDATION', 'mode applies to audio requests only');
    const mode = row.kind === 'audio' ? (body.mode ?? 'replace') : null;
    const approved = this.patch(id, { status: 'approved', modifiedById: actor.userId, mode });
    this.publish('approved', id);
    const sent = await this.sendToAdditional(approved, mode ?? 'replace');
    if (sent.status === 'approved') await this.notify('approved', sent);
    return this.toResource(sent, actor);
  }

  async decline(actor: Actor, id: number, reason?: string): Promise<LanguageRequest> {
    if (!canManageRequests(actor.permissions)) throw RequestsError.forbidden();
    const row = this.row(id);
    this.requirePending(row);
    const declined = this.patch(id, { status: 'declined', modifiedById: actor.userId, declineReason: reason ?? null });
    this.publish('declined', id);
    await this.notify('declined', declined, reason ? { reason } : {});
    return this.toResource(declined, actor);
  }

  async retry(actor: Actor, id: number): Promise<LanguageRequest> {
    if (!canManageRequests(actor.permissions)) throw RequestsError.forbidden();
    const row = this.row(id);
    if (row.status !== 'failed') throw new RequestsError('CONFLICT', `request ${id} is ${row.status}, not failed`);
    const approved = this.patch(id, { status: 'approved', modifiedById: actor.userId, failureReason: null });
    this.publish('approved', id);
    return this.toResource(await this.sendToAdditional(approved, row.mode ?? 'replace'), actor);
  }

  remove(actor: Actor, id: number): void {
    const row = this.row(id);
    const allowed = canManageRequests(actor.permissions) || (row.requestedById === actor.userId && row.status === 'pending');
    if (!allowed) throw RequestsError.forbidden('only pending requests of your own can be deleted');
    this.db.delete(languageRequests).where(eq(languageRequests.id, id)).run();
    this.publish('deleted', id);
  }

  // -------------------------------------------------------------------------------------
  // completion (RequestsStatusSync and library events)
  // -------------------------------------------------------------------------------------

  /**
   * Re-checks one approved request: the linked records' outcomes first (all done: completed;
   * one failed: failed), then whether the item has the language on every file of the scope now
   * (a scheduled search found it later). Anything else leaves it approved.
   */
  async refresh(row: LanguageRequestRow): Promise<LanguageRequestRow> {
    if (row.status !== 'approved') return row;
    const linked = row.additionalLanguageIds.length
      ? this.db.select().from(additionalLanguages).where(inArray(additionalLanguages.id, row.additionalLanguageIds)).all()
      : [];
    if (row.additionalLanguageIds.length > 0 && linked.length === 0) {
      return this.fail(row, `The additional ${kindLabel(row.kind)} language was removed from the title`);
    }
    const failed = linked.find((l) => FAILED.includes(l.status));
    if (failed) return this.settle(row, failed.status, failed.message);
    if (linked.length > 0 && linked.every((l) => DONE.includes(l.status))) return this.settle(row, linked[0]!.status, linked[0]!.message);
    try {
      const plan = (await this.port().preview(this.additionalRequest(row, row.mode ?? 'replace'))).items[0];
      if (plan?.outcome === 'alreadyPresent') return this.complete(this.row(row.id), { outcome: 'alreadyPresent', outcomeMessage: `Now has ${this.describe(row)}.` });
    } catch (err) {
      this.log?.debug({ err, languageRequestId: row.id }, 'language request check skipped');
    }
    const latest = linked[0];
    if (latest && (latest.status !== row.outcome || latest.message !== row.outcomeMessage)) {
      const updated = this.patch(row.id, { outcome: latest.status, outcomeMessage: latest.message });
      this.publish('updated', row.id);
      return updated;
    }
    return row;
  }

  /** Part of RequestsStatusSync: re-checks every approved request. */
  async syncStatuses(signal?: AbortSignal): Promise<string> {
    const open = this.db.select().from(languageRequests).where(eq(languageRequests.status, 'approved')).all();
    let completed = 0;
    let failed = 0;
    for (const row of open) {
      if (signal?.aborted) throw new Error('cancelled');
      const after = await this.refresh(row);
      if (after.status === 'completed') completed++;
      else if (after.status === 'failed') failed++;
    }
    return `${open.length} language requests checked, ${completed} completed, ${failed} failed`;
  }

  private rowsOfItem(mediaType: MediaType, id: number, statuses: RequestStatus[]): LanguageRequestRow[] {
    const col = mediaType === 'movie' ? languageRequests.movieId : languageRequests.seriesId;
    return this.db
      .select()
      .from(languageRequests)
      .where(and(eq(languageRequests.mediaType, mediaType), eq(col, id), inArray(languageRequests.status, statuses)))
      .all();
  }

  /** The item changed (a search finished, a file imported): re-check its approved requests. */
  itemUpdated(mediaType: MediaType, id: number): void {
    const rows = this.rowsOfItem(mediaType, id, ['approved']);
    if (rows.length === 0) return;
    this.track(
      (async () => {
        for (const row of rows) await this.refresh(this.row(row.id));
      })(),
    );
  }

  /** The item left the library: its open requests fail (closed ones stay as history). */
  itemDeleted(mediaType: MediaType, id: number): void {
    for (const row of this.rowsOfItem(mediaType, id, ACTIVE)) this.fail(row, 'The title was removed from the library');
  }
}
