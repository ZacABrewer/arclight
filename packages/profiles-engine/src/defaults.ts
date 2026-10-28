import {
  QUALITIES,
  QUALITY_GROUP_ID_BASE,
  qualitiesForDomain,
  type CustomFormat,
  type DelayProfile,
  type MediaDomain,
  type QualityName,
  type QualityProfileInput,
  type QualityProfileItem,
} from '@arclight/shared';

/**
 * The vocabulary of one domain ordered worst → best by default weight. Defaults to video, so
 * series/movie callers never see audio qualities.
 */
export function qualitiesByWeight(domain: MediaDomain = 'video') {
  return [...qualitiesForDomain(domain)].sort((a, b) => a.weight - b.weight || a.id - b.id);
}

interface GroupSpec {
  id: number;
  name: string;
  members: QualityName[];
}

/** Named groups the defaults share; members rank equal within a profile. */
export const DEFAULT_GROUPS: ReadonlyArray<GroupSpec> = [
  { id: QUALITY_GROUP_ID_BASE + 1, name: 'WEB 480p', members: ['WEBDL-480p', 'WEBRip-480p'] },
  { id: QUALITY_GROUP_ID_BASE + 2, name: 'WEB 720p', members: ['WEBDL-720p', 'WEBRip-720p'] },
  { id: QUALITY_GROUP_ID_BASE + 3, name: 'WEB 1080p', members: ['WEBDL-1080p', 'WEBRip-1080p'] },
  { id: QUALITY_GROUP_ID_BASE + 4, name: 'WEB 2160p', members: ['WEBDL-2160p', 'WEBRip-2160p'] },
];

/**
 * Every quality of the domain as an item, worst → best, with WEB-DL/WEBRip pairs grouped
 * (video). Only the listed names are allowed; names of another domain are ignored. This is
 * also the `/qualityprofile/schema` template when `allowed` is empty.
 */
export function buildItems(allowed: ReadonlyArray<QualityName>, domain: MediaDomain = 'video'): QualityProfileItem[] {
  const allowedIds = new Set(allowed.map((n) => QUALITIES[n].id));
  const grouped = new Map<number, GroupSpec>();
  if (domain === 'video') for (const g of DEFAULT_GROUPS) for (const m of g.members) grouped.set(QUALITIES[m].id, g);

  const items: QualityProfileItem[] = [];
  const emitted = new Set<number>();
  for (const q of qualitiesByWeight(domain)) {
    const group = grouped.get(q.id);
    if (!group) {
      items.push({ kind: 'quality', qualityId: q.id, allowed: allowedIds.has(q.id) });
      continue;
    }
    if (emitted.has(group.id)) continue;
    emitted.add(group.id);
    const qualityIds = group.members.map((m) => QUALITIES[m].id);
    items.push({ kind: 'group', id: group.id, name: group.name, qualityIds, allowed: qualityIds.some((id) => allowedIds.has(id)) });
  }
  return items;
}

function groupIdFor(name: QualityName): number {
  return DEFAULT_GROUPS.find((g) => g.members.includes(name))?.id ?? QUALITIES[name].id;
}

function profile(name: string, cutoff: QualityName, allowed: QualityName[], domain: MediaDomain = 'video'): QualityProfileInput {
  return {
    name,
    ...(domain === 'video' ? {} : { mediaDomain: domain }),
    upgradeAllowed: true,
    cutoff: groupIdFor(cutoff),
    items: buildItems(allowed, domain),
    minFormatScore: 0,
    cutoffFormatScore: 0,
    minUpgradeFormatScore: 1,
    formatItems: [],
    languages: [],
  };
}

const SD: QualityName[] = ['SDTV', 'DVD', 'WEBDL-480p', 'WEBRip-480p', 'Bluray-480p', 'Bluray-576p'];
const HD720: QualityName[] = ['HDTV-720p', 'WEBDL-720p', 'WEBRip-720p', 'Bluray-720p'];
const HD1080: QualityName[] = ['HDTV-1080p', 'WEBDL-1080p', 'WEBRip-1080p', 'Bluray-1080p'];
const UHD: QualityName[] = ['HDTV-2160p', 'WEBDL-2160p', 'WEBRip-2160p', 'Bluray-2160p', 'Remux-2160p'];

export function defaultQualityProfiles(): QualityProfileInput[] {
  return [
    profile('Any', 'Bluray-1080p', [...SD, ...HD720, ...HD1080, 'Remux-1080p', ...UHD]),
    profile('SD', 'Bluray-480p', SD),
    profile('HD-720p', 'Bluray-720p', HD720),
    profile('HD-1080p', 'Bluray-1080p', HD1080),
    profile('HD-720p/1080p', 'Bluray-1080p', [...HD720, ...HD1080]),
    profile('Ultra-HD', 'Bluray-2160p', UHD),
  ];
}

const LOSSY_HQ: QualityName[] = ['MP3-VBR-V0', 'MP3-320', 'AAC-256', 'AAC-320', 'Opus'];
const LOSSLESS: QualityName[] = ['ALAC', 'FLAC', 'Lossless-Other'];
const HI_RES: QualityName[] = ['ALAC-24bit', 'FLAC-24bit'];

/** Music profiles, seeded the first time music is switched on (design section 7.2). */
export function defaultMusicProfiles(): QualityProfileInput[] {
  return [
    profile('Lossless', 'FLAC', LOSSLESS, 'music'),
    profile('Hi-Res', 'FLAC-24bit', [...LOSSLESS, ...HI_RES], 'music'),
    profile('High-quality lossy', 'MP3-320', LOSSY_HQ, 'music'),
    profile('Any (music)', 'FLAC', ['MP3-192', 'MP3-VBR-V2', 'MP3-256', ...LOSSY_HQ, 'AAC-Low', 'Vorbis', ...LOSSLESS, ...HI_RES], 'music'),
  ];
}

/** Ships empty: formats are opinionated and belong to the user (or a later preset import). */
export function defaultCustomFormats(): Omit<CustomFormat, 'id'>[] {
  return [];
}

/** The untagged default delay profile every install starts with. */
export function defaultDelayProfile(): Omit<DelayProfile, 'id'> {
  return {
    tags: [],
    preferredProtocol: 'usenet',
    usenetDelayMinutes: 0,
    torrentDelayMinutes: 0,
    bypassIfHighestQuality: false,
    bypassIfAboveCustomFormatScore: false,
    minimumCustomFormatScore: 0,
    order: 1,
  };
}

// ---------------------------------------------------------------------------------------
// Default size limits (MB per minute of audio). Video qualities ship without limits; audio
// gets defaults because an album or book with the wrong size for its codec is a strong sign
// of a mislabelled release. MB/min = kbps × 0.0075; the bands leave room for container and
// artwork overhead. Checked against album duration or book runtime (design section 7.1).

type SizeBand = { minSize: number; preferredSize: number; maxSize: number };

export const DEFAULT_AUDIO_SIZES: Readonly<Partial<Record<QualityName, SizeBand>>> = {
  // Music, lossy
  'MP3-Low': { minSize: 0.3, preferredSize: 1.0, maxSize: 1.4 },
  'MP3-192': { minSize: 1.2, preferredSize: 1.45, maxSize: 1.8 },
  'MP3-VBR-V2': { minSize: 1.1, preferredSize: 1.45, maxSize: 2.0 },
  'MP3-256': { minSize: 1.7, preferredSize: 1.95, maxSize: 2.2 },
  'MP3-VBR-V0': { minSize: 1.4, preferredSize: 1.85, maxSize: 2.4 },
  'MP3-320': { minSize: 2.2, preferredSize: 2.4, maxSize: 2.6 },
  'AAC-Low': { minSize: 0.4, preferredSize: 1.0, maxSize: 1.5 },
  'AAC-256': { minSize: 1.4, preferredSize: 1.95, maxSize: 2.3 },
  'AAC-320': { minSize: 2.1, preferredSize: 2.4, maxSize: 2.7 },
  Vorbis: { minSize: 0.5, preferredSize: 1.6, maxSize: 3.0 },
  Opus: { minSize: 0.4, preferredSize: 1.2, maxSize: 2.5 },
  // Music, lossless (16/44.1 PCM is 10.6 MB/min; FLAC/ALAC compress it to roughly half)
  'Lossless-Other': { minSize: 3.5, preferredSize: 6, maxSize: 12 },
  PCM: { minSize: 9, preferredSize: 10.6, maxSize: 70 },
  ALAC: { minSize: 3.5, preferredSize: 6, maxSize: 12 },
  FLAC: { minSize: 3.5, preferredSize: 6, maxSize: 12 },
  'ALAC-24bit': { minSize: 8, preferredSize: 18, maxSize: 40 },
  'FLAC-24bit': { minSize: 8, preferredSize: 18, maxSize: 40 },
  // DSD64 stereo is about 42 MB/min; multichannel and DSD128+ go higher.
  DSD: { minSize: 20, preferredSize: 45, maxSize: 200 },
  // Audiobooks (speech, mostly mono or low-bitrate stereo)
  'AB-MP3-Low': { minSize: 0.1, preferredSize: 0.3, maxSize: 0.5 },
  'AB-AAC-Low': { minSize: 0.1, preferredSize: 0.25, maxSize: 0.5 },
  'AB-MP3': { minSize: 0.4, preferredSize: 0.5, maxSize: 1.0 },
  'AB-MP3-High': { minSize: 0.9, preferredSize: 1.0, maxSize: 2.5 },
  'AB-Opus': { minSize: 0.1, preferredSize: 0.3, maxSize: 1.0 },
  'AB-AAC': { minSize: 0.25, preferredSize: 0.6, maxSize: 1.5 },
  'AB-Lossless': { minSize: 3, preferredSize: 6, maxSize: 12 },
};

const SIZE_BY_ID = new Map<number, SizeBand>(
  Object.entries(DEFAULT_AUDIO_SIZES).map(([name, band]) => [QUALITIES[name as QualityName].id, band]),
);

/** Default limits for a quality definition (MB/min); all null for video and Unknown. */
export function defaultQualitySize(qualityId: number): { minSize: number | null; preferredSize: number | null; maxSize: number | null } {
  const band = SIZE_BY_ID.get(qualityId);
  return band ? { ...band } : { minSize: null, preferredSize: null, maxSize: null };
}
