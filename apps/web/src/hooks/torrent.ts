import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { TorrentPriorityRequest, TorrentSettingsUpdate } from '@arclight/shared';
import { torrentApi, type TorrentAction } from '../api/torrent.js';
import { useInvalidatingMutation } from './settings-keys.js';

// Everything for the built-in torrent engine lives under ['torrent'].
export const torrentKeys = {
  all: ['torrent'] as const,
  status: ['torrent', 'status'] as const,
  settings: ['torrent', 'settings'] as const,
  detail: (id: string) => ['torrent', 'detail', id] as const,
};

/** Live engine status, polled every 3 s. */
export function useTorrentStatus(options: { enabled?: boolean } = {}) {
  return useQuery({
    queryKey: torrentKeys.status,
    queryFn: torrentApi.status,
    retry: false,
    refetchInterval: 3_000,
    enabled: options.enabled ?? true,
  });
}

export function useTorrentSettings() {
  return useQuery({ queryKey: torrentKeys.settings, queryFn: torrentApi.settings.get, retry: false });
}

export function useSaveTorrentSettings() {
  return useInvalidatingMutation((body: TorrentSettingsUpdate) => torrentApi.settings.update(body), [torrentKeys.all], {
    errorTitle: 'Could not save torrent engine settings',
  });
}

/** One torrent by info-hash (the queue drawer), polled every 3 s while mounted. */
export function useTorrentDetail(id: string) {
  return useQuery({
    queryKey: torrentKeys.detail(id),
    queryFn: async () => (await torrentApi.list({ id }))[0] ?? null,
    retry: false,
    refetchInterval: 3_000,
  });
}

export function useTorrentAction(id: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (action: TorrentAction) => torrentApi.action(id, action),
    meta: { errorTitle: 'Torrent action failed' },
    onSettled: () => qc.invalidateQueries({ queryKey: torrentKeys.detail(id) }),
  });
}

export function useTorrentPriority(id: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: TorrentPriorityRequest) => torrentApi.priority(id, body),
    meta: { errorTitle: 'Could not change priority' },
    onSettled: () => qc.invalidateQueries({ queryKey: torrentKeys.detail(id) }),
  });
}
