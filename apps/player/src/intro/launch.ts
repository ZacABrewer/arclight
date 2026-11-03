import { Capacitor } from '@capacitor/core';
import { ArclightPlayer, type LaunchInfo } from '../native';
import { cacheReduceMotion, decideLaunchIntro, readCachedReduceMotion, readPlayIntro, webLaunchInfo, writePlayIntro, type LaunchIntroMode } from './policy';

const session = (): Storage | undefined => {
  try {
    return sessionStorage;
  } catch {
    return undefined;
  }
};
const local = (): Storage | undefined => {
  try {
    return localStorage;
  } catch {
    return undefined;
  }
};

/**
 * Cold-launch info, consumed once per process by the native plugin. Builds without it (a browser,
 * an older native side) fall back to the sessionStorage flag, which a WebView reload keeps.
 */
export async function launchInfo(): Promise<LaunchInfo> {
  if (Capacitor.isNativePlatform()) {
    try {
      const info = await ArclightPlayer.consumeLaunchInfo?.();
      if (info) {
        // Keep the web flag in step, so a reload of this WebView never replays it either way.
        webLaunchInfo(session());
        return info;
      }
    } catch {
      // UNIMPLEMENTED: the web fallback below.
    }
  }
  return webLaunchInfo(session());
}

const prefersReducedMotion = (): boolean => {
  try {
    return window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  } catch {
    return false;
  }
};

/** What to show at start-up (main.tsx, once). */
export async function launchIntroMode(): Promise<LaunchIntroMode> {
  const launch = await launchInfo().catch(() => null);
  const store = local();
  return decideLaunchIntro({
    launch,
    playIntro: readPlayIntro(store),
    reducedMotion: readCachedReduceMotion(store) || prefersReducedMotion() || launch?.systemReducedMotion === true,
  });
}

/** Remember the active profile's reduce motion on the device, for the next launch. */
export function rememberReduceMotion(on: boolean): void {
  cacheReduceMotion(local(), on);
}

/** Settings > Display > "Play intro on launch" (device setting, §9 Q16). */
export const playIntroOnLaunch = (): boolean => readPlayIntro(local());
export const setPlayIntroOnLaunch = (on: boolean): void => writePlayIntro(local(), on);
