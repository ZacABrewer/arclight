import { useEffect } from 'react';
import { useQuery } from '@tanstack/react-query';
import { ThemeCatalog } from '@arclight/shared';
import { request } from '../core/api';
import { useSession } from '../app/context';

// The player follows the active profile's theme (spec §4.1, §9 Q7): null means `cinema`, the
// design's own values. The app is served from the device, so the pack's stylesheet is fetched
// from the server as text and put in a <style> (index.html's CSP allows inline styles, not remote
// stylesheets), with its relative url()s made absolute. A theme the server does not have leaves
// the app on its built-in look.

export const DEFAULT_PLAYER_THEME = 'cinema';
const STYLE_ID = 'al-app-theme';

/** Make a pack's relative url(...) references absolute against the stylesheet's own URL. */
export function absolutizeCss(css: string, base: string): string {
  return css.replace(/url\(\s*(['"]?)([^'")]+)\1\s*\)/g, (whole, q: string, ref: string) => {
    if (/^(data:|https?:|blob:|#)/i.test(ref)) return whole;
    try {
      return `url(${q}${new URL(ref, base).toString()}${q})`;
    } catch {
      return whole;
    }
  });
}

export function themeStylesheetUrl(serverUrl: string, cssPath: string): string {
  return `${serverUrl.replace(/\/+$/, '')}/api/v1/${cssPath.replace(/^\/+/, '')}`;
}

function applyTheme(id: string | null, css: string | null): void {
  const root = document.documentElement;
  let el = document.getElementById(STYLE_ID) as HTMLStyleElement | null;
  if (!id || css == null) {
    el?.remove();
    if (root.dataset.playerTheme) {
      delete root.dataset.playerTheme;
      delete root.dataset.theme;
    }
    return;
  }
  if (!el) {
    el = document.createElement('style');
    el.id = STYLE_ID;
    document.head.appendChild(el);
  }
  if (el.textContent !== css) el.textContent = css;
  root.dataset.theme = id;
  root.dataset.playerTheme = id;
}

export function useProfileTheme(theme: string | null | undefined): void {
  const session = useSession();
  const want = theme ?? DEFAULT_PLAYER_THEME;
  const server = session?.serverUrl ?? null;
  const catalog = useQuery({
    queryKey: ['app-theme', 'catalog', server],
    queryFn: () => request('/theme', ThemeCatalog),
    enabled: Boolean(server),
    staleTime: 10 * 60_000,
    retry: false,
  });
  const info = catalog.data?.themes.find((t) => t.id === want && t.css) ?? null;
  const cssPath = info?.css ?? null;
  const sheet = useQuery({
    queryKey: ['app-theme', 'css', server, cssPath],
    queryFn: async () => {
      const url = themeStylesheetUrl(server ?? '', cssPath ?? '');
      const res = await fetch(url, { credentials: 'omit' });
      if (!res.ok) throw new Error(`theme ${res.status}`);
      return absolutizeCss(await res.text(), url);
    },
    enabled: Boolean(server && cssPath),
    staleTime: Infinity,
    retry: false,
  });
  const css = sheet.data ?? null;
  const ready = catalog.isSuccess && (!cssPath || sheet.isSuccess || sheet.isError);
  useEffect(() => {
    if (!ready) return;
    applyTheme(cssPath && css != null ? want : null, css);
  }, [ready, want, cssPath, css]);
  useEffect(() => () => applyTheme(null, null), []);
}
