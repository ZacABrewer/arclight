import { useSyncExternalStore } from 'react';

// The layout switch (redesign spec §4.4): one composition per form factor. The web /player and
// the app on phones use 'portrait' and 'wide'; 'tv' is the app on a TV (builder D passes it in).

export type PlayerLayout = 'tv' | 'portrait' | 'wide';

/** Portrait under 700 px wide, or taller than wide while under 900 px wide; else wide. */
export function layoutFor(width: number, height: number, tv = false): PlayerLayout {
  if (tv) return 'tv';
  if (width < 700 || (height > width && width < 900)) return 'portrait';
  return 'wide';
}

function subscribe(listener: () => void): () => void {
  if (typeof window === 'undefined') return () => {};
  window.addEventListener('resize', listener);
  window.addEventListener('orientationchange', listener);
  return () => {
    window.removeEventListener('resize', listener);
    window.removeEventListener('orientationchange', listener);
  };
}

const read = () => (typeof window === 'undefined' ? 'wide' : layoutFor(window.innerWidth, window.innerHeight));

/** The layout for the current viewport, live. `tv` forces 'tv' (the app on a TV). */
export function useLayout(tv = false): PlayerLayout {
  const layout = useSyncExternalStore(subscribe, read, () => 'wide' as const);
  return tv ? 'tv' : layout;
}

/** Wide tile scale (§4.5): the TV sizes times clamp(0.8, vw / 1280, 1.2). */
export function tileScale(width: number): number {
  return Math.min(1.2, Math.max(0.8, width / 1280));
}
