import { FocusManager } from './focus-manager';

// Glue between the focus manager, the router and the remote's Back button in TV mode.
//
// Back, in order: close an open dialog / menu / panel (as Escape would) → go back in history →
// from the content of a top screen, move focus to the rail → leave the app.

export interface TvRouterLike {
  history: { back(): void; length?: number; canGoBack?: () => boolean };
  state: { location: { pathname: string } };
  subscribe(event: 'onResolved', fn: () => void): () => void;
}

export interface TvRuntime {
  focus: FocusManager;
  /** Handles the Back button; false when nothing is left to do (the caller leaves the app). */
  back(canGoBack: boolean): boolean;
  stop(): void;
}

let runtime: TvRuntime | null = null;

/** Screens whose Back leaves the app (after a stop on the rail). */
const TOP_PATHS = ['/player', '/player/', '/welcome', '/'];

export function startTvRuntime(router: TvRouterLike): TvRuntime {
  runtime?.stop();
  const focus = new FocusManager({ pageKey: () => router.state.location.pathname });
  const detach = focus.attach();
  const unsubscribe = router.subscribe('onResolved', () => focus.restore());
  focus.restore();

  const back = (canGoBack: boolean): boolean => {
    if (focus.hasOpenScope()) {
      const target = document.activeElement ?? document.body;
      target.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', code: 'Escape', bubbles: true, cancelable: true }));
      return true;
    }
    const path = router.state.location.pathname;
    const top = TOP_PATHS.includes(path);
    if (canGoBack && !top) {
      router.history.back();
      return true;
    }
    if (!focus.inGroup('rail') && focus.focusGroup('rail')) return true;
    if (canGoBack) {
      router.history.back();
      return true;
    }
    return false;
  };

  // In a browser (?tv=1) Escape / Backspace stand in for the remote's Back.
  const onKey = (e: KeyboardEvent) => {
    if (e.defaultPrevented) return;
    const typing = e.target instanceof HTMLElement && (e.target.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(e.target.tagName));
    if (e.key === 'GoBack' || e.key === 'BrowserBack' || (!typing && (e.key === 'Escape' || e.key === 'Backspace'))) {
      if (e.key === 'Escape' && focus.hasOpenScope()) return; // the dialog closes itself
      e.preventDefault();
      back(window.history.length > 1);
    }
  };
  window.addEventListener('keydown', onKey);

  runtime = {
    focus,
    back,
    stop() {
      detach();
      unsubscribe();
      window.removeEventListener('keydown', onKey);
      if (runtime?.focus === focus) runtime = null;
    },
  };
  return runtime;
}

export function tvRuntime(): TvRuntime | null {
  return runtime;
}
