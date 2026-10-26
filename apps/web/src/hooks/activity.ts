import { keepPreviousData, useQuery } from '@tanstack/react-query';
import type { QueueBulkRemoveRequest, QueueQueryInput, QueueRemoveOptions } from '@media-tron/shared';
import { blocklistApi } from '../api/blocklist.js';
import { historyApi, type HistoryFilter } from '../api/history.js';
import { queueApi } from '../api/queue.js';
import { activityKeys, useInvalidatingMutation } from './settings-keys.js';

/** Queue events invalidate ['queue']; the poll is a safety net for progress between events. */
export function useQueue(query: Partial<QueueQueryInput>) {
  return useQuery({
    queryKey: activityKeys.queue(query),
    queryFn: () => queueApi.list(query),
    placeholderData: keepPreviousData,
    refetchInterval: 10_000,
  });
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
    { errorTitle: 'Could not remove from queue' },
  );
}

export function useGrabQueueItem() {
  return useInvalidatingMutation((id: number) => queueApi.grab(id), [['queue']], { errorTitle: 'Could not send to client' });
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
    errorTitle: 'Could not mark as failed',
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
    { errorTitle: 'Could not remove from blocklist' },
  );
}
