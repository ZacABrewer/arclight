import { and, asc, desc, eq, inArray, type SQL } from 'drizzle-orm';
import { isMbid } from '@arclight/metadata';
import {
  AddArtistRequest,
  AddAuthorRequest,
  AddBookRequest,
  AudioRequestDefaults,
  AudioRequestListQuery,
  CreateAudioRequest,
  audioRequestDomain,
  type AudioRequest,
  type AudioRequestCount,
  type AudioRequestKind,
  type AudioRequestPage,
  type RequestStatus,
  type ServerEvent,
} from '@arclight/shared';
import type { Logger } from 'pino';
import type { Db } from '../../db/index.js';
import { listSearchCondition } from '../../db/list-search.js';
import { albums, qualityProfiles, rootFolders } from '../../db/schema.js';
import type { EventBus } from '../../events.js';
import * as ab from '../audiobooks/service.js';
import * as music from '../music/service.js';
import { getSection, setSection } from '../settings/service.js';
import type { AudioDiscoverService } from './audio-discover.js';
import { audioLibraryStatus, normalizeForeignId, overlayAudioRequest, type AudioLibraryEntry } from './audio-status.js';
import { RequestsError } from './errors.js';
import type { RequestNotifier } from './notify.js';
import { type Actor, canAutoApproveAudio, canManageRequests, canManageSettings, canManageUsers, canRequestAudio, canViewAllRequests } from './permissions.js';
import { audioRequests } from './schema.js';
import { ownerUser, requestUsers, userNameSearchColumns, userPermissions, userRow, type UserRow } from './users.js';

// Music and audiobook requests (design music-audiobooks.md section 11; the video flow is in
// service.ts). Same lifecycle as video requests: pending → approved → completed, or declined /
// failed. Approval adds the item to the music or audiobook library and searches:
//
// * album: the artist is added (monitor "none", new albums "none") unless already present; once
//   its release groups are synced the album is monitored and an AlbumSearch runs. An artist that
//   is already in the library is refreshed first when the album row is not there yet.
// * artist: added with every album monitored and search on add (or monitored + ArtistSearch).
// * book: added by ASIN (its author created when new, other books unmonitored) with search on
//   add (or monitored + BookSearch).
// * author: added with every book monitored and search on add (or monitored + AuthorSearch).
//
// Root folder and quality profile come from the `audioRequests` settings section, else the
// first root folder of the media type and the first quality profile of the domain. Anything
// that goes wrong marks the request failed with a reason (retry re-runs the approval). The
// status sync completes approved requests once the item is available.

export type AudioRequestRow = typeof audioRequests.$inferSelect;

/** Where approvals write (the music/audiobook refreshers in production, fakes in tests). */
export interface AudioLibraryPort {
  /** Inserts the artist and starts ArtistAdd; `done` settles when the albums are synced. */
  addArtist(req: AddArtistRequest): Promise<{ id: number; done: Promise<unknown> }>;
  /** RefreshArtist; resolves when it finished. */
  refreshArtist(id: number): Promise<unknown>;
  addAuthor(req: AddAuthorRequest): Promise<{ id: number }>;
  addBook(req: AddBookRequest): Promise<{ id: number }>;
  /** AlbumSearch / ArtistSearch / BookSearch / AuthorSearch for library ids (detached). */
  search(kind: AudioRequestKind, ids: number[]): void;
}

export interface AudioRequestsServiceOptions {
  db: Db;
  bus: EventBus;
  log?: Logger;
  notifier: RequestNotifier;
  discover: AudioDiscoverService;
  library: AudioLibraryPort;
  now?: () => Date;
}

/** Requests that block a new one for the same item. */
const ACTIVE: RequestStatus[] = ['pending', 'approved'];
const ASIN_RE = /^[A-Z0-9]{10}$/;
const KINDS: Record<'music' | 'audiobook', AudioRequestKind[]> = { music: ['album', 'artist'], audiobook: ['book', 'author'] };

export class AudioRequestsService {
  private readonly db: Db;
  private readonly bus: EventBus;
  private readonly log: Logger | undefined;
  private readonly notifier: RequestNotifier;
  private readonly discover: AudioDiscoverService;
  private readonly library: AudioLibraryPort;
  private readonly now: () => Date;
  /** Approvals still waiting on a library job (album requests). */
  private readonly pending = new Set<Promise<void>>();

  constructor(opts: AudioRequestsServiceOptions) {
    this.db = opts.db;
    this.bus = opts.bus;
    this.log = opts.log;
    this.notifier = opts.notifier;
    this.discover = opts.discover;
    this.library = opts.library;
    this.now = opts.now ?? (() => new Date());
  }

  private iso(): string {
    return this.now().toISOString();
  }

  private publish(action: Extract<ServerEvent, { type: 'request' }>['action'], id: number): void {
    this.bus.publish({ type: 'request', action, id, audio: true });
  }

  private notify(kind: Parameters<RequestNotifier['audioRequest']>[0], row: AudioRequestRow, extra: { reason?: string } = {}): Promise<void> {
    return this.notifier.audioRequest(kind, row, extra).catch((err: unknown) => this.log?.warn({ err }, `audio request ${kind} notification failed`));
  }

  /** Resolves once every approval waiting on a library job has settled (tests, shutdown). */
  async whenIdle(): Promise<void> {
    while (this.pending.size > 0) await Promise.allSettled([...this.pending]);
  }

  // -------------------------------------------------------------------------------------
  // settings (section `audioRequests`)
  // -------------------------------------------------------------------------------------

  defaults(actor: Actor): AudioRequestDefaults {
    if (!canManageSettings(actor.permissions)) throw RequestsError.forbidden();
    return getSection(this.db, 'audioRequests');
  }

  /** Root folders must be registered for the media type, profiles must belong to the domain. */
  setDefaults(actor: Actor, raw: AudioRequestDefaults): AudioRequestDefaults {
    if (!canManageSettings(actor.permissions)) throw RequestsError.forbidden();
    const value = AudioRequestDefaults.parse(raw);
    for (const domain of ['music', 'audiobook'] as const) {
      const { rootFolderPath, qualityProfileId } = value[domain];
      if (rootFolderPath !== null) {
        const known = this.db.select().from(rootFolders).where(and(eq(rootFolders.mediaType, domain), eq(rootFolders.path, rootFolderPath))).get();
        if (!known) throw new RequestsError('VALIDATION', `${rootFolderPath} is not a registered ${domain} root folder`);
      }
      if (qualityProfileId !== null) {
        const profile = this.db.select({ mediaDomain: qualityProfiles.mediaDomain }).from(qualityProfiles).where(eq(qualityProfiles.id, qualityProfileId)).get();
        if (profile?.mediaDomain !== domain) throw new RequestsError('VALIDATION', `quality profile ${qualityProfileId} is not a ${domain} profile`);
      }
    }
    const saved = setSection(this.db, 'audioRequests', value, this.iso());
    this.bus.publish({ type: 'settings', section: 'audioRequests' });
    return saved;
  }

  // -------------------------------------------------------------------------------------
  // resource mapping
  // -------------------------------------------------------------------------------------

  row(id: number): AudioRequestRow {
    const row = this.db.select().from(audioRequests).where(eq(audioRequests.id, id)).get();
    if (!row) throw RequestsError.notFound('audio request', id);
    return row;
  }

  private libraryOf(rows: readonly AudioRequestRow[]): Map<string, AudioLibraryEntry> {
    const out = new Map<string, AudioLibraryEntry>();
    for (const kind of ['album', 'artist', 'book', 'author'] as const) {
      const ids = rows.filter((r) => r.kind === kind).map((r) => r.foreignId);
      for (const [id, entry] of audioLibraryStatus(this.db, kind, ids)) out.set(`${kind}:${id}`, entry);
    }
    return out;
  }

  toResources(rows: AudioRequestRow[], actor: Actor): AudioRequest[] {
    if (rows.length === 0) return [];
    const users = requestUsers(this.db, rows.flatMap((r) => [r.requestedById, r.modifiedById]));
    const library = this.libraryOf(rows);
    const manage = canManageRequests(actor.permissions);
    return rows.map((r) => {
      const entry = library.get(`${r.kind}:${r.foreignId}`);
      return {
        id: r.id,
        kind: r.kind,
        status: r.status,
        foreignId: r.foreignId,
        parentForeignId: r.parentForeignId,
        region: r.region,
        title: r.title,
        subtitle: r.subtitle,
        year: r.year,
        coverUrl: r.coverUrl,
        requestedBy: users.get(r.requestedById) ?? { id: r.requestedById, username: `deleted user ${r.requestedById}` },
        modifiedBy: r.modifiedById === null ? null : (users.get(r.modifiedById) ?? null),
        declineReason: r.declineReason,
        failureReason: r.failureReason,
        libraryId: r.libraryId ?? entry?.libraryId ?? null,
        mediaStatus: overlayAudioRequest(entry?.status ?? 'unknown', r.status),
        canRemove: manage || (r.requestedById === actor.userId && r.status === 'pending'),
        createdAt: r.createdAt,
        updatedAt: r.updatedAt,
      };
    });
  }

  toResource(row: AudioRequestRow, actor: Actor): AudioRequest {
    return this.toResources([row], actor)[0]!;
  }

  // -------------------------------------------------------------------------------------
  // reading
  // -------------------------------------------------------------------------------------

  /** Own requests unless the actor may view everyone's (as for video requests). */
  private scope(actor: Actor, requestedBy?: number): SQL | undefined {
    if (canViewAllRequests(actor.permissions)) return requestedBy === undefined ? undefined : eq(audioRequests.requestedById, requestedBy);
    if (requestedBy !== undefined && requestedBy !== actor.userId) throw RequestsError.forbidden('you may only view your own requests');
    return eq(audioRequests.requestedById, actor.userId ?? -1);
  }

  get(actor: Actor, id: number): AudioRequest {
    const row = this.row(id);
    if (row.requestedById !== actor.userId && !canViewAllRequests(actor.permissions)) throw RequestsError.forbidden();
    return this.toResource(row, actor);
  }

  list(actor: Actor, rawQuery: AudioRequestListQuery): AudioRequestPage {
    const q = AudioRequestListQuery.parse(rawQuery);
    const where: SQL[] = [];
    const scope = this.scope(actor, q.requestedBy);
    if (scope) where.push(scope);
    if (q.domain !== 'all') where.push(inArray(audioRequests.kind, KINDS[q.domain]));
    const statusFilter: Partial<Record<typeof q.filter, RequestStatus[]>> = {
      pending: ['pending'],
      approved: ['approved'],
      processing: ['approved'],
      declined: ['declined'],
      failed: ['failed'],
      completed: ['completed'],
      available: ['approved', 'completed'],
    };
    const statuses = statusFilter[q.filter];
    if (statuses) where.push(inArray(audioRequests.status, statuses));
    const search = listSearchCondition(q.q, [
      audioRequests.title,
      audioRequests.subtitle,
      audioRequests.year,
      audioRequests.kind,
      audioRequests.status,
      audioRequests.declineReason,
      audioRequests.failureReason,
      ...userNameSearchColumns(audioRequests.requestedById),
    ]);
    if (search) where.push(search);
    let rows = this.db
      .select()
      .from(audioRequests)
      .where(where.length ? and(...where) : undefined)
      .orderBy(q.sortDirection === 'asc' ? asc(audioRequests.id) : desc(audioRequests.id))
      .all();
    // processing / available depend on the library, so they filter after the query.
    if (q.filter === 'processing' || q.filter === 'available') {
      const status = new Map(this.toResources(rows, actor).map((r) => [r.id, r.mediaStatus]));
      rows = rows.filter((r) => (q.filter === 'available' ? status.get(r.id) === 'available' : status.get(r.id) !== 'available'));
    }
    const page = rows.slice(q.skip, q.skip + q.take);
    return { pageInfo: { total: rows.length, take: q.take, skip: q.skip }, results: this.toResources(page, actor) };
  }

  count(actor: Actor): AudioRequestCount {
    const rows = this.db.select({ kind: audioRequests.kind, status: audioRequests.status }).from(audioRequests).where(this.scope(actor)).all();
    return {
      total: rows.length,
      music: rows.filter((r) => audioRequestDomain(r.kind) === 'music').length,
      audiobook: rows.filter((r) => audioRequestDomain(r.kind) === 'audiobook').length,
      pending: rows.filter((r) => r.status === 'pending').length,
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

  async create(actor: Actor, raw: CreateAudioRequest): Promise<AudioRequest> {
    const input = CreateAudioRequest.parse(raw);
    const domain = audioRequestDomain(input.kind);
    this.discover.assertEnabled(domain);
    const requester = this.resolveRequester(actor, input.userId);
    const held = userPermissions(requester);
    if (!canRequestAudio(held, domain)) throw RequestsError.forbidden(`not allowed to request ${domain === 'music' ? 'music' : 'audiobooks'}`);
    const foreignId = normalizeForeignId(input.kind, input.foreignId);
    if (domain === 'music' ? !isMbid(foreignId) : !ASIN_RE.test(foreignId)) {
      throw new RequestsError('VALIDATION', `${foreignId} is not a ${domain === 'music' ? 'MusicBrainz id' : 'ASIN'}`);
    }

    // Duplicates and items already on disk are decided before the catalogue lookup.
    const existing = this.db
      .select({ id: audioRequests.id })
      .from(audioRequests)
      .where(and(eq(audioRequests.kind, input.kind), eq(audioRequests.foreignId, foreignId), inArray(audioRequests.status, ACTIVE)))
      .get();
    if (existing) throw new RequestsError('CONFLICT', `this ${input.kind} already has an active request (#${existing.id})`);
    if (audioLibraryStatus(this.db, input.kind, [foreignId]).get(foreignId)?.status === 'available') {
      throw new RequestsError('CONFLICT', `this ${input.kind} is already in the library`);
    }

    const facts = await this.discover.facts(input.kind, foreignId, input.region);
    const autoApproved = canAutoApproveAudio(held) || canAutoApproveAudio(actor.permissions);
    const now = this.iso();
    const row = this.db
      .insert(audioRequests)
      .values({
        kind: input.kind,
        status: autoApproved ? 'approved' : 'pending',
        foreignId,
        parentForeignId: facts.parentForeignId,
        region: facts.region,
        title: facts.title,
        subtitle: facts.subtitle,
        year: facts.year,
        coverUrl: facts.coverUrl,
        requestedById: requester.id,
        modifiedById: autoApproved ? requester.id : null,
        createdAt: now,
        updatedAt: now,
      })
      .returning()
      .get();
    this.log?.info({ audioRequestId: row.id, kind: row.kind, foreignId, status: row.status }, 'audio request created');
    this.publish('created', row.id);
    await this.notify('created', row);
    const final = autoApproved ? await this.sendToLibrary(row) : row;
    return this.toResource(final, actor);
  }

  // -------------------------------------------------------------------------------------
  // approval: into the music / audiobook library
  // -------------------------------------------------------------------------------------

  /** Root folder and quality profile for the domain; throws a readable reason when none exists. */
  private resolveTarget(domain: 'music' | 'audiobook'): { rootFolderPath: string; qualityProfileId: number } {
    const defaults = getSection(this.db, 'audioRequests')[domain];
    const label = domain === 'music' ? 'music' : 'audiobook';
    const rootFolderPath =
      defaults.rootFolderPath ??
      this.db.select().from(rootFolders).where(eq(rootFolders.mediaType, domain)).orderBy(asc(rootFolders.id)).limit(1).get()?.path ??
      null;
    if (!rootFolderPath) throw new Error(`No ${label} root folder is set up`);
    const qualityProfileId =
      defaults.qualityProfileId ??
      this.db.select({ id: qualityProfiles.id }).from(qualityProfiles).where(eq(qualityProfiles.mediaDomain, domain)).orderBy(asc(qualityProfiles.id)).limit(1).get()?.id ??
      null;
    if (qualityProfileId === null) throw new Error(`No ${label} quality profile is set up`);
    return { rootFolderPath, qualityProfileId };
  }

  private patch(id: number, values: Partial<typeof audioRequests.$inferInsert>): AudioRequestRow {
    return this.db
      .update(audioRequests)
      .set({ ...values, updatedAt: this.iso() })
      .where(eq(audioRequests.id, id))
      .returning()
      .get()!;
  }

  private fail(row: AudioRequestRow, err: unknown): AudioRequestRow {
    const message = err instanceof Error ? err.message : String(err);
    this.log?.warn({ err, audioRequestId: row.id }, 'sending audio request to the library failed');
    const failed = this.patch(row.id, { status: 'failed', failureReason: message });
    this.publish('failed', row.id);
    return failed;
  }

  /** Library id and availability of the item now. */
  private libraryEntry(row: AudioRequestRow): AudioLibraryEntry | undefined {
    return audioLibraryStatus(this.db, row.kind, [row.foreignId]).get(row.foreignId);
  }

  /** Stores the library id; completes the request when the item is already available, else searches. */
  private async settle(row: AudioRequestRow, libraryId: number, search: boolean): Promise<AudioRequestRow> {
    const updated = this.patch(row.id, { libraryId, failureReason: null });
    if (this.libraryEntry(updated)?.status === 'available') return this.complete(updated);
    if (search) this.library.search(row.kind, [libraryId]);
    return updated;
  }

  /**
   * Adds (or re-monitors) the item for an approved request. Returns the updated row; failures
   * mark it failed. Album requests for an artist the library does not have (or whose album row
   * is not there yet) finish in the background once the release groups are synced.
   */
  async sendToLibrary(row: AudioRequestRow): Promise<AudioRequestRow> {
    try {
      const target = this.resolveTarget(audioRequestDomain(row.kind));
      switch (row.kind) {
        case 'album':
          return await this.sendAlbum(row, target);
        case 'artist': {
          const existing = music.findArtistByMbid(this.db, row.foreignId);
          if (existing) {
            music.updateArtist(this.db, existing.id, { monitored: true });
            return await this.settle(row, existing.id, true);
          }
          const added = await this.library.addArtist(
            AddArtistRequest.parse({ mbArtistId: row.foreignId, ...target, monitored: true, monitorOption: 'all', monitorNewAlbums: 'all', searchOnAdd: true }),
          );
          return await this.settle(row, added.id, false);
        }
        case 'book': {
          const existing = ab.booksByAsin(this.db, [row.foreignId]).get(row.foreignId);
          if (existing) {
            ab.updateBookFlags(this.db, existing.id, { monitored: true });
            return await this.settle(row, existing.id, true);
          }
          const added = await this.library.addBook(
            AddBookRequest.parse({
              asin: row.foreignId,
              ...(row.region ? { region: row.region } : {}),
              monitored: true,
              searchOnAdd: true,
              author: { ...target, monitored: true, monitorNewBooks: 'none' },
            }),
          );
          return await this.settle(row, added.id, false);
        }
        case 'author': {
          const existing = ab.findAuthorByAsin(this.db, row.foreignId);
          if (existing) {
            ab.updateAuthor(this.db, existing.id, { monitored: true });
            return await this.settle(row, existing.id, true);
          }
          const added = await this.library.addAuthor(
            AddAuthorRequest.parse({ asin: row.foreignId, ...target, monitored: true, monitorOption: 'all', monitorNewBooks: 'all', searchOnAdd: true }),
          );
          return await this.settle(row, added.id, false);
        }
      }
    } catch (err) {
      return this.fail(row, err);
    }
  }

  private albumRow(mbReleaseGroupId: string) {
    return this.db.select().from(albums).where(eq(albums.mbReleaseGroupId, mbReleaseGroupId)).get();
  }

  /** Monitors the album (and its artist) and searches it. */
  private async monitorAlbum(row: AudioRequestRow, album: { id: number; artistId: number }): Promise<AudioRequestRow> {
    const artist = music.artistRow(this.db, album.artistId);
    if (!artist.monitored) music.updateArtist(this.db, artist.id, { monitored: true });
    music.updateAlbumFlags(this.db, album.id, { monitored: true });
    return this.settle(row, album.id, true);
  }

  private async sendAlbum(row: AudioRequestRow, target: { rootFolderPath: string; qualityProfileId: number }): Promise<AudioRequestRow> {
    const album = this.albumRow(row.foreignId);
    if (album) return this.monitorAlbum(row, album);
    const artistMbid = row.parentForeignId;
    if (!artistMbid) throw new Error('MusicBrainz names no artist for this album');
    const artist = music.findArtistByMbid(this.db, artistMbid);
    // The album row appears once the artist's release groups are synced: ArtistAdd for a new
    // artist (nothing else monitored), RefreshArtist for one already in the library.
    const synced = artist
      ? this.library.refreshArtist(artist.id)
      : (
          await this.library.addArtist(
            AddArtistRequest.parse({ mbArtistId: artistMbid, ...target, monitored: true, monitorOption: 'none', monitorNewAlbums: 'none', searchOnAdd: false }),
          )
        ).done;
    const follow = (async () => {
      try {
        await synced;
        const current = this.row(row.id);
        if (current.status !== 'approved') return;
        const found = this.albumRow(row.foreignId);
        if (!found) {
          throw new Error(`${row.title} was not found on the artist after the MusicBrainz sync (its type may be filtered out by the artist's album-type profile)`);
        }
        await this.monitorAlbum(current, found);
      } catch (err) {
        // A request declined or deleted meanwhile is left alone.
        const current = this.db.select().from(audioRequests).where(eq(audioRequests.id, row.id)).get();
        if (current?.status === 'approved') this.fail(current, err);
      }
    })();
    const tracked = follow.finally(() => this.pending.delete(tracked));
    this.pending.add(tracked);
    return row;
  }

  private async complete(row: AudioRequestRow): Promise<AudioRequestRow> {
    const done = this.patch(row.id, { status: 'completed' });
    this.publish('completed', row.id);
    await this.notify('available', done);
    return done;
  }

  private requirePending(row: AudioRequestRow): void {
    if (row.status !== 'pending') throw new RequestsError('CONFLICT', `request ${row.id} is ${row.status}, not pending`);
  }

  async approve(actor: Actor, id: number): Promise<AudioRequest> {
    if (!canManageRequests(actor.permissions)) throw RequestsError.forbidden();
    const row = this.row(id);
    this.discover.assertEnabled(audioRequestDomain(row.kind));
    this.requirePending(row);
    const approved = this.patch(id, { status: 'approved', modifiedById: actor.userId });
    this.publish('approved', id);
    const sent = await this.sendToLibrary(approved);
    if (sent.status === 'approved') await this.notify('approved', sent);
    return this.toResource(sent, actor);
  }

  async decline(actor: Actor, id: number, reason?: string): Promise<AudioRequest> {
    if (!canManageRequests(actor.permissions)) throw RequestsError.forbidden();
    const row = this.row(id);
    this.requirePending(row);
    const declined = this.patch(id, { status: 'declined', modifiedById: actor.userId, declineReason: reason ?? null });
    this.publish('declined', id);
    await this.notify('declined', declined, reason ? { reason } : {});
    return this.toResource(declined, actor);
  }

  async retry(actor: Actor, id: number): Promise<AudioRequest> {
    if (!canManageRequests(actor.permissions)) throw RequestsError.forbidden();
    const row = this.row(id);
    this.discover.assertEnabled(audioRequestDomain(row.kind));
    if (row.status !== 'failed') throw new RequestsError('CONFLICT', `request ${id} is ${row.status}, not failed`);
    const approved = this.patch(id, { status: 'approved', modifiedById: actor.userId, failureReason: null });
    this.publish('approved', id);
    return this.toResource(await this.sendToLibrary(approved), actor);
  }

  remove(actor: Actor, id: number): void {
    const row = this.row(id);
    const allowed = canManageRequests(actor.permissions) || (row.requestedById === actor.userId && row.status === 'pending');
    if (!allowed) throw RequestsError.forbidden('only pending requests of your own can be deleted');
    this.db.delete(audioRequests).where(eq(audioRequests.id, id)).run();
    this.publish('deleted', id);
  }

  // -------------------------------------------------------------------------------------
  // status sync (part of RequestsStatusSync)
  // -------------------------------------------------------------------------------------

  /** Links open requests to their library rows and completes the ones whose item is available. */
  async syncStatuses(signal?: AbortSignal): Promise<string> {
    const open = this.db.select().from(audioRequests).where(inArray(audioRequests.status, ACTIVE)).all();
    const library = this.libraryOf(open);
    let completed = 0;
    for (const req of open) {
      if (signal?.aborted) throw new Error('cancelled');
      const entry = library.get(`${req.kind}:${req.foreignId}`);
      if (!entry) continue;
      if (req.libraryId === null) this.db.update(audioRequests).set({ libraryId: entry.libraryId }).where(eq(audioRequests.id, req.id)).run();
      if (entry.status === 'available') {
        await this.complete(this.row(req.id));
        completed++;
      }
    }
    return `${open.length} audio requests checked, ${completed} completed`;
  }
}
