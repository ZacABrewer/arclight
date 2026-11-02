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
