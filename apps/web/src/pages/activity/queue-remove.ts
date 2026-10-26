import type { QueueItem, QueueRemoveOptions } from '@arclight/shared';

// State of the "remove from queue" dialog, kept pure for testing.

export interface RemoveDialogState extends QueueRemoveOptions {
  /** False when none of the items has reached a download client yet. */
  clientAvailable: boolean;
}

export type RemoveAction =
  | { type: 'removeFromClient'; value: boolean }
  | { type: 'blocklist'; value: boolean }
  | { type: 'skipRedownload'; value: boolean };

/** True for items still waiting to be sent (delay profile / send failure). */
export function isPendingItem(item: Pick<QueueItem, 'downloadId' | 'downloadClientId'>): boolean {
  return item.downloadClientId === null || item.downloadId.startsWith('pending:');
}

export function initialRemoveState(items: ReadonlyArray<Pick<QueueItem, 'downloadId' | 'downloadClientId'>>): RemoveDialogState {
  const clientAvailable = items.some((i) => !isPendingItem(i));
  return { clientAvailable, removeFromClient: clientAvailable, blocklist: false, skipRedownload: false };
}

export function removeReducer(state: RemoveDialogState, action: RemoveAction): RemoveDialogState {
  switch (action.type) {
    case 'removeFromClient':
      return { ...state, removeFromClient: state.clientAvailable && action.value };
    case 'blocklist':
      // Skipping the redownload only means something when the release is blocklisted.
      return { ...state, blocklist: action.value, skipRedownload: action.value ? state.skipRedownload : false };
    case 'skipRedownload':
      return { ...state, skipRedownload: state.blocklist && action.value };
  }
}

export function toRemoveOptions(state: RemoveDialogState): QueueRemoveOptions {
  return { removeFromClient: state.removeFromClient, blocklist: state.blocklist, skipRedownload: state.skipRedownload };
}
