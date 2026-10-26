import { useEffect, useState } from 'react';
import { getReduceMotion, useReduceMotionSetting } from '../motion-preference.js';

function matches(query: string): boolean {
  return typeof window !== 'undefined' && typeof window.matchMedia === 'function' ? window.matchMedia(query).matches : false;
}

/** Live `matchMedia` result. False where matchMedia is unavailable (jsdom, SSR). */
export function useMediaQuery(query: string): boolean {
  const [value, setValue] = useState(() => matches(query));
  useEffect(() => {
    if (typeof window.matchMedia !== 'function') return;
    const mql = window.matchMedia(query);
    const onChange = () => setValue(mql.matches);
    onChange();
    mql.addEventListener?.('change', onChange);
    return () => mql.removeEventListener?.('change', onChange);
  }, [query]);
  return value;
}

export const REDUCED_MOTION_QUERY = '(prefers-reduced-motion: reduce)';

/** The OS-level setting alone (prefers-reduced-motion), ignoring the in-app switch. */
export function useOsReducedMotion(): boolean {
  return useMediaQuery(REDUCED_MOTION_QUERY);
}

/**
 * True when CSS animation is off: the OS asks for reduced motion, or the in-app "Reduce motion"
 * switch is on. Arclight drops every animation then.
 */
export function useReducedMotion(): boolean {
  const os = useOsReducedMotion();
  return useReduceMotionSetting() === 'on' || os;
}

/** Non-hook check, for event handlers. */
export function prefersReducedMotion(): boolean {
  return getReduceMotion() === 'on' || matches(REDUCED_MOTION_QUERY);
}
