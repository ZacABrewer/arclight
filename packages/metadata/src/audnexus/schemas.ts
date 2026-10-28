// Loose Zod schemas for the Audnexus payloads we read. Objects are `.loose()` so new fields pass
// through; Audnexus omits fields it has no data for, so nearly everything is optional.

import { z } from 'zod';

const optString = z.string().nullable().optional();
const optNumber = z.number().nullable().optional();
/** Audnexus sends some numbers (rating, series position) as strings. */
const optNumeric = z.union([z.string(), z.number()]).nullable().optional();

export const anxPersonSchema = z.object({ asin: optString, name: z.string() }).loose();

export const anxGenreSchema = z
  .object({ asin: optString, name: z.string(), type: optString })
  .loose();

export const anxSeriesSchema = z
  .object({ asin: optString, name: z.string(), position: optNumeric })
  .loose();

export const anxBookSchema = z
  .object({
    asin: z.string(),
    title: z.string(),
    subtitle: optString,
    authors: z.array(anxPersonSchema).nullable().optional(),
    narrators: z.array(anxPersonSchema).nullable().optional(),
    copyright: optNumber,
    description: optString,
    summary: optString,
    formatType: optString,
    literatureType: optString,
    genres: z.array(anxGenreSchema).nullable().optional(),
    image: optString,
    isAdult: z.boolean().nullable().optional(),
    isbn: optString,
    language: optString,
    publisherName: optString,
    rating: optNumeric,
    region: optString,
    releaseDate: optString,
    runtimeLengthMin: optNumber,
    seriesPrimary: anxSeriesSchema.nullable().optional(),
    seriesSecondary: anxSeriesSchema.nullable().optional(),
  })
  .loose();
export type AnxBookWire = z.infer<typeof anxBookSchema>;

export const anxChapterSchema = z
  .object({
    title: optString,
    lengthMs: z.number(),
    startOffsetMs: z.number(),
    startOffsetSec: optNumber,
  })
  .loose();

export const anxChaptersSchema = z
  .object({
    asin: z.string(),
    brandIntroDurationMs: optNumber,
    brandOutroDurationMs: optNumber,
    chapters: z.array(anxChapterSchema),
    isAccurate: z.boolean().nullable().optional(),
    region: optString,
    runtimeLengthMs: optNumber,
    runtimeLengthSec: optNumber,
  })
  .loose();
export type AnxChaptersWire = z.infer<typeof anxChaptersSchema>;

export const anxAuthorSchema = z
  .object({
    asin: z.string(),
    name: z.string(),
    description: optString,
    genres: z.array(anxGenreSchema).nullable().optional(),
    image: optString,
    region: optString,
    similar: z.array(anxPersonSchema).nullable().optional(),
  })
  .loose();
export type AnxAuthorWire = z.infer<typeof anxAuthorSchema>;

export const anxAuthorSearchSchema = z.array(anxPersonSchema);
