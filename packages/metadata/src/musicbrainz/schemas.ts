// Loose Zod schemas for the MusicBrainz WS/2 JSON payloads we read. Objects are `.loose()`
// so new fields pass through; only fields the mapper reads are declared, and MusicBrainz
// nulls freely, so most are nullable/optional.

import { z } from 'zod';

const optString = z.string().nullable().optional();
const optNumber = z.number().nullable().optional();

export const mbLifeSpanSchema = z
  .object({ begin: optString, end: optString, ended: z.boolean().nullable().optional() })
  .loose();

export const mbAreaSchema = z.object({ name: optString }).loose();

export const mbAliasSchema = z
  .object({
    name: z.string(),
    'sort-name': optString,
    locale: optString,
    primary: z.boolean().nullable().optional(),
    type: optString,
  })
  .loose();

export const mbGenreSchema = z.object({ name: z.string(), count: optNumber }).loose();

export const mbRelationSchema = z
  .object({
    type: z.string(),
    'target-type': optString,
    url: z.object({ resource: z.string() }).loose().nullable().optional(),
  })
  .loose();

export const mbArtistSchema = z
  .object({
    id: z.string(),
    name: z.string(),
    'sort-name': optString,
    disambiguation: optString,
    type: optString,
    country: optString,
    area: mbAreaSchema.nullable().optional(),
    'life-span': mbLifeSpanSchema.nullable().optional(),
    aliases: z.array(mbAliasSchema).nullable().optional(),
    genres: z.array(mbGenreSchema).nullable().optional(),
    relations: z.array(mbRelationSchema).nullable().optional(),
    score: optNumber,
  })
  .loose();
export type MbArtistWire = z.infer<typeof mbArtistSchema>;

export const mbArtistSearchSchema = z
  .object({ count: z.number(), offset: z.number(), artists: z.array(mbArtistSchema) })
  .loose();

export const mbArtistCreditSchema = z
  .object({
    name: z.string(),
    joinphrase: optString,
    artist: z.object({ id: z.string(), name: z.string() }).loose(),
  })
  .loose();
export type MbArtistCreditWire = z.infer<typeof mbArtistCreditSchema>;

export const mbReleaseGroupSchema = z
  .object({
    id: z.string(),
    title: z.string(),
    disambiguation: optString,
    'primary-type': optString,
    'secondary-types': z.array(z.string()).nullable().optional(),
    'first-release-date': optString,
    score: optNumber,
    'artist-credit': z.array(mbArtistCreditSchema).nullable().optional(),
    /** Only with `inc=genres` (release-group lookup). */
    genres: z.array(mbGenreSchema).nullable().optional(),
  })
  .loose();
export type MbReleaseGroupWire = z.infer<typeof mbReleaseGroupSchema>;

export const mbReleaseGroupBrowseSchema = z
  .object({
    'release-group-count': z.number(),
    'release-group-offset': z.number(),
    'release-groups': z.array(mbReleaseGroupSchema),
  })
  .loose();

export const mbReleaseGroupSearchSchema = z
  .object({
    count: z.number(),
    offset: z.number(),
    'release-groups': z.array(mbReleaseGroupSchema),
  })
  .loose();

export const mbTrackSchema = z
  .object({
    id: z.string(),
    number: optString,
    position: optNumber,
    title: z.string(),
    length: optNumber,
    recording: z
      .object({ id: z.string(), title: optString, length: optNumber })
      .loose(),
    'artist-credit': z.array(mbArtistCreditSchema).nullable().optional(),
  })
  .loose();
export type MbTrackWire = z.infer<typeof mbTrackSchema>;

export const mbMediumSchema = z
  .object({
    position: optNumber,
    format: optString,
    title: optString,
    'track-count': z.number(),
    tracks: z.array(mbTrackSchema).nullable().optional(),
  })
  .loose();
export type MbMediumWire = z.infer<typeof mbMediumSchema>;

export const mbLabelInfoSchema = z
  .object({
    'catalog-number': optString,
    label: z.object({ id: z.string(), name: z.string() }).loose().nullable().optional(),
  })
  .loose();

export const mbReleaseSchema = z
  .object({
    id: z.string(),
    title: z.string(),
    status: optString,
    country: optString,
    date: optString,
    disambiguation: optString,
    barcode: optString,
    media: z.array(mbMediumSchema).nullable().optional(),
    'label-info': z.array(mbLabelInfoSchema).nullable().optional(),
    'artist-credit': z.array(mbArtistCreditSchema).nullable().optional(),
    'release-group': z.object({ id: z.string() }).loose().nullable().optional(),
  })
  .loose();
export type MbReleaseWire = z.infer<typeof mbReleaseSchema>;

export const mbReleaseBrowseSchema = z
  .object({
    'release-count': z.number(),
    'release-offset': z.number(),
    releases: z.array(mbReleaseSchema),
  })
  .loose();
