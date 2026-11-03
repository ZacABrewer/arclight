import { useSyncExternalStore } from 'react';

// Which layout the phone app draws (spec §4.4 / §4.5): `portrait` for a phone held upright,
// `wide` for phones on their side and tablets. TVs never get here (the TV frame is separate).

export type Layout = 'tv' | 'portrait' | 'wide';

export function layoutFor(width: number, height: number, tv = false): Layout {
  if (tv) return 'tv';
  if (width < 700 || (height > width && width < 900)) return 'portrait';
  return 'wide';
}

const subscribe = (cb: () => void) => {
  window.addEventListener('resize', cb);
  return () => window.removeEventListener('resize', cb);
};

export function useLayout(tv = false): Layout {
  return useSyncExternalStore(
    subscribe,
    () => layoutFor(window.innerWidth, window.innerHeight, tv),
    () => 'portrait' as Layout,
  );
}
