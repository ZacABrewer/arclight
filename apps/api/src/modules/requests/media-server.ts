import { and, eq, inArray } from 'drizzle-orm';
import {
  MediaBrowserClient,
  PlexServerClient,
  idsMatch,
  type FetchLike,
  type SeasonPresence,
} from '@arclight/notifications';
import type { MediaServerConfig, MediaServerKind, MediaServerSettings, MediaType } from '@arclight/shared';
import type { Db } from '../../db/index.js';
import { notifications } from '../../db/schema.js';
import { mediaServerView } from '../media-servers/index.js';
import { getSection } from '../settings/service.js';

// "Is it on the media server?" for RequestsStatusSync (docs/spec/requests.md section 10,
// adapted). The servers are the enabled entries of Settings > Media servers flagged
// `usedForAvailability` (media-servers module); when there are none, the enabled Jellyfin/Emby
// connections under Settings > Notifications are used (host + API key). The lookups stay on the
// @arclight/notifications clients because they need per-season episode counts, which the
// read-only @arclight/media-servers client does not expose.
//
// Jellyfin/Emby: items by provider id (Tmdb, Tvdb for series), episodes counted per season.
// Plex: the movie/show libraries are indexed by guid (cached for a few minutes, since Plex
// cannot filter by external id) and seasons report their episode count (leafCount).

export type { FetchLike };

export interface AvailabilityQuery {
  mediaType: MediaType;
  tmdbId: number;
  tvdbId?: number | null;
}

/**
 * Result of one lookup. `unconfigured`: no media server at all (callers fall back to the
 * library); `error`: the server could not answer (callers change nothing).
 */
export type MediaServerLookup =
  | { state: 'unconfigured' }
  | { state: 'error'; message: string }
  | { state: 'absent' }
  | { state: 'present'; serverName: string; itemId: string; seasons: SeasonPresence[] };

export interface MediaServerAvailability {
  readonly name: string;
  /** true: present on a media server; false: definitely absent; null: unknown (ignored). */
  isAvailable(query: AvailabilityQuery, signal?: AbortSignal): Promise<boolean | null>;
  /** Richer answer with per-season episode counts; implementations without it only answer isAvailable. */
  lookup?(query: AvailabilityQuery, signal?: AbortSignal): Promise<MediaServerLookup>;
}

/** Library-only: never overrides what the library says. */
export const libraryOnlyAvailability: MediaServerAvailability = {
  name: 'library',
  isAvailable: async () => null,
  lookup: async () => ({ state: 'unconfigured' }),
};

export const DEFAULT_SERVER_NAMES: Record<MediaServerKind, string> = { jellyfin: 'Jellyfin', emby: 'Emby', plex: 'Plex' };

/** One reachable media server. */
export interface ServerConn {
  kind: MediaServerKind;
  baseUrl: string;
  apiKey: string;
  name: string;
}

function baseUrlOf(settings: Record<string, unknown>): string | null {
  const host = typeof settings['host'] === 'string' ? settings['host'].trim() : '';
  if (!host) return null;
  const port = typeof settings['port'] === 'number' ? settings['port'] : 8096;
  const scheme = settings['useSsl'] === true ? 'https' : 'http';
  const urlBase = typeof settings['urlBase'] === 'string' ? settings['urlBase'].replace(/^\/*/, '/').replace(/\/+$/, '') : '';
  const cleanHost = host.replace(/^https?:\/\//, '').replace(/\/+$/, '');
  return `${scheme}://${cleanHost}:${port}${urlBase === '/' ? '' : urlBase}`;
}

/** Enabled Jellyfin/Emby connections from the notifications table. */
export function mediaServerConnections(db: Db): ServerConn[] {
  return db
    .select()
    .from(notifications)
    .where(and(inArray(notifications.implementation, ['jellyfin', 'emby']), eq(notifications.enabled, true)))
    .all()
    .flatMap((row): ServerConn[] => {
      const baseUrl = baseUrlOf(row.settings);
      const apiKey = typeof row.settings['apiKey'] === 'string' ? row.settings['apiKey'] : '';
      const kind = row.implementation as 'jellyfin' | 'emby';
      return baseUrl && apiKey ? [{ kind, baseUrl, apiKey, name: row.name || DEFAULT_SERVER_NAMES[kind] }] : [];
    });
}

/** The single-server view over the media servers list (sign-in, links, user import). */
export function mediaServerSettings(db: Db): MediaServerSettings {
  return mediaServerView(db);
}

/** The view's media server (first login-enabled entry of the list), or null. */
export function configuredServer(db: Db): ServerConn | null {
  const s = mediaServerSettings(db);
  if (!s.kind || !s.url || !s.apiKey) return null;
  return { kind: s.kind, baseUrl: s.url.replace(/\/+$/, ''), apiKey: s.apiKey, name: s.name || DEFAULT_SERVER_NAMES[s.kind] };
}

export function toServerConn(config: Pick<MediaServerConfig, 'kind' | 'url' | 'apiKey' | 'name'>): ServerConn {
  return { kind: config.kind, baseUrl: config.url.replace(/\/+$/, ''), apiKey: config.apiKey, name: config.name || DEFAULT_SERVER_NAMES[config.kind] };
}

/** Enabled list entries flagged usedForAvailability (read straight from the settings section). */
export function listedAvailabilityServers(db: Db): ServerConn[] {
  return getSection(db, 'mediaServers')
    .servers.filter((s) => s.enabled && s.usedForAvailability && s.url && s.apiKey)
    .map(toServerConn);
}

/** Servers to ask: the listed ones, else the Jellyfin/Emby notification connections. */
export function availabilityServers(db: Db): ServerConn[] {
  const listed = listedAvailabilityServers(db);
  return listed.length > 0 ? listed : mediaServerConnections(db);
}

const PLEX_INDEX_TTL_MS = 5 * 60_000;

interface PlexIndex {
  at: number;
  items: Awaited<ReturnType<PlexServerClient['libraryItems']>>;
}

/**
 * Asks each server for the title. Any server that has it wins; an error on every server is
 * "error" (nothing is demoted or completed on a down server).
 */
export function mediaServerAvailability(
  db: Db,
  fetchImpl: FetchLike = (u, i) => globalThis.fetch(u, i),
  opts: { servers?: (db: Db) => ServerConn[]; now?: () => number } = {},
): MediaServerAvailability {
  const serversOf = opts.servers ?? availabilityServers;
  const now = opts.now ?? (() => Date.now());
  const plexIndexes = new Map<string, PlexIndex>();

  async function lookupOne(server: ServerConn, query: AvailabilityQuery, signal?: AbortSignal): Promise<MediaServerLookup> {
    const fetchWithSignal: FetchLike = (u, i) => fetchImpl(u, { ...i, ...(signal ? { signal } : {}) });
    if (server.kind === 'plex') {
      const client = new PlexServerClient({ url: server.baseUrl, token: server.apiKey, fetch: fetchWithSignal });
      const key = `${server.baseUrl}|${server.apiKey}`;
      let index = plexIndexes.get(key);
      if (!index || now() - index.at > PLEX_INDEX_TTL_MS) {
        index = { at: now(), items: await client.libraryItems() };
        plexIndexes.set(key, index);
      }
      const item = index.items.find((i) => i.mediaType === query.mediaType && idsMatch(i.ids, query.tmdbId, query.mediaType === 'series' ? query.tvdbId : null));
      if (!item) return { state: 'absent' };
      const seasons = query.mediaType === 'series' ? await client.seasonPresence(item.ratingKey) : [];
      return { state: 'present', serverName: server.name, itemId: item.ratingKey, seasons };
    }
    const client = new MediaBrowserClient({ kind: server.kind, url: server.baseUrl, apiKey: server.apiKey, fetch: fetchWithSignal });
    const match = await client.findByIds(query.mediaType, query.tmdbId, query.mediaType === 'series' ? query.tvdbId : null);
    if (!match) return { state: 'absent' };
    return { state: 'present', serverName: server.name, itemId: match.item.id, seasons: match.seasons };
  }

  async function lookup(query: AvailabilityQuery, signal?: AbortSignal): Promise<MediaServerLookup> {
    const servers = serversOf(db);
    if (servers.length === 0) return { state: 'unconfigured' };
    let answered = false;
    let lastError = '';
    for (const server of servers) {
      try {
        const found = await lookupOne(server, query, signal);
        if (found.state === 'present') return found;
        answered = true;
      } catch (err) {
        lastError = err instanceof Error ? err.message : String(err);
      }
    }
    return answered ? { state: 'absent' } : { state: 'error', message: lastError || 'media server unreachable' };
  }

  return {
    name: 'mediaServer',
    lookup,
    async isAvailable(query, signal) {
      const found = await lookup(query, signal);
      return found.state === 'present' ? true : found.state === 'absent' ? false : null;
    },
  };
}

/** The Jellyfin/Emby notification connections only (kept for callers that want just those). */
export function jellyfinAvailability(db: Db, fetchImpl: FetchLike = (u, i) => globalThis.fetch(u, i)): MediaServerAvailability {
  return { ...mediaServerAvailability(db, fetchImpl, { servers: mediaServerConnections }), name: 'jellyfin' };
}
