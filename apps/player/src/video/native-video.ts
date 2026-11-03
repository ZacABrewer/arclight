import type { PluginListenerHandle } from '@capacitor/core';
import type { PlayableItem, PlaybackProgress, ProgressReport, VideoDeviceProfile, VideoSession, VideoSessionRequest } from '@arclight/shared';
import type { OpenVideoOptions } from '@web/features/player/video/video-launcher';
import { audioTrackLabel, episodeCode, resumePoint } from '@web/features/player/video/format';
import { t } from '@web/i18n/index';
import type {
  ArclightPlayerPlugin,
  NativeVideoSubtitle,
  PlayVideoOptions,
  VideoClosedEvent,
  VideoNextEvent,
  VideoProgressEvent,
  VideoSeekRequestEvent,
} from '../native/definitions';

// The app's video launcher on Android: every play button of the Movies & TV pages (through the
// web's `openVideo`) ends here instead of the web player page. It asks the server for a session
// with the device's own decode profile (direct play / remux / transcode), hands the signed
// stream, subtitle links, audio tracks, chapters, skip segments and the next episode to the
// native VideoActivity, and then answers its events:
//
//   videoProgress     → a progress report (offline: the progress queue)
//   videoSeekRequest  → a new session from that point (or with that audio track) → replaceVideoStream
//   videoNext         → stop + "played" for this one, then playVideo for the next (loads in place)
//   videoClosed       → the final report, "played" when it reached the end, refresh the pages
//
// All positions are media time (absolute), as the plugin reports them.

export interface NativeVideoDeps {
  plugin: ArclightPlayerPlugin;
  /** The device's decode profile (getDeviceInfo().videoProfile), asked once. */
  profile: () => Promise<VideoDeviceProfile>;
  fetchItem: (itemKey: string) => Promise<PlayableItem>;
  fetchProgress: (itemKey: string) => Promise<PlaybackProgress | null>;
  requestSession: (body: VideoSessionRequest) => Promise<VideoSession>;
  /** One progress report (the app's sender queues it when offline). */
  sendProgress: (itemKey: string, report: ProgressReport) => Promise<unknown>;
  /** POST /playback/watched for one item. */
  markPlayed: (itemKey: string) => Promise<unknown>;
  /** Pause the music / audiobook player. */
  pauseAudio: () => void;
  /** After the player closed or moved on: refresh continue watching, next up, watched marks. */
  refresh: () => void;
  /** Show a failure (closed with an error, could not start). */
  onError?: (message: string) => void;
  deviceId: string;
  deviceName?: string;
  now?: () => Date;
}

interface Current {
  item: PlayableItem;
  session: VideoSession;
  positionMs: number;
  durationMs: number;
  paused: boolean;
  audioTrack: number | null;
  subtitle: string | null;
  mediaFileId: number | null;
  started: boolean;
}

/** The text subtitle to show at start: the file's default text track, else a forced text one, else off. */
export function defaultSubtitle(item: PlayableItem): string | null {
  const subs = item.video?.subtitleTracks ?? [];
  return subs.find((s) => s.text && s.default)?.id ?? subs.find((s) => s.text && s.forced)?.id ?? null;
}

/** Where to start: Restart → 0, an explicit time, else the saved place when it is worth resuming. */
export function startPosition(opts: OpenVideoOptions, progress: PlaybackProgress | null, durationMs: number): number {
  if (opts.restart) return 0;
  if (opts.startMs !== undefined && opts.startMs > 0) return Math.floor(opts.startMs);
  return resumePoint(progress, durationMs) ?? 0;
}

/** "DIRECT PLAY · 4K HDR10" under the title. */
export function streamInfo(item: PlayableItem, session: VideoSession): string {
  const v = item.video;
  const h = v?.height ?? 0;
  const res = h >= 2000 ? '4K' : h >= 1400 ? '1440p' : h >= 1000 ? '1080p' : h >= 700 ? '720p' : h > 0 ? `${h}p` : null;
  const range = v && v.dynamicRange !== 'sdr' ? ({ dv: 'DV', hlg: 'HLG', hdr10plus: 'HDR10+', hdr10: 'HDR10' } as const)[v.dynamicRange] : null;
  return [t(`player.video.method.${session.method}`), [res, range].filter(Boolean).join(' ')].filter(Boolean).join(' · ');
}

/** The line under the title: "S2 · E5 · Show" for episodes, the year for movies. */
export function itemSubtitle(item: PlayableItem): string | undefined {
  if (item.kind === 'episode') {
    const code = item.seasonNumber != null || item.episodeNumber != null ? episodeCode(item.seasonNumber, item.episodeNumber) : null;
    // The server's own subtitle can be just the code again ("S1:E1"): show it once.
    const norm = (s: string) => s.replace(/[^a-z0-9]/gi, '').toLowerCase();
    const extra = item.context ?? item.subtitle;
    const dup = code && extra && norm(code) === norm(extra);
    return [code, dup ? null : extra].filter(Boolean).join(' · ') || undefined;
  }
  return item.year ? String(item.year) : (item.subtitle ?? undefined);
}

function subtitlesOf(session: VideoSession): NativeVideoSubtitle[] {
  return session.subtitles.map((s) => ({ id: s.id, url: s.url, label: s.label, language: s.language, default: s.default, forced: s.forced }));
}

const httpUrl = (u: string | null | undefined) => (u && /^https?:/i.test(u) ? u : undefined);

export class NativeVideoLauncher {
  private readonly deps: NativeVideoDeps;
  private current: Current | null = null;
  private handles: PluginListenerHandle[] = [];
  private profilePromise: Promise<VideoDeviceProfile> | null = null;
  /** Latest seek request wins. */
  private seekToken = 0;
  private started = false;

  constructor(deps: NativeVideoDeps) {
    this.deps = deps;
  }

  /** Listen to the plugin's video events (once). */
  async start(): Promise<void> {
    if (this.started) return;
    this.started = true;
    const p = this.deps.plugin;
    this.handles = await Promise.all([
      p.addListener('videoProgress', (e) => this.onProgress(e)),
      p.addListener('videoSeekRequest', (e) => void this.onSeekRequest(e)),
      p.addListener('videoNext', (e) => void this.onNext(e)),
      p.addListener('videoClosed', (e) => void this.onClosed(e)),
    ]);
  }

  async stop(): Promise<void> {
    const hs = this.handles.splice(0);
    this.started = false;
    await Promise.all(hs.map((h) => h.remove().catch(() => undefined)));
  }

  /** The item on screen (tests, diagnostics). */
  get playing(): { itemKey: string; positionMs: number; method: VideoSession['method'] } | null {
    const c = this.current;
    return c ? { itemKey: c.item.itemKey, positionMs: c.positionMs, method: c.session.method } : null;
  }

  private profile(): Promise<VideoDeviceProfile> {
    this.profilePromise ??= this.deps.profile().catch((err: unknown) => {
      this.profilePromise = null;
      throw err;
    });
    return this.profilePromise;
  }

  /** The `VideoLauncher` the web pages call (setVideoLauncher). */
  launch = async (itemKey: string, opts: OpenVideoOptions = {}): Promise<void> => {
    this.deps.pauseAudio();
    try {
      await this.open(itemKey, opts);
    } catch (err) {
      this.deps.onError?.(err instanceof Error ? err.message : String(err));
      throw err;
    }
  };

  private request(c: Pick<Current, 'item' | 'audioTrack' | 'subtitle' | 'mediaFileId'>, profile: VideoDeviceProfile, startMs: number): VideoSessionRequest {
    const sub = c.subtitle ? c.item.video?.subtitleTracks.find((s) => s.id === c.subtitle) : undefined;
    return {
      itemKey: c.item.itemKey as VideoSessionRequest['itemKey'],
      ...(c.mediaFileId !== null ? { mediaFileId: c.mediaFileId } : {}),
      profile,
      ...(c.audioTrack !== null ? { audioTrack: c.audioTrack } : {}),
      // Text subtitles are side-loaded by the player; only image ones would need burning in.
      ...(sub && !sub.text ? { subtitle: sub.id } : {}),
      ...(startMs > 0 ? { startMs: Math.floor(startMs) } : {}),
    };
  }

  /** Fetch the item, ask for a session and open the native player (an open one loads it in place). */
  private async open(itemKey: string, opts: OpenVideoOptions): Promise<void> {
    const [item, progress, profile] = await Promise.all([
      this.deps.fetchItem(itemKey),
      opts.restart || (opts.startMs ?? 0) > 0 ? Promise.resolve(null) : this.deps.fetchProgress(itemKey).catch(() => null),
      this.profile(),
    ]);
    if (!item.video) throw new Error(t('player.video.error.load'));
    const startMs = startPosition(opts, progress, item.durationMs);
    const base = {
      item,
      audioTrack: item.video.audioTracks.find((a) => a.default)?.index ?? null,
      subtitle: defaultSubtitle(item),
      mediaFileId: opts.mediaFileId ?? null,
    };
    const session = await this.deps.requestSession(this.request(base, profile, startMs));
    const next = item.next ? await this.deps.fetchItem(item.next).catch(() => null) : null;
    const durationMs = session.durationMs || item.durationMs;
    this.current = {
      ...base,
      session,
      positionMs: startMs,
      durationMs,
      paused: false,
      audioTrack: session.audioTrack,
      mediaFileId: session.mediaFileId,
      // The image subtitle the server could not burn in is dropped; a text one must be in the list.
      subtitle: base.subtitle && session.subtitles.some((s) => s.id === base.subtitle) ? base.subtitle : null,
      started: false,
    };
    const v = item.video;
    const options: PlayVideoOptions = {
      itemKey: item.itemKey,
      url: session.url,
      mimeType: session.mimeType,
      streamStartMs: session.streamStartMs,
      startPositionMs: startMs,
      seekable: session.seekable,
      durationMs,
      title: item.title,
      streamInfo: streamInfo(item, session),
      subtitles: subtitlesOf(session),
      selectedSubtitle: this.current.subtitle,
      audioTracks: v.audioTracks.map((a) => {
        const l = audioTrackLabel(a);
        return { index: a.index, label: l.detail ? `${l.name} · ${l.detail}` : l.name };
      }),
      ...(session.audioTrack !== null && session.audioTrack !== undefined ? { selectedAudio: session.audioTrack } : {}),
      chapters: item.chapters.map((c) => ({ title: c.title, startMs: c.startMs })),
      segments: item.segments ?? [],
    };
    const subtitle = itemSubtitle(item);
    if (subtitle) options.subtitle = subtitle;
    const art = httpUrl(item.artworkUrl);
    if (art) options.artworkUrl = art;
    const backdrop = httpUrl(item.backdropUrl);
    if (backdrop) options.backdropUrl = backdrop;
    if (next) {
      const nextSub = itemSubtitle(next);
      const nextArt = httpUrl(next.artworkUrl) ?? httpUrl(next.backdropUrl);
      options.next = { itemKey: next.itemKey, title: next.title, ...(nextSub ? { subtitle: nextSub } : {}), ...(nextArt ? { artworkUrl: nextArt } : {}) };
    }
    await this.deps.plugin.playVideo(options);
    this.report('start');
    if (this.current) this.current.started = true;
  }

  // ---- reports -------------------------------------------------------------------------

  private report(event: ProgressReport['event'], c: Current | null = this.current): void {
    if (!c) return;
    const body: ProgressReport = {
      event,
      positionMs: Math.max(0, Math.floor(c.positionMs)),
      durationMs: Math.max(0, Math.floor(c.durationMs)),
      speed: 1,
      deviceId: this.deps.deviceId,
      ...(this.deps.deviceName ? { deviceName: this.deps.deviceName } : {}),
      clientTime: (this.deps.now?.() ?? new Date()).toISOString(),
      playMethod: c.session.method === 'direct' ? 'DirectPlay' : 'Transcode',
    };
    void this.deps.sendProgress(c.item.itemKey, body).catch(() => undefined);
  }

  private matches(itemKey: string): Current | null {
    return this.current && this.current.item.itemKey === itemKey ? this.current : null;
  }

  // ---- events --------------------------------------------------------------------------

  private onProgress(e: VideoProgressEvent): void {
    const c = this.matches(e.itemKey);
    if (!c) return;
    const wasPaused = c.paused;
    c.positionMs = e.positionMs;
    if (e.durationMs > 0) c.durationMs = e.durationMs;
    c.paused = e.paused;
    if (e.paused && wasPaused) return; // Nothing moved.
    this.report(e.paused ? 'pause' : 'progress', c);
  }

  private async onSeekRequest(e: VideoSeekRequestEvent): Promise<void> {
    const c = this.matches(e.itemKey);
    if (!c) return;
    const token = ++this.seekToken;
    c.positionMs = e.positionMs;
    if (e.audioTrack !== undefined) c.audioTrack = e.audioTrack;
    if (e.subtitle !== undefined) c.subtitle = e.subtitle;
    let session: VideoSession;
    try {
      session = await this.deps.requestSession(this.request(c, await this.profile(), e.positionMs));
    } catch (err) {
      if (token === this.seekToken) this.deps.onError?.(err instanceof Error ? err.message : String(err));
      return;
    }
    // A newer seek, or the player moved on / closed meanwhile.
    if (token !== this.seekToken || this.current !== c) return;
    c.session = session;
    if (session.audioTrack !== null && session.audioTrack !== undefined) c.audioTrack = session.audioTrack;
    await this.deps.plugin
      .replaceVideoStream({
        url: session.url,
        mimeType: session.mimeType,
        streamStartMs: session.streamStartMs,
        seekable: session.seekable,
        positionMs: e.positionMs,
        subtitles: subtitlesOf(session),
        ...(c.audioTrack !== null ? { selectedAudio: c.audioTrack } : {}),
        streamInfo: streamInfo(c.item, session),
      })
      .catch(() => undefined);
    this.report('seek', c);
  }

  private async onNext(e: VideoNextEvent): Promise<void> {
    const c = this.current;
    if (c) {
      // Up next fires at the credits: this one counts as watched.
      c.positionMs = Math.max(c.positionMs, c.durationMs);
      this.report('stop', c);
      await this.deps.markPlayed(c.item.itemKey).catch(() => undefined);
      this.current = null;
    }
    try {
      await this.open(e.itemKey, {});
    } catch (err) {
      this.deps.onError?.(err instanceof Error ? err.message : String(err));
      await this.deps.plugin.closeVideo().catch(() => undefined);
    } finally {
      this.deps.refresh();
    }
  }

  private async onClosed(e: VideoClosedEvent): Promise<void> {
    const c = this.matches(e.itemKey);
    if (c) {
      this.current = null;
      this.seekToken++;
      if (e.positionMs > 0) c.positionMs = e.positionMs;
      if (e.durationMs > 0) c.durationMs = e.durationMs;
      if (c.started) this.report('stop', c);
      if (e.completed) await this.deps.markPlayed(c.item.itemKey).catch(() => undefined);
    }
    if (e.error) this.deps.onError?.(t(`player.video.error.${errorKey(e.error)}`));
    this.deps.refresh();
  }
}

/** Native error code → the web player's message keys. */
function errorKey(code: string): 'busy' | 'forbidden' | 'unsupported' | 'network' | 'load' {
  if (code === 'auth') return 'forbidden';
  if (code === 'network') return 'network';
  if (code === 'unsupported' || code === 'decoder') return 'unsupported';
  if (code === 'busy') return 'busy';
  return 'load';
}
