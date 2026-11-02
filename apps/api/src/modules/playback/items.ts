import { eq } from 'drizzle-orm';
import { itemKey, parseItemKey, type PlayableChapter, type PlayableItem, type PlayablePart } from '@arclight/shared';
import type { Db } from '../../db/index.js';
import { audioFiles } from '../library/schema.js';
import { albums, artists, tracks } from '../music/schema.js';
import { authors, books, bookSeries, bookSeriesEntries } from '../audiobooks/schema.js';
import { mimeOf } from './format.js';

// Playable items (GET /playback/item/:itemKey): a track is its one audio file; an audiobook is
// every file of the book on one timeline, ordered by part, disc and track number, then path.

type AudioFileRow = typeof audioFiles.$inferSelect;

/** Image routes of the player (served by GET /playback/artwork/:kind/:id, guarded like the rest). */
export function artworkUrl(basePath: string, kind: 'album' | 'artist' | 'book', id: number): string {
  return `${basePath}/api/v1/playback/artwork/${kind}/${id}`;
}

const byNumber = (a: number | null, b: number | null) => (a ?? Number.MAX_SAFE_INTEGER) - (b ?? Number.MAX_SAFE_INTEGER);

/** Book files in play order. */
export function orderBookFiles<T extends Pick<AudioFileRow, 'partNumber' | 'discNumber' | 'trackNumber' | 'path'>>(files: readonly T[]): T[] {
  return [...files].sort(
    (a, b) =>
      byNumber(a.partNumber, b.partNumber) ||
      byNumber(a.discNumber, b.discNumber) ||
      byNumber(a.trackNumber, b.trackNumber) ||
      a.path.localeCompare(b.path, undefined, { numeric: true }),
  );
}

function partOf(f: AudioFileRow, startMs: number): PlayablePart {
  return {
    fileId: f.id,
    startMs,
    durationMs: f.durationMs ?? 0,
    codec: f.codec,
    container: f.container,
    mimeType: mimeOf(f.path),
    bitrateKbps: f.bitrateKbps,
    sampleRateHz: f.sampleRateHz,
    bitDepth: f.bitDepth,
    channels: f.channels,
    sizeBytes: f.sizeBytes,
  };
}

/** Places files back to back: each part starts where the previous ended. */
export function timelineOf(files: readonly AudioFileRow[]): PlayablePart[] {
  let at = 0;
  return files.map((f) => {
    const part = partOf(f, at);
    at += part.durationMs;
    return part;
  });
}

/** Chapter durations from the start of the next one (the last runs to `totalMs`). */
function withDurations(list: Array<{ title: string; startMs: number; lengthMs?: number | null | undefined }>, totalMs: number): PlayableChapter[] {
  const sorted = [...list].sort((a, b) => a.startMs - b.startMs);
  return sorted.map((c, i) => {
    const next = sorted[i + 1]?.startMs ?? totalMs;
    const durationMs = c.lengthMs && c.lengthMs > 0 ? c.lengthMs : Math.max(0, next - c.startMs);
    return { title: c.title, startMs: c.startMs, durationMs };
  });
}

/**
 * Chapters on the book timeline: the catalogue's (books.chapters) when stored, else the chapter
 * marks embedded in the files (offset by each file's start), else one chapter per file.
 */
export function chaptersOf(stored: ReadonlyArray<{ title: string; startMs: number; lengthMs?: number | null | undefined }>, files: readonly AudioFileRow[], parts: readonly PlayablePart[]): PlayableChapter[] {
  const totalMs = parts.reduce((s, p) => s + p.durationMs, 0);
  if (stored.length > 0) return withDurations(stored.map((c) => ({ ...c })), totalMs);
  const embedded = files.flatMap((f, i) => (f.mediaInfo?.chapters ?? []).map((c) => ({ title: c.title, startMs: parts[i]!.startMs + c.startMs })));
  if (embedded.length > 0) return withDurations(embedded, totalMs);
  return files.map((f, i) => ({
    title: f.tags?.title?.trim() || `Part ${i + 1}`,
    startMs: parts[i]!.startMs,
    durationMs: parts[i]!.durationMs,
  }));
}

export interface ItemContext {
  db: Db;
  basePath: string;
}

function trackItem({ db, basePath }: ItemContext, id: number): PlayableItem | null {
  const row = db
    .select({ track: tracks, album: albums, artist: artists, file: audioFiles })
    .from(tracks)
    .innerJoin(albums, eq(albums.id, tracks.albumId))
    .innerJoin(artists, eq(artists.id, albums.artistId))
    .innerJoin(audioFiles, eq(audioFiles.id, tracks.audioFileId))
    .where(eq(tracks.id, id))
    .get();
  if (!row) return null;
  const part = partOf(row.file, 0);
  const durationMs = part.durationMs || row.track.durationMs || 0;
  const info = row.file.mediaInfo;
  const gain = info && (info.replayGainTrackDb != null || info.replayGainAlbumDb != null) ? { trackGainDb: info.replayGainTrackDb ?? null, albumGainDb: info.replayGainAlbumDb ?? null } : null;
  return {
    itemKey: itemKey('track', id),
    kind: 'track',
    title: row.track.title,
    subtitle: row.track.artistCredit || row.artist.name,
    context: row.album.title,
    artworkUrl: artworkUrl(basePath, 'album', row.album.id),
    durationMs,
    parts: [{ ...part, durationMs }],
    chapters: [],
    albumId: row.album.id,
    artistId: row.artist.id,
    bookId: null,
    replayGain: gain,
  };
}

/** "Series, book 2" for a book's primary (else first) series. */
export function seriesOf(db: Db, bookId: number): { id: number; title: string; position: string | null } | null {
  const rows = db
    .select({ id: bookSeries.id, name: bookSeries.name, position: bookSeriesEntries.position, isPrimary: bookSeriesEntries.isPrimary })
    .from(bookSeriesEntries)
    .innerJoin(bookSeries, eq(bookSeries.id, bookSeriesEntries.seriesId))
    .where(eq(bookSeriesEntries.bookId, bookId))
    .all();
  const s = rows.find((r) => r.isPrimary) ?? rows[0];
  return s ? { id: s.id, title: s.name, position: s.position } : null;
}

export function authorNames(credits: ReadonlyArray<{ name: string }>, fallback: string | null): string[] {
  const names = credits.map((c) => c.name).filter(Boolean);
  return names.length > 0 ? names : fallback ? [fallback] : [];
}

function audiobookItem({ db, basePath }: ItemContext, id: number): PlayableItem | null {
  const book = db.select({ book: books, authorName: authors.name }).from(books).leftJoin(authors, eq(authors.id, books.authorId)).where(eq(books.id, id)).get();
  if (!book) return null;
  const files = orderBookFiles(db.select().from(audioFiles).where(eq(audioFiles.bookId, id)).all());
  if (files.length === 0) return null;
  const parts = timelineOf(files);
  const series = seriesOf(db, id);
  return {
    itemKey: itemKey('audiobook', id),
    kind: 'audiobook',
    title: book.book.title,
    subtitle: authorNames(book.book.authorCredits, book.authorName).join(', ') || null,
    context: series ? (series.position ? `${series.title}, book ${series.position}` : series.title) : null,
    artworkUrl: artworkUrl(basePath, 'book', id),
    durationMs: parts.reduce((s, p) => s + p.durationMs, 0),
    parts,
    chapters: chaptersOf(book.book.chapters ?? [], files, parts),
    albumId: null,
    artistId: null,
    bookId: id,
    replayGain: null,
  };
}

/** The playable item for a key, or null when it is unknown or has no file. */
export function playableItem(ctx: ItemContext, key: string): PlayableItem | null {
  const parsed = parseItemKey(key);
  if (!parsed) return null;
  return parsed.kind === 'track' ? trackItem(ctx, parsed.id) : audiobookItem(ctx, parsed.id);
}
