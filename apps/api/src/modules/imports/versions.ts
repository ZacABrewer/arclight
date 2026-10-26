import { join } from 'node:path';
import { hasVersionToken } from '@arclight/organizer';
import type { Episode, MediaFile, MediaVersion, Movie, NamingConfig, Series } from '@arclight/shared';
import { isVersioned, sameTag, slotOf } from '../library/index.js';

// Multi-version placement for the import pipeline (pure). A versioned item keeps one file per
// version slot; this decides which existing files a new file competes with (only its own
// slot) and where a versioned file lives on disk.

/** The naming format a file of this item is rendered with (for the `{Version}` check). */
export function formatFor(naming: NamingConfig, item: { series?: Pick<Series, 'seriesType'> | undefined }): string {
  if (!item.series) return naming.movieFormat;
  if (item.series.seriesType === 'daily') return naming.dailyEpisodeFormat;
  if (item.series.seriesType === 'anime') return naming.animeEpisodeFormat;
  return naming.standardEpisodeFormat;
}

/**
 * Where a (possibly versioned) file goes. Unversioned: `<folder>/<name>`. Versioned, layout
 * `subfolder`: `<folder>/<tag>/<name>`. Versioned, layout `sideBySide` (default): the name gets
 * ` - <tag>` before its extension unless the format already renders `{Version}`, so versions
 * never collide on one name.
 */
export function placeVersioned(
  folder: string,
  name: string,
  tag: string | null | undefined,
  naming: NamingConfig,
  format: string,
  extension: string,
): string {
  if (!tag) return join(folder, name);
  if (naming.versionLayout === 'subfolder') return join(folder, tag, name);
  if (hasVersionToken(format)) return join(folder, name);
  const ext = extension && name.toLowerCase().endsWith(extension.toLowerCase()) ? extension : '';
  const stem = ext ? name.slice(0, name.length - ext.length) : name;
  return join(folder, `${stem} - ${tag}${ext}`);
}

/**
 * Library files a new file would replace: those attached to the same episodes (or the movie)
 * that fill the same version slot. Unversioned items keep the classic rule: the files the
 * episodes / the movie point at.
 */
export function filesInSlot(
  all: readonly MediaFile[],
  target: { series?: Series | undefined; movie?: Movie | undefined; episodes: readonly Episode[] },
  slot: string | null,
): MediaFile[] {
  const versions: MediaVersion[] | null | undefined = target.series?.versions ?? target.movie?.versions;
  if (target.series) {
    const ids = new Set(target.episodes.map((e) => e.id));
    if (!isVersioned(versions)) {
      const primary = new Set(target.episodes.map((e) => e.episodeFileId).filter((v): v is number => typeof v === 'number'));
      return all.filter((f) => primary.has(f.id) && (f.versionTag ?? null) === null);
    }
    return all.filter((f) => f.episodeIds.some((id) => ids.has(id)) && sameTag(slotOf(f.versionTag, versions), slot));
  }
  if (target.movie) {
    if (!isVersioned(versions)) return all.filter((f) => f.id === target.movie!.movieFileId && (f.versionTag ?? null) === null);
    return all.filter((f) => sameTag(slotOf(f.versionTag, versions), slot));
  }
  return [];
}
