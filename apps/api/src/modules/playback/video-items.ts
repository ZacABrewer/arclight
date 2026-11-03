import { execFile } from 'node:child_process';
import { stat } from 'node:fs/promises';
import { and, asc, eq, inArray, isNotNull } from 'drizzle-orm';
import { itemKey, type ContentRestrictions, type MediaImage, type PlayableChapter, type PlayableItem, type VideoArtworkType, type VideoInfo, type VideoVersion } from '@arclight/shared';
import type { Db } from '../../db/index.js';
import { episodes, episodeVersionFiles, mediaFiles, movies, series } from '../library/schema.js';
import { locateFfprobe } from '../media-analysis/runner.js';
import { isUnrestricted, restrictionReason } from '../requests/certification.js';
import { subtitleFiles } from '../subtitles/schema.js';
import { baseRangeOf, compareVersions, durationOf, segmentsFromChapters, parseProbeChapters, videoInfoOf, versionLabel, type ExternalSubtitle, type VideoFileFacts } from './video-info.js';

// Movies and episodes as playable items (GET /playback/item/movie:<id> | episode:<id>): the file
// that plays by default (the best version), every version, the file's chapters (ffprobe, read
// lazily and cached), intro/credits segments from chapter names, and for episodes the previous
// and next episode with a file. Content restrictions (certification caps) hide items entirely.

export type MediaFileRow = typeof mediaFiles.$inferSelect;
export type MovieRow = typeof movies.$inferSelect;
export type SeriesRow = typeof series.$inferSelect;
export type EpisodeRow = typeof episodes.$inferSelect;

/** Image routes for video (GET /playback/artwork/movie|series|episode/:id). */
export function videoArtworkUrl(basePath: string, kind: 'movie' | 'series' | 'episode', id: number, type?: VideoArtworkType, width?: '342' | '780' | '1280' | 'original'): string {
  const q = [type ? `type=${type}` : null, width ? `w=${width}` : null].filter(Boolean).join('&');
  return `${basePath}/api/v1/playback/artwork/${kind}/${id}${q ? `?${q}` : ''}`;
}

const COVER_TYPE: Record<VideoArtworkType, string> = { poster: 'poster', fanart: 'fanart', logo: 'clearlogo' };

/** The artwork URL when the catalogue has an image of that type; else null. */
export function imageUrl(basePath: string, kind: 'movie' | 'series', id: number, images: readonly MediaImage[] | null, type: VideoArtworkType, width?: '342' | '780' | '1280' | 'original'): string | null {
  const has = (images ?? []).some((i) => i.coverType === COVER_TYPE[type] && (i.url || i.remoteUrl));
  return has ? videoArtworkUrl(basePath, kind, id, type, width) : null;
}

/** True when `certification` is within the user's caps (movies: MPAA, series: TV guidelines). */
export function withinRestrictions(r: ContentRestrictions | null, type: 'movie' | 'series', certification: string | null): boolean {
  if (!r || isUnrestricted(r)) return true;
  return restrictionReason(r, type, certification) === null;
}

/** TMDB rating, else IMDb, else any (0-10). */
export function ratingOf(ratings: Record<string, { value: number; votes: number }> | null | undefined): number | null {
  if (!ratings) return null;
  const r = ratings['tmdb'] ?? ratings['imdb'] ?? Object.values(ratings)[0];
  return r && r.value > 0 ? r.value : null;
}

// ---- files -----------------------------------------------------------------------------------

const factsOf = (f: MediaFileRow): VideoFileFacts => ({ id: f.id, path: f.path, sizeBytes: f.sizeBytes, versionTag: f.versionTag, edition: f.edition, mediaInfo: f.mediaInfo ?? null });

/** External subtitle files per media file. */
export function externalSubtitles(db: Db, fileIds: readonly number[]): Map<number, ExternalSubtitle[]> {
  const out = new Map<number, ExternalSubtitle[]>();
  if (fileIds.length === 0) return out;
  const rows = db
    .select()
    .from(subtitleFiles)
    .where(and(inArray(subtitleFiles.mediaFileId, [...fileIds]), eq(subtitleFiles.embedded, false), isNotNull(subtitleFiles.path)))
    .orderBy(asc(subtitleFiles.language), asc(subtitleFiles.id))
    .all();
  for (const r of rows) {
    const list = out.get(r.mediaFileId) ?? [];
    list.push({ id: r.id, path: r.path!, language: r.language, forced: r.forced, hi: r.hi, codec: r.codec });
    out.set(r.mediaFileId, list);
  }
  return out;
}

/** Every file of a movie (all versions). */
export function movieFiles(db: Db, movieId: number): MediaFileRow[] {
  return db.select().from(mediaFiles).where(eq(mediaFiles.movieId, movieId)).all();
}

/** The files of an episode: its primary file plus the files of its version slots. */
export function episodeFiles(db: Db, episode: Pick<EpisodeRow, 'id' | 'episodeFileId'>): MediaFileRow[] {
  const ids = new Set<number>();
  if (episode.episodeFileId) ids.add(episode.episodeFileId);
  for (const v of db.select({ id: episodeVersionFiles.mediaFileId }).from(episodeVersionFiles).where(eq(episodeVersionFiles.episodeId, episode.id)).all()) ids.add(v.id);
  return ids.size === 0 ? [] : db.select().from(mediaFiles).where(inArray(mediaFiles.id, [...ids])).all();
}

export interface VersionedFile {
  file: MediaFileRow;
  info: VideoInfo;
}

/** Files with their VideoInfo, best version first. */
export function versionsOf(db: Db, files: readonly MediaFileRow[]): VersionedFile[] {
  const subs = externalSubtitles(
    db,
    files.map((f) => f.id),
  );
  return files.map((file) => ({ file, info: videoInfoOf(factsOf(file), subs.get(file.id) ?? []) })).sort((a, b) => compareVersions(a.info, b.info));
}

export const toVersion = (v: VersionedFile): VideoVersion => ({ versionTag: v.file.versionTag, label: versionLabel(v.info, v.file), mediaFileId: v.file.id });

// ---- chapters ------------------------------------------------------------------------------

export type ChapterProbe = (path: string) => Promise<string | null>;

/** ffprobe's chapter list as JSON (null without ffprobe or on failure). */
export function ffprobeChapters(locate: () => Promise<string | null> = () => locateFfprobe()): ChapterProbe {
  let binary: Promise<string | null> | undefined;
  return async (path) => {
    binary ??= locate();
    const bin = await binary;
    if (!bin) {
      binary = undefined;
      return null;
    }
    return new Promise((resolve) => {
      execFile(bin, ['-v', 'error', '-print_format', 'json', '-show_chapters', path], { timeout: 30_000, maxBuffer: 4 * 1024 * 1024, windowsHide: true }, (err, stdout) => resolve(err ? null : stdout));
    });
  };
}

/**
 * Chapters of video files, read with ffprobe on first use and kept in memory per file (keyed by
 * id, size and mtime, so a replaced file is read again). Bounded: the oldest entries go first.
 */
export class ChapterReader {
  private readonly cache = new Map<string, PlayableChapter[]>();
  private readonly pending = new Map<string, Promise<PlayableChapter[]>>();

  constructor(
    private readonly probe: ChapterProbe = ffprobeChapters(),
    private readonly maxEntries = 2000,
  ) {}

  /** Cached chapters only (no probing); null when the file was not read yet. */
  peek(file: Pick<MediaFileRow, 'id' | 'sizeBytes'>): PlayableChapter[] | null {
    for (const [key, value] of this.cache) if (key.startsWith(`${file.id}:${file.sizeBytes}:`)) return value;
    return null;
  }

  async read(file: Pick<MediaFileRow, 'id' | 'path' | 'sizeBytes'>, totalMs: number): Promise<PlayableChapter[]> {
    let mtime = 0;
    try {
      mtime = Math.round((await stat(file.path)).mtimeMs);
    } catch {
      return [];
    }
    const key = `${file.id}:${file.sizeBytes}:${mtime}`;
    const hit = this.cache.get(key);
    if (hit) return hit;
    const running = this.pending.get(key);
    if (running) return running;
    const job = (async () => {
      const json = await this.probe(file.path);
      const chapters = json ? parseProbeChapters(json, totalMs) : [];
      // Drop stale keys of the same file, then the oldest entries over the bound.
      for (const k of this.cache.keys()) if (k.startsWith(`${file.id}:`)) this.cache.delete(k);
      this.cache.set(key, chapters);
      while (this.cache.size > this.maxEntries) this.cache.delete(this.cache.keys().next().value!);
      return chapters;
    })().finally(() => this.pending.delete(key));
    this.pending.set(key, job);
    return job;
  }
}

// ---- items -------------------------------------------------------------------------------------

export interface VideoItemContext {
  db: Db;
  basePath: string;
  chapters: ChapterReader;
}

export interface VideoItemOptions {
  restrictions: ContentRestrictions | null;
  /** Read chapters with ffprobe when not cached (single-item requests); batches use the cache only. */
  probe: boolean;
}

async function chaptersFor(ctx: VideoItemContext, file: MediaFileRow, totalMs: number, probe: boolean): Promise<PlayableChapter[]> {
  if (!probe) return ctx.chapters.peek(file) ?? [];
  return ctx.chapters.read(file, totalMs);
}

/** The audio-only fields of PlayableItem, empty for video. */
const videoBase = () => ({ context: null, albumId: null, artistId: null, bookId: null, replayGain: null, parts: [] });

export async function movieItem(ctx: VideoItemContext, id: number, opts: VideoItemOptions): Promise<PlayableItem | null> {
  const movie = ctx.db.select().from(movies).where(eq(movies.id, id)).get();
  if (!movie || !withinRestrictions(opts.restrictions, 'movie', movie.certification)) return null;
  const versions = versionsOf(ctx.db, movieFiles(ctx.db, id));
  const best = versions[0];
  if (!best) return null;
  const durationMs = durationOf(best.file.mediaInfo ?? null, movie.runtimeMinutes);
  const chapters = await chaptersFor(ctx, best.file, durationMs, opts.probe);
  return {
    ...videoBase(),
    itemKey: itemKey('movie', id),
    kind: 'movie',
    title: movie.title,
    subtitle: movie.year ? String(movie.year) : null,
    artworkUrl: imageUrl(ctx.basePath, 'movie', id, movie.images, 'poster', '342'),
    durationMs,
    chapters,
    movieId: id,
    year: movie.year || null,
    overview: movie.overview || null,
    backdropUrl: imageUrl(ctx.basePath, 'movie', id, movie.images, 'fanart', '1280'),
    logoUrl: imageUrl(ctx.basePath, 'movie', id, movie.images, 'logo', '780'),
    video: best.info,
    versions: versions.map(toVersion),
    segments: segmentsFromChapters(chapters),
  };
}

/** Episodes of a series that have a file, in play order (specials last). */
export function playableEpisodes(db: Db, seriesId: number): EpisodeRow[] {
  return db
    .select()
    .from(episodes)
    .where(and(eq(episodes.seriesId, seriesId), eq(episodes.hasFile, true), isNotNull(episodes.episodeFileId)))
    .all()
    .sort((a, b) => seasonOrder(a.seasonNumber) - seasonOrder(b.seasonNumber) || a.episodeNumber - b.episodeNumber);
}

/** Specials (season 0) sort after the regular seasons. */
export const seasonOrder = (n: number) => (n === 0 ? Number.MAX_SAFE_INTEGER : n);

/** The episodes before and after `episode` with a file; specials only neighbour specials. */
export function neighbours(list: readonly EpisodeRow[], episode: Pick<EpisodeRow, 'id' | 'seasonNumber'>): { previous: EpisodeRow | null; next: EpisodeRow | null } {
  const same = list.filter((e) => (e.seasonNumber === 0) === (episode.seasonNumber === 0));
  const i = same.findIndex((e) => e.id === episode.id);
  if (i < 0) return { previous: null, next: null };
  return { previous: same[i - 1] ?? null, next: same[i + 1] ?? null };
}

export const episodeCode = (e: Pick<EpisodeRow, 'seasonNumber' | 'episodeNumber'>) => `S${e.seasonNumber}:E${e.episodeNumber}`;

export async function episodeItem(ctx: VideoItemContext, id: number, opts: VideoItemOptions): Promise<PlayableItem | null> {
  const row = ctx.db.select({ episode: episodes, series }).from(episodes).innerJoin(series, eq(series.id, episodes.seriesId)).where(eq(episodes.id, id)).get();
  if (!row || !withinRestrictions(opts.restrictions, 'series', row.series.certification)) return null;
  const { episode, series: show } = row;
  const versions = versionsOf(ctx.db, episodeFiles(ctx.db, episode));
  const best = versions[0];
  if (!best) return null;
  const durationMs = durationOf(best.file.mediaInfo ?? null, episode.runtimeMinutes ?? show.runtimeMinutes);
  const chapters = await chaptersFor(ctx, best.file, durationMs, opts.probe);
  const { previous, next } = neighbours(playableEpisodes(ctx.db, show.id), episode);
  return {
    ...videoBase(),
    itemKey: itemKey('episode', id),
    kind: 'episode',
    title: episode.title && episode.title !== 'TBA' ? episode.title : `Episode ${episode.episodeNumber}`,
    subtitle: show.title,
    context: episodeCode(episode),
    artworkUrl: videoArtworkUrl(ctx.basePath, 'episode', id),
    durationMs,
    chapters,
    seriesId: show.id,
    seasonNumber: episode.seasonNumber,
    episodeNumber: episode.episodeNumber,
    year: show.year || null,
    overview: episode.overview || null,
    backdropUrl: imageUrl(ctx.basePath, 'series', show.id, show.images, 'fanart', '1280'),
    logoUrl: imageUrl(ctx.basePath, 'series', show.id, show.images, 'logo', '780'),
    video: best.info,
    versions: versions.map(toVersion),
    segments: segmentsFromChapters(chapters),
    ...(next ? { next: itemKey('episode', next.id) } : {}),
    ...(previous ? { previous: itemKey('episode', previous.id) } : {}),
  };
}

/** The playable video item for a parsed key, or null (missing, no file, restricted). */
export function videoItem(ctx: VideoItemContext, kind: 'movie' | 'episode', id: number, opts: VideoItemOptions): Promise<PlayableItem | null> {
  return kind === 'movie' ? movieItem(ctx, id, opts) : episodeItem(ctx, id, opts);
}

/** The files a video item may play, with the DV base range for the decision. Null when not playable. */
export function playableFilesOf(db: Db, kind: 'movie' | 'episode', id: number, restrictions: ContentRestrictions | null): Array<VersionedFile & { baseRange: ReturnType<typeof baseRangeOf> }> | null {
  let files: MediaFileRow[];
  if (kind === 'movie') {
    const movie = db.select({ certification: movies.certification }).from(movies).where(eq(movies.id, id)).get();
    if (!movie || !withinRestrictions(restrictions, 'movie', movie.certification)) return null;
    files = movieFiles(db, id);
  } else {
    const row = db.select({ episode: episodes, certification: series.certification }).from(episodes).innerJoin(series, eq(series.id, episodes.seriesId)).where(eq(episodes.id, id)).get();
    if (!row || !withinRestrictions(restrictions, 'series', row.certification)) return null;
    files = episodeFiles(db, row.episode);
  }
  const versions = versionsOf(db, files);
  return versions.length === 0 ? null : versions.map((v) => ({ ...v, baseRange: baseRangeOf(v.file.mediaInfo ?? null) }));
}

/**
 * Whether a media file may be streamed under `restrictions`: it must belong to a movie, or to a
 * series, within the caps. Null when the file is unknown.
 */
export function mediaFileAllowed(db: Db, fileId: number, restrictions: ContentRestrictions | null): MediaFileRow | null {
  const file = db.select().from(mediaFiles).where(eq(mediaFiles.id, fileId)).get();
  if (!file) return null;
  if (file.mediaType === 'movie' && file.movieId) {
    const m = db.select({ certification: movies.certification }).from(movies).where(eq(movies.id, file.movieId)).get();
    return m && withinRestrictions(restrictions, 'movie', m.certification) ? file : null;
  }
  if (file.seriesId) {
    const s = db.select({ certification: series.certification }).from(series).where(eq(series.id, file.seriesId)).get();
    return s && withinRestrictions(restrictions, 'series', s.certification) ? file : null;
  }
  return null;
}

/** The VideoInfo of one media file (with its external subtitles), for the stream routes. */
export function videoInfoForFile(db: Db, file: MediaFileRow): VideoInfo {
  return versionsOf(db, [file])[0]!.info;
}
