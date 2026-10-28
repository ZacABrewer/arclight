import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { AudioManualImportQueryInput, AudioManualImportRequestInput, ReleaseGrabRequest, ReleasesSettings } from '@arclight/shared';
import { musicAcquisitionApi, type MusicReleaseTarget } from '../api/music-acquisition.js';
import { useToast } from '../components/toast.js';
import { upsertJob } from '../live.js';
import { libraryKeys } from './library-keys.js';
import { musicKeys } from './music-keys.js';
import { useInvalidatingMutation } from './settings-keys.js';
import { t } from '../i18n/index.js';

// Music searches, grabs, the discography settings and the audio manual import (Wave 2).

export const musicAcquisitionKeys = {
  /** Under ['releases'] like the video searches, so nothing else invalidates a snapshot. */
  releases: (target: MusicReleaseTarget | null) => ['releases', 'music', target] as const,
  settings: ['settings', 'releases'] as const,
  manualImport: (query: AudioManualImportQueryInput | null) => ['manualimport', 'music', query] as const,
};

/** Interactive search for an album (or an artist's packs). Runs only while `target` is set. */
export function useMusicInteractiveSearch(target: MusicReleaseTarget | null) {
  return useQuery({
    queryKey: musicAcquisitionKeys.releases(target),
    queryFn: () => musicAcquisitionApi.releases.search(target!),
    enabled: target !== null,
    staleTime: 5 * 60_000,
    retry: false,
    refetchOnMount: 'always',
  });
}

export function useGrabMusicRelease() {
  const qc = useQueryClient();
  const toast = useToast();
  return useMutation({
    mutationFn: (body: ReleaseGrabRequest) => musicAcquisitionApi.releases.grab(body),
    meta: { errorTitle: t('hooks.library.grabFailed') },
    onSuccess: (r) => {
      toast.push({ tone: 'ok', title: t('common.grabbed'), message: r.title });
      void qc.invalidateQueries({ queryKey: ['queue'] });
    },
  });
}

export type MusicSearchCommand = { name: 'AlbumSearch'; albumIds: number[] } | { name: 'ArtistSearch'; artistIds: number[] };

/** AlbumSearch / ArtistSearch: a "search started" toast; results arrive as queue and job events. */
export function useMusicSearch() {
  const qc = useQueryClient();
  const toast = useToast();
  return useMutation({
    mutationFn: (body: MusicSearchCommand) => musicAcquisitionApi.command(body),
    meta: { errorTitle: t('common.searchFailed') },
    onSuccess: (job, body) => {
      const count = body.name === 'AlbumSearch' ? body.albumIds.length : body.artistIds.length;
      toast.push({
        tone: 'ok',
        title: body.name === 'AlbumSearch' ? t('music.search.albumSearchStarted', { count }) : t('music.search.artistSearchStarted', { count }),
        message: t('hooks.library.runIdIsStatus', { id: job.id, status: job.status }),
        durationMs: 4_000,
      });
      upsertJob(qc, job);
      void qc.invalidateQueries({ queryKey: libraryKeys.wanted.all });
    },
  });
}

export function useMusicReleasesSettings(enabled = true) {
  return useQuery({ queryKey: musicAcquisitionKeys.settings, queryFn: musicAcquisitionApi.settings.get, retry: false, enabled });
}

export function useSaveMusicReleasesSettings() {
  return useInvalidatingMutation((body: ReleasesSettings) => musicAcquisitionApi.settings.update(body), [musicAcquisitionKeys.settings], {
    errorTitle: t('music.releases.couldNotSave'),
  });
}

export function useAudioImportScan(query: AudioManualImportQueryInput | null) {
  return useQuery({
    queryKey: musicAcquisitionKeys.manualImport(query),
    queryFn: () => musicAcquisitionApi.manualImport.scan(query!),
    enabled: query !== null,
    retry: false,
    staleTime: Infinity,
  });
}

export function useAudioImport() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: AudioManualImportRequestInput) => musicAcquisitionApi.manualImport.execute(body),
    meta: { errorTitle: t('activity.manualImport.manualImportFailed'), silent: true },
    onSuccess: async () => {
      await Promise.all([
        qc.invalidateQueries({ queryKey: ['queue'] }),
        qc.invalidateQueries({ queryKey: ['history'] }),
        qc.invalidateQueries({ queryKey: musicKeys.all }),
      ]);
    },
  });
}
