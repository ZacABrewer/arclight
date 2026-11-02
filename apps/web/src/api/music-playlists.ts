import { z } from 'zod';
import {
  AudioDiscoverItem,
  MusicPlaylist,
  MusicPlaylistEntry,
  MusicPlaylistPreview,
  MusicPlaylistsSettingsResponse,
  MusicPlaylistSyncStarted,
  SimilarArtistsResponse,
  type CreateMusicPlaylistInput,
  type MusicPlaylistsSettingsUpdate,
  type PlaylistSource,
  type UpdateMusicPlaylist,
} from '@arclight/shared';
import { request } from './client.js';

// Paths mirror apps/api/src/modules/music/playlists (playlist import, m3u and media-server
// pushes, similar artists) and the portal's GET /discover/music/artist/:mbid/similar.
// Playlist routes are admin-only; 404 MUSIC_DISABLED while music is off.

const PortalSimilar = z.object({ items: z.array(AudioDiscoverItem) });

export const musicPlaylistsApi = {
  list: () => request('/music/playlist', z.array(MusicPlaylist)),
  get: (id: number) => request(`/music/playlist/${id}`, MusicPlaylist),
  create: (body: CreateMusicPlaylistInput) => request('/music/playlist', MusicPlaylist, { method: 'POST', json: body }),
  update: (id: number, body: UpdateMusicPlaylist) => request(`/music/playlist/${id}`, MusicPlaylist, { method: 'PUT', json: body }),
  remove: (id: number) => request(`/music/playlist/${id}`, null, { method: 'DELETE' }),
  entries: (id: number) => request(`/music/playlist/${id}/entries`, z.array(MusicPlaylistEntry)),
  sync: (id: number) => request(`/music/playlist/${id}/sync`, MusicPlaylistSyncStarted, { method: 'POST' }),
  preview: (source: PlaylistSource) => request('/music/playlist/preview', MusicPlaylistPreview, { method: 'POST', json: { source } }),
  settings: () => request('/settings/musicplaylists', MusicPlaylistsSettingsResponse),
  updateSettings: (body: MusicPlaylistsSettingsUpdate) => request('/settings/musicplaylists', MusicPlaylistsSettingsResponse, { method: 'PUT', json: body }),
  similar: (artistId: number) => request(`/artist/${artistId}/similar`, SimilarArtistsResponse),
  portalSimilar: (mbid: string) => request(`/discover/music/artist/${encodeURIComponent(mbid)}/similar`, PortalSimilar),
};
