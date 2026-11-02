// Loose Zod schemas for the two keyless ListenBrainz endpoints we read. Objects are `.loose()`
// and nearly every field is optional: the payloads are not versioned.

import { z } from 'zod';

const optString = z.string().nullable().optional();
const optNumber = z.number().nullable().optional();
const optStrings = z.array(z.string()).nullable().optional();

/** One entry of `/1/explore/fresh-releases`. */
export const lbFreshReleaseSchema = z
  .object({
    release_group_mbid: optString,
    release_name: optString,
    release_mbid: optString,
    release_date: optString,
    artist_credit_name: optString,
    artist_mbids: optStrings,
    release_group_primary_type: optString,
    release_group_secondary_type: optString,
    caa_id: optNumber,
    caa_release_mbid: optString,
    listen_count: optNumber,
  })
  .loose();
export type LbFreshReleaseWire = z.infer<typeof lbFreshReleaseSchema>;

export const lbFreshReleasesResponseSchema = z
  .object({
    payload: z.object({ releases: z.array(lbFreshReleaseSchema).nullable().optional() }).loose(),
  })
  .loose();

/** One entry of `/1/stats/sitewide/release-groups`. */
export const lbTopReleaseGroupSchema = z
  .object({
    release_group_mbid: optString,
    release_group_name: optString,
    artist_name: optString,
    artist_mbids: optStrings,
    caa_id: optNumber,
    caa_release_mbid: optString,
    listen_count: optNumber,
  })
  .loose();
export type LbTopReleaseGroupWire = z.infer<typeof lbTopReleaseGroupSchema>;

export const lbTopReleaseGroupsResponseSchema = z
  .object({
    payload: z.object({ release_groups: z.array(lbTopReleaseGroupSchema).nullable().optional() }).loose(),
  })
  .loose();

// ---------------------------------------------------------------------------------------
// Playlists (JSPF) and the labs similar-artists dataset

const jspfExtension = z.record(z.string(), z.unknown()).nullable().optional();

/** One JSPF track. `identifier` is a recording URL (a string or a list of them). */
export const lbJspfTrackSchema = z
  .object({
    title: optString,
    creator: optString,
    album: optString,
    duration: optNumber,
    identifier: z.union([z.string(), z.array(z.string())]).nullable().optional(),
    extension: jspfExtension,
  })
  .loose();
export type LbJspfTrackWire = z.infer<typeof lbJspfTrackSchema>;

export const lbJspfPlaylistSchema = z
  .object({
    title: optString,
    identifier: optString,
    annotation: optString,
    creator: optString,
    date: optString,
    track: z.array(lbJspfTrackSchema).nullable().optional(),
    extension: jspfExtension,
  })
  .loose();
export type LbJspfPlaylistWire = z.infer<typeof lbJspfPlaylistSchema>;

export const lbPlaylistResponseSchema = z.object({ playlist: lbJspfPlaylistSchema }).loose();

export const lbPlaylistListResponseSchema = z
  .object({
    playlists: z.array(z.object({ playlist: lbJspfPlaylistSchema }).loose()).nullable().optional(),
    playlist_count: optNumber,
  })
  .loose();

export const lbSimilarArtistRowSchema = z
  .object({ artist_mbid: optString, name: optString, comment: optString, type: optString, score: optNumber, reference_mbid: optString })
  .loose();
export type LbSimilarArtistRowWire = z.infer<typeof lbSimilarArtistRowSchema>;

/** The labs API answers a list of rows, or (older datasets) a list of `{ data: rows }` blocks. */
export const lbSimilarArtistsResponseSchema = z.array(z.union([z.object({ data: z.array(lbSimilarArtistRowSchema) }).loose(), lbSimilarArtistRowSchema]));
