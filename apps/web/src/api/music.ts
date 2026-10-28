import {
  Album,
  AlbumDetails,
  AlbumListResponse,
  AlbumTypeProfile,
  Artist,
  ArtistDetails,
  ArtistListResponse,
  ArtistSearchResponse,
  AudioImportSettings,
  FeatureSettings,
  Job,
  MusicMetadataSettingsResponse,
  WantedAlbumsPage,
  type AddArtistRequestInput,
  type AlbumTypeProfileInput,
  type BulkAlbumMonitorRequest,
  type BulkArtistUpdateRequest,
  type MusicCommand,
  type MusicMetadataSettingsUpdate,
  type UpdateAlbumRequest,
  type UpdateArtistRequest,
  type WantedAlbumsQuery,
} from '@arclight/shared';
import { request, type QueryParams } from './client.js';
import type { DeleteMediaOptions } from './library.js';

// Music (docs/design/music-audiobooks.md, Wave 1). Paths mirror apps/api/src/modules/music;
// shapes come from packages/shared/src/music.ts. Calendar album items ride on the shared
// CalendarItem union (api/library.ts calendar.list).

const q = (v: object | undefined): QueryParams | undefined => v as QueryParams | undefined;

export const musicApi = {
  artists: {
    list: () => request('/artist', ArtistListResponse, { query: { includeStatistics: true } }),
    get: (id: number) => request(`/artist/${id}`, ArtistDetails),
    /** Answers with the artist at once; albums fill in through the background ArtistAdd job. */
    add: (body: AddArtistRequestInput) => request('/artist', Artist, { method: 'POST', json: body }),
    update: (id: number, body: UpdateArtistRequest) => request(`/artist/${id}`, Artist, { method: 'PUT', json: body }),
    /** Bulk edit; the caller refetches, so the response body is not needed. */
    bulk: (body: BulkArtistUpdateRequest) => request('/artist/editor', null, { method: 'PUT', json: body }),
    remove: (id: number, opts: DeleteMediaOptions = {}) =>
      request(`/artist/${id}`, null, {
        method: 'DELETE',
        query: { deleteFiles: opts.deleteFiles ?? false, addExclusion: opts.addExclusion ?? false },
      }),
    /** MusicBrainz search; results already in the library carry `artistId`. */
    lookup: (term: string) => request('/artist/lookup', ArtistSearchResponse, { query: { term } }),
  },
  albums: {
    list: (artistId: number) => request('/album', AlbumListResponse, { query: { artistId } }),
    get: (id: number) => request(`/album/${id}`, AlbumDetails),
    update: (id: number, body: UpdateAlbumRequest) => request(`/album/${id}`, Album, { method: 'PUT', json: body }),
    monitor: (body: BulkAlbumMonitorRequest) => request('/album/monitor', null, { method: 'PUT', json: body }),
  },
  albumTypeProfiles: {
    list: () => request('/albumtypeprofile', AlbumTypeProfile.array()),
    create: (body: AlbumTypeProfileInput) => request('/albumtypeprofile', AlbumTypeProfile, { method: 'POST', json: body }),
    update: (id: number, body: AlbumTypeProfileInput) =>
      request(`/albumtypeprofile/${id}`, AlbumTypeProfile, { method: 'PUT', json: body }),
    remove: (id: number) => request(`/albumtypeprofile/${id}`, null, { method: 'DELETE' }),
  },
  wanted: {
    missing: (query?: Partial<WantedAlbumsQuery>) => request('/wanted/missing/albums', WantedAlbumsPage, { query: q(query) }),
    cutoff: (query?: Partial<WantedAlbumsQuery>) => request('/wanted/cutoff/albums', WantedAlbumsPage, { query: q(query) }),
  },
  /** POST /command (shared MusicCommand): answered 202 with the started job. */
  command: (body: MusicCommand) => request('/command', Job, { method: 'POST', json: body }),
  settings: {
    features: {
      get: () => request('/settings/features', FeatureSettings),
      update: (body: FeatureSettings) => request('/settings/features', FeatureSettings, { method: 'PUT', json: body }),
    },
    metadata: {
      get: () => request('/settings/musicmetadata', MusicMetadataSettingsResponse),
      update: (body: MusicMetadataSettingsUpdate) =>
        request('/settings/musicmetadata', MusicMetadataSettingsResponse, { method: 'PUT', json: body }),
    },
    audio: {
      get: () => request('/settings/audio', AudioImportSettings),
      update: (body: AudioImportSettings) => request('/settings/audio', AudioImportSettings, { method: 'PUT', json: body }),
    },
  },
};
