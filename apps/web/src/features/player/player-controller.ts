import { PLAYED_THRESHOLD, RESUME_MIN, type ItemKey, type PlayableItem, type PlaybackProgress, type PlayQueue, type ProgressBeacon, type ProgressReport, type RepeatMode } from '@arclight/shared';
import { AudioEngine, type EngineSnapshot, type StreamInfo } from './engine/audio-engine.js';
import type { ReplayGainMode } from './engine/gain.js';
import { bindMediaSession, updateMediaMetadata, updateMediaPlayback } from './engine/media-session.js';
import { SleepTimer, rewindOnResumeMs, type SleepTimerSetting, type SleepTimerState } from './engine/sleep-timer.js';
import { chapterBounds, chapterIndexAt, clamp } from './engine/timeline.js';
import { ProgressReporter } from './progress-reporter.js';
import {
  EMPTY_QUEUE,
  REPEAT_CYCLE,
  addToQueue as queueAdd,
  clearUpcoming,
  currentKey,
  fromServerQueue,
  goTo,
  moveItem,
  newQueue,
  nextPos,
  playNext as queuePlayNext,
  playOrder,
  previousPos,
  removeAt,
  setRepeat as queueSetRepeat,
  setShuffle,
  toServerQueue,
  type Queue,
  type Random,
} from './queue.js';

// The player's brain, outside React: one engine, one queue, one progress reporter. The
// provider (player-context.tsx) creates it once and renders its state; everything here can be
// driven in tests with a fake engine element, fake fetchers and fake timers.

export interface QueueEntry {
  itemKey: ItemKey;
  /** Position in the play order (what removeFromQueue / moveInQueue take). */
  position: number;
}

export type PlayerErrorCode = 'unsupported' | 'network' | 'busy' | 'blocked' | 'load';

export interface PlayerState {
  /** The item loaded right now (playing or paused). */
  current: PlayableItem | null;
  /** The whole queue in play order (shuffled order while shuffle is on). */
  queue: QueueEntry[];
  /** Position of `current` in `queue`. */
  queueIndex: number;
  /** What the queue was started from ("album:12", "playlist:3", "audiobook:7"). */
  source: string | null;
  positionMs: number;
  durationMs: number;
  playing: boolean;
  buffering: boolean;
  /** An item is being fetched before it can start. */
  loading: boolean;
  speed: number;
  volume: number;
  muted: boolean;
  repeat: RepeatMode;
  shuffle: boolean;
  replayGain: ReplayGainMode;
  sleepTimer: SleepTimerState | null;
  /** Chapter playing (audiobooks); -1 when the item has none. */
  chapterIndex: number;
  /** How the current file is streamed (format badge). */
  stream: StreamInfo | null;
  error: PlayerErrorCode | null;
}

export interface PlayItemsOptions {
  /** Index into `itemKeys` to start at (default 0). */
  startIndex?: number;
  /** "Playing from": "album:12", "playlist:3", "artist:4", "audiobook:7", "search". */
  source?: string | null;
  /** Start position in ms; omitted: resume from saved progress where it applies. */
  startMs?: number;
  /** Start shuffled (the chosen item first). */
  shuffle?: boolean;
}

export interface ControllerDeps {
  engine: AudioEngine;
  fetchItem: (key: ItemKey) => Promise<PlayableItem>;
  fetchProgress: (key: ItemKey) => Promise<PlaybackProgress | null>;
  loadQueue: () => Promise<PlayQueue | null>;
  saveQueue: (q: PlayQueue) => Promise<unknown>;
  savePrefs: (key: ItemKey, prefs: { speed: number }) => Promise<unknown>;
  sendProgress: (key: string, report: ProgressReport) => Promise<unknown>;
  beacon: (body: ProgressBeacon) => boolean;
  deviceId: string;
  deviceName?: string;
  now?: () => number;
  random?: Random;
  queueSaveDelayMs?: number;
  initial?: { volume: number; muted: boolean; replayGain: ReplayGainMode };
  /** Bind lock-screen controls (default on). */
  mediaSession?: boolean;
}

/** Items at least this long resume where they were left even when they are tracks (DJ mixes). */
export const LONG_TRACK_MS = 15 * 60_000;
/** Previous restarts the item instead when more than this has played. */
export const RESTART_THRESHOLD_MS = 3_000;
const SEEK_REPORT_DELAY_MS = 800;
const PREFS_SAVE_DELAY_MS = 1_000;

/** Where to start an item from its effective progress (0 when nothing to resume). */
export function resumePosition(item: Pick<PlayableItem, 'kind' | 'durationMs'>, progress: PlaybackProgress | null): number {
  if (!progress || progress.played) return 0;
  if (item.kind !== 'audiobook' && item.durationMs < LONG_TRACK_MS) return 0;
  const duration = progress.durationMs > 0 ? progress.durationMs : item.durationMs;
  if (duration <= 0) return 0;
  const share = progress.positionMs / duration;
  return share >= RESUME_MIN && share < PLAYED_THRESHOLD ? Math.min(progress.positionMs, item.durationMs) : 0;
}

export class PlayerController {
  private readonly deps: ControllerDeps;
  private readonly engine: AudioEngine;
  private readonly reporter: ProgressReporter;
  private queue: Queue = EMPTY_QUEUE;
  private listeners = new Set<() => void>();
  private s: PlayerState;
  private loadToken = 0;
  private nextToken = 0;
  private touched = false;
  private restoreStarted = false;
  private pausedAt: number | null = null;
  private sleep: SleepTimer | null = null;
  private queueTimer: ReturnType<typeof setTimeout> | null = null;
  private seekTimer: ReturnType<typeof setTimeout> | null = null;
  private prefsTimer: ReturnType<typeof setTimeout> | null = null;
  private unbindSession: () => void = () => undefined;
  private sessionKind: PlayableItem['kind'] | null | undefined = undefined;
  private metaKey = '';
  private lastSnapshot: EngineSnapshot | null = null;
  private readonly unsubscribe: () => void;

  constructor(deps: ControllerDeps) {
    this.deps = deps;
    this.engine = deps.engine;
    const initial = deps.initial ?? { volume: 1, muted: false, replayGain: 'off' as const };
    this.engine.setVolume(initial.volume);
    this.engine.setMuted(initial.muted);
    this.engine.setReplayGain(initial.replayGain);
    this.s = {
      current: null,
      queue: [],
      queueIndex: 0,
      source: null,
      positionMs: 0,
      durationMs: 0,
      playing: false,
      buffering: false,
      loading: false,
      speed: 1,
      volume: initial.volume,
      muted: initial.muted,
      repeat: 'off',
      shuffle: false,
      replayGain: initial.replayGain,
      sleepTimer: null,
      chapterIndex: -1,
      stream: null,
      error: null,
    };
    this.reporter = new ProgressReporter({
      read: () => this.reportSnapshot(),
      send: deps.sendProgress,
      beacon: deps.beacon,
      deviceId: deps.deviceId,
      ...(deps.deviceName ? { deviceName: deps.deviceName } : {}),
      now: () => new Date(this.now()),
    });
    this.engine.setHooks({ onAdvance: (item) => this.onAdvance(item), onQueueEnd: () => this.onQueueEnd() });
    this.unsubscribe = this.engine.subscribe((snap) => this.onEngine(snap));
  }

  // ------------------------------------------------------------------ store

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  getState = (): PlayerState => this.s;

  private set(patch: Partial<PlayerState>): void {
    this.s = { ...this.s, ...patch };
    for (const l of this.listeners) l();
  }

  private now(): number {
    return this.deps.now?.() ?? Date.now();
  }

  private queueState(): Partial<PlayerState> {
    const keys = playOrder(this.queue);
    return {
      queue: keys.map((itemKey, position) => ({ itemKey, position })),
      queueIndex: this.queue.pos,
      source: this.queue.source,
      repeat: this.queue.repeat,
      shuffle: this.queue.shuffle,
    };
  }

  private reportSnapshot() {
    const item = this.engine.current;
    if (!item) return null;
    return {
      itemKey: item.itemKey,
      positionMs: this.engine.positionMs,
      durationMs: item.durationMs,
      speed: this.engine.playbackSpeed,
      playing: this.engine.isPlaying,
      playMethod: this.lastSnapshot?.stream?.transcoded ? ('Transcode' as const) : ('DirectPlay' as const),
    };
  }

  // ------------------------------------------------------------------ engine events

  private onEngine(snap: EngineSnapshot): void {
    this.lastSnapshot = snap;
    const item = snap.item;
    const chapterIndex = item ? chapterIndexAt(item.chapters, snap.positionMs) : -1;
    let sleepTimer = this.s.sleepTimer;
    if (this.sleep && item) {
      const tick = this.sleep.tick({
        now: this.now(),
        itemKey: item.itemKey,
        playing: snap.playing,
        positionMs: snap.positionMs,
        durationMs: snap.durationMs,
        speed: this.engine.playbackSpeed,
        chapters: item.chapters,
      });
      this.engine.setFade(tick.fade);
      sleepTimer = this.sleep.state();
      if (tick.expired) {
        this.sleep = null;
        sleepTimer = null;
        queueMicrotask(() => {
          this.pause();
          this.engine.setFade(1);
        });
      }
    }
    if (snap.playing) this.reporter.startHeartbeat();
    else this.reporter.stopHeartbeat();
    this.set({
      current: item,
      positionMs: snap.positionMs,
      durationMs: snap.durationMs,
      playing: snap.playing,
      buffering: snap.buffering,
      stream: snap.stream,
      error: snap.error ?? (this.s.error === 'load' ? 'load' : null),
      chapterIndex,
      sleepTimer,
    });
    this.syncMediaSession(item, chapterIndex, snap);
  }

  private syncMediaSession(item: PlayableItem | null, chapterIndex: number, snap: EngineSnapshot): void {
    if (this.deps.mediaSession === false) return;
    const kind = item?.kind ?? null;
    if (kind !== this.sessionKind) {
      this.unbindSession();
      this.sessionKind = kind;
      this.unbindSession = item
        ? bindMediaSession(kind, {
            play: () => this.play(),
            pause: () => this.pause(),
            seekTo: (ms) => this.seek(ms),
            skip: (d) => this.skip(d),
            next: () => this.next(),
            previous: () => this.previous(),
          })
        : () => undefined;
    }
    const chapter = item && chapterIndex >= 0 ? (item.chapters[chapterIndex]?.title ?? null) : null;
    const metaKey = `${item?.itemKey ?? ''}|${chapter ?? ''}`;
    if (metaKey !== this.metaKey) {
      this.metaKey = metaKey;
      updateMediaMetadata(item, chapter);
    }
    if (item) updateMediaPlayback(snap.playing, snap.positionMs, snap.durationMs, this.engine.playbackSpeed);
  }

  private onAdvance(item: PlayableItem): void {
    // An end-of-chapter timer set on the item that just finished: stop here, at the boundary
    // (the gapless handoff already started the next one).
    if (this.sleep?.kind === 'chapter') {
      this.sleep = null;
      this.set({ sleepTimer: null });
      queueMicrotask(() => {
        this.pause();
        this.engine.setFade(1);
      });
    }
    // The previous item finished: close its report at its end, then start the new one.
    const prev = this.reporter.startedKey;
    const prevItem = prev ? this.s.current : null;
    if (prev && prevItem && prevItem.itemKey === prev) {
      this.reporter.stop({ itemKey: prev, positionMs: prevItem.durationMs, durationMs: prevItem.durationMs, speed: this.engine.playbackSpeed, playing: false, playMethod: 'DirectPlay' });
    }
    const pos = nextPos(this.queue, true);
    if (pos !== null && currentKey(goTo(this.queue, pos)) === item.itemKey) this.queue = goTo(this.queue, pos);
    else {
      const at = playOrder(this.queue).indexOf(item.itemKey);
      if (at >= 0) this.queue = goTo(this.queue, at);
    }
    this.set({ ...this.queueState(), current: item, chapterIndex: chapterIndexAt(item.chapters, 0) });
    this.reporter.report('start', { itemKey: item.itemKey, positionMs: 0, durationMs: item.durationMs, playing: true });
    this.prepareNext();
    this.scheduleQueueSave();
  }

  private onQueueEnd(): void {
    const item = this.s.current;
    if (item && this.reporter.startedKey === item.itemKey) {
      this.reporter.stop({ itemKey: item.itemKey, positionMs: item.durationMs, durationMs: item.durationMs, speed: this.engine.playbackSpeed, playing: false, playMethod: 'DirectPlay' });
    }
    this.scheduleQueueSave();
  }

  // ------------------------------------------------------------------ loading

  /** Restore the server queue (paused) unless something was started meanwhile. */
  async restore(): Promise<void> {
    if (this.restoreStarted) return;
    this.restoreStarted = true;
    let server: PlayQueue | null = null;
    try {
      server = await this.deps.loadQueue();
    } catch {
      return;
    }
    if (!server || server.items.length === 0 || this.touched) return;
    this.queue = fromServerQueue(server);
    this.set(this.queueState());
    await this.loadCurrent({ autoplay: false, startMs: server.positionMs, restoring: true });
  }

  private async loadCurrent(opts: { autoplay: boolean; startMs?: number | undefined; restoring?: boolean }): Promise<void> {
    const key = currentKey(this.queue);
    const token = ++this.loadToken;
    if (this.reporter.startedKey) this.reporter.stop();
    if (!key) {
      this.engine.stop();
      this.set({ ...this.queueState(), current: null, loading: false });
      return;
    }
    this.set({ ...this.queueState(), loading: true, error: null });
    let item: PlayableItem;
    try {
      item = await this.deps.fetchItem(key);
    } catch {
      if (token === this.loadToken) this.set({ loading: false, error: 'load' });
      return;
    }
    if (token !== this.loadToken || (opts.restoring && this.touched)) return;
    let startMs = opts.startMs;
    let speed = 1;
    if (item.kind === 'audiobook' || startMs === undefined) {
      const progress = await this.deps.fetchProgress(key).catch(() => null);
      if (token !== this.loadToken) return;
      if (startMs === undefined) startMs = resumePosition(item, progress);
      if (item.kind === 'audiobook' && progress?.prefs.speed) speed = progress.prefs.speed;
    }
    this.engine.setSpeed(speed);
    this.pausedAt = opts.autoplay ? null : this.now();
    this.engine.load(item, clamp(startMs ?? 0, 0, item.durationMs), opts.autoplay);
    this.set({ current: item, loading: false, speed, error: null });
    if (opts.autoplay) this.reporter.report('start');
    this.prepareNext();
  }

  /** Fetch the queue's next item and hand it to the engine to preload (gapless). */
  private prepareNext(): void {
    const token = ++this.nextToken;
    const pos = nextPos(this.queue, true);
    const key = pos === null ? null : currentKey(goTo(this.queue, pos));
    if (!key) {
      this.engine.setNext(null);
      return;
    }
    const current = this.engine.current;
    if (current && current.itemKey === key) {
      this.engine.setNext(current);
      return;
    }
    this.deps
      .fetchItem(key)
      .then((item) => {
        if (token === this.nextToken) this.engine.setNext(item);
      })
      .catch(() => {
        if (token === this.nextToken) this.engine.setNext(null);
      });
  }

  private scheduleQueueSave(): void {
    if (this.queueTimer !== null) clearTimeout(this.queueTimer);
    this.queueTimer = setTimeout(() => {
      this.queueTimer = null;
      this.saveQueueNow();
    }, this.deps.queueSaveDelayMs ?? 1_500);
  }

  private saveQueueNow(): void {
    void this.deps.saveQueue(toServerQueue(this.queue, this.engine.positionMs, this.deps.deviceId)).catch(() => undefined);
  }

  private queueChanged(): void {
    this.touched = true;
    this.set(this.queueState());
    this.prepareNext();
    this.scheduleQueueSave();
  }

  // ------------------------------------------------------------------ actions

  playItems = (itemKeys: readonly string[], opts: PlayItemsOptions = {}): Promise<void> => {
    const keys = itemKeys.filter(Boolean) as ItemKey[];
    this.touched = true;
    this.queue = newQueue(keys, opts.startIndex ?? 0, {
      source: opts.source ?? null,
      repeat: this.queue.repeat,
      shuffle: opts.shuffle ?? false,
      ...(this.deps.random ? { random: this.deps.random } : {}),
    });
    this.scheduleQueueSave();
    return this.loadCurrent({ autoplay: true, startMs: opts.startMs });
  };

  playItem = (itemKey: string, opts: Omit<PlayItemsOptions, 'startIndex' | 'shuffle'> = {}): Promise<void> =>
    this.playItems([itemKey], { source: opts.source ?? itemKey, ...(opts.startMs !== undefined ? { startMs: opts.startMs } : {}) });

  play = (): void => {
    const item = this.engine.current;
    if (!item) {
      if (currentKey(this.queue)) void this.loadCurrent({ autoplay: true });
      return;
    }
    const back = rewindOnResumeMs(item.kind, this.pausedAt, this.now());
    if (back > 0) this.engine.seek(Math.max(0, this.engine.positionMs - back));
    this.pausedAt = null;
    this.engine.play();
    if (this.reporter.startedKey !== item.itemKey) this.reporter.report('start');
    else this.reporter.report('progress');
  };

  pause = (): void => {
    if (!this.engine.isPlaying) return;
    this.engine.pause();
    this.pausedAt = this.now();
    this.reporter.report('pause');
    this.scheduleQueueSave();
  };

  toggle = (): void => {
    if (this.engine.isPlaying) this.pause();
    else this.play();
  };

  seek = (ms: number): void => {
    const item = this.engine.current;
    if (!item) return;
    this.engine.seek(clamp(ms, 0, item.durationMs));
    if (this.seekTimer !== null) clearTimeout(this.seekTimer);
    this.seekTimer = setTimeout(() => {
      this.seekTimer = null;
      this.reporter.report('seek');
    }, SEEK_REPORT_DELAY_MS);
  };

  skip = (deltaMs: number): void => {
    if (!this.engine.current) return;
    this.seek(this.engine.positionMs + deltaMs);
  };

  next = (): void => {
    const pos = nextPos(this.queue, false);
    if (pos === null) return;
    this.queue = goTo(this.queue, pos);
    this.touched = true;
    this.scheduleQueueSave();
    void this.loadCurrent({ autoplay: true, startMs: 0 });
  };

  previous = (): void => {
    if (this.engine.positionMs > RESTART_THRESHOLD_MS || this.queue.order.length <= 1) {
      this.seek(0);
      return;
    }
    const pos = previousPos(this.queue);
    if (pos === null) {
      this.seek(0);
      return;
    }
    this.queue = goTo(this.queue, pos);
    this.touched = true;
    this.scheduleQueueSave();
    void this.loadCurrent({ autoplay: true, startMs: 0 });
  };

  /** The item `next()` would load, or null at the end of the queue (repeat one still moves on). */
  peekNext = (): ItemKey | null => {
    const pos = nextPos(this.queue, false);
    return pos === null ? null : currentKey(goTo(this.queue, pos));
  };

  /**
   * The place moved without this controller (a lock-screen / car / headset seek that native
   * audio applied itself): report it now instead of waiting for the next heartbeat.
   */
  reportExternalSeek = (): void => {
    if (!this.engine.current) return;
    if (this.seekTimer !== null) {
      clearTimeout(this.seekTimer);
      this.seekTimer = null;
    }
    this.reporter.report('seek');
  };

  /** Jump to an entry of the queue (play-order position). */
  playQueueIndex = (position: number): void => {
    if (position < 0 || position >= this.queue.order.length) return;
    this.queue = goTo(this.queue, position);
    this.touched = true;
    this.scheduleQueueSave();
    void this.loadCurrent({ autoplay: true, startMs: 0 });
  };

  nextChapter = (): void => {
    const item = this.engine.current;
    if (!item || item.chapters.length === 0) return;
    const i = chapterIndexAt(item.chapters, this.engine.positionMs);
    const target = item.chapters[i + 1];
    if (target) this.seek(target.startMs);
  };

  previousChapter = (): void => {
    const item = this.engine.current;
    if (!item || item.chapters.length === 0) return;
    const pos = this.engine.positionMs;
    const i = chapterIndexAt(item.chapters, pos);
    const bounds = chapterBounds(item.chapters, i, item.durationMs);
    // A few seconds in: back to the start of this chapter; else the one before.
    if (bounds && pos - bounds.startMs > RESTART_THRESHOLD_MS) this.seek(bounds.startMs);
    else this.seek(item.chapters[Math.max(0, i - 1)]?.startMs ?? 0);
  };

  setSpeed = (speed: number): void => {
    const s = Math.round(clamp(speed, 0.5, 3.5) * 100) / 100;
    this.engine.setSpeed(s);
    this.set({ speed: s });
    const item = this.engine.current;
    if (item?.kind !== 'audiobook') return;
    // Remembered per audiobook (progress prefs).
    if (this.prefsTimer !== null) clearTimeout(this.prefsTimer);
    this.prefsTimer = setTimeout(() => {
      this.prefsTimer = null;
      void this.deps.savePrefs(item.itemKey, { speed: s }).catch(() => undefined);
    }, PREFS_SAVE_DELAY_MS);
  };

  setVolume = (volume: number): void => {
    const v = clamp(volume, 0, 1);
    this.engine.setVolume(v);
    if (v > 0 && this.s.muted) this.engine.setMuted(false);
    this.set({ volume: v, muted: v > 0 ? false : this.s.muted });
  };

  setMuted = (muted: boolean): void => {
    this.engine.setMuted(muted);
    this.set({ muted });
  };

  toggleMute = (): void => this.setMuted(!this.s.muted);

  setReplayGain = (mode: ReplayGainMode): void => {
    this.engine.setReplayGain(mode);
    this.set({ replayGain: mode });
  };

  setRepeat = (repeat: RepeatMode): void => {
    this.queue = queueSetRepeat(this.queue, repeat);
    this.queueChanged();
  };

  cycleRepeat = (): void => this.setRepeat(REPEAT_CYCLE[this.queue.repeat]);

  toggleShuffle = (): void => {
    this.queue = setShuffle(this.queue, !this.queue.shuffle, this.deps.random);
    this.queueChanged();
  };

  playNext = (itemKeys: readonly string[]): void => {
    const wasEmpty = this.queue.items.length === 0;
    this.queue = queuePlayNext(this.queue, itemKeys as ItemKey[]);
    this.queueChanged();
    if (wasEmpty) void this.loadCurrent({ autoplay: false, startMs: 0 });
  };

  addToQueue = (itemKeys: readonly string[]): void => {
    const wasEmpty = this.queue.items.length === 0;
    this.queue = queueAdd(this.queue, itemKeys as ItemKey[]);
    this.queueChanged();
    if (wasEmpty) void this.loadCurrent({ autoplay: false, startMs: 0 });
  };

  removeFromQueue = (position: number): void => {
    const removingCurrent = position === this.queue.pos;
    const wasPlaying = this.engine.isPlaying;
    this.queue = removeAt(this.queue, position);
    this.queueChanged();
    if (removingCurrent) void this.loadCurrent({ autoplay: wasPlaying, startMs: 0 });
  };

  moveInQueue = (from: number, to: number): void => {
    this.queue = moveItem(this.queue, from, to);
    this.queueChanged();
  };

  clearQueue = (): void => {
    this.queue = clearUpcoming(this.queue);
    this.queueChanged();
  };

  /** null turns the timer off. */
  setSleepTimer = (setting: SleepTimerSetting | null): void => {
    this.engine.setFade(1);
    const item = this.engine.current;
    if (!setting || !item) {
      this.sleep = null;
      this.set({ sleepTimer: null });
      return;
    }
    this.sleep = new SleepTimer(setting, {
      now: this.now(),
      itemKey: item.itemKey,
      playing: this.engine.isPlaying,
      positionMs: this.engine.positionMs,
      durationMs: item.durationMs,
      speed: this.engine.playbackSpeed,
      chapters: item.chapters,
    });
    this.set({ sleepTimer: this.sleep.state() });
  };

  /**
   * A copy of the timer runs elsewhere (natively, so it fires while this code is suspended) and
   * has `remainingMs` left: show that. Minutes timers only (chapter timers follow the position).
   */
  adjustSleepTimer = (remainingMs: number): void => {
    if (!this.sleep || this.sleep.kind !== 'minutes') return;
    this.sleep.setRemaining(remainingMs, this.now());
    this.set({ sleepTimer: this.sleep.state() });
  };

  /** Stop playback and empty the queue. */
  stop = (): void => {
    this.reporter.stop();
    this.engine.stop();
    this.queue = { ...EMPTY_QUEUE, repeat: this.queue.repeat };
    this.sleep = null;
    this.queueChanged();
    this.set({ current: null, sleepTimer: null });
  };

  /**
   * A profile switch around `select` (the request that switches). The queue and the place belong
   * to the profile that is leaving, so they are saved for it first; once the switch went through,
   * the player is emptied without saving anything and the new profile's queue is restored (paused).
   * A failed switch (a wrong PIN) leaves playback as it was.
   */
  async switchProfile<T>(select: () => Promise<T>): Promise<T> {
    if (this.engine.current || this.queueTimer !== null) {
      if (this.queueTimer !== null) clearTimeout(this.queueTimer);
      this.queueTimer = null;
      await Promise.all([
        this.deps.saveQueue(toServerQueue(this.queue, this.engine.positionMs, this.deps.deviceId)).catch(() => undefined),
        this.reporter.flush(),
      ]);
    }
    const res = await select();
    for (const t of [this.queueTimer, this.seekTimer, this.prefsTimer]) if (t !== null) clearTimeout(t);
    this.queueTimer = this.seekTimer = this.prefsTimer = null;
    this.reporter.forget();
    this.loadToken++;
    this.nextToken++;
    this.engine.stop();
    this.queue = { ...EMPTY_QUEUE, repeat: this.queue.repeat };
    this.sleep = null;
    this.pausedAt = null;
    this.touched = false;
    this.restoreStarted = false;
    this.set({ ...this.queueState(), current: null, sleepTimer: null, loading: false, error: null });
    void this.restore();
    return res;
  }

  // ------------------------------------------------------------------ page lifecycle

  /** Tab hidden: send the place with sendBeacon. */
  onHidden(): void {
    if (!this.engine.current) return;
    this.reporter.beacon(this.engine.isPlaying ? 'progress' : 'pause');
  }

  /** Page going away. */
  onPageHide(): void {
    if (!this.engine.current) return;
    this.reporter.beacon(this.engine.isPlaying ? 'stop' : 'pause');
  }

  dispose(): void {
    for (const t of [this.queueTimer, this.seekTimer, this.prefsTimer]) if (t !== null) clearTimeout(t);
    this.reporter.dispose();
    this.unbindSession();
    this.unsubscribe();
    this.engine.destroy();
    this.listeners.clear();
  }
}
