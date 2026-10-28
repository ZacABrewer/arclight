// Name assembly (spec sections 4, 8, 10): episode/movie file names, series/season/movie folders,
// and the UI preview samples.

import { formatHasToken, type MultiEpisodeStyle, type NamingConfig, type NamingSample, type NamingSamples } from '@arclight/shared';
import {
  EPISODE_TITLE_TOKENS,
  addCustomFormatTokens,
  addEditionTokens,
  addEpisodeTokens,
  addFileTokens,
  addMediaInfoTokens,
  addMovieTokens,
  addQualityTokens,
  addSeasonTokens,
  addSeriesTokens,
  addVersionTokens,
  addAlbumTokens,
  addArtistTokens,
  addAuthorTokens,
  addBookTokens,
  addPartTokens,
  addTrackTokens,
  normalizeTokenName,
  originalTitle,
  padNumber,
  parseFormat,
  protectLiteralEllipsis,
  renderParts,
  tokensOf,
  type TitleBudget,
  type TokenHandlers,
} from './tokens.js';
import {
  byteLength,
  cleanIllegal,
  cleanupFileComponent,
  cleanupFolderComponent,
  finalizeComponent,
  splitPath,
  truncateBytes,
  type CleanOptions,
} from './text.js';
import type {
  NamingAlbum,
  NamingArtist,
  NamingAuthor,
  NamingBook,
  NamingBookExtras,
  NamingEpisode,
  NamingExtras,
  NamingFile,
  NamingMovie,
  NamingSeries,
  NamingTrack,
  NamingTrackExtras,
} from './types.js';
import { SAMPLES } from './samples.js';

export class NamingFormatError extends Error {
  readonly code = 'NAMING_FORMAT_INVALID';
  constructor(message: string) {
    super(message);
    this.name = 'NamingFormatError';
  }
}

const DEFAULT_MAX_FILE_NAME_BYTES = 255;
const DEFAULT_MAX_PATH_BYTES = 4096;
const DEFAULT_RELEASE_GROUP = 'Arclight';

function cleanOptions(config: NamingConfig, media: 'tv' | 'movie'): CleanOptions {
  const colon = media === 'movie' && config.colonReplacement === 'custom' ? 'smart' : config.colonReplacement;
  return {
    replaceIllegalCharacters: config.replaceIllegalCharacters,
    colonReplacement: colon,
    customColonReplacement: config.customColonReplacement,
  };
}

const cleanerFor =
  (config: NamingConfig, media: 'tv' | 'movie') =>
  (value: string): string =>
    cleanIllegal(value, cleanOptions(config, media));

function withExtension(name: string, extras: NamingExtras): string {
  return extras.extension ? name + extras.extension : name;
}

// ---------------------------------------------------------------------------------------
// Episode numbering (spec 4.4-4.6)
// ---------------------------------------------------------------------------------------

const NUMBERING_RE =
  /(?<pre>[- ._]*)(?<s>s?)(?<season>\{season(?::(?<spad>0+))?\})(?<esep>[- ._]?[ex])\{episode(?::(?<epad>0+))?\}(?<post>[- ._]*)/gi;
const ABSOLUTE_RE = /(?<pre>[- ._]*)\{absolute(?::(?<pad>0+))?\}(?<post>[- ._]*)/gi;

/** Surrounding separator: trailing run if a token follows, else leading run if after `}` (4.4.2). */
function surroundingSeparator(source: string, offset: number, match: string, pre: string, post: string): string {
  if (post && source[offset + match.length] === '{') return post;
  if (pre && source[offset - 1] === '}') return pre;
  return '';
}

function numberingText(
  style: MultiEpisodeStyle,
  episodes: readonly NamingEpisode[],
  s: string,
  seasonText: string,
  esep: string,
  epad: string | undefined,
  separator: string,
): string {
  const eps = episodes.map((e) => padNumber(e.episodeNumber, epad));
  const head = `${s}${seasonText}${esep}${eps[0] ?? ''}`;
  const rest = eps.slice(1);
  if (rest.length === 0) return head;
  const last = rest[rest.length - 1] ?? '';
  switch (style) {
    case 'extend':
      return head + rest.map((e) => `-${e}`).join('');
    case 'duplicate':
      return head + rest.map((e) => `${separator}${s}${seasonText}${esep}${e}`).join('');
    case 'repeat':
      return head + rest.map((e) => `${esep}${e}`).join('');
    case 'scene':
      return head + rest.map((e) => `-${esep}${e}`).join('');
    case 'range':
      return `${head}-${last}`;
    case 'prefixedRange':
      return `${head}-${esep}${last}`;
  }
}

function absoluteText(style: MultiEpisodeStyle, numbers: readonly string[], separator: string): string {
  const [first = '', ...rest] = numbers;
  if (rest.length === 0) return first;
  const last = rest[rest.length - 1] ?? '';
  switch (style) {
    case 'duplicate':
      return first + rest.map((n) => separator + n).join('');
    case 'repeat': {
      const sep = separator.trim() || ' ';
      return first + rest.map((n) => sep + n).join('');
    }
    case 'extend':
    case 'scene':
      return first + rest.map((n) => `-${n}`).join('');
    case 'range':
    case 'prefixedRange':
      return `${first}-${last}`;
  }
}

function substituteNumbering(component: string, style: MultiEpisodeStyle, episodes: readonly NamingEpisode[]): string {
  const seasonNumber = episodes[0]?.seasonNumber ?? 0;
  return component.replace(NUMBERING_RE, (match: string, ...args: unknown[]) => {
    const offset = args[args.length - 3] as number;
    const g = args[args.length - 1] as Record<string, string | undefined>;
    const pre = g['pre'] ?? '';
    const post = g['post'] ?? '';
    const sep = surroundingSeparator(component, offset, match, pre, post);
    const body = numberingText(
      style,
      episodes,
      g['s'] ?? '',
      padNumber(seasonNumber, g['spad']),
      g['esep'] ?? '',
      g['epad'],
      sep,
    );
    return pre + body + post;
  });
}

function substituteAbsolute(
  component: string,
  style: MultiEpisodeStyle,
  episodes: readonly NamingEpisode[],
  useAbsolute: boolean,
): string {
  return component.replace(ABSOLUTE_RE, (match: string, ...args: unknown[]) => {
    const offset = args[args.length - 3] as number;
    const g = args[args.length - 1] as Record<string, string | undefined>;
    const pre = g['pre'] ?? '';
    const post = g['post'] ?? '';
    if (!useAbsolute) return pre + post;
    let sep = surroundingSeparator(component, offset, match, pre, post);
    if (!sep.trim()) sep = '-';
    const numbers = episodes.map((e) => padNumber(e.absoluteEpisodeNumber ?? 0, g['pad']));
    return pre + absoluteText(style, numbers, sep) + post;
  });
}

const hasNumbering = (s: string): boolean => new RegExp(NUMBERING_RE.source, 'i').test(s);
const hasAbsolute = (s: string): boolean => /\{absolute(?::0+)?\}/i.test(s);

// ---------------------------------------------------------------------------------------
// Episode file names
// ---------------------------------------------------------------------------------------

function sortEpisodes(episodes: readonly NamingEpisode[]): NamingEpisode[] {
  return [...episodes].sort((a, b) => a.seasonNumber - b.seasonNumber || a.episodeNumber - b.episodeNumber);
}

const allHaveAbsolute = (episodes: readonly NamingEpisode[]): boolean =>
  episodes.length > 0 && episodes.every((e) => e.absoluteEpisodeNumber != null && e.absoluteEpisodeNumber > 0);

type EpisodeFormatKind = 'standard' | 'daily' | 'anime';

function chooseEpisodeFormat(
  config: NamingConfig,
  series: NamingSeries,
  episodes: readonly NamingEpisode[],
): { kind: EpisodeFormatKind; format: string } {
  if (series.seriesType === 'daily' && (episodes[0]?.seasonNumber ?? 0) > 0) {
    return { kind: 'daily', format: config.dailyEpisodeFormat };
  }
  if (series.seriesType === 'anime' && (allHaveAbsolute(episodes) || !hasAbsolute(config.animeEpisodeFormat))) {
    return { kind: 'anime', format: config.animeEpisodeFormat };
  }
  return { kind: 'standard', format: config.standardEpisodeFormat };
}

const FORMAT_LABEL: Record<EpisodeFormatKind, string> = { standard: 'Standard', daily: 'Daily', anime: 'Anime' };

function limits(extras: NamingExtras, isLast: boolean): number {
  const maxName = extras.maxFileNameBytes ?? DEFAULT_MAX_FILE_NAME_BYTES;
  const maxPath = extras.maxPathBytes ?? DEFAULT_MAX_PATH_BYTES;
  const pathRoom = maxPath - (extras.seasonPath ? byteLength(extras.seasonPath) : 0) - 1;
  return Math.min(maxName, pathRoom) - (isLast && extras.extension ? byteLength(extras.extension) : 0);
}

/**
 * Builds an episode file name (sub-folders joined by `extras.pathSeparator` when the format has
 * slashes). The extension is appended only when `extras.extension` is given.
 */
export function buildEpisodeFileName(
  config: NamingConfig,
  series: NamingSeries,
  episodes: readonly NamingEpisode[],
  file: NamingFile,
  extras: NamingExtras = {},
): string {
  const clean = cleanerFor(config, 'tv');
  if (!config.renameEpisodes) {
    return withExtension(clean(originalTitle(file, true)), extras);
  }
  const sorted = sortEpisodes(episodes);
  const { kind, format } = chooseEpisodeFormat(config, series, sorted);
  if (!format.trim()) throw new NamingFormatError(`${FORMAT_LABEL[kind]} episode format cannot be empty`);

  const useAbsolute = series.seriesType === 'anime' && allHaveAbsolute(sorted);
  const saved = (file.id ?? 0) > 0;
  const components = splitPath(format);
  const rendered = components.map((component, index) => {
    const isLast = index === components.length - 1;
    const airDate = tokensOf(parseFormat(component, { escapes: true })).some(
      (t) => normalizeTokenName(t.name) === 'airdate',
    );
    const fallbackAllowed = !saved || (!hasNumbering(component) && !hasAbsolute(component) && !airDate);

    let pattern = substituteNumbering(component, config.multiEpisodeStyle, sorted);
    pattern = substituteAbsolute(pattern, config.multiEpisodeStyle, sorted, useAbsolute);
    const parts = protectLiteralEllipsis(parseFormat(pattern, { escapes: true }));

    const budget: TitleBudget = { budget: null };
    const h: TokenHandlers = new Map();
    addSeriesTokens(h, series);
    addSeasonTokens(h, sorted[0]?.seasonNumber ?? 0, extras.seasonTitle);
    addEpisodeTokens(h, sorted, budget);
    addFileTokens(h, file, fallbackAllowed, extras.releaseGroupFallback ?? DEFAULT_RELEASE_GROUP);
    addQualityTokens(h, file, series.seriesType === 'anime');
    if (file.mediaInfo) addMediaInfoTokens(h, file.mediaInfo, file.sceneName, false);
    addCustomFormatTokens(h, extras.customFormats ?? []);
    addVersionTokens(h, file);

    const limit = limits(extras, isLast);
    let out = cleanupFileComponent(renderParts(parts, h, clean));
    const hasTitle = tokensOf(parts).some((t) => EPISODE_TITLE_TOKENS.has(normalizeTokenName(t.name)));
    if (hasTitle) {
      let room = limit - byteLength(out);
      for (let attempt = 0; attempt < 4; attempt++) {
        budget.budget = room;
        out = cleanupFileComponent(renderParts(parts, h, clean));
        const over = byteLength(out) - limit;
        if (over <= 0) break;
        room -= over;
      }
    }
    return finalizeComponent(cleanupFileComponent(truncateBytes(out, limit)));
  });
  return withExtension(rendered.filter(Boolean).join(extras.pathSeparator ?? '/'), extras);
}

// ---------------------------------------------------------------------------------------
// Series / season folders
// ---------------------------------------------------------------------------------------

export function buildSeriesFolder(config: NamingConfig, series: NamingSeries, extras: NamingExtras = {}): string {
  const h: TokenHandlers = new Map();
  addSeriesTokens(h, series);
  const rendered = renderParts(parseFormat(config.seriesFolderFormat, { escapes: true }), h, cleanerFor(config, 'tv'));
  const limit = extras.maxFileNameBytes ?? DEFAULT_MAX_FILE_NAME_BYTES;
  return splitPath(rendered)
    .map((seg) => finalizeComponent(cleanupFolderComponent(truncateBytes(cleanupFolderComponent(seg), limit))))
    .filter(Boolean)
    .join(extras.pathSeparator ?? '/');
}

/** Season folder name; season 0 uses the specials format. */
export function buildSeasonFolder(
  config: NamingConfig,
  series: NamingSeries,
  seasonNumber: number,
  extras: NamingExtras = {},
): string {
  const format = seasonNumber === 0 ? config.specialsFolderFormat : config.seasonFolderFormat;
  const clean = cleanerFor(config, 'tv');
  const h: TokenHandlers = new Map();
  addSeriesTokens(h, series);
  addSeasonTokens(h, seasonNumber, extras.seasonTitle);
  const rendered = cleanupFolderComponent(renderParts(parseFormat(format, { escapes: true }), h, clean), true);
  const limit = extras.maxFileNameBytes ?? DEFAULT_MAX_FILE_NAME_BYTES;
  // The folder is one path level: run it through illegal-character cleaning once more (3.1).
  return finalizeComponent(cleanupFolderComponent(truncateBytes(clean(rendered), limit), true));
}

// ---------------------------------------------------------------------------------------
// Movies
// ---------------------------------------------------------------------------------------

function movieHandlers(movie: NamingMovie): TokenHandlers {
  const h: TokenHandlers = new Map();
  addMovieTokens(h, movie);
  return h;
}

/** Movie file name. The extension is appended only when `extras.extension` is given. */
export function buildMovieFileName(
  config: NamingConfig,
  movie: NamingMovie,
  file: NamingFile,
  extras: NamingExtras = {},
): string {
  const clean = cleanerFor(config, 'movie');
  if (!config.renameMovies) return withExtension(clean(originalTitle(file, true)), extras);
  const format = config.movieFormat;
  if (!format.trim()) throw new NamingFormatError('Standard movie format cannot be empty');

  const fallbackAllowed = tokensOf(parseFormat(format, { wrappers: true })).length === 1;
  const h = movieHandlers(movie);
  addFileTokens(h, file, fallbackAllowed, extras.releaseGroupFallback ?? DEFAULT_RELEASE_GROUP);
  addQualityTokens(h, file, false);
  if (file.mediaInfo) addMediaInfoTokens(h, file.mediaInfo, file.sceneName, true);
  addCustomFormatTokens(h, extras.customFormats ?? []);
  addEditionTokens(h, file);
  addVersionTokens(h, file);

  const components = splitPath(format);
  const rendered = components.map((component, index) => {
    const limit = limits(extras, index === components.length - 1);
    const out = cleanupFileComponent(renderParts(parseFormat(component, { wrappers: true }), h, clean));
    return finalizeComponent(cleanupFileComponent(truncateBytes(out, limit)));
  });
  return withExtension(rendered.filter(Boolean).join(extras.pathSeparator ?? '/'), extras);
}

export function buildMovieFolder(config: NamingConfig, movie: NamingMovie, extras: NamingExtras = {}): string {
  const clean = cleanerFor(config, 'movie');
  const h = movieHandlers(movie);
  const limit = extras.maxFileNameBytes ?? DEFAULT_MAX_FILE_NAME_BYTES;
  return splitPath(config.movieFolderFormat)
    .map((seg) => {
      const out = cleanupFolderComponent(renderParts(parseFormat(seg, { wrappers: true }), h, clean));
      return finalizeComponent(cleanupFolderComponent(truncateBytes(out, limit)));
    })
    .filter(Boolean)
    .join(extras.pathSeparator ?? '/');
}

// ---------------------------------------------------------------------------------------
// Music and audiobooks (docs/design/music-audiobooks.md 9.4)
// ---------------------------------------------------------------------------------------

/** Empty `()` / `[]` / `{}` left by a token with no value (`Album ()` when the year is unknown). */
function stripEmptyBrackets(text: string): string {
  return text.replace(/\s*(?:\(\s*\)|\[\s*\]|\{\s*\})/g, '').replace(/ {2,}/g, ' ');
}

function requireFormat(format: string, label: string): void {
  if (!format.trim()) throw new NamingFormatError(`${label} cannot be empty`);
}

function requireToken(format: string, token: string, label: string): void {
  if (!formatHasToken(format, token)) throw new NamingFormatError(`${label} must contain {${token}}`);
}

/** Folder path (one or more levels) from a format, each level cleaned like a movie folder. */
function renderAudioFolder(format: string, h: TokenHandlers, clean: (v: string) => string, extras: NamingExtras): string {
  const limit = extras.maxFileNameBytes ?? DEFAULT_MAX_FILE_NAME_BYTES;
  return splitPath(format)
    .map((seg) => {
      const out = cleanupFolderComponent(stripEmptyBrackets(renderParts(parseFormat(seg, { escapes: true }), h, clean)));
      return finalizeComponent(cleanupFolderComponent(truncateBytes(out, limit)));
    })
    .filter(Boolean)
    .join(extras.pathSeparator ?? '/');
}

/** File name (sub-folders allowed) from a format; the extension is appended when given. */
function renderAudioFile(format: string, h: TokenHandlers, clean: (v: string) => string, extras: NamingExtras): string {
  const components = splitPath(format);
  const rendered = components.map((component, index) => {
    const isLast = index === components.length - 1;
    const tidy = (text: string): string => (isLast ? cleanupFileComponent(text) : cleanupFolderComponent(text));
    const parts = protectLiteralEllipsis(parseFormat(component, { escapes: true }));
    const out = tidy(stripEmptyBrackets(renderParts(parts, h, clean)));
    return finalizeComponent(tidy(truncateBytes(out, limits(extras, isLast))));
  });
  return withExtension(rendered.filter(Boolean).join(extras.pathSeparator ?? '/'), extras);
}

function addAudioFileTokens(h: TokenHandlers, file: NamingFile, extras: NamingExtras, format: string): void {
  const fallbackAllowed = tokensOf(parseFormat(format, { escapes: true })).length === 1;
  addFileTokens(h, file, fallbackAllowed, extras.releaseGroupFallback ?? DEFAULT_RELEASE_GROUP);
  addQualityTokens(h, file, false);
  if (file.mediaInfo) addMediaInfoTokens(h, file.mediaInfo, file.sceneName, false);
  addCustomFormatTokens(h, extras.customFormats ?? []);
}

/** Artist folder name (relative to the music root folder). */
export function buildArtistFolder(config: NamingConfig, artist: NamingArtist, extras: NamingExtras = {}): string {
  requireFormat(config.artistFolderFormat, 'Artist folder format');
  const h: TokenHandlers = new Map();
  addArtistTokens(h, artist);
  return renderAudioFolder(config.artistFolderFormat, h, cleanerFor(config, 'tv'), extras);
}

/** Album folder relative to the artist folder; a `/` in the format makes nested folders. */
export function buildAlbumFolder(
  config: NamingConfig,
  artist: NamingArtist,
  album: NamingAlbum,
  extras: NamingExtras = {},
): string {
  requireFormat(config.albumFolderFormat, 'Album folder format');
  const h: TokenHandlers = new Map();
  addArtistTokens(h, artist);
  addAlbumTokens(h, album);
  return renderAudioFolder(config.albumFolderFormat, h, cleanerFor(config, 'tv'), extras);
}

/** The format a track is named with; the `subfolder` multi-disc style prepends `Disc {medium}/`. */
export function trackFormatFor(config: NamingConfig, mediumCount = 1): string {
  if (mediumCount <= 1) return config.trackFormat;
  return config.multiDiscStyle === 'subfolder' ? `Disc {medium}/${config.trackFormat}` : config.multiDiscTrackFormat;
}

/**
 * Track file name relative to the album folder: `01 - Title`, `1-01 - Title` (multi-disc
 * `prefix`) or `Disc 1/01 - Title` (multi-disc `subfolder`). With `renameTracks` off the
 * original name is kept. The extension is appended only when `extras.extension` is given.
 */
export function buildTrackFileName(
  config: NamingConfig,
  artist: NamingArtist,
  album: NamingAlbum,
  track: NamingTrack,
  file: NamingFile,
  extras: NamingTrackExtras = {},
): string {
  const clean = cleanerFor(config, 'tv');
  if (!config.renameTracks) return withExtension(clean(originalTitle(file, true)), extras);
  const prefixStyle = (extras.mediumCount ?? 1) > 1 && config.multiDiscStyle === 'prefix';
  const base = prefixStyle ? config.multiDiscTrackFormat : config.trackFormat;
  const label = prefixStyle ? 'Multi-disc track format' : 'Track format';
  requireFormat(base, label);
  requireToken(base, 'track', label);
  if (prefixStyle) requireToken(base, 'medium', label);
  const h: TokenHandlers = new Map();
  addArtistTokens(h, artist);
  addAlbumTokens(h, album);
  addTrackTokens(h, track, artist);
  addAudioFileTokens(h, file, extras, base);
  return renderAudioFile(trackFormatFor(config, extras.mediumCount ?? 1), h, clean, extras);
}

/** Author folder name (relative to the audiobook root folder). */
export function buildAuthorFolder(config: NamingConfig, author: NamingAuthor, extras: NamingExtras = {}): string {
  requireFormat(config.authorFolderFormat, 'Author folder format');
  const h: TokenHandlers = new Map();
  addAuthorTokens(h, author);
  return renderAudioFolder(config.authorFolderFormat, h, cleanerFor(config, 'tv'), extras);
}

/**
 * Book folder relative to the author folder: `seriesBookFolderFormat` when the book has a
 * series (`Series/Book 3 - Title`), else `bookFolderFormat`.
 */
export function buildBookFolder(config: NamingConfig, author: NamingAuthor, book: NamingBook, extras: NamingExtras = {}): string {
  const series = Boolean(book.seriesTitle?.trim());
  const format = series ? config.seriesBookFolderFormat : config.bookFolderFormat;
  requireFormat(format, series ? 'Series book folder format' : 'Book folder format');
  const h: TokenHandlers = new Map();
  addAuthorTokens(h, author);
  addBookTokens(h, book);
  return renderAudioFolder(format, h, cleanerFor(config, 'tv'), extras);
}

/**
 * Book file name relative to the book folder: `bookFileFormat` for a single file,
 * `bookPartFormat` (`{Part:00} - Title`) when `extras.partCount` > 1. With `renameAudiobooks`
 * off the original name is kept. The extension is appended only when `extras.extension` is given.
 */
export function buildBookFileName(
  config: NamingConfig,
  author: NamingAuthor,
  book: NamingBook,
  file: NamingFile,
  extras: NamingBookExtras = {},
): string {
  const clean = cleanerFor(config, 'tv');
  if (!config.renameAudiobooks) return withExtension(clean(originalTitle(file, true)), extras);
  const parts = (extras.partCount ?? 1) > 1;
  const format = parts ? config.bookPartFormat : config.bookFileFormat;
  const label = parts ? 'Book part format' : 'Book file format';
  requireFormat(format, label);
  if (parts) requireToken(format, 'part', label);
  const h: TokenHandlers = new Map();
  addAuthorTokens(h, author);
  addBookTokens(h, book);
  addPartTokens(h, extras.part ?? 1);
  addAudioFileTokens(h, file, extras, format);
  return renderAudioFile(format, h, clean, extras);
}

// ---------------------------------------------------------------------------------------
// Predicates (spec 1.2)
// ---------------------------------------------------------------------------------------

/** True when the format that would be used for this series contains an episode-title token. */
export function requiresEpisodeTitle(
  config: NamingConfig,
  series: NamingSeries,
  episodes: readonly NamingEpisode[],
): boolean {
  if (!config.renameEpisodes) return false;
  const { format } = chooseEpisodeFormat(config, series, sortEpisodes(episodes));
  return tokensOf(parseFormat(format, { escapes: true })).some((t) =>
    EPISODE_TITLE_TOKENS.has(normalizeTokenName(t.name)),
  );
}

export function requiresAbsoluteNumber(config: NamingConfig, series: NamingSeries): boolean {
  return config.renameEpisodes && series.seriesType === 'anime' && hasAbsolute(config.animeEpisodeFormat);
}

// ---------------------------------------------------------------------------------------
// Samples (spec section 10)
// ---------------------------------------------------------------------------------------

function sample(render: () => string): NamingSample {
  try {
    return { value: render(), error: null };
  } catch (err) {
    return { value: null, error: err instanceof Error ? err.message : String(err) };
  }
}

/**
 * Renders every format against the canned sample data. Renaming is forced on so the preview
 * shows the formats even while renaming is disabled. No extension is appended.
 */
export function getSamples(config: NamingConfig): NamingSamples {
  const c: NamingConfig = { ...config, renameEpisodes: true, renameMovies: true, renameTracks: true, renameAudiobooks: true };
  const s = SAMPLES;
  return {
    singleEpisode: sample(() => buildEpisodeFileName(c, s.series, [s.episode1], s.file, s.extras)),
    multiEpisode: sample(() => buildEpisodeFileName(c, s.series, s.episodes, s.file, s.extras)),
    dailyEpisode: sample(() => buildEpisodeFileName(c, s.dailySeries, [s.episode1], s.file, s.extras)),
    animeEpisode: sample(() => buildEpisodeFileName(c, s.animeSeries, [s.episode1], s.animeFile, s.extras)),
    animeMultiEpisode: sample(() => buildEpisodeFileName(c, s.animeSeries, s.episodes, s.animeFile, s.extras)),
    seriesFolder: sample(() => buildSeriesFolder(c, s.series)),
    seasonFolder: sample(() => buildSeasonFolder(c, s.series, 1)),
    specialsFolder: sample(() => buildSeasonFolder(c, s.series, 0)),
    movie: sample(() => buildMovieFileName(c, s.movie, s.movieFile, s.extras)),
    movieFolder: sample(() => buildMovieFolder(c, s.movie)),
    artistFolder: sample(() => buildArtistFolder(c, s.artist)),
    albumFolder: sample(() => buildAlbumFolder(c, s.artist, s.album)),
    track: sample(() => buildTrackFileName(c, s.artist, s.album, s.track, s.trackFile)),
    multiDiscTrack: sample(() => buildTrackFileName(c, s.artist, s.album, s.discTrack, s.trackFile, { mediumCount: 2 })),
    authorFolder: sample(() => buildAuthorFolder(c, s.author)),
    bookFolder: sample(() => buildBookFolder(c, s.author, s.book)),
    seriesBookFolder: sample(() => buildBookFolder(c, s.author, s.seriesBook)),
    bookFile: sample(() => buildBookFileName(c, s.author, s.seriesBook, s.bookFile)),
    bookPart: sample(() => buildBookFileName(c, s.author, s.seriesBook, s.bookFile, { part: 1, partCount: 12 })),
  };
}
