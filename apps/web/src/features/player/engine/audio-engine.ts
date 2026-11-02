import type { PlayableItem, PlayablePart } from '@arclight/shared';
import { streamUrl as defaultStreamUrl, type StreamOptions } from '../api.js';
import { outputLevel, replayGainFactor, type AudioContextLike, type ReplayGainMode } from './gain.js';
import { canPlayPart, chooseStream, codecLabel, preferredTranscode, type StreamChoice } from './stream.js';
import { clamp, globalPosition, locate } from './timeline.js';

// The audio engine: two <audio> elements ("decks") behind one timeline. The active deck plays;
// the standby deck preloads what comes next (the item's next file, or the queue's next item)
// and starts the moment the active one runs out, so albums and multi-file audiobooks play
// without a gap. Framework-free: the React provider (player-context.tsx) drives it and
// renders its snapshots.
//
// The precise (timer) handoff runs only when the element knows the file's length and it agrees
// with the library's; otherwise (unknown length, a live transcode, a file longer than the database
// says) the switch waits for the element's 'ended', so nothing is cut short.

/** The slice of HTMLAudioElement the engine uses; tests pass fakes. */
export interface AudioLike {
  src: string;
  currentTime: number;
  readonly duration: number;
  readonly paused: boolean;
  playbackRate: number;
  preservesPitch?: boolean;
  volume: number;
  muted: boolean;
  preload: string;
  readonly error?: { code: number } | null;
  play(): Promise<void> | void;
  pause(): void;
  load(): void;
  removeAttribute(name: string): void;
  addEventListener(type: string, listener: () => void): void;
  removeEventListener(type: string, listener: () => void): void;
  canPlayType(type: string): string;
}

export interface StreamInfo extends StreamChoice {
  /** "FLAC", "MP3 320", "FLAC 24/96": the original file's codec. */
  sourceLabel: string;
}

export interface EngineSnapshot {
  item: PlayableItem | null;
  partIndex: number;
  positionMs: number;
  durationMs: number;
  playing: boolean;
  buffering: boolean;
  /**
   * 'unsupported' (no way to decode), 'network' (the stream failed or the server refused it),
   * 'busy' (the server is out of transcode slots), 'blocked' (autoplay refused), or null.
   */
  error: 'unsupported' | 'network' | 'busy' | 'blocked' | null;
  stream: StreamInfo | null;
}

export interface EngineOptions {
  createElement?: () => AudioLike;
  streamUrl?: (fileId: number, opts: StreamOptions) => string;
  /** null: never use Web Audio (element volume instead). */
  createAudioContext?: (() => AudioContextLike | null) | null;
  /** Effective bitrate cap for this connection (0: none). */
  maxBitrateKbps?: () => number;
  userAgent?: string;
  /** Start the standby deck this long before the active one would end (ms). */
  preloadAheadMs?: number;
  /** Schedule the precise handoff once this little is left (ms). */
  handoffWindowMs?: number;
  /**
   * After a media error: the HTTP status of the stream URL (a HEAD request), 0 when the request
   * itself failed, null when it cannot tell. Tells a refused or failed stream from a decode error.
   */
  probe?: (url: string) => Promise<number | null>;
  now?: () => number;
}

/** HEAD the stream URL; 0 when the request fails, null without fetch. */
export async function probeStream(url: string): Promise<number | null> {
  if (typeof fetch !== 'function') return null;
  try {
    const res = await fetch(url, { method: 'HEAD', credentials: 'same-origin', cache: 'no-store' });
    return res.status;
  } catch {
    return 0;
  }
}

/** The element's length beyond the library's by more than this: wait for 'ended' instead of a timer. */
const DURATION_TOLERANCE_MS = 1_500;
/** A transcode paused longer than this is requested again on play (the server drops stalled ones). */
const TRANSCODE_RESUME_AFTER_MS = 45_000;

export interface EngineHooks {
  /** The standby deck took over with the queue's next item (gapless advance). */
  onAdvance?: (item: PlayableItem) => void;
  /** The last item ended with nothing queued after it. */
  onQueueEnd?: () => void;
  /** A user-visible pause came from the engine itself (end, error). */
  onStateChange?: (s: EngineSnapshot) => void;
}

interface Segment {
  item: PlayableItem;
  partIndex: number;
}

interface Deck {
  el: AudioLike;
  seg: Segment | null;
  stream: StreamInfo | null;
  /** Transcoded streams start at `offsetMs` into the file (element time 0 = offset). */
  offsetMs: number;
  /** Seek to apply once metadata is in (direct streams). */
  pendingSeekS: number | null;
  /** The direct stream failed once: transcode from now on. */
  forceTranscode: boolean;
  gain: { gain: { value: number } } | null;
  wired: boolean;
  /** Bumped on every new src, so a late error probe for an old one is dropped. */
  srcToken: number;
}

const MEDIA_ERR_SRC_NOT_SUPPORTED = 4;
const MEDIA_ERR_DECODE = 3;

function sameSeg(a: Segment | null, b: Segment | null): boolean {
  return Boolean(a && b && a.item.itemKey === b.item.itemKey && a.partIndex === b.partIndex && a.item === b.item);
}

/** Global position of a local offset; a part of unknown length (0) is not clamped at its end. */
function positionIn(part: PlayablePart, localMs: number): number {
  return part.durationMs > 0 ? globalPosition(part, localMs) : part.startMs + Math.max(0, localMs);
}

export class AudioEngine {
  private readonly decks: [Deck, Deck];
  private active = 0;
  private item: PlayableItem | null = null;
  private nextItem: PlayableItem | null = null;
  private wantPlay = false;
  private buffering = false;
  private error: EngineSnapshot['error'] = null;
  private speed = 1;
  private volume = 1;
  private muted = false;
  private rgMode: ReplayGainMode = 'off';
  private fade = 1;
  private handoffTimer: ReturnType<typeof setTimeout> | null = null;
  /** The next segment failed to preload: not tried again on standby; the advance loads it. */
  private failedPreload: Segment | null = null;
  private pausedAt: number | null = null;
  private ctx: AudioContextLike | null = null;
  private ctxTried = false;
  private readonly listeners = new Set<(s: EngineSnapshot) => void>();
  private readonly cleanups: Array<() => void> = [];
  private readonly opts: Required<Omit<EngineOptions, 'createAudioContext' | 'userAgent'>> & {
    createAudioContext: EngineOptions['createAudioContext'] | undefined;
    userAgent: string | undefined;
  };
  private hooks: EngineHooks = {};

  constructor(options: EngineOptions = {}) {
    this.opts = {
      createElement: options.createElement ?? (() => new Audio() as unknown as AudioLike),
      streamUrl: options.streamUrl ?? defaultStreamUrl,
      createAudioContext: options.createAudioContext,
      maxBitrateKbps: options.maxBitrateKbps ?? (() => 0),
      userAgent: options.userAgent,
      preloadAheadMs: options.preloadAheadMs ?? 30_000,
      handoffWindowMs: options.handoffWindowMs ?? 1_500,
      probe: options.probe ?? probeStream,
      now: options.now ?? Date.now,
    };
    this.decks = [this.makeDeck(), this.makeDeck()];
    this.decks.forEach((d) => this.wire(d));
  }

  setHooks(hooks: EngineHooks): void {
    this.hooks = hooks;
  }

  subscribe(listener: (s: EngineSnapshot) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  // ------------------------------------------------------------------ state

  private get deck(): Deck {
    return this.decks[this.active]!;
  }

  private get standby(): Deck {
    return this.decks[1 - this.active]!;
  }

  get current(): PlayableItem | null {
    return this.item;
  }

  get isPlaying(): boolean {
    return this.wantPlay;
  }

  get positionMs(): number {
    const d = this.deck;
    if (!d.seg) return 0;
    const part = d.seg.item.parts[d.seg.partIndex]!;
    const localMs = d.pendingSeekS !== null ? d.pendingSeekS * 1000 : d.offsetMs + (Number.isFinite(d.el.currentTime) ? d.el.currentTime : 0) * 1000;
    return positionIn(part, localMs);
  }

  snapshot(): EngineSnapshot {
    return {
      item: this.item,
      partIndex: this.deck.seg?.partIndex ?? 0,
      positionMs: this.positionMs,
      durationMs: this.item?.durationMs ?? 0,
      playing: this.wantPlay,
      buffering: this.buffering,
      error: this.error,
      stream: this.deck.stream,
    };
  }

  private emit(): void {
    const s = this.snapshot();
    for (const l of this.listeners) l(s);
    this.hooks.onStateChange?.(s);
  }

  // ------------------------------------------------------------------ decks

  private makeDeck(): Deck {
    const el = this.opts.createElement();
    el.preload = 'auto';
    return { el, seg: null, stream: null, offsetMs: 0, pendingSeekS: null, forceTranscode: false, gain: null, wired: false, srcToken: 0 };
  }

  private wire(deck: Deck): void {
    const on = (type: string, fn: () => void) => {
      deck.el.addEventListener(type, fn);
      this.cleanups.push(() => deck.el.removeEventListener(type, fn));
    };
    on('loadedmetadata', () => {
      if (deck.pendingSeekS !== null) {
        const s = deck.pendingSeekS;
        deck.pendingSeekS = null;
        try {
          deck.el.currentTime = s;
        } catch {
          // Some browsers refuse seeks before data; the position stays at 0.
        }
      }
    });
    on('timeupdate', () => {
      if (deck !== this.deck) return;
      this.onTick();
      this.emit();
    });
    on('waiting', () => {
      if (deck !== this.deck) return;
      this.buffering = true;
      this.emit();
    });
    on('playing', () => {
      if (deck !== this.deck) return;
      this.buffering = false;
      this.error = null;
      this.emit();
    });
    on('canplay', () => {
      if (deck !== this.deck || !this.buffering) return;
      this.buffering = false;
      this.emit();
    });
    on('ended', () => {
      if (deck !== this.deck) return;
      this.handoff();
    });
    on('error', () => this.onError(deck));
  }

  private transcodeTarget(): 'opus' | 'aac' {
    return preferredTranscode(this.deck.el, this.opts.userAgent);
  }

  /** Point a deck at a segment, `localMs` into its file. */
  private place(deck: Deck, seg: Segment, localMs: number): void {
    const part = seg.item.parts[seg.partIndex]!;
    const choice = chooseStream(part, {
      playable: canPlayPart(deck.el, part),
      transcodeTo: this.transcodeTarget(),
      maxBitrateKbps: this.opts.maxBitrateKbps(),
      forceTranscode: deck.forceTranscode,
    });
    deck.seg = seg;
    deck.stream = { ...choice, sourceLabel: codecLabel(part) };
    deck.srcToken += 1;
    const local = part.durationMs > 0 ? clamp(localMs, 0, part.durationMs) : Math.max(0, localMs);
    if (choice.transcoded) {
      deck.offsetMs = local;
      deck.pendingSeekS = null;
      deck.el.src = this.opts.streamUrl(part.fileId, { format: choice.format, bitrateKbps: choice.bitrateKbps ?? undefined, startMs: local });
    } else {
      deck.offsetMs = 0;
      deck.pendingSeekS = local > 0 ? local / 1000 : null;
      deck.el.src = this.opts.streamUrl(part.fileId, { format: 'original' });
    }
    deck.el.playbackRate = this.speed;
    deck.el.preservesPitch = true;
    this.applyLevel(deck);
  }

  private clearDeck(deck: Deck): void {
    deck.srcToken += 1;
    deck.el.pause();
    deck.seg = null;
    deck.stream = null;
    deck.pendingSeekS = null;
    deck.offsetMs = 0;
    deck.forceTranscode = false;
    try {
      deck.el.removeAttribute('src');
      deck.el.load();
    } catch {
      // Nothing to unload.
    }
  }

  private applyLevel(deck: Deck): void {
    const level = outputLevel(
      { volume: this.volume, muted: this.muted, replayGain: replayGainFactor(deck.seg?.item, this.rgMode), fade: this.fade },
      deck.gain !== null,
    );
    if (deck.gain) {
      deck.el.volume = 1;
      deck.gain.gain.value = level;
    } else {
      deck.el.volume = level;
    }
  }

  private applyAll(): void {
    this.decks.forEach((d) => {
      d.el.playbackRate = this.speed;
      d.el.preservesPitch = true;
      this.applyLevel(d);
    });
  }

  /** Web Audio is set up on the first play (it needs a user gesture). */
  private ensureAudioGraph(): void {
    if (this.ctxTried) {
      if (this.ctx && this.ctx.state === 'suspended') void this.ctx.resume().catch(() => undefined);
      return;
    }
    this.ctxTried = true;
    const factory = this.opts.createAudioContext;
    if (factory === null || factory === undefined) return;
    const ctx = factory();
    if (!ctx) return;
    try {
      for (const d of this.decks) {
        const source = ctx.createMediaElementSource(d.el);
        const gain = ctx.createGain();
        source.connect(gain);
        gain.connect(ctx.destination);
        d.gain = gain;
      }
      this.ctx = ctx;
      if (ctx.state === 'suspended') void ctx.resume().catch(() => undefined);
    } catch {
      this.decks.forEach((d) => (d.gain = null));
    }
    this.applyAll();
  }

  private startElement(deck: Deck): void {
    try {
      const p = deck.el.play();
      if (p && typeof (p as Promise<void>).catch === 'function') {
        (p as Promise<void>).catch((err: unknown) => {
          if (deck !== this.deck) return;
          // NotAllowedError: the browser wants a gesture first. AbortError: a newer src replaced this one.
          if (err instanceof Error && err.name === 'AbortError') return;
          this.wantPlay = false;
          this.error = 'blocked';
          this.emit();
        });
      }
    } catch {
      this.wantPlay = false;
      this.error = 'blocked';
    }
  }

  // ------------------------------------------------------------------ next segment

  /** What plays after the active deck: the item's next file, else the queue's next item. */
  private expectedNext(): Segment | null {
    const seg = this.deck.seg;
    if (!seg) return null;
    if (seg.partIndex + 1 < seg.item.parts.length) return { item: seg.item, partIndex: seg.partIndex + 1 };
    return this.nextItem ? { item: this.nextItem, partIndex: 0 } : null;
  }

  private preloadNext(): void {
    const want = this.expectedNext();
    const sb = this.standby;
    if (!want) {
      if (sb.seg) this.clearDeck(sb);
      return;
    }
    if (sameSeg(sb.seg, want)) return;
    // It failed on standby once: leave it to the advance, which can still fall back to a transcode.
    if (sameSeg(this.failedPreload, want)) return;
    sb.forceTranscode = false;
    this.place(sb, want, 0);
  }

  /** The active file's length as the element reports it (ms), or null while unknown (live transcodes). */
  private elementDurationMs(d: Deck): number | null {
    const s = d.el.duration;
    if (!Number.isFinite(s) || s <= 0) return null;
    return d.offsetMs + s * 1000;
  }

  /**
   * The active file's length and whether a timer may end it: only when the element knows the
   * length and it is not meaningfully longer than the library's (that would cut the file short).
   */
  private partLength(): { durationMs: number; timed: boolean } {
    const d = this.deck;
    if (!d.seg) return { durationMs: Infinity, timed: false };
    const db = d.seg.item.parts[d.seg.partIndex]!.durationMs;
    const el = this.elementDurationMs(d);
    if (el === null) return { durationMs: db > 0 ? db : Infinity, timed: false };
    return { durationMs: el, timed: db <= 0 || el <= db + DURATION_TOLERANCE_MS };
  }

  private remainingInPartMs(): number {
    const d = this.deck;
    if (!d.seg) return Infinity;
    const part: PlayablePart = d.seg.item.parts[d.seg.partIndex]!;
    const local = this.positionMs - part.startMs;
    return (this.partLength().durationMs - local) / this.speed;
  }

  private onTick(): void {
    if (!this.wantPlay) return;
    const left = this.remainingInPartMs();
    if (left <= this.opts.preloadAheadMs) this.preloadNext();
    if (!this.partLength().timed) return;
    if (left <= this.opts.handoffWindowMs && this.handoffTimer === null && this.standby.seg && sameSeg(this.standby.seg, this.expectedNext())) {
      this.handoffTimer = setTimeout(() => {
        this.handoffTimer = null;
        this.handoff();
      }, Math.max(0, left));
    }
  }

  private cancelHandoff(): void {
    if (this.handoffTimer !== null) clearTimeout(this.handoffTimer);
    this.handoffTimer = null;
  }

  /** The active deck ran out: switch to the standby deck (or load the next segment now). */
  private handoff(): void {
    this.cancelHandoff();
    const old = this.deck;
    const oldSeg = old.seg;
    if (!oldSeg) return;
    const want = this.expectedNext();
    if (!want) {
      // End of the queue.
      this.wantPlay = false;
      this.buffering = false;
      old.el.pause();
      this.emit();
      this.hooks.onQueueEnd?.();
      return;
    }
    const sb = this.standby;
    if (!sameSeg(sb.seg, want)) this.place(sb, want, 0);
    this.failedPreload = null;
    this.active = 1 - this.active;
    if (this.wantPlay) this.startElement(sb);
    this.clearDeck(old);
    // A new play of an item (the queue's next one, or the same one again on repeat-one).
    const advanced = want.item !== oldSeg.item || want.partIndex === 0;
    this.item = want.item;
    if (advanced) {
      this.nextItem = null;
      this.hooks.onAdvance?.(want.item);
    }
    this.preloadNext();
    this.emit();
  }

  private onError(deck: Deck): void {
    if (!deck.seg) return;
    if (deck !== this.deck) {
      // The preload failed: remember it so the next ticks do not retry (and flip to a transcode)
      // every quarter second. The advance loads it on the active deck and handles it there.
      this.failedPreload = deck.seg;
      this.clearDeck(deck);
      return;
    }
    const code = deck.el.error?.code ?? 0;
    const decodeIssue = code === MEDIA_ERR_SRC_NOT_SUPPORTED || code === MEDIA_ERR_DECODE;
    const seg = deck.seg;
    const at = this.positionMs - seg.item.parts[seg.partIndex]!.startMs;
    const token = deck.srcToken;
    // Browsers report a 403/404/503 answer as "source not supported" too: ask the server first.
    this.buffering = true;
    this.emit();
    void this.opts
      .probe(deck.el.src)
      .catch(() => null)
      .then((status) => {
        if (token !== deck.srcToken || deck !== this.deck || deck.seg !== seg) return;
        this.resolveError(deck, decodeIssue, status, at);
      });
  }

  private resolveError(deck: Deck, decodeIssue: boolean, status: number | null, atMs: number): void {
    const refused = status !== null && (status === 0 || status >= 400);
    if (!refused && decodeIssue && deck.seg && deck.stream && !deck.stream.transcoded && !deck.forceTranscode) {
      // The browser claimed it could play the file and then could not: ask for a transcode.
      deck.forceTranscode = true;
      this.place(deck, deck.seg, atMs);
      if (this.wantPlay) this.startElement(deck);
      this.emit();
      return;
    }
    this.wantPlay = false;
    this.buffering = false;
    if (refused) this.error = status === 503 || status === 429 ? 'busy' : 'network';
    else this.error = decodeIssue ? 'unsupported' : 'network';
    this.emit();
  }

  // ------------------------------------------------------------------ public controls

  /** Start an item `startMs` into its timeline. */
  load(item: PlayableItem, startMs = 0, autoplay = true): void {
    this.cancelHandoff();
    this.failedPreload = null;
    this.pausedAt = autoplay ? null : this.opts.now();
    this.clearDeck(this.standby);
    const d = this.deck;
    d.forceTranscode = false;
    this.item = item;
    this.error = null;
    this.buffering = autoplay;
    const at = locate(item, startMs);
    this.place(d, { item, partIndex: at.partIndex }, at.localMs);
    this.wantPlay = autoplay;
    if (autoplay) {
      this.ensureAudioGraph();
      this.startElement(d);
    } else {
      d.el.pause();
    }
    this.emit();
  }

  /** What the queue plays after the current item (null: nothing); preloaded near the end. */
  setNext(item: PlayableItem | null): void {
    this.nextItem = item;
    const sb = this.standby;
    if (sb.seg && !sameSeg(sb.seg, this.expectedNext())) this.clearDeck(sb);
    if (this.wantPlay && this.remainingInPartMs() <= this.opts.preloadAheadMs) this.preloadNext();
  }

  play(): void {
    const d = this.deck;
    if (!d.seg) return;
    // A live transcode paused for long was dropped by the server (it kills stalled ones): ask
    // for it again from here instead of letting the cut-off stream "end" the item.
    if (d.stream?.transcoded && this.pausedAt !== null && this.opts.now() - this.pausedAt > TRANSCODE_RESUME_AFTER_MS) {
      this.place(d, d.seg, this.positionMs - d.seg.item.parts[d.seg.partIndex]!.startMs);
    }
    this.pausedAt = null;
    this.wantPlay = true;
    this.error = null;
    this.ensureAudioGraph();
    this.startElement(this.deck);
    this.emit();
  }

  pause(): void {
    this.wantPlay = false;
    this.pausedAt = this.opts.now();
    this.cancelHandoff();
    this.deck.el.pause();
    this.buffering = false;
    this.emit();
  }

  /** Seek on the item timeline (across files for audiobooks). */
  seek(globalMs: number): void {
    const item = this.item;
    const d = this.deck;
    if (!item || !d.seg) return;
    this.cancelHandoff();
    const at = locate(item, globalMs);
    if (at.partIndex === d.seg.partIndex && d.seg.item === item && d.stream && !d.stream.transcoded) {
      if (d.pendingSeekS !== null) d.pendingSeekS = at.localMs / 1000;
      else d.el.currentTime = at.localMs / 1000;
    } else {
      // Another file, or a transcode (no ranges): request the stream from there.
      const keepTranscode = at.partIndex === d.seg.partIndex && d.forceTranscode;
      d.forceTranscode = keepTranscode;
      this.place(d, { item, partIndex: at.partIndex }, at.localMs);
      if (this.wantPlay) this.startElement(d);
      if (!sameSeg(this.standby.seg, this.expectedNext())) this.clearDeck(this.standby);
    }
    this.emit();
  }

  setSpeed(speed: number): void {
    this.speed = clamp(speed, 0.5, 3.5);
    this.applyAll();
    this.emit();
  }

  get playbackSpeed(): number {
    return this.speed;
  }

  setVolume(volume: number): void {
    this.volume = clamp(volume, 0, 1);
    this.decks.forEach((d) => this.applyLevel(d));
  }

  setMuted(muted: boolean): void {
    this.muted = muted;
    this.decks.forEach((d) => this.applyLevel(d));
  }

  setReplayGain(mode: ReplayGainMode): void {
    this.rgMode = mode;
    this.decks.forEach((d) => this.applyLevel(d));
  }

  /** Sleep-timer fade, 0..1. */
  setFade(fade: number): void {
    this.fade = clamp(fade, 0, 1);
    this.decks.forEach((d) => this.applyLevel(d));
  }

  /** Stop and forget the current item. */
  stop(): void {
    this.cancelHandoff();
    this.wantPlay = false;
    this.buffering = false;
    this.clearDeck(this.standby);
    this.clearDeck(this.deck);
    this.item = null;
    this.nextItem = null;
    this.emit();
  }

  destroy(): void {
    this.stop();
    this.cleanups.forEach((c) => c());
    this.cleanups.length = 0;
    this.listeners.clear();
  }

  /** The elements (tests and debugging). */
  get elements(): readonly AudioLike[] {
    return this.decks.map((d) => d.el);
  }

  get activeElement(): AudioLike {
    return this.deck.el;
  }
}
