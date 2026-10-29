import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { AudioManualImportRequestInput, ReleaseGrabRequest } from '@arclight/shared';
import { audiobookAcquisitionApi, type AudiobookManualImportQuery, type AudiobookReleaseTarget } from '../api/audiobook-acquisition.js';
import { useToast } from '../components/toast.js';
import { upsertJob } from '../live.js';
import { audiobookKeys } from './audiobook-keys.js';
import { libraryKeys } from './library-keys.js';
import { t } from '../i18n/index.js';

// Audiobook searches, grabs and the audio manual import in audiobook mode (Wave 3).

export const audiobookAcquisitionKeys = {
  /** Under ['releases'] like the video and music searches, so nothing else invalidates a snapshot. */
  releases: (target: AudiobookReleaseTarget | null) => ['releases', 'audiobook', target] as const,
  manualImport: (query: AudiobookManualImportQuery | null) => ['manualimport', 'audiobook', query] as const,
};

/** Interactive search for a book (or an author's packs). Runs only while `target` is set. */
export function useAudiobookInteractiveSearch(target: AudiobookReleaseTarget | null) {
  return useQuery({
    queryKey: audiobookAcquisitionKeys.releases(target),
    queryFn: () => audiobookAcquisitionApi.releases.search(target!),
    enabled: target !== null,
    staleTime: 5 * 60_000,
    retry: false,
    refetchOnMount: 'always',
  });
}

export function useGrabAudiobookRelease() {
  const qc = useQueryClient();
  const toast = useToast();
  return useMutation({
    mutationFn: (body: ReleaseGrabRequest) => audiobookAcquisitionApi.releases.grab(body),
    meta: { errorTitle: t('hooks.library.grabFailed') },
    onSuccess: (r) => {
      toast.push({ tone: 'ok', title: t('common.grabbed'), message: r.title });
      void qc.invalidateQueries({ queryKey: ['queue'] });
    },
  });
}

export type AudiobookSearchCommand = { name: 'BookSearch'; bookIds: number[] } | { name: 'AuthorSearch'; authorIds: number[] };

/** BookSearch / AuthorSearch: a "search started" toast; results arrive as queue and job events. */
export function useAudiobookSearch() {
  const qc = useQueryClient();
  const toast = useToast();
  return useMutation({
    mutationFn: (body: AudiobookSearchCommand) => audiobookAcquisitionApi.command(body),
    meta: { errorTitle: t('common.searchFailed') },
    onSuccess: (job, body) => {
      const count = body.name === 'BookSearch' ? body.bookIds.length : body.authorIds.length;
      toast.push({
        tone: 'ok',
        title: body.name === 'BookSearch' ? t('audiobooks.search.bookSearchStarted', { count }) : t('audiobooks.search.authorSearchStarted', { count }),
        message: t('hooks.library.runIdIsStatus', { id: job.id, status: job.status }),
        durationMs: 4_000,
      });
      upsertJob(qc, job);
      void qc.invalidateQueries({ queryKey: libraryKeys.wanted.all });
    },
  });
}

export function useAudiobookImportScan(query: AudiobookManualImportQuery | null) {
  return useQuery({
    queryKey: audiobookAcquisitionKeys.manualImport(query),
    queryFn: () => audiobookAcquisitionApi.manualImport.scan(query!),
    enabled: query !== null,
    retry: false,
    staleTime: Infinity,
  });
}

export function useAudiobookImport() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: AudioManualImportRequestInput) => audiobookAcquisitionApi.manualImport.execute(body),
    meta: { errorTitle: t('activity.manualImport.manualImportFailed'), silent: true },
    onSuccess: async () => {
      await Promise.all([
        qc.invalidateQueries({ queryKey: ['queue'] }),
        qc.invalidateQueries({ queryKey: ['history'] }),
        qc.invalidateQueries({ queryKey: audiobookKeys.all }),
      ]);
    },
  });
}
