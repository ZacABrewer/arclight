import type { FastifyPluginAsync, FastifyRequest, RawServerDefault } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { and, eq } from 'drizzle-orm';
import {
  ACTIVE_STREAM_IDLE_SEC,
  ACTIVE_STREAM_PAUSED_IDLE_SEC,
  ActiveStreamsResponse,
  parseItemKey,
  type ActiveStream,
  type ActiveStreamMethod,
  type TranscodeHwaccel,
  type VideoHlsRungId,
} from '@arclight/shared';
import type { Db } from '../../db/index.js';
import { users } from '../auth/schema.js';
import { appDevices } from '../app-auth/schema.js';
import { householdProfiles } from '../households/schema.js';
import { audioFiles, episodes, episodeVersionFiles, mediaFiles, movies, series } from '../library/schema.js';
import { tracks } from '../music/schema.js';
import { isRemoteRequest } from './access.js';
import type { ActiveStreamRow, ActiveStreams, StreamClient, StreamOrigin, StreamViewer } from './active-streams.js';
import type { HlsSessions } from './hls/jobs.js';
import { playableItem } from './items.js';
import { videoArtworkUrl } from './video-items.js';

// GET /api/v1/activity/streams (Activity -> Now playing) and the request helpers the playback
// routes use to feed the list (active-streams.ts). Admin-only: the route opens nothing to other
// users (auth hook default), so portal users, non-owner profiles and app tokens of non-admins get
// 403. Rows name the user, profile, item, device, address and how it plays; never a stream URL,
// link signature or token.

/** The viewer of a signed-in request (null without a user: an API key). */
export function viewerOfRequest(req: FastifyRequest): StreamViewer | null {
  const userId = req.auth?.user?.id;
  if (userId === undefined) return null;
  const profile = req.auth?.profile;
  return { userId, profileKey: profile && !profile.isOwner ? profile.id : 0 };
}

/** The viewer a signed link plays as. */
export const viewerOfLink = (userId: number, profileId: number | null): StreamViewer => ({ userId, profileKey: profileId ?? 0 });

/** What kind of client sent a signed-in request; null for signed links (they say nothing). */
export function clientOf(db: Db, req: FastifyRequest, deviceName?: string): StreamClient | null {
  const auth = req.auth;
  if (!auth) return null;
  if (auth.via === 'app' && auth.appDeviceId !== undefined) {
    const row = db
      .select({ name: appDevices.name, platform: appDevices.platform, appVersion: appDevices.appVersion, method: appDevices.method })
      .from(appDevices)
      .where(eq(appDevices.id, auth.appDeviceId))
      .get();
    // TVs sign in with a device code (the code on the TV, approved in a browser).
    if (row) return { kind: row.method === 'device-code' ? 'tv' : 'app', deviceName: row.name, platform: row.platform, appVersion: row.appVersion };
    return { kind: 'app', deviceName: deviceName ?? null, platform: null, appVersion: null };
  }
  if (auth.via === 'session') return { kind: 'web', deviceName: deviceName ?? null, platform: null, appVersion: null };
  return { kind: 'other', deviceName: deviceName ?? null, platform: null, appVersion: null };
}

/** Where a request came from: Fastify's req.ip (forwarded headers only from trusted proxies). */
export function originOf(db: Db, req: FastifyRequest, deviceName?: string): StreamOrigin {
  return { ip: req.ip, remote: isRemoteRequest(req), client: clientOf(db, req, deviceName) };
}

/** Which item a streamed file belongs to (cached; files rarely move between items). */
export class StreamItemResolver {
  private readonly cache = new Map<string, string | null>();
  constructor(private readonly db: Db) {}

  audio(fileId: number): string | null {
    return this.cached(`a${fileId}`, () => {
      const track = this.db.select({ id: tracks.id }).from(tracks).where(eq(tracks.audioFileId, fileId)).get();
      if (track) return `track:${track.id}`;
      const file = this.db.select({ bookId: audioFiles.bookId }).from(audioFiles).where(eq(audioFiles.id, fileId)).get();
      return file?.bookId ? `audiobook:${file.bookId}` : null;
    });
  }

  video(mediaFileId: number): string | null {
    return this.cached(`v${mediaFileId}`, () => {
      const file = this.db.select({ movieId: mediaFiles.movieId }).from(mediaFiles).where(eq(mediaFiles.id, mediaFileId)).get();
      if (!file) return null;
      if (file.movieId) return `movie:${file.movieId}`;
      const ep =
        this.db.select({ id: episodes.id }).from(episodes).where(eq(episodes.episodeFileId, mediaFileId)).get() ??
        this.db.select({ id: episodeVersionFiles.episodeId }).from(episodeVersionFiles).where(eq(episodeVersionFiles.mediaFileId, mediaFileId)).get();
      return ep ? `episode:${ep.id}` : null;
    });
  }

  /** The session route knows the pairing already. */
  remember(kind: 'audio' | 'video', fileId: number, itemKey: string): void {
    this.put(`${kind === 'audio' ? 'a' : 'v'}${fileId}`, itemKey);
  }

  private cached(key: string, load: () => string | null): string | null {
    if (this.cache.has(key)) return this.cache.get(key) ?? null;
    const value = load();
    // Unknown files are not cached: a library scan may add them.
    if (value) this.put(key, value);
    return value;
  }

  private put(key: string, value: string): void {
    if (this.cache.size > 5000) this.cache.clear();
    this.cache.set(key, value);
  }
}

/** What the playback routes feed the list with (absent in tests that do not care). */
export interface StreamFeed {
  streams: ActiveStreams;
  items: StreamItemResolver;
}

export interface ActiveStreamsRouteDeps {
  db: Db;
  basePath: string;
  streams: ActiveStreams;
  /** Live HLS sessions (the rung being fetched, the encoder and its speed). */
  hls?: HlsSessions | undefined;
}

type Item = ActiveStream['item'];

/** Title, episode numbers, artist/album, chapter and artwork of an item (null: gone from the library). */
export function describeItem(db: Db, basePath: string, itemKey: string, positionMs: number): Item | null {
  const parsed = parseItemKey(itemKey);
  if (!parsed) return null;
  const base = { itemKey, kind: parsed.kind, seriesTitle: null, seasonNumber: null, episodeNumber: null, artist: null, album: null, chapter: null, year: null } as const;
  if (parsed.kind === 'movie') {
    const m = db.select({ title: movies.title, year: movies.year }).from(movies).where(eq(movies.id, parsed.id)).get();
    return m ? { ...base, title: m.title, year: m.year ?? null, artworkUrl: videoArtworkUrl(basePath, 'movie', parsed.id, 'poster', '342') } : null;
  }
  if (parsed.kind === 'episode') {
    const e = db
      .select({ title: episodes.title, season: episodes.seasonNumber, number: episodes.episodeNumber, seriesId: series.id, seriesTitle: series.title, year: series.year })
      .from(episodes)
      .innerJoin(series, eq(series.id, episodes.seriesId))
      .where(eq(episodes.id, parsed.id))
      .get();
    if (!e) return null;
    return {
      ...base,
      title: e.title ?? '',
      seriesTitle: e.seriesTitle,
      seasonNumber: e.season,
      episodeNumber: e.number,
      year: e.year ?? null,
      artworkUrl: videoArtworkUrl(basePath, 'series', e.seriesId, 'poster', '342'),
    };
  }
  const item = playableItem({ db, basePath }, itemKey);
  if (!item) return null;
  if (item.kind === 'track') return { ...base, title: item.title, artist: item.subtitle, album: item.context, artworkUrl: item.artworkUrl };
  const chapter = [...item.chapters].reverse().find((c) => c.startMs <= positionMs) ?? null;
  return { ...base, title: item.title, artist: item.subtitle, chapter: chapter?.title ?? null, artworkUrl: item.artworkUrl };
}

interface HlsLive {
  method: ActiveStreamMethod;
  rung: { id: VideoHlsRungId; height: number; videoKbps: number; codec: string } | null;
  hwaccel: TranscodeHwaccel | null;
  encodeSpeed: number | null;
}

function hlsLive(sessions: HlsSessions | undefined, id: string | null): HlsLive | null {
  const s = id ? sessions?.get(id) : null;
  if (!s) return null;
  const rung = s.rungs.get(s.playhead?.rung ?? s.init.ladder.startRung) ?? null;
  const copy = rung?.mode === 'copy';
  const health = s.health();
  return {
    method: copy ? 'remux' : 'transcode',
    rung: rung ? { id: rung.id, height: rung.height, videoKbps: Math.round(rung.videoKbps), codec: rung.codec === 'copy' ? (s.init.info.videoCodec ?? 'copy') : rung.codec } : null,
    hwaccel: copy ? null : health.hwaccel,
    encodeSpeed: copy ? null : health.encodeSpeed,
  };
}

/** One list row in the contract's shape (null when its item left the library). */
export function toActiveStream(deps: ActiveStreamsRouteDeps, row: ActiveStreamRow, people: People): ActiveStream | null {
  const item = describeItem(deps.db, deps.basePath, row.itemKey, row.positionNowMs);
  const user = people.user(row.viewer.userId);
  if (!item || !user) return null;
  const d = row.delivery;
  const live = d?.delivery === 'hls' ? hlsLive(deps.hls, d.hlsSessionId) : null;
  const method = live?.method ?? d?.method ?? null;
  return {
    id: row.id,
    state: row.state,
    startedAt: new Date(row.startedAt).toISOString(),
    lastSeenAt: new Date(row.lastSeen).toISOString(),
    user,
    profile: people.profile(row.viewer),
    item,
    positionMs: Math.max(0, row.positionNowMs),
    durationMs: Math.max(0, row.durationMs),
    client: row.client,
    address: { ip: row.ip, remote: row.remote },
    playback: {
      method,
      delivery: d?.delivery ?? null,
      backend: d?.backend ?? 'arclight',
      reasons: d?.reasons ?? [],
      rung: live?.rung ?? null,
      hwaccel: live ? live.hwaccel : (d?.hwaccel ?? null),
      encodeSpeed: live?.encodeSpeed ?? null,
      audioFormat: d?.audioFormat ?? null,
      bitrateKbps: live?.rung ? live.rung.videoKbps : (d?.bitrateKbps ?? null),
    },
  };
}

/** Users and profiles of one listing, each read once. */
export class People {
  private readonly users = new Map<number, ActiveStream['user'] | null>();
  private readonly profiles = new Map<string, ActiveStream['profile']>();
  constructor(private readonly db: Db) {}

  user(id: number): ActiveStream['user'] | null {
    if (!this.users.has(id)) {
      const row = this.db.select({ id: users.id, username: users.username }).from(users).where(eq(users.id, id)).get();
      this.users.set(id, row ?? null);
    }
    return this.users.get(id) ?? null;
  }

  profile(v: StreamViewer): ActiveStream['profile'] {
    const key = `${v.userId}:${v.profileKey}`;
    if (!this.profiles.has(key)) {
      const cols = { id: householdProfiles.id, name: householdProfiles.name, color: householdProfiles.color, initial: householdProfiles.initial, isOwner: householdProfiles.isOwner };
      const where =
        v.profileKey === 0
          ? and(eq(householdProfiles.userId, v.userId), eq(householdProfiles.isOwner, true))
          : and(eq(householdProfiles.userId, v.userId), eq(householdProfiles.id, v.profileKey));
      this.profiles.set(key, this.db.select(cols).from(householdProfiles).where(where).get() ?? null);
    }
    return this.profiles.get(key) ?? null;
  }
}

export function activeStreamsRoutes(deps: ActiveStreamsRouteDeps): FastifyPluginAsync<Record<never, never>, RawServerDefault, ZodTypeProvider> {
  return async (app) => {
    // Admins only (no `access`): the list holds every user's addresses. Polled by the page.
    app.get('/activity/streams', { config: { audit: false }, schema: { response: { 200: ActiveStreamsResponse } } }, async (_req, reply) => {
      const people = new People(deps.db);
      const streams = deps.streams.list().flatMap((row) => toActiveStream(deps, row, people) ?? []);
      reply.header('cache-control', 'no-store');
      return { streams, idleSec: ACTIVE_STREAM_IDLE_SEC, pausedIdleSec: ACTIVE_STREAM_PAUSED_IDLE_SEC };
    });
  };
}
