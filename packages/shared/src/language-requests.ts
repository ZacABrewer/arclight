import { z } from 'zod';
import { AdditionalAudioMode, AdditionalLanguageOutcome, ItemLanguageChip } from './additional-languages.js';
import { MediaType } from './library.js';
import { ListSearchParam } from './list-search.js';
import { PageInfo, RequestStatus, RequestUser } from './requests.js';
import { LanguageProfileFlagMode, SubtitleLanguageOption } from './subtitles.js';

// Subtitle and language requests: a portal user asks for subtitles in a language, or for an
// additional audio language (a dub), on a title that is already in the library. Approval runs
// "Add additional…" (additional-languages.ts) on the item with a search right away. Kept apart
// from `media_requests`: rows live in `language_requests`, keyed on the library item, and never
// count toward media quotas. Behaviour: docs/API.md "Subtitle and language requests".

export const LanguageRequestKind = z.enum(['subtitle', 'audio']);
export type LanguageRequestKind = z.infer<typeof LanguageRequestKind>;

/** Longest note a requester may leave. */
export const LANGUAGE_REQUEST_NOTE_MAX = 500;

export const LanguageRequest = z.object({
  id: z.number().int(),
  kind: LanguageRequestKind,
  status: RequestStatus,
  mediaType: MediaType,
  /** Library ids of the item (no foreign key; the request is failed when the item is deleted). */
  movieId: z.number().int().nullable(),
  seriesId: z.number().int().nullable(),
  /** Series: one season, or null for the whole series. Always null for movies. */
  seasonNumber: z.number().int().nullable(),
  tmdbId: z.number().int(),
  title: z.string(),
  year: z.number().int().nullish(),
  poster: z.string().nullish(),
  /** Normalised IETF-style tag ("es", "pt-BR"). */
  language: z.string(),
  /** English name of the language ("Spanish"); the web may show its own. */
  languageName: z.string(),
  /** Subtitles: forced / hearing-impaired modes, as on a language profile item. */
  forced: LanguageProfileFlagMode,
  hi: LanguageProfileFlagMode,
  /** Audio: replace or version, chosen by the approver (null until approved). */
  mode: AdditionalAudioMode.nullable(),
  note: z.string().nullable(),
  requestedBy: RequestUser,
  modifiedBy: RequestUser.nullable(),
  declineReason: z.string().nullish(),
  failureReason: z.string().nullish(),
  /** Latest "Add additional…" outcome for the item once approved. */
  outcome: AdditionalLanguageOutcome.nullable(),
  outcomeMessage: z.string().nullable(),
  /** The additional-language records the approval created or reused. */
  additionalLanguageIds: z.array(z.number().int()),
  /** The caller may delete this request (own pending request, or MANAGE_REQUESTS). */
  canRemove: z.boolean(),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type LanguageRequest = z.infer<typeof LanguageRequest>;

/**
 * POST /request/language. Needs REQUEST_LANGUAGE (or REQUEST). The title must be in the library
 * with at least one file in the chosen scope.
 */
export const CreateLanguageRequest = z
  .object({
    kind: LanguageRequestKind,
    mediaType: MediaType,
    tmdbId: z.number().int().positive(),
    /** Series only: one season; absent = the whole series. */
    seasonNumber: z.number().int().min(0).optional(),
    /** Any spelling the language list knows ("es", "spa", "Spanish"); stored normalised. */
    language: z.string().trim().min(2).max(64),
    /** Subtitles only. */
    forced: LanguageProfileFlagMode.default('never'),
    hi: LanguageProfileFlagMode.default('also'),
    note: z.string().trim().max(LANGUAGE_REQUEST_NOTE_MAX).optional(),
    /** Request on behalf of another user (MANAGE_USERS or MANAGE_REQUESTS). */
    userId: z.number().int().positive().optional(),
  })
  .refine((r) => r.mediaType === 'series' || r.seasonNumber === undefined, { message: 'seasonNumber applies to series only', path: ['seasonNumber'] });
export type CreateLanguageRequest = z.input<typeof CreateLanguageRequest>;

/** POST /request/language/:id/approve body (optional). */
export const ApproveLanguageRequest = z.object({
  /** Audio requests: replace the file with a multi-audio release (default) or add a version slot. */
  mode: AdditionalAudioMode.optional(),
});
export type ApproveLanguageRequest = z.infer<typeof ApproveLanguageRequest>;

export const LanguageRequestListQuery = z.object({
  take: z.coerce.number().int().min(1).max(500).default(20),
  skip: z.coerce.number().int().min(0).default(0),
  filter: z.enum(['all', 'pending', 'approved', 'declined', 'failed', 'completed']).default('all'),
  kind: z.enum(['all', 'subtitle', 'audio']).default('all'),
  requestedBy: z.coerce.number().int().positive().optional(),
  sortDirection: z.enum(['asc', 'desc']).default('desc'),
  /** Text search (list-search.ts): every word must match. */
  q: ListSearchParam,
});
export type LanguageRequestListQuery = z.input<typeof LanguageRequestListQuery>;

export const LanguageRequestPage = z.object({ pageInfo: PageInfo, results: z.array(LanguageRequest) });
export type LanguageRequestPage = z.infer<typeof LanguageRequestPage>;

export const LanguageRequestCount = z.object({
  total: z.number().int(),
  subtitle: z.number().int(),
  audio: z.number().int(),
  pending: z.number().int(),
});
export type LanguageRequestCount = z.infer<typeof LanguageRequestCount>;

/** GET /request/language/options: one title, by TMDB id. */
export const LanguageRequestOptionsQuery = z.object({
  mediaType: MediaType,
  tmdbId: z.coerce.number().int().positive(),
});
export type LanguageRequestOptionsQuery = z.infer<typeof LanguageRequestOptionsQuery>;

/** An open (pending or approved) language request of the title, without who asked. */
export const OpenLanguageRequest = z.object({
  id: z.number().int(),
  kind: LanguageRequestKind,
  status: RequestStatus,
  seasonNumber: z.number().int().nullable(),
  language: z.string(),
  forced: LanguageProfileFlagMode,
  hi: LanguageProfileFlagMode,
  /** The caller asked for it. */
  mine: z.boolean(),
});
export type OpenLanguageRequest = z.infer<typeof OpenLanguageRequest>;

/** What the request dialog needs to know about a title (portal-safe). */
export const LanguageRequestOptions = z.object({
  /** In the library with at least one file. */
  inLibrary: z.boolean(),
  mediaType: MediaType,
  movieId: z.number().int().nullable(),
  seriesId: z.number().int().nullable(),
  /** Series: seasons with at least one file, ascending. */
  seasons: z.array(z.object({ seasonNumber: z.number().int(), files: z.number().int() })),
  /** Languages the whole item has or was given (subtitle keys: `en`, `en:forced`, `en:hi`). */
  audio: z.array(ItemLanguageChip),
  subtitles: z.array(ItemLanguageChip),
  openRequests: z.array(OpenLanguageRequest),
  /** The caller may request languages (REQUEST_LANGUAGE or REQUEST). */
  canRequest: z.boolean(),
});
export type LanguageRequestOptions = z.infer<typeof LanguageRequestOptions>;

/** GET /request/language/languages: the languages that can be requested (code + English name). */
export const LanguageRequestLanguages = z.array(SubtitleLanguageOption);
export type LanguageRequestLanguages = z.infer<typeof LanguageRequestLanguages>;
