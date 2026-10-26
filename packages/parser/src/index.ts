import { prepare, stripExtension, cleanTitle, normalizeTitle, spaced } from './normalize.js';
import { parseQuality, parseRevision } from './quality.js';
import { parseSeries, parseSeriesTitleInfo, parseSeasonTitle } from './series.js';
import { parseMovie, normalizeImdbId } from './movie.js';
import { parseLanguages } from './language.js';
import { parseReleaseGroup } from './group.js';
import { isHashedRelease, parseReleaseHash } from './hash.js';
import type { MediaTypeHint, ParsedRelease } from './types.js';

export * from './types.js';
export {
  parseQuality,
  parseRevision,
  parseSeries,
  parseSeriesTitleInfo,
  parseSeasonTitle,
  parseMovie,
  normalizeImdbId,
  parseLanguages,
  parseReleaseGroup,
  isHashedRelease,
  parseReleaseHash,
  cleanTitle,
  normalizeTitle,
  spaced,
};

/**
 * Some obfuscated posts are the real name written backwards ("10E10S.esaeleR.emoS").
 * A reversed SxxEyy marker is the tell.
 */
function unreverse(title: string): string {
  if (/(?:^|[-_. ])\d{1,3}E-?\d{1,4}S(?:[-_. ]|$)/.test(title) && !/(?:^|[-_. ])S\d{1,4}-?E\d{1,3}(?:[-_. ]|$)/i.test(title)) {
    return [...title].reverse().join('');
  }
  return title;
}

/**
 * Index in `releaseTitle` where the parsed title ends, or 0 when no title was found. The
 * text before it is title, so language/quality words there are not release attributes.
 */
export function titleEndIndex(releaseTitle: string, title: string): number {
  if (!title) return 0;
  // Compare on a separator-insensitive view; map the match end back to the original string.
  const words = spaced(title).split(' ').filter(Boolean);
  if (words.length === 0) return 0;
  let pos = 0;
  const lower = releaseTitle.toLowerCase();
  for (const w of words) {
    const idx = lower.indexOf(w.toLowerCase(), pos);
    if (idx < 0) return 0;
    pos = idx + w.length;
  }
  return pos;
}

/**
 * Parse a release or file name. With hint 'auto' both interpretations are attempted; the
 * series one wins when the title has episode structure, otherwise the movie one.
 */
export function parseRelease(raw: string, hint: MediaTypeHint = 'auto'): ParsedRelease & { titleEnd: number } {
  const stripped = stripExtension(raw.trim());
  const extension = stripped.extension;
  const unreversed = unreverse(stripped.title);
  const source = unreversed === stripped.title ? raw : unreversed;
  const releaseTitle = prepare(source);

  const releaseGroup = parseReleaseGroup(releaseTitle);
  const quality = parseQuality(releaseTitle, extension);
  const releaseHash = parseReleaseHash(unreversed);

  const series = hint === 'movie' ? null : parseSeries(releaseTitle);
  const movie = hint === 'series' || series ? null : parseMovie(releaseTitle);

  // Language words inside the title ("The French Connection") are not release languages.
  const titleEnd = titleEndIndex(releaseTitle, series?.title ?? movie?.title ?? '');
  const languages = parseLanguages(releaseTitle.slice(titleEnd), releaseGroup);

  return { releaseTitle, quality, languages, releaseGroup, releaseHash, series, movie, titleEnd };
}

/** Capture-source words; used to decide whether a file name says where it came from. */
const SOURCE_WORD = /(?<![a-z0-9])(?:blu-?ray|bd(?:rip|remux)?|br-?rip|remux|web(?:-?dl|-?rip)?|hdtv|pdtv|sdtv|dvd(?:rip|r)?|hdrip|cam|telesync|telecine)(?![a-z0-9])/i;

/** A path segment that only names a season: "Season 2", "Season 01 - Name", "Specials". */
function seasonFolder(name: string): number | null {
  const m = /^(?:Season|Saison|Staffel|Series)[-_. ]*(\d{1,4})(?:\s*-.*)?$/i.exec(name.trim());
  if (m) return Number(m[1]);
  if (/^Specials?$/i.test(name.trim())) return 0;
  return null;
}

/**
 * Parse a file path. Tries the file name; when that is hashed/obfuscated or yields nothing,
 * falls back to the parent folder name (which is where scene releases keep the real title).
 */
export function parsePath(path: string, hint: MediaTypeHint = 'auto'): ParsedRelease {
  const parts = path.split(/[\\/]+/).filter(Boolean);
  const fileName = parts[parts.length - 1] ?? path;
  const folder = parts.length > 1 ? parts[parts.length - 2]! : null;
  const folderSeason = folder ? seasonFolder(folder) : null;

  const hashed = isHashedRelease(fileName);
  const fromFile = hashed ? null : parseRelease(fileName, hint);

  // "Season 2\01. Episode Name.mkv", "Season 2\E05-06 - Name": season from the folder.
  if (folderSeason !== null && fromFile && hint !== 'movie') {
    const base = stripExtension(fileName).title;
    const s = fromFile.series;
    if (s && s.seasons.length <= 1 && s.airDate === null) {
      if (s.absoluteEpisodes.length > 0 && s.episodes.length === 0) {
        s.episodes = s.absoluteEpisodes;
        s.absoluteEpisodes = [];
      }
      if (s.episodes.length > 0 && (s.seasons[0] === undefined || s.seasons[0] <= 1 || s.seasons[0] === folderSeason)) {
        s.seasons = [folderSeason];
        s.special = folderSeason === 0 || s.special;
      }
      return fromFile;
    }
    // "Season 01\01 Pilot (1080p HD).mkv": a leading episode number inside a season folder.
    const lead = /^(\d{1,3})(?:[-_. ]|$)/.exec(base);
    if (!s && lead) {
      const rest = base.slice(lead[0].length);
      const viaFolder = parseRelease(`S${folderSeason}E${lead[1]} ${rest}`, 'series');
      if (viaFolder.series) {
        viaFolder.quality = fromFile.quality;
        return viaFolder;
      }
    }
  }

  const fileOk = fromFile && (fromFile.series || fromFile.movie);
  if (fileOk && folder) {
    // "Movie.2011.UHD.BluRay-CtrlHD/ctrlhd-rotpota-1080p.mkv": the file name gives the
    // resolution but no source; take the source from the folder.
    const base = stripExtension(fileName).title;
    if (!SOURCE_WORD.test(base) && SOURCE_WORD.test(folder)) {
      const folderTags = folder.replace(/(?<![a-z0-9])(?:2160p|1080[pi]|720p|576p|480p|uhd|4k)(?![a-z0-9])/gi, ' ');
      fromFile.quality = parseQuality(prepare(`${base} ${folderTags}`), stripExtension(fileName).extension);
    }
  }
  if (fileOk || !folder) return fromFile ?? parseRelease(fileName, hint);

  const fromFolder = parseRelease(folder, hint);
  // "Title 921-928 [Batch]/921.mkv": the file is one episode of the folder's range.
  const bare = /^\d{1,4}$/.exec(stripExtension(fileName).title);
  const folderSeries = fromFolder.series;
  if (bare && folderSeries && folderSeries.absoluteEpisodes.includes(Number(bare[0]))) {
    folderSeries.absoluteEpisodes = [Number(bare[0])];
  }
  if (fromFolder.series || fromFolder.movie) {
    // Keep extension-derived quality from the file if the folder has none.
    const fileQuality = fromFile?.quality ?? parseRelease(fileName, hint).quality;
    if (fromFolder.quality.quality.id === 0 && fileQuality.quality.id !== 0) {
      fromFolder.quality = fileQuality;
    }
    return fromFolder;
  }
  // Deeper folders: "Title.S01E01\hash\MKV\file.mkv"
  for (let i = parts.length - 3; i >= 0 && i >= parts.length - 5; i--) {
    const deeper = parseRelease(parts[i]!, hint);
    if (deeper.series || deeper.movie) return deeper;
  }
  return fromFile ?? fromFolder;
}
