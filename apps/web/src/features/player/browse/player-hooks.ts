import { createContext, useContext } from 'react';

// The browse pages talk to the global player only through this adapter.
//
// Inside the /player layout, PlayerLayout provides BrowsePlayerContext from usePlayer() (see
// BrowsePlayerBridge in ui/player-layout.tsx). Tests provide the context directly.

export interface PlayItemsOptions {
  /** Index into `itemKeys` to start at (a clicked track). */
  startIndex?: number;
  /** What the queue plays from, e.g. "album:12", "playlist:3", "artist:4". */
  source?: string;
}

/** Offline copy of one item, as far as the player knows. */
export type DownloadState = 'none' | 'queued' | 'downloading' | 'done';

export interface BrowsePlayerActions {
  /** Item key of the item loaded in the player ("track:5"), or null. */
  currentItemKey: string | null;
  playing: boolean;
  /** Replace the queue with these items and start playing. */
  playItems: (itemKeys: string[], opts?: PlayItemsOptions) => void;
  /** Play one item; the engine resumes audiobooks at their saved position. */
  playItem: (itemKey: string) => void;
  playNext: (itemKeys: string[]) => void;
  addToQueue: (itemKeys: string[]) => void;
  /** Play/pause the current item. */
  toggle: () => void;
  /**
   * Keep items for offline listening. Optional: only the mobile app provides it (the web has no
   * offline copies), and the Download buttons and menu entries are hidden without it.
   */
  download?: ((itemKeys: string[]) => void) | undefined;
  /** Where an item's offline copy stands (with `download`). */
  downloadState?: ((itemKey: string) => DownloadState) | undefined;
}

const noop = () => {};
const IDLE: BrowsePlayerActions = {
  currentItemKey: null,
  playing: false,
  playItems: noop,
  playItem: noop,
  playNext: noop,
  addToQueue: noop,
  toggle: noop,
};

export const BrowsePlayerContext = createContext<BrowsePlayerActions>(IDLE);

export function usePlayerActions(): BrowsePlayerActions {
  return useContext(BrowsePlayerContext);
}

/**
 * One state for several items (an album, a playlist): 'none' while any is missing (the button
 * downloads the rest), else 'downloading' / 'queued' while any is under way, else 'done'.
 */
export function aggregateDownloadState(states: readonly DownloadState[]): DownloadState {
  if (states.length === 0 || states.includes('none')) return 'none';
  if (states.includes('downloading')) return 'downloading';
  if (states.includes('queued')) return 'queued';
  return 'done';
}

/** The download state of these items, or null when the player has no downloads (the web). */
export function useDownloadState(itemKeys: readonly string[]): DownloadState | null {
  const { download, downloadState } = usePlayerActions();
  if (!download || !downloadState) return null;
  return aggregateDownloadState(itemKeys.map((k) => downloadState(k)));
}
