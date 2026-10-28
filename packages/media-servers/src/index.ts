/**
 * @arclight/media-servers: typed read clients for Jellyfin, Emby and Plex.
 *
 *   const client = createMediaServerClient({ kind: 'jellyfin', url, apiKey });
 *   const users = await client.users();
 *   const states = await client.listPlayStates(users[0].id, 'movie');
 *
 * Read-only apart from `refreshLibrary`. No database or HTTP-server code; the api's
 * media-servers module stores the connections (settings section `mediaServers`).
 */

import { MediaBrowserServerClient } from './media-browser.js';
import { PlexServerReadClient } from './plex.js';
import { MEDIA_SERVER_KINDS, MediaServerError, type MediaServerClient, type MediaServerClientOptions, type MediaServerKind } from './types.js';

export * from './types.js';
export { MediaBrowserServerClient, mediaBrowserProviderIds, mediaBrowserLibraryKind, ticksToMs, type MediaBrowserKind, type MediaBrowserServerOptions } from './media-browser.js';
export { PlexServerReadClient, plexProviderIds, plexLibraryKind, pathIsInside, normalisePath, PLEX_OWNER_ACCOUNT_ID, type PlexServerOptions } from './plex.js';
export { normaliseBaseUrl, idsMatchQuery } from './http.js';

export function isMediaServerKind(value: unknown): value is MediaServerKind {
  return typeof value === 'string' && (MEDIA_SERVER_KINDS as readonly string[]).includes(value);
}

/** Builds the read client for one configured server. Throws `MediaServerError('invalidSettings')`. */
export function createMediaServerClient(opts: MediaServerClientOptions): MediaServerClient {
  const extra = {
    ...(opts.fetch ? { fetch: opts.fetch } : {}),
    ...(opts.timeoutMs !== undefined ? { timeoutMs: opts.timeoutMs } : {}),
  };
  switch (opts.kind) {
    case 'jellyfin':
    case 'emby':
      return new MediaBrowserServerClient({ kind: opts.kind, url: opts.url, apiKey: opts.apiKey, ...extra });
    case 'plex':
      return new PlexServerReadClient({ url: opts.url, token: opts.apiKey, ...extra });
  }
  throw new MediaServerError('jellyfin', 'invalidSettings', `Unknown media server kind "${String(opts.kind)}"`);
}
