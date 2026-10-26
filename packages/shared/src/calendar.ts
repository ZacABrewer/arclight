import { z } from 'zod';
import { Episode, MediaFile, MediaImage, MovieStatus, SeriesStatus } from './library.js';

// Calendar contract: upcoming/recent episodes by air date and movies by release date.
// Dates are ISO-8601. An episode's `date` is its UTC air time when known, else its air date
// (YYYY-MM-DD); a movie's `date` is the release date of its `releaseKind`.

export const CalendarReleaseKind = z.enum(['cinema', 'digital', 'physical']);
export type CalendarReleaseKind = z.infer<typeof CalendarReleaseKind>;

export const CalendarSeriesSummary = z.object({
  id: z.number().int(),
  tmdbId: z.number().int(),
  tvdbId: z.number().int().nullish(),
  title: z.string(),
  year: z.number().int(),
  status: SeriesStatus,
  network: z.string().nullish(),
  runtimeMinutes: z.number().int().nullish(),
  monitored: z.boolean(),
  images: z.array(MediaImage),
  tags: z.array(z.number().int()),
  path: z.string(),
  qualityProfileId: z.number().int(),
});
export type CalendarSeriesSummary = z.infer<typeof CalendarSeriesSummary>;

export const CalendarMovieSummary = z.object({
  id: z.number().int(),
  tmdbId: z.number().int(),
  imdbId: z.string().nullish(),
  title: z.string(),
  year: z.number().int(),
  overview: z.string(),
  status: MovieStatus,
  studio: z.string().nullish(),
  certification: z.string().nullish(),
  runtimeMinutes: z.number().int().nullish(),
  inCinemas: z.string().nullish(),
  digitalRelease: z.string().nullish(),
  physicalRelease: z.string().nullish(),
  monitored: z.boolean(),
  hasFile: z.boolean(),
  images: z.array(MediaImage),
  tags: z.array(z.number().int()),
  qualityProfileId: z.number().int(),
});
export type CalendarMovieSummary = z.infer<typeof CalendarMovieSummary>;

export const CalendarEpisodeItem = z.object({
  type: z.literal('episode'),
  date: z.string(),
  seriesId: z.number().int(),
  seriesTitle: z.string(),
  episode: Episode,
  /** Present when the query asked for `includeSeries`. */
  series: CalendarSeriesSummary.optional(),
  /** Present when the query asked for `includeEpisodeFile` and the episode has a file. */
  episodeFile: MediaFile.optional(),
});
export type CalendarEpisodeItem = z.infer<typeof CalendarEpisodeItem>;

export const CalendarMovieItem = z.object({
  type: z.literal('movie'),
  date: z.string(),
  releaseKind: CalendarReleaseKind,
  movie: CalendarMovieSummary,
});
export type CalendarMovieItem = z.infer<typeof CalendarMovieItem>;

export const CalendarItem = z.discriminatedUnion('type', [CalendarEpisodeItem, CalendarMovieItem]);
export type CalendarItem = z.infer<typeof CalendarItem>;

/** Query-string boolean: accepts true/false/1/0 (and real booleans from typed callers). */
const qsBool = (fallback: boolean) =>
  z
    .union([z.boolean(), z.stringbool()])
    .optional()
    .transform((v) => v ?? fallback);

/** Comma-separated tag ids (`tags=1,2`) or an array of ids. */
const qsTags = z
  .union([z.string(), z.array(z.union([z.string(), z.number()]))])
  .optional()
  .transform((v, ctx) => {
    if (v === undefined) return [] as number[];
    const parts = (Array.isArray(v) ? v.map(String) : v.split(',')).map((s) => s.trim()).filter((s) => s !== '');
    const ids = parts.map(Number);
    if (ids.some((n) => !Number.isInteger(n))) {
      ctx.addIssue({ code: 'custom', message: 'tags must be a comma-separated list of integer ids' });
      return z.NEVER;
    }
    return ids;
  });

const isoDateOrTime = z
  .string()
  .refine((s) => !Number.isNaN(Date.parse(s)), { message: 'must be an ISO-8601 date or timestamp' });

/** GET /calendar. Defaults: start = today 00:00 UTC, end = start + 7 days. Both inclusive. */
export const CalendarQuery = z.object({
  start: isoDateOrTime.optional(),
  end: isoDateOrTime.optional(),
  unmonitored: qsBool(false),
  includeSeries: qsBool(false),
  includeEpisodeFile: qsBool(false),
  tags: qsTags,
});
export type CalendarQuery = z.infer<typeof CalendarQuery>;
export type CalendarQueryInput = z.input<typeof CalendarQuery>;

/** GET /calendar/feed.ics. */
export const CalendarFeedQuery = z.object({
  token: z.string().optional(),
  tags: qsTags,
  unmonitored: qsBool(false),
  pastDays: z.coerce.number().int().min(0).max(3650).default(7),
  futureDays: z.coerce.number().int().min(0).max(3650).default(28),
});
export type CalendarFeedQuery = z.infer<typeof CalendarFeedQuery>;

/** GET /calendar/feed: where the iCal feed lives (path includes the install token). */
export const CalendarFeedInfo = z.object({
  path: z.string(),
  token: z.string(),
});
export type CalendarFeedInfo = z.infer<typeof CalendarFeedInfo>;

export const CalendarErrorResponse = z.object({ error: z.string(), code: z.string().optional() });
export type CalendarErrorResponse = z.infer<typeof CalendarErrorResponse>;
