import { createHash, randomBytes } from 'node:crypto';
import type { FetchLike } from '@arclight/metadata';
import { indexRemoteTracks, type LocalTrack, type RemoteTrack } from './map.js';

// Writing a playlist into a media server. Each server's own playlist API: Jellyfin and Emby
// (/Playlists), Plex (/playlists with a server:// URI) and the Subsonic API (Navidrome and
// compatible servers). The library files are found among the server's tracks by recording
// MBID, by the end of the file path (the server may mount the library elsewhere), or by
// title + artist. Only what was found is pushed; the result says how many were missing.

export interface PushResult {
  remoteId: string;
  pushed: number;
  missing: number;
}

export interface PlaylistPusher {
  push(name: string, items: readonly LocalTrack[], remoteId?: string): Promise<PushResult>;
}

export class PushError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PushError';
  }
}

const TIMEOUT_MS = 30_000;
const PAGE = 1000;
const CHUNK = 100;

function chunks<T>(items: readonly T[], size = CHUNK): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

function base(url: string): string {
  return url.replace(/\/+$/, '');
}

async function call(fetchImpl: FetchLike, url: string, init: RequestInit & { label: string }): Promise<Response> {
  let res: Response;
  try {
    res = await fetchImpl(url, { ...init, signal: AbortSignal.timeout(TIMEOUT_MS) });
  } catch (err) {
    throw new PushError(`${init.label}: unreachable (${err instanceof Error ? err.message : String(err)})`);
  }
  return res;
}

async function json<T>(fetchImpl: FetchLike, url: string, init: RequestInit & { label: string }): Promise<T> {
  const res = await call(fetchImpl, url, init);
  if (!res.ok) throw new PushError(`${init.label}: HTTP ${res.status}`);
  const text = await res.text();
  try {
    return (text ? JSON.parse(text) : {}) as T;
  } catch {
    throw new PushError(`${init.label}: the answer was not JSON`);
  }
}

function resolveAll(items: readonly LocalTrack[], remote: readonly RemoteTrack[]): { ids: string[]; missing: number } {
  const find = indexRemoteTracks(remote);
  const ids: string[] = [];
  let missing = 0;
  for (const item of items) {
    const hit = find(item);
    if (hit) ids.push(hit.id);
    else missing++;
  }
  return { ids, missing };
}

// ---------------------------------------------------------------------------------------
// Jellyfin / Emby
// ---------------------------------------------------------------------------------------

interface JfItem {
  Id: string;
  Name?: string;
  Path?: string;
  Artists?: string[];
  AlbumArtist?: string;
  RunTimeTicks?: number;
  ProviderIds?: Record<string, string>;
  PlaylistItemId?: string;
}

export function jellyfinPusher(opts: { url: string; apiKey: string; label: string; fetchImpl: FetchLike }): PlaylistPusher {
  const root = base(opts.url);
  const headers = { Accept: 'application/json', 'X-Emby-Token': opts.apiKey, Authorization: `MediaBrowser Token="${opts.apiKey}"` };
  const get = <T>(path: string) => json<T>(opts.fetchImpl, `${root}${path}`, { method: 'GET', headers, label: opts.label });
  const send = async (method: string, path: string) => {
    const res = await call(opts.fetchImpl, `${root}${path}`, { method, headers, label: opts.label });
    if (!res.ok) throw new PushError(`${opts.label}: ${method} ${path.split('?')[0]} answered HTTP ${res.status}`);
    const text = await res.text();
    return text ? (JSON.parse(text) as Record<string, unknown>) : {};
  };

  async function userId(): Promise<string> {
    const users = await get<Array<{ Id: string; Policy?: { IsAdministrator?: boolean } }>>('/Users');
    const pick = users.find((u) => u.Policy?.IsAdministrator) ?? users[0];
    if (!pick) throw new PushError(`${opts.label}: no user to own the playlist`);
    return pick.Id;
  }

  async function tracks(user: string): Promise<RemoteTrack[]> {
    const out: RemoteTrack[] = [];
    for (let start = 0; ; start += PAGE) {
      const page = await get<{ Items?: JfItem[]; TotalRecordCount?: number }>(
        `/Users/${user}/Items?Recursive=true&IncludeItemTypes=Audio&Fields=Path,ProviderIds&EnableImages=false&StartIndex=${start}&Limit=${PAGE}`,
      );
      for (const i of page.Items ?? []) {
        const ids = i.ProviderIds ?? {};
        out.push({
          id: i.Id,
          path: i.Path,
          recordingMbid: ids['MusicBrainzRecording'] ?? ids['MusicBrainzTrack'],
          title: i.Name,
          artist: i.Artists?.[0] ?? i.AlbumArtist,
          durationMs: i.RunTimeTicks ? Math.round(i.RunTimeTicks / 10_000) : undefined,
        });
      }
      if ((page.Items ?? []).length < PAGE || out.length >= (page.TotalRecordCount ?? 0)) break;
    }
    return out;
  }

  return {
    async push(name, items, remoteId) {
      const user = await userId();
      const { ids, missing } = resolveAll(items, await tracks(user));
      let id = remoteId;
      if (id) {
        const existing = await call(opts.fetchImpl, `${root}/Playlists/${id}/Items?UserId=${user}`, { method: 'GET', headers, label: opts.label });
        if (existing.status === 404 || existing.status === 400) id = undefined;
        else if (!existing.ok) throw new PushError(`${opts.label}: reading the playlist answered HTTP ${existing.status}`);
        else {
          const body = (await existing.json()) as { Items?: JfItem[] };
          const entries = (body.Items ?? []).map((i) => i.PlaylistItemId ?? i.Id);
          for (const part of chunks(entries)) await send('DELETE', `/Playlists/${id}/Items?EntryIds=${part.join(',')}`);
        }
      }
      if (!id) {
        const first = ids.slice(0, CHUNK);
        const created = await send('POST', `/Playlists?Name=${encodeURIComponent(name)}&MediaType=Audio&UserId=${user}${first.length ? `&Ids=${first.join(',')}` : ''}`);
        const newId = typeof created['Id'] === 'string' ? created['Id'] : undefined;
        if (!newId) throw new PushError(`${opts.label}: creating the playlist returned no id`);
        for (const part of chunks(ids.slice(CHUNK))) await send('POST', `/Playlists/${newId}/Items?Ids=${part.join(',')}&UserId=${user}`);
        return { remoteId: newId, pushed: ids.length, missing };
      }
      for (const part of chunks(ids)) await send('POST', `/Playlists/${id}/Items?Ids=${part.join(',')}&UserId=${user}`);
      return { remoteId: id, pushed: ids.length, missing };
    },
  };
}

// ---------------------------------------------------------------------------------------
// Plex
// ---------------------------------------------------------------------------------------

interface PlexTrack {
  ratingKey: string;
  title?: string;
  grandparentTitle?: string;
  originalTitle?: string;
  duration?: number;
  Media?: Array<{ Part?: Array<{ file?: string }> }>;
  Guid?: Array<{ id?: string }>;
}

export function plexPusher(opts: { url: string; token: string; label: string; fetchImpl: FetchLike }): PlaylistPusher {
  const root = base(opts.url);
  const headers = { Accept: 'application/json', 'X-Plex-Token': opts.token };
  const get = <T>(path: string) => json<T>(opts.fetchImpl, `${root}${path}`, { method: 'GET', headers, label: opts.label });

  async function tracks(): Promise<RemoteTrack[]> {
    const sections = await get<{ MediaContainer?: { Directory?: Array<{ key: string; type?: string }> } }>('/library/sections');
    const out: RemoteTrack[] = [];
    for (const s of (sections.MediaContainer?.Directory ?? []).filter((d) => d.type === 'artist')) {
      for (let start = 0; ; start += PAGE) {
        const page = await get<{ MediaContainer?: { Metadata?: PlexTrack[]; totalSize?: number } }>(
          `/library/sections/${s.key}/all?type=10&includeGuids=1&X-Plex-Container-Start=${start}&X-Plex-Container-Size=${PAGE}`,
        );
        const rows = page.MediaContainer?.Metadata ?? [];
        for (const t of rows) {
          const mbid = t.Guid?.map((g) => g.id ?? '').find((g) => g.startsWith('mbid://'))?.slice('mbid://'.length);
          out.push({
            id: t.ratingKey,
            path: t.Media?.[0]?.Part?.[0]?.file,
            recordingMbid: mbid,
            title: t.title,
            artist: t.originalTitle ?? t.grandparentTitle,
            durationMs: t.duration,
          });
        }
        if (rows.length < PAGE) break;
      }
    }
    return out;
  }

  return {
    async push(name, items, remoteId) {
      const identity = await get<{ MediaContainer?: { machineIdentifier?: string } }>('/identity');
      const machine = identity.MediaContainer?.machineIdentifier;
      if (!machine) throw new PushError(`${opts.label}: no machine identifier`);
      const { ids, missing } = resolveAll(items, await tracks());
      const uri = (keys: string[]) => encodeURIComponent(`server://${machine}/com.plexapp.plugins.library/library/metadata/${keys.join(',')}`);
      const parts = chunks(ids);
      let id = remoteId;
      if (id) {
        const cleared = await call(opts.fetchImpl, `${root}/playlists/${id}/items`, { method: 'DELETE', headers, label: opts.label });
        if (cleared.status === 404) id = undefined;
        else if (!cleared.ok) throw new PushError(`${opts.label}: clearing the playlist answered HTTP ${cleared.status}`);
      }
      if (!id) {
        if (parts.length === 0) throw new PushError(`${opts.label}: none of the playlist's files are on this server`);
        const created = await json<{ MediaContainer?: { Metadata?: Array<{ ratingKey?: string }> } }>(
          opts.fetchImpl,
          `${root}/playlists?type=audio&smart=0&title=${encodeURIComponent(name)}&uri=${uri(parts[0]!)}`,
          { method: 'POST', headers, label: opts.label },
        );
        id = created.MediaContainer?.Metadata?.[0]?.ratingKey;
        if (!id) throw new PushError(`${opts.label}: creating the playlist returned no id`);
        parts.shift();
      }
      for (const part of parts) {
        const res = await call(opts.fetchImpl, `${root}/playlists/${id}/items?uri=${uri(part)}`, { method: 'PUT', headers, label: opts.label });
        if (!res.ok) throw new PushError(`${opts.label}: adding items answered HTTP ${res.status}`);
      }
      return { remoteId: id, pushed: ids.length, missing };
    },
  };
}

// ---------------------------------------------------------------------------------------
// Subsonic API (Navidrome)
// ---------------------------------------------------------------------------------------

interface SubsonicSong {
  id: string;
  title?: string;
  artist?: string;
  duration?: number;
  path?: string;
  musicBrainzId?: string;
}

interface SubsonicBody {
  'subsonic-response'?: {
    status?: string;
    error?: { code?: number; message?: string };
    playlist?: { id?: string };
    searchResult3?: { song?: SubsonicSong[] };
  };
}

export function subsonicPusher(opts: { url: string; user: string; password: string; label: string; fetchImpl: FetchLike; salt?: () => string }): PlaylistPusher {
  const root = base(opts.url);
  function auth(): URLSearchParams {
    const salt = opts.salt?.() ?? randomBytes(8).toString('hex');
    const token = createHash('md5').update(opts.password + salt).digest('hex');
    return new URLSearchParams({ u: opts.user, t: token, s: salt, v: '1.16.1', c: 'arclight', f: 'json' });
  }
  async function rest(method: string, params: URLSearchParams = new URLSearchParams(), post = false): Promise<NonNullable<SubsonicBody['subsonic-response']>> {
    const q = auth();
    for (const [k, v] of params) q.append(k, v);
    const body = post
      ? await json<SubsonicBody>(opts.fetchImpl, `${root}/rest/${method}`, {
          method: 'POST',
          headers: { Accept: 'application/json', 'Content-Type': 'application/x-www-form-urlencoded' },
          body: q.toString(),
          label: opts.label,
        })
      : await json<SubsonicBody>(opts.fetchImpl, `${root}/rest/${method}?${q.toString()}`, { method: 'GET', headers: { Accept: 'application/json' }, label: opts.label });
    const r = body['subsonic-response'];
    if (!r || r.status !== 'ok') throw new PushError(`${opts.label}: ${r?.error?.message ?? 'the server refused the request'}`);
    return r;
  }

  async function tracks(): Promise<RemoteTrack[]> {
    const out: RemoteTrack[] = [];
    for (let offset = 0; ; offset += 500) {
      const r = await rest('search3', new URLSearchParams({ query: '', songCount: '500', songOffset: String(offset), artistCount: '0', albumCount: '0' }));
      const songs = r.searchResult3?.song ?? [];
      for (const s of songs) {
        out.push({ id: s.id, path: s.path, recordingMbid: s.musicBrainzId, title: s.title, artist: s.artist, durationMs: s.duration ? s.duration * 1000 : undefined });
      }
      if (songs.length < 500) break;
    }
    return out;
  }

  return {
    async push(name, items, remoteId) {
      const { ids, missing } = resolveAll(items, await tracks());
      const params = new URLSearchParams(remoteId ? { playlistId: remoteId } : { name });
      for (const id of ids) params.append('songId', id);
      let r: Awaited<ReturnType<typeof rest>>;
      try {
        r = await rest('createPlaylist', params, true);
      } catch (err) {
        if (!remoteId) throw err;
        // The playlist was deleted on the server: create it again.
        const fresh = new URLSearchParams({ name });
        for (const id of ids) fresh.append('songId', id);
        r = await rest('createPlaylist', fresh, true);
        remoteId = undefined;
      }
      const id = r.playlist?.id ?? remoteId;
      if (!id) throw new PushError(`${opts.label}: creating the playlist returned no id`);
      return { remoteId: id, pushed: ids.length, missing };
    },
  };
}
