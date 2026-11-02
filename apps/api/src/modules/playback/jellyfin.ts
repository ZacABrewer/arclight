import { randomUUID } from 'node:crypto';
import { MediaServerError, type MediaBrowserAudioPath, type MediaBrowserAudioStreamSpec, type MediaServerClient } from '@arclight/media-servers';
import { isMediaBrowserKind, type MediaServerConfig, type PlayerEngineTestResult, type PlayerSettings } from '@arclight/shared';

// The player's Jellyfin engine (Settings → Player → Playback engine). With it on, the stream
// route still does every check (access, signed links, caps, remote rules) and then, instead of
// reading the file itself, finds the file's Audio item on the chosen Jellyfin/Emby server and
// proxies that server's `Audio/{id}/stream`. The API key stays on the server side.
//
// Files are matched by path. Jellyfin sees the library through its own mounts, so a path that is
// not identical is matched on its trailing folders (at least the file name and its folder, and the
// longest unique match wins). Mappings are cached in memory per server; misses are retried after
// MISS_TTL_MS. Anything that goes wrong returns null, and the route falls back to Arclight's engine.

/** A miss (the server does not know the file) is asked again after this long. */
export const MISS_TTL_MS = 5 * 60_000;
/** The full Audio path index of a server is rebuilt after this long. */
export const INDEX_TTL_MS = 10 * 60_000;
/** Paths must share at least this many trailing segments (file name and its folder). */
const MIN_SHARED_SEGMENTS = 2;

/** What the engine needs from a Jellyfin/Emby client (MediaBrowserServerClient). */
export interface AudioStreamingClient {
  info: MediaServerClient['info'];
  audioPaths(opts?: { searchTerm?: string; limit?: number }): Promise<MediaBrowserAudioPath[]>;
  audioStream(itemId: string, spec: MediaBrowserAudioStreamSpec, opts?: { method?: 'GET' | 'HEAD'; range?: string | undefined; signal?: AbortSignal }): Promise<Response>;
}

function isStreamingClient(client: MediaServerClient): client is MediaServerClient & AudioStreamingClient {
  const c = client as unknown as Partial<AudioStreamingClient>;
  return typeof c.audioPaths === 'function' && typeof c.audioStream === 'function';
}

export interface JellyfinEngineDeps {
  /** Stored media server connections (with keys). */
  servers: () => MediaServerConfig[];
  clientFor: (config: MediaServerConfig) => MediaServerClient;
  log: { warn: (obj: object, msg: string) => void };
  now?: () => number;
}

export interface EngineTarget {
  config: MediaServerConfig;
  client: AudioStreamingClient;
}

/** The file being streamed: id, path on Arclight's disk and, when tagged, its title (narrows the search). */
export interface EngineFile {
  id: number;
  path: string;
  title?: string | null | undefined;
}

const normalise = (p: string) =>
  p
    .replace(/\\/g, '/')
    .replace(/\/{2,}/g, '/')
    .replace(/\/$/, '')
    .toLowerCase();

const segments = (p: string) => normalise(p).split('/').filter(Boolean);

/**
 * The candidate whose path is `target`: an exact match (slashes and case ignored), else the one
 * sharing the most trailing segments (at least two), when that best match is unique.
 */
export function matchAudioPath(target: string, candidates: readonly MediaBrowserAudioPath[]): MediaBrowserAudioPath | null {
  const want = normalise(target);
  const exact = candidates.find((c) => normalise(c.path) === want);
  if (exact) return exact;
  const ws = segments(target);
  let best: MediaBrowserAudioPath | null = null;
  let bestShared = 0;
  let tie = false;
  for (const c of candidates) {
    const cs = segments(c.path);
    let shared = 0;
    while (shared < ws.length && shared < cs.length && ws[ws.length - 1 - shared] === cs[cs.length - 1 - shared]) shared++;
    if (shared < MIN_SHARED_SEGMENTS) continue;
    if (shared > bestShared) {
      best = c;
      bestShared = shared;
      tie = false;
    } else if (shared === bestShared && c.id !== best?.id) {
      tie = true;
    }
  }
  return best && !tie ? best : null;
}

/** The file name without folder and extension (a fallback search term). */
function stem(path: string): string {
  const name = segments(path).pop() ?? '';
  return name.replace(/\.[^.]+$/, '');
}

interface Mapping {
  path: string;
  itemId: string | null;
  at: number;
}

export class JellyfinEngine {
  private readonly now: () => number;
  private readonly clients = new Map<string, { sig: string; client: AudioStreamingClient }>();
  private readonly mappings = new Map<string, Mapping>();
  private readonly indexes = new Map<string, { at: number; items: Promise<MediaBrowserAudioPath[]> }>();
  private readonly warned = new Map<string, number>();

  constructor(private readonly deps: JellyfinEngineDeps) {
    this.now = deps.now ?? Date.now;
  }

  /** Enabled Jellyfin/Emby connections, in the stored order. */
  candidates(): MediaServerConfig[] {
    return this.deps.servers().filter((s) => s.enabled && isMediaBrowserKind(s.kind));
  }

  /** The connection a server id (null: the first) names, when it is an enabled Jellyfin/Emby one. */
  serverFor(serverId: string | null): MediaServerConfig | null {
    const list = this.candidates();
    return (serverId ? list.find((s) => s.id === serverId) : list[0]) ?? null;
  }

  /** Where streams go for these settings; null: Arclight's own engine. */
  target(settings: PlayerSettings): EngineTarget | null {
    if (settings.backend !== 'jellyfin') return null;
    const config = this.serverFor(settings.jellyfinServerId);
    if (!config) {
      this.warnOnce(`server:${settings.jellyfinServerId ?? ''}`, { serverId: settings.jellyfinServerId }, 'player engine is Jellyfin but no enabled Jellyfin/Emby server matches; using Arclight');
      return null;
    }
    const client = this.clientOf(config);
    return client ? { config, client } : null;
  }

  private clientOf(config: MediaServerConfig): AudioStreamingClient | null {
    const sig = `${config.kind}|${config.url}|${config.apiKey}`;
    const cached = this.clients.get(config.id);
    if (cached && cached.sig === sig) return cached.client;
    let client: MediaServerClient;
    try {
      client = this.deps.clientFor(config);
    } catch {
      return null;
    }
    if (!isStreamingClient(client)) return null;
    this.clients.set(config.id, { sig, client });
    // A changed connection may see other paths and ids.
    this.forgetServer(config.id);
    return client;
  }

  private forgetServer(serverId: string): void {
    this.indexes.delete(serverId);
    for (const key of this.mappings.keys()) if (key.startsWith(`${serverId}:`)) this.mappings.delete(key);
  }

  /** Drops one file's mapping (the server answered 404 for it). */
  forget(target: EngineTarget, fileId: number): void {
    this.mappings.delete(`${target.config.id}:${fileId}`);
  }

  /** The server's item id for a file, or null when it does not know it. Throws when the server cannot be reached. */
  async resolve(target: EngineTarget, file: EngineFile): Promise<string | null> {
    const key = `${target.config.id}:${file.id}`;
    const at = this.now();
    const cached = this.mappings.get(key);
    if (cached && cached.path === file.path && (cached.itemId !== null || at - cached.at < MISS_TTL_MS)) return cached.itemId;
    const found = await this.lookup(target, file);
    this.mappings.set(key, { path: file.path, itemId: found?.id ?? null, at });
    return found?.id ?? null;
  }

  private async lookup(target: EngineTarget, file: EngineFile): Promise<MediaBrowserAudioPath | null> {
    // Narrow first (the tag title is what the server names the item), then the full index.
    for (const term of [file.title?.trim(), stem(file.path)]) {
      if (!term) continue;
      const hit = matchAudioPath(file.path, await target.client.audioPaths({ searchTerm: term, limit: 50 }));
      if (hit) return hit;
    }
    return matchAudioPath(file.path, await this.index(target));
  }

  private index(target: EngineTarget): Promise<MediaBrowserAudioPath[]> {
    const id = target.config.id;
    const cached = this.indexes.get(id);
    if (cached && this.now() - cached.at < INDEX_TTL_MS) return cached.items;
    const items = target.client.audioPaths();
    items.catch(() => this.indexes.delete(id));
    this.indexes.set(id, { at: this.now(), items });
    return items;
  }

  /** Opens the server's stream for an item; see AudioStreamingClient.audioStream. */
  open(target: EngineTarget, itemId: string, spec: MediaBrowserAudioStreamSpec, opts: { method?: 'GET' | 'HEAD'; range?: string | undefined; signal?: AbortSignal }): Promise<Response> {
    return target.client.audioStream(itemId, spec.format === 'original' ? spec : { ...spec, playSessionId: randomUUID().replace(/-/g, '') }, opts);
  }

  /** Logs a warning, at most once per `everyMs` for the same key (a whole album missing on the server is one line). */
  warnOnce(key: string, obj: object, msg: string, everyMs = MISS_TTL_MS): void {
    const at = this.now();
    const last = this.warned.get(key);
    if (last !== undefined && at - last < everyMs) return;
    this.warned.set(key, at);
    this.deps.log.warn(obj, msg);
  }

  /** Settings → Player → Test: reach the server, then resolve one sample file. */
  async test(serverId: string | null, sample: EngineFile | null): Promise<PlayerEngineTestResult> {
    const config = this.serverFor(serverId);
    const base = { serverId: config?.id ?? null, serverName: null, version: null, sample: null } as const;
    if (!config) return { ...base, ok: false, message: 'No enabled Jellyfin or Emby server is set up (Settings → Media servers)' };
    const client = this.clientOf(config);
    if (!client) return { ...base, ok: false, message: `${config.name} cannot be used for streaming` };
    try {
      const info = await client.info();
      const head = { ...base, serverName: info.name, version: info.version ?? null };
      if (!sample) return { ...head, ok: true, message: 'Connected. Arclight has no audio files to try yet.' };
      // A fresh lookup: the test should show what the server says now.
      this.mappings.delete(`${config.id}:${sample.id}`);
      const itemId = await this.resolve({ config, client }, sample);
      return {
        ...head,
        ok: itemId !== null,
        sample: { fileId: sample.id, resolved: itemId !== null, itemId },
        message: itemId ? null : `${info.name} has no item for ${sample.path}. Check that it has a library on the same folders.`,
      };
    } catch (err) {
      return { ...base, ok: false, message: err instanceof MediaServerError || err instanceof Error ? err.message : String(err) };
    }
  }
}
