import { useSyncExternalStore } from 'react';

// The active theme (theme packs, Settings → UI). The built-in look is "tron": no data-theme
// attribute and no extra stylesheet. A pack theme adds `<link id="al-theme-css">` with the pack's
// stylesheet and, once it has loaded (so the page never shows half a theme), sets
// `<html data-theme="<id>">`, the color-scheme meta and the browser theme colour. The last theme
// is kept on this device so the next visit paints it before the api answers.

export type ThemeBackdropKind = 'tron' | 'shapes' | 'none';

export interface ActiveTheme {
  id: string;
  /** Stylesheet URL; null for the built-in look. */
  href: string | null;
  colorScheme: 'dark' | 'light';
  backdrop: ThemeBackdropKind;
  /** Browser theme colour (the pack's first swatch). */
  themeColor: string;
}

export const BUILTIN_THEME: Readonly<ActiveTheme> = Object.freeze({ id: 'tron', href: null, colorScheme: 'dark', backdrop: 'tron', themeColor: '#000000' });

const STORAGE_KEY = 'arclight.theme';
const LINK_ID = 'al-theme-css';

let current: ActiveTheme = BUILTIN_THEME;
/** The theme being switched to; a stylesheet that finishes loading after a later switch is ignored. */
let pending: ActiveTheme | null = null;
const listeners = new Set<() => void>();

function readStored(): ActiveTheme | null {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    const v = JSON.parse(raw) as Partial<ActiveTheme>;
    if (typeof v.id !== 'string' || (v.href !== null && typeof v.href !== 'string')) return null;
    return {
      id: v.id,
      href: v.href ?? null,
      colorScheme: v.colorScheme === 'light' ? 'light' : 'dark',
      backdrop: v.backdrop === 'shapes' || v.backdrop === 'none' ? v.backdrop : 'tron',
      themeColor: typeof v.themeColor === 'string' ? v.themeColor : BUILTIN_THEME.themeColor,
    };
  } catch {
    return null;
  }
}

function store(theme: ActiveTheme): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(theme));
  } catch {
    // private mode / storage blocked: the theme still applies for this page
  }
}

function setMeta(name: string, content: string): void {
  let el = document.head.querySelector<HTMLMetaElement>(`meta[name="${name}"]`);
  if (!el) {
    el = document.createElement('meta');
    el.name = name;
    document.head.appendChild(el);
  }
  el.content = content;
}

function commit(theme: ActiveTheme): void {
  const root = document.documentElement;
  if (theme.href) root.setAttribute('data-theme', theme.id);
  else root.removeAttribute('data-theme');
  root.style.colorScheme = theme.colorScheme;
  setMeta('color-scheme', theme.colorScheme);
  setMeta('theme-color', theme.themeColor);
  // Only the new theme's stylesheet stays.
  for (const link of document.head.querySelectorAll<HTMLLinkElement>(`link[data-al-theme]`)) {
    if (link.getAttribute('href') !== theme.href) link.remove();
  }
  current = theme;
  for (const l of listeners) l();
}

/** Switches to `theme`: loads its stylesheet first, then flips the page over in one go. */
export function applyTheme(theme: ActiveTheme): void {
  if (typeof document === 'undefined') return;
  store(theme);
  pending = theme;
  if (!theme.href) return commit(theme);
  const existing = Array.from(document.head.querySelectorAll<HTMLLinkElement>('link[data-al-theme]')).find((l) => l.getAttribute('href') === theme.href);
  if (existing?.dataset.loaded === '1') return commit(theme);
  const link = existing ?? document.createElement('link');
  if (!existing) {
    link.rel = 'stylesheet';
    link.id = LINK_ID;
    link.dataset.alTheme = theme.id;
    link.href = theme.href;
    document.head.appendChild(link);
  }
  const done = () => {
    link.dataset.loaded = '1';
    // A later switch may have replaced this one while it loaded.
    if (pending === theme) commit(theme);
  };
  link.addEventListener('load', done, { once: true });
  // A stylesheet that fails to load must not strand the page: fall back to the built-in look.
  link.addEventListener(
    'error',
    () => {
      link.remove();
      if (pending === theme) commit(BUILTIN_THEME);
    },
    { once: true },
  );
}

/** Paints the theme this device used last, before anything is fetched. */
export function restoreTheme(): void {
  const stored = readStored();
  if (stored && stored.id !== BUILTIN_THEME.id) applyTheme(stored);
}

export function getActiveTheme(): ActiveTheme {
  return current;
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** The active theme, live. */
export function useActiveTheme(): ActiveTheme {
  return useSyncExternalStore(subscribe, getActiveTheme, getActiveTheme);
}
