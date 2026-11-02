// When the startup intro plays, and how it is scaled. Pure functions, unit-tested.
import { STAGE_H } from '../../../../design/brand/intro/src/timeline.js';

export type IntroMode = 'skip' | 'full' | 'static';

export interface IntroContext {
  /** Settings → "Play intro on launch". */
  playIntro: boolean;
  /** Already shown in this app process (coming back from a server page reloads the app's screens). */
  alreadyPlayed: boolean;
  /** prefers-reduced-motion: reduce. */
  reducedMotion: boolean;
  /** Launched by a notification tap, a share or a deep link (arclight://...): never delay it. */
  launchedByEvent: boolean;
  /** The app opened on its default route (not a specific screen such as #settings). */
  routeIsAuto: boolean;
}

/** Full animation, a static logo (reduced motion) or nothing. */
export function decideIntro(c: IntroContext): IntroMode {
  if (!c.playIntro || c.alreadyPlayed || c.launchedByEvent || !c.routeIsAuto) return 'skip';
  return c.reducedMotion ? 'static' : 'full';
}

/** Sound only with the full animation and only when the user left it on. */
export const introSoundOn = (mode: IntroMode, introSound: boolean): boolean => mode === 'full' && introSound;

/** How long the static logo stays up with reduced motion. */
export const STATIC_HOLD_MS = 1000;

/**
 * Width of the 1920 px stage that must stay visible: the lockup spans about x = 400..1600, plus
 * room for the wider letter spacing while it types in and a margin. The rest is black (the
 * ribbons run off the edges anyway).
 */
export const SAFE_W = 1460;

/** Scale for the 1920x1080 stage on a vw x vh screen: the safe area fits, centred, letterboxed on black. */
export function introScale(vw: number, vh: number): number {
  if (!(vw > 0 && vh > 0)) return 1;
  return Math.min(vw / SAFE_W, vh / STAGE_H);
}

/** Per-process "already played" flag: sessionStorage lives as long as the WebView, not across launches. */
export const PLAYED_KEY = 'arclight.introPlayed';

export function readPlayed(storage: Pick<Storage, 'getItem'> | undefined): boolean {
  try {
    return storage?.getItem(PLAYED_KEY) === '1';
  } catch {
    return false;
  }
}

export function markPlayed(storage: Pick<Storage, 'setItem'> | undefined): void {
  try {
    storage?.setItem(PLAYED_KEY, '1');
  } catch {
    /* private mode or storage disabled: the intro may play again, which is harmless */
  }
}
