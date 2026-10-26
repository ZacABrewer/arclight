import { useSyncExternalStore } from 'react';

// The global "Reduce motion" switch (handoff README, Motion layer v1.1). The app sets it from the
// signed-in user's preference; the design system reads it.
//   system — follow the OS (prefers-reduced-motion)
//   on     — reduce: no backdrop canvas and <html data-motion="off"> stops every CSS animation
//   off    — keep the ambient motion even when the OS asks to reduce it (the backdrop canvas
//            runs; CSS animations still honour the OS media query)

export type ReduceMotionSetting = 'system' | 'on' | 'off';

export const REDUCE_MOTION_SETTINGS: readonly ReduceMotionSetting[] = ['system', 'on', 'off'];

let current: ReduceMotionSetting = 'system';
const listeners = new Set<() => void>();

function applyRootAttribute(setting: ReduceMotionSetting): void {
  if (typeof document === 'undefined') return;
  const root = document.documentElement;
  if (setting === 'on') root.setAttribute('data-motion', 'off');
  else root.removeAttribute('data-motion');
}

/** Sets the switch, updates `data-motion` on the document root and notifies subscribers. */
export function setReduceMotion(setting: ReduceMotionSetting): void {
  applyRootAttribute(setting);
  if (setting === current) return;
  current = setting;
  for (const l of listeners) l();
}

export function getReduceMotion(): ReduceMotionSetting {
  return current;
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** The live "Reduce motion" setting. */
export function useReduceMotionSetting(): ReduceMotionSetting {
  return useSyncExternalStore(subscribe, getReduceMotion, getReduceMotion);
}
