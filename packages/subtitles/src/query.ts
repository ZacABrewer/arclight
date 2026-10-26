import { parsePath, parseRelease } from '@arclight/parser';
import type { MediaFile } from '@arclight/shared';
import { parseLanguageTag } from './languages.js';
import { detectAudioCodec, detectResolution, detectSource, detectStreamingService, detectVideoCodec } from './scoring.js';
import type { FileHashes, LanguageTag, MediaType, SubtitleQuery, WantedLanguage } from './types.js';

// Build a SubtitleQuery from a library media file plus item metadata (spec R5.12 layering:
// file name parse, then scene name fills gaps, then database and probe data).

export type QueryFile = Pick<MediaFile, 'path' | 'sizeBytes'> &
  Partial<Pick<MediaFile, 'sceneName' | 'releaseGroup' | 'edition' | 'mediaInfo' | 'quality'>>;

export interface QueryInputData {
  mediaType: MediaType;
  file: QueryFile;
  title: string;
  originalTitle?: string | undefined;
  alternativeTitles?: readonly string[] | undefined;
  year?: number | undefined;
  season?: number | undefined;
  episode?: number | undefined;
  absoluteEpisode?: number | undefined;
  episodeTitle?: string | undefined;
  imdbId?: string | undefined;
  seriesImdbId?: string | undefined;
  tmdbId?: number | undefined;
  tvdbId?: number | undefined;
  seriesTvdbId?: number | undefined;
  anidbEpisodeId?: number | undefined;
  anilistId?: number | undefined;
  fps?: number | undefined;
  hashes?: FileHashes | undefined;
  languages: readonly WantedLanguage[];
  /** Merge the scene name (use_scenename, default true). */
  useSceneName?: boolean | undefined;
}

const QUALITY_SOURCE_LABEL: Record<string, string> = {
  television: 'HDTV',
  televisionRaw: 'HDTV',
  web: 'Web',
  webRip: 'Web',
  bluray: 'Blu-ray',
  blurayRaw: 'Blu-ray',
  dvd: 'DVD',
};

function basename(p: string): string {
  return p.slice(Math.max(p.lastIndexOf('/'), p.lastIndexOf('\\')) + 1);
}

function first<T>(...values: (T | null | undefined)[]): T | undefined {
  for (const v of values) if (v !== undefined && v !== null && v !== '') return v;
  return undefined;
}

/** Build the query; later layers only fill fields still missing. */
export function buildQuery(input: QueryInputData): SubtitleQuery {
  const { file } = input;
  const hint = input.mediaType === 'episode' ? 'series' : 'movie';
  const fromFile = parsePath(file.path, hint);
  const scene = input.useSceneName !== false && file.sceneName ? parseRelease(file.sceneName, hint) : undefined;
  const names = [basename(file.path), input.useSceneName !== false ? file.sceneName ?? '' : ''].filter(Boolean);
  const detectAll = (fn: (s: string) => string | undefined) => first(...names.map(fn));

  const qualitySource = file.quality?.quality.source;
  const qualityRes = file.quality?.quality.resolution;
  const mediaRes = file.mediaInfo?.resolution ? /x(\d{3,4})$/.exec(file.mediaInfo.resolution)?.[1] : undefined;

  const audioLanguages = (file.mediaInfo?.audioLanguages ?? [])
    .map((l) => parseLanguageTag(l))
    .filter((l): l is LanguageTag => l !== undefined);

  const movieEdition = fromFile.movie?.edition ?? scene?.movie?.edition;
  const parsedYear = fromFile.series?.titleInfo.year || fromFile.movie?.year || scene?.series?.titleInfo.year || scene?.movie?.year || undefined;

  const query: SubtitleQuery = {
    mediaType: input.mediaType,
    title: input.title.replace(/\s*\(\d{4}\)\s*$/, ''),
    originalTitle: input.originalTitle,
    alternativeTitles: input.alternativeTitles,
    // R5.5: the database year is a fallback only when the file name has none.
    year: parsedYear ?? input.year,
    season: input.season,
    episode: input.episode,
    absoluteEpisode: input.absoluteEpisode,
    episodeTitle: input.episodeTitle,
    imdbId: input.imdbId,
    seriesImdbId: input.seriesImdbId,
    tmdbId: input.tmdbId,
    tvdbId: input.tvdbId,
    seriesTvdbId: input.seriesTvdbId,
    anidbEpisodeId: input.anidbEpisodeId,
    anilistId: input.anilistId,
    releaseGroup: first(file.releaseGroup, fromFile.releaseGroup, scene?.releaseGroup),
    source: first(detectAll(detectSource), qualitySource && qualitySource !== 'unknown' ? QUALITY_SOURCE_LABEL[qualitySource] : undefined),
    resolution: first(detectAll(detectResolution), qualityRes ? `${qualityRes}p` : undefined, mediaRes ? `${mediaRes}p` : undefined),
    videoCodec: first(detectAll(detectVideoCodec), file.mediaInfo?.videoCodec),
    audioCodec: first(detectAll(detectAudioCodec), file.mediaInfo?.audioCodec),
    streamingService: detectAll(detectStreamingService),
    edition: first(file.edition, movieEdition),
    sceneName: file.sceneName ?? undefined,
    filePath: file.path,
    fileName: basename(file.path),
    fileSize: file.sizeBytes,
    fps: input.fps,
    hashes: input.hashes,
    audioLanguages: audioLanguages.length ? audioLanguages : undefined,
    languages: input.languages,
  };
  return query;
}
