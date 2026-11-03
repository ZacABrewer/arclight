import type { PlayerCapabilities } from '@arclight/shared';

// The phone's account sheet links out of the app (D7): "Request portal" for people who may
// request, "Open Arclight" for accounts with app pages. Both open in the system browser.
// The server already masks both on a profile that is not the owner; `owner` hides them before
// the profile list has loaded too. The TV shows neither (D8).

export interface AccountLinks {
  portal: string | null;
  app: string | null;
}

type Caps = Pick<PlayerCapabilities, 'portalUrl' | 'canRequest' | 'appHome'>;

/** `serverUrl`: the signed-in server ("https://nas.example.com/arclight"). */
export function accountLinks(caps: Partial<Caps> | undefined, owner: boolean, serverUrl: string | null | undefined): AccountLinks {
  if (!caps || !owner) return { portal: null, app: null };
  const server = serverUrl ? serverUrl.replace(/\/+$/, '') : null;
  // The portal's public address; signed-in users always have the built-in /portal too.
  const portal = caps.canRequest ? (caps.portalUrl ?? (server ? `${server}/portal` : null)) : null;
  const app = server && typeof caps.appHome === 'string' ? `${server}${caps.appHome}` : null;
  return { portal, app };
}

/** Opens an address in the system browser, not inside the app's web view. */
export function openInBrowser(url: string, open: (url: string, target: string) => unknown = (u, t) => window.open(u, t)): void {
  open(url, '_system');
}
