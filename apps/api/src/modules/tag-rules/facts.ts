import { and, asc, eq, gt, inArray, ne } from 'drizzle-orm';
import type { MediaInfo, QualityModel, TagEntityType, TagRuleSetField, TagTemplateVariable } from '@arclight/shared';
import type { Db } from '../../db/index.js';
import * as s from '../../db/schema.js';
import type { ItemFacts } from './engine.js';

// The database half of tag rules: turns library rows (and their files, requests, books ...)
// into ItemFacts, a page of items at a time. Value normalisers are exported for the tests.

type FileLike = {
  quality: QualityModel;
  mediaInfo: MediaInfo | null;
  sizeBytes: number;
  releaseGroup: string | null;
  languages?: string[];
};

// ---------------------------------------------------------------------------------------
// Normalisers (pure)
// ---------------------------------------------------------------------------------------

/** `2160p`, `1080p` ...; from the quality, else the probed height. Null when unknown. */
export function resolutionOf(quality: QualityModel | null | undefined, info: MediaInfo | null | undefined): string | null {
  const r = quality?.quality.resolution ?? 0;
  if (r > 0) return `${r}p`;
  const h = info?.height ?? Number(/x(\d+)/.exec(info?.resolution ?? '')?.[1] ?? 0);
  if (!h) return null;
  const w = info?.width ?? 0;
  if (h > 1600 || w > 3200) return '2160p';
  if (h > 900 || w > 1700) return '1080p';
  if (h > 600 || w > 1100) return '720p';
  if (h > 400) return '576p';
  return '480p';
}

/** HDR formats of a file, lower case: `dv`, `hdr10+`, `hdr10`, `hlg`, `pq`; `hdr` when HDR of an unknown kind. Empty for SDR. */
export function hdrFormatsOf(info: MediaInfo | null | undefined): string[] {
  if (!info) return [];
  const raw = `${info.videoDynamicRangeType ?? ''} ${info.videoDynamicRange ?? ''}`.toUpperCase();
  const out: string[] = [];
  if (/\bDV\b|DOVI|DOLBY ?VISION/.test(raw) || (info.doviProfile ?? 0) > 0) out.push('dv');
  if (/HDR10(PLUS|\+)/.test(raw)) out.push('hdr10+');
  else if (/HDR10/.test(raw)) out.push('hdr10');
  if (/HLG/.test(raw)) out.push('hlg');
  if (/\bPQ\b/.test(raw)) out.push('pq');
  if (out.length === 0 && /\bHDR/.test(raw)) out.push('hdr');
  return out;
}

const CODEC_FAMILIES: ReadonlyArray<[RegExp, string]> = [
  [/x265|hevc|h\.?265/i, 'hevc'],
  [/x264|avc|h\.?264/i, 'h264'],
  [/av1/i, 'av1'],
  [/vp9/i, 'vp9'],
  [/vc-?1/i, 'vc1'],
  [/mpeg-?2/i, 'mpeg2'],
  [/xvid|divx|mpeg-?4/i, 'xvid'],
];

/** Video codec family: `hevc`, `h264`, `av1`, `vp9`, `vc1`, `mpeg2`, `xvid`, or the raw name lower-cased. */
export function videoCodecOf(info: MediaInfo | null | undefined): string | null {
  const raw = info?.videoCodec ?? info?.videoFormat ?? null;
  if (!raw) return null;
  for (const [re, name] of CODEC_FAMILIES) if (re.test(raw)) return name;
  return raw.trim().toLowerCase() || null;
}

/** Audio languages of a file: probed track languages plus the languages parsed from the release. */
export function audioLanguagesOf(file: FileLike): string[] {
  const out = new Set<string>();
  for (const l of file.mediaInfo?.audioLanguages ?? []) if (l) out.add(l.toLowerCase());
  for (const st of file.mediaInfo?.audioStreams ?? []) if (st.language) out.add(st.language.toLowerCase());
  for (const l of file.languages ?? []) if (l && l.toLowerCase() !== 'unknown') out.add(l.toLowerCase());
  return [...out];
}

/** `5.1`, `2.0`: one decimal place. */
export const channelsLabel = (n: number) => (Number.isInteger(n) ? `${n}.0` : String(Math.round(n * 10) / 10));

/** 1990 → `1990s`. */
export const decadeOf = (year: number) => `${Math.floor(year / 10) * 10}s`;

/** TMDB rating first, then IMDb, then whatever source is there. */
export function ratingOf(ratings: Record<string, { value: number }> | null | undefined): number | null {
  if (!ratings) return null;
  const pick = ratings['tmdb'] ?? ratings['imdb'] ?? Object.values(ratings)[0];
  return pick && pick.value > 0 ? pick.value : null;
}

const GB = 1024 ** 3;

function lastSegment(path: string): string {
  const parts = path.replace(/[\\/]+$/, '').split(/[\\/]/);
  return parts[parts.length - 1] ?? path;
}

const uniq = <T>(xs: Iterable<T>): T[] => [...new Set(xs)];
const nonNull = <T>(x: T | null | undefined): x is T => x !== null && x !== undefined && x !== '';

/** Facts every video file contributes (movies and series aggregate over all their files). */
export function videoFileFacts(files: readonly FileLike[]) {
  const resolution = uniq(files.map((f) => resolutionOf(f.quality, f.mediaInfo)).filter(nonNull));
  const hdr = uniq(files.flatMap((f) => hdrFormatsOf(f.mediaInfo)));
  const channels = files.map((f) => f.mediaInfo?.audioChannels).filter((c): c is number => typeof c === 'number' && c > 0);
  return {
    resolution,
    quality: uniq(files.map((f) => f.quality.quality.name).filter(nonNull)),
    source: uniq(files.map((f) => f.quality.quality.source).filter((x) => nonNull(x) && x !== 'unknown')),
    hdr,
    videoCodec: uniq(files.map((f) => videoCodecOf(f.mediaInfo)).filter(nonNull)),
    audioCodec: uniq(files.map((f) => f.mediaInfo?.audioCodec?.toLowerCase()).filter(nonNull)),
    audioLanguage: uniq(files.flatMap(audioLanguagesOf)),
    releaseGroup: uniq(files.map((f) => f.releaseGroup).filter(nonNull)),
    maxChannels: channels.length > 0 ? Math.max(...channels) : null,
    sizeGb: files.length > 0 ? files.reduce((n, f) => n + f.sizeBytes, 0) / GB : null,
  };
}

// ---------------------------------------------------------------------------------------
// Shared lookups (loaded once per run)
// ---------------------------------------------------------------------------------------

export interface Lookups {
  /** user id → username. */
  users: Map<number, string>;
  /** quality profile id → name. */
  qualityProfiles: Map<number, string>;
  /** `movie:<tmdbId>`, `series:<tmdbId>`, `artist:<id>` / `artistmb:<mbid>`, `author:<id>` / `authorasin:<asin>` → requester ids. */
  requesters: Map<string, Set<number>>;
}

function addRequester(map: Map<string, Set<number>>, key: string, userId: number) {
  const set = map.get(key) ?? new Set<number>();
  set.add(userId);
  map.set(key, set);
}

export function loadLookups(db: Db): Lookups {
  const users = new Map(db.select({ id: s.users.id, username: s.users.username }).from(s.users).all().map((u) => [u.id, u.username]));
  const qualityProfiles = new Map(db.select({ id: s.qualityProfiles.id, name: s.qualityProfiles.name }).from(s.qualityProfiles).all().map((p) => [p.id, p.name]));
  const requesters = new Map<string, Set<number>>();
  for (const r of db
    .select({ type: s.mediaRequests.type, tmdbId: s.mediaRequests.tmdbId, by: s.mediaRequests.requestedById })
    .from(s.mediaRequests)
    .where(ne(s.mediaRequests.status, 'declined'))
    .all()) {
    addRequester(requesters, `${r.type}:${r.tmdbId}`, r.by);
  }
  const audio = db
    .select({
      kind: s.audioRequests.kind,
      foreignId: s.audioRequests.foreignId,
      parent: s.audioRequests.parentForeignId,
      libraryId: s.audioRequests.libraryId,
      by: s.audioRequests.requestedById,
    })
    .from(s.audioRequests)
    .where(ne(s.audioRequests.status, 'declined'))
    .all();
  const bookIds = audio.filter((r) => r.kind === 'book' && r.libraryId !== null).map((r) => r.libraryId!);
  const bookAuthor = new Map<number, number>();
  for (let i = 0; i < bookIds.length; i += 500) {
    for (const b of db.select({ id: s.books.id, authorId: s.books.authorId }).from(s.books).where(inArray(s.books.id, bookIds.slice(i, i + 500))).all()) {
      bookAuthor.set(b.id, b.authorId);
    }
  }
  for (const r of audio) {
    if (r.kind === 'artist') {
      if (r.libraryId !== null) addRequester(requesters, `artist:${r.libraryId}`, r.by);
      addRequester(requesters, `artistmb:${r.foreignId}`, r.by);
    } else if (r.kind === 'album') {
      if (r.parent) addRequester(requesters, `artistmb:${r.parent}`, r.by);
    } else if (r.kind === 'author') {
      if (r.libraryId !== null) addRequester(requesters, `author:${r.libraryId}`, r.by);
      addRequester(requesters, `authorasin:${r.foreignId}`, r.by);
    } else if (r.kind === 'book') {
      const authorId = r.libraryId !== null ? bookAuthor.get(r.libraryId) : undefined;
      if (authorId !== undefined) addRequester(requesters, `author:${authorId}`, r.by);
      if (r.parent) addRequester(requesters, `authorasin:${r.parent}`, r.by);
    }
  }
  return { users, qualityProfiles, requesters };
}

function requesterIds(lk: Lookups, keys: readonly string[]): number[] {
  const out = new Set<number>();
  for (const k of keys) for (const id of lk.requesters.get(k) ?? []) out.add(id);
  return [...out].sort((a, b) => a - b);
}

function requesterNames(lk: Lookups, ids: readonly number[]): string[] {
  return ids.map((id) => lk.users.get(id)).filter(nonNull);
}

function profileNames(lk: Lookups, id: number): string[] {
  const n = lk.qualityProfiles.get(id);
  return n ? [n] : [];
}

function groupBy<T, K>(rows: readonly T[], key: (r: T) => K): Map<K, T[]> {
  const m = new Map<K, T[]>();
  for (const r of rows) {
    const k = key(r);
    const list = m.get(k);
    if (list) list.push(r);
    else m.set(k, [r]);
  }
  return m;
}

// ---------------------------------------------------------------------------------------
// Paging
// ---------------------------------------------------------------------------------------

export interface TaggedItem {
  id: number;
  tags: number[];
}

/** Next page of item ids (and their tags) after `afterId`, in id order. */
export function pageItems(db: Db, type: TagEntityType, afterId: number, limit: number): TaggedItem[] {
  const table = tableFor(type);
  return db.select({ id: table.id, tags: table.tags }).from(table).where(gt(table.id, afterId)).orderBy(asc(table.id)).limit(limit).all();
}

export function itemsByIds(db: Db, type: TagEntityType, ids: readonly number[]): TaggedItem[] {
  if (ids.length === 0) return [];
  const table = tableFor(type);
  return db.select({ id: table.id, tags: table.tags }).from(table).where(inArray(table.id, [...ids])).all();
}

export function tableFor(type: TagEntityType) {
  switch (type) {
    case 'movie':
      return s.movies;
    case 'series':
      return s.series;
    case 'artist':
      return s.artists;
    case 'author':
      return s.authors;
  }
}

// ---------------------------------------------------------------------------------------
// Facts per item type
// ---------------------------------------------------------------------------------------

type Vars = Partial<Record<TagTemplateVariable, readonly string[]>>;
type Sets = Partial<Record<TagRuleSetField, readonly string[]>>;

function videoVars(ff: ReturnType<typeof videoFileFacts>, year: number | null): Vars {
  return {
    resolution: ff.resolution,
    quality: ff.quality,
    source: ff.source,
    hdr: ff.hdr,
    codec: ff.videoCodec,
    audiocodec: ff.audioCodec,
    language: ff.audioLanguage,
    releasegroup: ff.releaseGroup,
    channels: ff.maxChannels !== null ? [channelsLabel(ff.maxChannels)] : [],
    year: year ? [String(year)] : [],
    decade: year ? [decadeOf(year)] : [],
  };
}

/** Facts for a page of items of one type. Items that no longer exist are left out. */
export function loadFacts(db: Db, type: TagEntityType, ids: readonly number[], lk: Lookups): ItemFacts[] {
  if (ids.length === 0) return [];
  switch (type) {
    case 'movie':
      return movieFacts(db, ids, lk);
    case 'series':
      return seriesFacts(db, ids, lk);
    case 'artist':
      return artistFacts(db, ids, lk);
    case 'author':
      return authorFacts(db, ids, lk);
  }
}

function movieFacts(db: Db, ids: readonly number[], lk: Lookups): ItemFacts[] {
  const rows = db.select().from(s.movies).where(inArray(s.movies.id, [...ids])).all();
  const files = groupBy(
    db
      .select({
        movieId: s.mediaFiles.movieId,
        quality: s.mediaFiles.quality,
        mediaInfo: s.mediaFiles.mediaInfo,
        sizeBytes: s.mediaFiles.sizeBytes,
        releaseGroup: s.mediaFiles.releaseGroup,
        languages: s.mediaFiles.languages,
      })
      .from(s.mediaFiles)
      .where(inArray(s.mediaFiles.movieId, [...ids]))
      .all(),
    (f) => f.movieId,
  );
  return rows.map((m) => {
    const fs = files.get(m.id) ?? [];
    const ff = videoFileFacts(fs);
    const requestedBy = requesterIds(lk, [`movie:${m.tmdbId}`]);
    const collection = m.collection?.title ? [m.collection.title] : [];
    const sets: Sets = {
      genre: m.genres,
      resolution: ff.resolution,
      quality: ff.quality,
      source: ff.source,
      hdr: ff.hdr,
      videoCodec: ff.videoCodec,
      audioCodec: ff.audioCodec,
      audioLanguage: ff.audioLanguage,
      originalLanguage: m.originalLanguage ? [m.originalLanguage] : [],
      certification: m.certification ? [m.certification] : [],
      studio: m.studio ? [m.studio] : [],
      status: [m.status],
      rootFolder: [m.rootFolderPath],
      collection,
      releaseGroup: ff.releaseGroup,
    };
    return {
      entityType: 'movie',
      id: m.id,
      title: m.year ? `${m.title} (${m.year})` : m.title,
      addedAt: m.added,
      sets,
      nums: { year: m.year || null, rating: ratingOf(m.ratings), audioChannels: ff.maxChannels, sizeGb: ff.sizeGb, runtime: m.runtimeMinutes ?? null },
      bools: { monitored: m.monitored, hasFile: fs.length > 0 || m.hasFile },
      qualityProfileIds: [m.qualityProfileId],
      requestedByIds: requestedBy,
      vars: {
        ...videoVars(ff, m.year || null),
        genre: m.genres,
        originallanguage: sets.originalLanguage ?? [],
        certification: sets.certification ?? [],
        studio: sets.studio ?? [],
        status: [m.status],
        rootfolder: [lastSegment(m.rootFolderPath)],
        collection,
        requester: requesterNames(lk, requestedBy),
        qualityprofile: profileNames(lk, m.qualityProfileId),
      },
    } satisfies ItemFacts;
  });
}

function seriesFacts(db: Db, ids: readonly number[], lk: Lookups): ItemFacts[] {
  const rows = db.select().from(s.series).where(inArray(s.series.id, [...ids])).all();
  const files = groupBy(
    db
      .select({
        seriesId: s.mediaFiles.seriesId,
        quality: s.mediaFiles.quality,
        mediaInfo: s.mediaFiles.mediaInfo,
        sizeBytes: s.mediaFiles.sizeBytes,
        releaseGroup: s.mediaFiles.releaseGroup,
        languages: s.mediaFiles.languages,
      })
      .from(s.mediaFiles)
      .where(and(eq(s.mediaFiles.mediaType, 'series'), inArray(s.mediaFiles.seriesId, [...ids])))
      .all(),
    (f) => f.seriesId,
  );
  return rows.map((r) => {
    const fs = files.get(r.id) ?? [];
    const ff = videoFileFacts(fs);
    const requestedBy = requesterIds(lk, [`series:${r.tmdbId}`]);
    const sets: Sets = {
      genre: r.genres,
      resolution: ff.resolution,
      quality: ff.quality,
      source: ff.source,
      hdr: ff.hdr,
      videoCodec: ff.videoCodec,
      audioCodec: ff.audioCodec,
      audioLanguage: ff.audioLanguage,
      originalLanguage: r.originalLanguage ? [r.originalLanguage] : [],
      certification: r.certification ? [r.certification] : [],
      network: r.network ? [r.network] : [],
      status: [r.status],
      seriesType: [r.seriesType],
      rootFolder: [r.rootFolderPath],
      releaseGroup: ff.releaseGroup,
    };
    return {
      entityType: 'series',
      id: r.id,
      title: r.year ? `${r.title} (${r.year})` : r.title,
      addedAt: r.added,
      sets,
      nums: { year: r.year || null, rating: ratingOf(r.ratings), audioChannels: ff.maxChannels, sizeGb: ff.sizeGb, runtime: r.runtimeMinutes ?? null },
      bools: { monitored: r.monitored, hasFile: fs.length > 0 },
      qualityProfileIds: [r.qualityProfileId],
      requestedByIds: requestedBy,
      vars: {
        ...videoVars(ff, r.year || null),
        genre: r.genres,
        originallanguage: sets.originalLanguage ?? [],
        certification: sets.certification ?? [],
        network: sets.network ?? [],
        status: [r.status],
        seriestype: [r.seriesType],
        rootfolder: [lastSegment(r.rootFolderPath)],
        requester: requesterNames(lk, requestedBy),
        qualityprofile: profileNames(lk, r.qualityProfileId),
      },
    } satisfies ItemFacts;
  });
}

type AudioFileLike = { quality: QualityModel; codec: string | null; channels: number | null; sizeBytes: number; releaseGroup: string | null };

function audioFileFacts(files: readonly AudioFileLike[]) {
  const channels = files.map((f) => f.channels).filter((c): c is number => typeof c === 'number' && c > 0);
  return {
    quality: uniq(files.map((f) => f.quality.quality.name).filter((n) => nonNull(n) && n !== 'Unknown')),
    audioCodec: uniq(files.map((f) => f.codec?.toLowerCase()).filter(nonNull)),
    releaseGroup: uniq(files.map((f) => f.releaseGroup).filter(nonNull)),
    maxChannels: channels.length > 0 ? Math.max(...channels) : null,
    sizeGb: files.length > 0 ? files.reduce((n, f) => n + f.sizeBytes, 0) / GB : null,
  };
}

const audioFileCols = {
  artistId: s.audioFiles.artistId,
  authorId: s.audioFiles.authorId,
  quality: s.audioFiles.quality,
  codec: s.audioFiles.codec,
  channels: s.audioFiles.channels,
  sizeBytes: s.audioFiles.sizeBytes,
  releaseGroup: s.audioFiles.releaseGroup,
};

function artistFacts(db: Db, ids: readonly number[], lk: Lookups): ItemFacts[] {
  const rows = db.select().from(s.artists).where(inArray(s.artists.id, [...ids])).all();
  const files = groupBy(db.select(audioFileCols).from(s.audioFiles).where(inArray(s.audioFiles.artistId, [...ids])).all(), (f) => f.artistId);
  const albums = groupBy(
    db
      .select({ artistId: s.albums.artistId, primaryType: s.albums.primaryType, secondaryTypes: s.albums.secondaryTypes })
      .from(s.albums)
      .where(inArray(s.albums.artistId, [...ids]))
      .all(),
    (a) => a.artistId,
  );
  return rows.map((a) => {
    const fs = files.get(a.id) ?? [];
    const af = audioFileFacts(fs);
    const albumTypes = uniq((albums.get(a.id) ?? []).flatMap((x) => [x.primaryType, ...x.secondaryTypes]).filter(nonNull).map(String));
    const requestedBy = requesterIds(lk, [`artist:${a.id}`, `artistmb:${a.mbArtistId}`]);
    const sets: Sets = {
      genre: a.genres,
      quality: af.quality,
      audioCodec: af.audioCodec,
      status: [a.status],
      rootFolder: [a.rootFolderPath],
      releaseGroup: af.releaseGroup,
      albumType: albumTypes,
      artistType: a.artistType ? [a.artistType] : [],
    };
    return {
      entityType: 'artist',
      id: a.id,
      title: a.name,
      addedAt: a.added,
      sets,
      nums: { audioChannels: af.maxChannels, sizeGb: af.sizeGb },
      bools: { monitored: a.monitored, hasFile: fs.length > 0 },
      qualityProfileIds: [a.qualityProfileId],
      requestedByIds: requestedBy,
      vars: {
        genre: a.genres,
        quality: af.quality,
        audiocodec: af.audioCodec,
        releasegroup: af.releaseGroup,
        status: [a.status],
        albumtype: albumTypes,
        artisttype: sets.artistType ?? [],
        rootfolder: [lastSegment(a.rootFolderPath)],
        channels: af.maxChannels !== null ? [channelsLabel(af.maxChannels)] : [],
        requester: requesterNames(lk, requestedBy),
        qualityprofile: profileNames(lk, a.qualityProfileId),
      },
    } satisfies ItemFacts;
  });
}

function authorFacts(db: Db, ids: readonly number[], lk: Lookups): ItemFacts[] {
  const rows = db.select().from(s.authors).where(inArray(s.authors.id, [...ids])).all();
  const files = groupBy(db.select(audioFileCols).from(s.audioFiles).where(inArray(s.audioFiles.authorId, [...ids])).all(), (f) => f.authorId);
  const bookRows = db
    .select({ id: s.books.id, authorId: s.books.authorId, narrators: s.books.narrators, genres: s.books.genres, runtime: s.books.runtimeMinutes })
    .from(s.books)
    .where(inArray(s.books.authorId, [...ids]))
    .all();
  const books = groupBy(bookRows, (b) => b.authorId);
  const seriesByBook = new Map<number, string[]>();
  const bookIds = bookRows.map((b) => b.id);
  for (let i = 0; i < bookIds.length; i += 500) {
    for (const e of db
      .select({ bookId: s.bookSeriesEntries.bookId, name: s.bookSeries.name })
      .from(s.bookSeriesEntries)
      .innerJoin(s.bookSeries, eq(s.bookSeries.id, s.bookSeriesEntries.seriesId))
      .where(inArray(s.bookSeriesEntries.bookId, bookIds.slice(i, i + 500)))
      .all()) {
      const list = seriesByBook.get(e.bookId) ?? [];
      list.push(e.name);
      seriesByBook.set(e.bookId, list);
    }
  }
  return rows.map((a) => {
    const fs = files.get(a.id) ?? [];
    const af = audioFileFacts(fs);
    const bs = books.get(a.id) ?? [];
    const genres = uniq([...a.genres, ...bs.flatMap((b) => b.genres)]);
    const narrators = uniq(bs.flatMap((b) => b.narrators).filter(nonNull));
    const bookSeries = uniq(bs.flatMap((b) => seriesByBook.get(b.id) ?? []));
    const runtimes = bs.map((b) => b.runtime).filter((r): r is number => typeof r === 'number');
    const requestedBy = requesterIds(lk, [`author:${a.id}`, ...(a.asin ? [`authorasin:${a.asin}`] : [])]);
    const sets: Sets = {
      genre: genres,
      quality: af.quality,
      audioCodec: af.audioCodec,
      rootFolder: [a.rootFolderPath],
      releaseGroup: af.releaseGroup,
      author: [a.name],
      narrator: narrators,
      bookSeries,
    };
    return {
      entityType: 'author',
      id: a.id,
      title: a.name,
      addedAt: a.added,
      sets,
      nums: { audioChannels: af.maxChannels, sizeGb: af.sizeGb, runtime: runtimes.length > 0 ? runtimes.reduce((x, y) => x + y, 0) : null },
      bools: { monitored: a.monitored, hasFile: fs.length > 0 },
      qualityProfileIds: [a.qualityProfileId],
      requestedByIds: requestedBy,
      vars: {
        genre: genres,
        quality: af.quality,
        audiocodec: af.audioCodec,
        releasegroup: af.releaseGroup,
        author: [a.name],
        narrator: narrators,
        bookseries: bookSeries,
        rootfolder: [lastSegment(a.rootFolderPath)],
        channels: af.maxChannels !== null ? [channelsLabel(af.maxChannels)] : [],
        requester: requesterNames(lk, requestedBy),
        qualityprofile: profileNames(lk, a.qualityProfileId),
      },
    } satisfies ItemFacts;
  });
}
