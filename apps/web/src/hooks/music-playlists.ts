import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { CreateMusicPlaylistInput, MusicPlaylistsSettingsUpdate, PlaylistSource, UpdateMusicPlaylist } from '@arclight/shared';
import { musicPlaylistsApi } from '../api/music-playlists.js';
import { useToast } from '../components/toast.js';
import { useInvalidatingMutation } from './settings-keys.js';
import { t } from '../i18n/index.js';

export const musicPlaylistKeys = {
  all: ['music', 'playlists'] as const,
  list: ['music', 'playlists', 'list'] as const,
  entries: (id: number) => ['music', 'playlists', id, 'entries'] as const,
  settings: ['settings', 'musicplaylists'] as const,
  similar: (artistId: number) => ['music', 'similar', artistId] as const,
  portalSimilar: (mbid: string) => ['discover', 'music', 'similar', mbid] as const,
};

/** Polls every 3 s while a sync runs, else every 60 s. */
export function useMusicPlaylists() {
  return useQuery({
    queryKey: musicPlaylistKeys.list,
    queryFn: musicPlaylistsApi.list,
    retry: false,
    refetchInterval: (q) => (q.state.data?.some((p) => p.lastSyncStatus === 'running') ? 3_000 : 60_000),
  });
}

export function useMusicPlaylistEntries(id: number | null) {
  return useQuery({ queryKey: musicPlaylistKeys.entries(id ?? 0), queryFn: () => musicPlaylistsApi.entries(id!), enabled: id !== null, retry: false });
}

export function useSaveMusicPlaylist() {
  return useInvalidatingMutation(
    ({ id, body }: { id?: number | undefined; body: CreateMusicPlaylistInput | UpdateMusicPlaylist }) =>
      id ? musicPlaylistsApi.update(id, body as UpdateMusicPlaylist) : musicPlaylistsApi.create(body as CreateMusicPlaylistInput),
    [musicPlaylistKeys.all],
    { silent: true },
  );
}

export function useDeleteMusicPlaylist() {
  return useInvalidatingMutation((id: number) => musicPlaylistsApi.remove(id), [musicPlaylistKeys.all], { errorTitle: t('musicPlaylists.couldNotDelete') });
}

export function useSyncMusicPlaylist() {
  const qc = useQueryClient();
  const toast = useToast();
  return useMutation({
    mutationFn: (id: number) => musicPlaylistsApi.sync(id),
    meta: { errorTitle: t('musicPlaylists.couldNotSync') },
    onSuccess: () => {
      toast.push({ tone: 'ok', title: t('musicPlaylists.syncStarted'), durationMs: 3_000 });
      void qc.invalidateQueries({ queryKey: musicPlaylistKeys.all });
    },
  });
}

/** The preview is shown inline in the dialog; the caller renders errors. */
export function usePreviewMusicPlaylist() {
  return useMutation({ mutationFn: (source: PlaylistSource) => musicPlaylistsApi.preview(source), meta: { silent: true } });
}

export function useMusicPlaylistsSettings(enabled = true) {
  return useQuery({ queryKey: musicPlaylistKeys.settings, queryFn: musicPlaylistsApi.settings, retry: false, enabled });
}

export function useSaveMusicPlaylistsSettings() {
  return useInvalidatingMutation((body: MusicPlaylistsSettingsUpdate) => musicPlaylistsApi.updateSettings(body), [musicPlaylistKeys.settings], {
    errorTitle: t('musicPlaylists.couldNotSaveSettings'),
  });
}

/** Similar artists for a library artist (cached a day on the server). */
export function useSimilarArtists(artistId: number) {
  return useQuery({ queryKey: musicPlaylistKeys.similar(artistId), queryFn: () => musicPlaylistsApi.similar(artistId), retry: false, staleTime: 3_600_000 });
}

/** Similar artists as portal cards (empty when no source answers). */
export function usePortalSimilarArtists(mbid: string) {
  return useQuery({ queryKey: musicPlaylistKeys.portalSimilar(mbid), queryFn: () => musicPlaylistsApi.portalSimilar(mbid), retry: false, staleTime: 3_600_000 });
}
