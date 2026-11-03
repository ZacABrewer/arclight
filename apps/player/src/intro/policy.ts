import type { LaunchInfo } from '../native/definitions';

// When the launch intro plays (redesign spec §6). Pure functions, unit-tested. The same idea as
// the admin app's intro policy (apps/mobile/src/intro/policy.ts), written for the player app:
// it plays on a cold launch from the launcher only, never on resume, on a profile switch, after
// a WebView reload, or before a video (the video player never references it).

export type LaunchIntroMode = 'skip' | 'video' | 'static';

export interface LaunchIntroContext {
  /** From ArclightPlayer.consumeLaunchInfo() (or the web fallback). null: unknown, so skip. */
  launch: Pick<LaunchInfo, 'coldStart' | 'source'> | null;
  /** Settings > Display > "Play intro on launch" (device-local, default on). */
  playIntro: boolean;
  /** Reduce motion from any source: the cached profile setting, prefers-reduced-motion, the system. */
  reducedMotion: boolean;
}

export function decideLaunchIntro(c: LaunchIntroContext): LaunchIntroMode {
  if (!c.playIntro || !c.launch || !c.launch.coldStart || c.launch.source !== 'launcher') return 'skip';
  return c.reducedMotion ? 'static' : 'video';
}

/** The reduce-motion still stays up this long, then cuts (no fade, no sound). */
export const STATIC_HOLD_MS = 1000;
/** The video must have started by then, else the still is shown instead. */
export const START_TIMEOUT_MS = 1500;
/** Fade out at the end of the video (none with reduce motion). */
export const FADE_MS = 300;

/** Web fallback for "once per process": sessionStorage lives as long as the WebView. */
export const PLAYED_KEY = 'arclight.introPlayed';
/** Device setting, "0" = off. */
export const PLAY_INTRO_KEY = 'arclight.playIntro';
/** The last-used profile's reduceMotion, cached on the device (no profile is chosen yet at launch). */
export const REDUCE_MOTION_KEY = 'arclight.reduceMotion';

type Get = Pick<Storage, 'getItem'> | undefined;
type Set = Pick<Storage, 'setItem'> | undefined;

function read(storage: Get, key: string): string | null {
  try {
    return storage?.getItem(key) ?? null;
  } catch {
    return null;
  }
}

function write(storage: Set, key: string, value: string): void {
  try {
    storage?.setItem(key, value);
  } catch {
    /* storage disabled: the default applies next time */
  }
}

export const readPlayIntro = (s: Get): boolean => read(s, PLAY_INTRO_KEY) !== '0';
export const writePlayIntro = (s: Set, on: boolean): void => write(s, PLAY_INTRO_KEY, on ? '1' : '0');
export const readCachedReduceMotion = (s: Get): boolean => read(s, REDUCE_MOTION_KEY) === '1';
export const cacheReduceMotion = (s: Set, on: boolean): void => write(s, REDUCE_MOTION_KEY, on ? '1' : '0');

/**
 * Launch info without the native call (a browser, or a plugin without consumeLaunchInfo): the first
 * call in this WebView session is a cold start from the launcher, later ones are not.
 */
export function webLaunchInfo(storage: (Get & Set) | undefined): LaunchInfo {
  const played = read(storage, PLAYED_KEY) === '1';
  write(storage, PLAYED_KEY, '1');
  return { coldStart: !played, source: 'launcher', systemReducedMotion: false };
}

/** The phone gets the 720p file, the TV the 1080p one. Relative: the bundle is served as files. */
export const introVideoUrl = (tv: boolean): string => (tv ? 'intro/arclight-intro-1080p.mp4' : 'intro/arclight-intro-720p.mp4');
export const INTRO_POSTER_URL = 'intro/arclight-intro-poster.png';
