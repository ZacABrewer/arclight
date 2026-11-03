/**
 * The player: one audio engine, queue and progress reporter for the whole /player portal.
 *
 * Mount `<PlayerProvider>` once (PlayerLayout does) and read it anywhere below with `usePlayer()`:
 *
 *   const { state, playItems, playItem, toggle } = usePlayer();
 *
 * state (re-renders on change):
 *   current        PlayableItem | null     the item loaded now (playing or paused)
 *   queue          { itemKey, position }[] the queue in play order (shuffled order while shuffled)
 *   queueIndex     number                  position of `current` in `queue`
 *   source         string | null           "Playing from": "album:12", "playlist:3", "audiobook:7"
 *   positionMs, durationMs                 place on the item's whole timeline (all its files)
 *   playing, buffering, loading            loading: fetching the item before it can start
 *   speed          number                  0.5–3.5, remembered per audiobook
 *   volume, muted, replayGain              volume 0–1; replayGain 'off' | 'track' | 'album'
 *   repeat         'off' | 'all' | 'one'
 *   shuffle        boolean
 *   sleepTimer     { kind: 'minutes' | 'chapter', minutes, remainingMs } | null
 *   chapterIndex   number                  chapter playing (-1: none)
 *   stream         StreamInfo | null       format badge: direct or transcode, codec, bitrate
 *   error          'unsupported' | 'network' | 'busy' | 'blocked' | 'load' | null
 *
 * actions:
 *   playItems(itemKeys, { startIndex?, source?, startMs?, shuffle? })  replace the queue and play
 *   playItem(itemKey, { source?, startMs? })   play one item (resumes saved progress for books)
 *   toggle(), play(), pause(), stop()
 *   seek(ms), skip(deltaMs)                    on the item timeline
 *   next(), previous()                         previous restarts the item after 3 s
 *   nextChapter(), previousChapter()
 *   playQueueIndex(position)
 *   setSpeed(speed), setVolume(0..1), setMuted(bool), toggleMute(), setReplayGain(mode)
 *   setRepeat(mode), cycleRepeat(), toggleShuffle()
 *   playNext(itemKeys), addToQueue(itemKeys)
 *   removeFromQueue(position), moveInQueue(from, to), clearQueue()  (positions in play order)
 *   setSleepTimer({ kind: 'minutes', minutes } | { kind: 'chapter' } | null)
 *
 * Item keys are "track:<id>" or "audiobook:<id>". Playback keeps going while the user moves
 * between /player pages; leaving the portal stops it (with a final progress report).
 */
import { createContext, useContext, useEffect, useMemo, useRef, useState, useSyncExternalStore, type ReactNode } from 'react';
import { useQueryClient, type QueryClient } from '@tanstack/react-query';
import type { ItemKey, PlayerCapabilities } from '@arclight/shared';
import { AudioEngine } from './engine/audio-engine.js';
import { defaultAudioContext } from './engine/gain.js';
import { playbackApi, playerKeys, sendProgressBeacon } from './api.js';
import { browserName, deviceId, loadPrefs, savePrefs } from './device.js';
import { PlayerController, type PlayerState } from './player-controller.js';

export type { PlayerState, QueueEntry, PlayItemsOptions, PlayerErrorCode } from './player-controller.js';

type Actions = Pick<
  PlayerController,
  | 'playItems'
  | 'playItem'
  | 'toggle'
  | 'play'
  | 'pause'
  | 'stop'
  | 'seek'
  | 'skip'
  | 'next'
  | 'previous'
  | 'nextChapter'
  | 'previousChapter'
  | 'playQueueIndex'
  | 'setSpeed'
  | 'setVolume'
  | 'setMuted'
  | 'toggleMute'
  | 'setReplayGain'
  | 'setRepeat'
  | 'cycleRepeat'
  | 'toggleShuffle'
  | 'playNext'
  | 'addToQueue'
  | 'removeFromQueue'
  | 'moveInQueue'
  | 'clearQueue'
  | 'setSleepTimer'
>;

export interface PlayerApi extends Actions {
  state: PlayerState;
}

const PlayerContext = createContext<PlayerController | null>(null);

/**
 * Build the controller wired to the real api (tests build their own with fakes). `caps` is read
 * on every stream choice, so a cap that changes later (another network, an admin edit) applies.
 */
export function createPlayerController(qc: QueryClient, caps: () => PlayerCapabilities | undefined): PlayerController {
  const prefs = loadPrefs();
  const engine = new AudioEngine({
    createAudioContext: defaultAudioContext,
    maxBitrateKbps: () => caps()?.maxBitrateKbps ?? 0,
  });
  return new PlayerController({
    engine,
    fetchItem: (key) => qc.fetchQuery({ queryKey: playerKeys.item(key), queryFn: () => playbackApi.item(key), staleTime: 10 * 60_000 }),
    fetchProgress: async (key) => {
      const res = await playbackApi.progress([key]);
      return res.items.find((p) => p.itemKey === key) ?? null;
    },
    loadQueue: () => playbackApi.queue(),
    saveQueue: (q) => playbackApi.saveQueue(q),
    savePrefs: (key, p) => playbackApi.updateProgress(key, { prefs: p }),
    sendProgress: async (key, report) => {
      await playbackApi.report(key, report);
      if (report.event === 'stop' || report.event === 'pause') void qc.invalidateQueries({ queryKey: playerKeys.continue });
    },
    beacon: sendProgressBeacon,
    deviceId: deviceId(),
    deviceName: browserName(),
    initial: prefs,
  });
}

export function PlayerProvider({
  children,
  capabilities,
  controller: given,
  restoreQueue = true,
}: {
  children: ReactNode;
  capabilities?: PlayerCapabilities | undefined;
  /** Tests pass a controller built on fakes. */
  controller?: PlayerController;
  /** Pick up the queue saved on the server (another device, last visit), paused. */
  restoreQueue?: boolean;
}) {
  const qc = useQueryClient();
  // The controller is built once; it reads the latest capabilities through this ref.
  const capsRef = useRef(capabilities);
  capsRef.current = capabilities;
  const [controller] = useState(() => given ?? createPlayerController(qc, () => capsRef.current));

  useEffect(() => {
    if (restoreQueue) void controller.restore();
  }, [controller, restoreQueue]);

  // Remember volume / mute / ReplayGain on this device.
  useEffect(() => {
    let last = '';
    return controller.subscribe(() => {
      const s = controller.getState();
      const key = `${s.volume}|${s.muted}|${s.replayGain}`;
      if (key === last) return;
      last = key;
      savePrefs({ volume: s.volume, muted: s.muted, replayGain: s.replayGain });
    });
  }, [controller]);

  // Save the place when the tab is hidden or closed.
  useEffect(() => {
    const onVisibility = () => {
      if (document.visibilityState === 'hidden') controller.onHidden();
    };
    const onPageHide = () => controller.onPageHide();
    document.addEventListener('visibilitychange', onVisibility);
    window.addEventListener('pagehide', onPageHide);
    return () => {
      document.removeEventListener('visibilitychange', onVisibility);
      window.removeEventListener('pagehide', onPageHide);
    };
  }, [controller]);

  // Leaving the portal: final report, release the audio elements (unless the test owns it).
  // Deferred a tick so StrictMode's mount / unmount / mount in development keeps the player.
  const disposeTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => {
    if (disposeTimer.current !== null) clearTimeout(disposeTimer.current);
    disposeTimer.current = null;
    return () => {
      if (given) return;
      disposeTimer.current = setTimeout(() => {
        controller.onPageHide();
        controller.dispose();
      }, 0);
    };
  }, [controller, given]);

  return <PlayerContext.Provider value={controller}>{children}</PlayerContext.Provider>;
}

/** The controller when a `<PlayerProvider>` (or a scope) is above (the profile pickers switch through it), else null. */
export function usePlayerController(): PlayerController | null {
  return useContext(PlayerContext);
}

/** Lends a controller to pages outside `<PlayerProvider>` (the app's profile pickers), nothing more. */
export function PlayerControllerScope({ controller, children }: { controller: PlayerController; children: ReactNode }) {
  return <PlayerContext.Provider value={controller}>{children}</PlayerContext.Provider>;
}

/** The player's state and actions. Must be used inside `<PlayerProvider>`. */
export function usePlayer(): PlayerApi {
  const c = useContext(PlayerContext);
  if (!c) throw new Error('usePlayer must be used inside <PlayerProvider>');
  const state = useSyncExternalStore(c.subscribe, c.getState, c.getState);
  return useMemo(
    () => ({
      state,
      playItems: c.playItems,
      playItem: c.playItem,
      toggle: c.toggle,
      play: c.play,
      pause: c.pause,
      stop: c.stop,
      seek: c.seek,
      skip: c.skip,
      next: c.next,
      previous: c.previous,
      nextChapter: c.nextChapter,
      previousChapter: c.previousChapter,
      playQueueIndex: c.playQueueIndex,
      setSpeed: c.setSpeed,
      setVolume: c.setVolume,
      setMuted: c.setMuted,
      toggleMute: c.toggleMute,
      setReplayGain: c.setReplayGain,
      setRepeat: c.setRepeat,
      cycleRepeat: c.cycleRepeat,
      toggleShuffle: c.toggleShuffle,
      playNext: c.playNext,
      addToQueue: c.addToQueue,
      removeFromQueue: c.removeFromQueue,
      moveInQueue: c.moveInQueue,
      clearQueue: c.clearQueue,
      setSleepTimer: c.setSleepTimer,
    }),
    [c, state],
  );
}

/** Whether `itemKey` is the item loaded now (and playing): for play buttons on browse pages. */
export function useIsCurrent(itemKey: ItemKey | string): { current: boolean; playing: boolean } {
  const { state } = usePlayer();
  const current = state.current?.itemKey === itemKey;
  return { current, playing: current && state.playing };
}
