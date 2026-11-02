import { useQuery } from '@tanstack/react-query';
import type { WatchHistoryQuery, WatchHistorySettings } from '@arclight/shared';
import { jellyfinPluginApi, watchHistoryApi } from '../api/watch-history.js';
import { useInvalidatingMutation } from './settings-keys.js';

// Sync status, accounts, settings and the plugin card sit under ['settings'] so a settings
// event refreshes them; the history itself under ['watchhistory'].
export const watchHistoryKeys = {
  all: ['watchhistory'] as const,
  events: (query: WatchHistoryQuery) => ['watchhistory', 'events', query] as const,
  watchedBy: (mediaType: string, id: number) => ['watchhistory', 'title', mediaType, id] as const,
  nowPlaying: ['watchhistory', 'nowplaying'] as const,
  settings: ['settings', 'watchhistory'] as const,
  sync: (serverId: string) => ['settings', 'mediaservers', serverId, 'sync'] as const,
  accounts: (serverId: string) => ['settings', 'mediaservers', serverId, 'accounts'] as const,
  plugin: ['settings', 'jellyfinplugin'] as const,
};

export function useWatchHistory(query: WatchHistoryQuery) {
  return useQuery({ queryKey: watchHistoryKeys.events(query), queryFn: () => watchHistoryApi.events(query), retry: false });
}

export function useWatchedBy(mediaType: 'movie' | 'series', id: number, enabled = true) {
  return useQuery({ queryKey: watchHistoryKeys.watchedBy(mediaType, id), queryFn: () => watchHistoryApi.watchedBy(mediaType, id), enabled, retry: false });
}

/** Polled: sessions come and go without a server event. */
export function useNowPlaying(enabled = true) {
  return useQuery({ queryKey: watchHistoryKeys.nowPlaying, queryFn: watchHistoryApi.nowPlaying, enabled, retry: false, refetchInterval: 30_000 });
}

export function useWatchHistorySettings() {
  return useQuery({ queryKey: watchHistoryKeys.settings, queryFn: watchHistoryApi.settings, retry: false });
}

export function useSaveWatchHistorySettings() {
  return useInvalidatingMutation((body: WatchHistorySettings) => watchHistoryApi.saveSettings(body), [watchHistoryKeys.settings], { silent: true });
}

export function useMediaServerSync(serverId: string | null) {
  return useQuery({ queryKey: watchHistoryKeys.sync(serverId ?? ''), queryFn: () => watchHistoryApi.syncStatus(serverId ?? ''), enabled: serverId !== null, retry: false });
}

export function useServerAccounts(serverId: string | null) {
  return useQuery({ queryKey: watchHistoryKeys.accounts(serverId ?? ''), queryFn: () => watchHistoryApi.accounts(serverId ?? ''), enabled: serverId !== null, retry: false });
}

export function useJellyfinPlugin() {
  return useQuery({ queryKey: watchHistoryKeys.plugin, queryFn: jellyfinPluginApi.overview, retry: false });
}

export function useRemovePluginKey() {
  return useInvalidatingMutation((id: number) => jellyfinPluginApi.removeKey(id), [watchHistoryKeys.plugin]);
}
