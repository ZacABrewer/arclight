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
