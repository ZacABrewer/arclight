import type { ColonReplacement, MultiEpisodeStyle, NamingConfig } from '@media-tron/shared';
import { normalizeTokenName } from '@media-tron/organizer';
import { bool, int, str, type ForeignRow } from '../foreign-db.js';
import type { ArrApp } from './quality.js';

// Naming config. The token vocabulary is the one users know from the *arr apps, so formats
// carry over unchanged; tokens Media-Tron's organizer does not know are removed from the
// format (so renaming keeps working) and reported.

/** Normalised names (lower-case, separators dropped) of every token the organizer renders. */
const KNOWN_TOKENS = new Set(
  [
    'Series Title', 'Series CleanTitle', 'Series TitleYear', 'Series CleanTitleYear', 'Series TitleWithoutYear',
    'Series CleanTitleWithoutYear', 'Series TitleThe', 'Series CleanTitleThe', 'Series TitleTheYear', 'Series CleanTitleTheYear',
    'Series TitleTheWithoutYear', 'Series CleanTitleTheWithoutYear', 'Series TitleFirstCharacter', 'Series Year', 'Series Type',
    'ImdbId', 'TvdbId', 'TmdbId', 'TvMazeId',
    'season', 'episode', 'absolute', 'Season Title', 'Season CleanTitle',
    'Air Date', 'Episode Title', 'Episode CleanTitle',
    'Quality Title', 'Quality Proper', 'Quality Real', 'Quality Full',
    'MediaInfo Simple', 'MediaInfo Full', 'MediaInfo Video', 'MediaInfo VideoCodec', 'MediaInfo VideoBitDepth',
    'MediaInfo VideoDynamicRange', 'MediaInfo VideoDynamicRangeType', 'MediaInfo Audio', 'MediaInfo AudioCodec',
    'MediaInfo AudioChannels', 'MediaInfo AudioLanguages', 'MediaInfo AudioLanguagesAll', 'MediaInfo SubtitleLanguages',
    'MediaInfo SubtitleLanguagesAll', 'MediaInfo 3D',
    'Custom Formats', 'Custom Format', 'Original Title', 'Original Filename', 'Release Group', 'Release Hash',
    'Movie Title', 'Movie CleanTitle', 'Movie TitleThe', 'Movie CleanTitleThe', 'Movie TitleFirstCharacter',
    'Movie OriginalTitle', 'Movie CleanOriginalTitle', 'Movie Certification', 'Movie Collection', 'Movie CollectionThe',
    'Movie CleanCollectionThe', 'Release Year', 'Edition Tags',
  ].map(normalizeTokenName),
);

/** Upstream spellings that mean one of our tokens. */
const TOKEN_ALIASES: Record<string, string> = {
  imdbid: 'ImdbId',
  'imdb id': 'ImdbId',
  'tmdb id': 'TmdbId',
  'tvdb id': 'TvdbId',
  'movie year': 'Release Year',
};

export interface TokenCheck {
  format: string;
  removed: string[];
}

/** Name part of a token body: strip prefix/suffix separators and any `:modifier`. */
function tokenName(body: string): string {
  const withoutMod = body.split(':')[0] ?? body;
  return withoutMod.replace(/^[-. _[(]+/, '').replace(/[-. _)\]]+$/, '');
}

/**
 * Remove tokens the organizer cannot render. Innermost `{...}` groups are tokens; wrappers
 * such as `{edition-{Edition Tags}}` keep their inner token and are dropped with it.
 */
export function translateFormat(format: string): TokenCheck {
  const removed: string[] = [];
  let out = format.replace(/\{([^{}]*)\}/g, (whole, body: string) => {
    if (body.startsWith('{') || body === '') return whole;
    const name = tokenName(body);
    const alias = TOKEN_ALIASES[name.toLowerCase()];
    if (KNOWN_TOKENS.has(normalizeTokenName(name))) return whole;
    if (alias) return whole.replace(name, alias);
    removed.push(whole);
    return '';
  });
  // A wrapper left empty by a removed inner token (`{edition-}`) goes too.
  out = out.replace(/\{[a-z0-9]+-\}/gi, '');
  return { format: out.replace(/\s{2,}/g, ' ').trim(), removed };
}

const MULTI_EPISODE: Record<number, MultiEpisodeStyle> = {
  0: 'extend',
  1: 'duplicate',
  2: 'repeat',
  3: 'scene',
  4: 'range',
  5: 'prefixedRange',
};

const COLON: Record<number, ColonReplacement> = {
  0: 'delete',
  1: 'dash',
  2: 'spaceDash',
  3: 'spaceDashSpace',
  4: 'smart',
  5: 'custom',
};

export interface NamingMapResult {
  values: Partial<NamingConfig>;
  untranslatable: string[];
}

/** A NamingConfig row → the naming fields this app owns. */
export function mapNamingConfig(app: ArrApp, row: ForeignRow): NamingMapResult {
  const values: Partial<NamingConfig> = {};
  const untranslatable: string[] = [];
  const fmt = (key: keyof NamingConfig, raw: unknown) => {
    const s = str(raw);
    if (s === null || s.trim() === '') return;
    const t = translateFormat(s);
    for (const r of t.removed) untranslatable.push(`${key}: ${r}`);
    (values as Record<string, unknown>)[key] = t.format;
  };

  const colon = int(row['colonreplacementformat']);
  if (colon !== null && COLON[colon]) values.colonReplacement = COLON[colon];
  const custom = str(row['customcolonreplacementformat']);
  if (custom) values.customColonReplacement = custom;
  if (row['replaceillegalcharacters'] !== undefined) values.replaceIllegalCharacters = bool(row['replaceillegalcharacters'], true);

  if (app === 'sonarr') {
    if (row['renameepisodes'] !== undefined) values.renameEpisodes = bool(row['renameepisodes']);
    const multi = int(row['multiepisodestyle']);
    if (multi !== null && MULTI_EPISODE[multi]) values.multiEpisodeStyle = MULTI_EPISODE[multi];
    fmt('standardEpisodeFormat', row['standardepisodeformat']);
    fmt('dailyEpisodeFormat', row['dailyepisodeformat']);
    fmt('animeEpisodeFormat', row['animeepisodeformat']);
    fmt('seriesFolderFormat', row['seriesfolderformat']);
    fmt('seasonFolderFormat', row['seasonfolderformat']);
    fmt('specialsFolderFormat', row['specialsfolderformat']);
  } else {
    // Radarr kept the old `RenameEpisodes` column name for "rename movies" in early schemas.
    const rename = row['renamemovies'] ?? row['renameepisodes'];
    if (rename !== undefined) values.renameMovies = bool(rename);
    // Radarr's colon enum has no `custom`; 4 is smart there as well.
    fmt('movieFormat', row['standardmovieformat']);
    fmt('movieFolderFormat', row['moviefolderformat']);
  }
  return { values, untranslatable };
}
