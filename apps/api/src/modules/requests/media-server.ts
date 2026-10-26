import { and, eq, inArray } from 'drizzle-orm';
import type { MediaType } from '@media-tron/shared';
import type { Db } from '../../db/index.js';
import { notifications } from '../../db/schema.js';

// Optional "is it on the media server?" check used by RequestsStatusSync on top of the
// library. The default answers nothing (library-only availability). The Jellyfin/Emby
// implementation reuses the host and API key of the media-server connections configured
// under Settings > Notifications.

export interface AvailabilityQuery {
  mediaType: MediaType;
  tmdbId: number;
  tvdbId?: number | null;
}

export interface MediaServerAvailability {
  readonly name: string;
  /** true: present on a media server; false: definitely absent; null: unknown (ignored). */
  isAvailable(query: AvailabilityQuery, signal?: AbortSignal): Promise<boolean | null>;
}

/** Library-only: never overrides what the library says. */
export const libraryOnlyAvailability: MediaServerAvailability = {
  name: 'library',
  isAvailable: async () => null,
};

export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

interface ServerConn {
  kind: 'jellyfin' | 'emby';
  baseUrl: string;
  apiKey: string;
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
      return baseUrl && apiKey ? [{ kind: row.implementation as 'jellyfin' | 'emby', baseUrl, apiKey }] : [];
    });
}

/**
 * Asks each Jellyfin/Emby server for an item with the TMDB (or TVDB) provider id. Any server
 * that has it makes the title available; errors count as "unknown" so a down server never
 * demotes anything.
 */
export function jellyfinAvailability(db: Db, fetchImpl: FetchLike = (u, i) => globalThis.fetch(u, i)): MediaServerAvailability {
  return {
    name: 'jellyfin',
    async isAvailable(query, signal) {
      const servers = mediaServerConnections(db);
      if (servers.length === 0) return null;
      let sawAnswer = false;
      for (const server of servers) {
        const url = new URL(`${server.baseUrl}/Items`);
        url.searchParams.set('Recursive', 'true');
        url.searchParams.set('IncludeItemTypes', query.mediaType === 'movie' ? 'Movie' : 'Series');
        const ids = [`Tmdb.${query.tmdbId}`];
        if (query.tvdbId) ids.push(`Tvdb.${query.tvdbId}`);
        url.searchParams.set('AnyProviderIdEquals', ids.join(','));
        url.searchParams.set('Limit', '1');
        try {
          const res = await fetchImpl(url.toString(), {
            headers: { 'X-Emby-Token': server.apiKey, Accept: 'application/json' },
            ...(signal ? { signal } : {}),
          });
          if (!res.ok) continue;
          const body = (await res.json()) as { TotalRecordCount?: number; Items?: unknown[] };
          sawAnswer = true;
          if ((body.TotalRecordCount ?? body.Items?.length ?? 0) > 0) return true;
        } catch {
          continue;
        }
      }
      return sawAnswer ? false : null;
    },
  };
}
