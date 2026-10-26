import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { TorrentLimitsRequest, TorrentPriorityRequest, TorrentSettingsUpdate } from '@arclight/shared';
import { torrentApi, type TorrentAction } from '../api/torrent.js';
import { useInvalidatingMutation } from './settings-keys.js';
import { t } from '../i18n/index.js';

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
    errorTitle: t('hooks.torrent.couldNotSaveTorrentEngine'),
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
    meta: { errorTitle: t('hooks.torrent.torrentActionFailed') },
    onSettled: () => qc.invalidateQueries({ queryKey: torrentKeys.detail(id) }),
  });
}

export function useTorrentPriority(id: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: TorrentPriorityRequest) => torrentApi.priority(id, body),
    meta: { errorTitle: t('hooks.torrent.couldNotChangePriority') },
    onSettled: () => qc.invalidateQueries({ queryKey: torrentKeys.detail(id) }),
  });
}

export function useTorrentLimits(id: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: TorrentLimitsRequest) => torrentApi.limits(id, body),
    meta: { errorTitle: t('hooks.torrent.couldNotSetLimits') },
    onSettled: () => qc.invalidateQueries({ queryKey: torrentKeys.detail(id) }),
  });
}

export function useTorrentSuperSeed(id: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (enabled: boolean) => torrentApi.superSeed(id, { enabled }),
    meta: { errorTitle: t('hooks.torrent.couldNotChangeSuperSeeding') },
    onSettled: () => qc.invalidateQueries({ queryKey: torrentKeys.detail(id) }),
  });
}
