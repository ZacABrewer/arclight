import { isPrivateHostname } from '@arclight/net';

// Which push endpoints a subscription may name (DATA-05, AUTH-05). The server POSTs to the
// endpoint for every notification, so an arbitrary URL would let any signed-in user make it
// call into the LAN. Browsers only ever hand out https endpoints on their vendor's push
// service, so:
//  - every endpoint must be https, on a public host;
//  - a non-admin's endpoint must be on a known push service (Google FCM, Mozilla autopush,
//    Apple, Microsoft WNS); an admin may register another public https push service (a
//    self-hosted autopush, for example).
// Sending re-checks the resolved address and never follows redirects (webpush.ts).

/** Host suffixes of the browser push services. A host matches itself or any subdomain. */
export const KNOWN_PUSH_HOSTS: readonly string[] = [
  'fcm.googleapis.com',
  'android.googleapis.com',
  'push.services.mozilla.com',
  'push.apple.com',
  'notify.windows.com',
];

export function isKnownPushHost(host: string): boolean {
  const h = host.toLowerCase().replace(/\.$/, '');
  return KNOWN_PUSH_HOSTS.some((s) => h === s || h.endsWith(`.${s}`));
}

/** Why `endpoint` may not be used, or null when it may. */
export function pushEndpointProblem(endpoint: string, isAdmin: boolean): string | null {
  let url: URL;
  try {
    url = new URL(endpoint);
  } catch {
    return 'the push endpoint is not a valid URL';
  }
  if (url.protocol !== 'https:') return 'the push endpoint must use https';
  if (url.username || url.password) return 'the push endpoint must not contain credentials';
  if (isPrivateHostname(url.hostname)) return 'the push endpoint must be a public push service';
  if (!isAdmin && !isKnownPushHost(url.hostname)) return 'the push endpoint is not a known browser push service';
  return null;
}
