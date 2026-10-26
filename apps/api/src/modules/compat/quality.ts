import { PROFILE_LANGUAGES, qualityById, type QualityModel, type QualitySource } from '@arclight/shared';
import type { Json } from './common.js';

// Quality and language vocabulary translated to the upstream wire format. Quality ids and
// names are already shared with the *arr ecosystem (packages/shared/src/quality.ts); only the
// `source` spelling differs between Sonarr and Radarr.

export type Flavor = 'sonarr' | 'radarr';

const SONARR_SOURCE: Record<QualitySource, string> = {
  unknown: 'unknown',
  cam: 'unknown',
  telesync: 'unknown',
  telecine: 'unknown',
  workprint: 'unknown',
  dvd: 'dvd',
  television: 'television',
  televisionRaw: 'televisionRaw',
  web: 'web',
  webRip: 'webRip',
  bluray: 'bluray',
  blurayRaw: 'blurayRaw',
};

const RADARR_SOURCE: Record<QualitySource, string> = {
  unknown: 'unknown',
  cam: 'cam',
  telesync: 'telesync',
  telecine: 'telecine',
  workprint: 'workprint',
  dvd: 'dvd',
  television: 'tv',
  televisionRaw: 'tv',
  web: 'webdl',
  webRip: 'webrip',
  bluray: 'bluray',
  blurayRaw: 'bluray',
};

/** Sonarr's QualitySource enum values (custom-format `SourceSpecification`). */
export const SONARR_SOURCE_INT: Record<string, number> = {
  unknown: 0,
  television: 1,
  televisionRaw: 2,
  web: 3,
  webRip: 4,
  dvd: 5,
  bluray: 6,
  blurayRaw: 7,
};

export interface QualityLike {
  id: number;
  name: string;
  source: QualitySource;
  resolution: number;
  modifier?: string;
}

/** `{id, name, source, resolution}` (+ `modifier`, which Radarr has and Sonarr ignores). */
export function v3Quality(q: QualityLike, flavor: Flavor = 'sonarr'): Json {
  const source = flavor === 'radarr' ? RADARR_SOURCE[q.source] : SONARR_SOURCE[q.source];
  return { id: q.id, name: q.name, source, resolution: q.resolution, modifier: q.modifier ?? 'none' };
}

export function v3QualityById(id: number, flavor: Flavor = 'sonarr'): Json {
  return v3Quality(qualityById(id), flavor);
}

/** QualityModel -> `{ quality, revision: { version, real, isRepack } }`. */
export function v3QualityModel(model: QualityModel | null | undefined, flavor: Flavor = 'sonarr'): Json {
  const quality = model?.quality ?? qualityById(0);
  const revision = model?.revision ?? { version: 1, real: 0, isRepack: false };
  return {
    quality: v3Quality(quality, flavor),
    revision: { version: revision.version, real: revision.real, isRepack: revision.isRepack },
  };
}

// ---- languages ---------------------------------------------------------------------------

/** Upstream language ids by English name (public API enum values). */
const LANGUAGE_IDS: Record<string, number> = {
  Unknown: 0,
  English: 1,
  French: 2,
  Spanish: 3,
  German: 4,
  Italian: 5,
  Danish: 6,
  Dutch: 7,
  Japanese: 8,
  Icelandic: 9,
  Chinese: 10,
  Russian: 11,
  Polish: 12,
  Vietnamese: 13,
  Swedish: 14,
  Norwegian: 15,
  Finnish: 16,
  Turkish: 17,
  Portuguese: 18,
  Flemish: 19,
  Greek: 20,
  Korean: 21,
  Hungarian: 22,
  Hebrew: 23,
  Lithuanian: 24,
  Czech: 25,
  Arabic: 26,
  Hindi: 27,
  Bulgarian: 28,
  Malayalam: 29,
  Ukrainian: 30,
  Slovak: 31,
  Thai: 32,
  Romanian: 35,
  Original: -2,
};

export interface V3Language {
  id: number;
  name: string;
}

const UNKNOWN_LANGUAGE: V3Language = { id: 0, name: 'Unknown' };

const BY_CODE = new Map<string, V3Language>(
  PROFILE_LANGUAGES.map((l) => [l.code, { id: LANGUAGE_IDS[l.name] ?? 0, name: l.name }]),
);
const BY_ID = new Map<number, string>(PROFILE_LANGUAGES.map((l) => [LANGUAGE_IDS[l.name] ?? 0, l.code]));

/** ISO-639-1 code (or `original` / `unknown`) -> `{ id, name }`. Region suffixes are dropped. */
export function v3Language(code: string | null | undefined): V3Language {
  if (!code) return UNKNOWN_LANGUAGE;
  const lower = code.toLowerCase();
  return BY_CODE.get(lower) ?? BY_CODE.get(lower.split(/[-_]/)[0] ?? '') ?? UNKNOWN_LANGUAGE;
}

export function v3Languages(codes: readonly string[] | null | undefined): V3Language[] {
  const list = (codes ?? []).map(v3Language);
  return list.length > 0 ? list : [UNKNOWN_LANGUAGE];
}

/** Upstream language id -> our code, or undefined. */
export function languageCodeForId(id: number): string | undefined {
  return BY_ID.get(id);
}

/** GET /api/v3/language. */
export function languageList(): Json[] {
  return PROFILE_LANGUAGES.filter((l) => l.code !== 'original').map((l) => {
    const lang = v3Language(l.code);
    return { id: lang.id, name: lang.name, nameLower: lang.name.toLowerCase() };
  });
}
