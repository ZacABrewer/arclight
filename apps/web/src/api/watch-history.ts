import {
  JellyfinPluginKeyCreated,
  JellyfinPluginOverview,
  MediaServerAccountRow,
  MediaServerSyncStatus,
  NowPlayingEntry,
  PlexWebhookInfo,
  UserSyncServerResult,
  WatchedByEntry,
  WatchEventPage,
  WatchHistorySettings,
  WatchSyncServerResult,
  type WatchHistoryQuery,
} from '@arclight/shared';
import { request } from './client.js';

// Paths mirror apps/api/src/modules/watch-history/routes.ts and jellyfin-plugin/routes.ts
// (docs/API.md "Watch history" and "Jellyfin plugin").

const sid = (id: string) => encodeURIComponent(id);

export const watchHistoryApi = {
  settings: () => request('/settings/watchhistory', WatchHistorySettings),
  saveSettings: (body: WatchHistorySettings) => request('/settings/watchhistory', WatchHistorySettings, { method: 'PUT', json: body }),
  events: (query: WatchHistoryQuery = {}) => request('/watchhistory', WatchEventPage, { query: query as Record<string, string | number | boolean | undefined> }),
  watchedBy: (mediaType: 'movie' | 'series', id: number) => request(`/watchhistory/title/${mediaType}/${id}`, WatchedByEntry.array()),
  nowPlaying: () => request('/watchhistory/nowplaying', NowPlayingEntry.array()),
  syncStatus: (serverId: string) => request(`/mediaserver/${sid(serverId)}/sync`, MediaServerSyncStatus),
  syncNow: (serverId: string, full = false) => request(`/mediaserver/${sid(serverId)}/sync`, WatchSyncServerResult, { method: 'POST', json: { full } }),
  syncUsers: (serverId: string) => request(`/mediaserver/${sid(serverId)}/usersync`, UserSyncServerResult, { method: 'POST', json: {} }),
  accounts: (serverId: string) => request(`/mediaserver/${sid(serverId)}/accounts`, MediaServerAccountRow.array()),
  plexWebhook: (serverId: string) => request(`/mediaserver/${sid(serverId)}/plexwebhook`, PlexWebhookInfo),
  regeneratePlexWebhook: (serverId: string) => request(`/mediaserver/${sid(serverId)}/plexwebhook/regenerate`, PlexWebhookInfo, { method: 'POST', json: {} }),
};

export const jellyfinPluginApi = {
  overview: () => request('/settings/jellyfinplugin', JellyfinPluginOverview),
  createKey: (name?: string) => request('/settings/jellyfinplugin/keys', JellyfinPluginKeyCreated, { method: 'POST', json: name ? { name } : {} }),
  removeKey: (id: number) => request(`/settings/jellyfinplugin/keys/${id}`, null, { method: 'DELETE' }),
};
