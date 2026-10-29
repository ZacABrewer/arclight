import {
  AudioAlbumDetail,
  AudioArtistDetail,
  AudioAuthorDetail,
  AudioBookDetail,
  AudioDiscoverHome,
  AudioDiscoverSearchResult,
  AudioRequest,
  AudioRequestCount,
  AudioRequestDefaults,
  AudioRequestPage,
  BulkRequestResult,
  type AudibleRegion,
  type AudioRequestListQuery,
  type CreateAudioRequest,
} from '@arclight/shared';
import { request, type QueryParams } from './client.js';

// Music and audiobook requests and their Discover catalogue (docs/API.md "Music and audiobook
// requests"). Every route answers 404 MUSIC_DISABLED / AUDIOBOOKS_DISABLED while the matching
// feature flag is off. Responses are parsed with the shared contract.

const q = (v: object | undefined): QueryParams | undefined => v as QueryParams | undefined;
const regionQuery = (region: AudibleRegion | null | undefined): QueryParams | undefined => (region ? { region } : undefined);

/** The two audio domains: the URL segment of their Discover pages and their feature flag differ. */
export type AudioDomain = 'music' | 'audiobook';

/** Error codes the audio routes answer while their feature flag is off. */
export const AUDIO_DISABLED_CODES: readonly string[] = ['MUSIC_DISABLED', 'AUDIOBOOKS_DISABLED'];

const discoverRoot = (domain: AudioDomain) => (domain === 'music' ? '/discover/music' : '/discover/audiobooks');

export const audioDiscoverApi = {
  home: (domain: AudioDomain) => request(discoverRoot(domain), AudioDiscoverHome),
  search: (domain: AudioDomain, query: string) => request(`${discoverRoot(domain)}/search`, AudioDiscoverSearchResult, { query: { query } }),
  album: (mbid: string) => request(`/discover/music/album/${encodeURIComponent(mbid)}`, AudioAlbumDetail),
  artist: (mbid: string) => request(`/discover/music/artist/${encodeURIComponent(mbid)}`, AudioArtistDetail),
  book: (asin: string, region?: AudibleRegion | null) => request(`/discover/audiobooks/book/${encodeURIComponent(asin)}`, AudioBookDetail, { query: regionQuery(region) }),
  author: (asin: string, region?: AudibleRegion | null) => request(`/discover/audiobooks/author/${encodeURIComponent(asin)}`, AudioAuthorDetail, { query: regionQuery(region) }),
};

export const audioRequestsApi = {
  list: (query: AudioRequestListQuery = {}) => request('/audiorequest', AudioRequestPage, { query: q(query) }),
  count: () => request('/audiorequest/count', AudioRequestCount),
  get: (id: number) => request(`/audiorequest/${id}`, AudioRequest),
  create: (body: CreateAudioRequest) => request('/audiorequest', AudioRequest, { method: 'POST', json: body }),
  approve: (id: number) => request(`/audiorequest/${id}/approve`, AudioRequest, { method: 'POST', json: {} }),
  decline: (id: number, reason?: string) => request(`/audiorequest/${id}/decline`, AudioRequest, { method: 'POST', json: reason ? { reason } : {} }),
  retry: (id: number) => request(`/audiorequest/${id}/retry`, AudioRequest, { method: 'POST', json: {} }),
  remove: (id: number) => request(`/audiorequest/${id}`, null, { method: 'DELETE' }),
  /** Approve, decline, retry or delete several requests; answers per id. */
  bulk: (action: AudioBulkAction, ids: number[]) => request(`/audiorequest/bulk/${action}`, BulkRequestResult, { method: 'POST', json: { ids } }),
};

export type AudioBulkAction = 'approve' | 'decline' | 'retry' | 'delete';

/** Default root folder and quality profile per audio domain (GET/PUT /settings/audiorequests). */
export const audioRequestDefaultsApi = {
  get: () => request('/settings/audiorequests', AudioRequestDefaults),
  update: (body: AudioRequestDefaults) => request('/settings/audiorequests', AudioRequestDefaults, { method: 'PUT', json: body }),
};
