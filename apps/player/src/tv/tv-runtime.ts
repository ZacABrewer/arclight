import { FocusManager } from './focus-manager';

// Glue between the focus manager, the router and the remote's Back button in TV mode.
//
// Back follows the design (spec §4.3), in order:
//  1. an open panel ([data-tv-scope], dialogs, menus) closes, as Escape would;
//  2. a pushed screen (a title's detail, Listen, …) goes back to where it was opened from;
//  3. on a top tab other than Home: to Home, focus on the Home tab;
//  4. on Home: from anywhere to the Home tab; from the Home tab, leave the app;
//  5. "Who's watching?": nothing.
// Screens outside the stage (welcome, sign-in) keep the plain history back.

export interface TvRouterLike {
  history: { back(): void; length?: number; canGoBack?: () => boolean };
  state: { location: { pathname: string } };
  subscribe(event: 'onResolved', fn: () => void): () => void;
  navigate(opts: { to: string }): unknown;
}

export interface TvRuntime {
  focus: FocusManager;
  /** Handles the Back button; false when nothing is left to do (the caller leaves the app). */
  back(canGoBack: boolean): boolean;
  stop(): void;
}

let runtime: TvRuntime | null = null;

export const HOME_PATH = '/player';
/** The header's tabs: their Back goes to Home (the design's tab()). */
export const TAB_PATHS = ['/player/watch/shows', '/player/watch/movies', '/player/watch/my-list', '/player/search', '/player/discover', '/player/music', '/player/books', '/player/settings'];
export const PROFILES_PATH = '/profiles';

const norm = (p: string) => (p.length > 1 ? p.replace(/\/+$/, '') : p);
const isHome = (p: string) => norm(p) === HOME_PATH || norm(p) === '/player/watch';

const query = (sel: string) => (typeof document === 'undefined' ? null : document.querySelector<HTMLElement>(sel));
const tabEl = (id: string) => query(`[data-tv-key="tab-${id}"]`);

export function startTvRuntime(router: TvRouterLike): TvRuntime {
  runtime?.stop();
  const focus = new FocusManager({ pageKey: () => router.state.location.pathname });
  const detach = focus.attach();
  const unsubscribe = router.subscribe('onResolved', () => focus.restore());
  // A cold start (WebView, lazy chunks, the first queries) can take a while before anything renders.
  focus.restore(10_000);

  const back = (canGoBack: boolean): boolean => {
    if (focus.hasOpenScope()) {
      const target = document.activeElement ?? document.body;
      target.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', code: 'Escape', bubbles: true, cancelable: true }));
      return true;
    }
    const path = norm(router.state.location.pathname);
    const onStage = Boolean(query('[data-tv-stage]'));
    if (!onStage) {
      if (canGoBack) {
        router.history.back();
        return true;
      }
      return false;
    }
    if (path === PROFILES_PATH) return true;
    if (isHome(path)) {
      const home = tabEl('home');
      const active = document.activeElement;
      if (home && active === home) return false;
      if (home) focus.focus(home, undefined, true);
      return true;
    }
    if (TAB_PATHS.includes(path)) {
      const home = tabEl('home');
      if (home) focus.focus(home, undefined, true);
      void router.navigate({ to: HOME_PATH });
      return true;
    }
    if (canGoBack) router.history.back();
    else void router.navigate({ to: HOME_PATH });
    return true;
  };

  // In a browser (?tv=1) Escape / Backspace stand in for the remote's Back.
  const onKey = (e: KeyboardEvent) => {
    if (e.defaultPrevented) return;
    const typing = e.target instanceof HTMLElement && (e.target.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(e.target.tagName));
    if (e.key === 'GoBack' || e.key === 'BrowserBack' || (!typing && (e.key === 'Escape' || e.key === 'Backspace'))) {
      if (e.key === 'Escape' && focus.hasOpenScope()) return; // the panel closes itself
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
