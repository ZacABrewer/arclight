import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useCallback, useMemo, useState } from 'react';
import type { BulkCommandResponse, BulkRenameRequest, BulkSearchCommandInput, BulkSubtitleSearchCommand } from '@arclight/shared';
import { bulkApi } from '../api/bulk.js';
import { libraryApi } from '../api/library.js';
import { useToast } from '../components/toast.js';
import { upsertJob } from '../live.js';
import { libraryKeys } from './library-keys.js';
import { subtitleKeys } from './query-keys.js';
import { searchStatusKeys } from './search-status.js';
import { t } from '../i18n/index.js';

// Hooks behind the shared bulk bar (components/media/bulk-bar.tsx): selection state and the
// bulk commands. Long-running work (searches) is one server job; the toast says how many
// items it queued.

/** Selection for a list of rows with numeric ids, plus the "select mode" switch of poster grids. */
export function useBulkSelection<K extends string | number = number>() {
  const [selectMode, setSelectMode] = useState(false);
  const [selected, setSelected] = useState<ReadonlySet<K>>(new Set());
  const toggle = useCallback(
    (id: K) =>
      setSelected((prev) => {
        const next = new Set(prev);
        if (next.has(id)) next.delete(id);
        else next.add(id);
        return next;
      }),
    [],
  );
  const selectAll = useCallback((ids: Iterable<K>) => setSelected(new Set(ids)), []);
  const clear = useCallback(() => {
    setSelected(new Set());
    setSelectMode(false);
  }, []);
  return useMemo(
    () => ({ selectMode, setSelectMode, selected, setSelected, toggle, selectAll, clear, ids: [...selected] }),
    [selectMode, selected, toggle, selectAll, clear],
  );
}

function queuedToast(toast: ReturnType<typeof useToast>, r: BulkCommandResponse, kind: 'search' | 'subtitles') {
  if (r.queued === 0) {
    toast.push({ tone: 'info', title: t('bulk.toast.nothingToSearch'), message: r.skipped ? t('bulk.toast.skipped', { count: r.skipped }) : undefined });
    return;
  }
  toast.push({
    tone: 'ok',
    title: kind === 'search' ? t('bulk.toast.searchQueued', { count: r.queued }) : t('bulk.toast.subtitleSearchQueued', { count: r.queued }),
    message: r.skipped ? t('bulk.toast.skipped', { count: r.skipped }) : undefined,
    durationMs: 5_000,
  });
}

/** POST /command/bulksearch: queues one job; the toast says how many items went in. */
export function useBulkSearch() {
  const qc = useQueryClient();
  const toast = useToast();
  return useMutation({
    mutationFn: (body: BulkSearchCommandInput) => bulkApi.search(body),
    meta: { errorTitle: t('common.searchFailed') },
    onSuccess: (r) => {
      queuedToast(toast, r, 'search');
      if (r.job) upsertJob(qc, r.job);
      void qc.invalidateQueries({ queryKey: searchStatusKeys.all });
      void qc.invalidateQueries({ queryKey: libraryKeys.wanted.all });
    },
  });
}

/** POST /command/subtitlesearch/bulk. */
export function useBulkSubtitleSearch() {
  const qc = useQueryClient();
  const toast = useToast();
  return useMutation({
    mutationFn: (body: BulkSubtitleSearchCommand) => bulkApi.subtitleSearch(body),
    meta: { errorTitle: t('hooks.subtitles.subtitleSearchFailed') },
    onSuccess: (r) => {
      queuedToast(toast, r, 'subtitles');
      if (r.job) upsertJob(qc, r.job);
      void qc.invalidateQueries({ queryKey: subtitleKeys.all });
    },
  });
}

/** Rename preview for the selection (only while `body` is set). */
export function useBulkRenamePreview(body: BulkRenameRequest | null) {
  return useQuery({
    queryKey: ['bulk', 'rename', body] as const,
    queryFn: () => bulkApi.renamePreview(body!),
    enabled: body !== null,
    staleTime: 0,
    gcTime: 0,
    retry: false,
  });
}

/** POST /command/bulkrename; refreshes the renamed items. */
export function useBulkRename() {
  const qc = useQueryClient();
  const toast = useToast();
  return useMutation({
    mutationFn: (body: BulkRenameRequest) => bulkApi.rename(body),
    meta: { errorTitle: t('bulk.rename.failed') },
    onSuccess: (r) => {
      toast.push(
        r.failed.length === 0
          ? { tone: 'ok', title: t('bulk.rename.renamed', { count: r.renamed.length }) }
          : { tone: 'warning', title: t('bulk.rename.renamed', { count: r.renamed.length }), message: t('bulk.rename.someFailed', { count: r.failed.length }) },
      );
      void qc.invalidateQueries({ queryKey: libraryKeys.series.all });
      void qc.invalidateQueries({ queryKey: libraryKeys.movie.all });
    },
  });
}

/** Many episodes' monitored flag (PUT /episode/monitor) from a season's bulk bar. */
export function useSetEpisodesMonitored() {
  const qc = useQueryClient();
  const toast = useToast();
  return useMutation({
    // `seriesId` refreshes that series page; without it (Wanted rows span series) every series is refetched.
    mutationFn: ({ episodeIds, monitored }: { seriesId?: number | undefined; episodeIds: number[]; monitored: boolean }) => libraryApi.episodes.setManyMonitored(episodeIds, monitored),
    meta: { errorTitle: t('hooks.library.couldNotChangeMonitoring') },
    onSuccess: (list) => toast.push({ tone: 'ok', title: t('bulk.toast.updated', { count: list.length }), durationMs: 4_000 }),
    onSettled: (_r, _e, { seriesId }) => {
      void qc.invalidateQueries({ queryKey: seriesId === undefined ? libraryKeys.series.all : libraryKeys.series.detail(seriesId) });
      void qc.invalidateQueries({ queryKey: libraryKeys.wanted.all });
    },
  });
}

/** Deletes many media files from disk (one request each) and refreshes their item once. */
export function useDeleteMediaFiles() {
  const qc = useQueryClient();
  const toast = useToast();
  return useMutation({
    mutationFn: async ({ fileIds }: { fileIds: number[]; mediaType: 'series' | 'movie'; ownerId: number }) => {
      for (const id of fileIds) await libraryApi.mediaFiles.remove(id, true);
      return fileIds.length;
    },
    meta: { errorTitle: t('hooks.library.couldNotDeleteFile') },
    onSuccess: (n) => toast.push({ tone: 'ok', title: t('bulk.toast.filesDeleted', { count: n }) }),
    onSettled: (_r, _e, { mediaType, ownerId }) => {
      void qc.invalidateQueries({ queryKey: mediaType === 'series' ? libraryKeys.series.detail(ownerId) : libraryKeys.movie.detail(ownerId) });
      void qc.invalidateQueries({ queryKey: libraryKeys.wanted.all });
    },
  });
}
