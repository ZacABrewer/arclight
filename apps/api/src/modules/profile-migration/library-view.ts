import { inArray } from 'drizzle-orm';
import type { MediaFile, MediaType, MediaVersion } from '@arclight/shared';
import type { Db } from '../../db/index.js';
import { episodes, episodeVersionFiles, mediaFiles, movies, series } from '../../db/schema.js';
import { enabledVersions, findVersion, profileIdForSlot, slotOf } from '../library/index.js';

// A read-only view of the library slice a re-evaluation or a migration preview looks at: the
// items, their files (with the episodes each holds) and the profile governing every file. Read
// in a handful of queries per pass, never per file.

export interface ItemInfo {
  mediaType: MediaType;
  id: number;
  title: string;
  sortTitle: string;
  year: number;
  tmdbId: number;
  qualityProfileId: number;
  versions: MediaVersion[] | null;
  monitored: boolean;
  added: string;
  rootFolderPath: string;
  path: string;
  tags: number[];
  runtimeMinutes: number | null;
}

export interface EpisodeInfo {
  id: number;
  seriesId: number;
  seasonNumber: number;
  episodeNumber: number;
  monitored: boolean;
  runtimeMinutes: number | null;
}

export interface FileInfo {
  file: MediaFile;
  item: ItemInfo;
  /** Version slot the file fills; '' on unversioned items. */
  slot: string;
  /** Whether the slot is monitored (unversioned items: always). */
  slotEnabled: boolean;
}

/** Which items to read; `null` reads the whole library. */
export interface LibraryScope {
  seriesIds?: readonly number[];
  movieIds?: readonly number[];
}

export interface LibraryView {
  items: Map<string, ItemInfo>;
  files: FileInfo[];
  episodes: Map<number, EpisodeInfo>;
}

export const itemKey = (mediaType: MediaType, id: number): string => `${mediaType}:${id}`;

/** Profile per slot: '' is the item's own profile, then each configured version slot. */
export function profileMap(item: Pick<ItemInfo, 'qualityProfileId' | 'versions'>): Record<string, number> {
  const out: Record<string, number> = { '': item.qualityProfileId };
  for (const v of item.versions ?? []) out[v.tag] = v.qualityProfileId;
  return out;
}

/** The profile governing a file in `slot` ('' = unversioned). */
export function profileForSlot(item: Pick<ItemInfo, 'qualityProfileId' | 'versions'>, slot: string): number {
  return profileIdForSlot(item, slot === '' ? null : slot);
}

const CHUNK = 500;

function chunked<T>(values: readonly T[]): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < values.length; i += CHUNK) out.push(values.slice(i, i + CHUNK));
  return out;
}

export function loadLibrary(db: Db, scope: LibraryScope | null): LibraryView {
  const items = new Map<string, ItemInfo>();
  const seriesRows =
    scope === null
      ? db.select().from(series).all()
      : chunked(scope.seriesIds ?? []).flatMap((ids) => db.select().from(series).where(inArray(series.id, ids)).all());
  const movieRows =
    scope === null
      ? db.select().from(movies).all()
      : chunked(scope.movieIds ?? []).flatMap((ids) => db.select().from(movies).where(inArray(movies.id, ids)).all());

  for (const s of seriesRows) {
    items.set(itemKey('series', s.id), {
      mediaType: 'series',
      id: s.id,
      title: s.title,
      sortTitle: s.sortTitle,
      year: s.year,
      tmdbId: s.tmdbId,
      qualityProfileId: s.qualityProfileId,
      versions: s.versions ?? null,
      monitored: s.monitored,
      added: s.added,
      rootFolderPath: s.rootFolderPath,
      path: s.path,
      tags: s.tags,
      runtimeMinutes: s.runtimeMinutes,
    });
  }
  for (const m of movieRows) {
    items.set(itemKey('movie', m.id), {
      mediaType: 'movie',
      id: m.id,
      title: m.title,
      sortTitle: m.sortTitle,
      year: m.year,
      tmdbId: m.tmdbId,
      qualityProfileId: m.qualityProfileId,
      versions: m.versions ?? null,
      monitored: m.monitored,
      added: m.added,
      rootFolderPath: m.rootFolderPath,
      path: m.path,
      tags: m.tags,
      runtimeMinutes: m.runtimeMinutes,
    });
  }

  const seriesIds = seriesRows.map((s) => s.id);
  const movieIds = movieRows.map((m) => m.id);
  const fileRows = [
    ...chunked(seriesIds).flatMap((ids) => db.select().from(mediaFiles).where(inArray(mediaFiles.seriesId, ids)).all()),
    ...chunked(movieIds).flatMap((ids) => db.select().from(mediaFiles).where(inArray(mediaFiles.movieId, ids)).all()),
  ];

  const episodeRows = chunked(seriesIds).flatMap((ids) =>
    db
      .select({
        id: episodes.id,
        seriesId: episodes.seriesId,
        seasonNumber: episodes.seasonNumber,
        episodeNumber: episodes.episodeNumber,
        monitored: episodes.monitored,
        runtimeMinutes: episodes.runtimeMinutes,
        episodeFileId: episodes.episodeFileId,
      })
      .from(episodes)
      .where(inArray(episodes.seriesId, ids))
      .all(),
  );
  const episodeMap = new Map<number, EpisodeInfo>();
  const episodesByFile = new Map<number, Set<number>>();
  const link = (fileId: number, episodeId: number) => {
    let set = episodesByFile.get(fileId);
    if (!set) episodesByFile.set(fileId, (set = new Set()));
    set.add(episodeId);
  };
  for (const e of episodeRows) {
    episodeMap.set(e.id, {
      id: e.id,
      seriesId: e.seriesId,
      seasonNumber: e.seasonNumber,
      episodeNumber: e.episodeNumber,
      monitored: e.monitored,
      runtimeMinutes: e.runtimeMinutes,
    });
    if (e.episodeFileId !== null) link(e.episodeFileId, e.id);
  }
  const seriesFileIds = fileRows.filter((f) => f.mediaType === 'series').map((f) => f.id);
  for (const ids of chunked(seriesFileIds)) {
    for (const l of db
      .select({ episodeId: episodeVersionFiles.episodeId, fileId: episodeVersionFiles.mediaFileId })
      .from(episodeVersionFiles)
      .where(inArray(episodeVersionFiles.mediaFileId, ids))
      .all()) {
      link(l.fileId, l.episodeId);
    }
  }

  const files: FileInfo[] = [];
  for (const row of fileRows) {
    const item =
      row.seriesId != null ? items.get(itemKey('series', row.seriesId)) : row.movieId != null ? items.get(itemKey('movie', row.movieId)) : undefined;
    if (!item) continue;
    const slot = slotOf(row.versionTag ?? null, item.versions) ?? '';
    const version = slot === '' ? undefined : findVersion(item.versions, slot);
    const episodeIds = [...(episodesByFile.get(row.id) ?? [])].sort((a, b) => a - b);
    files.push({
      file: { ...row, episodeIds },
      item,
      slot,
      slotEnabled: slot === '' || (version !== undefined && enabledVersions([version]).length === 1),
    });
  }
  return { items, files, episodes: episodeMap };
}
