// Token engine (spec section 2) and the TV / movie token catalogues (sections 5-7).

import {
  ELLIPSIS,
  byteLength,
  cleanTitle,
  truncateBytes,
  firstCharacter,
  formatEdition,
  titleThe,
  titleWithoutYear,
  titleYear,
  trailingYear,
  truncateText,
} from './text.js';
import {
  audioChannelsText,
  audioCodecName,
  bitDepthText,
  dynamicRange,
  dynamicRangeType,
  languageListText,
  resolveLanguage,
  videoCodecName,
} from './media-info.js';
import type {
  NamingAlbum,
  NamingArtist,
  NamingAuthor,
  NamingBook,
  NamingTrack,
  NamingCustomFormat,
  NamingEpisode,
  NamingFile,
  NamingMediaInfo,
  NamingMovie,
  NamingSeries,
  NamingSeriesType,
} from './types.js';

// ---------------------------------------------------------------------------------------
// Parsing
// ---------------------------------------------------------------------------------------

export interface Token {
  kind: 'token';
  /** The original text, braces included. */
  raw: string;
  prefix: string;
  /** Name as written, e.g. `Series.Title`. */
  name: string;
  /** Separator run between the two name words (`''` for one-word names). */
  separator: string;
  modifier: string | undefined;
  suffix: string;
  /** Movie wrapper tag such as `edition-` for `{edition-{Edition Tags}}`. */
  wrapper: string | undefined;
}

export interface Literal {
  kind: 'literal';
  text: string;
}

export type FormatPart = Token | Literal;

export interface ParseOptions {
  /** `{{` / `}}` -> literal braces (TV). */
  escapes?: boolean;
  /** `{tag-{Token}}` wrappers (movies). */
  wrappers?: boolean;
}

const TOKEN_BODY = String.raw`(?<prefix>[- ._\[(]*)(?<name>[a-z0-9]+(?:(?<sep>[- ._]+)[a-z0-9]+)?)(?::(?<mod>[^{}]*?))?(?<suffix>[- ._)\]]*)`;
const TOKEN_RE = new RegExp(String.raw`\{${TOKEN_BODY}\}`, 'iy');
const WRAPPED_RE = new RegExp(String.raw`\{(?<tag>[a-z0-9]+-)\{${TOKEN_BODY}\}\}`, 'iy');

function toToken(m: RegExpExecArray): Token {
  const g = m.groups ?? {};
  return {
    kind: 'token',
    raw: m[0],
    prefix: g['prefix'] ?? '',
    name: g['name'] ?? '',
    separator: g['sep'] ?? '',
    modifier: g['mod'],
    suffix: g['suffix'] ?? '',
    wrapper: g['tag'],
  };
}

export function parseFormat(format: string, options: ParseOptions = {}): FormatPart[] {
  const parts: FormatPart[] = [];
  let literal = '';
  const flush = (): void => {
    if (literal) parts.push({ kind: 'literal', text: literal });
    literal = '';
  };
  let i = 0;
  while (i < format.length) {
    const ch = format[i] ?? '';
    const next = format[i + 1];
    if (options.escapes && (ch === '{' || ch === '}') && next === ch) {
      literal += ch;
      i += 2;
      continue;
    }
    if (ch === '{') {
      let m: RegExpExecArray | null = null;
      if (options.wrappers) {
        WRAPPED_RE.lastIndex = i;
        m = WRAPPED_RE.exec(format);
      }
      if (!m) {
        TOKEN_RE.lastIndex = i;
        m = TOKEN_RE.exec(format);
      }
      if (m) {
        flush();
        parts.push(toToken(m));
        i += m[0].length;
        continue;
      }
    }
    literal += ch;
    i += 1;
  }
  flush();
  return parts;
}

export function tokensOf(parts: readonly FormatPart[]): Token[] {
  return parts.filter((p): p is Token => p.kind === 'token');
}

/** Lookup key: lower-case, non-alphanumerics removed (spec 2.2.1). */
export function normalizeTokenName(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]/g, '');
}

// ---------------------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------------------

export type TokenHandler = (token: Token) => string;
export type TokenHandlers = Map<string, TokenHandler>;

export function register(h: TokenHandlers, names: string | readonly string[], fn: TokenHandler): void {
  for (const n of typeof names === 'string' ? [names] : names) h.set(normalizeTokenName(n), fn);
}

/** Case rule (spec 2.4): all-lower name lower-cases, all-upper upper-cases, mixed leaves alone. */
export function applyCase(name: string, value: string): string {
  const letters = name.replace(/[^\p{L}]/gu, '');
  if (!letters) return value;
  if (letters === letters.toLowerCase()) return value.toLowerCase();
  if (letters === letters.toUpperCase()) return value.toUpperCase();
  return value;
}

export function renderParts(
  parts: readonly FormatPart[],
  handlers: TokenHandlers,
  clean: (value: string) => string,
): string {
  let out = '';
  for (const part of parts) {
    if (part.kind === 'literal') {
      out += part.text;
      continue;
    }
    const handler = handlers.get(normalizeTokenName(part.name));
    let value = handler ? handler(part) : '';
    // Illegal-character cleaning runs before the separator rule so a colon's replacement text is
    // itself separated: `{Movie.Title}` of "The Movie: Title" -> `The.Movie.-.Title` (spec 6.7).
    value = clean(applyCase(part.name, value.trim()));
    const sep = part.separator.trim();
    if (sep) value = value.replaceAll(' ', sep);
    if (!value.trim()) continue;
    const body = part.prefix + value + part.suffix;
    out += part.wrapper ? `{${part.wrapper}${body}}` : body;
  }
  return out;
}

/** Replaces literal `...` in pattern text with the protected ellipsis (spec 2.5.3). */
export function protectLiteralEllipsis(parts: FormatPart[]): FormatPart[] {
  return parts.map((p) => (p.kind === 'literal' ? { ...p, text: p.text.replaceAll('...', ELLIPSIS) } : p));
}

/** Zero padding from a modifier made of zeros (spec 2.5.4). */
export function padNumber(n: number, modifier: string | undefined): string {
  const width = modifier && /^0+$/.test(modifier) ? modifier.length : 0;
  return String(n).padStart(width, '0');
}

const text = (h: TokenHandlers, names: string | readonly string[], value: () => string): void =>
  register(h, names, (t) => truncateText(value(), t.modifier));
const plain = (h: TokenHandlers, names: string | readonly string[], value: () => string): void =>
  register(h, names, () => value());
const positiveId = (n: number | null | undefined): string => (n && n > 0 ? String(n) : '');

// ---------------------------------------------------------------------------------------
// TV catalogue
// ---------------------------------------------------------------------------------------

const SERIES_TYPE_LABEL: Record<NamingSeriesType, string> = {
  standard: 'Standard',
  daily: 'Daily',
  anime: 'Anime',
};

export function addSeriesTokens(h: TokenHandlers, series: NamingSeries): void {
  const title = series.title ?? '';
  const base = titleWithoutYear(title);
  const year = trailingYear(title) ?? (series.year ? String(series.year) : '');
  const withParenYear = (s: string): string => (year ? `${s} (${year})` : s);
  const withBareYear = (s: string): string => (year ? `${s} ${year}` : s);

  text(h, 'Series Title', () => title);
  text(h, 'Series CleanTitle', () => cleanTitle(title));
  text(h, 'Series TitleYear', () => titleYear(title, series.year));
  text(h, 'Series CleanTitleYear', () => cleanTitle(titleYear(title, series.year)));
  text(h, 'Series TitleWithoutYear', () => base);
  text(h, 'Series CleanTitleWithoutYear', () => cleanTitle(base));
  text(h, 'Series TitleThe', () => titleThe(title));
  text(h, 'Series CleanTitleThe', () => titleThe(cleanTitle(title)));
  text(h, 'Series TitleTheYear', () => withParenYear(titleThe(base)));
  text(h, 'Series CleanTitleTheYear', () => withBareYear(titleThe(cleanTitle(base))));
  text(h, 'Series TitleTheWithoutYear', () => titleThe(base));
  text(h, 'Series CleanTitleTheWithoutYear', () => titleThe(cleanTitle(base)));
  plain(h, 'Series TitleFirstCharacter', () => firstCharacter(titleThe(title)));
  plain(h, 'Series Year', () => (series.year ? String(series.year) : ''));
  plain(h, 'Series Type', () => SERIES_TYPE_LABEL[series.seriesType] ?? '');
  plain(h, 'ImdbId', () => series.imdbId ?? '');
  plain(h, 'TvdbId', () => positiveId(series.tvdbId));
  plain(h, 'TmdbId', () => positiveId(series.tmdbId));
  plain(h, 'TvMazeId', () => positiveId(series.tvMazeId));
}

export function addSeasonTokens(h: TokenHandlers, seasonNumber: number, seasonTitle: string | undefined): void {
  register(h, 'season', (t) => padNumber(seasonNumber, t.modifier));
  text(h, 'Season Title', () => seasonTitle ?? '');
  text(h, 'Season CleanTitle', () => cleanTitle(seasonTitle ?? ''));
}

const trimEpisodeTitle = (s: string): string => s.replace(/[\s.?]+$/, '');
const MULTIPART = /(?:\s*\(\d+\)|(?:\s*:)?\s*\b(?:part|pt\.?)\s*\d+)$/i;

/** Titles for one or several episodes (spec 4.8.1, 4.8.2). */
export function episodeTitles(episodes: readonly NamingEpisode[]): string[] {
  const trimmed = episodes.map((e) => trimEpisodeTitle(e.title ?? ''));
  if (trimmed.length <= 1) return trimmed.filter((t) => t.trim());
  const dedupe = (list: string[]): string[] => [...new Set(list.filter((t) => t.trim()))];
  const stripped = dedupe(trimmed.map((t) => trimEpisodeTitle(t.replace(MULTIPART, ''))));
  return stripped.length ? stripped : dedupe(trimmed);
}

/** Fits joined titles into a UTF-8 byte budget (spec 4.8.6). */
export function fitTitles(titles: readonly string[], joiner: string, budget: number): string {
  const joined = titles.join(joiner);
  if (byteLength(joined) <= budget) return joined;
  const first = titles[0] ?? '';
  const firstTrim = first.replace(/[ .]+$/, '');
  if (titles.length >= 2) {
    const firstLast = firstTrim + ELLIPSIS + (titles[titles.length - 1] ?? '');
    if (byteLength(firstLast) <= budget) return firstLast;
    if (byteLength(firstTrim + ELLIPSIS) <= budget) return firstTrim + ELLIPSIS;
  }
  return truncateBytes(first, budget);
}

/** `null` budget = first (measuring) pass: titles render empty. */
export interface TitleBudget {
  budget: number | null;
}

export function addEpisodeTokens(
  h: TokenHandlers,
  episodes: readonly NamingEpisode[],
  titleBudget: TitleBudget,
): void {
  const first = episodes[0];
  const last = episodes[episodes.length - 1];
  register(h, 'episode', (t) => {
    if (!first || !last) return '';
    const a = padNumber(first.episodeNumber, t.modifier);
    return episodes.length > 1 ? `${a}-${padNumber(last.episodeNumber, t.modifier)}` : a;
  });
  plain(h, 'Air Date', () => {
    const d = first?.airDate?.trim();
    return d ? d.replaceAll('-', ' ') : 'Unknown';
  });
  const titles = episodeTitles(episodes);
  const titleToken =
    (list: readonly string[], joiner: string): TokenHandler =>
    (t) => {
      if (titleBudget.budget === null) return '';
      const fitted = fitTitles(list, joiner, titleBudget.budget - byteLength(t.prefix + t.suffix));
      return truncateText(fitted, t.modifier);
    };
  register(h, 'Episode Title', titleToken(titles, ' + '));
  register(h, 'Episode CleanTitle', titleToken(titles.map(cleanTitle), ' and '));
}

export const EPISODE_TITLE_TOKENS: ReadonlySet<string> = new Set(['episodetitle', 'episodecleantitle']);

// ---------------------------------------------------------------------------------------
// Quality, media-info, custom formats, file tokens (shared, section 7)
// ---------------------------------------------------------------------------------------

export function addQualityTokens(h: TokenHandlers, file: NamingFile, animeVersions: boolean): void {
  const q = file.quality;
  const title = q ? (q.quality.title ?? q.quality.name) : '';
  const version = q?.revision.version ?? 1;
  const proper = q && version > 1 ? (animeVersions ? `v${version}` : 'Proper') : '';
  const real = q && q.revision.real > 0 ? 'REAL' : '';
  plain(h, 'Quality Title', () => title);
  plain(h, 'Quality Proper', () => proper);
  plain(h, 'Quality Real', () => real);
  plain(h, 'Quality Full', () => [title, proper, real].filter(Boolean).join(' '));
}

export function addMediaInfoTokens(
  h: TokenHandlers,
  info: NamingMediaInfo,
  sceneName: string | null | undefined,
  includeMultiView: boolean,
): void {
  const video = (): string => videoCodecName(info, sceneName);
  const audio = (): string => audioCodecName(info);
  plain(h, ['MediaInfo Video', 'MediaInfo VideoCodec'], video);
  plain(h, 'MediaInfo VideoBitDepth', () => bitDepthText(info));
  plain(h, 'MediaInfo VideoDynamicRange', () => dynamicRange(info));
  plain(h, 'MediaInfo VideoDynamicRangeType', () => dynamicRangeType(info));
  plain(h, ['MediaInfo Audio', 'MediaInfo AudioCodec'], audio);
  plain(h, 'MediaInfo AudioChannels', () => audioChannelsText(info));
  register(h, 'MediaInfo AudioLanguages', (t) => languageListText(info.audioLanguages, t.modifier, true));
  register(h, 'MediaInfo AudioLanguagesAll', (t) => languageListText(info.audioLanguages, t.modifier, false));
  register(h, ['MediaInfo SubtitleLanguages', 'MediaInfo SubtitleLanguagesAll'], (t) =>
    languageListText(info.subtitles, t.modifier, false),
  );
  plain(h, 'MediaInfo Simple', () => [video(), audio()].filter(Boolean).join(' '));
  register(h, 'MediaInfo Full', (t) =>
    [
      video(),
      audio(),
      languageListText(info.audioLanguages, t.modifier, true),
      languageListText(info.subtitles, t.modifier, false),
    ]
      .filter(Boolean)
      .join(' '),
  );
  if (includeMultiView) plain(h, 'MediaInfo 3D', () => ((info.videoMultiViewCount ?? 0) > 1 ? '3D' : ''));
}

export function addCustomFormatTokens(h: TokenHandlers, formats: readonly NamingCustomFormat[]): void {
  const included = formats.filter((f) => f.includeInRenaming).map((f) => f.name);
  register(h, 'Custom Formats', (t) => {
    const mod = (t.modifier ?? '').trim();
    if (!mod) return included.join(' ');
    const exclude = mod.startsWith('-');
    const names = (exclude ? mod.slice(1) : mod).split(',').map((s) => s.trim()).filter(Boolean);
    return included.filter((n) => names.includes(n) !== exclude).join(' ');
  });
  register(h, 'Custom Format', (t) => {
    const name = (t.modifier ?? '').trim();
    return name && included.includes(name) ? name : '';
  });
}

function baseName(path: string | null | undefined): string {
  const last = (path ?? '').split(/[\\/]/).pop() ?? '';
  const dot = last.lastIndexOf('.');
  return dot > 0 ? last.slice(0, dot) : last;
}

/** The current file name without extension (relative path preferred). */
export function currentFileName(file: NamingFile): string {
  return baseName(file.relativePath || file.path);
}

/** Original title (spec 8.1) before illegal-character cleaning. */
export function originalTitle(file: NamingFile, fallbackAllowed: boolean): string {
  const scene = file.sceneName?.trim();
  if (scene) return scene;
  return fallbackAllowed ? currentFileName(file) : '';
}

export function addFileTokens(
  h: TokenHandlers,
  file: NamingFile,
  fallbackAllowed: boolean,
  releaseGroupFallback: string,
): void {
  text(h, 'Original Title', () => originalTitle(file, fallbackAllowed));
  plain(h, 'Original Filename', () => (fallbackAllowed ? currentFileName(file) : ''));
  register(h, 'Release Group', (t) => {
    const group = file.releaseGroup?.trim();
    if (group) return truncateText(group, t.modifier);
    return t.prefix || t.suffix ? '' : releaseGroupFallback;
  });
  plain(h, 'Release Hash', () => file.releaseHash ?? '');
}

// ---------------------------------------------------------------------------------------
// Movie catalogue (section 6)
// ---------------------------------------------------------------------------------------

const LANGUAGE_MODIFIER = /^[a-z]{2,3}(\|[a-z]{2,3})*$/i;

/** Translated title for a `de|fr` modifier: the first recognised code decides (spec 6.2). */
export function translatedTitle(movie: NamingMovie, modifier: string | undefined): string {
  if (!modifier || !LANGUAGE_MODIFIER.test(modifier)) return movie.title;
  for (const code of modifier.split('|')) {
    const lang = resolveLanguage(code);
    if (!lang) continue;
    const hit = (movie.translations ?? []).find((t) => resolveLanguage(t.language) === lang && t.title.trim());
    return hit ? hit.title : movie.title;
  }
  return movie.title;
}

const movieTitleToken =
  (movie: NamingMovie, transform: (s: string) => string): TokenHandler =>
  (t) => {
    if (t.modifier && LANGUAGE_MODIFIER.test(t.modifier)) return transform(translatedTitle(movie, t.modifier));
    return truncateText(transform(movie.title), t.modifier);
  };

export function addMovieTokens(h: TokenHandlers, movie: NamingMovie): void {
  const title = movie.title ?? '';
  const original = movie.originalTitle ?? '';
  const collection = movie.collection?.title ?? '';
  register(h, 'Movie Title', movieTitleToken(movie, (s) => s));
  register(h, 'Movie CleanTitle', movieTitleToken(movie, cleanTitle));
  text(h, 'Movie TitleThe', () => titleThe(title));
  text(h, 'Movie CleanTitleThe', () => titleThe(cleanTitle(title)));
  plain(h, 'Movie TitleFirstCharacter', () => firstCharacter(titleThe(title)));
  text(h, 'Movie OriginalTitle', () => original);
  text(h, 'Movie CleanOriginalTitle', () => cleanTitle(original));
  plain(h, 'Movie Certification', () => movie.certification ?? '');
  text(h, 'Movie Collection', () => collection);
  text(h, 'Movie CollectionThe', () => titleThe(collection));
  text(h, 'Movie CleanCollectionThe', () => titleThe(cleanTitle(collection)));
  plain(h, 'Release Year', () => (movie.year ? String(movie.year) : ''));
  plain(h, 'ImdbId', () => movie.imdbId ?? '');
  plain(h, 'TmdbId', () => positiveId(movie.tmdbId));
}

export function addEditionTokens(h: TokenHandlers, file: NamingFile): void {
  const edition = file.edition?.trim();
  if (edition) text(h, 'Edition Tags', () => formatEdition(edition));
}

/** `{Version}`: the multi-version slot of the file; empty (and dropped with its prefix) when unversioned. */
export function addVersionTokens(h: TokenHandlers, file: NamingFile): void {
  text(h, 'Version', () => file.versionTag?.trim() ?? '');
}

/** Whether a format uses `{Version}` anywhere. */
export function hasVersionToken(format: string): boolean {
  return tokensOf(parseFormat(format, { wrappers: true, escapes: true })).some((t) => normalizeTokenName(t.name) === 'version');
}

// ---------------------------------------------------------------------------------------
// Music catalogue (docs/design/music-audiobooks.md 9.4)
// ---------------------------------------------------------------------------------------

/** Year from a `YYYY[-MM[-DD]]` date, else the explicit year, else ''. */
export function releaseYearOf(date: string | null | undefined, year: number | null | undefined): string {
  const m = /^(\d{4})/.exec(date?.trim() ?? '');
  if (m?.[1] && m[1] !== '0000') return m[1];
  return year && year > 0 ? String(year) : '';
}

export function addArtistTokens(h: TokenHandlers, artist: NamingArtist): void {
  const name = artist.name ?? '';
  text(h, 'Artist Name', () => name);
  text(h, 'Artist CleanName', () => cleanTitle(name));
  text(h, 'Artist NameThe', () => titleThe(name));
  text(h, 'Artist CleanNameThe', () => titleThe(cleanTitle(name)));
  plain(h, 'Artist NameFirstCharacter', () => firstCharacter(titleThe(name)));
  text(h, 'Artist Disambiguation', () => artist.disambiguation ?? '');
  plain(h, 'Artist MbId', () => artist.mbArtistId ?? '');
}

export function addAlbumTokens(h: TokenHandlers, album: NamingAlbum): void {
  const title = album.title ?? '';
  text(h, 'Album Title', () => title);
  text(h, 'Album CleanTitle', () => cleanTitle(title));
  text(h, 'Album TitleThe', () => titleThe(title));
  text(h, 'Album CleanTitleThe', () => titleThe(cleanTitle(title)));
  plain(h, 'Album Type', () => album.albumType?.trim() ?? '');
  text(h, 'Album Disambiguation', () => album.disambiguation ?? '');
  plain(h, 'Album MbId', () => album.mbReleaseGroupId ?? '');
  plain(h, ['Release Year', 'Album ReleaseYear'], () => releaseYearOf(album.releaseDate, album.year));
}

export function addMediumTokens(h: TokenHandlers, mediumNumber: number): void {
  register(h, 'medium', (t) => padNumber(mediumNumber, t.modifier));
}

export function addTrackTokens(h: TokenHandlers, track: NamingTrack, albumArtist: NamingArtist): void {
  const title = track.title ?? '';
  const trackArtist = track.artistName?.trim() || albumArtist.name;
  addMediumTokens(h, track.mediumNumber ?? 1);
  register(h, 'track', (t) => padNumber(track.trackNumber, t.modifier));
  text(h, 'Track Title', () => title);
  text(h, 'Track CleanTitle', () => cleanTitle(title));
  text(h, 'Track ArtistName', () => trackArtist);
  text(h, 'Track ArtistCleanName', () => cleanTitle(trackArtist));
}

// ---------------------------------------------------------------------------------------
// Audiobook catalogue (docs/design/music-audiobooks.md 9.4)
// ---------------------------------------------------------------------------------------

export function addAuthorTokens(h: TokenHandlers, author: NamingAuthor): void {
  const name = author.name ?? '';
  text(h, 'Author Name', () => name);
  text(h, 'Author CleanName', () => cleanTitle(name));
  text(h, 'Author NameThe', () => titleThe(name));
  plain(h, 'Author NameFirstCharacter', () => firstCharacter(titleThe(name)));
}

/** Series position text: integers take a zero-padding modifier, anything else is kept as is. */
export function seriesPositionText(position: string | number | null | undefined, modifier: string | undefined): string {
  if (position === null || position === undefined) return '';
  const raw = String(position).trim();
  if (/^\d+$/.test(raw)) return padNumber(Number(raw), modifier);
  // `3.5` -> pad the integer part only.
  const m = /^(\d+)(\.\d+)$/.exec(raw);
  if (m?.[1] && m[2]) return padNumber(Number(m[1]), modifier) + m[2];
  return raw;
}

export function addBookTokens(h: TokenHandlers, book: NamingBook): void {
  const title = book.title ?? '';
  const narrators = (book.narrators ?? []).map((n) => n.trim()).filter(Boolean);
  text(h, 'Book Title', () => title);
  text(h, 'Book CleanTitle', () => cleanTitle(title));
  text(h, 'Book TitleThe', () => titleThe(title));
  text(h, 'Book Subtitle', () => book.subtitle ?? '');
  text(h, 'Series Title', () => book.seriesTitle ?? '');
  text(h, 'Series CleanTitle', () => cleanTitle(book.seriesTitle ?? ''));
  register(h, 'Series Position', (t) => seriesPositionText(book.seriesPosition, t.modifier));
  text(h, 'Narrator', () => narrators[0] ?? '');
  text(h, 'Narrators', () => narrators.join(', '));
  plain(h, 'Release Year', () => releaseYearOf(book.releaseDate, book.year));
}

export function addPartTokens(h: TokenHandlers, part: number): void {
  register(h, 'part', (t) => padNumber(part, t.modifier));
}
