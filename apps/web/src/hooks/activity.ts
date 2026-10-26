import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { BlocklistAddRequestInput, QueuePage, QueueBulkRemoveRequest, QueueQueryInput, QueueRemoveOptions } from '@arclight/shared';
import { blocklistApi } from '../api/blocklist.js';
import { historyApi, type HistoryFilter } from '../api/history.js';
import { queueApi } from '../api/queue.js';
import { useToast } from '../components/toast.js';
import { upsertJob } from '../live.js';
import { activityKeys, useInvalidatingMutation } from './settings-keys.js';
import { t } from '../i18n/index.js';

/** Poll interval while a row on the page is transferring (live speeds and peers). */
export const QUEUE_LIVE_POLL_MS = 3_000;
const QUEUE_IDLE_POLL_MS = 10_000;

/** True when any row is still downloading, so the page polls fast for live numbers. */
export function hasActiveDownloads(page: QueuePage | undefined): boolean {
  return (page?.records ?? []).some((r) => r.trackedState === 'downloading' && r.status !== 'paused');
}

/**
 * Queue events invalidate ['queue']; the poll is a safety net between events, fast (3 s)
 * while something is downloading. React Query skips interval polls while the tab is hidden.
 */
export function useQueue(query: Partial<QueueQueryInput>) {
  return useQuery({
    queryKey: activityKeys.queue(query),
    queryFn: () => queueApi.list(query),
    placeholderData: keepPreviousData,
    refetchInterval: (q) => (hasActiveDownloads(q.state.data) ? QUEUE_LIVE_POLL_MS : QUEUE_IDLE_POLL_MS),
  });
}

/** A download's timeline; `download` events refresh it live (see live.ts). */
export function useQueueTimeline(id: number, enabled = true) {
  return useQuery({ queryKey: activityKeys.queueTimeline(id), queryFn: () => queueApi.timeline(id), enabled, retry: false });
}

export function useQueueStatus() {
  return useQuery({ queryKey: activityKeys.queueStatus, queryFn: queueApi.status, refetchInterval: 30_000 });
}

export function useRemoveQueueItems() {
  return useInvalidatingMutation(
    ({ ids, options }: { ids: number[]; options: QueueRemoveOptions }) => {
      if (ids.length === 1) return queueApi.remove(ids[0]!, options);
      const body: QueueBulkRemoveRequest = { ids, ...options };
      return queueApi.removeBulk(body);
    },
    [['queue'], ['history']],
    { errorTitle: t('hooks.activity.couldNotRemoveFromQueue') },
  );
}

export function useGrabQueueItem() {
  return useInvalidatingMutation((id: number) => queueApi.grab(id), [['queue']], { errorTitle: t('hooks.activity.couldNotSendToClient') });
}

/** Pending api route: no retry so the "not available yet" notice shows at once. */
export function useHistory(filter: HistoryFilter) {
  return useQuery({
    queryKey: activityKeys.history(filter),
    queryFn: () => historyApi.list(filter),
    placeholderData: keepPreviousData,
    retry: false,
  });
}

export function useMarkHistoryFailed() {
  return useInvalidatingMutation((id: number) => historyApi.markFailed(id), [['history'], ['queue']], {
    errorTitle: t('hooks.activity.couldNotMarkAsFailed'),
  });
}

/** POST /history/:id/redownload: searches again for the record's episode(s) or movie. */
export function useRedownloadHistory() {
  const qc = useQueryClient();
  const toast = useToast();
  return useMutation({
    mutationFn: (id: number) => historyApi.redownload(id),
    meta: { errorTitle: t('hooks.activity.couldNotRedownload') },
    onSuccess: (job) => {
      toast.push({ tone: 'ok', title: t('hooks.activity.searchStarted'), message: t('hooks.activity.runIdIsStatus', { id: job.id, status: job.status }), durationMs: 4_000 });
      upsertJob(qc, job);
    },
    onSettled: async () => {
      await Promise.all([qc.invalidateQueries({ queryKey: ['history'] }), qc.invalidateQueries({ queryKey: ['queue'] })]);
    },
  });
}

/** History of one series (GET /history/series) or movie (GET /history/movie), newest first. */
export function useItemHistory(scope: { seriesId: number } | { movieId: number }) {
  return useQuery({
    queryKey: 'seriesId' in scope ? (['history', 'series', scope.seriesId] as const) : (['history', 'movie', scope.movieId] as const),
    queryFn: () => ('seriesId' in scope ? historyApi.forSeries(scope.seriesId) : historyApi.forMovie(scope.movieId)),
  });
}

export function useBlocklist(page: number, pageSize: number) {
  return useQuery({
    queryKey: activityKeys.blocklist(page, pageSize),
    queryFn: () => blocklistApi.list(page, pageSize),
    placeholderData: keepPreviousData,
    retry: false,
  });
}

export function useRemoveBlocklist() {
  return useInvalidatingMutation(
    (ids: number[]) => (ids.length === 1 ? blocklistApi.remove(ids[0]!) : blocklistApi.removeBulk(ids)),
    [['history', 'blocklist']],
    { errorTitle: t('hooks.activity.couldNotRemoveFromBlocklist') },
  );
}

export function useAddBlocklist() {
  return useInvalidatingMutation((body: BlocklistAddRequestInput) => blocklistApi.add(body), [['history', 'blocklist']], {
    silent: true,
  });
}

export function useClearBlocklist() {
  return useInvalidatingMutation(() => blocklistApi.clear(), [['history', 'blocklist']], { silent: true });
}
