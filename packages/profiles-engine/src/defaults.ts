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

function profile(name: string, cutoff: QualityName, allowed: QualityName[]): QualityProfileInput {
  return {
    name,
    upgradeAllowed: true,
    cutoff: groupIdFor(cutoff),
    items: buildItems(allowed),
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
