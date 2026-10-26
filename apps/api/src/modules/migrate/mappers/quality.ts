import {
  QUALITY_GROUP_ID_BASE,
  qualityByName,
  type QualityDefinition,
  type QualityModel,
  type QualityProfileItem,
} from '@media-tron/shared';
import { bool, field, int } from '../foreign-db.js';

// Upstream quality ids → Media-Tron qualities, by name. The upstream id tables are data about
// their storage format (what number a row holds), not code.

export type ArrApp = 'sonarr' | 'radarr';

const SONARR_QUALITY_NAMES: Record<number, string> = {
  0: 'Unknown',
  1: 'SDTV',
  2: 'DVD',
  3: 'WEBDL-1080p',
  4: 'HDTV-720p',
  5: 'WEBDL-720p',
  6: 'Bluray-720p',
  7: 'Bluray-1080p',
  8: 'WEBDL-480p',
  9: 'HDTV-1080p',
  10: 'Raw-HD',
  11: 'HDTV-480p',
  12: 'WEBRip-480p',
  13: 'Bluray-480p',
  14: 'WEBRip-720p',
  15: 'WEBRip-1080p',
  16: 'HDTV-2160p',
  17: 'WEBRip-2160p',
  18: 'WEBDL-2160p',
  19: 'Bluray-2160p',
  20: 'Bluray-1080p Remux',
  21: 'Bluray-2160p Remux',
  22: 'Bluray-576p',
};

const RADARR_QUALITY_NAMES: Record<number, string> = {
  0: 'Unknown',
  1: 'SDTV',
  2: 'DVD',
  3: 'WEBDL-1080p',
  4: 'HDTV-720p',
  5: 'WEBDL-720p',
  6: 'Bluray-720p',
  7: 'Bluray-1080p',
  8: 'WEBDL-480p',
  9: 'HDTV-1080p',
  10: 'Raw-HD',
  12: 'WEBRip-480p',
  14: 'WEBRip-720p',
  15: 'WEBRip-1080p',
  16: 'HDTV-2160p',
  17: 'WEBRip-2160p',
  18: 'WEBDL-2160p',
  19: 'Bluray-2160p',
  20: 'Bluray-480p',
  21: 'Bluray-576p',
  22: 'BR-DISK',
  23: 'DVD-R',
  24: 'WORKPRINT',
  25: 'CAM',
  26: 'TELESYNC',
  27: 'TELECINE',
  28: 'DVDSCR',
  29: 'REGIONAL',
  30: 'Remux-1080p',
  31: 'Remux-2160p',
};

/** Upstream names that differ from ours. `HDTV-480p` has no equivalent and is dropped. */
const NAME_ALIASES: Record<string, string> = {
  'Bluray-1080p Remux': 'Remux-1080p',
  'Bluray-2160p Remux': 'Remux-2160p',
};

export function upstreamQualityName(app: ArrApp, id: number): string | undefined {
  return (app === 'sonarr' ? SONARR_QUALITY_NAMES : RADARR_QUALITY_NAMES)[id];
}

/** Media-Tron quality for an upstream id, or undefined when there is no equivalent. */
export function mapQualityId(app: ArrApp, id: number): QualityDefinition | undefined {
  const name = upstreamQualityName(app, id);
  if (!name) return undefined;
  return qualityByName(NAME_ALIASES[name] ?? name);
}

/** `{"quality": 7, "revision": {...}}` (or `{"quality": {"id": 7}}`) → QualityModel. */
export function mapQualityModel(app: ArrApp, raw: unknown): QualityModel {
  const obj = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : {};
  const q = field(obj, 'quality');
  const id = q && typeof q === 'object' ? int(field(q as Record<string, unknown>, 'id')) : int(q);
  const def = (id !== null ? mapQualityId(app, id) : undefined) ?? qualityByName('Unknown')!;
  const rev = field(obj, 'revision');
  const r = rev && typeof rev === 'object' ? (rev as Record<string, unknown>) : {};
  return {
    quality: { ...def, mediaTypes: [...def.mediaTypes] },
    revision: {
      version: Math.max(1, int(field(r, 'version')) ?? 1),
      real: Math.max(0, int(field(r, 'real')) ?? 0),
      isRepack: bool(field(r, 'isRepack')),
    },
  };
}

export interface MappedProfileItems {
  items: QualityProfileItem[];
  cutoff: number | null;
  dropped: string[];
}

/**
 * Upstream profile items (worst → best; `{quality, allowed}` or `{id, name, items, allowed}`
 * groups) → Media-Tron items. Unknown qualities are dropped and reported; a quality listed
 * twice after mapping keeps its first position.
 */
export function mapProfileItems(app: ArrApp, rawItems: unknown[], rawCutoff: number | null): MappedProfileItems {
  const items: QualityProfileItem[] = [];
  const dropped: string[] = [];
  const seen = new Set<number>();
  const groupIds = new Set<number>();
  let nextGroupId = QUALITY_GROUP_ID_BASE;
  let cutoff: number | null = null;

  const qualityOf = (entry: Record<string, unknown>): number | null => {
    const q = field(entry, 'quality');
    if (q && typeof q === 'object') return int(field(q as Record<string, unknown>, 'id'));
    return int(q);
  };

  for (const raw of rawItems) {
    if (!raw || typeof raw !== 'object') continue;
    const entry = raw as Record<string, unknown>;
    const allowed = bool(field(entry, 'allowed'));
    const children = field(entry, 'items');
    const qid = qualityOf(entry);
    if (Array.isArray(children) && children.length > 0 && (qid === null || qid === undefined)) {
      const qualityIds: number[] = [];
      for (const child of children) {
        if (!child || typeof child !== 'object') continue;
        const cid = qualityOf(child as Record<string, unknown>);
        if (cid === null) continue;
        const def = mapQualityId(app, cid);
        if (!def) {
          dropped.push(upstreamQualityName(app, cid) ?? `#${cid}`);
          continue;
        }
        if (seen.has(def.id)) continue;
        seen.add(def.id);
        qualityIds.push(def.id);
      }
      if (qualityIds.length === 0) continue;
      let gid = int(field(entry, 'id')) ?? nextGroupId;
      if (gid < QUALITY_GROUP_ID_BASE || groupIds.has(gid)) gid = nextGroupId;
      groupIds.add(gid);
      nextGroupId = Math.max(nextGroupId, gid) + 1;
      const name = String(field(entry, 'name') ?? `Group ${gid}`) || `Group ${gid}`;
      items.push({ kind: 'group', id: gid, name, qualityIds, allowed });
      if (rawCutoff !== null && int(field(entry, 'id')) === rawCutoff) cutoff = gid;
      continue;
    }
    if (qid === null) continue;
    const def = mapQualityId(app, qid);
    if (!def) {
      dropped.push(upstreamQualityName(app, qid) ?? `#${qid}`);
      continue;
    }
    if (seen.has(def.id)) continue;
    seen.add(def.id);
    items.push({ kind: 'quality', qualityId: def.id, allowed });
    if (rawCutoff !== null && rawCutoff < QUALITY_GROUP_ID_BASE && qid === rawCutoff) cutoff = def.id;
  }

  // A cutoff that points at a dropped or disallowed item falls back to the best allowed item.
  const cutoffItem = items.find((i) => (i.kind === 'group' ? i.id : i.qualityId) === cutoff);
  if (!cutoffItem || !cutoffItem.allowed) {
    const best = [...items].reverse().find((i) => i.allowed);
    cutoff = best ? (best.kind === 'group' ? best.id : best.qualityId) : null;
  }
  return { items, cutoff, dropped };
}
