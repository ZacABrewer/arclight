import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { SoulseekGrabRequest, SoulseekSearchRequest, SoulseekSettingsUpdate } from '@arclight/shared';
import { soulseekApi } from '../api/soulseek.js';
import { useToast } from '../components/toast.js';
import { useInvalidatingMutation } from './settings-keys.js';
import { t } from '../i18n/index.js';

export const soulseekKeys = {
  settings: ['settings', 'soulseek'] as const,
  downloads: ['queue', 'soulseek'] as const,
};

export function useSoulseekSettings(enabled = true) {
  return useQuery({ queryKey: soulseekKeys.settings, queryFn: soulseekApi.settings, retry: false, enabled });
}

export function useSaveSoulseekSettings() {
  return useInvalidatingMutation((body: SoulseekSettingsUpdate) => soulseekApi.updateSettings(body), [soulseekKeys.settings], {
    errorTitle: t('soulseek.couldNotSave'),
  });
}

/** Active downloads poll every 5 s; nothing in flight, every 60 s. */
export function useSoulseekDownloads(enabled = true) {
  return useQuery({
    queryKey: soulseekKeys.downloads,
    queryFn: soulseekApi.downloads,
    retry: false,
    enabled,
    refetchInterval: (q) => (q.state.data?.some((d) => d.status === 'queued' || d.status === 'downloading' || d.status === 'importing') ? 5_000 : 60_000),
  });
}

/** Search results are shown inline; the caller renders errors. */
export function useSoulseekSearch() {
  return useMutation({ mutationFn: (body: SoulseekSearchRequest) => soulseekApi.search(body), meta: { silent: true } });
}

export function useSoulseekGrab() {
  const qc = useQueryClient();
  const toast = useToast();
  return useMutation({
    mutationFn: (body: SoulseekGrabRequest) => soulseekApi.grab(body),
    meta: { errorTitle: t('soulseek.grabFailed') },
    onSuccess: (d) => {
      toast.push({ tone: 'ok', title: t('soulseek.queued'), message: t('soulseek.queuedBody', { count: d.fileCount, username: d.username }), durationMs: 4_000 });
      void qc.invalidateQueries({ queryKey: soulseekKeys.downloads });
    },
  });
}

export function useSoulseekAuto() {
  const qc = useQueryClient();
  const toast = useToast();
  return useMutation({
    mutationFn: (albumId: number) => soulseekApi.auto(albumId),
    meta: { errorTitle: t('soulseek.searchFailed') },
    onSuccess: (r) => {
      toast.push({ tone: r.grabbed ? 'ok' : 'warning', title: r.grabbed ? t('soulseek.queued') : t('soulseek.nothingGrabbed'), message: r.message, durationMs: 5_000 });
      void qc.invalidateQueries({ queryKey: soulseekKeys.downloads });
    },
  });
}

export function useRemoveSoulseekDownload() {
  return useInvalidatingMutation((id: number) => soulseekApi.remove(id), [soulseekKeys.downloads], { errorTitle: t('soulseek.couldNotRemove') });
}
