import { z } from 'zod';
import { MediaType, VersionTag } from './library.js';
import { LanguageProfileFlagMode } from './subtitles.js';

// "Add additional…": add an audio or subtitle language to library items without losing what
// they already have. Language codes are the IETF-style tags the subtitles layer uses ("en",
// "es", "pt-BR"); ffprobe's ISO 639-2 audio tags ("spa") are normalised to them.
//
// Subtitle languages become item-level extras merged with the item's language profile (the
// shared profile is not edited). Audio languages become required audio languages: either the
// item's file is replaced by a release that carries the current languages plus the new one
// (`replace`), or a separate version slot is added for that language (`version`). Audio tracks
// from different releases are never merged into one file.

const isoDate = () => z.string().describe('ISO-8601 timestamp');

export const AdditionalLanguageKind = z.enum(['audio', 'subtitle']);
export type AdditionalLanguageKind = z.infer<typeof AdditionalLanguageKind>;

/** replace: find a release with every current language plus the new one; version: a separate version slot. */
export const AdditionalAudioMode = z.enum(['replace', 'version']);
export type AdditionalAudioMode = z.infer<typeof AdditionalAudioMode>;

/** One item: a movie, or a series (optionally narrowed to one season or some episodes). */
export const AdditionalLanguageTarget = z
  .object({
    movieId: z.number().int().positive().optional(),
    seriesId: z.number().int().positive().optional(),
    seasonNumber: z.number().int().min(0).optional(),
    episodeIds: z.array(z.number().int().positive()).max(1000).optional(),
  })
  .refine((t) => (t.movieId !== undefined) !== (t.seriesId !== undefined), { message: 'exactly one of movieId or seriesId is required' })
  .refine((t) => t.movieId === undefined || (t.seasonNumber === undefined && !t.episodeIds?.length), {
    message: 'seasonNumber and episodeIds apply to series only',
  });
export type AdditionalLanguageTarget = z.infer<typeof AdditionalLanguageTarget>;

/** A subtitle language to add, with the same forced/HI modes as a language profile item. */
export const AdditionalSubtitleLanguage = z.object({
  code: z.string().trim().min(2).max(16),
  forced: LanguageProfileFlagMode.default('never'),
  hi: LanguageProfileFlagMode.default('also'),
});
export type AdditionalSubtitleLanguage = z.infer<typeof AdditionalSubtitleLanguage>;

const targets = () => z.array(AdditionalLanguageTarget).min(1).max(500);

export const AdditionalSubtitleRequest = z.object({
  kind: z.literal('subtitle'),
  targets: targets(),
  languages: z.array(AdditionalSubtitleLanguage).min(1).max(20),
  /** Search providers right away (through a task that shows in Activity). Default true. */
  searchNow: z.boolean().default(true),
  /** When no provider has one, generate it with Whisper (needs a configured whisperai provider). */
  useWhisper: z.boolean().default(false),
});
export type AdditionalSubtitleRequest = z.infer<typeof AdditionalSubtitleRequest>;

export const AdditionalAudioRequest = z.object({
  kind: z.literal('audio'),
  targets: targets(),
  language: z.string().trim().min(2).max(16),
  mode: AdditionalAudioMode.default('replace'),
  /** Version mode: slot name; default the language's English name ("Spanish"). */
  versionTag: VersionTag.optional(),
  /** Version mode: quality profile of the new slot; default the item's profile. */
  qualityProfileId: z.number().int().optional(),
  /** Search for a release right away (through a task that shows in Activity). Default true. */
  searchNow: z.boolean().default(true),
});
export type AdditionalAudioRequest = z.infer<typeof AdditionalAudioRequest>;

/** POST /additional-language and /additional-language/preview */
export const AdditionalLanguageRequest = z.discriminatedUnion('kind', [AdditionalSubtitleRequest, AdditionalAudioRequest]);
export type AdditionalLanguageRequest = z.infer<typeof AdditionalLanguageRequest>;
/** The request as sent (defaults optional). */
export type AdditionalLanguageRequestInput = z.input<typeof AdditionalLanguageRequest>;

/**
 * Where an item stands. Preview: alreadyPresent, noFile, willSearch, willAddVersion, saved.
 * After applying: alreadyPresent, noFile, found, grabbed, notFound, searching, versionAdded,
 * saved (no search was asked for), failed.
 */
export const AdditionalLanguageOutcome = z.enum([
  'alreadyPresent',
  'noFile',
  'willSearch',
  'willAddVersion',
  'saved',
  'found',
  'grabbed',
  'notFound',
  'searching',
  'versionAdded',
  'failed',
]);
export type AdditionalLanguageOutcome = z.infer<typeof AdditionalLanguageOutcome>;

/** One requested subtitle language of one item. */
export const AdditionalSubtitleOutcome = z.object({
  language: z.string(),
  forced: z.boolean(),
  hi: z.boolean(),
  outcome: AdditionalLanguageOutcome,
});
export type AdditionalSubtitleOutcome = z.infer<typeof AdditionalSubtitleOutcome>;

export const AdditionalLanguageItemResult = z.object({
  /** Stable key of the item: `movie:1`, `series:2`, `series:2:s1`, `series:2:e7,8`. */
  key: z.string(),
  mediaType: MediaType,
  movieId: z.number().int().nullable(),
  seriesId: z.number().int().nullable(),
  seasonNumber: z.number().int().nullable(),
  episodeIds: z.array(z.number().int()),
  title: z.string(),
  outcome: AdditionalLanguageOutcome,
  /** Plain-language sentence for the row (English; the web maps `outcome` to its own strings). */
  message: z.string(),
  /** Media files of the item that the action looks at. */
  files: z.number().int(),
  /** Audio languages on the item's files now (normalised tags); empty when not analysed. */
  currentAudio: z.array(z.string()),
  /** Files whose audio has not been analysed yet. */
  unanalysedFiles: z.number().int(),
  /** Subtitle languages present now, as `en`, `en:forced`, `en:hi`. */
  currentSubtitles: z.array(z.string()),
  /** Audio, replace mode: languages a replacement release must carry. */
  requiredAudio: z.array(z.string()),
  /** Audio, version mode: the slot added or reused. */
  versionTag: z.string().nullable(),
  /** Subtitle requests: per language. */
  subtitles: z.array(AdditionalSubtitleOutcome),
});
export type AdditionalLanguageItemResult = z.infer<typeof AdditionalLanguageItemResult>;

export const AdditionalLanguageResult = z.object({
  kind: AdditionalLanguageKind,
  /** False for a preview. */
  applied: z.boolean(),
  items: z.array(AdditionalLanguageItemResult),
  /** A whisperai provider is set up (enabled or not) and has no config error. */
  whisperAvailable: z.boolean(),
  /** The Activity task that runs the searches; null when nothing was searched. */
  jobId: z.number().int().nullable(),
  message: z.string(),
});
export type AdditionalLanguageResult = z.infer<typeof AdditionalLanguageResult>;

/** A saved additional language (what future searches and upgrades honour). */
export const AdditionalLanguageRecord = z.object({
  id: z.number().int(),
  kind: AdditionalLanguageKind,
  mediaType: MediaType,
  movieId: z.number().int().nullable(),
  seriesId: z.number().int().nullable(),
  /** Series scope narrowed to a season; null = whole series. */
  seasonNumber: z.number().int().nullable(),
  /** Series scope narrowed to one episode; null = whole series / season. */
  episodeId: z.number().int().nullable(),
  language: z.string(),
  forced: LanguageProfileFlagMode,
  hi: LanguageProfileFlagMode,
  mode: AdditionalAudioMode.nullable(),
  versionTag: z.string().nullable(),
  /** Latest outcome. */
  status: AdditionalLanguageOutcome,
  message: z.string(),
  createdAt: isoDate(),
  updatedAt: isoDate(),
});
export type AdditionalLanguageRecord = z.infer<typeof AdditionalLanguageRecord>;

/** GET /additional-language: one item (movie, or series optionally narrowed). */
export const ItemLanguagesQuery = z
  .object({
    movieId: z.coerce.number().int().positive().optional(),
    seriesId: z.coerce.number().int().positive().optional(),
    seasonNumber: z.coerce.number().int().min(0).optional(),
    episodeId: z.coerce.number().int().positive().optional(),
  })
  .refine((q) => (q.movieId !== undefined) !== (q.seriesId !== undefined), { message: 'exactly one of movieId or seriesId is required' });
export type ItemLanguagesQuery = z.infer<typeof ItemLanguagesQuery>;

export const ItemLanguageChip = z.object({
  /** Normalised tag; subtitles use the `en`, `en:forced`, `en:hi` key. */
  language: z.string(),
  /** On at least one file now. */
  present: z.boolean(),
  /** Asked for with "Add additional…" (a saved record applies to the item). */
  added: z.boolean(),
});
export type ItemLanguageChip = z.infer<typeof ItemLanguageChip>;

export const ItemLanguages = z.object({
  audio: z.array(ItemLanguageChip),
  subtitles: z.array(ItemLanguageChip),
  /** Saved records that apply to the item (series-wide, the season, or its episodes). */
  records: z.array(AdditionalLanguageRecord),
});
export type ItemLanguages = z.infer<typeof ItemLanguages>;

export const AdditionalLanguageErrorResponse = z.object({ error: z.string(), code: z.string().optional() });
export type AdditionalLanguageErrorResponse = z.infer<typeof AdditionalLanguageErrorResponse>;
