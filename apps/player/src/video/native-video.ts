import type { PluginListenerHandle } from '@capacitor/core';
import type {
  PlayableItem,
  PlaybackProgress,
  PlayerSeriesDetails,
  ProfileSettings,
  ProfileSettingsPatch,
  ProgressReport,
  VideoDelivery,
  VideoDeviceProfile,
  VideoSession,
  VideoSessionRequest,
  VideoQuality,
} from '@arclight/shared';
import type { OpenVideoOptions } from '@web/features/player/video/video-launcher';
import { audioTrackLabel, episodeCode, playerEpisodeLine, playerHeading, resumePoint } from '@web/features/player/video/format';
import { t } from '@web/i18n/index';
import type {
  ArclightPlayerPlugin,
  NativeVideoSubtitle,
  PlayVideoOptions,
  VideoClosedEvent,
  VideoNextEvent,
  VideoProgressEvent,
  VideoPickItemEvent,
  VideoSeekRequestEvent,
  VideoTracksChangedEvent,
  NativeVideoTheme,
} from '../native/definitions';
import { normLanguage, pauseInfo, preferredAudio, preferredSubtitle, prefsOf, seasonsOf, trickplayOf, videoStrings } from './native-extras';

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
//   videoPickItem     → an episode from the native episodes panel: stop this one, open that one
//   videoTracksChanged → the profile's audio / subtitle language follows the choice
//
// With the redesign's extras (spec §5.9): the pause screen, scrub thumbnails, the episodes panel,
// the active profile's prefs and languages, the theme's colours and the overlay strings.
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
  /** The active profile's settings (languages, prefs); null / absent: the file's defaults. */
  profileSettings?: () => Promise<ProfileSettings | null>;
  /** GET /playback/series/:id, for the episodes panel. */
  fetchSeries?: (seriesId: number) => Promise<PlayerSeriesDetails>;
  /** Save the profile's languages after a track change in the player. */
  saveProfileSettings?: (patch: ProfileSettingsPatch) => Promise<unknown>;
  /** The active theme's colours (getComputedStyle on the --al-pl-* tokens). */
  theme?: () => NativeVideoTheme | undefined;
  /** Translated overlay strings (default: from the app's locales). */
  strings?: () => PlayVideoOptions['strings'];
  /** Streaming quality for this device and profile (Settings > Playback); absent: auto. */
  quality?: () => VideoQuality;
  /** How the native player takes converted video (getDeviceInfo().deliveries); absent: progressive only. */
  deliveries?: VideoDelivery[];
  /** The last measured throughput on the current network (kbit/s), saved from the player's events. */
  bandwidth?: { get: () => number | null; set: (kbps: number) => void };
  /** DELETE /playback/video/session/:id: an HLS session the player is done with. */
  endSession?: (sessionId: string) => Promise<unknown>;
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
  /** Playback health from the latest native event (ProgressReport stalls / stallMs / startupMs). */
  stats?: Pick<ProgressReport, 'stalls' | 'stallMs' | 'startupMs'>;
}

/** The health fields of a native event, as ProgressReport takes them. */
function statsOf(e: VideoProgressEvent | VideoClosedEvent): Current['stats'] {
  const out: NonNullable<Current['stats']> = {};
  const n = (v: number | undefined) => (typeof v === 'number' && Number.isFinite(v) && v >= 0 ? Math.floor(v) : undefined);
  const stalls = n(e.stalls);
  const stallMs = n(e.stallMs);
  const startupMs = n(e.startupMs);
  if (stalls !== undefined) out.stalls = stalls;
  if (stallMs !== undefined) out.stallMs = stallMs;
  if (startupMs !== undefined) out.startupMs = startupMs;
  return Object.keys(out).length ? out : undefined;
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

/**
 * The overlay's title and the line under it: the series name over "S1 E3 · Episode name" for
 * episodes; movies keep their title over the year.
 */
export function itemTitles(item: PlayableItem): { title: string; subtitle: string | undefined } {
  if (item.kind !== 'episode') return { title: item.title, subtitle: itemSubtitle(item) };
  const title = playerHeading(item);
  // Without a series name the title already is the episode's: the line then carries only the code.
  const episodeTitle = title === item.title ? null : (item.pause?.episodeTitle ?? item.title);
  return { title, subtitle: playerEpisodeLine(item.seasonNumber, item.episodeNumber, episodeTitle) || undefined };
}

/** The up-next card's line under the next title: "S2 · E5" for episodes, the year for movies. */
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
  /**
   * Bumped by every open and by a close: an open that finishes after the player was closed (Back
   * pressed while the next episode loads) or after a newer open must not (re)open the screen.
   */
  private openGen = 0;
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
      p.addListener('videoPickItem', (e) => void this.onPickItem(e)),
      p.addListener('videoTracksChanged', (e) => void this.onTracksChanged(e)),
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
      await this.open(itemKey, opts, ++this.openGen);
    } catch (err) {
      this.deps.onError?.(err instanceof Error ? err.message : String(err));
      throw err;
    }
  };

  private request(
    c: Pick<Current, 'item' | 'audioTrack' | 'subtitle' | 'mediaFileId'>,
    profile: VideoDeviceProfile,
    startMs: number,
    avoidDirect = false,
  ): VideoSessionRequest {
    const sub = c.subtitle ? c.item.video?.subtitleTracks.find((s) => s.id === c.subtitle) : undefined;
    const deliveries = this.deps.deliveries;
    const hint = this.deps.bandwidth?.get() ?? null;
    return {
      itemKey: c.item.itemKey as VideoSessionRequest['itemKey'],
      ...(c.mediaFileId !== null ? { mediaFileId: c.mediaFileId } : {}),
      profile,
      ...(c.audioTrack !== null ? { audioTrack: c.audioTrack } : {}),
      // Text subtitles are side-loaded by the player; only image ones would need burning in.
      ...(sub && !sub.text ? { subtitle: sub.id } : {}),
      ...(startMs > 0 ? { startMs: Math.floor(startMs) } : {}),
      quality: this.deps.quality?.() ?? 'auto',
      // 0.24 HLS: what the player takes, the throughput hint and the device (one session per device).
      ...(deliveries?.length ? { deliveries } : {}),
      ...(deliveries?.includes('hls') ? { deviceKey: this.deps.deviceId.slice(0, 64) } : {}),
      ...(hint ? { bandwidthKbps: hint } : {}),
      ...(avoidDirect ? { avoidDirect: true } : {}),
    };
  }

  /** The HLS parts of a session for the plugin (none for progressive streams). */
  private hlsOf(session: VideoSession): Pick<PlayVideoOptions, 'delivery' | 'sessionId' | 'hls'> {
    if (session.delivery !== 'hls' || !session.hls) return {};
    return { delivery: 'hls', sessionId: session.sessionId, hls: session.hls };
  }

  /** Lets the server free an HLS session the player no longer uses (its encoder and slot). */
  private endSession(session: VideoSession | null | undefined): void {
    if (!session || session.delivery !== 'hls' || !session.sessionId || !this.deps.endSession) return;
    void this.deps.endSession(session.sessionId).catch(() => undefined);
  }

  /** Keeps the player's throughput measurement for the next video on this network. */
  private saveBandwidth(kbps: number | undefined): void {
    if (kbps && kbps > 0) this.deps.bandwidth?.set(kbps);
  }

  /** Fetch the item, ask for a session and open the native player (an open one loads it in place). */
  private async open(itemKey: string, opts: OpenVideoOptions, gen: number): Promise<void> {
    const stale = () => gen !== this.openGen;
    const [item, progress, profile, settings] = await Promise.all([
      this.deps.fetchItem(itemKey),
      opts.restart || (opts.startMs ?? 0) > 0 ? Promise.resolve(null) : this.deps.fetchProgress(itemKey).catch(() => null),
      this.profile(),
      this.deps.profileSettings ? this.deps.profileSettings().catch(() => null) : Promise.resolve(null),
    ]);
    if (stale()) return;
    if (!item.video) throw new Error(t('player.video.error.load'));
    const startMs = startPosition(opts, progress, item.durationMs);
    const audioTrack = preferredAudio(item, settings);
    const base = {
      item,
      audioTrack,
      subtitle: settings ? preferredSubtitle(item, settings, audioTrack) : defaultSubtitle(item),
      mediaFileId: opts.mediaFileId ?? null,
    };
    const seriesId = item.kind === 'episode' ? item.seriesId : undefined;
    const [session, next, show] = await Promise.all([
      this.deps.requestSession(this.request(base, profile, startMs)),
      item.next ? this.deps.fetchItem(item.next).catch(() => null) : Promise.resolve(null),
      seriesId && this.deps.fetchSeries ? this.deps.fetchSeries(seriesId).catch(() => null) : Promise.resolve(null),
    ]);
    // Closed (or another item opened) while the session was being prepared.
    if (stale()) return;
    const durationMs = session.durationMs || item.durationMs;
    // Replacing an item in place (another playVideo): its HLS session is done.
    if (this.current && this.current.session !== session) this.endSession(this.current.session);
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
    const titles = itemTitles(item);
    const options: PlayVideoOptions = {
      itemKey: item.itemKey,
      url: session.url,
      mimeType: session.mimeType,
      streamStartMs: session.streamStartMs,
      startPositionMs: startMs,
      seekable: session.seekable,
      durationMs,
      title: titles.title,
      streamInfo: streamInfo(item, session),
      subtitles: subtitlesOf(session),
      selectedSubtitle: this.current.subtitle,
      audioTracks: v.audioTracks.map((a) => {
        const l = audioTrackLabel(a);
        return { index: a.index, label: l.detail ? `${l.name} · ${l.detail}` : l.name, language: a.language, codec: a.codec, channels: a.channels, title: a.title };
      }),
      ...(session.audioTrack !== null && session.audioTrack !== undefined ? { selectedAudio: session.audioTrack } : {}),
      chapters: item.chapters.map((c) => ({ title: c.title, startMs: c.startMs })),
      segments: item.segments ?? [],
      ...this.hlsOf(session),
      quality: this.deps.quality?.() ?? 'auto',
    };
    const hint = this.deps.bandwidth?.get();
    if (hint) options.bandwidthKbps = hint;
    if (titles.subtitle) options.subtitle = titles.subtitle;
    const art = httpUrl(item.artworkUrl);
    if (art) options.artworkUrl = art;
    const backdrop = httpUrl(item.backdropUrl);
    if (backdrop) options.backdropUrl = backdrop;
    if (next) {
      const nextSub = itemSubtitle(next);
      const nextArt = httpUrl(next.artworkUrl) ?? httpUrl(next.backdropUrl);
      options.next = { itemKey: next.itemKey, title: next.title, ...(nextSub ? { subtitle: nextSub } : {}), ...(nextArt ? { artworkUrl: nextArt } : {}) };
    }
    const pause = pauseInfo(item);
    if (pause) options.pause = pause;
    options.trickplay = trickplayOf(session.trickplay);
    if (show && show.seasons.length) {
      options.seasons = seasonsOf(show);
      if (item.seasonNumber != null) options.currentSeason = item.seasonNumber;
    }
    if (settings) options.prefs = prefsOf(settings);
    const theme = this.deps.theme?.();
    if (theme) options.theme = theme;
    options.strings = this.deps.strings?.() ?? videoStrings();
    const opened = this.current;
    await this.deps.plugin.playVideo(options);
    if (this.current !== opened) return;
    this.report('start', opened);
    opened.started = true;
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
      ...(c.stats ?? {}),
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
    const st = statsOf(e);
    if (st) c.stats = st;
    this.saveBandwidth(e.bandwidthKbps);
    if (e.paused && wasPaused) return; // Nothing moved.
    this.report(e.paused ? 'pause' : 'progress', c);
  }

  private async onSeekRequest(e: VideoSeekRequestEvent): Promise<void> {
    const c = this.matches(e.itemKey);
    if (!c) return;
    // Direct play keeps stalling: switch to a converted stream only on Auto (a pinned quality is
    // the viewer's choice; native asks only on Auto too).
    if (e.avoidDirect && (this.deps.quality?.() ?? 'auto') !== 'auto') return;
    const token = ++this.seekToken;
    c.positionMs = e.positionMs;
    if (e.audioTrack !== undefined) c.audioTrack = e.audioTrack;
    if (e.subtitle !== undefined) c.subtitle = e.subtitle;
    let session: VideoSession;
    try {
      session = await this.deps.requestSession(this.request(c, await this.profile(), e.positionMs, e.avoidDirect === true));
    } catch (err) {
      if (token !== this.seekToken || this.current !== c) return;
      // The native screen waits (spinner) for an answer that will not come: close it rather than
      // leave it stuck, and say why (the toast shows once the app is back in front).
      this.deps.onError?.(err instanceof Error ? err.message : String(err));
      await this.deps.plugin.closeVideo().catch(() => undefined);
      return;
    }
    // A newer seek, or the player moved on / closed meanwhile.
    if (token !== this.seekToken || this.current !== c) {
      this.endSession(session);
      return;
    }
    // The stream changes (audio track, direct play to HLS): the old HLS session is done.
    if (c.session.sessionId !== session.sessionId) this.endSession(c.session);
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
        ...this.hlsOf(session),
      })
      .catch(() => undefined);
    this.report('seek', c);
  }

  private async onNext(e: VideoNextEvent): Promise<void> {
    const gen = ++this.openGen;
    const c = this.current;
    if (c) {
      // Let go of it first: a close arriving meanwhile must not report it a second time.
      this.current = null;
      this.seekToken++;
      // The countdown / the end / "Play now" at the credits: this one counts as watched. The
      // "Next episode" button mid-way (completed: false) only saves where it stopped.
      const watched = e.completed !== false;
      if (watched) c.positionMs = Math.max(c.positionMs, c.durationMs);
      if (c.started) this.report('stop', c);
      this.endSession(c.session);
      if (watched) await this.deps.markPlayed(c.item.itemKey).catch(() => undefined);
    }
    try {
      // Closed while marking: stay closed.
      if (gen === this.openGen) await this.open(e.itemKey, {}, gen);
    } catch (err) {
      this.deps.onError?.(err instanceof Error ? err.message : String(err));
      if (gen === this.openGen) await this.deps.plugin.closeVideo().catch(() => undefined);
    } finally {
      this.deps.refresh();
    }
  }

  /** Another episode from the native episodes panel: save where this one stopped, open that one. */
  private async onPickItem(e: VideoPickItemEvent): Promise<void> {
    const gen = ++this.openGen;
    const c = this.current;
    if (c && c.item.itemKey === e.fromItemKey) {
      this.current = null;
      this.seekToken++;
      if (e.positionMs > 0) c.positionMs = e.positionMs;
      if (c.started) this.report('stop', c);
      this.endSession(c.session);
    }
    try {
      await this.open(e.itemKey, {}, gen);
    } catch (err) {
      this.deps.onError?.(err instanceof Error ? err.message : String(err));
      if (gen === this.openGen) await this.deps.plugin.closeVideo().catch(() => undefined);
    } finally {
      this.deps.refresh();
    }
  }

  /** A track picked in the player: remember it, and make its language the profile's choice. */
  private async onTracksChanged(e: VideoTracksChangedEvent): Promise<void> {
    const c = this.matches(e.itemKey);
    if (!c) return;
    const v = c.item.video;
    // An index that is not one of the item's tracks is never kept or turned into a language.
    const audio = e.audioTrack !== null ? v?.audioTracks.find((a) => a.index === e.audioTrack) : undefined;
    if (e.audioTrack === null || audio) c.audioTrack = e.audioTrack;
    c.subtitle = e.subtitle;
    if (!this.deps.saveProfileSettings) return;
    const sub = e.subtitle !== null ? v?.subtitleTracks.find((s) => s.id === e.subtitle) : undefined;
    const patch: ProfileSettingsPatch = {};
    const audioLang = normLanguage(audio?.language);
    if (audioLang) patch.audioLanguage = audioLang;
    // Off, or a forced track (shown anyway): subtitles off for the profile.
    if (e.subtitle === null || sub?.forced) patch.subtitleLanguage = null;
    else {
      const subLang = normLanguage(sub?.language);
      if (subLang) patch.subtitleLanguage = subLang;
    }
    if (Object.keys(patch).length) await this.deps.saveProfileSettings(patch).catch(() => undefined);
  }

  private async onClosed(e: VideoClosedEvent): Promise<void> {
    const c = this.matches(e.itemKey);
    // The screen is gone: a pending open (the next episode loading) must not bring it back.
    if (c || !this.current) this.openGen++;
    if (c) {
      this.current = null;
      this.seekToken++;
      if (e.positionMs > 0) c.positionMs = e.positionMs;
      if (e.durationMs > 0) c.durationMs = e.durationMs;
      const st = statsOf(e);
      if (st) c.stats = st;
      if (c.started) this.report('stop', c);
      this.endSession(c.session);
      if (e.completed) await this.deps.markPlayed(c.item.itemKey).catch(() => undefined);
    }
    this.saveBandwidth(e.bandwidthKbps);
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
