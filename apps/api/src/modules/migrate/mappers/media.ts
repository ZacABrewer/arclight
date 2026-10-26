import type { ImageCoverType, MediaImage, MediaInfo, Ratings } from '@arclight/shared';
import { field, int, json, num, str } from '../foreign-db.js';

// Small library sub-shapes: media info, images, ratings, genres.

const COVER_TYPES = new Set<ImageCoverType>(['poster', 'banner', 'fanart', 'clearlogo', 'screenshot', 'headshot']);

function langList(v: unknown): string[] | null {
  if (Array.isArray(v)) return v.map((x) => String(x).trim()).filter(Boolean);
  const s = str(v);
  if (!s) return null;
  return s.split(/[/,]/).map((x) => x.trim()).filter(Boolean);
}

/** `hh:mm:ss(.fff)` or `d.hh:mm:ss` or seconds → whole seconds. */
function runtimeSeconds(v: unknown): number | null {
  const n = num(v);
  if (n !== null) return Math.round(n);
  const s = str(v);
  const m = s ? /^(?:(\d+)\.)?(\d{1,2}):(\d{2}):(\d{2})(?:\.\d+)?$/.exec(s) : null;
  if (!m) return null;
  return Number(m[1] ?? 0) * 86400 + Number(m[2]) * 3600 + Number(m[3]) * 60 + Number(m[4]);
}

export function mapMediaInfo(raw: unknown): MediaInfo | null {
  const parsed = json<unknown>(raw, null);
  if (!parsed || typeof parsed !== 'object') return null;
  const o = parsed as Record<string, unknown>;
  const width = int(field(o, 'width'));
  const height = int(field(o, 'height'));
  const info: MediaInfo = {
    videoCodec: str(field(o, 'videoCodec', 'videoFormat')),
    audioCodec: str(field(o, 'audioCodec', 'audioFormat')),
    audioChannels: num(field(o, 'audioChannels', 'audioChannelsContainer')),
    resolution: width && height ? `${width}x${height}` : null,
    runtimeSeconds: runtimeSeconds(field(o, 'runTime', 'runtime')),
    videoDynamicRange: str(field(o, 'videoDynamicRangeType', 'videoDynamicRange', 'videoHdrFormat')) || null,
    subtitles: langList(field(o, 'subtitles')),
    audioLanguages: langList(field(o, 'audioLanguages')),
  };
  return Object.values(info).some((v) => v !== null && v !== undefined) ? info : null;
}

export function mapImages(raw: unknown): MediaImage[] {
  const list = json<unknown>(raw, []);
  if (!Array.isArray(list)) return [];
  const out: MediaImage[] = [];
  for (const entry of list) {
    if (!entry || typeof entry !== 'object') continue;
    const o = entry as Record<string, unknown>;
    const type = (str(field(o, 'coverType')) ?? '').toLowerCase() as ImageCoverType;
    const remote = str(field(o, 'remoteUrl'));
    const url = remote ?? str(field(o, 'url'));
    if (!COVER_TYPES.has(type) || !url || url.startsWith('/MediaCover')) continue;
    out.push({ coverType: type, url, remoteUrl: url });
  }
  return out;
}

/** `{votes, value}` (Sonarr) or `{tmdb: {...}, imdb: {...}}` (Radarr) → Ratings. */
export function mapRatings(raw: unknown, defaultSource: string): Ratings {
  const parsed = json<unknown>(raw, null);
  if (!parsed || typeof parsed !== 'object') return {};
  const o = parsed as Record<string, unknown>;
  const one = (r: unknown) => {
    if (!r || typeof r !== 'object') return null;
    const votes = int(field(r as Record<string, unknown>, 'votes')) ?? 0;
    const value = num(field(r as Record<string, unknown>, 'value')) ?? 0;
    return votes >= 0 && value >= 0 ? { votes, value } : null;
  };
  if ('value' in o || 'votes' in o || 'Value' in o) {
    const r = one(o);
    return r ? { [defaultSource]: r } : {};
  }
  const out: Ratings = {};
  for (const [k, v] of Object.entries(o)) {
    const r = one(v);
    if (r && (r.votes > 0 || r.value > 0)) out[k.toLowerCase()] = r;
  }
  return out;
}

export function mapGenres(raw: unknown): string[] {
  const list = json<unknown>(raw, []);
  return Array.isArray(list) ? list.map((g) => String(g)).filter(Boolean) : [];
}
