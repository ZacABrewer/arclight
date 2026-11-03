import type { DownloadState } from '@web/features/player/browse/player-hooks';
import { entryStatus, type DownloadIndex } from './download-index';

// What the browse pages' Download buttons show for an item, from the download index.

export function itemDownloadState(index: Pick<DownloadIndex, 'get'>, accountId: string, itemKey: string, pending: ReadonlySet<string> = new Set()): DownloadState {
  const entry = index.get(accountId, itemKey);
  if (!entry) return pending.has(itemKey) ? 'queued' : 'none';
  switch (entryStatus(entry)) {
    case 'completed':
      return 'done';
    case 'downloading':
      return 'downloading';
    case 'waiting':
      return 'waiting';
    case 'failed':
      return pending.has(itemKey) ? 'queued' : 'none';
    default:
      return 'queued';
  }
}
