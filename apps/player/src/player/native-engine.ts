import type { PluginListenerHandle } from '@capacitor/core';
import type { PlayableItem } from '@arclight/shared';
import type { EngineHooks, EngineSnapshot, StreamInfo } from '@web/features/player/engine/audio-engine';
import { outputLevel, replayGainFactor, type ReplayGainMode } from '@web/features/player/engine/gain';
import { clamp, locate } from '@web/features/player/engine/timeline';
import type { ArclightPlayerPlugin, NativeTrack, PlayerErrorCode, PositionEvent, RemoteCommandEvent, StateEvent, TrackChangedEvent } from '../native/definitions';

// The web player's controller (apps/web/src/features/player/player-controller.ts) drives an
// AudioEngine: load / play / pause / seek on an item's timeline, a "next" item for gapless
// advance, and snapshots back. This class offers the same surface on top of the ArclightPlayer
// plugin (native audio with lock-screen controls, or its in-WebView fallback), so the queue,
// progress reporting, sleep timer and every screen are the web player's own.
//
// Native plays FILES ("tracks"); an item is one track (music) or several (audiobook parts).
// The native queue is always: the current item's parts, then the next item's parts, so native
// keeps going (gapless) while JS is suspended in the background. Positions from native are
// offsets in the current file; this maps them onto the item's timeline with `itemOffsetMs`.

/** What `resolve` returns for one item: its files ready to play and how they are streamed. */
export interface ResolvedItem {
  tracks: Array<Omit<NativeTrack, 'id'>>;
  stream: StreamInfo;
}

export interface ResolveOptions {
  /** Ask for a transcode even when the original would do (the decoder refused it). */
  forceTranscode?: boolean;
  /** Do not reuse cached links (they were refused). */
  fresh?: boolean;
}

export interface NativeEngineDeps {
  plugin: ArclightPlayerPlugin;
  resolve: (item: PlayableItem, opts: ResolveOptions) => Promise<ResolvedItem>;
  /** Lock-screen skip intervals for audiobooks. */
  skipMs?: { back: number; forward: number };
  now?: () => number;
  /** A native "paused" that JS did not ask for is acted on after this long (track changes flicker). */
  externalPauseDelayMs?: number;
}

/** What the lock screen / headset / car asked for that the controller must decide. */
export type ExternalCommand = 'play' | 'pause' | 'next' | 'previous';

type EngineError = EngineSnapshot['error'];

interface Loaded {
  item: PlayableItem;
  gen: number;
  stream: StreamInfo;
  retriedAuth: boolean;
  forcedTranscode: boolean;
}

/** Ignore play/pause mismatches from native this soon after a local command (it has not applied it yet). */
const COMMAND_GRACE_MS = 1_200;

export class NativeEngine {
  private readonly plugin: ArclightPlayerPlugin;
  private readonly deps: NativeEngineDeps;
  private hooks: EngineHooks = {};
  private readonly listeners = new Set<(s: EngineSnapshot) => void>();
  private handles: PluginListenerHandle[] = [];
  private external: ((c: ExternalCommand) => void) | null = null;

  private item: PlayableItem | null = null;
  private loaded: Loaded | null = null;
  private nextItem: PlayableItem | null = null;
  private nextLoaded: Loaded | null = null;
  /** Mirror of the native queue. */
  private queue: NativeTrack[] = [];
  private trackGen = new Map<string, number>();
  private nativeIndex = -1;
  private gen = 0;
  private loadToken = 0;

  private wantPlay = false;
  private buffering = false;
  private error: EngineError = null;
  private speed = 1;
  private volume = 1;
  private muted = false;
  private rgMode: ReplayGainMode = 'off';
  private fade = 1;

  /** Last position from native: offset in `trackId`, at `at`. */
  private pos: { trackId: string | null; localMs: number; at: number; globalMs: number } = { trackId: null, localMs: 0, at: 0, globalMs: 0 };
  private lastCommandAt = 0;
  private pauseTimer: ReturnType<typeof setTimeout> | null = null;
  private ready: Promise<void>;

  constructor(deps: NativeEngineDeps) {
    this.deps = deps;
    this.plugin = deps.plugin;
    this.ready = this.attach();
  }

  private now(): number {
    return this.deps.now?.() ?? Date.now();
  }

  private async attach(): Promise<void> {
    const p = this.plugin;
    this.handles = await Promise.all([
      p.addListener('state', (e) => this.onState(e)),
      p.addListener('position', (e) => this.onPosition(e)),
      p.addListener('trackChanged', (e) => this.onTrackChanged(e)),
      p.addListener('queueEnded', () => this.onQueueEnded()),
      p.addListener('remoteCommand', (e) => this.onRemote(e)),
    ]);
  }

  /** Resolves once the native listeners are attached (tests). */
  whenReady(): Promise<void> {
    return this.ready;
  }

  /** Where lock-screen next / previous (and external play / pause) go: the controller. */
  setExternalHandler(handler: ((c: ExternalCommand) => void) | null): void {
    this.external = handler;
  }

  // ------------------------------------------------------------------ AudioEngine surface

  setHooks(hooks: EngineHooks): void {
    this.hooks = hooks;
  }

  subscribe(listener: (s: EngineSnapshot) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  get current(): PlayableItem | null {
    return this.item;
  }

  get isPlaying(): boolean {
    return this.wantPlay;
  }

  get playbackSpeed(): number {
    return this.speed;
  }

  /** Position on the current item's timeline, moving smoothly between native's once-a-second events. */
  get positionMs(): number {
    const item = this.item;
    if (!item) return 0;
    let ms = this.pos.globalMs;
    if (this.wantPlay && !this.buffering && this.pos.trackId && this.pos.at > 0) ms += (this.now() - this.pos.at) * this.speed;
    return item.durationMs > 0 ? clamp(ms, 0, item.durationMs) : Math.max(0, ms);
  }

  snapshot(): EngineSnapshot {
    const item = this.item;
    const position = this.positionMs;
    return {
      item,
      partIndex: item ? locate(item, position).partIndex : 0,
      positionMs: position,
      durationMs: item?.durationMs ?? 0,
      playing: this.wantPlay,
      buffering: this.buffering,
      error: this.error,
      stream: this.loaded?.stream ?? null,
    };
  }

  private emit(): void {
    const s = this.snapshot();
    for (const l of [...this.listeners]) l(s);
    this.hooks.onStateChange?.(s);
  }

  load(item: PlayableItem, startMs = 0, autoplay = true): void {
    this.cancelExternalPause();
    this.item = item;
    this.loaded = null;
    this.nextLoaded = null;
    this.error = null;
    this.wantPlay = autoplay;
    this.buffering = autoplay;
    this.markCommand();
    this.setPosition(null, 0, clamp(startMs, 0, item.durationMs > 0 ? item.durationMs : Number.MAX_SAFE_INTEGER));
    this.emit();
    void this.loadNative(item, this.pos.globalMs, autoplay, {});
  }

  setNext(item: PlayableItem | null): void {
    this.nextItem = item;
    this.nextLoaded = null;
    void this.syncUpcoming();
  }

  play(): void {
    if (!this.item) return;
    this.cancelExternalPause();
    this.wantPlay = true;
    this.error = null;
    this.markCommand();
    this.pos = { ...this.pos, at: this.now() };
    if (!this.loaded || this.nativeIndex < 0) {
      this.buffering = true;
      this.emit();
      void this.loadNative(this.item, this.pos.globalMs, true, {});
      return;
    }
    this.emit();
    void this.call(() => this.plugin.play());
  }

  pause(): void {
    this.cancelExternalPause();
    const at = this.positionMs;
    this.wantPlay = false;
    this.buffering = false;
    this.markCommand();
    this.pos = { ...this.pos, globalMs: at, localMs: this.pos.localMs + (at - this.pos.globalMs), at: this.now() };
    this.emit();
    void this.call(() => this.plugin.pause());
  }

  seek(globalMs: number): void {
    const item = this.item;
    if (!item) return;
    const target = item.durationMs > 0 ? clamp(globalMs, 0, item.durationMs) : Math.max(0, globalMs);
    const at = locate(item, target);
    const loaded = this.loaded;
    this.markCommand();
    const index = loaded ? this.queue.findIndex((t) => this.trackGen.get(t.id) === loaded.gen && t.partIndex === at.partIndex) : -1;
    const trackId = index >= 0 ? this.queue[index]!.id : null;
    this.setPosition(trackId, at.localMs, target);
    this.emit();
    if (!loaded || index < 0) {
      void this.loadNative(item, target, this.wantPlay, {});
      return;
    }
    if (index === this.nativeIndex) void this.call(() => this.plugin.seek({ positionMs: Math.round(at.localMs) }));
    else {
      this.nativeIndex = index;
      void this.call(() => this.plugin.skipTo({ index, positionMs: Math.round(at.localMs) }));
    }
  }

  setSpeed(speed: number): void {
    // Keep the place: positions before now were at the old speed.
    const at = this.positionMs;
    this.pos = { ...this.pos, globalMs: at, localMs: this.pos.localMs + (at - this.pos.globalMs), at: this.now() };
    this.speed = clamp(speed, 0.5, 3.5);
    void this.call(() => this.plugin.setRate({ rate: this.speed }));
    this.emit();
  }

  setVolume(volume: number): void {
    this.volume = clamp(volume, 0, 1);
    this.applyLevel();
  }

  setMuted(muted: boolean): void {
    this.muted = muted;
    this.applyLevel();
  }

  setReplayGain(mode: ReplayGainMode): void {
    this.rgMode = mode;
    this.applyLevel();
  }

  setFade(fade: number): void {
    const f = clamp(fade, 0, 1);
    if (f === this.fade) return;
    this.fade = f;
    this.applyLevel();
  }

  stop(): void {
    this.cancelExternalPause();
    this.loadToken++;
    this.wantPlay = false;
    this.buffering = false;
    this.item = null;
    this.loaded = null;
    this.nextItem = null;
    this.nextLoaded = null;
    this.queue = [];
    this.trackGen.clear();
    this.nativeIndex = -1;
    this.setPosition(null, 0, 0);
    void this.call(() => this.plugin.stop());
    this.emit();
  }

  destroy(): void {
    this.stop();
    for (const h of this.handles) void h.remove();
    this.handles = [];
    this.listeners.clear();
  }

  // ------------------------------------------------------------------ native queue

  private level(): number {
    return outputLevel({ volume: this.volume, muted: this.muted, replayGain: replayGainFactor(this.item, this.rgMode), fade: this.fade }, false);
  }

  private applyLevel(): void {
    void this.call(() => this.plugin.setVolume({ volume: this.level() }));
  }

  private markCommand(): void {
    this.lastCommandAt = this.now();
  }

  private setPosition(trackId: string | null, localMs: number, globalMs: number): void {
    this.pos = { trackId, localMs, globalMs, at: this.now() };
  }

  private withIds(resolved: ResolvedItem, gen: number): NativeTrack[] {
    return resolved.tracks.map((t) => {
      const id = `${t.itemKey}#${t.partIndex}~${gen}`;
      this.trackGen.set(id, gen);
      return { ...t, id };
    });
  }

  private async loadNative(item: PlayableItem, globalMs: number, autoplay: boolean, opts: ResolveOptions, retry?: Partial<Loaded>): Promise<void> {
    const token = ++this.loadToken;
    try {
      const resolved = await this.deps.resolve(item, opts);
      if (token !== this.loadToken || this.item !== item) return;
      const gen = ++this.gen;
      this.trackGen.clear();
      const current = this.withIds(resolved, gen);
      this.loaded = { item, gen, stream: resolved.stream, retriedAuth: retry?.retriedAuth ?? false, forcedTranscode: retry?.forcedTranscode ?? Boolean(opts.forceTranscode) };
      const at = locate(item, globalMs);
      const startIndex = Math.max(0, current.findIndex((t) => t.partIndex === at.partIndex));
      const next = await this.resolveNext(token);
      if (token !== this.loadToken) return;
      this.queue = [...current, ...next];
      this.nativeIndex = startIndex;
      this.setPosition(current[startIndex]?.id ?? null, at.localMs, globalMs);
      await this.ready;
      await this.plugin.load({ tracks: this.queue, startIndex, startMs: Math.round(at.localMs), autoplay: autoplay && this.wantPlay, rate: this.speed });
      if (token !== this.loadToken) return;
      await this.plugin.setVolume({ volume: this.level() });
      await this.plugin.configureRemote({
        mode: item.kind === 'audiobook' ? 'audiobook' : 'music',
        skipBackMs: this.deps.skipMs?.back ?? 30_000,
        skipForwardMs: this.deps.skipMs?.forward ?? 30_000,
      });
      this.emit();
    } catch (err) {
      if (token !== this.loadToken) return;
      this.fail(errorCode(err));
    }
  }

  /** The next item's files (resolved once per next item), or none. */
  private async resolveNext(token: number): Promise<NativeTrack[]> {
    const next = this.nextItem;
    if (!next) return [];
    try {
      const resolved = await this.deps.resolve(next, {});
      if (token !== this.loadToken || this.nextItem !== next) return [];
      const gen = ++this.gen;
      this.nextLoaded = { item: next, gen, stream: resolved.stream, retriedAuth: false, forcedTranscode: false };
      return this.withIds(resolved, gen);
    } catch {
      // Not resolvable now (offline): JS loads it when the current one ends.
      return [];
    }
  }

  /** After setNext: replace everything after the current native track. */
  private async syncUpcoming(): Promise<void> {
    const loaded = this.loaded;
    if (!loaded || this.nativeIndex < 0) return;
    const token = this.loadToken;
    const restOfCurrent = this.queue.slice(this.nativeIndex + 1).filter((t) => this.trackGen.get(t.id) === loaded.gen);
    const next = await this.resolveNext(token);
    if (token !== this.loadToken || this.loaded !== loaded) return;
    const head = this.queue.slice(0, this.nativeIndex + 1);
    // Forget ids no longer queued (except the current item's).
    for (const t of this.queue.slice(this.nativeIndex + 1)) if (this.trackGen.get(t.id) !== loaded.gen) this.trackGen.delete(t.id);
    for (const t of next) this.trackGen.set(t.id, this.nextLoaded?.gen ?? -1);
    this.queue = [...head, ...restOfCurrent, ...next];
    await this.call(() => this.plugin.setUpcoming({ tracks: [...restOfCurrent, ...next] }));
  }

  private trackOf(id: string | null): NativeTrack | null {
    return id ? (this.queue.find((t) => t.id === id) ?? null) : null;
  }

  private async call(fn: () => Promise<void>): Promise<void> {
    try {
      await this.ready;
      await fn();
    } catch (err) {
      const code = errorCode(err);
      if (code !== 'invalid') this.handleError(code);
    }
  }

  // ------------------------------------------------------------------ native events

  private onPosition(e: PositionEvent): void {
    const t = this.trackOf(e.trackId);
    const loaded = this.loaded;
    if (!t || !loaded || this.trackGen.get(t.id) !== loaded.gen) return;
    this.nativeIndex = e.index;
    this.setPosition(t.id, e.positionMs, t.itemOffsetMs + e.positionMs);
    this.emit();
  }

  private onTrackChanged(e: TrackChangedEvent): void {
    const t = this.trackOf(e.trackId);
    if (!t) return;
    this.nativeIndex = e.index;
    const gen = this.trackGen.get(t.id);
    const loaded = this.loaded;
    if (loaded && gen === loaded.gen) {
      // Next file of the same audiobook, or a skip within it.
      if (e.reason === 'auto' || e.reason === 'remote') this.setPosition(t.id, 0, t.itemOffsetMs);
      this.emit();
      return;
    }
    const next = this.nextLoaded;
    if (next && gen === next.gen) {
      // Gapless advance into the next item.
      this.item = next.item;
      this.loaded = next;
      this.nextItem = null;
      this.nextLoaded = null;
      this.error = null;
      // Drop the finished item's tracks from the mirror (native keeps them behind the index).
      this.setPosition(t.id, 0, t.itemOffsetMs);
      this.applyLevel();
      void this.call(() =>
        this.plugin.configureRemote({
          mode: next.item.kind === 'audiobook' ? 'audiobook' : 'music',
          skipBackMs: this.deps.skipMs?.back ?? 30_000,
          skipForwardMs: this.deps.skipMs?.forward ?? 30_000,
        }),
      );
      this.emit();
      this.hooks.onAdvance?.(next.item);
    }
  }

  private onQueueEnded(): void {
    if (!this.item) return;
    this.cancelExternalPause();
    this.wantPlay = false;
    this.buffering = false;
    this.nativeIndex = -1;
    this.loaded = null;
    this.setPosition(null, 0, this.item.durationMs);
    this.emit();
    this.hooks.onQueueEnd?.();
  }

  private onState(e: StateEvent): void {
    switch (e.status) {
      case 'loading':
      case 'buffering':
        if (this.wantPlay && !this.buffering) {
          this.buffering = true;
          this.emit();
        }
        return;
      case 'playing': {
        this.cancelExternalPause();
        const changed = this.buffering || this.error !== null;
        this.buffering = false;
        this.error = null;
        this.pos = { ...this.pos, at: this.now() };
        if (!this.wantPlay && this.now() - this.lastCommandAt > COMMAND_GRACE_MS) {
          // Played from the lock screen / headset while JS thought it paused.
          if (this.external) this.external('play');
          else {
            this.wantPlay = true;
            this.emit();
          }
          return;
        }
        if (changed) this.emit();
        return;
      }
      case 'paused':
        if (this.buffering) {
          this.buffering = false;
          this.emit();
        }
        if (this.wantPlay && this.now() - this.lastCommandAt > COMMAND_GRACE_MS) this.scheduleExternalPause();
        return;
      case 'error':
        this.handleError(e.error?.code ?? 'unknown');
        return;
      default:
        return;
    }
  }

  private onRemote(e: RemoteCommandEvent): void {
    switch (e.command) {
      case 'next':
        this.external?.('next');
        return;
      case 'previous':
        this.external?.('previous');
        return;
      case 'seekTo':
      case 'skipForward':
      case 'skipBackward':
        // Native applied it; its position event follows. Nothing to decide here.
        return;
      default:
        // play / pause / toggle / stop: native applied them; its state events tell us.
        return;
    }
  }

  private scheduleExternalPause(): void {
    if (this.pauseTimer) return;
    this.pauseTimer = setTimeout(() => {
      this.pauseTimer = null;
      if (!this.wantPlay) return;
      if (this.external) this.external('pause');
      else this.pause();
    }, this.deps.externalPauseDelayMs ?? 250);
  }

  private cancelExternalPause(): void {
    if (this.pauseTimer) clearTimeout(this.pauseTimer);
    this.pauseTimer = null;
  }

  private handleError(code: PlayerErrorCode): void {
    const item = this.item;
    const loaded = this.loaded;
    if (item && loaded && code === 'auth' && !loaded.retriedAuth) {
      // Expired or refused link: fresh links, same place.
      void this.loadNative(item, this.positionMs, this.wantPlay, { fresh: true, forceTranscode: loaded.forcedTranscode }, { retriedAuth: true, forcedTranscode: loaded.forcedTranscode });
      return;
    }
    if (item && loaded && code === 'unsupported' && !loaded.forcedTranscode) {
      void this.loadNative(item, this.positionMs, this.wantPlay, { forceTranscode: true, fresh: true }, { retriedAuth: loaded.retriedAuth, forcedTranscode: true });
      return;
    }
    this.fail(code);
  }

  private fail(code: PlayerErrorCode): void {
    const mapped: EngineError = code === 'unsupported' ? 'unsupported' : code === 'busy' ? 'busy' : 'network';
    this.wantPlay = false;
    this.buffering = false;
    this.error = mapped;
    this.emit();
  }
}

function errorCode(err: unknown): PlayerErrorCode {
  const code = (err as { code?: string } | null)?.code;
  const known: PlayerErrorCode[] = ['auth', 'network', 'busy', 'unsupported', 'file', 'invalid', 'unknown'];
  if (code && (known as string[]).includes(code)) return code as PlayerErrorCode;
  return 'network';
}
