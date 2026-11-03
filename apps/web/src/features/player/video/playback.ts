import type {
  PlayableItem,
  ProgressBeacon,
  ProgressReport,
  VideoDelivery,
  VideoDeviceProfile,
  VideoHlsHealth,
  VideoHlsRung,
  VideoQuality,
  VideoSession,
  VideoSessionRequest,
} from '@arclight/shared';
import { ProgressReporter, type ReporterSnapshot } from '../progress-reporter.js';
import { lowerCap, rungBelow, rungRank, type HlsEngine, type HlsEngineFactory } from './hls-engine.js';

// The video player's brain, outside React: asks the server for a session (direct play, HLS, or
// a legacy remux/transcode), points the <video> at it, keeps the item's absolute clock (stream
// start + element time), seeks by re-requesting when the stream is not seekable, switches audio /
// burned subtitles / quality the same way, falls back to a safe profile when the browser cannot
// decode the direct file, and reports progress through the shared ProgressReporter.
//
// HLS sessions (playback design §4.6-4.8) play through an HlsEngine (hls.js or native HLS): seeks
// are local, Auto is ABR across the session's rungs, a pinned quality is a fixed level (no new
// session), the server's speed advice caps ABR, and the session is DELETEd when it is left. Direct
// play that keeps stalling switches once to HLS (`avoidDirect`). Stall and startup counts go out
// with the progress reports. Tests drive it with a fake element and a fake engine.

/** The parts of HTMLVideoElement used here. */
export interface VideoElementLike extends EventTarget {
  src: string;
  currentTime: number;
  readonly paused: boolean;
  playbackRate: number;
  volume: number;
  muted: boolean;
  readonly error: { code: number } | null;
  readonly buffered?: { length: number; start(i: number): number; end(i: number): number } | undefined;
  play(): Promise<void> | void;
  pause(): void;
  load(): void;
  removeAttribute(name: string): void;
}

export type VideoErrorCode = 'busy' | 'forbidden' | 'unsupported' | 'network' | 'load';

export interface VideoState {
  /** idle: waiting for start(); loading: asking for a session or the first frames. */
  status: 'idle' | 'loading' | 'ready' | 'ended' | 'error';
  session: VideoSession | null;
  playing: boolean;
  buffering: boolean;
  /** A new stream is being fetched (seek in a live stream, track or quality change). */
  switching: boolean;
  /** Absolute media time. */
  positionMs: number;
  durationMs: number;
  /** The chosen version (media_files.id); null: the server's best. */
  mediaFileId: number | null;
  audioTrack: number | null;
  /** VideoSubtitleTrack.id shown (text: drawn by the page; image: burned in by the server). */
  subtitle: string | null;
  quality: VideoQuality;
  /** HLS: the rung pinned in the quality menu (ABR off); null: Auto. */
  pinnedRung: string | null;
  /** HLS: the rung playing now (null: not known yet, or not HLS). */
  activeRung: string | null;
  /** HLS: the best rung the server can keep up with (ABR is capped here); null: no cap. */
  capRung: string | null;
  /** HLS: rungs can be pinned in place (hls.js); false: a quality change asks for a new session. */
  levelControl: boolean;
  /** HLS: the encoder's last health report. */
  health: VideoHlsHealth | null;
  /** Rebuffers after startup (shorter than 0.5 s are not counted), their total time, click to first frame. */
  stalls: number;
  stallMs: number;
  startupMs: number | null;
  speed: number;
  volume: number;
  muted: boolean;
  error: VideoErrorCode | null;
}

export interface VideoPlaybackDeps {
  item: PlayableItem;
  profile: VideoDeviceProfile;
  requestSession: (body: VideoSessionRequest) => Promise<VideoSession>;
  sendProgress: (itemKey: string, report: ProgressReport) => Promise<unknown>;
  beacon: (body: ProgressBeacon) => boolean;
  deviceId: string;
  deviceName?: string;
  initial?: Partial<Pick<VideoState, 'volume' | 'muted' | 'speed' | 'quality' | 'audioTrack' | 'subtitle' | 'mediaFileId'>>;
  /** The item finished playing to the end. */
  onEnded?: () => void;
  heartbeatMs?: number;
  /** What this browser can play (profile.ts `browserDeliveries`); absent: progressive only. */
  deliveries?: VideoDelivery[];
  /** Plays HLS sessions (without one, HLS is never asked for). */
  hlsEngine?: HlsEngineFactory;
  /** GET the session's signed health URL. */
  fetchHealth?: (url: string) => Promise<VideoHlsHealth>;
  /** DELETE /playback/video/session/:id (the item was left or the session replaced). */
  endSession?: (sessionId: string) => void;
  /** Last measured throughput (kbit/s) for the next session, and where to keep the new one. */
  bandwidth?: { read: () => number | null; write: (kbps: number | null) => void };
  healthMs?: number;
  now?: () => number;
}

/** Plays almost anywhere: what a direct file that will not decode falls back to. */
export const SAFE_PROFILE: VideoDeviceProfile = {
  containers: ['mp4'],
  videoCodecs: ['h264'],
  hevc10bit: false,
  hdr: [],
  audioCodecs: ['aac'],
  maxAudioChannels: 2,
  maxHeight: 1080,
};

export const SPEEDS = [0.5, 0.75, 1, 1.25, 1.5, 2] as const;
export const QUALITIES: readonly VideoQuality[] = ['auto', 'original', '1080p', '720p', '480p'];

const MEDIA_ERR_ABORTED = 1;

/** Health poll while an HLS session plays. */
export const HEALTH_MS = 10_000;
/** Rebuffers shorter than this are not counted (§8.3). */
export const STALL_MIN_MS = 500;
/** Direct play guard (§4.8): two rebuffers within this window, or one longer than STALL_LONG_MS. */
export const STALL_WINDOW_MS = 60_000;
export const STALL_LONG_MS = 3_000;

const RUNG_QUALITY: Record<string, VideoQuality> = { src: 'original', '1080': '1080p', '720': '720p', '480': '480p' };

/** The stored quality a rung stands for; null for rungs the quality setting has no value for (2160, 360). */
export function qualityForRung(id: string | null): VideoQuality | null {
  return id === null ? 'auto' : (RUNG_QUALITY[id] ?? null);
}

/** The rung a quality setting pins: Original = the source rung (else the best); 1080p = 1080 or the best below. */
export function rungForQuality(q: VideoQuality, rungs: readonly VideoHlsRung[]): string | null {
  if (q === 'auto' || rungs.length === 0) return null;
  if (q === 'original') return rungs.find((r) => r.id === 'src')?.id ?? rungs[0]!.id;
  const h = Number.parseInt(q, 10);
  return rungs.find((r) => r.id !== 'src' && r.height <= h)?.id ?? rungs[rungs.length - 1]!.id;
}

function errorCode(err: unknown): VideoErrorCode {
  const status = (err as { status?: number } | null)?.status;
  if (status === 429 || status === 503) return 'busy';
  if (status === 401 || status === 403) return 'forbidden';
  if (status === 415) return 'unsupported';
  if (status === undefined) return 'network';
  return 'load';
}

export class VideoPlayback {
  private readonly deps: VideoPlaybackDeps;
  private el: VideoElementLike | null = null;
  private state: VideoState;
  private readonly listeners = new Set<() => void>();
  private readonly reporter: ProgressReporter;
  /** Latest session request wins (rapid seeks). */
  private token = 0;
  /** Seek inside a direct (seekable) stream once its metadata is in. */
  private pendingSeekSec: number | null = null;
  /** Keep playing after a stream swap. */
  private wantPlay = true;
  /** Element errors in a row (reset by playback): 1st retries in place, 2nd falls back to SAFE_PROFILE. */
  private failures = 0;
  private useSafeProfile = false;
  private disposed = false;
  private readonly unbind: Array<() => void> = [];
  /** HLS engine of the current session. */
  private engine: HlsEngine | null = null;
  private healthTimer: ReturnType<typeof setInterval> | null = null;
  /** Direct play stalled: the next session asks for HLS (once per item, §4.8). */
  private avoidDirect = false;
  private guardUsed = false;
  /** Start times of recent rebuffers during direct play (guard window). */
  private recentStalls: number[] = [];
  private stallStart: number | null = null;
  private stallTimer: ReturnType<typeof setTimeout> | null = null;
  /** A seek or stream swap is in flight: its waiting is not a stall. */
  private seeking = false;
  private startedAt: number | null = null;
  private readonly now: () => number;

  constructor(deps: VideoPlaybackDeps) {
    this.deps = deps;
    this.now = deps.now ?? (() => Date.now());
    const init = deps.initial ?? {};
    this.state = {
      status: 'idle',
      session: null,
      playing: false,
      buffering: false,
      switching: false,
      positionMs: 0,
      durationMs: deps.item.durationMs,
      mediaFileId: init.mediaFileId ?? null,
      audioTrack: init.audioTrack ?? null,
      subtitle: init.subtitle ?? null,
      quality: init.quality ?? 'auto',
      pinnedRung: null,
      activeRung: null,
      capRung: null,
      levelControl: false,
      health: null,
      stalls: 0,
      stallMs: 0,
      startupMs: null,
      speed: init.speed ?? 1,
      volume: init.volume ?? 1,
      muted: init.muted ?? false,
      error: null,
    };
    this.reporter = new ProgressReporter({
      read: () => this.snapshot(),
      send: deps.sendProgress,
      beacon: deps.beacon,
      deviceId: deps.deviceId,
      ...(deps.deviceName ? { deviceName: deps.deviceName } : {}),
      ...(deps.heartbeatMs ? { heartbeatMs: deps.heartbeatMs } : {}),
    });
  }

  // ---- store -------------------------------------------------------------------------

  subscribe = (fn: () => void): (() => void) => {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  };

  getState = (): VideoState => this.state;

  private set(patch: Partial<VideoState>): void {
    this.state = { ...this.state, ...patch };
    for (const fn of this.listeners) fn();
  }

  get item(): PlayableItem {
    return this.deps.item;
  }

  private snapshot(): ReporterSnapshot | null {
    const s = this.state;
    if (!s.session) return null;
    return {
      itemKey: this.deps.item.itemKey,
      positionMs: s.positionMs,
      durationMs: s.durationMs,
      speed: s.speed,
      playing: s.playing,
      playMethod: s.session.method === 'direct' ? 'DirectPlay' : 'Transcode',
      stats: { stalls: s.stalls, stallMs: s.stallMs, startupMs: s.startupMs },
    };
  }

  // ---- element -----------------------------------------------------------------------

  attach(el: VideoElementLike): void {
    if (this.el === el) return;
    this.detachElement();
    this.el = el;
    el.volume = this.state.volume;
    el.muted = this.state.muted;
    const on = (type: string, fn: () => void) => {
      el.addEventListener(type, fn);
      this.unbind.push(() => el.removeEventListener(type, fn));
    };
    on('loadedmetadata', () => this.onMetadata());
    on('timeupdate', () => this.syncPosition());
    on('playing', () => {
      this.failures = 0;
      this.endStall();
      this.seeking = false;
      const first = this.reporter.startedKey !== this.deps.item.itemKey;
      const startup = this.state.startupMs === null && this.startedAt !== null ? { startupMs: Math.max(0, this.now() - this.startedAt) } : {};
      this.set({ playing: true, buffering: false, switching: false, status: 'ready', error: null, ...startup });
      if (first) this.reporter.report('start');
      this.reporter.startHeartbeat();
    });
    on('play', () => this.set({ playing: true }));
    on('pause', () => {
      // A pause while swapping streams is not the user's.
      if (this.state.switching) return;
      this.syncPosition();
      this.set({ playing: false });
      this.reporter.report('pause');
      this.reporter.stopHeartbeat();
    });
    on('waiting', () => {
      this.set({ buffering: true });
      this.beginStall();
    });
    on('seeking', () => {
      this.seeking = true;
    });
    on('canplay', () => this.set({ buffering: false }));
    on('ended', () => this.onEnded());
    on('error', () => void this.onElementError());
  }

  // ---- stalls (metrics and the direct play guard) ---------------------------------------

  /** A rebuffer while playing, after startup, not caused by a seek or a stream swap. */
  private beginStall(): void {
    const s = this.state;
    if (this.stallStart !== null || s.startupMs === null || this.seeking || s.switching || !this.wantPlay) return;
    this.stallStart = this.now();
    if (this.guardArmed()) {
      this.stallTimer = setTimeout(() => {
        this.stallTimer = null;
        if (this.stallStart !== null) this.leaveDirect();
      }, STALL_LONG_MS);
    }
  }

  private endStall(): void {
    if (this.stallTimer !== null) clearTimeout(this.stallTimer);
    this.stallTimer = null;
    const start = this.stallStart;
    this.stallStart = null;
    if (start === null) return;
    const ms = this.now() - start;
    if (ms < STALL_MIN_MS) return;
    this.set({ stalls: this.state.stalls + 1, stallMs: this.state.stallMs + ms });
    if (!this.guardArmed()) return;
    this.recentStalls = [...this.recentStalls.filter((t) => start - t <= STALL_WINDOW_MS), start];
    if (this.recentStalls.length >= 2) this.leaveDirect();
  }

  /** §4.8: only for direct play in Auto, when this browser plays HLS, once per item. */
  private guardArmed(): boolean {
    const s = this.state;
    return !this.guardUsed && s.quality === 'auto' && s.session?.method === 'direct' && s.session.delivery !== 'hls' && !!this.deps.hlsEngine && (this.deps.deliveries ?? []).includes('hls');
  }

  /** Direct play starves on this link: ask for HLS at the current place (the ladder takes over). */
  private leaveDirect(): void {
    if (this.guardUsed || this.disposed) return;
    this.guardUsed = true;
    this.avoidDirect = true;
    this.recentStalls = [];
    this.stallStart = null;
    void this.load(this.state.positionMs, { keepPlaying: true });
  }

  private detachElement(): void {
    for (const off of this.unbind.splice(0)) off();
    this.el = null;
  }

  private syncPosition(): void {
    const s = this.state;
    if (!this.el || !s.session || s.switching) return;
    const pos = Math.min(s.durationMs || Infinity, s.session.streamStartMs + this.el.currentTime * 1000);
    if (Number.isFinite(pos) && Math.abs(pos - s.positionMs) >= 1) this.set({ positionMs: Math.max(0, pos) });
  }

  private onMetadata(): void {
    const el = this.el;
    if (!el) return;
    el.playbackRate = this.state.speed;
    if (this.pendingSeekSec !== null && this.pendingSeekSec > 0) {
      try {
        el.currentTime = this.pendingSeekSec;
      } catch {
        // Some browsers refuse before the first frame; timeupdate catches up.
      }
    }
    this.pendingSeekSec = null;
    if (this.wantPlay) this.playElement();
    else this.set({ switching: false, status: 'ready' });
  }

  private playElement(): void {
    const el = this.el;
    if (!el) return;
    try {
      const p = el.play();
      if (p && typeof (p as Promise<void>).catch === 'function') {
        (p as Promise<void>).catch((err: unknown) => {
          // Autoplay refused (no user gesture yet): stay paused and let the play button start it.
          if ((err as { name?: string } | null)?.name === 'NotAllowedError') this.set({ playing: false, switching: false, status: 'ready' });
        });
      }
    } catch {
      // jsdom and old engines: nothing to do.
    }
  }

  private onEnded(): void {
    const s = this.state;
    this.set({ playing: false, status: 'ended', positionMs: s.durationMs || s.positionMs });
    this.reporter.stop();
    this.deps.onEnded?.();
  }

  private async onElementError(): Promise<void> {
    const el = this.el;
    if (!el || !this.state.session || this.disposed) return;
    if (el.error?.code === MEDIA_ERR_ABORTED) return;
    // hls.js reports (and first tries to recover) media errors itself: see onEngineFatal.
    if (this.engine?.kind === 'hlsjs') return;
    await this.recoverFromError();
  }

  /** hls.js gave up on the session (network, decode): the same recovery as an element error. */
  private onEngineFatal(engine: HlsEngine): void {
    if (engine !== this.engine || this.disposed) return;
    void this.recoverFromError();
  }

  private async recoverFromError(): Promise<void> {
    this.failures += 1;
    const at = this.state.positionMs;
    if (this.failures === 1) {
      // A dropped connection or an expired link: the same stream again from here.
      await this.load(at, { keepPlaying: this.wantPlay });
      return;
    }
    if (this.failures === 2 && !this.useSafeProfile) {
      // The browser cannot decode what it said it could: ask for something that plays everywhere.
      this.useSafeProfile = true;
      await this.load(at, { keepPlaying: this.wantPlay });
      return;
    }
    this.set({ status: 'error', error: 'unsupported', playing: false, switching: false });
  }

  // ---- sessions ----------------------------------------------------------------------

  private request(startMs: number): VideoSessionRequest {
    const s = this.state;
    const sub = s.subtitle ? this.deps.item.video?.subtitleTracks.find((x) => x.id === s.subtitle) : undefined;
    const deliveries = this.deps.hlsEngine ? (this.deps.deliveries ?? []) : [];
    const hint = deliveries.includes('hls') ? (this.engine?.bandwidthKbps() ?? this.deps.bandwidth?.read() ?? null) : null;
    return {
      itemKey: this.deps.item.itemKey as VideoSessionRequest['itemKey'],
      ...(s.mediaFileId !== null ? { mediaFileId: s.mediaFileId } : {}),
      profile: this.useSafeProfile ? SAFE_PROFILE : this.deps.profile,
      ...(s.audioTrack !== null ? { audioTrack: s.audioTrack } : {}),
      // Text subtitles are drawn here; only image subtitles go to the server (to burn in).
      ...(sub && !sub.text ? { subtitle: sub.id } : {}),
      ...(startMs > 0 ? { startMs: Math.floor(startMs) } : {}),
      quality: s.quality,
      ...(deliveries.length ? { deliveries, deviceKey: this.deps.deviceId.slice(0, 64) } : {}),
      ...(hint !== null ? { bandwidthKbps: Math.max(1, Math.round(hint)) } : {}),
      ...(this.avoidDirect ? { avoidDirect: true } : {}),
    };
  }

  /** Start (or restart) the item at `startMs`. */
  async start(startMs = 0): Promise<void> {
    this.wantPlay = true;
    this.startedAt ??= this.now();
    await this.load(startMs, { keepPlaying: true, first: true });
  }

  private async load(startMs: number, opts: { keepPlaying: boolean; first?: boolean }): Promise<void> {
    const token = ++this.token;
    const at = Math.max(0, Math.min(startMs, Math.max(0, (this.state.durationMs || Infinity) - 1000)));
    this.wantPlay = opts.keepPlaying;
    this.set({ ...(opts.first ? { status: 'loading' as const } : {}), switching: !opts.first, error: null, positionMs: at, buffering: true });
    this.seeking = true;
    let session: VideoSession;
    try {
      session = await this.deps.requestSession(this.request(at));
    } catch (err) {
      if (token !== this.token || this.disposed) return;
      this.set({ status: 'error', error: errorCode(err), switching: false, buffering: false, playing: false });
      return;
    }
    if (token !== this.token || this.disposed) return;
    const el = this.el;
    const durationMs = session.durationMs || this.deps.item.durationMs;
    const previous = this.state.session;
    this.releaseEngine();
    // The old HLS session's encoder and slot go now (the server would also replace it by device).
    if (previous?.sessionId && previous.sessionId !== session.sessionId) this.deps.endSession?.(previous.sessionId);
    const hls = session.delivery === 'hls' && session.hls && this.deps.hlsEngine ? session.hls : null;
    const pinned = hls ? this.pinFor(hls.rungs) : null;
    this.set({
      session,
      durationMs,
      audioTrack: session.audioTrack,
      mediaFileId: this.state.mediaFileId ?? session.mediaFileId,
      // An image subtitle the server could not burn in is dropped.
      ...(this.state.subtitle && session.burnedSubtitle === null && !session.subtitles.some((x) => x.id === this.state.subtitle) ? { subtitle: null } : {}),
      pinnedRung: pinned,
      activeRung: null,
      capRung: null,
      levelControl: false,
      health: null,
    });
    if (!el) return;
    // Direct play: the file starts at 0 and seeks itself. Live streams start where we asked.
    // HLS: media time, so the place is the element's own time (streamStartMs is 0).
    this.pendingSeekSec = session.seekable ? at / 1000 : Math.max(0, (at - session.streamStartMs) / 1000) || null;
    if (!hls) {
      el.src = session.url;
      el.load();
      return;
    }
    let engine: HlsEngine | null = null;
    try {
      engine = await this.deps.hlsEngine!(el, {
        url: hls.masterUrl,
        startSec: at / 1000,
        rungs: hls.rungs,
        startRung: pinned ?? hls.startRung,
        pinned,
        bandwidthKbps: this.deps.bandwidth?.read() ?? null,
        onRung: (id) => {
          if (engine && this.engine === engine) this.set({ activeRung: id });
        },
        onAdvice: (id) => {
          if (engine && this.engine === engine) this.applyCap(id);
        },
        onUnsustainable: (id) => {
          if (engine && this.engine === engine) this.onUnsustainable(id);
        },
        onFatal: () => {
          if (engine) this.onEngineFatal(engine);
        },
      });
    } catch (err) {
      if (token !== this.token || this.disposed) return;
      this.set({ status: 'error', error: errorCode(err), switching: false, buffering: false, playing: false });
      return;
    }
    if (token !== this.token || this.disposed) {
      engine.destroy();
      return;
    }
    this.engine = engine;
    if (engine.handlesStart) this.pendingSeekSec = null;
    this.set({ levelControl: engine.controllable });
    this.startHealth(hls.healthUrl);
  }

  /** The rung to pin in a new HLS session: the one pinned before (when offered), else the stored quality's. */
  private pinFor(rungs: readonly VideoHlsRung[]): string | null {
    const s = this.state;
    if (s.pinnedRung !== null && rungs.some((r) => r.id === s.pinnedRung)) return s.pinnedRung;
    return rungForQuality(s.quality, rungs);
  }

  private hlsRungs(): readonly VideoHlsRung[] {
    return this.state.session?.hls?.rungs ?? [];
  }

  /** Never let ABR above `id` (the lower of what is already capped and the new advice wins). */
  private applyCap(id: string | null): void {
    const rungs = this.hlsRungs();
    if (id !== null && rungRank(rungs, id) < 0) return;
    const cap = lowerCap(rungs, this.state.capRung, id);
    if (cap === this.state.capRung) return;
    this.set({ capRung: cap });
    this.engine?.cap(cap);
  }

  /** 409 on a rung: cap below it; a pin on or above it moves down too (the server will not encode it). */
  private onUnsustainable(id: string): void {
    const rungs = this.hlsRungs();
    const below = rungBelow(rungs, id);
    if (!below) return;
    this.applyCap(below);
    if (this.state.pinnedRung !== null && rungRank(rungs, this.state.pinnedRung) <= rungRank(rungs, id)) {
      this.set({ pinnedRung: below });
      this.engine?.pin(below);
    }
  }

  private startHealth(url: string): void {
    this.stopHealth();
    const fetchHealth = this.deps.fetchHealth;
    if (!fetchHealth || !url) return;
    const engine = this.engine;
    const tick = () => {
      fetchHealth(url)
        .then((h) => {
          if (this.engine !== engine || this.disposed) return;
          this.set({ health: h });
          if (h.maxSustainableRung) this.applyCap(h.maxSustainableRung);
          this.deps.bandwidth?.write(engine?.bandwidthKbps() ?? null);
        })
        .catch(() => undefined);
    };
    tick();
    this.healthTimer = setInterval(tick, this.deps.healthMs ?? HEALTH_MS);
  }

  private stopHealth(): void {
    if (this.healthTimer !== null) clearInterval(this.healthTimer);
    this.healthTimer = null;
  }

  /** Drop the HLS engine (keeping its bandwidth estimate for the next session). */
  private releaseEngine(): void {
    this.stopHealth();
    const engine = this.engine;
    this.engine = null;
    if (!engine) return;
    this.deps.bandwidth?.write(engine.bandwidthKbps());
    engine.destroy();
  }

  // ---- controls ----------------------------------------------------------------------

  play = (): void => {
    this.wantPlay = true;
    if (this.state.status === 'ended') {
      void this.seek(0);
      return;
    }
    this.playElement();
  };

  pause = (): void => {
    this.wantPlay = false;
    this.el?.pause();
  };

  toggle = (): void => {
    if (this.state.playing) this.pause();
    else this.play();
  };

  /** Jump to an absolute media time: in place when the stream allows it, else a new stream from there. */
  seek = async (ms: number): Promise<void> => {
    const s = this.state;
    if (!s.session) return;
    const target = Math.max(0, Math.min(ms, Math.max(0, s.durationMs - 500)));
    const el = this.el;
    const local = (target - s.session.streamStartMs) / 1000;
    if (el && (s.session.seekable || (local >= 0 && inBuffered(el, local)))) {
      this.seeking = true;
      el.currentTime = local;
      this.set({ positionMs: target, ...(s.status === 'ended' ? { status: 'ready' as const } : {}) });
      if (s.status === 'ended') this.playElement();
    } else {
      const token = this.token + 1;
      await this.load(target, { keepPlaying: this.wantPlay || s.status === 'ended' });
      // Left the item (its `stop` is sent) or a newer seek / switch took over: no stale report.
      if (this.disposed || token !== this.token) return;
    }
    this.reporter.report('seek', { positionMs: target });
  };

  skip = (deltaMs: number): Promise<void> => this.seek(this.state.positionMs + deltaMs);

  setAudioTrack = async (index: number): Promise<void> => {
    if (index === this.state.audioTrack) return;
    this.set({ audioTrack: index });
    // Browsers cannot switch audio tracks of a file reliably: always a new stream with that track.
    await this.load(this.state.positionMs, { keepPlaying: this.wantPlay });
  };

  setSubtitle = async (id: string | null): Promise<void> => {
    const s = this.state;
    if (id === s.subtitle) return;
    const track = id ? this.deps.item.video?.subtitleTracks.find((x) => x.id === id) : undefined;
    const wasBurned = s.session?.burnedSubtitle != null;
    this.set({ subtitle: id });
    // Image subtitles are burned in by the server; leaving a burned one needs a clean stream.
    if ((track && !track.text) || wasBurned) await this.load(s.positionMs, { keepPlaying: this.wantPlay });
  };

  setQuality = async (quality: VideoQuality): Promise<void> => {
    const s = this.state;
    if (this.engine?.controllable && s.session?.delivery === 'hls') {
      // HLS: Auto is ABR, a quality is a fixed level of this session (no new session).
      const rung = rungForQuality(quality, this.hlsRungs());
      if (quality === s.quality && rung === s.pinnedRung) return;
      this.set({ quality, pinnedRung: rung });
      this.engine.pin(rung);
      return;
    }
    if (quality === s.quality) return;
    this.set({ quality, pinnedRung: null });
    await this.load(this.state.positionMs, { keepPlaying: this.wantPlay });
  };

  /** HLS quality menu: pin one of the session's rungs (null: Auto). */
  setRung = async (id: string | null): Promise<void> => {
    const s = this.state;
    if (!this.engine?.controllable || s.session?.delivery !== 'hls') {
      await this.setQuality(qualityForRung(id) ?? s.quality);
      return;
    }
    if (id !== null && rungRank(this.hlsRungs(), id) < 0) return;
    if (id === s.pinnedRung) return;
    this.set({ pinnedRung: id, quality: qualityForRung(id) ?? s.quality });
    this.engine.pin(id);
  };

  /** Another version of the item (4K / 1080p, editions). */
  setVersion = async (mediaFileId: number): Promise<void> => {
    if (mediaFileId === this.state.mediaFileId) return;
    this.set({ mediaFileId, audioTrack: null });
    await this.load(this.state.positionMs, { keepPlaying: this.wantPlay });
  };

  setSpeed = (speed: number): void => {
    this.set({ speed });
    if (this.el) this.el.playbackRate = speed;
  };

  setVolume = (volume: number): void => {
    const v = Math.max(0, Math.min(1, volume));
    this.set({ volume: v, muted: v === 0 ? this.state.muted : false });
    if (this.el) {
      this.el.volume = v;
      if (v > 0) this.el.muted = false;
    }
  };

  setMuted = (muted: boolean): void => {
    this.set({ muted });
    if (this.el) this.el.muted = muted;
  };

  toggleMute = (): void => this.setMuted(!this.state.muted);

  /** Try again after an error. */
  retry = (): Promise<void> => {
    this.failures = 0;
    return this.load(this.state.positionMs, { keepPlaying: true, first: !this.state.session });
  };

  // ---- lifecycle ---------------------------------------------------------------------

  /** Tab hidden or closed: save the place with sendBeacon. */
  onHidden(): void {
    if (this.state.session) this.reporter.beacon(this.state.playing ? 'progress' : 'pause');
  }

  /** Leave the item: final report, release the stream. */
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.token++;
    this.syncPosition();
    this.reporter.stop();
    this.reporter.dispose();
    if (this.stallTimer !== null) clearTimeout(this.stallTimer);
    this.releaseEngine();
    const sessionId = this.state.session?.sessionId;
    if (sessionId) this.deps.endSession?.(sessionId);
    const el = this.el;
    this.detachElement();
    if (el) {
      try {
        el.pause();
        el.removeAttribute('src');
        el.load();
      } catch {
        // Nothing to release.
      }
    }
    this.listeners.clear();
  }
}

function inBuffered(el: VideoElementLike, sec: number): boolean {
  const b = el.buffered;
  if (!b) return false;
  for (let i = 0; i < b.length; i++) if (sec >= b.start(i) && sec <= b.end(i)) return true;
  return false;
}
