import { buildUrl } from '../../api/client.js';
import { PLAYER_ROOT } from './player-location.js';

// "Copy link" on title pages: the player's public address (GET /playback/me `playerUrl`, from
// Settings > Player > Player address) plus the title's page. `playerUrl` always names the
// player's root (https://watch.example.com, https://example.com/watch or
// https://example.com/player), so the page goes on as its path below /player
// (/watch/movies/12). Without one, the server this page talks to is used: the page's own
// address in the browser, the signed-in server in the Arclight app (whose api client stands in
// for this one).

/** The server's address with its base path ("https://example.com/arclight"), from the api root. */
export function serverOrigin(apiUrl: string = buildUrl(''), page: string = typeof location === 'undefined' ? 'http://localhost/' : location.href): string {
  return new URL(apiUrl, page).href.replace(/\/api\/v1\/?$/, '').replace(/\/+$/, '');
}

export type ShareTarget = { kind: 'movie' | 'show' | 'album' | 'book'; id: number };

/** The page of a title below the player root ("/watch/movies/12"). */
export function sharePathOf(target: ShareTarget): string {
  switch (target.kind) {
    case 'movie':
      return `/watch/movies/${target.id}`;
    case 'show':
      return `/watch/shows/${target.id}`;
    case 'album':
      return `/music/album/${target.id}`;
    case 'book':
      return `/books/${target.id}`;
  }
}

/** The link to share for a title. `origin` is this page's origin and base path (tests pass it). */
export function shareUrlFor(target: ShareTarget, playerUrl: string | null | undefined, origin: string = serverOrigin()): string {
  const root = (playerUrl ?? `${origin}${PLAYER_ROOT}`).replace(/\/+$/, '');
  return `${root}${sharePathOf(target)}`;
}

/** Puts the link on the clipboard; false when the browser refuses (no permission, insecure page). */
export async function copyText(text: string, clipboard: Pick<Clipboard, 'writeText'> | undefined = typeof navigator === 'undefined' ? undefined : navigator.clipboard): Promise<boolean> {
  if (!clipboard) return false;
  try {
    await clipboard.writeText(text);
    return true;
  } catch {
    return false;
  }
}
