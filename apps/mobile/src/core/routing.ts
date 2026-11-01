import { normalizeBaseUrl } from './address.js';
import { serverForUrl, type Server } from './servers.js';

// Where a notification tap or a share goes.

/** A same-server path: starts with one "/", no scheme, no "//" (would be another host), no backslashes. */
export function isSafePath(path: unknown): path is string {
  return typeof path === 'string' && path.startsWith('/') && !path.startsWith('//') && !path.includes('\\') && !/[\u0000-\u001f]/.test(path);
}

export interface RouteTarget {
  server: Server;
  /** Absolute URL to open in the WebView. */
  url: string;
}

/**
 * Notification payload data: { url: "/requests/12", server: "https://arclight.example.com" }.
 * The server must be one of the saved servers (never open a URL a payload made up); without
 * `server`, the fallback server (the current page's or the selected one) is used.
 */
export function routeNotification(data: Record<string, unknown> | null | undefined, servers: readonly Server[], fallback: Server | null): RouteTarget | null {
  if (!data) return null;
  const path = isSafePath(data.url) ? data.url : '/';
  let server: Server | null = fallback;
  if (typeof data.server === 'string' && data.server) {
    try {
      const wanted = normalizeBaseUrl(data.server).toLowerCase();
      server = servers.find((s) => s.url.toLowerCase() === wanted) ?? serverForUrl(servers, data.server) ?? null;
    } catch {
      server = null;
    }
  }
  if (!server) return null;
  return { server, url: `${server.url}${path}` };
}

// Share sheet: "Request in Arclight" with an IMDb / TMDB link or plain text.

/** Search text for whatever was shared (title preferred; else the IMDb id / TMDB link). */
export function shareQuery(title: string | null | undefined, texts: readonly string[]): string | null {
  const all = [title ?? '', ...texts].join('\n');
  const urls = all.match(/https?:\/\/\S+/gi) ?? [];
  // Text around the link, minus site suffixes ("Dune (2021) - IMDb", "Dune — The Movie Database (TMDB)").
  // IMDb's app shares "Dune: Part Two (2024) ⭐ 8.5 | Action, Adventure\n<link>": keep the first
  // line's title, drop rating/genres, the year in brackets and site names.
  const firstLine =
    all
      .replace(/https?:\/\/\S+/gi, ' ')
      .split(/\r?\n/)
      .map((l) => l.trim())
      .find((l) => l.length > 0) ?? '';
  const words = firstLine
    .replace(/\s*(⭐|★|\|).*$/, '')
    .replace(/\s*[-–—:]\s*(IMDb|The Movie Database( \(TMDB\))?|TMDB)\b.*$/i, '')
    .replace(/^(IMDb|TMDB)$/i, '')
    .replace(/\s*\((19|20)\d{2}\)\s*$/, '')
    .replace(/\s+/g, ' ')
    .trim();
  if (words) return words.slice(0, 200);
  for (const u of urls) {
    const imdb = /imdb\.com\/(?:[a-z]{2}\/)?title\/(tt\d+)/i.exec(u);
    if (imdb) return imdb[1]!;
    const tmdb = /themoviedb\.org\/(movie|tv)\/(\d+)(?:-([\w-]+))?/i.exec(u);
    if (tmdb) return tmdb[3] ? tmdb[3].replace(/-/g, ' ') : `tmdb:${tmdb[1]!.toLowerCase()}/${tmdb[2]}`;
  }
  return null;
}

/** The server's discover search page (the web UI sends non-admins on to the portal's search). */
export function discoverSearchPath(query: string): string {
  return `/discover/search?q=${encodeURIComponent(query)}`;
}
