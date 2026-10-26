import { createContext, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import { useMatches } from '@tanstack/react-router';

// Per-page shell options. A page opts out of the spire (dense pages such as Details) or
// moves the vanishing point (404) either with the hook, from inside the page:
//
//   useBackdropOptions({ spire: false });
//
// or declaratively on its route: createRoute({ …, staticData: { backdrop: { spire: false } } }).
// The hook wins over staticData; both reset when the page unmounts.

export interface BackdropOptions {
  spire?: boolean | undefined;
  circuit?: boolean | undefined;
  /** Vanishing point x as a fraction of the width. */
  vx?: number | undefined;
  /** Horizon y as a fraction of the height. */
  horizon?: number | undefined;
}

declare module '@tanstack/react-router' {
  interface StaticDataRouteOption {
    backdrop?: BackdropOptions;
  }
}

interface ShellOptionsValue {
  backdrop: BackdropOptions;
  setBackdrop: (opts: BackdropOptions | null) => void;
}

const ShellOptionsContext = createContext<ShellOptionsValue | null>(null);

export function ShellOptionsProvider({ children }: { children: ReactNode }) {
  const [backdrop, setState] = useState<BackdropOptions | null>(null);
  const value = useMemo<ShellOptionsValue>(() => ({ backdrop: backdrop ?? {}, setBackdrop: setState }), [backdrop]);
  return <ShellOptionsContext.Provider value={value}>{children}</ShellOptionsContext.Provider>;
}

/**
 * Set the shell backdrop for the current page. Pass a stable value or literal; options are
 * compared by value. Outside the shell (bare pages, tests) it does nothing.
 */
export function useBackdropOptions(opts: BackdropOptions): void {
  const ctx = useContext(ShellOptionsContext);
  const setBackdrop = ctx?.setBackdrop;
  const key = JSON.stringify(opts);
  useEffect(() => {
    if (!setBackdrop) return;
    setBackdrop(JSON.parse(key) as BackdropOptions);
    return () => setBackdrop(null);
  }, [setBackdrop, key]);
}

/** Backdrop props for the shell: defaults (spire + circuit on) ← route staticData ← page hook. */
export function useResolvedBackdrop(): Required<Pick<BackdropOptions, 'spire' | 'circuit'>> & BackdropOptions {
  const ctx = useContext(ShellOptionsContext);
  // Selected as a string so the selector result is stable between renders.
  const routeKey = useMatches({ select: (ms) => JSON.stringify(ms.reduce<BackdropOptions>((acc, m) => ({ ...acc, ...(m.staticData?.backdrop ?? {}) }), {})) });
  const fromRoute = useMemo(() => JSON.parse(routeKey) as BackdropOptions, [routeKey]);
  const merged: BackdropOptions = { ...fromRoute, ...(ctx?.backdrop ?? {}) };
  return { ...merged, spire: merged.spire ?? true, circuit: merged.circuit ?? true };
}
