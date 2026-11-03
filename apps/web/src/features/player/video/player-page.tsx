import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore, type CSSProperties, type PointerEvent as ReactPointerEvent } from 'react';
import { useNavigate, useParams, useRouterState } from '@tanstack/react-router';
import { trickplayTileAt, type MediaChips, type PlayableItem, type TrickplayManifest, type VideoAudioTrack, type VideoSegment, type VideoSession, type VideoSubtitleTrack } from '@arclight/shared';
import { Button, Icon, isTypingTarget } from '../../../arclight/index.js';
import { cx } from '../../../arclight/cx.js';
import { useT } from '../../../i18n/index.js';
import { formatTime } from '../../../i18n/format.js';
import { playbackApi, sendProgressBeacon, usePlayableItem, useProgress } from '../api.js';
import { usePlayerActions } from '../browse/player-hooks.js';
import { browserName, deviceId, readStored, writeStored } from '../device.js';
import { useAuth } from '../../../auth/auth-context.js';
import { useProfileSettings, useSaveProfileSettings, useTrickplay } from '../redesign/api.js';
import { readStoredQuality, writeStoredQuality } from '../redesign/quality.js';
import { RdIcon } from '../redesign/icons.js';
import { MetaLine } from '../redesign/meta-line.js';
import { Art } from '../redesign/tiles.js';
import { useShow, videoApi } from './api.js';
import { chapterAt, clock, cueTextAt, episodeCode, languageName, parseVtt, playerEpisodeLine, playerHeading, resumePoint, segmentAt, type Cue } from './format.js';
import { watchPaths } from './paths.js';
import { VideoPlayback, type VideoState } from './playback.js';
import { EpisodesPanel, SettingsPanel, TracksPanel, type PanelId } from './player-panels.js';
import { browserVideoProfile } from './profile.js';
import './watch.css';
import './player-overlay.css';

// /player/watch/play/$itemKey: the web video player (redesign spec §5). Full screen over the
// portal, its own <video> (the audio player pauses when it opens), every control a real button,
// keyboard and TV-remote keys (space, ←/→, F, M, C, N, media keys, Back), the resume prompt,
// the pause screen, scrub thumbnails, skip intro / recap / credits and the up-next card.

const PREFS_KEY = 'arclight.player.video.prefs';
/** §5.1: the UI hides after 5 s idle while playing. */
export const HIDE_AFTER_MS = 5000;
/** §5.2: the pause screen shows after 6 s paused with no input. */
export const PAUSE_SCREEN_AFTER_MS = 6000;
export const UP_NEXT_SECONDS = 10;
/** §5.5: the up-next card shows 20 s before the end when there is no credits segment. */
export const UP_NEXT_LEAD_MS = 20_000;
const SKIP_MS = 10_000;
/** §5.1 caption sizes (profile setting), in stage px. */
const CAPTION_PX = { small: 22, medium: 28, large: 36 } as const;

interface VideoPrefs {
  volume: number;
  muted: boolean;
}

function loadVideoPrefs(): VideoPrefs {
  try {
    const p = JSON.parse(readStored(PREFS_KEY) ?? '{}') as Partial<VideoPrefs>;
    return { volume: typeof p.volume === 'number' && p.volume >= 0 && p.volume <= 1 ? p.volume : 1, muted: p.muted === true };
  } catch {
    return { volume: 1, muted: false };
  }
}

function usePlayParams(): { itemKey: string; t: number | null; file: number | null; restart: boolean } {
  const params = useParams({ strict: false }) as Record<string, string | undefined>;
  const search = useRouterState({ select: (s) => s.location.search as Record<string, unknown> | undefined });
  const num = (v: unknown) => {
    const n = typeof v === 'number' ? v : typeof v === 'string' ? Number(v) : Number.NaN;
    return Number.isFinite(n) && n >= 0 ? Math.floor(n) : null;
  };
  return {
    itemKey: decodeURIComponent(params.itemKey ?? ''),
    t: num(search?.t),
    file: num(search?.file),
    restart: search?.restart === 1 || search?.restart === '1' || search?.restart === true,
  };
}

/** Where Back goes when there is no history to go back to. */
function detailsPath(item: PlayableItem | undefined): string {
  if (item?.movieId) return watchPaths.movie(item.movieId);
  if (item?.seriesId) return watchPaths.show(item.seriesId);
  return watchPaths.home;
}

export function VideoPlayerPage() {
  const t = useT();
  const { itemKey, t: startParam, file, restart } = usePlayParams();
  const item = usePlayableItem(itemKey || null);
  const progress = useProgress(itemKey ? [itemKey] : []);
  const audio = usePlayerActions();
  const navigate = useNavigate();
  const [chosenStart, setChosenStart] = useState<number | null>(null);

  // Pause the music / audiobook when a video opens.
  const audioRef = useRef(audio);
  audioRef.current = audio;
  useEffect(() => {
    if (audioRef.current.playing) audioRef.current.toggle();
  }, [itemKey]);

  useEffect(() => setChosenStart(null), [itemKey]);

  const goBack = useCallback(() => {
    if (typeof window !== 'undefined' && window.history.length > 1) window.history.back();
    else void navigate({ to: detailsPath(item.data) as never });
  }, [navigate, item.data]);

  const saved = progress.data?.items.find((p) => p.itemKey === itemKey);
  const resumeAt = item.data && saved ? resumePoint(saved, item.data.durationMs) : null;

  let start: number | null = null;
  if (startParam !== null) start = startParam;
  else if (restart) start = 0;
  else if (chosenStart !== null) start = chosenStart;
  else if (item.isSuccess && progress.isFetched && resumeAt === null) start = 0;

  if (item.isError || (item.isSuccess && !item.data.video)) {
    return (
      <div className="vp" data-testid="video-player">
        <div className="vp-center">
          <div className="vp-message" role="alert">
            <h1 className="vp-message__title">{t('player.video.error.load')}</h1>
            <div className="vp-message__actions">
              <Button variant="primary" onClick={goBack}>
                {t('player.video.back')}
              </Button>
            </div>
          </div>
        </div>
      </div>
    );
  }

  if (!item.data || start === null) {
    const prompt = item.data && resumeAt !== null && start === null;
    return (
      <div className="vp" data-testid="video-player">
        {item.data?.backdropUrl ? <img className="vp-backdrop" src={item.data.backdropUrl} alt="" aria-hidden="true" /> : null}
        <div className="vp-center">
          {prompt && item.data ? (
            <div className="vp-message" role="dialog" aria-labelledby="vp-resume-title">
              <h1 className="vp-message__title" id="vp-resume-title">
                {item.data.title}
              </h1>
              <p className="vp-muted">{t('player.video.resumePrompt', { time: clock(resumeAt!) })}</p>
              <div className="vp-message__actions">
                <Button variant="primary" size="lg" icon={<Icon name="play" />} autoFocus onClick={() => setChosenStart(resumeAt!)}>
                  {t('player.video.resumeAt', { time: clock(resumeAt!) })}
                </Button>
                <Button size="lg" icon={<Icon name="refresh" />} onClick={() => setChosenStart(0)}>
                  {t('player.video.startOver')}
                </Button>
                <Button size="lg" variant="ghost" onClick={goBack}>
                  {t('player.video.back')}
                </Button>
              </div>
            </div>
          ) : (
            <span className="vp-spinner" role="status" aria-label={t('player.browse.loading')} />
          )}
        </div>
      </div>
    );
  }

  return <VideoStage key={`${itemKey}:${file ?? ''}`} item={item.data} startMs={start} mediaFileId={file} onBack={goBack} />;
}

const NO_STATE = () => () => undefined;
const nullState = (): VideoState | null => null;

function usePlaybackState(pb: VideoPlayback | null): VideoState | null {
  return useSyncExternalStore(pb?.subscribe ?? NO_STATE, pb?.getState ?? nullState, pb?.getState ?? nullState);
}

/** "DIRECT PLAY · 4K HDR10 · 62 Mb/s". */
function streamLabel(t: ReturnType<typeof useT>, item: PlayableItem, session: VideoSession): string {
  const v = item.video;
  const h = v?.height ?? 0;
  const res = h >= 2000 ? '4K' : h >= 1400 ? '1440p' : h >= 1000 ? '1080p' : h >= 700 ? '720p' : h > 0 ? `${h}p` : null;
  const range = v && v.dynamicRange !== 'sdr' ? (v.dynamicRange === 'dv' ? 'DV' : v.dynamicRange === 'hlg' ? 'HLG' : v.dynamicRange === 'hdr10plus' ? 'HDR10+' : 'HDR10') : null;
  const rate = session.method === 'direct' && v?.bitrateKbps ? t('player.video.mbps', { value: (v.bitrateKbps / 1000).toFixed(v.bitrateKbps >= 10_000 ? 0 : 1) }) : null;
  return [t(`player.video.method.${session.method}`), [res, range].filter(Boolean).join(' '), rate].filter(Boolean).join(' · ');
}

/** A phone or small tablet held in the hand: playback asks for full screen and landscape (§5.9). */
function isHandheld(): boolean {
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return false;
  const coarse = window.matchMedia('(pointer: coarse)').matches;
  const short = Math.min(window.screen?.width ?? 1024, window.screen?.height ?? 1024) < 600;
  return coarse && short;
}

function useFullscreen(target: React.RefObject<HTMLElement | null>, video: React.RefObject<HTMLVideoElement | null>) {
  const [on, setOn] = useState(false);
  useEffect(() => {
    const sync = () => setOn(document.fullscreenElement != null);
    document.addEventListener('fullscreenchange', sync);
    return () => document.removeEventListener('fullscreenchange', sync);
  }, []);
  const enter = useCallback(
    async (landscape: boolean) => {
      const el = target.current;
      try {
        if (!document.fullscreenElement && el?.requestFullscreen) await el.requestFullscreen();
        else if (!el?.requestFullscreen) (video.current as (HTMLVideoElement & { webkitEnterFullscreen?: () => void }) | null)?.webkitEnterFullscreen?.();
        if (landscape) await (screen.orientation as ScreenOrientation & { lock?: (o: string) => Promise<void> })?.lock?.('landscape');
      } catch {
        // Not allowed here (no user gesture, iframe, desktop): carry on in the window.
      }
    },
    [target, video],
  );
  const toggle = useCallback(() => {
    if (document.fullscreenElement) {
      void document.exitFullscreen?.().catch(() => undefined);
      return;
    }
    void enter(isHandheld());
  }, [enter]);
  return { on, toggle, enter };
}

/** When the up-next card shows: the credits segment (in the second half), else 20 s before the end. */
export function upNextStart(segments: readonly VideoSegment[] | undefined, durationMs: number): number {
  const credits = segments?.find((s) => s.type === 'credits' && s.startMs > durationMs * 0.5);
  return credits ? credits.startMs : Math.max(0, durationMs - UP_NEXT_LEAD_MS);
}

/** Two language codes name the same language ("en" / "eng"). */
function sameLanguage(a: string | null | undefined, b: string | null | undefined): boolean {
  if (!a || !b) return false;
  if (a.toLowerCase() === b.toLowerCase()) return true;
  const na = languageName(a);
  return !!na && na === languageName(b);
}

/** The profile's audio and subtitle languages pick the starting tracks (forced subtitles otherwise). */
function initialTracks(item: PlayableItem, audioLanguage: string | null, subtitleLanguage: string | null): { audioTrack?: number; subtitle: string | null } {
  const subs = (item.video?.subtitleTracks ?? []).filter((s) => s.text);
  const audio = item.video?.audioTracks ?? [];
  const a = audioLanguage ? audio.find((x) => sameLanguage(x.language, audioLanguage)) : undefined;
  const wanted = subtitleLanguage ? (subs.find((s) => sameLanguage(s.language, subtitleLanguage) && !s.forced) ?? subs.find((s) => sameLanguage(s.language, subtitleLanguage))) : undefined;
  const fallback = subs.find((s) => s.forced) ?? (subtitleLanguage === null ? undefined : subs.find((s) => s.default));
  return { ...(a ? { audioTrack: a.index } : {}), subtitle: (wanted ?? fallback)?.id ?? null };
}

export function VideoStage({ item, startMs, mediaFileId, onBack }: { item: PlayableItem; startMs: number; mediaFileId: number | null; onBack: () => void }) {
  const t = useT();
  const navigate = useNavigate();
  const settings = useProfileSettings();
  const saveSettings = useSaveProfileSettings();
  const rootRef = useRef<HTMLDivElement>(null);
  const videoRef = useRef<HTMLVideoElement>(null);
  const playRef = useRef<HTMLButtonElement>(null);
  const [pb, setPb] = useState<VideoPlayback | null>(null);
  const state = usePlaybackState(pb);
  const [panel, setPanel] = useState<PanelId | null>(null);
  const panelOpener = useRef<HTMLElement | null>(null);
  const [chrome, setChrome] = useState(true);
  const [pauseScreen, setPauseScreen] = useState(false);
  const [scrub, setScrub] = useState<number | null>(null);
  const [hover, setHover] = useState<number | null>(null);
  const [cues, setCues] = useState<Cue[]>([]);
  const [upNextDismissed, setUpNextDismissed] = useState(false);
  const [countdown, setCountdown] = useState<number | null>(null);
  const fs = useFullscreen(rootRef, videoRef);
  const hideTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pauseTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const autoSkipped = useRef(false);
  const settingsRef = useRef(settings);
  // Streaming quality is kept per browser and profile (Settings > Playback).
  const profileId = useAuth().session?.activeProfile?.id ?? null;
  const profileIdRef = useRef(profileId);
  profileIdRef.current = profileId;
  settingsRef.current = settings;

  const goTo = useCallback(
    (key: string) => void navigate({ to: watchPaths.play(key) as never, search: { restart: 1 } as never, replace: true }),
    [navigate],
  );
  const next = item.next ?? null;
  const show = useShow(item.kind === 'episode' ? (item.seriesId ?? null) : null);
  const nextEpisode = next ? show.data?.seasons.flatMap((s) => s.episodes).find((e) => e.itemKey === next) : undefined;

  // ---- controller ----------------------------------------------------------------------
  useEffect(() => {
    const prefs = loadVideoPrefs();
    const s = settingsRef.current;
    const tracks = initialTracks(item, s.audioLanguage, s.subtitleLanguage);
    const c = new VideoPlayback({
      item,
      profile: browserVideoProfile(),
      requestSession: videoApi.session,
      sendProgress: playbackApi.report,
      beacon: sendProgressBeacon,
      deviceId: deviceId(),
      deviceName: browserName(),
      initial: { volume: prefs.volume, muted: prefs.muted, quality: readStoredQuality(profileIdRef.current), subtitle: tracks.subtitle, mediaFileId, ...(tracks.audioTrack !== undefined ? { audioTrack: tracks.audioTrack } : {}) },
      onEnded: () => {
        if (next && settingsRef.current.autoplayNext) goTo(next);
      },
    });
    if (videoRef.current) c.attach(videoRef.current);
    setPb(c);
    void c.start(startMs);
    const onHide = () => {
      if (document.visibilityState === 'hidden') c.onHidden();
    };
    const onPageHide = () => c.onHidden();
    document.addEventListener('visibilitychange', onHide);
    window.addEventListener('pagehide', onPageHide);
    return () => {
      document.removeEventListener('visibilitychange', onHide);
      window.removeEventListener('pagehide', onPageHide);
      c.dispose();
    };
    // One controller per item (the stage is keyed by item and version).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Phones: full screen and landscape (still inside the tap that opened the player).
  useEffect(() => {
    if (isHandheld()) void fs.enter(true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Remember volume / mute.
  useEffect(() => {
    if (!state) return;
    writeStored(PREFS_KEY, JSON.stringify({ volume: state.volume, muted: state.muted }));
  }, [state?.volume, state?.muted]); // eslint-disable-line react-hooks/exhaustive-deps

  // ---- subtitles (text tracks drawn here, on the item's own clock) ---------------------
  const subUrl = state?.session?.subtitles.find((s) => s.id === state.subtitle)?.url ?? null;
  useEffect(() => {
    setCues([]);
    if (!subUrl) return undefined;
    let alive = true;
    fetch(subUrl, { credentials: 'include' })
      .then((r) => (r.ok ? r.text() : ''))
      .then((text) => {
        if (alive) setCues(parseVtt(text));
      })
      .catch(() => undefined);
    return () => {
      alive = false;
    };
  }, [subUrl]);

  // ---- derived -------------------------------------------------------------------------
  const playing = !!state?.playing;
  const status = state?.status ?? 'loading';
  const busy = status === 'loading' || !!state?.switching || (!!state?.buffering && status !== 'error');
  const durationMs = state?.durationMs || item.durationMs;
  const positionMs = scrub ?? state?.positionMs ?? startMs;
  const chapters = item.chapters;
  const segment = segmentAt(item.segments, state?.positionMs ?? 0);
  const upNextAt = upNextStart(item.segments, durationMs);
  const showUpNext = !!next && !upNextDismissed && !!state && status !== 'error' && durationMs > 0 && state.positionMs >= upNextAt;
  const subtitleText = cues.length ? cueTextAt(cues, state?.positionMs ?? 0) : '';
  const autoplay = settings.autoplayNext;
  const canPauseScreen = status === 'ready' && !playing && !busy && !panel && !showUpNext;

  // ---- idle: hide the UI after 5 s while playing; the pause screen after 6 s paused ----
  const idle = useRef({ playing, panel, canPauseScreen });
  idle.current = { playing, panel, canPauseScreen };
  const armTimers = useCallback(() => {
    if (hideTimer.current) clearTimeout(hideTimer.current);
    if (pauseTimer.current) clearTimeout(pauseTimer.current);
    hideTimer.current = null;
    pauseTimer.current = null;
    if (idle.current.playing && !idle.current.panel) hideTimer.current = setTimeout(() => setChrome(false), HIDE_AFTER_MS);
    if (idle.current.canPauseScreen) pauseTimer.current = setTimeout(() => setPauseScreen(true), PAUSE_SCREEN_AFTER_MS);
  }, []);
  const poke = useCallback(() => {
    setChrome(true);
    setPauseScreen(false);
    armTimers();
  }, [armTimers]);
  useEffect(() => {
    if (!playing || panel) setChrome(true);
    if (!canPauseScreen) setPauseScreen(false);
    armTimers();
  }, [playing, panel, canPauseScreen, armTimers]);
  useEffect(
    () => () => {
      if (hideTimer.current) clearTimeout(hideTimer.current);
      if (pauseTimer.current) clearTimeout(pauseTimer.current);
    },
    [],
  );

  // ---- skip intro automatically (profile setting; once per play, recap never) ----------
  useEffect(() => {
    if (!pb || !segment || segment.type !== 'intro' || !settings.skipIntros || autoSkipped.current) return;
    autoSkipped.current = true;
    void pb.seek(segment.endMs);
  }, [pb, segment, settings.skipIntros]);

  // Up-next countdown: 10 s, then the next episode (only with Autoplay next episode on).
  useEffect(() => {
    if (!showUpNext || !autoplay) {
      setCountdown(null);
      return undefined;
    }
    setCountdown((c) => c ?? UP_NEXT_SECONDS);
    if (!playing) return undefined;
    const id = setInterval(() => setCountdown((c) => (c === null ? null : Math.max(0, c - 1))), 1000);
    return () => clearInterval(id);
  }, [showUpNext, playing, autoplay]);
  useEffect(() => {
    if (countdown === 0 && next) goTo(next);
  }, [countdown, next, goTo]);

  const openPanel = (id: PanelId) => {
    panelOpener.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    setPanel((p) => (p === id ? null : id));
  };
  const closePanel = useCallback(() => {
    setPanel(null);
    const back = panelOpener.current;
    panelOpener.current = null;
    setTimeout(() => back?.focus(), 0);
  }, []);

  // Track picks: the per-item prefs (the controller) and the profile's languages (§5.7).
  const pickAudio = useCallback(
    (a: VideoAudioTrack) => {
      void pb?.setAudioTrack(a.index);
      const lang = a.language?.toLowerCase() ?? null;
      if (lang && /^[a-z]{2,3}$/.test(lang) && lang !== 'und' && !sameLanguage(lang, settingsRef.current.audioLanguage)) saveSettings.mutate({ audioLanguage: lang });
    },
    [pb, saveSettings],
  );
  const pickSubtitle = useCallback(
    (s: VideoSubtitleTrack | null) => {
      void pb?.setSubtitle(s ? s.id : null);
      if (s?.forced) return; // forced tracks follow the audio, not a reading preference
      const lang = s ? (s.language?.toLowerCase() ?? null) : null;
      if (s && (!lang || !/^[a-z]{2,3}$/.test(lang) || lang === 'und')) return;
      const current = settingsRef.current.subtitleLanguage;
      if (lang === null ? current !== null : !sameLanguage(lang, current)) saveSettings.mutate({ subtitleLanguage: lang });
    },
    [pb, saveSettings],
  );

  const cycleSubtitles = useCallback(() => {
    if (!pb || !state) return;
    const subs = item.video?.subtitleTracks ?? [];
    if (!subs.length) return;
    const idx = state.subtitle ? subs.findIndex((s) => s.id === state.subtitle) : -1;
    const nextSub = idx + 1 < subs.length ? subs[idx + 1]! : null;
    void pb.setSubtitle(nextSub ? nextSub.id : null);
  }, [pb, state, item.video]);

  const pip = useCallback(() => {
    const v = videoRef.current as (HTMLVideoElement & { requestPictureInPicture?: () => Promise<unknown> }) | null;
    if (!v) return;
    if (document.pictureInPictureElement) void document.exitPictureInPicture?.().catch(() => undefined);
    else void v.requestPictureInPicture?.().catch(() => undefined);
  }, []);
  const pipSupported = typeof document !== 'undefined' && 'pictureInPictureEnabled' in document && (document as { pictureInPictureEnabled?: boolean }).pictureInPictureEnabled === true;

  // Skip: intro / recap seek to the end; credits with no next item end the item and close (§5.6).
  const skipSegment = useCallback(
    (seg: VideoSegment) => {
      if (!pb) return;
      if (seg.type === 'credits' && !next) {
        void pb.seek(Math.max(0, durationMs - 250)).finally(onBack);
        return;
      }
      void pb.seek(seg.endMs);
    },
    [pb, next, durationMs, onBack],
  );
  const showSkip = !!segment && !!state && !showUpNext;

  // ---- keyboard / remote ---------------------------------------------------------------
  const keyState = useRef({ chrome, panel, showUpNext, pauseScreen, segment: showSkip ? segment : null });
  keyState.current = { chrome, panel, showUpNext, pauseScreen, segment: showSkip ? segment : null };
  useEffect(() => {
    if (!pb) return undefined;
    const onKey = (e: KeyboardEvent) => {
      if (e.defaultPrevented || e.ctrlKey || e.metaKey || e.altKey || isTypingTarget(e.target)) return;
      if (e.key === 'Shift' || e.key === 'Control' || e.key === 'Alt' || e.key === 'Meta') return;
      const k = keyState.current;
      const target = e.target instanceof HTMLElement ? e.target : null;
      const onControl = !!target && target !== document.body && target !== rootRef.current && !!target.closest('button, a, [role="slider"], input');
      const onSeek = !!target?.classList.contains('vp-seek__input');
      const handled = () => {
        e.preventDefault();
        e.stopPropagation();
      };
      const wasHidden = !k.chrome;
      poke();
      // The pause screen: any key brings back the paused UI (media keys still act).
      if (k.pauseScreen && !e.key.startsWith('Media')) {
        handled();
        return;
      }
      switch (e.key) {
        case ' ':
        case 'k':
        case 'K':
          if (onControl && !onSeek && !wasHidden && e.key === ' ') return;
          handled();
          pb.toggle();
          return;
        case 'Enter':
          if (wasHidden || !onControl) {
            handled();
            if (k.segment) skipSegment(k.segment);
            else pb.toggle();
          }
          return;
        case 'ArrowLeft':
        case 'ArrowRight':
          if (k.panel) return;
          if (wasHidden || onSeek || !onControl) {
            handled();
            void pb.skip(e.key === 'ArrowLeft' ? -SKIP_MS : SKIP_MS);
          }
          return;
        case 'ArrowUp':
        case 'ArrowDown':
          if (wasHidden) {
            handled();
            playRef.current?.focus();
          }
          return;
        case 'f':
        case 'F':
          handled();
          fs.toggle();
          return;
        case 'm':
        case 'M':
          handled();
          pb.toggleMute();
          return;
        case 'c':
        case 'C':
          handled();
          cycleSubtitles();
          return;
        case 'n':
        case 'N':
        case 'MediaTrackNext':
          if (next) {
            handled();
            goTo(next);
          }
          return;
        case 'MediaPlayPause':
          handled();
          pb.toggle();
          return;
        case 'MediaPlay':
          handled();
          pb.play();
          return;
        case 'MediaPause':
        case 'MediaStop':
          handled();
          pb.pause();
          return;
        case 'MediaFastForward':
          handled();
          void pb.skip(SKIP_MS);
          return;
        case 'MediaRewind':
          handled();
          void pb.skip(-SKIP_MS);
          return;
        case 'Escape':
        case 'Backspace':
        case 'GoBack':
        case 'BrowserBack':
          if (e.key === 'Escape' && document.fullscreenElement && !k.panel) return; // the browser leaves full screen
          handled();
          if (k.panel) closePanel();
          else if (k.showUpNext) setUpNextDismissed(true);
          else onBack();
          return;
        default:
      }
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [pb, poke, fs, cycleSubtitles, next, goTo, closePanel, onBack, skipSegment]);

  // ---- seek bar ------------------------------------------------------------------------
  const commitScrub = () => {
    if (scrub !== null && pb) void pb.seek(scrub);
    setScrub(null);
  };
  const onSeekHover = (e: ReactPointerEvent<HTMLDivElement>) => {
    if (e.pointerType === 'touch' && e.buttons === 0) return;
    const r = e.currentTarget.getBoundingClientRect();
    if (r.width <= 0) return;
    const x = Math.min(r.width, Math.max(0, e.clientX - r.left));
    setHover((x / r.width) * durationMs);
  };
  const previewMs = scrub ?? hover;

  const trickplay = useTrickplay(state?.session?.mediaFileId ?? null, state?.session?.trickplay ?? null);
  const sheets = trickplay.data?.status === 'ready' && trickplay.data.sheets.length ? trickplay.data : null;

  // §5.1 top line: the series name over "S1 E2 · Title" for episodes; the title over "2025 · PG-13".
  const heading = playerHeading(item);
  const sub = useMemo(() => {
    if (item.kind === 'episode') return playerEpisodeLine(item.seasonNumber, item.episodeNumber, item.pause?.episodeTitle ?? item.title);
    return [item.year ? String(item.year) : null, item.pause?.certification ?? null].filter(Boolean).join(' · ') || t('player.video.movie');
  }, [item, t]);

  const tab = chrome && !pauseScreen ? 0 : -1;
  const uiShown = chrome && !pauseScreen;
  const caption = CAPTION_PX[settings.subtitleSize] ?? CAPTION_PX.medium;
  const pct = durationMs ? Math.min(100, (positionMs / durationMs) * 100) : 0;

  return (
    <div
      ref={rootRef}
      className={cx('vp', !uiShown && 'vp--idle', pauseScreen && 'vp--pause-screen', settings.reduceMotion && 'vp--still')}
      data-testid="video-player"
      onPointerMove={poke}
      onPointerDown={poke}
      aria-label={item.title}
      role="region"
      style={{ '--vp-caption': `${caption}px` } as CSSProperties}
    >
      {item.backdropUrl && status === 'loading' ? <img className="vp-backdrop" src={item.backdropUrl} alt="" aria-hidden="true" /> : null}
      <video
        ref={(el) => {
          videoRef.current = el;
          if (el && pb) pb.attach(el);
        }}
        className="vp-video"
        playsInline
        preload="auto"
        onClick={() => pb?.toggle()}
        onDoubleClick={fs.toggle}
        aria-label={item.title}
      />

      {subtitleText && !pauseScreen ? (
        <div className={cx('vp-subtitle', uiShown && 'vp-subtitle--raised')} aria-live="off">
          {subtitleText.split('\n').map((line, i) => (
            <span key={i}>{line}</span>
          ))}
        </div>
      ) : null}

      {busy && status !== 'error' ? (
        <div className="vp-center vp-center--passive">
          <span className="vp-spinner" role="status" aria-label={t('player.browse.loading')} />
        </div>
      ) : null}

      {/* §5.1: the big pause glyph while paused (until the pause screen) */}
      {status === 'ready' && !playing && !busy && !pauseScreen && !panel ? (
        <div className="vp-paused" aria-hidden="true">
          <span />
          <span />
        </div>
      ) : null}

      {status === 'error' && state?.error ? (
        <div className="vp-center">
          <div className="vp-message" role="alert">
            <h1 className="vp-message__title">{t(`player.video.error.${state.error}`)}</h1>
            <div className="vp-message__actions">
              <Button variant="primary" onClick={() => void pb?.retry()} autoFocus>
                {t('player.video.retry')}
              </Button>
              <Button variant="ghost" onClick={onBack}>
                {t('player.video.back')}
              </Button>
            </div>
          </div>
        </div>
      ) : null}

      {pauseScreen ? <PauseScreen item={item} remainingMs={Math.max(0, durationMs - positionMs)} onDismiss={poke} /> : null}

      {/* top: title and sub (§5.1); the stream badge and the close button are kept from 0.22 */}
      <div className="vp-top" aria-hidden={!uiShown || undefined}>
        <div className="vp-top__title">
          <h1 className="vp-title">{heading}</h1>
          {sub ? <p className="vp-sub">{sub}</p> : null}
        </div>
        <div className="vp-top__end">
          {state?.session ? (
            <span className="vp-health" data-method={state.session.method} title={state.session.reasons.map((r) => t(`player.video.reason.${r}`)).join('\n') || undefined}>
              <span className="vp-health__dot" aria-hidden="true" />
              {streamLabel(t, item, state.session)}
            </span>
          ) : null}
          <button type="button" className="vp-btn vp-btn--ghost" aria-label={t('player.video.back')} onClick={onBack} tabIndex={tab}>
            <RdIcon name="close" size={24} />
          </button>
        </div>
      </div>

      {/* skip intro / recap / credits (§5.6) */}
      {showSkip && segment ? (
        <button type="button" className={cx('vp-skip', uiShown && 'is-raised')} onClick={() => skipSegment(segment)}>
          {t(`player.video.skip.${segment.type}`)}
        </button>
      ) : null}

      {/* up next (§5.5) */}
      {showUpNext && next ? (
        <section className={cx('vp-upnext', uiShown && 'is-raised')} aria-label={t('player.video.upNext')}>
          <Art image={nextEpisode?.thumbUrl} seed={heading} shift={nextEpisode ? nextEpisode.episodeNumber * 14 + nextEpisode.seasonNumber * 30 : 0} className="vp-upnext__thumb" />
          <div className="vp-upnext__body">
            <p className="vp-upnext__kicker">{t('player.video.upNext')}</p>
            <p className="vp-upnext__title">
              {nextEpisode
                ? [episodeCode(nextEpisode.seasonNumber, nextEpisode.episodeNumber), nextEpisode.title].filter(Boolean).join(' · ')
                : t('player.video.nextEpisode')}
            </p>
            <div className="vp-upnext__actions">
              <button type="button" className="vp-upnext__play" onClick={() => goTo(next)}>
                <RdIcon name="play" size={14} />
                {t('player.video.playNow')}
              </button>
              {autoplay ? (
                <button type="button" className="vp-upnext__cancel" onClick={() => setUpNextDismissed(true)}>
                  {t('player.video.cancel')}
                </button>
              ) : null}
            </div>
            {countdown !== null ? (
              <p className="vp-upnext__count" aria-live="polite">
                {t('player.video.upNextIn', { seconds: countdown })}
              </p>
            ) : null}
          </div>
          {countdown !== null ? (
            <span className="vp-upnext__bar" aria-hidden="true">
              <span style={{ width: `${(countdown / UP_NEXT_SECONDS) * 100}%` }} />
            </span>
          ) : null}
        </section>
      ) : null}

      {/* bottom: scrub bar and controls (§5.1, §5.3) */}
      <div className="vp-bottom" aria-hidden={!uiShown || undefined}>
        <div className="vp-bar">
          <div className="vp-seek" onPointerMove={onSeekHover} onPointerLeave={() => setHover(null)}>
            <div className="vp-seek__track" aria-hidden="true">
              <span className="vp-seek__fill" style={{ width: `${pct}%` }} />
              {chapters
                .filter((c) => c.startMs > 0 && durationMs > 0 && c.startMs < durationMs)
                .map((c) => (
                  <span key={c.startMs} className="vp-seek__notch" style={{ left: `${(c.startMs / durationMs) * 100}%` }} />
                ))}
              <span className="vp-seek__knob" style={{ left: `${pct}%` }} />
            </div>
            <input
              className="vp-seek__input"
              type="range"
              min={0}
              max={Math.max(1, durationMs)}
              step={1000}
              value={Math.min(positionMs, durationMs)}
              aria-label={t('player.video.seek')}
              aria-valuetext={t('player.video.seekValue', { position: clock(positionMs), duration: clock(durationMs) })}
              tabIndex={tab}
              onChange={(e) => setScrub(Number(e.target.value))}
              onPointerUp={commitScrub}
              onKeyUp={commitScrub}
              onBlur={() => scrub !== null && commitScrub()}
            />
            {previewMs !== null && durationMs > 0 ? <ScrubPreview ms={previewMs} durationMs={durationMs} chapters={chapters} manifest={sheets} /> : null}
          </div>
          <span className="vp-time">
            {clock(positionMs)} / {clock(durationMs)}
          </span>
        </div>
        <div className="vp-controls">
          <button
            ref={playRef}
            type="button"
            className="vp-btn vp-btn--play"
            aria-label={playing ? t('player.video.pause') : t('player.video.play')}
            onClick={() => pb?.toggle()}
            tabIndex={tab}
            autoFocus
          >
            <RdIcon name={playing ? 'pause' : 'play'} size={playing ? 22 : 20} />
          </button>
          <button type="button" className="vp-btn vp-btn--round" aria-label={t('player.video.back10')} onClick={() => void pb?.skip(-SKIP_MS)} tabIndex={tab}>
            −10
          </button>
          <button type="button" className="vp-btn vp-btn--round" aria-label={t('player.video.forward10')} onClick={() => void pb?.skip(SKIP_MS)} tabIndex={tab}>
            +10
          </button>
          {next ? (
            <button type="button" className="vp-pill" onClick={() => goTo(next)} tabIndex={tab}>
              <RdIcon name="next" size={16} className="vp-pill__icon" />
              <span className="vp-pill__label">{t('player.video.nextEpisode')}</span>
            </button>
          ) : null}
          {item.kind === 'episode' && item.seriesId ? (
            <button type="button" className="vp-pill" aria-expanded={panel === 'episodes'} onClick={() => openPanel('episodes')} tabIndex={tab}>
              <RdIcon name="episodes" size={18} className="vp-pill__icon" />
              <span className="vp-pill__label">{t('player.video.episodes')}</span>
            </button>
          ) : null}
          <span className="vp-controls__spacer" />
          <span className="vp-volume-wrap">
            <button type="button" className="vp-btn vp-btn--round" aria-label={state?.muted ? t('player.video.unmute') : t('player.video.mute')} aria-pressed={!!state?.muted} onClick={() => pb?.toggleMute()} tabIndex={tab}>
              <RdIcon name={state?.muted || state?.volume === 0 ? 'mute' : 'volume'} size={22} />
            </button>
            <input
              className="vp-volume"
              type="range"
              min={0}
              max={100}
              step={5}
              value={Math.round((state?.muted ? 0 : (state?.volume ?? 1)) * 100)}
              aria-label={t('player.video.volume')}
              tabIndex={tab}
              onChange={(e) => pb?.setVolume(Number(e.target.value) / 100)}
            />
          </span>
          <button type="button" className="vp-btn vp-btn--round" aria-label={t('player.video.settings')} aria-expanded={panel === 'settings'} onClick={() => openPanel('settings')} tabIndex={tab}>
            <RdIcon name="settings" size={22} />
          </button>
          {pipSupported ? (
            <button type="button" className="vp-btn vp-btn--round" aria-label={t('player.video.pip')} onClick={pip} tabIndex={tab}>
              <PipIcon />
            </button>
          ) : null}
          <button type="button" className="vp-btn vp-btn--round" aria-label={fs.on ? t('player.video.exitFullscreen') : t('player.video.fullscreen')} aria-pressed={fs.on} onClick={fs.toggle} tabIndex={tab}>
            <RdIcon name={fs.on ? 'exitFullscreen' : 'fullscreen'} size={22} />
          </button>
          <button
            type="button"
            className="vp-pill"
            aria-expanded={panel === 'tracks'}
            aria-controls={panel === 'tracks' ? 'vp-tracks' : undefined}
            onClick={() => openPanel('tracks')}
            tabIndex={tab}
          >
            <CaptionsIcon />
            <span className="vp-pill__label">{t('player.video.audioAndSubtitles')}</span>
          </button>
        </div>
      </div>

      {panel && state && pb ? (
        <>
          <div className="vp-scrim" aria-hidden="true" onClick={closePanel} />
          {panel === 'tracks' ? (
            <TracksPanel item={item} state={state} onAudio={pickAudio} onSubtitle={pickSubtitle} />
          ) : panel === 'settings' ? (
            <SettingsPanel item={item} state={state} onQuality={(q) => {
              writeStoredQuality(profileIdRef.current, q);
              void pb.setQuality(q);
            }} onSpeed={pb.setSpeed} onVersion={(id) => void pb.setVersion(id)} />
          ) : (
            <EpisodesPanel item={item} onPick={(key) => (key === item.itemKey ? closePanel() : goTo(key))} />
          )}
        </>
      ) : null}
    </div>
  );
}

/** The scrub preview (§5.3): a 240x135 trickplay tile (when ready), the time and the chapter. */
export function ScrubPreview({ ms, durationMs, chapters, manifest }: { ms: number; durationMs: number; chapters: PlayableItem['chapters']; manifest: TrickplayManifest | null }) {
  const at = Math.max(0, Math.min(durationMs, ms));
  const chapter = chapterAt(chapters, at);
  const tile = manifest ? trickplayTileAt(manifest, at) : null;
  const sheet = tile && manifest ? manifest.sheets[tile.sheet] : undefined;

  // Preload the sheet in view and its neighbours.
  useEffect(() => {
    if (!manifest || !tile) return;
    for (const n of [tile.sheet - 1, tile.sheet, tile.sheet + 1]) {
      const url = manifest.sheets[n];
      if (url && !preloaded.has(url)) {
        preloaded.add(url);
        const img = new Image();
        img.decoding = 'async';
        img.src = url;
      }
    }
  }, [manifest, tile?.sheet]); // eslint-disable-line react-hooks/exhaustive-deps

  let thumb: CSSProperties | null = null;
  if (manifest && tile && sheet) {
    const sx = 240 / manifest.tileWidth;
    const sy = 135 / manifest.tileHeight;
    thumb = {
      backgroundImage: `url("${sheet.replace(/["\\\n]/g, (c) => encodeURIComponent(c))}")`,
      backgroundSize: `${manifest.columns * manifest.tileWidth * sx}px ${manifest.rows * manifest.tileHeight * sy}px`,
      backgroundPosition: `${-tile.x * sx}px ${-tile.y * sy}px`,
    };
  }
  return (
    <span className={cx('vp-preview', thumb && 'vp-preview--thumb')} style={{ left: `clamp(var(--vp-preview-half), ${(at / durationMs) * 100}%, calc(100% - var(--vp-preview-half)))` }} aria-hidden="true" data-testid="scrub-preview">
      {thumb ? <span className="vp-preview__thumb" style={thumb} data-testid="scrub-thumb" /> : null}
      <span className="vp-preview__time">{clock(at)}</span>
      {chapter >= 0 && chapters[chapter] ? <span className="vp-preview__chapter">{chapters[chapter]!.title}</span> : null}
    </span>
  );
}

const preloaded = new Set<string>();

/** The pause info screen (§5.2). */
export function PauseScreen({ item, remainingMs, onDismiss }: { item: PlayableItem; remainingMs: number; onDismiss: () => void }) {
  const t = useT();
  const p = item.pause;
  const [logoFailed, setLogoFailed] = useState(false);
  const title = playerHeading(item);
  const logo = (p?.logoUrl ?? item.logoUrl) || null;
  const backdrop = (p?.backdropUrl ?? item.backdropUrl) || null;
  const episodeLine = item.kind === 'episode' ? playerEpisodeLine(p?.seasonNumber ?? item.seasonNumber, p?.episodeNumber ?? item.episodeNumber, p?.episodeTitle ?? item.title) : null;
  const chips: MediaChips | null = p?.chips
    ? p.chips.tmdbScore === null && p.tmdbScore !== null
      ? { ...p.chips, tmdbScore: p.tmdbScore }
      : p.chips
    : p?.tmdbScore
      ? { resolution: null, dynamicRange: null, audio: null, audioLanguages: [], sizeBytes: null, tmdbScore: p.tmdbScore, certification: null }
      : null;
  const overview = p?.overview ?? item.overview ?? null;
  return (
    <div className="vp-pause" role="region" aria-label={t('player.video.paused')} onPointerDown={onDismiss} data-testid="pause-screen">
      {backdrop ? <img className="vp-pause__art" src={backdrop} alt="" aria-hidden="true" /> : null}
      <div className={cx('vp-pause__shade', !backdrop && 'vp-pause__shade--frame')} aria-hidden="true" />
      <div className="vp-pause__content">
        {logo && !logoFailed ? (
          <h2 className="vp-pause__logo">
            <img src={logo} alt={title} onError={() => setLogoFailed(true)} />
          </h2>
        ) : (
          <h2 className="vp-pause__title">{title}</h2>
        )}
        {episodeLine ? <p className="vp-pause__episode">{episodeLine}</p> : null}
        <MetaLine
          year={p?.year ?? item.year ?? null}
          cert={p?.certification ?? null}
          runtimeMinutes={item.kind === 'movie' && item.durationMs > 0 ? Math.round(item.durationMs / 60_000) : null}
          genres={p?.genres ?? []}
          chips={chips}
          className="vp-pause__meta"
        />
        {overview ? <p className="vp-pause__overview">{overview}</p> : null}
        <p className="vp-pause__ends">{t('player.video.pauseEndsAt', { time: formatTime(new Date(Date.now() + remainingMs)) })}</p>
      </div>
    </div>
  );
}

function PipIcon() {
  return (
    <svg viewBox="0 0 24 24" width={22} height={22} fill="none" stroke="currentColor" strokeWidth={2} strokeLinejoin="round" aria-hidden="true" focusable="false">
      <path d="M3 5h18v14H3zM12 12h7v5h-7z" />
    </svg>
  );
}

function CaptionsIcon() {
  return (
    <svg viewBox="0 0 24 24" width={20} height={20} fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" className="vp-pill__icon" aria-hidden="true" focusable="false">
      <path d="M3 5h18v14H3zM10 10.5a2 2 0 1 0 0 3M17 10.5a2 2 0 1 0 0 3" />
    </svg>
  );
}
