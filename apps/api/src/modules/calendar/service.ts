import { randomBytes } from 'node:crypto';
import { and, eq, gte, inArray, isNotNull, isNull, lte, or } from 'drizzle-orm';
import {
  type CalendarAlbumItem,
  type CalendarBookItem,
  type CalendarEpisodeItem,
  type CalendarItem,
  type CalendarMovieItem,
  type CalendarMovieSummary,
  type CalendarQuery,
  type CalendarReleaseKind,
  type CalendarSeriesSummary,
  type Episode,
  type MediaFile,
} from '@arclight/shared';
import type { Db } from '../../db/index.js';
import { albums, artists, authors, books, episodes, mediaFiles, movies, series, settings } from '../../db/schema.js';
import { booksFromRows } from '../audiobooks/service.js';
import { albumStatistics } from '../music/statistics.js';
import { getSection } from '../settings/service.js';

// Calendar over the library tables: episodes by air date, movies by each of their release
// dates, while `features.music` is on albums by release date and, while `features.audiobooks`
// is on, books by release date. Ranges are inclusive at both
// ends. A date-only value (YYYY-MM-DD) counts as midnight UTC of that day.

type SeriesRow = typeof series.$inferSelect;
type MovieRow = typeof movies.$inferSelect;
type EpisodeRow = typeof episodes.$inferSelect;
type MediaFileRow = typeof mediaFiles.$inferSelect;

export const ICS_TOKEN_KEY = 'calendar.icsToken';
const DAY_MS = 24 * 60 * 60_000;

export class CalendarError extends Error {
  constructor(
    readonly code: 'VALIDATION' | 'UNAUTHORIZED',
    message: string,
  ) {
    super(message);
    this.name = 'CalendarError';
  }
}

export interface CalendarRange {
  start: Date;
  end: Date;
}

/** Defaults: start = today 00:00 UTC, end = start + 7 days. */
export function resolveRange(query: Pick<CalendarQuery, 'start' | 'end'>, now: Date = new Date()): CalendarRange {
  const today = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  const start = query.start ? new Date(query.start) : today;
  const end = query.end ? endOf(query.end) : new Date(start.getTime() + 7 * DAY_MS);
  if (end < start) throw new CalendarError('VALIDATION', 'end must not be before start');
  return { start, end };
}

/** A date-only `end` means the whole of that day. */
function endOf(value: string): Date {
  const d = new Date(value);
  return /^\d{4}-\d{2}-\d{2}$/.test(value) ? new Date(d.getTime() + DAY_MS - 1) : d;
}

const DATE_KIND_COLUMN = {
  cinema: 'inCinemas',
  digital: 'digitalRelease',
  physical: 'physicalRelease',
} as const satisfies Record<CalendarReleaseKind, keyof MovieRow>;

export class CalendarService {
  constructor(
    private readonly db: Db,
    private readonly now: () => Date = () => new Date(),
  ) {}

  list(query: Omit<CalendarQuery, 'mediaType'> & { mediaType?: CalendarQuery['mediaType'] }): CalendarItem[] {
    const range = resolveRange(query, this.now());
    const mediaType = query.mediaType ?? 'all';
    const items: CalendarItem[] = [
      ...(mediaType === 'all' || mediaType === 'series' ? this.episodeItems(range, query) : []),
      ...(mediaType === 'all' || mediaType === 'movie' ? this.movieItems(range, query) : []),
      ...((mediaType === 'all' || mediaType === 'music') && getSection(this.db, 'features').music ? this.albumItems(range, query) : []),
      ...((mediaType === 'all' || mediaType === 'audiobook') && getSection(this.db, 'features').audiobooks ? this.bookItems(range, query) : []),
    ];
    return items.sort(
      (a, b) => instant(a.date) - instant(b.date) || titleOf(a).localeCompare(titleOf(b)) || orderOf(a) - orderOf(b),
    );
  }

  // ---- episodes ----------------------------------------------------------------------------

  private episodeItems(range: CalendarRange, query: Omit<CalendarQuery, 'mediaType'>): CalendarEpisodeItem[] {
    // Coarse SQL window on the text columns (one day of slack either side), exact filter in JS.
    const lo = isoDay(range.start.getTime() - DAY_MS);
    const hi = isoDay(range.end.getTime() + DAY_MS) + '~';
    const rows = this.db
      .select({ episode: episodes, series })
      .from(episodes)
      .innerJoin(series, eq(episodes.seriesId, series.id))
      .where(
        and(
          or(
            and(isNotNull(episodes.airDateUtc), gte(episodes.airDateUtc, lo), lte(episodes.airDateUtc, hi)),
            and(isNull(episodes.airDateUtc), gte(episodes.airDate, lo), lte(episodes.airDate, hi)),
          ),
          query.unmonitored ? undefined : and(eq(episodes.monitored, true), eq(series.monitored, true)),
        ),
      )
      .all()
      .filter((r) => matchesTags(r.series.tags, query.tags))
      .map((r) => ({ ...r, date: (r.episode.airDateUtc ?? r.episode.airDate)! }))
      .filter((r) => inRange(r.date, range));

    const files = query.includeEpisodeFile ? this.filesFor(rows.map((r) => r.episode.episodeFileId)) : new Map();
    return rows.map((r) => {
      const file = r.episode.episodeFileId != null ? files.get(r.episode.episodeFileId) : undefined;
      return {
        type: 'episode' as const,
        date: r.date,
        seriesId: r.series.id,
        seriesTitle: r.series.title,
        episode: toEpisode(r.episode),
        ...(query.includeSeries ? { series: toSeriesSummary(r.series) } : {}),
        ...(file ? { episodeFile: file } : {}),
      };
    });
  }

  private filesFor(ids: Array<number | null>): Map<number, MediaFile> {
    const unique = [...new Set(ids.filter((id): id is number => id !== null))];
    if (unique.length === 0) return new Map();
    const fileRows = this.db.select().from(mediaFiles).where(inArray(mediaFiles.id, unique)).all();
    const links = this.db
      .select({ id: episodes.id, fileId: episodes.episodeFileId })
      .from(episodes)
      .where(inArray(episodes.episodeFileId, unique))
      .all();
    return new Map(
      fileRows.map((f) => [f.id, toMediaFile(f, links.filter((l) => l.fileId === f.id).map((l) => l.id))]),
    );
  }

  // ---- movies --------------------------------------------------------------------------------

  private movieItems(range: CalendarRange, query: Omit<CalendarQuery, 'mediaType'>): CalendarMovieItem[] {
    const lo = isoDay(range.start.getTime() - DAY_MS);
    const hi = isoDay(range.end.getTime() + DAY_MS) + '~';
    const window = (col: typeof movies.inCinemas | typeof movies.digitalRelease | typeof movies.physicalRelease) => and(isNotNull(col), gte(col, lo), lte(col, hi));
    const rows = this.db
      .select()
      .from(movies)
      .where(
        and(
          or(window(movies.inCinemas), window(movies.digitalRelease), window(movies.physicalRelease)),
          query.unmonitored ? undefined : eq(movies.monitored, true),
        ),
      )
      .all()
      .filter((m) => matchesTags(m.tags, query.tags));

    const items: CalendarMovieItem[] = [];
    for (const row of rows) {
      const summary = toMovieSummary(row);
      for (const kind of ['cinema', 'digital', 'physical'] as const) {
        const date = row[DATE_KIND_COLUMN[kind]];
        if (date && inRange(date, range)) items.push({ type: 'movie', date, releaseKind: kind, movie: summary });
      }
    }
    return items;
  }

  // ---- albums --------------------------------------------------------------------------------

  private albumItems(range: CalendarRange, query: Omit<CalendarQuery, 'mediaType'>): CalendarAlbumItem[] {
    const lo = isoDay(range.start.getTime() - DAY_MS);
    const hi = isoDay(range.end.getTime() + DAY_MS) + '~';
    const rows = this.db
      .select({ album: albums, artist: artists })
      .from(albums)
      .innerJoin(artists, eq(albums.artistId, artists.id))
      .where(
        and(
          isNotNull(albums.releaseDate),
          gte(albums.releaseDate, lo),
          lte(albums.releaseDate, hi),
          query.unmonitored ? undefined : and(eq(albums.monitored, true), eq(artists.monitored, true)),
        ),
      )
      .all()
      // Only full dates go on a calendar; "2026" or "2026-05" names no day.
      .filter((r) => /^\d{4}-\d{2}-\d{2}$/.test(r.album.releaseDate ?? '') && inRange(r.album.releaseDate!, range))
      .filter((r) => matchesTags(r.artist.tags, query.tags));
    const stats = albumStatistics(
      this.db,
      rows.map((r) => r.album.id),
    );
    return rows.map(({ album, artist }) => ({
      type: 'album' as const,
      date: album.releaseDate!,
      artistId: artist.id,
      artistName: artist.name,
      album: { ...album, ...(stats.get(album.id) ? { statistics: stats.get(album.id) } : {}) },
      artist: {
        id: artist.id,
        mbArtistId: artist.mbArtistId,
        name: artist.name,
        sortName: artist.sortName,
        status: artist.status,
        monitored: artist.monitored,
        images: artist.images,
        tags: artist.tags,
        path: artist.path,
        qualityProfileId: artist.qualityProfileId,
      },
    }));
  }

  // ---- books ---------------------------------------------------------------------------------

  private bookItems(range: CalendarRange, query: Omit<CalendarQuery, 'mediaType'>): CalendarBookItem[] {
    const lo = isoDay(range.start.getTime() - DAY_MS);
    const hi = isoDay(range.end.getTime() + DAY_MS) + '~';
    const rows = this.db
      .select({ book: books, author: authors })
      .from(books)
      .innerJoin(authors, eq(books.authorId, authors.id))
      .where(
        and(
          isNotNull(books.releaseDate),
          gte(books.releaseDate, lo),
          lte(books.releaseDate, hi),
          query.unmonitored ? undefined : and(eq(books.monitored, true), eq(authors.monitored, true)),
        ),
      )
      .all()
      // Books dated only to the year name no day.
      .filter((r) => /^\d{4}-\d{2}-\d{2}$/.test(r.book.releaseDate ?? '') && inRange(r.book.releaseDate!, range))
      .filter((r) => matchesTags(r.author.tags, query.tags));
    const list = booksFromRows(
      this.db,
      rows.map((r) => r.book),
    );
    return rows.map(({ author }, i) => ({
      type: 'book' as const,
      date: list[i]!.releaseDate!,
      authorId: author.id,
      authorName: author.name,
      book: list[i]!,
      author: {
        id: author.id,
        asin: author.asin,
        name: author.name,
        sortName: author.sortName,
        monitored: author.monitored,
        images: author.images,
        tags: author.tags,
        path: author.path,
        qualityProfileId: author.qualityProfileId,
      },
    }));
  }

  // ---- iCal token ----------------------------------------------------------------------------

  /** The per-install feed token, created on first use. */
  icsToken(): string {
    const row = this.db.select().from(settings).where(eq(settings.key, ICS_TOKEN_KEY)).get();
    if (typeof row?.value === 'string' && row.value.length > 0) return row.value;
    const token = randomBytes(24).toString('hex');
    this.db
      .insert(settings)
      .values({ key: ICS_TOKEN_KEY, value: token, updatedAt: this.now().toISOString() })
      .onConflictDoNothing()
      .run();
    // Another request may have won the race; re-read so everyone agrees.
    const stored = this.db.select().from(settings).where(eq(settings.key, ICS_TOKEN_KEY)).get();
    return typeof stored?.value === 'string' ? stored.value : token;
  }

  /** Replace the feed token; subscribed calendar apps must be given the new feed URL. */
  regenerateToken(): string {
    const token = randomBytes(24).toString('hex');
    this.db
      .insert(settings)
      .values({ key: ICS_TOKEN_KEY, value: token, updatedAt: this.now().toISOString() })
      .onConflictDoUpdate({ target: settings.key, set: { value: token, updatedAt: this.now().toISOString() } })
      .run();
    return token;
  }

  verifyToken(token: string | undefined): void {
    if (!token || !timingSafeEqualString(token, this.icsToken())) {
      throw new CalendarError('UNAUTHORIZED', 'invalid or missing calendar token');
    }
  }
}

// ---- helpers -------------------------------------------------------------------------------

function timingSafeEqualString(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

export function instant(value: string): number {
  return Date.parse(/^\d{4}-\d{2}-\d{2}$/.test(value) ? `${value}T00:00:00Z` : value);
}

function inRange(value: string, range: CalendarRange): boolean {
  const t = instant(value);
  return t >= range.start.getTime() && t <= range.end.getTime();
}

function isoDay(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

function matchesTags(itemTags: number[], wanted: number[]): boolean {
  return wanted.length === 0 || itemTags.some((t) => wanted.includes(t));
}

function titleOf(item: CalendarItem): string {
  if (item.type === 'episode') return item.seriesTitle;
  if (item.type === 'movie') return item.movie.title;
  return item.type === 'album' ? item.artistName : item.authorName;
}

function orderOf(item: CalendarItem): number {
  return item.type === 'episode' ? item.episode.seasonNumber * 10_000 + item.episode.episodeNumber : 0;
}

function toEpisode(row: EpisodeRow): Episode {
  return { ...row };
}

function toSeriesSummary(row: SeriesRow): CalendarSeriesSummary {
  return {
    id: row.id,
    tmdbId: row.tmdbId,
    tvdbId: row.tvdbId,
    title: row.title,
    year: row.year,
    status: row.status,
    network: row.network,
    runtimeMinutes: row.runtimeMinutes,
    monitored: row.monitored,
    images: row.images,
    tags: row.tags,
    path: row.path,
    qualityProfileId: row.qualityProfileId,
  };
}

function toMovieSummary(row: MovieRow): CalendarMovieSummary {
  return {
    id: row.id,
    tmdbId: row.tmdbId,
    imdbId: row.imdbId,
    title: row.title,
    year: row.year,
    overview: row.overview,
    status: row.status,
    studio: row.studio,
    certification: row.certification,
    runtimeMinutes: row.runtimeMinutes,
    inCinemas: row.inCinemas,
    digitalRelease: row.digitalRelease,
    physicalRelease: row.physicalRelease,
    monitored: row.monitored,
    hasFile: row.hasFile,
    images: row.images,
    tags: row.tags,
    qualityProfileId: row.qualityProfileId,
  };
}

function toMediaFile(row: MediaFileRow, episodeIds: number[]): MediaFile {
  return {
    id: row.id,
    mediaType: row.mediaType,
    seriesId: row.seriesId,
    movieId: row.movieId,
    seasonNumber: row.seasonNumber,
    episodeIds,
    relativePath: row.relativePath,
    path: row.path,
    sizeBytes: row.sizeBytes,
    dateAdded: row.dateAdded,
    quality: row.quality,
    languages: row.languages,
    releaseGroup: row.releaseGroup,
    sceneName: row.sceneName,
    edition: row.edition,
    mediaInfo: row.mediaInfo,
  };
}
