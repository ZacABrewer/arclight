import { and, asc, desc, eq, inArray, isNotNull, like, or, type SQL } from 'drizzle-orm';
import { rm } from 'node:fs/promises';
import { isAbsolute, join, relative, resolve } from 'node:path';
import {
  AlbumPrimaryType,
  AlbumReleaseStatus,
  AlbumSecondaryType,
  ArtistType,
  albumPassesTypeProfile,
  defaultAlbumTypeProfiles,
  type AddArtistRequest,
  type Album,
  type AlbumDetails,
  type AlbumListQuery,
  type AlbumRelease,
  type AlbumStatistics,
  type AlbumTypeProfile,
  type AlbumTypeProfileInput,
  type Artist,
  type ArtistDetails,
  type ArtistLink,
  type ArtistListQuery,
  type ArtistStatistics,
  type ArtistStatus,
  type AudioFile,
  type AudioFileListQuery,
  type AudioFileTags,
  type BulkArtistUpdateRequest,
  type MonitorNewAlbums,
  type MusicImage,
  type MusicMonitorOption,
  type QualityProfile,
  type Track,
  type UpdateArtistRequest,
  type WantedAlbum,
  type WantedAlbumsPage,
  type WantedAlbumsQuery,
} from '@arclight/shared';
import { formatArtistCredit, type MbArtist, type MbRelease, type MbReleaseGroup, type MbReleaseSummary } from '@arclight/metadata';
import { isQualityCutoffMet } from '@arclight/profiles-engine';
import type { Db } from '../../db/index.js';
import {
  albumReleases,
  albumTypeProfiles,
  albums,
  artists,
  audioFiles,
  audioImportExclusions,
  qualityProfiles,
  rootFolders,
  tags as tagsTable,
  tracks,
} from '../../db/schema.js';
import type { KnownAlbum, RescanArtistResult } from '../imports/audio/index.js';
import { LibraryError, libraryService } from '../library/index.js';
import { getSection } from '../settings/service.js';
import { albumsToMonitor, isReleased, monitorNewAlbum, releaseDateMs } from './monitoring.js';
import { musicQualityFor } from './quality.js';
import { albumStatistics, artistStatistics, type MusicDb } from './statistics.js';
import type { AlbumReleaseRow, AlbumRow, ArtistRow, TrackRow } from './schema.js';

// Business logic for the music library (artists → albums → releases → tracks, audio files).
// Plain functions over a database handle, like the library service: no Fastify, no network.
// The refresher (modules/metadata/music-jobs.ts) fetches from MusicBrainz and writes through
// these functions.

type AudioFileRow = typeof audioFiles.$inferSelect;

const nowIso = () => new Date().toISOString();

export function musicEnabled(db: Db): boolean {
  return getSection(db, 'features').music;
}

// ---------------------------------------------------------------------------------------
// MusicBrainz → columns
// ---------------------------------------------------------------------------------------

export interface ArtistMetadataInput {
  mbArtistId: string;
  name: string;
  sortName: string;
  disambiguation: string | null;
  artistType: ArtistType | null;
  status: ArtistStatus;
  overview: string;
  genres: string[];
  links: ArtistLink[];
  aliases: string[];
}

export function artistMetadataFrom(mb: MbArtist): ArtistMetadataInput {
  const type = mb.type ? (ArtistType.safeParse(mb.type).data ?? 'Other') : null;
  return {
    mbArtistId: mb.mbid.toLowerCase(),
    name: mb.name,
    sortName: mb.sortName || mb.name,
    disambiguation: mb.disambiguation ?? null,
    artistType: type,
    status: mb.status,
    overview: '',
    genres: mb.genres,
    links: mb.links.map((l) => ({ name: l.type, url: l.url })),
    aliases: [...new Set(mb.aliases.map((a) => a.name).filter((n) => n !== mb.name))],
  };
}

export interface ReleaseGroupInput {
  mbReleaseGroupId: string;
  title: string;
  disambiguation: string | null;
  primaryType: AlbumPrimaryType;
  secondaryTypes: AlbumSecondaryType[];
  releaseDate: string | null;
  year: number | null;
}

export function releaseGroupFrom(group: MbReleaseGroup): ReleaseGroupInput {
  return {
    mbReleaseGroupId: group.mbid.toLowerCase(),
    title: group.title,
    disambiguation: group.disambiguation ?? null,
    primaryType: AlbumPrimaryType.safeParse(group.primaryType).data ?? 'Other',
    secondaryTypes: group.secondaryTypes.flatMap((t) => AlbumSecondaryType.safeParse(t).data ?? []),
    releaseDate: group.firstReleaseDate ?? null,
    year: group.year ?? (group.firstReleaseDate ? Number(group.firstReleaseDate.slice(0, 4)) || null : null),
  };
}

function releaseStatus(value: string | undefined): AlbumReleaseStatus | null {
  return value ? (AlbumReleaseStatus.safeParse(value).data ?? null) : null;
}

function releaseSummaryColumns(r: MbReleaseSummary | MbRelease) {
  return {
    mbReleaseId: r.mbid.toLowerCase(),
    title: r.title,
    status: releaseStatus(r.status),
    country: r.country ?? null,
    date: r.date ?? null,
    barcode: r.barcode ?? null,
    formats: [...new Set(r.formats)],
    mediumCount: r.mediumCount,
    trackCount: r.trackCount,
    media: r.media.map((m) => ({ position: m.position, format: m.format ?? null, name: m.title ?? null, trackCount: m.trackCount })),
    disambiguation: r.disambiguation ?? null,
  };
}

// ---------------------------------------------------------------------------------------
// Validation helpers
// ---------------------------------------------------------------------------------------

function isPathInside(parent: string, child: string): boolean {
  const rel = relative(resolve(parent), resolve(child));
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
}

function requireMusicRootFolder(db: MusicDb, path: string): string {
  const match = db
    .select()
    .from(rootFolders)
    .where(eq(rootFolders.mediaType, 'music'))
    .all()
    .find((r) => resolve(r.path) === resolve(path));
  if (!match) throw new LibraryError('VALIDATION', `${path} is not a registered music root folder`);
  return match.path;
}

function requireMusicProfile(db: MusicDb, id: number | undefined): void {
  if (id === undefined) return;
  const row = db.select({ mediaDomain: qualityProfiles.mediaDomain }).from(qualityProfiles).where(eq(qualityProfiles.id, id)).get();
  if (!row) throw new LibraryError('VALIDATION', `quality profile ${id} does not exist`);
  if (row.mediaDomain !== 'music') {
    throw new LibraryError('VALIDATION', `quality profile ${id} is a ${row.mediaDomain} profile; artists need a music profile`);
  }
}

function requireTags(db: MusicDb, ids: readonly number[]): number[] {
  const unique = [...new Set(ids)];
  if (unique.length === 0) return [];
  const found = new Set(db.select({ id: tagsTable.id }).from(tagsTable).where(inArray(tagsTable.id, unique)).all().map((r) => r.id));
  const missing = unique.filter((id) => !found.has(id));
  if (missing.length > 0) throw new LibraryError('VALIDATION', `unknown tag ids: ${missing.join(', ')}`);
  return unique.sort((a, b) => a - b);
}

/** `<root>/<Artist Name>` (naming default `{Artist Name}`), folder-safe. */
export function buildArtistPath(rootFolderPath: string, name: string): string {
  return join(rootFolderPath, libraryService.sanitizeFolderName(name));
}

// ---------------------------------------------------------------------------------------
// Album-type profiles
// ---------------------------------------------------------------------------------------

function toProfile(row: typeof albumTypeProfiles.$inferSelect): AlbumTypeProfile {
  return {
    id: row.id,
    name: row.name,
    primaryTypes: row.primaryTypes,
    secondaryTypes: row.secondaryTypes,
    releaseStatuses: row.releaseStatuses,
    isDefault: row.isDefault,
  };
}

/** Seeds the default profiles when the table is empty (the profiles module also does on start). */
function ensureProfiles(db: MusicDb): void {
  if (db.select({ id: albumTypeProfiles.id }).from(albumTypeProfiles).limit(1).all().length > 0) return;
  for (const p of defaultAlbumTypeProfiles()) db.insert(albumTypeProfiles).values(p).run();
}

export function listAlbumTypeProfiles(db: MusicDb): AlbumTypeProfile[] {
  ensureProfiles(db);
  return db.select().from(albumTypeProfiles).orderBy(asc(albumTypeProfiles.id)).all().map(toProfile);
}

export function getAlbumTypeProfile(db: MusicDb, id: number): AlbumTypeProfile {
  const row = db.select().from(albumTypeProfiles).where(eq(albumTypeProfiles.id, id)).get();
  if (!row) throw LibraryError.notFound('album-type profile', id);
  return toProfile(row);
}

export function defaultAlbumTypeProfile(db: MusicDb): AlbumTypeProfile {
  const all = listAlbumTypeProfiles(db);
  return all.find((p) => p.isDefault) ?? all[0]!;
}

function nameTaken(db: MusicDb, name: string, exceptId?: number): boolean {
  return db
    .select({ id: albumTypeProfiles.id, name: albumTypeProfiles.name })
    .from(albumTypeProfiles)
    .all()
    .some((r) => r.id !== exceptId && r.name.toLowerCase() === name.toLowerCase());
}

export function createAlbumTypeProfile(db: Db, input: AlbumTypeProfileInput): AlbumTypeProfile {
  return db.transaction((tx) => {
    ensureProfiles(tx);
    if (nameTaken(tx, input.name)) throw new LibraryError('CONFLICT', `an album-type profile named "${input.name}" already exists`);
    if (input.isDefault) tx.update(albumTypeProfiles).set({ isDefault: false }).run();
    return toProfile(tx.insert(albumTypeProfiles).values(input).returning().get());
  });
}

export function updateAlbumTypeProfile(db: Db, id: number, input: AlbumTypeProfileInput): AlbumTypeProfile {
  return db.transaction((tx) => {
    const current = getAlbumTypeProfile(tx, id);
    if (nameTaken(tx, input.name, id)) throw new LibraryError('CONFLICT', `an album-type profile named "${input.name}" already exists`);
    if (current.isDefault && !input.isDefault) {
      throw new LibraryError('VALIDATION', 'one profile must stay the default; mark another profile as default instead');
    }
    if (input.isDefault) tx.update(albumTypeProfiles).set({ isDefault: false }).run();
    tx.update(albumTypeProfiles).set(input).where(eq(albumTypeProfiles.id, id)).run();
    return getAlbumTypeProfile(tx, id);
  });
}

export function deleteAlbumTypeProfile(db: Db, id: number): void {
  db.transaction((tx) => {
    const current = getAlbumTypeProfile(tx, id);
    if (current.isDefault) throw new LibraryError('VALIDATION', 'the default album-type profile cannot be deleted');
    const used = tx.select({ id: artists.id }).from(artists).where(eq(artists.albumTypeProfileId, id)).limit(1).get();
    if (used) throw new LibraryError('CONFLICT', `album-type profile ${id} is used by at least one artist`);
    tx.delete(albumTypeProfiles).where(eq(albumTypeProfiles.id, id)).run();
  });
}

// ---------------------------------------------------------------------------------------
// Artists
// ---------------------------------------------------------------------------------------

function toArtist(row: ArtistRow, statistics?: ArtistStatistics): Artist {
  return {
    id: row.id,
    mbArtistId: row.mbArtistId,
    name: row.name,
    sortName: row.sortName,
    cleanName: row.cleanName,
    disambiguation: row.disambiguation,
    artistType: row.artistType,
    status: row.status,
    overview: row.overview,
    genres: row.genres,
    images: row.images,
    links: row.links,
    aliases: row.aliases,
    path: row.path,
    rootFolderPath: row.rootFolderPath,
    qualityProfileId: row.qualityProfileId,
    albumTypeProfileId: row.albumTypeProfileId,
    monitored: row.monitored,
    monitorNewAlbums: row.monitorNewAlbums,
    tags: row.tags,
    added: row.added,
    lastRefreshed: row.lastRefreshed,
    nextRefreshAt: row.nextRefreshAt,
    ...(statistics ? { statistics } : {}),
  };
}

function artistRow(db: MusicDb, id: number): ArtistRow {
  const row = db.select().from(artists).where(eq(artists.id, id)).get();
  if (!row) throw LibraryError.notFound('artist', id);
  return row;
}

export function findArtistByMbid(db: MusicDb, mbArtistId: string): ArtistRow | undefined {
  return db.select().from(artists).where(eq(artists.mbArtistId, mbArtistId.toLowerCase())).get();
}

/** Library artist ids keyed by MusicBrainz id (lookup marks results already added). */
export function artistIdsByMbid(db: MusicDb, mbids: readonly string[]): Map<string, number> {
  if (mbids.length === 0) return new Map();
  const rows = db
    .select({ id: artists.id, mbid: artists.mbArtistId })
    .from(artists)
    .where(inArray(artists.mbArtistId, mbids.map((m) => m.toLowerCase())))
    .all();
  return new Map(rows.map((r) => [r.mbid, r.id]));
}

/** Validates an add request against the database (before any network call). */
export function validateAddArtist(db: MusicDb, req: AddArtistRequest): { rootFolderPath: string; albumTypeProfileId: number; tags: number[] } {
  if (findArtistByMbid(db, req.mbArtistId)) throw new LibraryError('CONFLICT', `artist ${req.mbArtistId} is already in the library`);
  const excluded = db
    .select({ id: audioImportExclusions.id })
    .from(audioImportExclusions)
    .where(and(eq(audioImportExclusions.mediaType, 'music'), eq(audioImportExclusions.foreignId, req.mbArtistId.toLowerCase())))
    .get();
  if (excluded) throw new LibraryError('CONFLICT', `artist ${req.mbArtistId} is on the import exclusion list`);
  const rootFolderPath = requireMusicRootFolder(db, req.rootFolderPath);
  requireMusicProfile(db, req.qualityProfileId);
  const albumTypeProfileId =
    req.albumTypeProfileId !== undefined ? getAlbumTypeProfile(db, req.albumTypeProfileId).id : defaultAlbumTypeProfile(db).id;
  return { rootFolderPath, albumTypeProfileId, tags: requireTags(db, req.tags) };
}

/** Inserts the artist row (no albums yet; the ArtistAdd job fills them). */
export function addArtist(db: Db, meta: ArtistMetadataInput, req: AddArtistRequest, now: string = nowIso()): Artist {
  return db.transaction((tx) => {
    const { rootFolderPath, albumTypeProfileId, tags } = validateAddArtist(tx, req);
    const path = buildArtistPath(rootFolderPath, meta.name);
    if (tx.select({ id: artists.id }).from(artists).where(eq(artists.path, path)).get()) {
      throw new LibraryError('CONFLICT', `an artist already uses the path ${path}`);
    }
    const row = tx
      .insert(artists)
      .values({
        ...meta,
        cleanName: libraryService.toCleanTitle(meta.name),
        images: [],
        path,
        rootFolderPath,
        qualityProfileId: req.qualityProfileId,
        albumTypeProfileId,
        monitored: req.monitorOption === 'none' ? false : req.monitored,
        monitorNewAlbums: req.monitorNewAlbums,
        tags,
        added: now,
        lastRefreshed: null,
        nextRefreshAt: null,
      })
      .returning()
      .get();
    return toArtist(row, artistStatistics(tx, [row.id]).get(row.id));
  });
}

export function getArtist(db: MusicDb, id: number, opts: { includeStatistics?: boolean } = {}): Artist {
  const row = artistRow(db, id);
  return toArtist(row, opts.includeStatistics === false ? undefined : artistStatistics(db, [id]).get(id));
}

export function getArtistDetails(db: MusicDb, id: number): ArtistDetails {
  const artist = getArtist(db, id);
  return { ...artist, albums: listAlbums(db, { artistId: id, includeStatistics: true }) };
}

const artistSort = {
  sortName: artists.sortName,
  added: artists.added,
  status: artists.status,
  qualityProfileId: artists.qualityProfileId,
  path: artists.path,
} as const;

export function listArtists(db: MusicDb, query: ArtistListQuery): Artist[] {
  const where: SQL[] = [];
  if (query.monitored !== undefined) where.push(eq(artists.monitored, query.monitored));
  if (query.status) where.push(eq(artists.status, query.status));
  if (query.qualityProfileId !== undefined) where.push(eq(artists.qualityProfileId, query.qualityProfileId));
  if (query.albumTypeProfileId !== undefined) where.push(eq(artists.albumTypeProfileId, query.albumTypeProfileId));
  if (query.rootFolderPath) where.push(eq(artists.rootFolderPath, query.rootFolderPath));
  if (query.mbArtistId) where.push(eq(artists.mbArtistId, query.mbArtistId.toLowerCase()));
  if (query.search) {
    const needle = query.search.toLowerCase();
    where.push(or(like(artists.cleanName, `%${libraryService.toCleanTitle(query.search)}%`), like(artists.aliases, `%${needle}%`))!);
  }
  const bySize = query.sortKey === 'sizeOnDisk';
  const column = query.sortKey === 'sizeOnDisk' ? artists.sortName : artistSort[query.sortKey];
  let rows = db
    .select()
    .from(artists)
    .where(where.length ? and(...where) : undefined)
    .orderBy(query.sortOrder === 'desc' && !bySize ? desc(column) : asc(column), asc(artists.id))
    .all()
    .filter((r) => query.tag === undefined || r.tags.includes(query.tag));
  if (!query.includeStatistics && !bySize) return rows.map((r) => toArtist(r));
  const stats = artistStatistics(
    db,
    rows.map((r) => r.id),
  );
  if (bySize) {
    const size = (r: ArtistRow) => stats.get(r.id)?.sizeOnDisk ?? 0;
    rows = [...rows].sort((a, b) => (query.sortOrder === 'desc' ? size(b) - size(a) : size(a) - size(b)) || a.id - b.id);
  }
  return rows.map((r) => toArtist(r, query.includeStatistics ? stats.get(r.id) : undefined));
}

function resolveArtistPath(
  tx: MusicDb,
  current: ArtistRow,
  req: Pick<UpdateArtistRequest, 'rootFolderPath' | 'path'>,
): { rootFolderPath?: string; path?: string } {
  const out: { rootFolderPath?: string; path?: string } = {};
  if (req.rootFolderPath !== undefined) {
    out.rootFolderPath = requireMusicRootFolder(tx, req.rootFolderPath);
    // Moving the folder on disk is the organizer's job; the library records where it lives.
    out.path = req.path ?? buildArtistPath(out.rootFolderPath, current.name);
  } else if (req.path !== undefined) {
    if (!isAbsolute(req.path)) throw new LibraryError('VALIDATION', 'artist path must be absolute');
    out.path = req.path;
  }
  if (out.path && out.path !== current.path) {
    const clash = tx.select({ id: artists.id }).from(artists).where(eq(artists.path, out.path)).get();
    if (clash) throw new LibraryError('CONFLICT', `an artist already uses the path ${out.path}`);
  }
  return out;
}

export function updateArtist(db: Db, id: number, req: UpdateArtistRequest, now: string = nowIso()): Artist {
  return db.transaction((tx) => {
    const current = artistRow(tx, id);
    requireMusicProfile(tx, req.qualityProfileId);
    const patch: Partial<typeof artists.$inferInsert> = {};
    if (req.monitored !== undefined) patch.monitored = req.monitored;
    if (req.monitorNewAlbums !== undefined) patch.monitorNewAlbums = req.monitorNewAlbums;
    if (req.qualityProfileId !== undefined) patch.qualityProfileId = req.qualityProfileId;
    if (req.albumTypeProfileId !== undefined) patch.albumTypeProfileId = getAlbumTypeProfile(tx, req.albumTypeProfileId).id;
    if (req.tags !== undefined) patch.tags = requireTags(tx, req.tags);
    Object.assign(patch, resolveArtistPath(tx, current, req));
    if (Object.keys(patch).length > 0) tx.update(artists).set(patch).where(eq(artists.id, id)).run();
    if (req.monitorOption) applyMusicMonitorOption(tx, id, req.monitorOption, now);
    return getArtist(tx, id);
  });
}

export function bulkUpdateArtists(db: Db, req: BulkArtistUpdateRequest, now: string = nowIso()): Artist[] {
  return db.transaction((tx) => {
    const rows = tx.select().from(artists).where(inArray(artists.id, req.ids)).all();
    const found = new Set(rows.map((r) => r.id));
    const missing = req.ids.filter((id) => !found.has(id));
    if (missing.length > 0) throw LibraryError.notFound('artist', missing.join(', '));
    requireMusicProfile(tx, req.qualityProfileId);
    const albumTypeProfileId = req.albumTypeProfileId !== undefined ? getAlbumTypeProfile(tx, req.albumTypeProfileId).id : undefined;
    const rootFolderPath = req.rootFolderPath !== undefined ? requireMusicRootFolder(tx, req.rootFolderPath) : undefined;
    if (req.tags) requireTags(tx, [...(req.tags.add ?? []), ...(req.tags.remove ?? [])]);

    for (const row of rows) {
      const patch: Partial<typeof artists.$inferInsert> = {};
      if (req.monitored !== undefined) patch.monitored = req.monitored;
      if (req.monitorNewAlbums !== undefined) patch.monitorNewAlbums = req.monitorNewAlbums;
      if (req.qualityProfileId !== undefined) patch.qualityProfileId = req.qualityProfileId;
      if (albumTypeProfileId !== undefined) patch.albumTypeProfileId = albumTypeProfileId;
      if (rootFolderPath !== undefined) Object.assign(patch, resolveArtistPath(tx, row, { rootFolderPath }));
      if (req.tags) {
        const next = new Set(row.tags);
        for (const t of req.tags.add ?? []) next.add(t);
        for (const t of req.tags.remove ?? []) next.delete(t);
        patch.tags = [...next].sort((a, b) => a - b);
      }
      if (Object.keys(patch).length > 0) tx.update(artists).set(patch).where(eq(artists.id, row.id)).run();
      if (req.monitorOption) applyMusicMonitorOption(tx, row.id, req.monitorOption, now);
    }
    return req.ids.map((id) => getArtist(tx, id));
  });
}

export async function deleteArtist(db: Db, id: number, opts: { deleteFiles?: boolean; addExclusion?: boolean } = {}): Promise<void> {
  const row = artistRow(db, id);
  if (opts.deleteFiles && (resolve(row.path) === resolve(row.rootFolderPath) || !isPathInside(row.rootFolderPath, row.path))) {
    throw new LibraryError('VALIDATION', `refusing to delete ${row.path}: not inside its root folder ${row.rootFolderPath}`);
  }
  db.transaction((tx) => {
    if (opts.addExclusion) {
      tx.insert(audioImportExclusions)
        .values({ mediaType: 'music', foreignId: row.mbArtistId, title: row.name, year: null })
        .onConflictDoNothing()
        .run();
    }
    tx.delete(artists).where(eq(artists.id, id)).run(); // cascades to albums, releases, tracks, audio_files
  });
  if (opts.deleteFiles) await rm(row.path, { recursive: true, force: true });
}

/** Writes refreshed artist metadata (path and user settings stay). */
export function applyArtistMetadata(db: MusicDb, id: number, meta: ArtistMetadataInput, images: MusicImage[] | null): void {
  const { mbArtistId: _mbid, ...rest } = meta;
  db.update(artists)
    .set({ ...rest, cleanName: libraryService.toCleanTitle(meta.name), ...(images && images.length > 0 ? { images } : {}) })
    .where(eq(artists.id, id))
    .run();
}

export function markArtistRefreshed(db: MusicDb, id: number, at: string, nextRefreshAt: string): void {
  db.update(artists).set({ lastRefreshed: at, nextRefreshAt }).where(eq(artists.id, id)).run();
}

// ---------------------------------------------------------------------------------------
// Albums
// ---------------------------------------------------------------------------------------

function toAlbum(row: AlbumRow, statistics?: AlbumStatistics): Album {
  return {
    id: row.id,
    artistId: row.artistId,
    mbReleaseGroupId: row.mbReleaseGroupId,
    title: row.title,
    cleanTitle: row.cleanTitle,
    disambiguation: row.disambiguation,
    primaryType: row.primaryType,
    secondaryTypes: row.secondaryTypes,
    releaseDate: row.releaseDate,
    year: row.year,
    overview: row.overview,
    genres: row.genres,
    images: row.images,
    ratings: row.ratings,
    monitored: row.monitored,
    anyReleaseOk: row.anyReleaseOk,
    selectedReleaseId: row.selectedReleaseId,
    added: row.added,
    lastRefreshed: row.lastRefreshed,
    ...(statistics ? { statistics } : {}),
  };
}

export function toAlbumWithStats(db: MusicDb, rows: readonly AlbumRow[]): Album[] {
  const stats = albumStatistics(
    db,
    rows.map((r) => r.id),
  );
  return rows.map((r) => toAlbum(r, stats.get(r.id)));
}

function albumRow(db: MusicDb, id: number): AlbumRow {
  const row = db.select().from(albums).where(eq(albums.id, id)).get();
  if (!row) throw LibraryError.notFound('album', id);
  return row;
}

export function listAlbums(db: MusicDb, query: Partial<AlbumListQuery>): Album[] {
  const where: SQL[] = [];
  if (query.artistId !== undefined) where.push(eq(albums.artistId, query.artistId));
  if (query.monitored !== undefined) where.push(eq(albums.monitored, query.monitored));
  if (query.mbReleaseGroupId) where.push(eq(albums.mbReleaseGroupId, query.mbReleaseGroupId.toLowerCase()));
  const rows = db
    .select()
    .from(albums)
    .where(where.length ? and(...where) : undefined)
    .orderBy(asc(albums.artistId), asc(albums.releaseDate), asc(albums.title), asc(albums.id))
    .all();
  return query.includeStatistics === false ? rows.map((r) => toAlbum(r)) : toAlbumWithStats(db, rows);
}

export function getAlbum(db: MusicDb, id: number): Album {
  return toAlbumWithStats(db, [albumRow(db, id)])[0]!;
}

function toRelease(row: AlbumReleaseRow): AlbumRelease {
  return { ...row };
}

function toTrack(row: TrackRow): Track {
  return { ...row };
}

export function toAudioFile(row: AudioFileRow): AudioFile {
  return { ...row };
}

export function getAlbumDetails(db: MusicDb, id: number): AlbumDetails {
  const album = getAlbum(db, id);
  const artist = artistRow(db, album.artistId);
  const releases = db
    .select()
    .from(albumReleases)
    .where(eq(albumReleases.albumId, id))
    .orderBy(asc(albumReleases.date), asc(albumReleases.id))
    .all()
    .map(toRelease);
  const trackRows =
    album.selectedReleaseId != null
      ? db
          .select()
          .from(tracks)
          .where(and(eq(tracks.albumId, id), eq(tracks.albumReleaseId, album.selectedReleaseId)))
          .orderBy(asc(tracks.mediumNumber), asc(tracks.trackNumber))
          .all()
      : [];
  const files = db.select().from(audioFiles).where(eq(audioFiles.albumId, id)).orderBy(asc(audioFiles.path)).all().map(toAudioFile);
  return {
    ...album,
    artist: { id: artist.id, mbArtistId: artist.mbArtistId, name: artist.name, sortName: artist.sortName, path: artist.path, images: artist.images },
    releases,
    tracks: trackRows.map(toTrack),
    files,
  };
}

export function updateAlbumFlags(db: MusicDb, id: number, req: { monitored?: boolean | undefined; anyReleaseOk?: boolean | undefined }): void {
  albumRow(db, id);
  const patch: Partial<typeof albums.$inferInsert> = {};
  if (req.monitored !== undefined) patch.monitored = req.monitored;
  if (req.anyReleaseOk !== undefined) patch.anyReleaseOk = req.anyReleaseOk;
  if (Object.keys(patch).length > 0) db.update(albums).set(patch).where(eq(albums.id, id)).run();
}

export function bulkSetAlbumsMonitored(db: Db, ids: readonly number[], monitored: boolean): Album[] {
  return db.transaction((tx) => {
    const rows = tx.select({ id: albums.id }).from(albums).where(inArray(albums.id, [...ids])).all();
    const found = new Set(rows.map((r) => r.id));
    const missing = ids.filter((id) => !found.has(id));
    if (missing.length > 0) throw LibraryError.notFound('album', missing.join(', '));
    tx.update(albums).set({ monitored }).where(inArray(albums.id, [...ids])).run();
    return toAlbumWithStats(tx, tx.select().from(albums).where(inArray(albums.id, [...ids])).all());
  });
}

/** Album ids of the artist that have at least one track file. */
function albumsWithFiles(db: MusicDb, artistId: number): Set<number> {
  return new Set(
    db
      .select({ albumId: tracks.albumId })
      .from(tracks)
      .innerJoin(albums, eq(tracks.albumId, albums.id))
      .where(and(eq(albums.artistId, artistId), eq(tracks.hasFile, true)))
      .all()
      .map((r) => r.albumId),
  );
}

/** Sets every album's monitored flag of the artist from a monitor option. */
export function applyMusicMonitorOption(db: MusicDb, artistId: number, option: MusicMonitorOption, now: string = nowIso()): void {
  artistRow(db, artistId);
  const rows = db.select({ id: albums.id, releaseDate: albums.releaseDate, monitored: albums.monitored }).from(albums).where(eq(albums.artistId, artistId)).all();
  const withFiles = albumsWithFiles(db, artistId);
  const keep = albumsToMonitor(
    option,
    rows.map((r) => ({ id: r.id, releaseDate: r.releaseDate, hasFiles: withFiles.has(r.id) })),
    new Date(now),
  );
  for (const r of rows) {
    const monitored = keep.has(r.id);
    if (monitored !== r.monitored) db.update(albums).set({ monitored }).where(eq(albums.id, r.id)).run();
  }
}

export type ReleaseGroupSyncMode = { kind: 'add'; option: MusicMonitorOption } | { kind: 'refresh'; monitorNewAlbums: MonitorNewAlbums };

export interface ReleaseGroupSyncResult {
  added: number[];
  updated: number;
  removed: number;
}

/**
 * Reconciles the artist's albums with its release groups. Groups that pass the artist's
 * album-type profile become (or stay) albums with fresh metadata; existing albums keep their
 * monitored flag and edition. New albums are monitored by the add option (on add) or by
 * `monitor_new_albums` (on refresh). Albums whose group vanished or no longer passes the profile
 * are removed unless they have files. `covers` gives each new album its images.
 */
export function syncReleaseGroups(
  db: Db,
  artistId: number,
  groups: readonly MbReleaseGroup[],
  mode: ReleaseGroupSyncMode,
  covers: (mbReleaseGroupId: string) => MusicImage[],
  now: string = nowIso(),
): ReleaseGroupSyncResult {
  return db.transaction((tx) => {
    const artist = artistRow(tx, artistId);
    const profile = getAlbumTypeProfile(tx, artist.albumTypeProfileId);
    const kept = groups.map(releaseGroupFrom).filter((g) => albumPassesTypeProfile(profile, g));
    const existing = new Map(
      tx
        .select()
        .from(albums)
        .where(eq(albums.artistId, artistId))
        .all()
        .map((r) => [r.mbReleaseGroupId, r]),
    );
    const result: ReleaseGroupSyncResult = { added: [], updated: 0, removed: 0 };
    const nowDate = new Date(now);
    for (const g of kept) {
      const columns = {
        title: g.title,
        cleanTitle: libraryService.toCleanTitle(g.title),
        disambiguation: g.disambiguation,
        primaryType: g.primaryType,
        secondaryTypes: g.secondaryTypes,
        releaseDate: g.releaseDate,
        year: g.year,
        lastRefreshed: now,
      };
      const row = existing.get(g.mbReleaseGroupId);
      if (row) {
        tx.update(albums).set(columns).where(eq(albums.id, row.id)).run();
        existing.delete(g.mbReleaseGroupId);
        result.updated++;
        continue;
      }
      // A release group can only belong to one artist row (unique id): skip groups another
      // artist in the library already has (collaborations).
      if (tx.select({ id: albums.id }).from(albums).where(eq(albums.mbReleaseGroupId, g.mbReleaseGroupId)).get()) continue;
      const monitored = mode.kind === 'refresh' ? monitorNewAlbum(mode.monitorNewAlbums, g.releaseDate, nowDate) : true;
      const inserted = tx
        .insert(albums)
        .values({
          ...columns,
          artistId,
          mbReleaseGroupId: g.mbReleaseGroupId,
          overview: '',
          genres: [],
          images: covers(g.mbReleaseGroupId),
          ratings: {},
          monitored,
          anyReleaseOk: true,
          selectedReleaseId: null,
          added: now,
        })
        .returning({ id: albums.id })
        .get();
      result.added.push(inserted.id);
    }
    const withFiles = albumsWithFiles(tx, artistId);
    for (const row of existing.values()) {
      if (withFiles.has(row.id)) continue;
      tx.delete(albums).where(eq(albums.id, row.id)).run();
      result.removed++;
    }
    if (mode.kind === 'add') applyMusicMonitorOption(tx, artistId, mode.option, now);
    return result;
  });
}

/** Upserts the album's editions (browse results, no tracks). Returns all edition rows. */
export function saveReleases(db: Db, albumId: number, summaries: readonly MbReleaseSummary[]): AlbumReleaseRow[] {
  return db.transaction((tx) => {
    albumRow(tx, albumId);
    const existing = new Map(
      tx
        .select()
        .from(albumReleases)
        .where(eq(albumReleases.albumId, albumId))
        .all()
        .map((r) => [r.mbReleaseId, r]),
    );
    for (const s of summaries) {
      const cols = releaseSummaryColumns(s);
      const row = existing.get(cols.mbReleaseId);
      if (row) {
        // Labels, catalogue number and duration come from the full release; keep them.
        tx.update(albumReleases).set(cols).where(eq(albumReleases.id, row.id)).run();
      } else {
        const taken = tx.select({ id: albumReleases.id }).from(albumReleases).where(eq(albumReleases.mbReleaseId, cols.mbReleaseId)).get();
        if (taken) continue; // listed under another album (merged groups); leave it there
        tx.insert(albumReleases)
          .values({ ...cols, albumId, labels: [], catalogNumber: null, durationMs: null })
          .run();
      }
    }
    return tx.select().from(albumReleases).where(eq(albumReleases.albumId, albumId)).all();
  });
}

export function releaseRows(db: MusicDb, albumId: number): AlbumReleaseRow[] {
  return db.select().from(albumReleases).where(eq(albumReleases.albumId, albumId)).all();
}

export function releaseRow(db: MusicDb, albumId: number, releaseId: number): AlbumReleaseRow {
  const row = db.select().from(albumReleases).where(and(eq(albumReleases.id, releaseId), eq(albumReleases.albumId, albumId))).get();
  if (!row) throw new LibraryError('VALIDATION', `release ${releaseId} is not an edition of album ${albumId}`);
  return row;
}

/**
 * Makes `release` (fetched with its tracks) the album's selected edition: stores its full
 * columns, replaces the stored tracks with its tracks, and re-links the album's files to the new
 * tracks by MusicBrainz recording id, then by disc/track position. Returns how many tracks
 * have a file afterwards.
 */
export function selectRelease(db: Db, albumId: number, release: MbRelease, artistName: string): { linked: number } {
  return db.transaction((tx) => {
    albumRow(tx, albumId);
    const cols = releaseSummaryColumns(release);
    const full = {
      ...cols,
      labels: release.labels.map((l) => ({ name: l.name, catalogNumber: l.catalogNumber ?? null })),
      catalogNumber: release.labels.find((l) => l.catalogNumber)?.catalogNumber ?? null,
      durationMs: release.durationMs ?? null,
    };
    let row = tx.select().from(albumReleases).where(eq(albumReleases.mbReleaseId, cols.mbReleaseId)).get();
    if (row && row.albumId !== albumId) throw new LibraryError('VALIDATION', `release ${cols.mbReleaseId} belongs to another album`);
    if (row) tx.update(albumReleases).set(full).where(eq(albumReleases.id, row.id)).run();
    else row = tx.insert(albumReleases).values({ ...full, albumId }).returning().get();
    const releaseId = row.id;

    // Links of the tracks being replaced, and the album's files not linked to any track.
    const old = tx.select().from(tracks).where(eq(tracks.albumId, albumId)).all();
    const fileRows = tx.select().from(audioFiles).where(eq(audioFiles.albumId, albumId)).all();
    const byRecording = new Map<string, number>();
    const byPosition = new Map<string, number>();
    const linkedIds = new Set<number>();
    for (const t of old) {
      if (t.audioFileId == null) continue;
      linkedIds.add(t.audioFileId);
      if (t.mbRecordingId) byRecording.set(t.mbRecordingId, t.audioFileId);
      byPosition.set(`${t.mediumNumber}:${t.trackNumber}`, t.audioFileId);
    }
    for (const f of fileRows) {
      if (linkedIds.has(f.id)) continue;
      const rec = f.tags?.mbRecordingId;
      if (rec && !byRecording.has(rec)) byRecording.set(rec, f.id);
      if (f.trackNumber != null) {
        const key = `${f.discNumber ?? 1}:${f.trackNumber}`;
        if (!byPosition.has(key)) byPosition.set(key, f.id);
      }
    }
    tx.delete(tracks).where(eq(tracks.albumId, albumId)).run();

    const fresh = release.media.flatMap((m) =>
      m.tracks.map((t) => {
        const credit = formatArtistCredit(t.artistCredits);
        return {
          albumId,
          albumReleaseId: releaseId,
          mbTrackId: t.mbid,
          mbRecordingId: t.recordingMbid,
          mediumNumber: t.mediumNumber,
          absoluteNumber: t.absoluteNumber,
          trackNumber: t.position,
          title: t.title,
          durationMs: t.durationMs ?? null,
          artistCredit: credit && credit !== artistName ? credit : null,
          hasFile: false,
          audioFileId: null as number | null,
        };
      }),
    );
    const used = new Set<number>();
    for (const t of fresh) {
      const id = t.mbRecordingId ? byRecording.get(t.mbRecordingId) : undefined;
      if (id !== undefined && !used.has(id)) {
        t.audioFileId = id;
        used.add(id);
      }
    }
    for (const t of fresh) {
      if (t.audioFileId !== null) continue;
      const id = byPosition.get(`${t.mediumNumber}:${t.trackNumber}`);
      if (id !== undefined && !used.has(id)) {
        t.audioFileId = id;
        used.add(id);
      }
    }
    for (const t of fresh) {
      t.hasFile = t.audioFileId !== null;
      tx.insert(tracks).values(t).run();
    }
    tx.update(albums).set({ selectedReleaseId: releaseId }).where(eq(albums.id, albumId)).run();
    return { linked: used.size };
  });
}

// ---------------------------------------------------------------------------------------
// Audio files and rescans
// ---------------------------------------------------------------------------------------

/**
 * "Allow upgrades again" for an audio file grabbed with "Grab anyway". Upgrades are decided per
 * album (music) or per book (audiobooks), so the override is cleared on every file of the same
 * album / book. Returns the files that changed (empty when none carried an override).
 */
export function clearAudioGrabOverride(db: MusicDb, id: number): AudioFile[] {
  const file = db.select().from(audioFiles).where(eq(audioFiles.id, id)).get();
  if (!file) throw LibraryError.notFound('audio file', id);
  const scope =
    file.albumId !== null ? eq(audioFiles.albumId, file.albumId) : file.bookId !== null ? eq(audioFiles.bookId, file.bookId) : eq(audioFiles.id, file.id);
  const where = and(eq(audioFiles.mediaType, file.mediaType), scope, isNotNull(audioFiles.grabOverride));
  const rows = db.update(audioFiles).set({ grabOverride: null }).where(where).returning().all();
  return rows.map(toAudioFile);
}

export function listAudioFiles(db: MusicDb, query: AudioFileListQuery): AudioFile[] {
  const where: SQL[] = [eq(audioFiles.mediaType, 'music')];
  if (query.artistId !== undefined) where.push(eq(audioFiles.artistId, query.artistId));
  if (query.albumId !== undefined) where.push(eq(audioFiles.albumId, query.albumId));
  return db.select().from(audioFiles).where(and(...where)).orderBy(asc(audioFiles.path)).all().map(toAudioFile);
}

/** The artist's albums as the track matcher sees them: the selected edition with its tracks. */
export function knownAlbumsFor(db: MusicDb, artistId: number): KnownAlbum[] {
  const rows = db.select().from(albums).where(and(eq(albums.artistId, artistId), isNotNull(albums.selectedReleaseId))).all();
  if (rows.length === 0) return [];
  const releaseById = new Map(
    db
      .select()
      .from(albumReleases)
      .where(inArray(albumReleases.id, rows.map((r) => r.selectedReleaseId!)))
      .all()
      .map((r) => [r.id, r]),
  );
  const trackRows = db.select().from(tracks).where(inArray(tracks.albumId, rows.map((r) => r.id))).all();
  const out: KnownAlbum[] = [];
  for (const album of rows) {
    const release = releaseById.get(album.selectedReleaseId!);
    const own = trackRows.filter((t) => t.albumId === album.id && t.albumReleaseId === album.selectedReleaseId);
    if (!release || own.length === 0) continue;
    const media = new Map<number, typeof own>();
    for (const t of own) media.set(t.mediumNumber, [...(media.get(t.mediumNumber) ?? []), t]);
    out.push({
      albumId: album.id,
      title: album.title,
      mbReleaseGroupId: album.mbReleaseGroupId,
      selectedReleaseId: release.mbReleaseId,
      // Only the selected edition's tracks are stored, so a rescan matches against it alone.
      anyReleaseOk: false,
      releases: [
        {
          id: release.mbReleaseId,
          title: release.title,
          ref: release.id,
          preferred: true,
          media: [...media.entries()]
            .sort(([a], [b]) => a - b)
            .map(([position, list]) => ({
              position,
              format: release.media.find((m) => m.position === position)?.format ?? null,
              tracks: list
                .sort((a, b) => a.trackNumber - b.trackNumber)
                .map((t) => ({
                  position: t.trackNumber,
                  title: t.title,
                  durationMs: t.durationMs,
                  recordingId: t.mbRecordingId,
                  trackId: t.mbTrackId,
                  artist: t.artistCredit,
                  ref: t.id,
                })),
            })),
        },
      ],
    });
  }
  return out;
}

export interface RescanWriteResult {
  added: number;
  updated: number;
  removed: number;
  /** Tracks with a file after the rescan. */
  linked: number;
  unmatchedGroups: number;
  unmatchedFiles: number;
}

type TrackAssignmentRow = RescanArtistResult['assignments'][number];

/** The `audio_files` columns of one matched track file. */
function trackFileValues(artistId: number, albumId: number, a: TrackAssignmentRow) {
  const t = a.tags;
  return {
    mediaType: 'music' as const,
    artistId,
    albumId,
    authorId: null,
    bookId: null,
    path: a.path,
    relativePath: a.relativePath,
    sizeBytes: a.sizeBytes,
    mtime: new Date(a.mtimeMs).toISOString(),
    quality: musicQualityFor({ codec: t.codec, container: t.container, bitrateKbps: t.bitrateKbps, bitDepth: t.bitDepth }),
    codec: t.codec,
    container: t.container,
    bitrateKbps: t.bitrateKbps !== null ? Math.round(t.bitrateKbps) : null,
    sampleRateHz: t.sampleRateHz,
    bitDepth: t.bitDepth,
    channels: t.channels,
    durationMs: t.durationMs !== null ? Math.round(t.durationMs) : null,
    discNumber: t.discNo ?? a.mediumNumber,
    trackNumber: t.trackNo ?? a.trackPosition,
    partNumber: null,
    chapterCount: t.chapters ? t.chapters.length : null,
    tags: fileTags(t),
    mediaInfo: {
      source: t.source,
      lossless: t.lossless,
      ...(t.chapters && t.chapters.length > 0 ? { chapters: t.chapters.map((c) => ({ title: c.title, startMs: Math.round(c.startMs) })) } : {}),
    },
  };
}

/** Inserts or refreshes the file row of one assignment and links its track. Returns the row id and whether it was new. */
function writeTrackFile(tx: MusicDb, artistId: number, albumId: number, a: TrackAssignmentRow, prior: AudioFileRow | undefined, now: string): { id: number; added: boolean } {
  const values = trackFileValues(artistId, albumId, a);
  const row = prior ?? tx.select().from(audioFiles).where(eq(audioFiles.path, a.path)).get();
  let id: number;
  if (row) {
    tx.update(audioFiles).set(values).where(eq(audioFiles.id, row.id)).run();
    id = row.id;
  } else {
    id = tx.insert(audioFiles).values({ ...values, dateAdded: now }).returning({ id: audioFiles.id }).get().id;
  }
  tx.update(tracks).set({ hasFile: true, audioFileId: id }).where(eq(tracks.id, a.trackRef as number)).run();
  return { id, added: !row };
}

/**
 * Writes a rescan of the artist folder: one `audio_files` row per matched file (inserted or
 * refreshed by path), `tracks.has_file` / `audio_file_id` set from the assignments, and rows of
 * files that are gone or now match another track removed. Rows the scan cannot speak for keep
 * their track: files outside the artist folder (linked in place by a library import) and files
 * it found but could not match (linked by hand), so a rescan never undoes a manual decision.
 */
export function applyRescan(db: Db, artistId: number, result: RescanArtistResult, now: string = nowIso()): RescanWriteResult {
  return db.transaction((tx) => {
    const artist = artistRow(tx, artistId);
    const existing = new Map(
      tx
        .select()
        .from(audioFiles)
        .where(and(eq(audioFiles.mediaType, 'music'), eq(audioFiles.artistId, artistId)))
        .all()
        .map((r) => [r.path, r]),
    );
    const albumIds = tx.select({ id: albums.id }).from(albums).where(eq(albums.artistId, artistId)).all().map((r) => r.id);
    const out: RescanWriteResult = {
      added: 0,
      updated: 0,
      removed: 0,
      linked: 0,
      unmatchedGroups: result.unmatchedGroups.length,
      unmatchedFiles: result.unmatchedFiles.length,
    };
    // Rows the scan cannot speak for (see above) keep their tracks through the reset.
    const assigned = new Set(result.assignments.map((a) => a.path));
    const unmatched = new Set([...result.unmatchedGroups.flatMap((g) => g.group.files.map((f) => f.path)), ...result.unmatchedFiles.map((f) => f.path)]);
    const kept = [...existing.values()].filter(
      (r) => !assigned.has(r.path) && r.albumId !== null && albumIds.includes(r.albumId) && (unmatched.has(r.path) || !isPathInside(artist.path, r.path)),
    );
    const keptTracks =
      kept.length === 0
        ? []
        : tx
            .select({ id: tracks.id, audioFileId: tracks.audioFileId })
            .from(tracks)
            .where(inArray(tracks.audioFileId, kept.map((r) => r.id)))
            .all();
    if (albumIds.length > 0) {
      tx.update(tracks).set({ hasFile: false, audioFileId: null }).where(inArray(tracks.albumId, albumIds)).run();
    }
    for (const t of keptTracks) tx.update(tracks).set({ hasFile: true, audioFileId: t.audioFileId }).where(eq(tracks.id, t.id)).run();
    const seen = new Set<string>(kept.map((r) => r.path));
    for (const a of result.assignments) {
      const albumId = Number(a.albumId);
      if (!albumIds.includes(albumId) || typeof a.trackRef !== 'number') continue;
      const w = writeTrackFile(tx, artistId, albumId, a, existing.get(a.path), now);
      if (w.added) out.added++;
      else out.updated++;
      seen.add(a.path);
      out.linked++;
    }
    for (const [path, row] of existing) {
      if (seen.has(path)) continue;
      tx.delete(audioFiles).where(eq(audioFiles.id, row.id)).run();
      out.removed++;
    }
    return out;
  });
}

/**
 * Links matched files to their tracks where they are (library import, in place): like a rescan
 * for the given assignments only. Nothing else of the artist changes; a track that had another
 * file keeps that row (unlinked from the track).
 */
export function linkTrackFiles(db: Db, artistId: number, assignments: readonly TrackAssignmentRow[], now: string = nowIso()): { added: number; updated: number; linked: number } {
  return db.transaction((tx) => {
    artistRow(tx, artistId);
    const albumIds = new Set(tx.select({ id: albums.id }).from(albums).where(eq(albums.artistId, artistId)).all().map((r) => r.id));
    const out = { added: 0, updated: 0, linked: 0 };
    for (const a of assignments) {
      const albumId = Number(a.albumId);
      if (!albumIds.has(albumId) || typeof a.trackRef !== 'number') continue;
      const w = writeTrackFile(tx, artistId, albumId, a, undefined, now);
      if (w.added) out.added++;
      else out.updated++;
      out.linked++;
    }
    return out;
  });
}

/**
 * Adds one release group as an album of the artist (library import of an album the artist's
 * album-type profile would not list, or before the artist's albums are loaded). Returns the
 * album id; an album that already exists is returned as it is.
 */
export function addReleaseGroupAlbum(db: Db, artistId: number, group: MbReleaseGroup, covers: (mbReleaseGroupId: string) => MusicImage[], monitored: boolean, now: string = nowIso()): number {
  return db.transaction((tx) => {
    artistRow(tx, artistId);
    const g = releaseGroupFrom(group);
    const hit = tx.select({ id: albums.id }).from(albums).where(eq(albums.mbReleaseGroupId, g.mbReleaseGroupId)).get();
    if (hit) return hit.id;
    return tx
      .insert(albums)
      .values({
        title: g.title,
        cleanTitle: libraryService.toCleanTitle(g.title),
        disambiguation: g.disambiguation,
        primaryType: g.primaryType,
        secondaryTypes: g.secondaryTypes,
        releaseDate: g.releaseDate,
        year: g.year,
        lastRefreshed: now,
        artistId,
        mbReleaseGroupId: g.mbReleaseGroupId,
        overview: '',
        genres: [],
        images: covers(g.mbReleaseGroupId),
        ratings: {},
        monitored,
        anyReleaseOk: true,
        selectedReleaseId: null,
        added: now,
      })
      .returning({ id: albums.id })
      .get().id;
  });
}


function fileTags(t: RescanArtistResult['assignments'][number]['tags']): AudioFileTags {
  return {
    title: t.title,
    artist: t.artist,
    albumArtist: t.albumArtist,
    album: t.album,
    date: t.date,
    trackNo: t.trackNo,
    trackOf: t.trackOf,
    discNo: t.discNo,
    discOf: t.discOf,
    mbRecordingId: t.mbRecordingId,
    mbReleaseId: t.mbReleaseId,
    mbReleaseGroupId: t.mbReleaseGroupId,
    mbArtistId: t.mbArtistId,
  };
}

// ---------------------------------------------------------------------------------------
// Wanted (read-only in Wave 1)
// ---------------------------------------------------------------------------------------

function paginate<T>(items: T[], q: WantedAlbumsQuery): { page: number; pageSize: number; totalRecords: number; records: T[] } {
  const start = (q.page - 1) * q.pageSize;
  return { page: q.page, pageSize: q.pageSize, totalRecords: items.length, records: items.slice(start, start + q.pageSize) };
}

function monitoredAlbumsOfMonitoredArtists(db: MusicDb) {
  return db
    .select({ album: albums, artist: artists })
    .from(albums)
    .innerJoin(artists, eq(albums.artistId, artists.id))
    .where(and(eq(albums.monitored, true), eq(artists.monitored, true)))
    .orderBy(desc(albums.releaseDate), asc(artists.sortName), asc(albums.title), asc(albums.id))
    .all();
}

function toWanted(album: AlbumRow, artist: ArtistRow, stats: AlbumStatistics | undefined): WantedAlbum {
  return { ...toAlbum(album, stats), artistName: artist.name, mbArtistId: artist.mbArtistId, qualityProfileId: artist.qualityProfileId };
}

/**
 * Monitored albums (of monitored artists) that are released and lack files: fewer track files
 * than stored tracks, or no tracks loaded yet and nothing on disk. Newest first.
 */
export function listMissingAlbums(db: MusicDb, q: WantedAlbumsQuery, now: Date = new Date()): WantedAlbumsPage {
  const rows = monitoredAlbumsOfMonitoredArtists(db).filter((r) => isReleased(r.album.releaseDate, now));
  const stats = albumStatistics(
    db,
    rows.map((r) => r.album.id),
  );
  const missing = rows.filter((r) => {
    const s = stats.get(r.album.id);
    if (!s) return true;
    return s.trackCount > 0 ? s.trackFileCount < s.trackCount : s.sizeOnDisk === 0;
  });
  return paginate(
    missing.map((r) => toWanted(r.album, r.artist, stats.get(r.album.id))),
    q,
  );
}

/**
 * Monitored albums with files whose lowest track-file quality is below the artist's profile
 * cutoff. Custom-format scores for audio arrive in Wave 2; only the quality cutoff counts here.
 */
export function listCutoffUnmetAlbums(db: MusicDb, q: WantedAlbumsQuery, profiles: readonly QualityProfile[]): WantedAlbumsPage {
  const byId = new Map(profiles.map((p) => [p.id, p]));
  const rows = monitoredAlbumsOfMonitoredArtists(db);
  if (rows.length === 0) return paginate([], q);
  const files = db
    .select({ albumId: audioFiles.albumId, quality: audioFiles.quality, grabOverride: audioFiles.grabOverride })
    .from(audioFiles)
    .where(inArray(audioFiles.albumId, rows.map((r) => r.album.id)))
    .all();
  const byAlbum = new Map<number, typeof files>();
  for (const f of files) if (f.albumId !== null) byAlbum.set(f.albumId, [...(byAlbum.get(f.albumId) ?? []), f]);
  const unmet = rows.filter((r) => {
    const own = byAlbum.get(r.album.id);
    const profile = byId.get(r.artist.qualityProfileId);
    if (!own || own.length === 0 || !profile) return false;
    // Kept by the user's choice ("Grab anyway"): upgrades are paused until they allow them again.
    if (own.some((f) => f.grabOverride != null)) return false;
    return own.some((f) => !isQualityCutoffMet(profile, f.quality));
  });
  const stats = albumStatistics(
    db,
    unmet.map((r) => r.album.id),
  );
  return paginate(
    unmet.map((r) => toWanted(r.album, r.artist, stats.get(r.album.id))),
    q,
  );
}

/** Ordering helper for refresh: albums of the artist, monitored first, then newest first. */
export function albumsForTrackLoading(db: MusicDb, artistId: number): AlbumRow[] {
  return db
    .select()
    .from(albums)
    .where(eq(albums.artistId, artistId))
    .all()
    .sort(
      (a, b) =>
        Number(b.monitored) - Number(a.monitored) ||
        (releaseDateMs(b.releaseDate) ?? 0) - (releaseDateMs(a.releaseDate) ?? 0) ||
        a.id - b.id,
    );
}

export { albumRow, artistRow };
