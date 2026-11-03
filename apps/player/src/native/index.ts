import { Capacitor, registerPlugin } from '@capacitor/core';
import type { ArclightPlayerPlugin, PlayerInfo } from './definitions';
import { ArclightPlayerWeb } from './web';

export * from './definitions';

/** The registered plugin: native on iOS/Android, the HTMLAudio fallback in a browser. */
export const ArclightPlayer = registerPlugin<ArclightPlayerPlugin>('ArclightPlayer', {
  web: () => new ArclightPlayerWeb(),
});

const NO_FEATURES: PlayerInfo['features'] = { audio: false, downloads: false, car: false, cast: false, sleepTimer: false };

export interface PlayerBackend {
  /** What actually plays audio (native, or the WebView fallback). */
  plugin: ArclightPlayerPlugin;
  info: PlayerInfo;
  /** True when `plugin` is the native implementation. */
  native: boolean;
}

/** Capacitor's "not implemented" (a stub plugin or a missing method). */
export function isUnimplemented(e: unknown): boolean {
  const code = (e as { code?: string } | null)?.code;
  return code === 'UNIMPLEMENTED' || code === 'UNAVAILABLE';
}

let backend: Promise<PlayerBackend> | null = null;

/**
 * Picks the audio backend once: the native plugin when it reports audio support, else the
 * in-WebView HTMLAudio fallback (also when the native side is still the UNIMPLEMENTED stub).
 * Downloads / car / cast come from the native plugin only when its `getInfo` says so.
 */
export function playerBackend(): Promise<PlayerBackend> {
  backend ??= (async () => {
    if (!Capacitor.isNativePlatform()) {
      const plugin = ArclightPlayer;
      return { plugin, info: await plugin.getInfo(), native: false };
    }
    let info: PlayerInfo;
    try {
      info = await ArclightPlayer.getInfo();
    } catch (e) {
      if (!isUnimplemented(e)) console.warn('ArclightPlayer.getInfo failed', e);
      info = { platform: Capacitor.getPlatform() as 'ios' | 'android', version: 'stub', features: NO_FEATURES };
    }
    if (info.features.audio) return { plugin: ArclightPlayer, info, native: true };
    const web = new ArclightPlayerWeb();
    const webInfo = await web.getInfo();
    return { plugin: web, info: { ...webInfo, features: { ...webInfo.features, ...pick(info.features) } }, native: false };
  })();
  return backend;
}

/** Native-only features a stub-audio build might still offer (none today; kept for partial implementations). */
function pick(f: PlayerInfo['features']): Partial<PlayerInfo['features']> {
  return { downloads: f.downloads, car: f.car, cast: f.cast };
}

/** The native plugin for downloads, when the platform implements them (null otherwise). */
export async function downloadPlugin(): Promise<ArclightPlayerPlugin | null> {
  const b = await playerBackend();
  return b.info.features.downloads ? ArclightPlayer : null;
}

/** Tests: forget the cached backend. */
export function resetPlayerBackend(): void {
  backend = null;
}
