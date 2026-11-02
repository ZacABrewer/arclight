// Recording lookups for playlist matching: by recording MBID, by ISRC and by title + artist
// search. Wire schemas and mapping live here (not in ./schemas.ts / ./map.ts) so the playlist
// work stays in one place; the client methods are in ./client.ts.

import { z } from 'zod';
import { mapArtistCredits, yearOf } from './map.js';
import { mbArtistCreditSchema } from './schemas.js';
import type { MbArtistCredit } from './types.js';

const optString = z.string().nullable().optional();
const optNumber = z.number().nullable().optional();

export const mbRecordingReleaseSchema = z
  .object({
    id: z.string(),
    title: optString,
    status: optString,
    date: optString,
    country: optString,
    'release-group': z
      .object({
        id: z.string(),
        title: optString,
        'primary-type': optString,
        'secondary-types': z.array(z.string()).nullable().optional(),
        'first-release-date': optString,
      })
      .loose()
      .nullable()
      .optional(),
  })
  .loose();

export const mbRecordingSchema = z
  .object({
    id: z.string(),
    title: z.string(),
    length: optNumber,
    score: optNumber,
    video: z.boolean().nullable().optional(),
    'first-release-date': optString,
    'artist-credit': z.array(mbArtistCreditSchema).nullable().optional(),
    releases: z.array(mbRecordingReleaseSchema).nullable().optional(),
    isrcs: z.array(z.string()).nullable().optional(),
  })
  .loose();
export type MbRecordingWire = z.infer<typeof mbRecordingSchema>;

export const mbRecordingSearchSchema = z
  .object({ count: z.number(), offset: z.number(), recordings: z.array(mbRecordingSchema) })
  .loose();

export const mbIsrcSchema = z.object({ isrc: optString, recordings: z.array(mbRecordingSchema).nullable().optional() }).loose();

export interface MbRecordingReleaseGroup {
  mbid: string;
  title: string;
  primaryType?: string;
  secondaryTypes: string[];
  firstReleaseDate?: string;
  year?: number;
}

export interface MbRecordingRelease {
  mbid: string;
  title: string;
  status?: string;
  date?: string;
  country?: string;
  releaseGroup?: MbRecordingReleaseGroup;
}

export interface MbRecording {
  mbid: string;
  title: string;
  durationMs?: number;
  firstReleaseDate?: string;
  artistCredits: MbArtistCredit[];
  isrcs: string[];
  /** The releases the recording appears on (lookups ask for release groups too). */
  releases: MbRecordingRelease[];
  /** Search relevance 0-100; search results only. */
  score?: number;
}

function text(value: string | null | undefined): string | undefined {
  const t = value?.trim();
  return t ? t : undefined;
}

export function mapRecording(wire: MbRecordingWire): MbRecording {
  const releases = (wire.releases ?? []).map((r): MbRecordingRelease => {
    const rg = r['release-group'];
    const title = text(r.title) ?? '';
    const status = text(r.status);
    const date = text(r.date);
    const country = text(r.country);
    let releaseGroup: MbRecordingReleaseGroup | undefined;
    if (rg) {
      const primaryType = text(rg['primary-type']);
      const firstReleaseDate = text(rg['first-release-date']);
      const year = yearOf(firstReleaseDate);
      releaseGroup = {
        mbid: rg.id.toLowerCase(),
        title: text(rg.title) ?? title,
        ...(primaryType ? { primaryType } : {}),
        secondaryTypes: rg['secondary-types'] ?? [],
        ...(firstReleaseDate ? { firstReleaseDate } : {}),
        ...(year !== undefined ? { year } : {}),
      };
    }
    return {
      mbid: r.id.toLowerCase(),
      title,
      ...(status ? { status } : {}),
      ...(date ? { date } : {}),
      ...(country ? { country } : {}),
      ...(releaseGroup ? { releaseGroup } : {}),
    };
  });
  const firstReleaseDate = text(wire['first-release-date']);
  return {
    mbid: wire.id.toLowerCase(),
    title: wire.title,
    ...(typeof wire.length === 'number' && wire.length > 0 ? { durationMs: Math.round(wire.length) } : {}),
    ...(firstReleaseDate ? { firstReleaseDate } : {}),
    artistCredits: mapArtistCredits(wire['artist-credit']),
    isrcs: (wire.isrcs ?? []).map((i) => i.toUpperCase()),
    releases,
    ...(typeof wire.score === 'number' ? { score: wire.score } : {}),
  };
}
