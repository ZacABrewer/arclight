import { z } from 'zod';

// Naming configuration contract (one per installation) and the preview-sample response.
// Behaviour: docs/spec/naming.md. Defaults are the upstream defaults (spec 1.1.2 / 1.1.3) so
// "reset to default" restores them; Arclight may choose to seed rename on at install time.

/**
 * How a `:` inside a token value is replaced (spec 3.2). `custom` uses
 * `customColonReplacement` and applies to series/episode names only; movies treat it as `smart`.
 * When "replace illegal characters" is off, colons are always removed.
 */
export const ColonReplacement = z.enum(['delete', 'dash', 'spaceDash', 'spaceDashSpace', 'smart', 'custom']);
export type ColonReplacement = z.infer<typeof ColonReplacement>;

/** How several episodes in one file are numbered (spec 4.5). */
export const MultiEpisodeStyle = z.enum(['extend', 'duplicate', 'repeat', 'scene', 'range', 'prefixedRange']);
export type MultiEpisodeStyle = z.infer<typeof MultiEpisodeStyle>;

export const DEFAULT_NAMING_FORMATS = {
  standardEpisodeFormat: '{Series Title} - S{season:00}E{episode:00} - {Episode Title} {Quality Full}',
  dailyEpisodeFormat: '{Series Title} - {Air-Date} - {Episode Title} {Quality Full}',
  animeEpisodeFormat: '{Series Title} - S{season:00}E{episode:00} - {Episode Title} {Quality Full}',
  seriesFolderFormat: '{Series Title}',
  seasonFolderFormat: 'Season {season}',
  specialsFolderFormat: 'Specials',
  movieFormat: '{Movie Title} ({Release Year}) {Quality Full}',
  movieFolderFormat: '{Movie Title} ({Release Year})',
  artistFolderFormat: '{Artist Name}',
  albumFolderFormat: '{Album Title} ({Release Year})',
  trackFormat: '{track:00} - {Track Title}',
  multiDiscTrackFormat: '{medium:0}-{track:00} - {Track Title}',
  authorFolderFormat: '{Author Name}',
  seriesBookFolderFormat: '{Series Title}/Book {Series Position} - {Book Title}',
  bookFolderFormat: '{Book Title}',
  bookFileFormat: '{Book Title}',
  bookPartFormat: '{Part:00} - {Book Title}',
} as const;

/**
 * Albums with more than one medium: `prefix` names files with `multiDiscTrackFormat`
 * (`1-01 - Title`), `subfolder` puts each disc in `Disc {medium}/` and names files with
 * `trackFormat`.
 */
export const MultiDiscStyle = z.enum(['prefix', 'subfolder']);
export type MultiDiscStyle = z.infer<typeof MultiDiscStyle>;

/** True when `format` contains `{name}` or `{name:<zeros>}` (any case, spaces allowed). */
export function formatHasToken(format: string, name: string): boolean {
  return new RegExp(String.raw`\{\s*${name}\s*(?::0*)?\s*\}`, 'i').test(format);
}

const nonEmpty = (label: string) => z.string().refine((s) => s.trim().length > 0, { message: `${label} cannot be empty` });
const withTokens = (label: string, tokens: readonly string[]) =>
  nonEmpty(label).refine((s) => tokens.every((t) => formatHasToken(s, t)), {
    message: `${label} must contain ${tokens.map((t) => `{${t}}`).join(' and ')}`,
  });

const ILLEGAL_IN_COLON_TEXT = /[:\\/<>?*|"]/;

export const NamingConfig = z.object({
  renameEpisodes: z.boolean().default(false),
  renameMovies: z.boolean().default(false),
  replaceIllegalCharacters: z.boolean().default(true),
  colonReplacement: ColonReplacement.default('smart'),
  customColonReplacement: z
    .string()
    .refine((s) => !ILLEGAL_IN_COLON_TEXT.test(s), {
      message: 'Must not contain a colon or any of \\ / < > ? * | "',
    })
    .optional(),
  multiEpisodeStyle: MultiEpisodeStyle.default('prefixedRange'),
  standardEpisodeFormat: z.string().default(DEFAULT_NAMING_FORMATS.standardEpisodeFormat),
  dailyEpisodeFormat: z.string().default(DEFAULT_NAMING_FORMATS.dailyEpisodeFormat),
  animeEpisodeFormat: z.string().default(DEFAULT_NAMING_FORMATS.animeEpisodeFormat),
  seriesFolderFormat: z.string().default(DEFAULT_NAMING_FORMATS.seriesFolderFormat),
  seasonFolderFormat: z.string().default(DEFAULT_NAMING_FORMATS.seasonFolderFormat),
  specialsFolderFormat: z.string().default(DEFAULT_NAMING_FORMATS.specialsFolderFormat),
  movieFormat: z.string().default(DEFAULT_NAMING_FORMATS.movieFormat),
  movieFolderFormat: z.string().default(DEFAULT_NAMING_FORMATS.movieFolderFormat),
  /**
   * Multi-version items: `sideBySide` (default) keeps every version in the item's folder and
   * appends ` - <tag>` when the format has no `{Version}` token; `subfolder` puts each version
   * in a `<tag>` sub-folder of the series/season or movie folder.
   */
  versionLayout: z.enum(['sideBySide', 'subfolder']).optional(),

  // ---- music (docs/design/music-audiobooks.md 9.4) ----
  renameTracks: z.boolean().default(false),
  artistFolderFormat: nonEmpty('Artist folder format').default(DEFAULT_NAMING_FORMATS.artistFolderFormat),
  albumFolderFormat: nonEmpty('Album folder format').default(DEFAULT_NAMING_FORMATS.albumFolderFormat),
  trackFormat: withTokens('Track format', ['track']).default(DEFAULT_NAMING_FORMATS.trackFormat),
  multiDiscTrackFormat: withTokens('Multi-disc track format', ['medium', 'track']).default(
    DEFAULT_NAMING_FORMATS.multiDiscTrackFormat,
  ),
  multiDiscStyle: MultiDiscStyle.default('prefix'),

  // ---- audiobooks ----
  renameAudiobooks: z.boolean().default(false),
  authorFolderFormat: nonEmpty('Author folder format').default(DEFAULT_NAMING_FORMATS.authorFolderFormat),
  seriesBookFolderFormat: nonEmpty('Series book folder format').default(DEFAULT_NAMING_FORMATS.seriesBookFolderFormat),
  bookFolderFormat: nonEmpty('Book folder format').default(DEFAULT_NAMING_FORMATS.bookFolderFormat),
  bookFileFormat: nonEmpty('Book file format').default(DEFAULT_NAMING_FORMATS.bookFileFormat),
  bookPartFormat: withTokens('Book part format', ['part']).default(DEFAULT_NAMING_FORMATS.bookPartFormat),
});
export type NamingConfig = z.infer<typeof NamingConfig>;
export type NamingConfigInput = z.input<typeof NamingConfig>;

/** The upstream defaults, fully populated. */
export const NAMING_DEFAULTS: NamingConfig = NamingConfig.parse({});

/** One rendered preview: the name, or the error that rendering it raised. */
export const NamingSample = z.object({
  value: z.string().nullable(),
  error: z.string().nullable(),
});
export type NamingSample = z.infer<typeof NamingSample>;

/** Preview of every format against the canned sample data (spec section 10). */
export const NamingSamples = z.object({
  singleEpisode: NamingSample,
  multiEpisode: NamingSample,
  dailyEpisode: NamingSample,
  animeEpisode: NamingSample,
  animeMultiEpisode: NamingSample,
  seriesFolder: NamingSample,
  seasonFolder: NamingSample,
  specialsFolder: NamingSample,
  movie: NamingSample,
  movieFolder: NamingSample,
  // Music and audiobooks (docs/design/music-audiobooks.md 9.4).
  artistFolder: NamingSample,
  albumFolder: NamingSample,
  track: NamingSample,
  multiDiscTrack: NamingSample,
  authorFolder: NamingSample,
  bookFolder: NamingSample,
  seriesBookFolder: NamingSample,
  bookFile: NamingSample,
  bookPart: NamingSample,
});
export type NamingSamples = z.infer<typeof NamingSamples>;
