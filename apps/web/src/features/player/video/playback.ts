import type { PlayableItem, ProgressBeacon, ProgressReport, VideoDeviceProfile, VideoQuality, VideoSession, VideoSessionRequest } from '@arclight/shared';
import { ProgressReporter, type ReporterSnapshot } from '../progress-reporter.js';

// The video player's brain, outside React: asks the server for a session (direct play, remux or
// transcode), points the <video> at it, keeps the item's absolute clock (stream start + element
// time), seeks by re-requesting when the stream is not seekable, switches audio / burned
// subtitles / quality the same way, falls back to a safe profile when the browser cannot decode
// the direct file, and reports progress through the shared ProgressReporter. Tests drive it
// with a fake element.

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

  constructor(deps: VideoPlaybackDeps) {
    this.deps = deps;
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
      const first = this.reporter.startedKey !== this.deps.item.itemKey;
      this.set({ playing: true, buffering: false, switching: false, status: 'ready', error: null });
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
    on('waiting', () => this.set({ buffering: true }));
    on('canplay', () => this.set({ buffering: false }));
    on('ended', () => this.onEnded());
    on('error', () => void this.onElementError());
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
    return {
      itemKey: this.deps.item.itemKey as VideoSessionRequest['itemKey'],
      ...(s.mediaFileId !== null ? { mediaFileId: s.mediaFileId } : {}),
      profile: this.useSafeProfile ? SAFE_PROFILE : this.deps.profile,
      ...(s.audioTrack !== null ? { audioTrack: s.audioTrack } : {}),
      // Text subtitles are drawn here; only image subtitles go to the server (to burn in).
      ...(sub && !sub.text ? { subtitle: sub.id } : {}),
      ...(startMs > 0 ? { startMs: Math.floor(startMs) } : {}),
      quality: s.quality,
    };
  }

  /** Start (or restart) the item at `startMs`. */
  async start(startMs = 0): Promise<void> {
    this.wantPlay = true;
    await this.load(startMs, { keepPlaying: true, first: true });
  }

  private async load(startMs: number, opts: { keepPlaying: boolean; first?: boolean }): Promise<void> {
    const token = ++this.token;
    const at = Math.max(0, Math.min(startMs, Math.max(0, (this.state.durationMs || Infinity) - 1000)));
    this.wantPlay = opts.keepPlaying;
    this.set({ ...(opts.first ? { status: 'loading' as const } : {}), switching: !opts.first, error: null, positionMs: at, buffering: true });
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
    this.set({
      session,
      durationMs,
      audioTrack: session.audioTrack,
      mediaFileId: this.state.mediaFileId ?? session.mediaFileId,
      // An image subtitle the server could not burn in is dropped.
      ...(this.state.subtitle && session.burnedSubtitle === null && !session.subtitles.some((x) => x.id === this.state.subtitle) ? { subtitle: null } : {}),
    });
    if (!el) return;
    // Direct play: the file starts at 0 and seeks itself. Live streams start where we asked.
    this.pendingSeekSec = session.seekable ? at / 1000 : Math.max(0, (at - session.streamStartMs) / 1000) || null;
    el.src = session.url;
    el.load();
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
    if (quality === this.state.quality) return;
    this.set({ quality });
    await this.load(this.state.positionMs, { keepPlaying: this.wantPlay });
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
