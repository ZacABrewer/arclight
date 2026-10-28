import {
  AudioManualImportItem,
  AudioManualImportResult,
  Job,
  ReleaseDecision,
  ReleaseGrabResponse,
  ReleasesSettings,
  type AudioManualImportQueryInput,
  type AudioManualImportRequestInput,
  type MusicCommand,
  type ReleaseGrabRequest,
} from '@arclight/shared';
import { request, type QueryParams } from './client.js';

// Music acquisition (docs/design/music-audiobooks.md, Wave 2 / WP 2E). The release search and
// grab routes are shared with video (GET/POST /release with the music fields of
// packages/shared releases.ts); searches go through POST /command (AlbumSearch,
// ArtistSearch); manual import has its own audio routes (/manualimport/audio, docs/API.md).

export type MusicReleaseTarget = { albumId: number; artistId?: number | undefined } | { artistId: number };

/** The facts the release table shows, read from the decision's parsed music info. */
export interface MusicFacts {
  codec: string | null;
  bitrateKbps: number | null;
  bitDepth: number | null;
  sampleRateHz: number | null;
  media: string | null;
  hasLog: boolean;
  logScore: number | null;
  hasCue: boolean;
  /** `discography` or `multiAlbum` packs. */
  pack: 'discography' | 'multiAlbum' | null;
  years: { start: number; end: number } | null;
}

export function musicFacts(r: Pick<ReleaseDecision, 'music'>): MusicFacts {
  const m = r.music;
  return {
    codec: m?.codec && m.codec !== 'Unknown' ? m.codec : null,
    bitrateKbps: m?.bitrateKbps ?? null,
    bitDepth: m?.bitDepth ?? null,
    sampleRateHz: m?.sampleRateHz ?? null,
    media: m?.media && m.media !== 'Unknown' ? m.media : null,
    hasLog: m?.hasLog === true || (m?.logScore ?? null) !== null,
    logScore: m?.logScore ?? null,
    hasCue: m?.hasCue === true,
    pack: m?.packType ?? null,
    years: m?.discographyYears ?? null,
  };
}

/** POST /release body for a music grab: the guid plus the artist and albums the decision mapped to. */
export function musicGrabRequest(r: ReleaseDecision): ReleaseGrabRequest {
  return {
    guid: r.guid,
    indexerId: r.indexerId,
    ...(r.artistId !== undefined ? { artistId: r.artistId } : {}),
    ...(r.albumIds?.length ? { albumIds: r.albumIds } : {}),
  };
}

export const musicAcquisitionApi = {
  releases: {
    /** GET /release?albumId= (one album) or ?artistId= (packs plus every wanted album). */
    search: (target: MusicReleaseTarget) => request('/release', ReleaseDecision.array(), { query: target as QueryParams }),
    grab: (body: ReleaseGrabRequest) => request('/release', ReleaseGrabResponse, { method: 'POST', json: body }),
  },
  /** AlbumSearch / ArtistSearch through POST /command (answered 202 with the job). */
  command: (body: Extract<MusicCommand, { name: 'AlbumSearch' | 'ArtistSearch' }>) => request('/command', Job, { method: 'POST', json: body }),
  settings: {
    /** GET/PUT /settings/releases: the whole section (PUT replaces it), music knobs included. */
    get: () => request('/settings/releases', ReleasesSettings),
    update: (body: ReleasesSettings) => request('/settings/releases', ReleasesSettings, { method: 'PUT', json: body }),
  },
  manualImport: {
    /** GET /manualimport/audio: one item per audio file with the proposed artist, album and track. */
    scan: (query: AudioManualImportQueryInput) => request('/manualimport/audio', AudioManualImportItem.array(), { query: query as QueryParams }),
    execute: (body: AudioManualImportRequestInput) => request('/manualimport/audio', AudioManualImportResult, { method: 'POST', json: body }),
  },
};
