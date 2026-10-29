import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import {
  createMediaServerClient,
  MediaServerError,
  normaliseBaseUrl,
  pathIsInside,
  type FetchLike,
  type MediaKind,
  type MediaServerClient,
  type MediaServerClientOptions,
} from '@arclight/media-servers';
import {
  isLoginCapableKind,
  MediaServerInput,
  MediaServerTestRequest,
  SECRET_MASK,
  type MediaServerKind,
  type MediaServerAccountResource,
  type MediaServerConfig,
  type MediaServerInputRaw,
  type MediaServerProbeResult,
  type MediaServerRefreshResult,
  type MediaServerResource,
} from '@arclight/shared';
import type { Db } from '../../db/index.js';
import { getSection, setSection } from '../settings/service.js';

// The list of Jellyfin/Emby/Plex/Audiobookshelf connections (settings section `mediaServers`)
// and the one place that turns them into read clients. Other modules ask for clients by purpose:
//
//   service.clients('retention')   // enabled servers flagged usedForRetention
//
// so availability (requests), retention sweeps and post-import refreshes share one list.
// Audiobookshelf is a library server only: it takes part in post-import refreshes, never in
// sign-in (its login flags are forced off) and not yet in the video availability/retention
// purposes, whose callers speak the Jellyfin/Emby/Plex kinds.

export type MediaServerPurpose = 'availability' | 'retention' | 'refresh';

const PURPOSE_FLAG: Record<MediaServerPurpose, 'usedForAvailability' | 'usedForRetention' | 'usedForRefresh'> = {
  availability: 'usedForAvailability',
  retention: 'usedForRetention',
  refresh: 'usedForRefresh',
};

export type MediaServersErrorCode = 'NOT_FOUND' | 'VALIDATION' | 'CONFLICT' | 'SERVER_ERROR';

export class MediaServersError extends Error {
  constructor(
    readonly code: MediaServersErrorCode,
    message: string,
    options: { cause?: unknown } = {},
  ) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = 'MediaServersError';
  }
}

export type MediaServerClientFactory = (opts: MediaServerClientOptions) => MediaServerClient;

export interface MediaServersServiceOptions {
  db: Db;
  /** Injected in tests (fake servers). */
  clientFactory?: MediaServerClientFactory;
  fetch?: FetchLike;
  newId?: () => string;
}

/** What changed on disk, for `refreshPath`. */
export interface RefreshPathInput {
  /** Absolute folder (or file) that changed: an album folder after a music import, a book folder after an audiobook import. */
  path: string;
  /** Library kind the path belongs to; decides which libraries may contain it. */
  mediaType: MediaKind;
  /** Jellyfin/Emby partial refresh type. Default `Modified`. */
  updateType?: 'Created' | 'Modified' | 'Deleted';
}

/**
 * Library kinds that may hold a path of `mediaType`. Plex has no audiobook section type, so
 * audiobooks may also sit in music libraries (the path decides).
 */
export function libraryKindsFor(mediaType: MediaKind): readonly MediaKind[] {
  return mediaType === 'audiobook' ? ['audiobook', 'music'] : [mediaType];
}

export interface ConfiguredClient<C extends MediaServerConfig = MediaServerConfig> {
  config: C;
  client: MediaServerClient;
}

/** A stored connection to a Jellyfin, Emby or Plex server (not Audiobookshelf). */
export type VideoServerConfig = MediaServerConfig & { kind: MediaServerKind };

/** Login flags only apply to sign-in capable kinds; Audiobookshelf never signs users in. */
function withLoginRules<T extends Pick<MediaServerConfig, 'kind' | 'loginEnabled' | 'createUsersOnLogin'>>(config: T): T {
  return isLoginCapableKind(config.kind) ? config : { ...config, loginEnabled: false, createUsersOnLogin: false };
}

export class MediaServersService {
  private readonly db: Db;
  private readonly factory: MediaServerClientFactory;
  private readonly newId: () => string;

  constructor(opts: MediaServersServiceOptions) {
    this.db = opts.db;
    const fetchImpl = opts.fetch;
    this.factory = opts.clientFactory ?? ((o) => createMediaServerClient(fetchImpl ? { ...o, fetch: fetchImpl } : o));
    this.newId = opts.newId ?? (() => randomUUID());
  }

  // ---- stored list ---------------------------------------------------------------------

  /** Raw configs with secrets. For other api modules; never serve these. */
  stored(): MediaServerConfig[] {
    return getSection(this.db, 'mediaServers').servers;
  }

  private save(servers: MediaServerConfig[]): void {
    setSection(this.db, 'mediaServers', { servers });
  }

  list(): MediaServerResource[] {
    return this.stored().map(mask);
  }

  get(id: string): MediaServerResource {
    return mask(this.require(id));
  }

  create(raw: MediaServerInputRaw): MediaServerResource {
    const input = parseInput(raw);
    const servers = this.stored();
    assertUniqueName(servers, input.name, null);
    if (!input.apiKey || input.apiKey === SECRET_MASK) throw new MediaServersError('VALIDATION', 'apiKey is required');
    const url = cleanUrl(input.url);
    const config: MediaServerConfig = withLoginRules({ ...input, id: this.newId(), url, apiKey: input.apiKey.trim() });
    this.save([...servers, config]);
    return mask(config);
  }

  update(id: string, raw: MediaServerInputRaw): MediaServerResource {
    const input = parseInput(raw);
    const servers = this.stored();
    const current = servers.find((s) => s.id === id);
    if (!current) throw notFound(id);
    assertUniqueName(servers, input.name, id);
    const next: MediaServerConfig = withLoginRules({ ...input, id, url: cleanUrl(input.url), apiKey: mergeKey(current, input) });
    if (!next.apiKey) throw new MediaServersError('VALIDATION', 'apiKey is required');
    this.save(servers.map((s) => (s.id === id ? next : s)));
    return mask(next);
  }

  delete(id: string): void {
    const servers = this.stored();
    if (!servers.some((s) => s.id === id)) throw notFound(id);
    this.save(servers.filter((s) => s.id !== id));
  }

  // ---- clients ---------------------------------------------------------------------------

  clientFor(config: MediaServerConfig): MediaServerClient {
    return this.factory({ kind: config.kind, url: config.url, apiKey: config.apiKey });
  }

  /**
   * Enabled servers flagged for `purpose`, each with a fresh client (fresh caches). Availability
   * and retention are video purposes: Audiobookshelf servers are left out of them.
   */
  clients(purpose: 'availability' | 'retention'): ConfiguredClient<VideoServerConfig>[];
  clients(purpose: MediaServerPurpose): ConfiguredClient[];
  clients(purpose: MediaServerPurpose): ConfiguredClient[] {
    const flag = PURPOSE_FLAG[purpose];
    return this.stored()
      .filter((s) => s.enabled && s[flag] && (purpose === 'refresh' || isLoginCapableKind(s.kind)))
      .flatMap((config) => {
        try {
          return [{ config, client: this.clientFor(config) }];
        } catch {
          // Misconfigured connections (empty URL/key) are skipped; the test route reports why.
          return [];
        }
      });
  }

  // ---- refresh after import --------------------------------------------------------------

  /**
   * Post-import refresh: every enabled server flagged `usedForRefresh` whose libraries of a
   * matching kind have a folder containing `path` is asked to rescan that path. Servers with
   * no such library are skipped, failures are reported per server (never thrown), so one
   * unreachable server does not stop the others.
   */
  async refreshPath(input: RefreshPathInput): Promise<MediaServerRefreshResult[]> {
    const kinds = libraryKindsFor(input.mediaType);
    const results: MediaServerRefreshResult[] = [];
    for (const { config, client } of this.clients('refresh')) {
      const result: MediaServerRefreshResult = { serverId: config.id, name: config.name, status: 'skipped', libraries: [] };
      try {
        const matching = (await client.libraries()).filter(
          (l) => l.type !== 'other' && kinds.includes(l.type) && l.locations.some((loc) => pathIsInside(input.path, loc)),
        );
        result.libraries = matching.map((l) => l.name);
        if (matching.length === 0) {
          result.message = `No ${kinds.join('/')} library contains ${input.path}`;
        } else {
          await client.refreshLibrary({ path: input.path, mediaType: input.mediaType, ...(input.updateType ? { updateType: input.updateType } : {}) });
          result.status = 'refreshed';
        }
      } catch (err) {
        result.status = 'failed';
        result.message = err instanceof Error ? err.message : String(err);
      }
      results.push(result);
    }
    return results;
  }

  // ---- probes ----------------------------------------------------------------------------

  async test(id: string): Promise<MediaServerProbeResult> {
    return this.probe(this.require(id));
  }

  /** Tests an unsaved candidate; a masked key with `id` reuses the stored key. */
  async testCandidate(raw: z.input<typeof MediaServerTestRequest>): Promise<MediaServerProbeResult> {
    const parsed = MediaServerTestRequest.safeParse(raw);
    if (!parsed.success) throw new MediaServersError('VALIDATION', z.prettifyError(parsed.error));
    const { id, ...input } = parsed.data;
    const existing = id ? this.stored().find((s) => s.id === id) : undefined;
    const apiKey = existing ? mergeKey(existing, input) : (input.apiKey ?? '').trim();
    return this.probe({ ...input, id: id ?? 'candidate', url: cleanUrl(input.url), apiKey });
  }

  private async probe(config: MediaServerConfig): Promise<MediaServerProbeResult> {
    try {
      const client = this.clientFor(config);
      const info = await client.info();
      const libraries = (await client.libraries()).map((l) => ({ id: l.id, name: l.name, type: l.type }));
      return { ok: true, serverName: info.name, ...(info.version ? { version: info.version } : {}), libraries };
    } catch (err) {
      return {
        ok: false,
        message: err instanceof Error ? err.message : String(err),
        ...(err instanceof MediaServerError ? { code: err.code } : {}),
      };
    }
  }

  async users(id: string): Promise<MediaServerAccountResource[]> {
    const config = this.require(id);
    try {
      return await this.clientFor(config).users();
    } catch (err) {
      throw new MediaServersError('SERVER_ERROR', err instanceof Error ? err.message : String(err), { cause: err });
    }
  }

  private require(id: string): MediaServerConfig {
    const found = this.stored().find((s) => s.id === id);
    if (!found) throw notFound(id);
    return found;
  }
}

function notFound(id: string): MediaServersError {
  return new MediaServersError('NOT_FOUND', `Media server ${id} not found`);
}

function mask(config: MediaServerConfig): MediaServerResource {
  return { ...config, apiKey: config.apiKey ? SECRET_MASK : '' };
}

function parseInput(raw: MediaServerInputRaw): MediaServerInput {
  const parsed = MediaServerInput.safeParse(raw);
  if (!parsed.success) throw new MediaServersError('VALIDATION', z.prettifyError(parsed.error));
  return parsed.data;
}

function cleanUrl(url: string): string {
  const scheme = /^([a-z][a-z0-9+.-]*):\/\//i.exec(url.trim());
  if (scheme && !/^https?$/i.test(scheme[1] ?? '')) throw new MediaServersError('VALIDATION', `Invalid server URL "${url}"`);
  const normalised = normaliseBaseUrl(url);
  try {
    const u = new URL(normalised);
    if (u.protocol !== 'http:' && u.protocol !== 'https:') throw new Error('protocol');
  } catch {
    throw new MediaServersError('VALIDATION', `Invalid server URL "${url}"`);
  }
  return normalised;
}

function mergeKey(current: MediaServerConfig, input: { apiKey?: string | undefined }): string {
  const key = input.apiKey;
  if (key === undefined || key === SECRET_MASK) return current.apiKey;
  return key.trim();
}

function assertUniqueName(servers: MediaServerConfig[], name: string, selfId: string | null): void {
  if (servers.some((s) => s.id !== selfId && s.name.toLowerCase() === name.toLowerCase())) {
    throw new MediaServersError('CONFLICT', `A media server named "${name}" already exists`);
  }
}
