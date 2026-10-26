// Pure mappers for the Phase 4 title-page extras (credits, similar, recommendations, videos,
// keywords), people and companies. No I/O.

import type { z } from 'zod';
import type { CompanyRef, CreditPerson, PersonCredit, PersonMetadata, SearchResult, TitleExtras, VideoRef } from '../types.js';
import { mapMovieSearchItem, mapTvSearchItem, toIsoDate, type ImageUrlBuilder } from './map.js';
import {
  tmdbMovieSearchItemSchema,
  tmdbTvSearchItemSchema,
  type TmdbMovieExtras,
  type TmdbPerson,
  type TmdbTvExtras,
  type tmdbCreditsSchema,
  type tmdbVideoSchema,
} from './schemas.js';

type Credits = z.infer<typeof tmdbCreditsSchema>;
type Video = z.infer<typeof tmdbVideoSchema>;

const MAX_CAST = 30;
const MAX_CREW = 30;
/** Crew jobs worth showing on a title page, in display priority. */
const KEY_JOBS = ['Director', 'Creator', 'Screenplay', 'Writer', 'Novel', 'Story', 'Producer', 'Executive Producer', 'Original Music Composer', 'Director of Photography'];

function opt<K extends string, V>(key: K, value: V | null | undefined): { [P in K]?: V } {
  return value === null || value === undefined || value === '' ? {} : ({ [key]: value } as { [P in K]: V });
}

export function mapCredits(credits: Credits | undefined, images: ImageUrlBuilder): { cast: CreditPerson[]; crew: CreditPerson[] } {
  if (!credits) return { cast: [], crew: [] };
  const cast = [...credits.cast]
    .sort((a, b) => (a.order ?? 999) - (b.order ?? 999))
    .slice(0, MAX_CAST)
    .map((c) => ({
      tmdbId: c.id,
      name: c.name,
      ...opt('character', c.character),
      ...opt('profile', images('profile', c.profile_path)),
    }));
  const rank = (job: string | null | undefined): number => {
    const i = KEY_JOBS.indexOf(job ?? '');
    return i === -1 ? KEY_JOBS.length : i;
  };
  const seen = new Set<string>();
  const crew = [...credits.crew]
    .filter((c) => c.job)
    .sort((a, b) => rank(a.job) - rank(b.job))
    .filter((c) => {
      const key = `${c.id}|${c.job}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .slice(0, MAX_CREW)
    .map((c) => ({
      tmdbId: c.id,
      name: c.name,
      job: c.job ?? '',
      ...opt('department', c.department),
      ...opt('profile', images('profile', c.profile_path)),
    }));
  return { cast, crew };
}

/** YouTube and Vimeo videos, trailers first, official before fan uploads. */
export function mapVideos(videos: Video[] | undefined): VideoRef[] {
  if (!videos) return [];
  const known = videos.filter((v) => ['youtube', 'vimeo'].includes(v.site.toLowerCase()));
  const rank = (v: Video): number => {
    const type = (v.type ?? '').toLowerCase();
    return (type === 'trailer' ? 0 : type === 'teaser' ? 1 : 2) * 2 + (v.official ? 0 : 1);
  };
  return [...known].sort((a, b) => rank(a) - rank(b)).map((v) => ({
    name: typeof v['name'] === 'string' ? (v['name'] as string) : (v.type ?? 'Video'),
    key: v.key,
    site: v.site,
    type: v.type ?? 'Video',
  }));
}

function mapCompanies(items: { id: number; name: string; logo_path?: string | null | undefined }[] | undefined, images: ImageUrlBuilder): CompanyRef[] {
  return (items ?? []).map((c) => ({ tmdbId: c.id, name: c.name, ...opt('logo', images('logo', c.logo_path)) }));
}

export function mapMovieExtras(raw: TmdbMovieExtras, images: ImageUrlBuilder): TitleExtras {
  return {
    tmdbId: raw.id,
    mediaType: 'movie',
    ...opt('tagline', raw.tagline),
    genres: (raw.genres ?? []).map((g) => ({ tmdbId: g.id, name: g.name })),
    keywords: (raw.keywords?.keywords ?? []).map((k) => ({ tmdbId: k.id, name: k.name })),
    companies: mapCompanies(raw.production_companies, images),
    ...mapCredits(raw.credits, images),
    videos: mapVideos(raw.videos?.results),
    similar: (raw.similar?.results ?? []).map((i) => mapMovieSearchItem(i, images)),
    recommendations: (raw.recommendations?.results ?? []).map((i) => mapMovieSearchItem(i, images)),
  };
}

export function mapTvExtras(raw: TmdbTvExtras, images: ImageUrlBuilder): TitleExtras {
  return {
    tmdbId: raw.id,
    mediaType: 'series',
    ...opt('tagline', raw.tagline),
    genres: (raw.genres ?? []).map((g) => ({ tmdbId: g.id, name: g.name })),
    keywords: (raw.keywords?.results ?? []).map((k) => ({ tmdbId: k.id, name: k.name })),
    companies: mapCompanies(raw.networks, images),
    ...mapCredits(raw.credits, images),
    videos: mapVideos(raw.videos?.results),
    similar: (raw.similar?.results ?? []).map((i) => mapTvSearchItem(i, images)),
    recommendations: (raw.recommendations?.results ?? []).map((i) => mapTvSearchItem(i, images)),
  };
}

function creditFrom(row: Record<string, unknown>, images: ImageUrlBuilder): SearchResult | null {
  if (row['media_type'] === 'movie') {
    const parsed = tmdbMovieSearchItemSchema.safeParse(row);
    return parsed.success ? mapMovieSearchItem(parsed.data, images) : null;
  }
  if (row['media_type'] === 'tv') {
    const parsed = tmdbTvSearchItemSchema.safeParse(row);
    return parsed.success ? mapTvSearchItem(parsed.data, images) : null;
  }
  return null;
}

function releaseOf(r: SearchResult): string {
  return (r.mediaType === 'movie' ? r.releaseDate : r.firstAired) ?? '';
}

/** Person details; credits de-duplicated per title (crew jobs joined) and newest first. */
export function mapPerson(raw: TmdbPerson, images: ImageUrlBuilder): PersonMetadata {
  const cast = new Map<string, PersonCredit>();
  for (const row of raw.combined_credits?.cast ?? []) {
    const base = creditFrom(row, images);
    if (!base) continue;
    const key = `${base.mediaType}:${base.tmdbId}`;
    if (cast.has(key)) continue;
    const character = typeof row['character'] === 'string' && row['character'] ? (row['character'] as string) : undefined;
    cast.set(key, { ...base, ...(character ? { character } : {}) });
  }
  const crew = new Map<string, PersonCredit>();
  for (const row of raw.combined_credits?.crew ?? []) {
    const base = creditFrom(row, images);
    if (!base) continue;
    const key = `${base.mediaType}:${base.tmdbId}`;
    const job = typeof row['job'] === 'string' ? (row['job'] as string) : undefined;
    const existing = crew.get(key);
    if (existing) {
      if (job && existing.job && !existing.job.split(', ').includes(job)) existing.job = `${existing.job}, ${job}`;
      continue;
    }
    crew.set(key, { ...base, ...(job ? { job } : {}) });
  }
  const byDate = (a: PersonCredit, b: PersonCredit) => releaseOf(b).localeCompare(releaseOf(a));
  return {
    tmdbId: raw.id,
    name: raw.name,
    biography: raw.biography ?? '',
    ...opt('birthday', toIsoDate(raw.birthday)),
    ...opt('deathday', toIsoDate(raw.deathday)),
    ...opt('placeOfBirth', raw.place_of_birth),
    ...opt('knownForDepartment', raw.known_for_department),
    ...opt('profile', images('profile', raw.profile_path)),
    cast: [...cast.values()].sort(byDate),
    crew: [...crew.values()].sort(byDate),
  };
}
