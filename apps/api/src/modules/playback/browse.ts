import { sql, type SQL } from 'drizzle-orm';
import {
  itemKey,
  rankMatches,
  searchWords,
  type AudiobookHome,
  type BrowseQuery,
  type ContentRestrictions,
  type MusicHome,
  type PlaybackProgress,
  type PlayerAlbum,
  type PlayerAlbumDetails,
  type PlayerArtist,
  type PlayerArtistDetails,
  type PlayerAudiobook,
  type PlayerAudiobookDetails,
  type PlayerSearchResponse,
  type PlayerTrack,
} from '@arclight/shared';
import type { Db } from '../../db/index.js';
import { listSearchCondition } from '../../db/list-search.js';
import { commonLabel, formatLabel, isLossless, type FormatFields } from './format.js';
import { artworkUrl, playableItem } from './items.js';
import type { PlaybackOwner, ProgressStore } from './progress.js';
import type { FastifyRequest } from 'fastify';
import { restrictionsFor } from '../requests/certification.js';

// Browse queries of the player. Everything is limited to items with files: tracks joined to
// their audio file, albums and artists through such tracks, books with at least one audio file.
// Raw SQL keeps the joins and aggregates readable; values always go through bound parameters.
//
// Content caps: the library has no explicit-track flag and no adult flag on books, so `explicit`
// is always false and nothing is filtered by age yet.

export interface BrowseUser {
  /** Null for an admin credential without a user (API key): no personal state. */
  userId: number | null;
  settings: unknown;
  /** The active household profile (null without a user): every personal row is keyed by it. */
  profileId: number | null;
  /** The owner profile is active (only it merges media-server watch state). */
  isOwnerProfile: boolean;
  /** The account's caps combined with the profile's (restrictionsFor); null: none. */
  restrictions: ContentRestrictions | null;
}

/** The browse identity of a request: account, active household profile and combined caps. */
export function browseUserOf(req: FastifyRequest): BrowseUser {
  const auth = req.auth;
  const user = auth?.user ?? null;
  const profile = user ? (auth?.profile ?? null) : null;
  return {
    userId: user && profile ? user.id : null,
    settings: user?.settings ?? null,
    profileId: profile?.id ?? null,
    isOwnerProfile: profile?.isOwner ?? false,
    restrictions: restrictionsFor(auth),
  };
}

/** Whose rows a browse user reads and writes; null without a user (or profile). */
export function ownerOfBrowse(user: BrowseUser): PlaybackOwner | null {
  if (user.userId === null || user.profileId === null) return null;
  return { userId: user.userId, profileId: user.profileId, isOwnerProfile: user.isOwnerProfile };
}

export interface BrowseContext {
  db: Db;
  basePath: string;
  progress: ProgressStore;
}

/** The profile id personal rows are matched on (-1: none, so nothing matches). */
const uid = (u: BrowseUser) => u.profileId ?? -1;
const and = (parts: Array<SQL | undefined>): SQL => {
  const list = parts.filter((p): p is SQL => p !== undefined);
  return list.length === 0 ? sql`1 = 1` : sql.join(list, sql` AND `);
};

/** The A-Z rail: a letter, or "#" for anything else. */
function letterCondition(column: SQL, letter: string | undefined): SQL | undefined {
  if (!letter) return undefined;
  if (letter === '#') return sql`NOT (upper(substr(${column}, 1, 1)) BETWEEN 'A' AND 'Z')`;
  return sql`upper(substr(${column}, 1, 1)) = ${letter.toUpperCase()}`;
}

function genreCondition(column: SQL, genre: string | undefined): SQL | undefined {
  if (!genre) return undefined;
  return sql`EXISTS (SELECT 1 FROM json_each(${column}) WHERE lower(json_each.value) = ${genre.toLowerCase()})`;
}

const dir = (desc: boolean) => sql.raw(desc ? 'DESC' : 'ASC');
const offsetOf = (q: BrowseQuery) => (q.page - 1) * q.pageSize;

// ---------------------------------------------------------------------------------------
// Tracks
// ---------------------------------------------------------------------------------------

interface TrackRow extends FormatFields {
  id: number;
  title: string;
  disc: number | null;
  trackNo: number | null;
  durationMs: number;
  artistCredit: string | null;
  albumId: number;
  albumTitle: string;
  artistId: number;
  artistName: string;
}

const TRACK_FROM = sql.raw(`
  SELECT t.id AS id, t.title AS title, t.medium_number AS disc, t.track_number AS trackNo,
    coalesce(f.duration_ms, t.duration_ms, 0) AS durationMs, t.artist_credit AS artistCredit,
    al.id AS albumId, al.title AS albumTitle, ar.id AS artistId, ar.name AS artistName,
    f.codec AS codec, f.container AS container, f.bitrate_kbps AS bitrateKbps,
    f.sample_rate_hz AS sampleRateHz, f.bit_depth AS bitDepth
  FROM tracks t
  JOIN audio_files f ON f.id = t.audio_file_id
  JOIN albums al ON al.id = t.album_id
  JOIN artists ar ON ar.id = al.artist_id`);

function toTrack(ctx: BrowseContext, r: TrackRow): PlayerTrack {
  return {
    id: r.id,
    itemKey: itemKey('track', r.id),
    title: r.title,
    artistName: r.artistCredit || r.artistName,
    artistId: r.artistId,
    albumTitle: r.albumTitle,
    albumId: r.albumId,
    discNumber: r.disc,
    trackNumber: r.trackNo,
    durationMs: r.durationMs,
    formatLabel: formatLabel(r),
    lossless: isLossless(r),
    artworkUrl: artworkUrl(ctx.basePath, 'album', r.albumId),
    explicit: false,
  };
}

/** Tracks by id, in the order given (unknown or file-less ids are skipped; repeats kept). */
export function tracksByIds(ctx: BrowseContext, ids: readonly number[]): PlayerTrack[] {
  if (ids.length === 0) return [];
  const unique = [...new Set(ids)];
  const rows = new Map<number, TrackRow>();
  for (let i = 0; i < unique.length; i += 500) {
    const chunk = unique.slice(i, i + 500);
    for (const r of ctx.db.all<TrackRow>(sql`${TRACK_FROM} WHERE t.id IN (${sql.join(chunk.map((id) => sql`${id}`), sql`, `)})`)) rows.set(r.id, r);
  }
  return ids.flatMap((id) => {
    const r = rows.get(id);
    return r ? [toTrack(ctx, r)] : [];
  });
}

const TRACK_ORDER_IN_ALBUM = sql.raw('t.medium_number, t.track_number, t.absolute_number, t.id');

export function trackPage(ctx: BrowseContext, user: BrowseUser, q: BrowseQuery) {
  const where = and([
    listSearchCondition(q.search, [sql`t.title`, sql`al.title`, sql`ar.name`, sql`t.artist_credit`]),
    letterCondition(sql`t.title`, q.letter),
    genreCondition(sql`al.genres`, q.genre),
  ]);
  const played = sql`(SELECT p.last_played_at FROM playback_progress p WHERE p.profile_id = ${uid(user)} AND p.item_key = 'track:' || t.id)`;
  const order: Record<BrowseQuery['sort'], SQL> = {
    name: sql`t.title COLLATE NOCASE ${dir(q.desc)}, t.id`,
    added: sql`f.date_added ${dir(!q.desc)}, t.id`,
    played: sql`${played} IS NULL, ${played} ${dir(!q.desc)}, t.id`,
    year: sql`al.year ${dir(q.desc)}, al.title COLLATE NOCASE, ${TRACK_ORDER_IN_ALBUM}`,
    artist: sql`ar.sort_name COLLATE NOCASE ${dir(q.desc)}, al.year, al.title COLLATE NOCASE, ${TRACK_ORDER_IN_ALBUM}`,
  };
  const total = ctx.db.get<{ n: number }>(sql`SELECT count(*) AS n FROM (${TRACK_FROM} WHERE ${where})`)?.n ?? 0;
  const rows = ctx.db.all<TrackRow>(sql`${TRACK_FROM} WHERE ${where} ORDER BY ${order[q.sort]} LIMIT ${q.pageSize} OFFSET ${offsetOf(q)}`);
  return { items: rows.map((r) => toTrack(ctx, r)), total, page: q.page, pageSize: q.pageSize };
}

// ---------------------------------------------------------------------------------------
// Albums
// ---------------------------------------------------------------------------------------

interface AlbumRow {
  id: number;
  title: string;
  artistName: string;
  artistId: number;
  year: number | null;
  albumType: string | null;
  trackCount: number;
  durationMs: number;
  addedAt: string | null;
  genres: string;
}

const ALBUM_FROM = sql.raw(`
  SELECT al.id AS id, al.title AS title, ar.name AS artistName, ar.id AS artistId, al.year AS year,
    al.primary_type AS albumType, count(t.id) AS trackCount,
    sum(coalesce(f.duration_ms, t.duration_ms, 0)) AS durationMs, max(f.date_added) AS addedAt,
    al.genres AS genres
  FROM albums al
  JOIN artists ar ON ar.id = al.artist_id
  JOIN tracks t ON t.album_id = al.id
  JOIN audio_files f ON f.id = t.audio_file_id`);

function parseList(json: string | null): string[] {
  try {
    const v = JSON.parse(json ?? '[]') as unknown;
    return Array.isArray(v) ? v.filter((g): g is string => typeof g === 'string') : [];
  } catch {
    return [];
  }
}

/** Format labels of albums (the most common among each album's files). */
function albumLabels(db: Db, ids: readonly number[]): Map<number, { label: string | null; lossless: boolean }> {
  const out = new Map<number, { label: string | null; lossless: boolean }>();
  if (ids.length === 0) return out;
  const rows = db.all<FormatFields & { albumId: number }>(sql`
    SELECT t.album_id AS albumId, f.codec AS codec, f.container AS container, f.bitrate_kbps AS bitrateKbps,
      f.sample_rate_hz AS sampleRateHz, f.bit_depth AS bitDepth
    FROM tracks t JOIN audio_files f ON f.id = t.audio_file_id
    WHERE t.album_id IN (${sql.join(ids.map((id) => sql`${id}`), sql`, `)})`);
  const byAlbum = new Map<number, Array<FormatFields>>();
  for (const r of rows) byAlbum.set(r.albumId, [...(byAlbum.get(r.albumId) ?? []), r]);
  for (const [id, files] of byAlbum) {
    const label = commonLabel(files.map(formatLabel));
    const sample = files.find((f) => formatLabel(f) === label) ?? files[0]!;
    out.set(id, { label, lossless: isLossless(sample) });
  }
  return out;
}

function toAlbums(ctx: BrowseContext, rows: readonly AlbumRow[]): PlayerAlbum[] {
  const labels = albumLabels(
    ctx.db,
    rows.map((r) => r.id),
  );
  return rows.map((r) => ({
    id: r.id,
    title: r.title,
    artistName: r.artistName,
    artistId: r.artistId,
    year: r.year,
    albumType: r.albumType,
    trackCount: r.trackCount,
    durationMs: r.durationMs ?? 0,
    formatLabel: labels.get(r.id)?.label ?? null,
    lossless: labels.get(r.id)?.lossless ?? false,
    artworkUrl: artworkUrl(ctx.basePath, 'album', r.id),
    addedAt: r.addedAt,
    genres: parseList(r.genres),
  }));
}

function albumQuery(ctx: BrowseContext, where: SQL, order: SQL, limit: number, offset = 0): PlayerAlbum[] {
  return toAlbums(ctx, ctx.db.all<AlbumRow>(sql`${ALBUM_FROM} WHERE ${where} GROUP BY al.id ORDER BY ${order} LIMIT ${limit} OFFSET ${offset}`));
}

const albumPlayed = (user: BrowseUser) =>
  sql`(SELECT max(p.last_played_at) FROM playback_progress p JOIN tracks t2 ON p.item_key = 'track:' || t2.id WHERE t2.album_id = al.id AND p.profile_id = ${uid(user)})`;

export function albumPage(ctx: BrowseContext, user: BrowseUser, q: BrowseQuery) {
  const where = and([
    listSearchCondition(q.search, [sql`al.title`, sql`ar.name`]),
    letterCondition(sql`al.title`, q.letter),
    genreCondition(sql`al.genres`, q.genre),
  ]);
  const played = albumPlayed(user);
  const order: Record<BrowseQuery['sort'], SQL> = {
    name: sql`al.title COLLATE NOCASE ${dir(q.desc)}, al.id`,
    added: sql`max(f.date_added) ${dir(!q.desc)}, al.id`,
    played: sql`${played} IS NULL, ${played} ${dir(!q.desc)}, al.id`,
    year: sql`al.year ${dir(q.desc)}, al.title COLLATE NOCASE, al.id`,
    artist: sql`ar.sort_name COLLATE NOCASE ${dir(q.desc)}, al.year, al.id`,
  };
  const total = ctx.db.get<{ n: number }>(sql`SELECT count(*) AS n FROM (${ALBUM_FROM} WHERE ${where} GROUP BY al.id)`)?.n ?? 0;
  return { items: albumQuery(ctx, where, order[q.sort], q.pageSize, offsetOf(q)), total, page: q.page, pageSize: q.pageSize };
}

export function albumDetails(ctx: BrowseContext, id: number): PlayerAlbumDetails | null {
  const [album] = albumQuery(ctx, sql`al.id = ${id}`, sql`al.id`, 1);
  if (!album) return null;
  const rows = ctx.db.all<TrackRow>(sql`${TRACK_FROM} WHERE t.album_id = ${id} ORDER BY ${TRACK_ORDER_IN_ALBUM}`);
  const tracks = rows.map((r) => toTrack(ctx, r));
  return { ...album, tracks, discCount: new Set(rows.map((r) => r.disc ?? 1)).size };
}

// ---------------------------------------------------------------------------------------
// Artists
// ---------------------------------------------------------------------------------------

interface ArtistRow {
  id: number;
  name: string;
  albumCount: number;
  trackCount: number;
  genres: string;
  overview: string | null;
}

const ARTIST_FROM = sql.raw(`
  SELECT ar.id AS id, ar.name AS name, count(DISTINCT al.id) AS albumCount, count(t.id) AS trackCount,
    ar.genres AS genres, ar.overview AS overview
  FROM artists ar
  JOIN albums al ON al.artist_id = ar.id
  JOIN tracks t ON t.album_id = al.id
  JOIN audio_files f ON f.id = t.audio_file_id`);

function toArtist(ctx: BrowseContext, r: ArtistRow): PlayerArtist {
  return {
    id: r.id,
    name: r.name,
    imageUrl: artworkUrl(ctx.basePath, 'artist', r.id),
    albumCount: r.albumCount,
    trackCount: r.trackCount,
    genres: parseList(r.genres),
  };
}

export function artistPage(ctx: BrowseContext, user: BrowseUser, q: BrowseQuery) {
  const where = and([listSearchCondition(q.search, [sql`ar.name`]), letterCondition(sql`ar.sort_name`, q.letter), genreCondition(sql`ar.genres`, q.genre)]);
  const played = sql`(SELECT max(p.last_played_at) FROM playback_progress p JOIN tracks t2 ON p.item_key = 'track:' || t2.id JOIN albums al2 ON al2.id = t2.album_id WHERE al2.artist_id = ar.id AND p.profile_id = ${uid(user)})`;
  const order: Record<BrowseQuery['sort'], SQL> = {
    name: sql`ar.sort_name COLLATE NOCASE ${dir(q.desc)}, ar.id`,
    artist: sql`ar.sort_name COLLATE NOCASE ${dir(q.desc)}, ar.id`,
    year: sql`ar.sort_name COLLATE NOCASE ${dir(q.desc)}, ar.id`,
    added: sql`max(f.date_added) ${dir(!q.desc)}, ar.id`,
    played: sql`${played} IS NULL, ${played} ${dir(!q.desc)}, ar.id`,
  };
  const total = ctx.db.get<{ n: number }>(sql`SELECT count(*) AS n FROM (${ARTIST_FROM} WHERE ${where} GROUP BY ar.id)`)?.n ?? 0;
  const rows = ctx.db.all<ArtistRow>(sql`${ARTIST_FROM} WHERE ${where} GROUP BY ar.id ORDER BY ${order[q.sort]} LIMIT ${q.pageSize} OFFSET ${offsetOf(q)}`);
  return { items: rows.map((r) => toArtist(ctx, r)), total, page: q.page, pageSize: q.pageSize };
}

export function artistDetails(ctx: BrowseContext, user: BrowseUser, id: number): PlayerArtistDetails | null {
  const row = ctx.db.get<ArtistRow>(sql`${ARTIST_FROM} WHERE ar.id = ${id} GROUP BY ar.id`);
  if (!row) return null;
  const albums = albumQuery(ctx, sql`al.artist_id = ${id}`, sql`al.year IS NULL, al.year DESC, al.title COLLATE NOCASE`, 500);
  // Top tracks: this user's most played; album order when nothing was played yet.
  const top = ctx.db.all<TrackRow>(sql`${TRACK_FROM}
    LEFT JOIN playback_progress p ON p.profile_id = ${uid(user)} AND p.item_key = 'track:' || t.id
    WHERE al.artist_id = ${id}
    ORDER BY coalesce(p.play_count, 0) DESC, p.last_played_at DESC, al.year DESC, ${TRACK_ORDER_IN_ALBUM}
    LIMIT 10`);
  return { ...toArtist(ctx, row), overview: row.overview || null, topTracks: top.map((r) => toTrack(ctx, r)), albums };
}

// ---------------------------------------------------------------------------------------
// Audiobooks
// ---------------------------------------------------------------------------------------

interface BookRow {
  id: number;
  title: string;
  authorCredits: string;
  authorName: string | null;
  narrators: string;
  durationMs: number;
  addedAt: string | null;
  overview: string | null;
}

const BOOK_FROM = sql.raw(`
  SELECT b.id AS id, b.title AS title, b.author_credits AS authorCredits, au.name AS authorName,
    b.narrators AS narrators, b.added AS addedAt, b.overview AS overview,
    (SELECT coalesce(sum(f.duration_ms), 0) FROM audio_files f WHERE f.book_id = b.id) AS durationMs
  FROM books b
  LEFT JOIN authors au ON au.id = b.author_id`);
const BOOK_HAS_FILES = sql.raw('EXISTS (SELECT 1 FROM audio_files f WHERE f.book_id = b.id)');

function bookSeries(db: Db, ids: readonly number[]): Map<number, { title: string; position: string | null }> {
  const out = new Map<number, { title: string; position: string | null }>();
  if (ids.length === 0) return out;
  const rows = db.all<{ bookId: number; title: string; position: string | null; isPrimary: number }>(sql`
    SELECT e.book_id AS bookId, s.name AS title, e.position AS position, e.is_primary AS isPrimary
    FROM book_series_entries e JOIN book_series s ON s.id = e.series_id
    WHERE e.book_id IN (${sql.join(ids.map((id) => sql`${id}`), sql`, `)})
    ORDER BY e.is_primary DESC, s.id`);
  for (const r of rows) if (!out.has(r.bookId)) out.set(r.bookId, { title: r.title, position: r.position });
  return out;
}

function authorList(r: BookRow): string[] {
  const names = parseCredits(r.authorCredits);
  return names.length > 0 ? names : r.authorName ? [r.authorName] : [];
}

function parseCredits(json: string | null): string[] {
  try {
    const v = JSON.parse(json ?? '[]') as unknown;
    return Array.isArray(v) ? v.map((c) => (c && typeof c === 'object' ? (c as { name?: unknown }).name : null)).filter((n): n is string => typeof n === 'string' && n.length > 0) : [];
  } catch {
    return [];
  }
}

function toBooks(ctx: BrowseContext, user: BrowseUser, rows: readonly BookRow[]): PlayerAudiobook[] {
  const ids = rows.map((r) => r.id);
  const series = bookSeries(ctx.db, ids);
  const owner = ownerOfBrowse(user);
  const progress: Map<string, PlaybackProgress> =
    owner === null
      ? new Map()
      : ctx.progress.effective(
          owner,
          user.settings,
          ids.map((id) => itemKey('audiobook', id)),
        );
  return rows.map((r) => ({
    id: r.id,
    itemKey: itemKey('audiobook', r.id),
    title: r.title,
    authors: authorList(r),
    narrators: parseList(r.narrators),
    seriesTitle: series.get(r.id)?.title ?? null,
    seriesPosition: series.get(r.id)?.position ?? null,
    durationMs: r.durationMs ?? 0,
    artworkUrl: artworkUrl(ctx.basePath, 'book', r.id),
    addedAt: r.addedAt,
    progress: progress.get(itemKey('audiobook', r.id)) ?? null,
  }));
}

function bookQuery(ctx: BrowseContext, user: BrowseUser, where: SQL, order: SQL, limit: number, offset = 0): PlayerAudiobook[] {
  return toBooks(ctx, user, ctx.db.all<BookRow>(sql`${BOOK_FROM} WHERE ${BOOK_HAS_FILES} AND ${where} ORDER BY ${order} LIMIT ${limit} OFFSET ${offset}`));
}

/** Books by id in the order given (unknown or file-less ids are skipped). */
function booksByIds(ctx: BrowseContext, user: BrowseUser, ids: readonly number[]): PlayerAudiobook[] {
  if (ids.length === 0) return [];
  const found = new Map(bookQuery(ctx, user, sql`b.id IN (${sql.join(ids.map((id) => sql`${id}`), sql`, `)})`, sql`b.id`, ids.length).map((b) => [b.id, b]));
  return ids.flatMap((id) => (found.has(id) ? [found.get(id)!] : []));
}

export function audiobookPage(ctx: BrowseContext, user: BrowseUser, q: BrowseQuery) {
  const where = and([
    listSearchCondition(q.search, [sql`b.title`, sql`b.author_credits`, sql`b.narrators`, sql`au.name`]),
    letterCondition(sql`b.sort_title`, q.letter),
    genreCondition(sql`b.genres`, q.genre),
  ]);
  const played = sql`(SELECT p.last_played_at FROM playback_progress p WHERE p.profile_id = ${uid(user)} AND p.item_key = 'audiobook:' || b.id)`;
  const order: Record<BrowseQuery['sort'], SQL> = {
    name: sql`b.sort_title COLLATE NOCASE ${dir(q.desc)}, b.id`,
    added: sql`b.added ${dir(!q.desc)}, b.id`,
    played: sql`${played} IS NULL, ${played} ${dir(!q.desc)}, b.id`,
    year: sql`b.year ${dir(q.desc)}, b.sort_title COLLATE NOCASE, b.id`,
    artist: sql`au.sort_name COLLATE NOCASE ${dir(q.desc)}, b.sort_title COLLATE NOCASE, b.id`,
  };
  const total = ctx.db.get<{ n: number }>(sql`SELECT count(*) AS n FROM (${BOOK_FROM} WHERE ${BOOK_HAS_FILES} AND ${where})`)?.n ?? 0;
  return { items: bookQuery(ctx, user, where, order[q.sort], q.pageSize, offsetOf(q)), total, page: q.page, pageSize: q.pageSize };
}

/** Books of a series that have files, in reading order. */
function seriesBooks(ctx: BrowseContext, user: BrowseUser, seriesId: number): PlayerAudiobook[] {
  const ids = ctx.db
    .all<{ id: number }>(sql`SELECT e.book_id AS id FROM book_series_entries e WHERE e.series_id = ${seriesId} ORDER BY e.position_sort IS NULL, e.position_sort, e.position, e.book_id`)
    .map((r) => r.id);
  return booksByIds(ctx, user, ids);
}

export function audiobookDetails(ctx: BrowseContext, user: BrowseUser, id: number): PlayerAudiobookDetails | null {
  const [book] = booksByIds(ctx, user, [id]);
  if (!book) return null;
  const row = ctx.db.get<{ overview: string | null }>(sql`SELECT overview FROM books WHERE id = ${id}`);
  const item = playableItem(ctx, itemKey('audiobook', id));
  const primary = ctx.db.get<{ seriesId: number }>(sql`SELECT series_id AS seriesId FROM book_series_entries WHERE book_id = ${id} ORDER BY is_primary DESC, series_id LIMIT 1`);
  const series = primary ? seriesBooks(ctx, user, primary.seriesId).filter((b) => b.id !== id) : [];
  return { ...book, description: row?.overview || null, chapters: item?.chapters ?? [], series };
}

// ---------------------------------------------------------------------------------------
// Home pages
// ---------------------------------------------------------------------------------------

const HOME_ROW = 20;

export function musicHome(ctx: BrowseContext, user: BrowseUser, playlists: MusicHome['playlists'], now = new Date()): MusicHome {
  const owner = ownerOfBrowse(user);
  const recent = owner === null ? [] : ctx.progress.recent(owner, 100, 'track');
  const recentlyPlayed = tracksByIds(
    ctx,
    recent.slice(0, HOME_ROW).map((p) => Number(p.itemKey.slice('track:'.length))),
  );
  // Albums of the recently played tracks, newest play first.
  const albumOrder: number[] = [];
  for (const t of tracksByIds(
    ctx,
    recent.map((p) => Number(p.itemKey.slice('track:'.length))),
  )) {
    if (!albumOrder.includes(t.albumId)) albumOrder.push(t.albumId);
  }
  const jumpIds = albumOrder.slice(0, 12);
  const jump = jumpIds.length > 0 ? new Map(albumQuery(ctx, sql`al.id IN (${sql.join(jumpIds.map((id) => sql`${id}`), sql`, `)})`, sql`al.id`, jumpIds.length).map((a) => [a.id, a])) : new Map<number, PlayerAlbum>();
  const monthDay = `${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
  return {
    recentlyPlayed,
    jumpBackIn: jumpIds.flatMap((id) => (jump.has(id) ? [jump.get(id)!] : [])),
    recentlyAdded: albumQuery(ctx, sql`1 = 1`, sql`max(f.date_added) DESC, al.id DESC`, HOME_ROW),
    playlists,
    onThisDay: albumQuery(ctx, sql`length(al.release_date) >= 10 AND substr(al.release_date, 6, 5) = ${monthDay}`, sql`al.year DESC, al.id`, HOME_ROW),
  };
}

export function audiobookHome(ctx: BrowseContext, user: BrowseUser): AudiobookHome {
  const idOf = (p: PlaybackProgress) => Number(p.itemKey.slice('audiobook:'.length));
  const owner = ownerOfBrowse(user);
  const going = owner === null ? [] : ctx.progress.inProgress(owner, HOME_ROW, 'audiobook');
  const done = owner === null ? [] : ctx.progress.recent(owner, HOME_ROW, 'audiobook', { played: true });
  const seriesRows = ctx.db.all<{ id: number; title: string }>(sql`
    SELECT s.id AS id, s.name AS title FROM book_series s
    WHERE EXISTS (SELECT 1 FROM book_series_entries e JOIN audio_files f ON f.book_id = e.book_id WHERE e.series_id = s.id)
    ORDER BY s.name COLLATE NOCASE LIMIT ${HOME_ROW}`);
  return {
    continueListening: booksByIds(ctx, user, going.map(idOf)),
    recentlyAdded: bookQuery(ctx, user, sql`1 = 1`, sql`b.added DESC, b.id DESC`, HOME_ROW),
    series: seriesRows.map((s) => ({ id: s.id, title: s.title, books: seriesBooks(ctx, user, s.id) })).filter((s) => s.books.length > 0),
    finished: booksByIds(ctx, user, done.map(idOf)),
  };
}

// ---------------------------------------------------------------------------------------
// Search (typo tolerant, like the topbar search: SQL prefilter, then the shared matcher)
// ---------------------------------------------------------------------------------------

const SEARCH_SCAN = 400;
const SEARCH_TAKE = 20;

/** `%w%o%r%d%` on the longest word: what the matcher's loose step can still accept. */
function loosePattern(words: readonly string[]): string {
  const word = words.reduce((a, b) => (b.length > a.length ? b : a));
  return `%${[...word].join('%')}%`;
}

function ranked<T>(q: string, rows: readonly T[], text: (r: T) => string, keywords?: (r: T) => string[]): T[] {
  return rankMatches(q, rows, text, keywords)
    .slice(0, SEARCH_TAKE)
    .map((m) => m.item);
}

export function playerSearch(ctx: BrowseContext, user: BrowseUser, q: string, sections: { music: boolean; audiobooks: boolean }): PlayerSearchResponse {
  const words = searchWords(q);
  const out: PlayerSearchResponse = { tracks: [], albums: [], artists: [], audiobooks: [], movies: [], series: [] };
  if (words.length === 0) return out;
  const like = loosePattern(words);
  const match = (...cols: SQL[]) => sql`(${sql.join(
    cols.map((c) => sql`lower(${c}) LIKE ${like}`),
    sql` OR `,
  )})`;
  if (sections.music) {
    const trackRows = ctx.db.all<TrackRow>(sql`${TRACK_FROM} WHERE ${match(sql`t.title`)} LIMIT ${SEARCH_SCAN}`);
    out.tracks = ranked(q, trackRows, (r) => r.title, (r) => [r.artistCredit || r.artistName, r.albumTitle]).map((r) => toTrack(ctx, r));
    const albumRows = ctx.db.all<AlbumRow>(sql`${ALBUM_FROM} WHERE ${match(sql`al.title`)} GROUP BY al.id LIMIT ${SEARCH_SCAN}`);
    out.albums = toAlbums(
      ctx,
      ranked(q, albumRows, (r) => r.title, (r) => [r.artistName]),
    );
    const artistRows = ctx.db.all<ArtistRow>(sql`${ARTIST_FROM} WHERE ${match(sql`ar.name`)} GROUP BY ar.id LIMIT ${SEARCH_SCAN}`);
    out.artists = ranked(q, artistRows, (r) => r.name).map((r) => toArtist(ctx, r));
  }
  if (sections.audiobooks) {
    const bookRows = ctx.db.all<BookRow>(sql`${BOOK_FROM} WHERE ${BOOK_HAS_FILES} AND ${match(sql`b.title`, sql`b.author_credits`, sql`au.name`)} LIMIT ${SEARCH_SCAN}`);
    out.audiobooks = toBooks(
      ctx,
      user,
      ranked(q, bookRows, (r) => r.title, (r) => authorList(r)),
    );
  }
  return out;
}
