import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore, type PointerEvent as ReactPointerEvent } from 'react';
import { useNavigate, useParams, useRouterState } from '@tanstack/react-router';
import type { PlayableItem, VideoSession } from '@arclight/shared';
import { Button, Icon, isTypingTarget } from '../../../arclight/index.js';
import { cx } from '../../../arclight/cx.js';
import { useT } from '../../../i18n/index.js';
import { playbackApi, sendProgressBeacon, usePlayableItem, useProgress } from '../api.js';
import { usePlayerActions } from '../browse/player-hooks.js';
import { browserName, deviceId, readStored, writeStored } from '../device.js';
import { PlayerIcon } from '../ui/player-icons.js';
import { videoApi } from './api.js';
import { chapterAt, clock, cueTextAt, endsAtLabel, episodeCode, parseVtt, resumePoint, segmentAt, upNextFrom, type Cue } from './format.js';
import { watchPaths } from './paths.js';
import { VideoPlayback, type VideoState } from './playback.js';
import { EpisodesPanel, SettingsPanel, TracksPanel, type PanelId } from './player-panels.js';
import { browserVideoProfile } from './profile.js';
import './watch.css';

// /player/watch/play/$itemKey: the web video player. Full screen over the portal, its own
// <video> (the audio player pauses when it opens), every control a real button, keyboard and
// TV-remote keys (space, ←/→, F, M, C, N, media keys, Back), the resume prompt, skip intro /
// credits and an up-next card that counts down into the next episode.

const PREFS_KEY = 'arclight.player.video.prefs';
const HIDE_AFTER_MS = 3000;
const UP_NEXT_SECONDS = 10;
const SKIP_MS = 10_000;

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

function useFullscreen(target: React.RefObject<HTMLElement | null>, video: React.RefObject<HTMLVideoElement | null>) {
  const [on, setOn] = useState(false);
  useEffect(() => {
    const sync = () => setOn(document.fullscreenElement != null);
    document.addEventListener('fullscreenchange', sync);
    return () => document.removeEventListener('fullscreenchange', sync);
  }, []);
  const toggle = useCallback(() => {
    if (document.fullscreenElement) {
      void document.exitFullscreen?.().catch(() => undefined);
      return;
    }
    const el = target.current;
    if (el?.requestFullscreen) void el.requestFullscreen().catch(() => undefined);
    else (video.current as (HTMLVideoElement & { webkitEnterFullscreen?: () => void }) | null)?.webkitEnterFullscreen?.();
  }, [target, video]);
  return { on, toggle };
}

export function VideoStage({ item, startMs, mediaFileId, onBack }: { item: PlayableItem; startMs: number; mediaFileId: number | null; onBack: () => void }) {
  const t = useT();
  const navigate = useNavigate();
  const rootRef = useRef<HTMLDivElement>(null);
  const videoRef = useRef<HTMLVideoElement>(null);
  const playRef = useRef<HTMLButtonElement>(null);
  const [pb, setPb] = useState<VideoPlayback | null>(null);
  const state = usePlaybackState(pb);
  const [panel, setPanel] = useState<PanelId | null>(null);
  const panelOpener = useRef<HTMLElement | null>(null);
  const [chrome, setChrome] = useState(true);
  const [scrub, setScrub] = useState<number | null>(null);
  const [hover, setHover] = useState<{ x: number; ms: number } | null>(null);
  const [subOffset, setSubOffset] = useState(0);
  const [cues, setCues] = useState<Cue[]>([]);
  const [upNextDismissed, setUpNextDismissed] = useState(false);
  const [countdown, setCountdown] = useState<number | null>(null);
  const fs = useFullscreen(rootRef, videoRef);
  const hideTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const goTo = useCallback(
    (key: string) => void navigate({ to: watchPaths.play(key) as never, search: { restart: 1 } as never, replace: true }),
    [navigate],
  );
  const next = item.next ?? null;

  // ---- controller ----------------------------------------------------------------------
  useEffect(() => {
    const prefs = loadVideoPrefs();
    const subs = item.video?.subtitleTracks ?? [];
    const initialSub = subs.find((s) => s.text && s.forced) ?? subs.find((s) => s.text && s.default) ?? null;
    const c = new VideoPlayback({
      item,
      profile: browserVideoProfile(),
      requestSession: videoApi.session,
      sendProgress: playbackApi.report,
      beacon: sendProgressBeacon,
      deviceId: deviceId(),
      deviceName: browserName(),
      initial: { volume: prefs.volume, muted: prefs.muted, subtitle: initialSub?.id ?? null, mediaFileId },
      onEnded: () => {
        if (next) goTo(next);
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

  // ---- chrome auto-hide ----------------------------------------------------------------
  const playing = !!state?.playing;
  const poke = useCallback(() => {
    setChrome(true);
    if (hideTimer.current) clearTimeout(hideTimer.current);
    hideTimer.current = setTimeout(() => setChrome(false), HIDE_AFTER_MS);
  }, []);
  useEffect(() => {
    if (!playing || panel) {
      if (hideTimer.current) clearTimeout(hideTimer.current);
      setChrome(true);
    } else poke();
    return () => {
      if (hideTimer.current) clearTimeout(hideTimer.current);
    };
  }, [playing, panel, poke]);

  // ---- derived -------------------------------------------------------------------------
  const durationMs = state?.durationMs || item.durationMs;
  const positionMs = scrub ?? state?.positionMs ?? startMs;
  const chapters = item.chapters;
  const chapterIdx = chapterAt(chapters, positionMs);
  const segment = segmentAt(item.segments, state?.positionMs ?? 0);
  const upNextAt = upNextFrom(item.segments, durationMs);
  const showUpNext = !!next && !upNextDismissed && !!state && state.status !== 'error' && durationMs > 0 && state.positionMs >= upNextAt;
  const subtitleText = cues.length ? cueTextAt(cues, (state?.positionMs ?? 0) - subOffset) : '';

  // Up-next countdown: 10 s, then the next episode.
  useEffect(() => {
    if (!showUpNext || !playing) {
      if (!showUpNext) setCountdown(null);
      return undefined;
    }
    setCountdown((c) => c ?? UP_NEXT_SECONDS);
    const id = setInterval(() => setCountdown((c) => (c === null ? null : Math.max(0, c - 1))), 1000);
    return () => clearInterval(id);
  }, [showUpNext, playing]);
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

  // ---- keyboard / remote ---------------------------------------------------------------
  const keyState = useRef({ chrome, panel, showUpNext });
  keyState.current = { chrome, panel, showUpNext };
  useEffect(() => {
    if (!pb) return undefined;
    const onKey = (e: KeyboardEvent) => {
      if (e.defaultPrevented || e.ctrlKey || e.metaKey || e.altKey || isTypingTarget(e.target)) return;
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
            playRef.current?.focus();
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
          if (e.key === 'Escape' && document.fullscreenElement) return; // the browser leaves full screen
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
  }, [pb, poke, fs, cycleSubtitles, next, goTo, closePanel, onBack]);

  // ---- seek bar ------------------------------------------------------------------------
  const commitScrub = () => {
    if (scrub !== null && pb) void pb.seek(scrub);
    setScrub(null);
  };
  const onSeekHover = (e: ReactPointerEvent<HTMLDivElement>) => {
    const r = e.currentTarget.getBoundingClientRect();
    if (r.width <= 0) return;
    const x = Math.min(r.width, Math.max(0, e.clientX - r.left));
    setHover({ x, ms: (x / r.width) * durationMs });
  };

  const eyebrow = useMemo(() => {
    if (item.kind === 'episode') return [item.subtitle, episodeCode(item.seasonNumber, item.episodeNumber)].filter(Boolean).join(' · ');
    return item.year ? String(item.year) : t('player.video.movie');
  }, [item, t]);

  const remaining = Math.max(0, durationMs - positionMs);
  const status = state?.status ?? 'loading';
  const busy = status === 'loading' || !!state?.switching || (!!state?.buffering && status !== 'error');

  return (
    <div
      ref={rootRef}
      className={cx('vp', !chrome && 'vp--idle')}
      data-testid="video-player"
      onPointerMove={poke}
      onPointerDown={poke}
      aria-label={item.title}
      role="region"
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

      {subtitleText ? (
        <div className={cx('vp-subtitle', chrome && 'vp-subtitle--raised')} aria-live="off">
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

      {/* top bar */}
      <div className="vp-top" aria-hidden={!chrome || undefined}>
        <button type="button" className="vp-btn" aria-label={t('player.video.back')} onClick={onBack} tabIndex={chrome ? 0 : -1}>
          <Icon name="chevronLeft" size={24} />
        </button>
        <div className="vp-top__title">
          <p className="vp-eyebrow">{eyebrow}</p>
          <h1 className="vp-title">{item.kind === 'episode' ? (item.context ?? item.title) : item.title}</h1>
        </div>
        {state?.session ? (
          <span className="vp-health" data-method={state.session.method} title={state.session.reasons.map((r) => t(`player.video.reason.${r}`)).join('\n') || undefined}>
            <span className="vp-health__dot" aria-hidden="true" />
            {streamLabel(t, item, state.session)}
          </span>
        ) : null}
      </div>

      {/* skip intro / credits */}
      {segment && state && !showUpNext ? (
        <div className="vp-skip">
          <Button variant="secondary" size="lg" onClick={() => void pb?.seek(segment.endMs)}>
            {t(`player.video.skip.${segment.type}`)}
          </Button>
        </div>
      ) : null}

      {/* up next */}
      {showUpNext && next ? (
        <div className="vp-upnext" role="region" aria-label={t('player.video.upNext')}>
          <p className="vp-eyebrow">{t('player.video.upNext')}</p>
          <p className="vp-upnext__line" aria-live="polite">
            {countdown !== null ? t('player.video.upNextIn', { seconds: countdown }) : t('player.video.upNextPaused')}
          </p>
          <div className="vp-message__actions">
            <Button variant="primary" icon={<PlayerIcon name="next" size={18} />} onClick={() => goTo(next)}>
              {t('player.video.playNow')}
            </Button>
            <Button variant="ghost" onClick={() => setUpNextDismissed(true)}>
              {t('player.video.cancel')}
            </Button>
          </div>
        </div>
      ) : null}

      {/* bottom controls */}
      <div className="vp-bottom" aria-hidden={!chrome || undefined}>
        <div className="vp-time">
          <span className="vp-time__pos">
            {clock(positionMs)} <span className="vp-muted">/ {clock(durationMs)}</span>
          </span>
          {chapterIdx >= 0 && chapters[chapterIdx] ? <span className="vp-time__chapter">{chapters[chapterIdx]!.title}</span> : null}
          <span className="vp-time__left">
            −{clock(remaining)} · {endsAtLabel(remaining / (state?.speed || 1))}
          </span>
        </div>
        <div className="vp-seek" onPointerMove={onSeekHover} onPointerLeave={() => setHover(null)}>
          <div className="vp-seek__track" aria-hidden="true">
            <span className="vp-seek__fill" style={{ width: `${durationMs ? (positionMs / durationMs) * 100 : 0}%` }} />
            {chapters.slice(1).map((c) => (
              <span key={c.startMs} className="vp-seek__tick" style={{ left: `${(c.startMs / durationMs) * 100}%` }} />
            ))}
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
            tabIndex={chrome ? 0 : -1}
            onChange={(e) => setScrub(Number(e.target.value))}
            onPointerUp={commitScrub}
            onKeyUp={commitScrub}
            onBlur={() => scrub !== null && commitScrub()}
          />
          {hover ? (
            <span className="vp-seek__preview" style={{ left: hover.x }} aria-hidden="true">
              {clock(hover.ms)}
              {chapterAt(chapters, hover.ms) >= 0 ? <span className="vp-seek__preview-chapter">{chapters[chapterAt(chapters, hover.ms)]!.title}</span> : null}
            </span>
          ) : null}
        </div>
        <div className="vp-controls">
          <div className="vp-controls__group">
            <button
              ref={playRef}
              type="button"
              className="vp-btn vp-btn--play"
              aria-label={playing ? t('player.video.pause') : t('player.video.play')}
              onClick={() => pb?.toggle()}
              tabIndex={chrome ? 0 : -1}
              autoFocus
            >
              <PlayerIcon name={playing ? 'pause' : 'play'} size={26} />
            </button>
            <button type="button" className="vp-btn" aria-label={t('player.video.back10')} onClick={() => void pb?.skip(-SKIP_MS)} tabIndex={chrome ? 0 : -1}>
              <span className="vp-btn__skip">−10</span>
            </button>
            <button type="button" className="vp-btn" aria-label={t('player.video.forward10')} onClick={() => void pb?.skip(SKIP_MS)} tabIndex={chrome ? 0 : -1}>
              <span className="vp-btn__skip">+10</span>
            </button>
            {next ? (
              <button type="button" className="vp-btn" aria-label={t('player.video.nextEpisode')} onClick={() => goTo(next)} tabIndex={chrome ? 0 : -1}>
                <PlayerIcon name="next" />
              </button>
            ) : null}
            <button type="button" className="vp-btn" aria-label={state?.muted ? t('player.video.unmute') : t('player.video.mute')} aria-pressed={!!state?.muted} onClick={() => pb?.toggleMute()} tabIndex={chrome ? 0 : -1}>
              <PlayerIcon name={state?.muted || state?.volume === 0 ? 'mute' : 'volume'} />
            </button>
            <input
              className="vp-volume"
              type="range"
              min={0}
              max={100}
              step={5}
              value={Math.round((state?.muted ? 0 : (state?.volume ?? 1)) * 100)}
              aria-label={t('player.video.volume')}
              tabIndex={chrome ? 0 : -1}
              onChange={(e) => pb?.setVolume(Number(e.target.value) / 100)}
            />
          </div>
          <div className="vp-controls__group">
            <button
              type="button"
              className="vp-btn"
              aria-label={t('player.video.audioAndSubtitles')}
              aria-expanded={panel === 'tracks'}
              aria-controls={panel === 'tracks' ? 'vp-tracks' : undefined}
              data-active={state?.subtitle ? true : undefined}
              onClick={() => openPanel('tracks')}
              tabIndex={chrome ? 0 : -1}
            >
              <Icon name="subtitles" size={20} />
            </button>
            {item.kind === 'episode' && item.seriesId ? (
              <button
                type="button"
                className="vp-btn"
                aria-label={t('player.video.episodes')}
                aria-expanded={panel === 'episodes'}
                onClick={() => openPanel('episodes')}
                tabIndex={chrome ? 0 : -1}
              >
                <PlayerIcon name="queue" />
              </button>
            ) : null}
            <button type="button" className="vp-btn" aria-label={t('player.video.settings')} aria-expanded={panel === 'settings'} onClick={() => openPanel('settings')} tabIndex={chrome ? 0 : -1}>
              <Icon name="settings" size={20} />
            </button>
            {pipSupported ? (
              <button type="button" className="vp-btn" aria-label={t('player.video.pip')} onClick={pip} tabIndex={chrome ? 0 : -1}>
                <PipIcon />
              </button>
            ) : null}
            <button type="button" className="vp-btn" aria-label={fs.on ? t('player.video.exitFullscreen') : t('player.video.fullscreen')} aria-pressed={fs.on} onClick={fs.toggle} tabIndex={chrome ? 0 : -1}>
              <FullscreenIcon on={fs.on} />
            </button>
          </div>
        </div>
      </div>

      {panel && state && pb ? (
        <>
          <div className="vp-scrim" aria-hidden="true" onClick={closePanel} />
          {panel === 'tracks' ? (
            <TracksPanel
              item={item}
              state={state}
              subtitleOffsetMs={subOffset}
              onAudio={(i) => void pb.setAudioTrack(i)}
              onSubtitle={(id) => void pb.setSubtitle(id)}
              onOffset={setSubOffset}
              onClose={closePanel}
            />
          ) : panel === 'settings' ? (
            <SettingsPanel item={item} state={state} onQuality={(q) => void pb.setQuality(q)} onSpeed={pb.setSpeed} onVersion={(id) => void pb.setVersion(id)} onClose={closePanel} />
          ) : (
            <EpisodesPanel item={item} onPick={(key) => (key === item.itemKey ? closePanel() : goTo(key))} onClose={closePanel} />
          )}
        </>
      ) : null}
    </div>
  );
}

function PipIcon() {
  return (
    <svg viewBox="0 0 24 24" width={20} height={20} fill="none" stroke="currentColor" strokeWidth={1.5} className="al-icon" aria-hidden="true" focusable="false">
      <path d="M3 5h18v14H3zM12 12h7v5h-7z" />
    </svg>
  );
}

function FullscreenIcon({ on }: { on: boolean }) {
  return (
    <svg viewBox="0 0 24 24" width={20} height={20} fill="none" stroke="currentColor" strokeWidth={1.5} strokeLinecap="square" className="al-icon" aria-hidden="true" focusable="false">
      <path d={on ? 'M9 4v5H4M15 4v5h5M9 20v-5H4M15 20v-5h5' : 'M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5'} />
    </svg>
  );
}
