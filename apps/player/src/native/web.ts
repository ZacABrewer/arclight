import { WebPlugin } from '@capacitor/core';
import type {
  ArclightPlayerPlugin,
  BrowseNode,
  BrowseTree,
  CastState,
  DeviceInfo,
  DownloadRequest,
  DownloadTask,
  LoadOptions,
  NativeSleepTimer,
  NativeTrack,
  PlaybackStatus,
  PlayerErrorCode,
  PlayerInfo,
  PlayerSnapshot,
  RemoteConfig,
  RepeatMode,
  StorageInfo,
  VideoDeviceProfile,
} from './definitions';

/**
 * JS fallback for the ArclightPlayer plugin: one HTMLAudioElement inside the WebView.
 * Used in the browser (`vite dev`) and on a device while the native implementation is a stub.
 * It plays the queue it is given (with repeat), but has no background audio guarantees, no
 * downloads, no car and no cast: `getInfo().features` says so and the UI hides those.
 */
export class ArclightPlayerWeb extends WebPlugin implements ArclightPlayerPlugin {
  private audio: HTMLAudioElement | null = null;
  private tracks: NativeTrack[] = [];
  private index = -1;
  private status: PlaybackStatus = 'idle';
  private rate = 1;
  private volume = 1;
  private repeat: RepeatMode = 'off';
  private error: PlayerSnapshot['error'];
  private lastPositionEmit = 0;
  private sleep: ReturnType<typeof setTimeout> | null = null;
  private sleepEndOfTrack: string | null = null;

  /** Factory for tests (jsdom's HTMLAudioElement does not play). */
  constructor(private readonly createAudio: () => HTMLAudioElement = () => new Audio()) {
    super();
  }

  async getInfo(): Promise<PlayerInfo> {
    return { platform: 'web', version: 'web-fallback', features: { audio: true, downloads: false, car: false, cast: false, sleepTimer: true } };
  }

  // ---- audio ------------------------------------------------------------------------

  private element(): HTMLAudioElement {
    if (this.audio) return this.audio;
    const a = this.createAudio();
    a.preload = 'auto';
    a.addEventListener('playing', () => this.setStatus('playing'));
    a.addEventListener('pause', () => {
      if (this.status === 'playing' || this.status === 'buffering') this.setStatus('paused');
      this.emitPosition(true);
    });
    a.addEventListener('waiting', () => this.setStatus('buffering'));
    a.addEventListener('timeupdate', () => this.emitPosition(false));
    a.addEventListener('seeked', () => this.emitPosition(true));
    a.addEventListener('ended', () => this.onEnded());
    a.addEventListener('error', () => this.onError());
    this.audio = a;
    return a;
  }

  private current(): NativeTrack | null {
    return this.tracks[this.index] ?? null;
  }

  private setStatus(status: PlaybackStatus, error?: PlayerSnapshot['error']): void {
    this.status = status;
    this.error = error;
    const t = this.current();
    this.notifyListeners('state', { status, trackId: t?.id ?? null, index: this.index, ...(error ? { error } : {}) });
  }

  private emitPosition(force: boolean): void {
    const t = this.current();
    const a = this.audio;
    if (!t || !a) return;
    const now = Date.now();
    if (!force && now - this.lastPositionEmit < 900) return;
    this.lastPositionEmit = now;
    this.notifyListeners('position', {
      trackId: t.id,
      index: this.index,
      positionMs: Math.round(a.currentTime * 1000),
      durationMs: this.durationOf(t),
      bufferedMs: this.bufferedMs(),
    });
  }

  private durationOf(t: NativeTrack): number {
    const d = this.audio?.duration;
    return d && Number.isFinite(d) ? Math.round(d * 1000) : t.durationMs;
  }

  private bufferedMs(): number {
    const a = this.audio;
    if (!a || a.buffered.length === 0) return 0;
    try {
      return Math.round(a.buffered.end(a.buffered.length - 1) * 1000);
    } catch {
      return 0;
    }
  }

  private startTrack(index: number, startMs: number, autoplay: boolean, reason: 'auto' | 'skip' | 'load' | 'remote'): void {
    const previous = this.current();
    const t = this.tracks[index];
    if (!t) throw Object.assign(new Error(`No track at index ${index}`), { code: 'invalid' satisfies PlayerErrorCode });
    this.index = index;
    const a = this.element();
    a.src = t.url;
    a.playbackRate = this.rate;
    a.volume = this.volume;
    const seekTo = () => {
      if (startMs > 0) a.currentTime = startMs / 1000;
    };
    if (a.readyState >= 1) seekTo();
    else a.addEventListener('loadedmetadata', seekTo, { once: true });
    this.notifyListeners('trackChanged', { index, trackId: t.id, previousTrackId: previous?.id ?? null, reason });
    this.setStatus(autoplay ? 'loading' : 'paused');
    if (autoplay) void this.tryPlay();
  }

  private async tryPlay(): Promise<void> {
    const a = this.audio;
    if (!a) return;
    try {
      await a.play();
    } catch (e) {
      // Autoplay blocked or an aborted load: stay paused, the user presses play.
      if ((e as DOMException)?.name === 'NotAllowedError') this.setStatus('paused');
    }
  }

  private onEnded(): void {
    const t = this.current();
    if (t && this.sleepEndOfTrack === t.id) {
      this.sleepEndOfTrack = null;
      this.setStatus('paused');
      this.notifyListeners('sleepTimerFired', {});
      return;
    }
    if (this.repeat === 'one') {
      this.startTrack(this.index, 0, true, 'auto');
      return;
    }
    const next = this.index + 1;
    if (next < this.tracks.length) {
      this.startTrack(next, 0, true, 'auto');
    } else if (this.repeat === 'all' && this.tracks.length > 0) {
      this.startTrack(0, 0, true, 'auto');
    } else {
      this.setStatus('ended');
      this.notifyListeners('queueEnded', { trackId: t?.id ?? null });
    }
  }

  private onError(): void {
    const code = this.audio?.error?.code;
    // MEDIA_ERR_NETWORK = 2, MEDIA_ERR_DECODE = 3, MEDIA_ERR_SRC_NOT_SUPPORTED = 4.
    const mapped: PlayerErrorCode = code === 2 ? 'network' : code === 3 || code === 4 ? 'unsupported' : 'unknown';
    this.setStatus('error', { code: mapped, message: this.audio?.error?.message || 'Playback failed' });
  }

  async load(options: LoadOptions): Promise<void> {
    this.tracks = [...options.tracks];
    if (options.rate) this.rate = options.rate;
    if (this.tracks.length === 0) return this.stop();
    this.startTrack(Math.min(Math.max(0, options.startIndex), this.tracks.length - 1), Math.max(0, options.startMs), options.autoplay !== false, 'load');
  }

  async setUpcoming(options: { tracks: NativeTrack[] }): Promise<void> {
    const keep = this.index >= 0 ? this.tracks.slice(0, this.index + 1) : [];
    this.tracks = [...keep, ...options.tracks];
  }

  async play(): Promise<void> {
    if (!this.audio || !this.current()) return;
    if (this.status === 'ended') this.audio.currentTime = 0;
    await this.tryPlay();
  }

  async pause(): Promise<void> {
    this.audio?.pause();
  }

  async seek(options: { positionMs: number }): Promise<void> {
    if (this.audio) this.audio.currentTime = Math.max(0, options.positionMs) / 1000;
  }

  async skipTo(options: { index: number; positionMs?: number }): Promise<void> {
    const playing = this.status === 'playing' || this.status === 'buffering' || this.status === 'loading';
    this.startTrack(options.index, options.positionMs ?? 0, playing, 'skip');
  }

  async setRate(options: { rate: number }): Promise<void> {
    this.rate = options.rate;
    if (this.audio) this.audio.playbackRate = options.rate;
  }

  async setVolume(options: { volume: number }): Promise<void> {
    this.volume = Math.min(1, Math.max(0, options.volume));
    if (this.audio) this.audio.volume = this.volume;
  }

  async setRepeat(options: { mode: RepeatMode }): Promise<void> {
    this.repeat = options.mode;
  }

  async stop(): Promise<void> {
    if (this.audio) {
      this.audio.pause();
      this.audio.removeAttribute('src');
      this.audio.load();
    }
    this.tracks = [];
    this.index = -1;
    this.setStatus('idle');
  }

  async getState(): Promise<PlayerSnapshot> {
    const t = this.current();
    return {
      status: this.status,
      index: this.index,
      trackId: t?.id ?? null,
      positionMs: this.audio ? Math.round(this.audio.currentTime * 1000) : 0,
      durationMs: t ? this.durationOf(t) : 0,
      bufferedMs: this.bufferedMs(),
      rate: this.rate,
      volume: this.volume,
      repeat: this.repeat,
      ...(this.error ? { error: this.error } : {}),
    };
  }

  async configureRemote(_options: RemoteConfig): Promise<void> {
    // The WebView has no lock screen of its own; the web engine's Media Session is not used here.
  }

  async setNowPlayingExtra(_options: { chapterTitle: string | null }): Promise<void> {}

  async setSleepTimer(options: { timer: NativeSleepTimer }): Promise<void> {
    if (this.sleep) clearTimeout(this.sleep);
    this.sleep = null;
    this.sleepEndOfTrack = null;
    const timer = options.timer;
    if (!timer) return;
    if (timer.kind === 'endOfTrack') {
      this.sleepEndOfTrack = timer.trackId;
      return;
    }
    this.sleep = setTimeout(() => {
      this.sleep = null;
      this.audio?.pause();
      this.notifyListeners('sleepTimerFired', {});
    }, Math.max(0, timer.endsAt - Date.now()));
  }

  // ---- downloads (not available in the WebView) ----------------------------------------

  async enqueueDownload(_options: DownloadRequest): Promise<{ task: DownloadTask }> {
    throw this.unimplemented('Downloads need the native app.');
  }
  async pauseDownload(): Promise<void> {
    throw this.unimplemented('Downloads need the native app.');
  }
  async resumeDownload(): Promise<void> {
    throw this.unimplemented('Downloads need the native app.');
  }
  async cancelDownload(): Promise<void> {
    throw this.unimplemented('Downloads need the native app.');
  }
  async listDownloads(): Promise<{ tasks: DownloadTask[] }> {
    return { tasks: [] };
  }
  async deleteDownload(): Promise<void> {}
  async getStorageInfo(): Promise<StorageInfo> {
    return { usedBytes: 0, freeBytes: 0 };
  }
  async setDownloadPolicy(): Promise<void> {}

  // ---- car / cast (not available) --------------------------------------------------------

  async setBrowseTree(_options: BrowseTree): Promise<void> {}
  async answerBrowse(_options: { requestId: string; items: BrowseNode[] }): Promise<void> {}
  async getCastState(): Promise<CastState> {
    return { status: 'unavailable', kind: null };
  }
  async showRoutePicker(): Promise<void> {
    throw this.unimplemented('Casting needs the native app.');
  }
  async endCastSession(): Promise<void> {}

  // ---- video (the app falls back to the web player page) ---------------------------------

  async getDeviceInfo(): Promise<DeviceInfo> {
    return { isTv: false, videoProfile: browserVideoProfile() };
  }
  async playVideo(): Promise<void> {
    throw this.unimplemented('The native video player needs the Android app.');
  }
  async replaceVideoStream(): Promise<void> {
    throw this.unimplemented('The native video player needs the Android app.');
  }
  async closeVideo(): Promise<void> {}
}

/** A conservative profile from what this browser says it can play (`canPlayType`). */
export function browserVideoProfile(video: Pick<HTMLVideoElement, 'canPlayType'> | null = typeof document === 'undefined' ? null : document.createElement('video')): VideoDeviceProfile {
  const can = (type: string) => {
    try {
      return !!video && video.canPlayType(type) !== '';
    } catch {
      return false;
    }
  };
  const containers = ['mp4', 'mov'];
  if (can('video/webm')) containers.push('webm');
  if (can('video/x-matroska') || can('video/webm; codecs="vp9"')) containers.push('mkv');
  const videoCodecs = ['h264'];
  if (can('video/mp4; codecs="hvc1.1.6.L93.B0"') || can('video/mp4; codecs="hev1.1.6.L93.B0"')) videoCodecs.push('hevc');
  if (can('video/mp4; codecs="av01.0.05M.08"')) videoCodecs.push('av1');
  if (can('video/webm; codecs="vp9"')) videoCodecs.push('vp9');
  const audioCodecs = ['aac', 'mp3'];
  if (can('audio/ogg; codecs="opus"') || can('audio/webm; codecs="opus"')) audioCodecs.push('opus');
  if (can('audio/flac')) audioCodecs.push('flac');
  if (can('audio/mp4; codecs="ac-3"')) audioCodecs.push('ac3');
  if (can('audio/mp4; codecs="ec-3"')) audioCodecs.push('eac3');
  return {
    containers,
    videoCodecs,
    hevc10bit: can('video/mp4; codecs="hvc1.2.4.L153.B0"'),
    hdr: [],
    audioCodecs,
    maxAudioChannels: 2,
    maxHeight: 1080,
  };
}
