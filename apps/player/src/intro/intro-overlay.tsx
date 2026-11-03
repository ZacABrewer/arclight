import { useEffect, useRef, useState } from 'react';
import { FADE_MS, INTRO_POSTER_URL, introVideoUrl, START_TIMEOUT_MS, STATIC_HOLD_MS, type LaunchIntroMode } from './policy';
import './intro.css';

// The launch intro (redesign spec §6): a full-screen overlay above the app, which loads behind it
// (sign-in check, profiles, the home prefetch). Video path: the MP4 with its sound sting, muted
// when the WebView refuses unmuted autoplay, the still when it has not started within 1.5 s, and a
// 300 ms fade at the end. Static path (reduce motion): the poster for 1 s, then a cut. Any key or
// a tap ends it at once; while it is up, Back only ends it (main.tsx asks `introActive()`).

let active = false;
let skipCurrent: (() => void) | null = null;

/** The overlay is on screen. */
export const introActive = (): boolean => active;
/** End it now (the remote's Back). */
export function skipIntro(): void {
  skipCurrent?.();
}

export function IntroOverlay({ mode, tv, onDone }: { mode: Exclude<LaunchIntroMode, 'skip'>; tv: boolean; onDone: () => void }) {
  const [path, setPath] = useState<'video' | 'static'>(mode);
  const [fading, setFading] = useState(false);
  const video = useRef<HTMLVideoElement>(null);
  const done = useRef(false);

  const finish = (fade: boolean) => {
    if (done.current) return;
    if (fade) {
      setFading(true);
      window.setTimeout(() => finish(false), FADE_MS);
      return;
    }
    done.current = true;
    active = false;
    skipCurrent = null;
    video.current?.pause();
    onDone();
  };

  // Skip: any key (D-pad, OK, Back, media keys) or a tap. Capture phase, so nothing behind sees it.
  useEffect(() => {
    active = true;
    skipCurrent = () => finish(false);
    const onKey = (e: KeyboardEvent) => {
      e.preventDefault();
      e.stopImmediatePropagation();
      finish(false);
    };
    window.addEventListener('keydown', onKey, true);
    return () => {
      window.removeEventListener('keydown', onKey, true);
      active = false;
      skipCurrent = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Static path: hold, then cut.
  useEffect(() => {
    if (path !== 'static') return;
    const timer = window.setTimeout(() => finish(false), STATIC_HOLD_MS);
    return () => window.clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [path]);

  // Video path: start with sound, retry muted, fall back to the still when it does not start.
  useEffect(() => {
    if (path !== 'video') return;
    const el = video.current;
    if (!el) return;
    let started = false;
    const timer = window.setTimeout(() => {
      if (!started) setPath('static');
    }, START_TIMEOUT_MS);
    const onPlaying = () => {
      started = true;
    };
    el.addEventListener('playing', onPlaying);
    el.muted = false;
    void el.play().catch(() => {
      el.muted = true;
      return el.play().catch(() => setPath('static'));
    });
    return () => {
      window.clearTimeout(timer);
      el.removeEventListener('playing', onPlaying);
    };
  }, [path]);

  return (
    <div
      className={`al-intro${fading ? ' is-fading' : ''}`}
      style={{ ['--al-intro-fade' as string]: `${FADE_MS}ms` }}
      onPointerDown={() => finish(false)}
      aria-hidden="true"
      data-testid="launch-intro"
    >
      {path === 'video' ? (
        <video
          ref={video}
          className="al-intro__media"
          src={introVideoUrl(tv)}
          poster={INTRO_POSTER_URL}
          playsInline
          autoPlay
          preload="auto"
          onEnded={() => finish(true)}
          onError={() => setPath('static')}
        />
      ) : (
        <img className="al-intro__media" src={INTRO_POSTER_URL} alt="" />
      )}
    </div>
  );
}
