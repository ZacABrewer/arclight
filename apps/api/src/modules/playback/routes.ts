import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import { Readable } from 'node:stream';
import type { ReadableStream as WebReadableStream } from 'node:stream/web';
import type { FastifyPluginAsync, FastifyReply, FastifyRequest, RawServerDefault } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { asc, eq, inArray } from 'drizzle-orm';
import { z } from 'zod';
import {
  ArtworkLinkResponse,
  AudiobookHome,
  Bookmark,
  BookmarkInput,
  BookmarkListQuery,
  BookmarkUpdate,
  BrowseQuery,
  ContinueResponse,
  isVideoKind,
  ItemKey,
  MusicHome,
  PlayableItem,
  PlayerAlbumDetails,
  PlayerAlbumPage,
  PlayerArtistDetails,
  PlayerArtistPage,
  PlayerAudiobookDetails,
  PlayerAudiobookPage,
  PlayerCapabilities,
  PlayerEngineTestRequest,
  PlayerEngineTestResult,
  PlayerSearchResponse,
  PlayerSettings,
  PlayerTrackPage,
  PlaybackItemsRequest,
  PlaybackProgress,
  PlaylistTrackMove,
  PlaylistTracksAdd,
  PlayQueue,
  ProgressBatchRequest,
  ProgressBatchResponse,
  ProgressBeacon,
  ProgressListResponse,
  ProgressQuery,
  ProgressReport,
  ProgressUpdate,
  StreamLinksRequest,
  StreamLinksResponse,
  StreamQuery,
  UserPlaylistDetails,
  UserPlaylistInput,
  UserPlaylistSummary,
  parseItemKey,
  type PlayableKind,
  type PlaybackEngine,
  type PlayerCapabilities as Capabilities,
  type PlayerSettings as Settings,
  AddressClashResponse,
  DEFAULT_PLAYER_PATH,
  DEFAULT_PORTAL_PATH,
  Permission,
  appHomeOf,
  canRequest,
  addressClash,
  ErrorResponse,
} from '@arclight/shared';
import type { Db } from '../../db/index.js';
import { users } from '../auth/schema.js';
import { audioFiles } from '../library/schema.js';
import { getSection, setSection } from '../settings/service.js';
import { appUrlOf, playerUrlOf, portalUrlOf, publicUrlOf } from '../../public-urls.js';

const NO_ADDRESS = { paths: [], hosts: [] } as const;
import { capabilitiesOf, decide, denialReply, isRemoteRequest, linkUserStillActive as linkUserStillActiveIn, playerSettings, requirePlayer, subjectOf, type PlayerDecision } from './access.js';
import { findArtwork } from './artwork.js';
import {
  albumDetails,
  albumPage,
  artistDetails,
  artistPage,
  audiobookDetails,
  audiobookHome,
  audiobookPage,
  musicHome,
  playerSearch,
  browseUserOf,
  ownerOfBrowse,
  trackPage,
  type BrowseContext,
} from './browse.js';
import { downloadDisposition, mimeOf } from './format.js';
import { playableItem } from './items.js';
import { videoSearch } from './video-browse.js';
import { videoItem, type ChapterReader } from './video-items.js';
import { restrictionsFor } from '../requests/certification.js';
import { householdsFor } from '../households/service.js';
import type { EngineTarget, JellyfinEngine } from './jellyfin.js';
import { artworkLinkQuery, hasLinkParams, linkKey, linkQuery, verifyArtworkLink, verifyLink } from './links.js';
import type { PlaybackOwner, ProgressStore } from './progress.js';
import { etagOf, notModified, parseRange, rangeStillValid } from './range.js';
import { BookmarkStore, PlayerNotFound, PlaylistFull, PlaylistStore, QueueStore } from './stores.js';
import { DEFAULT_BITRATE_KBPS, FfmpegMissing, TRANSCODE_MIME, TranscodeBusy, type AudioTranscoder, type TranscodeFormat } from './transcode.js';

// /api/v1/playback/* and /api/v1/stream/*: the player. Every route is open to signed-in users
// (portal) and then passes the player guard (access.ts): 403 unless the player is on and the
// caller may use it from where they are. GET /playback/me answers without the guard, so the UI
// can show why. Per-user state (progress, queue, bookmarks, playlists) needs a user; API-key
// callers get 400 NO_USER there. The stream route also takes a signed link instead of a cookie.

export interface PlaybackDeps {
  db: Db;
  basePath: string;
  progress: ProgressStore;
  transcoder: AudioTranscoder;
  /** The install API key (links are signed with a key derived from it). */
  apiKey: () => string;
  /** The Jellyfin/Emby engine (Settings → Player → Playback engine); absent: Arclight only. */
  engine?: JellyfinEngine | undefined;
  /** Chapter reader for movie/episode items (ffprobe, cached). */
  chapters: ChapterReader;
  now?: () => number;
}

type AudioFileRow = typeof audioFiles.$inferSelect;

const user = { access: { portal: true } } as const;
const ErrorBody = z.object({ error: z.string(), code: z.string() });
const errors = { 400: ErrorBody, 403: ErrorBody, 404: ErrorBody };
const IdParams = z.object({ id: z.coerce.number().int().positive() });
const EntryParams = z.object({ id: z.coerce.number().int().positive(), entryId: z.coerce.number().int().positive() });
const KeyParams = z.object({ itemKey: ItemKey });
const FileParams = z.object({ fileId: z.coerce.number().int().positive() });
const ArtworkParams = z.object({ kind: z.enum(['album', 'artist', 'book']), id: z.coerce.number().int().positive() });
const SearchQuery = z.object({ q: z.string().max(200).default('') });
// `p`: the household profile a link plays as (links.ts); absent on owner links.
const LinkParams = { u: z.string().max(20).optional(), p: z.string().max(20).optional(), exp: z.string().max(20).optional(), sig: z.string().max(100).optional() };
const StreamQueryWithLink = StreamQuery.extend(LinkParams);
const ArtworkQuery = z.object(LinkParams);

const MAX_PROGRESS_KEYS = 200;

class PlayerHttpError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

/** Whose per-profile rows (progress, queue, bookmarks, playlists) a request reads and writes. */
function ownerOf(req: FastifyRequest): PlaybackOwner {
  const owner = ownerOfBrowse(browseUserOf(req));
  if (owner === null) throw new PlayerHttpError(400, 'NO_USER', 'this request is not signed in as a user');
  return owner;
}

/** The profile a signed link names: a non-owner profile's id, else null (the owner, no `p=`). */
function linkProfileOf(req: FastifyRequest): number | null {
  const profile = req.auth?.profile;
  return profile && !profile.isOwner ? profile.id : null;
}

const headerText = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v);


export function playbackRoutes(deps: PlaybackDeps): FastifyPluginAsync<Record<never, never>, RawServerDefault, ZodTypeProvider> {
  const { db } = deps;
  const now = deps.now ?? Date.now;
  const browse: BrowseContext = { db, basePath: deps.basePath, progress: deps.progress };
  const queue = new QueueStore(db);
  const bookmarks = new BookmarkStore(db);
  const playlists = new PlaylistStore(browse);
  const guard = requirePlayer(db);
  const guardUser = requirePlayer(db, { needsUser: true });
  const player = { config: user, preHandler: guard } as const;
  const playerUser = { config: user, preHandler: guardUser } as const;

  /** The guard, then 404 while the section is turned off in Settings → Features. */
  const sectionOn = (section: 'music' | 'audiobooks') => async (req: FastifyRequest, reply: FastifyReply) => {
    await guard(req, reply);
    if (reply.sent) return;
    if (!getSection(db, 'features')[section]) await reply.code(404).send({ error: `${section} is turned off (Settings → Features)`, code: 'SECTION_OFF' });
  };
  const music = { config: user, preHandler: sectionOn('music') } as const;
  const audiobooks = { config: user, preHandler: sectionOn('audiobooks') } as const;

  /** Whether the section of a file or item kind is on (Settings → Features). */
  function sectionEnabled(kind: 'music' | PlayableKind): boolean {
    if (kind === 'movie' || kind === 'episode') return playerSettings(db).video;
    const features = getSection(db, 'features');
    return kind === 'audiobook' ? features.audiobooks : features.music;
  }

  /** The playable item, or 404 when it is missing, has no file or its section is off. */
  function itemOr404(key: string): PlayableItem {
    const parsed = parseItemKey(key);
    const item = parsed && !isVideoKind(parsed.kind) && sectionEnabled(parsed.kind) ? playableItem(browse, key) : null;
    if (!item) throw new PlayerNotFound(`${key} not found or has no file`);
    return item;
  }

  /** Any playable item: audio as above, movies/episodes within the caller's content restrictions. */
  async function anyItem(req: FastifyRequest, key: string, probe: boolean): Promise<PlayableItem | null> {
    const parsed = parseItemKey(key);
    if (!parsed || !sectionEnabled(parsed.kind)) return null;
    if (!isVideoKind(parsed.kind)) return playableItem(browse, key);
    const restrictions = restrictionsFor(req.auth);
    return videoItem({ db, basePath: deps.basePath, chapters: deps.chapters }, parsed.kind, parsed.id, { restrictions, probe });
  }

  /** The keys of a progress query, validated (400 on a bad or too long list). */
  function keysOf(raw: string): string[] {
    const keys = [...new Set(raw.split(',').map((k) => k.trim()).filter(Boolean))];
    if (keys.length > MAX_PROGRESS_KEYS) throw new PlayerHttpError(400, 'VALIDATION', `at most ${MAX_PROGRESS_KEYS} item keys`);
    const bad = keys.find((k) => !parseItemKey(k));
    if (bad) throw new PlayerHttpError(400, 'VALIDATION', `not an item key: ${bad}`);
    return keys;
  }

  const linkUserStillActive = (userId: number, profileId: number | null) => linkUserStillActiveIn(db, userId, now(), profileId);

  /** The decision for a stream request: the signed-in caller, or the user of a valid link. */
  function streamDecision(req: FastifyRequest, query: { u?: unknown; exp?: unknown; sig?: unknown }, fileId: number): { decision: PlayerDecision; userId: number | null } | PlayerHttpError {
    const settings = playerSettings(db);
    const remote = isRemoteRequest(req);
    if (req.auth) return { decision: decide(settings, subjectOf(req), remote), userId: req.auth.user?.id ?? null };
    const check = verifyLink(linkKey(deps.apiKey()), fileId, query, now());
    if (!check.ok) return new PlayerHttpError(403, `LINK_${check.reason}`, check.reason === 'EXPIRED' ? 'this stream link has expired' : 'this stream link is not valid');
    const row = db.select({ id: users.id, role: users.role, settings: users.settings }).from(users).where(eq(users.id, check.userId)).get();
    if (!row || !linkUserStillActive(row.id, check.profileId)) return new PlayerHttpError(403, 'LINK_REVOKED', 'this stream link was revoked');
    return { decision: decide(settings, { userId: row.id, isAdmin: row.role === 'admin', settings: row.settings }, remote), userId: row.id };
  }

  /** Where streams go now: the Jellyfin/Emby target, or null for Arclight's own engine. */
  function engineTarget(settings: Settings = playerSettings(db)): EngineTarget | null {
    return deps.engine?.target(settings) ?? null;
  }

  const engineFile = (file: AudioFileRow) => ({ id: file.id, path: file.path, title: file.tags?.title ?? null });

  /** Who serves each file now (the link response tells clients). Never throws. */
  async function backendsOf(fileIds: number[]): Promise<Map<number, PlaybackEngine>> {
    const out = new Map<number, PlaybackEngine>(fileIds.map((id) => [id, 'arclight']));
    const target = engineTarget();
    if (!target || !deps.engine || fileIds.length === 0) return out;
    const rows = db.select().from(audioFiles).where(inArray(audioFiles.id, fileIds)).all();
    for (const row of rows) {
      try {
        if (await deps.engine.resolve(target, engineFile(row))) out.set(row.id, 'jellyfin');
      } catch (err) {
        deps.engine.warnOnce(`down:${target.config.id}`, { server: target.config.name, err: (err as Error).message }, 'Jellyfin/Emby is unreachable; the player streams with Arclight', 60_000);
        break;
      }
    }
    return out;
  }

  /**
   * Proxies the stream from Jellyfin/Emby. Null when it cannot (the file is unknown there, the
   * server is down or refuses): the caller then streams with Arclight's own engine.
   */
  async function viaJellyfin(
    req: FastifyRequest,
    reply: FastifyReply,
    target: EngineTarget,
    file: AudioFileRow,
    spec: { format: 'original' | TranscodeFormat; bitrateKbps: number | undefined; startMs: number | undefined },
  ): Promise<FastifyReply | null> {
    const engine = deps.engine!;
    const server = target.config.name;
    const fallBack = (key: string, msg: string, extra: object = {}, everyMs?: number) => {
      engine.warnOnce(key, { server, fileId: file.id, ...extra }, msg, everyMs);
      return null;
    };
    const down = (err: unknown) => fallBack(`down:${target.config.id}`, 'Jellyfin/Emby is unreachable; the player streams with Arclight', { err: (err as Error).message }, 60_000);
    let itemId: string | null;
    try {
      itemId = await engine.resolve(target, engineFile(file));
    } catch (err) {
      return down(err);
    }
    if (!itemId) return fallBack(`miss:${target.config.id}:${file.albumId ?? file.bookId ?? file.id}`, 'file not found on Jellyfin/Emby; the player streams it with Arclight', { path: file.path });
    const head = req.method === 'HEAD';
    const transcode = spec.format !== 'original';
    if (head && transcode) {
      // Do not start a server-side transcode just to answer a probe.
      return reply.code(200).header('content-type', TRANSCODE_MIME[spec.format as TranscodeFormat]).header('accept-ranges', 'none').header('x-arclight-backend', 'jellyfin').send();
    }
    const abort = new AbortController();
    reply.raw.on('close', () => abort.abort());
    let res: Response;
    try {
      res = await engine.open(target, itemId, spec, { method: head ? 'HEAD' : 'GET', range: transcode ? undefined : headerText(req.headers.range), signal: abort.signal });
    } catch (err) {
      return down(err);
    }
    if (res.status === 404 || res.status === 401 || res.status === 403 || res.status >= 500) {
      void res.body?.cancel().catch(() => undefined);
      if (res.status === 404) engine.forget(target, file.id);
      return fallBack(`status:${target.config.id}:${res.status}`, `Jellyfin/Emby answered ${res.status}; the player streams with Arclight`, { status: res.status }, 60_000);
    }
    reply.code(res.status).header('x-arclight-backend', 'jellyfin');
    for (const name of ['content-type', 'content-length', 'content-range', 'accept-ranges', 'etag', 'last-modified']) {
      const value = res.headers.get(name);
      if (value) reply.header(name, value);
    }
    if (transcode) {
      const fmt = spec.format as TranscodeFormat;
      reply.header('accept-ranges', 'none').header('x-arclight-transcode', `${fmt}/${spec.bitrateKbps ?? DEFAULT_BITRATE_KBPS[fmt]}`);
      if (!res.headers.get('content-type')) reply.header('content-type', TRANSCODE_MIME[fmt]);
    } else if (!res.headers.get('content-type')) {
      reply.header('content-type', mimeOf(file.path));
    }
    if (head || !res.body || res.status === 304 || res.status === 416) {
      void res.body?.cancel().catch(() => undefined);
      return reply.send();
    }
    const body = Readable.fromWeb(res.body as unknown as WebReadableStream<Uint8Array>);
    body.on('error', () => abort.abort());
    return reply.send(body);
  }

  return async (app) => {
    app.setErrorHandler((err, req, reply) => {
      if (err instanceof PlayerHttpError) return reply.code(err.status).send({ error: err.message, code: err.code });
      if (err instanceof PlayerNotFound) return reply.code(404).send({ error: err.message, code: err.code });
      if (err instanceof PlaylistFull) return reply.code(400).send({ error: err.message, code: err.code });
      if (err instanceof Error && 'validation' in err && err.validation) return reply.code(400).send({ error: err.message, code: 'VALIDATION' });
      const status = (err as { statusCode?: number }).statusCode;
      if (status && status >= 400 && status < 500) return reply.code(status).send({ error: (err as Error).message, code: 'BAD_REQUEST' });
      req.log.error({ err }, 'unhandled playback error');
      return reply.code(500).send({ error: 'internal error', code: 'INTERNAL' });
    });

    // ---- settings (admin only) -------------------------------------------------------
    app.get('/settings/player', { schema: { response: { 200: PlayerSettings } } }, async () => playerSettings(db));
    app.put('/settings/player', { schema: { body: PlayerSettings, response: { 200: PlayerSettings, 400: AddressClashResponse.or(ErrorResponse) } } }, async (req, reply) => {
      // A player path or hostname may not be one the request portal already uses.
      const clashes = addressClash(getSection(db, 'requests').publicPortal, req.body.address);
      if (clashes.length) return reply.code(400).send({ error: 'already used by the request portal (Settings > Requests)', code: 'address-clash' as const, clashes });
      return setSection(db, 'player', req.body);
    });
    app.post('/settings/player/engine-test', { schema: { body: PlayerEngineTestRequest, response: { 200: PlayerEngineTestResult } } }, async (req) => {
      if (!deps.engine) return { ok: false, serverId: null, serverName: null, version: null, sample: null, message: 'The Jellyfin engine is not available' };
      const sample = db.select().from(audioFiles).orderBy(asc(audioFiles.mediaType), asc(audioFiles.id)).limit(1).get();
      return deps.engine.test(req.body.jellyfinServerId, sample ? engineFile(sample) : null);
    });

    // ---- access -------------------------------------------------------------------------
    app.get('/playback/me', { config: user, schema: { response: { 200: PlayerCapabilities } } }, async (req): Promise<Capabilities> => {
      const settings = playerSettings(db);
      const caps = capabilitiesOf(db, decide(settings, subjectOf(req), isRemoteRequest(req)));
      // The active household profile can hide music and audiobooks (its own settings).
      const profile = req.auth?.user && req.auth.profile ? householdsFor(db).settings(req.auth.user.id, req.auth.profile.id) : null;
      if (profile) caps.sections = { ...caps.sections, music: caps.sections.music && profile.showMusic, audiobooks: caps.sections.audiobooks && profile.showAudiobooks };
      // The account menu (phone and TV apps hold no session permissions): the same rules as the
      // web's appHomeFor / canRequest. A non-owner profile is masked (no admin, no bits), so it
      // gets neither.
      const auth = req.auth;
      const origin = `${req.protocol}://${req.host}${deps.basePath}`;
      const perms = (auth?.user?.permissions ?? 0) & ~Permission.ADMIN;
      const admin = auth?.isAdmin === true;
      return {
        ...caps,
        engine: engineTarget(settings) ? 'jellyfin' : 'arclight',
        // Without an Application URL or a hostname, the address this request came in on.
        playerUrl: playerUrlOf(db, deps.basePath) ?? `${origin}${DEFAULT_PLAYER_PATH}`,
        // Signed-in users always have the built-in /portal; the public portal's paths and
        // hostnames count only while it is on.
        portalUrl: portalUrlOf(db, deps.basePath) ?? publicUrlOf(getSection(db, 'requests').applicationUrl, NO_ADDRESS, DEFAULT_PORTAL_PATH) ?? `${origin}${DEFAULT_PORTAL_PATH}`,
        canRequest: auth?.user ? admin || canRequest(perms) : false,
        appHome: auth?.user ? appHomeOf(admin, auth.appAccess, perms) : null,
        appUrl: appUrlOf(db, req.host, origin),
      };
    });

    // ---- items and stream links ------------------------------------------------------------
    app.get('/playback/item/:itemKey', { ...player, schema: { params: KeyParams, response: { 200: PlayableItem, ...errors } } }, async (req) => {
      const item = await anyItem(req, req.params.itemKey, true);
      if (!item) throw new PlayerNotFound(`${req.params.itemKey} not found or has no file`);
      return item;
    });

    // Several items at once (queues, offline downloads): missing ones and turned-off sections are left out, order kept.
    app.post('/playback/items', { ...player, config: { ...user, audit: false }, schema: { body: PlaybackItemsRequest, response: { 200: z.array(PlayableItem), ...errors } } }, async (req) => {
      const out: PlayableItem[] = [];
      for (const key of [...new Set(req.body.itemKeys)]) {
        const item = await anyItem(req, key, false);
        if (item) out.push(item);
      }
      return out;
    });

    app.post('/playback/stream-links', { ...playerUser, schema: { body: StreamLinksRequest, response: { 200: StreamLinksResponse, ...errors } } }, async (req) => {
      const { userId } = ownerOf(req);
      const profileId = linkProfileOf(req);
      const item = itemOr404(req.body.itemKey);
      const exp = Math.floor(now() / 1000) + playerSettings(db).streamLinkHours * 3600;
      const key = linkKey(deps.apiKey());
      const origin = `${req.protocol}://${req.host}`;
      const format =
        (req.body.format === 'original' ? '' : `format=${req.body.format}&${req.body.bitrateKbps ? `bitrateKbps=${req.body.bitrateKbps}&` : ''}`) + (req.body.download ? 'download=1&' : '');
      const backends = await backendsOf(item.parts.map((p) => p.fileId));
      const links = item.parts.map((p) => ({
        fileId: p.fileId,
        url: `${origin}${deps.basePath}/api/v1/stream/audio/${p.fileId}?${format}${linkQuery(key, { userId, profileId, fileId: p.fileId, exp })}`,
        expiresAt: new Date(exp * 1000).toISOString(),
        backend: backends.get(p.fileId) ?? ('arclight' as const),
      }));
      return { links, backendInUse: links.every((l) => l.backend === 'jellyfin') ? ('jellyfin' as const) : ('arclight' as const) };
    });

    // ---- the stream -----------------------------------------------------------------------
    app.route({
      method: ['GET', 'HEAD'],
      url: '/stream/audio/:fileId',
      config: { ...user, publicWhen: (req: FastifyRequest) => hasLinkParams(req.query) },
      schema: { params: FileParams, querystring: StreamQueryWithLink },
      handler: async (req, reply) => {
        const fileId = req.params.fileId;
        const decided = streamDecision(req, req.query, fileId);
        if (decided instanceof PlayerHttpError) return reply.code(decided.status).send({ error: decided.message, code: decided.code });
        const { decision, userId } = decided;
        if (decision.denial) return denialReply(reply, decision.denial);
        const file = db.select().from(audioFiles).where(eq(audioFiles.id, fileId)).get();
        // A file of a section turned off in Settings → Features reads as missing.
        if (!file || !sectionEnabled(file.mediaType)) return reply.code(404).send({ error: `audio file ${fileId} not found`, code: 'NOT_FOUND' });
        let info;
        try {
          info = await stat(file.path);
        } catch {
          return reply.code(404).send({ error: 'the file is missing on disk', code: 'FILE_MISSING' });
        }
        const head = req.method === 'HEAD';
        const cap = decision.maxBitrateKbps;
        let format = req.query.format as 'original' | TranscodeFormat;
        let bitrate = req.query.bitrateKbps;
        // Over the cap and no format asked for: transcode to Opus at the cap.
        if (format === 'original' && cap > 0 && (file.bitrateKbps ?? 0) > cap) {
          format = 'opus';
          bitrate = cap;
        }
        reply.header('cache-control', 'private, no-cache');
        // ?download=1: save as a file (the transcode's extension when converting).
        if (req.query.download === '1' || req.query.download === 'true') reply.header('content-disposition', downloadDisposition(file.path, format === 'original' ? null : format));
        // The Jellyfin engine, when chosen: same format and cap, bytes from the server.
        const target = engineTarget();
        if (target) {
          const kbps = format === 'original' ? undefined : Math.min(bitrate ?? DEFAULT_BITRATE_KBPS[format], cap > 0 ? cap : Number.MAX_SAFE_INTEGER);
          const proxied = await viaJellyfin(req, reply, target, file, { format, bitrateKbps: kbps, startMs: req.query.startMs });
          if (proxied) return proxied;
        }
        reply.header('x-arclight-backend', 'arclight');
        if (format !== 'original') {
          const kbps = Math.min(bitrate ?? DEFAULT_BITRATE_KBPS[format], cap > 0 ? cap : Number.MAX_SAFE_INTEGER);
          reply.header('content-type', TRANSCODE_MIME[format]).header('accept-ranges', 'none').header('x-arclight-transcode', `${format}/${kbps}`);
          // HEAD answers what a GET would now: the player probes with it after a failed stream.
          if (head) return deps.transcoder.canStart(userId) ? reply.code(200).send() : reply.code(503).header('retry-after', '5').send();
          let proc;
          try {
            proc = await deps.transcoder.start(file.path, { format, bitrateKbps: kbps, startMs: req.query.startMs, channels: file.channels }, userId);
          } catch (err) {
            if (err instanceof TranscodeBusy) return reply.code(503).header('retry-after', '5').send({ error: err.message, code: err.code });
            if (err instanceof FfmpegMissing) return reply.code(503).send({ error: err.message, code: err.code });
            throw err;
          }
          reply.raw.on('close', () => proc.kill());
          proc.stdout.on('error', () => proc.kill());
          return reply.code(200).send(proc.stdout);
        }

        const etag = etagOf(info);
        reply.header('accept-ranges', 'bytes').header('etag', etag).header('last-modified', info.mtime.toUTCString()).header('content-type', mimeOf(file.path));
        const rangeHeader = req.headers.range;
        if (!rangeHeader && notModified(req.headers, etag, info.mtime)) return reply.code(304).send();
        const range = rangeStillValid(headerText(req.headers['if-range']), etag, info.mtime) ? parseRange(rangeHeader, info.size) : ({ kind: 'full' } as const);
        if (range.kind === 'unsatisfiable') {
          return reply.code(416).header('content-range', `bytes */${info.size}`).type('application/json').send({ error: 'range not satisfiable', code: 'RANGE' });
        }
        if (range.kind === 'partial') {
          reply.code(206).header('content-range', `bytes ${range.start}-${range.end}/${info.size}`).header('content-length', range.end - range.start + 1);
          return head ? reply.send() : reply.send(createReadStream(file.path, { start: range.start, end: range.end }));
        }
        reply.code(200).header('content-length', info.size);
        return head ? reply.send() : reply.send(createReadStream(file.path));
      },
    });

    // ---- artwork ------------------------------------------------------------------------------
    // A query string that opens every artwork URL without credentials (<img> in the Arclight app, cast receivers).
    app.post('/playback/artwork-link', { ...playerUser, config: { ...user, audit: false }, schema: { response: { 200: ArtworkLinkResponse, ...errors } } }, async (req) => {
      const { userId } = ownerOf(req);
      const exp = Math.floor(now() / 1000) + playerSettings(db).streamLinkHours * 3600;
      return { query: artworkLinkQuery(linkKey(deps.apiKey()), { userId, profileId: linkProfileOf(req), exp }), expiresAt: new Date(exp * 1000).toISOString() };
    });

    /** Signed artwork links: the link's user must still be active and allowed to use the player. */
    const artworkGuard = async (req: FastifyRequest, reply: FastifyReply) => {
      if (req.auth) return guard(req, reply);
      const check = verifyArtworkLink(linkKey(deps.apiKey()), req.query as Record<string, unknown>, now());
      if (!check.ok) return reply.code(403).send({ error: check.reason === 'EXPIRED' ? 'this artwork link has expired' : 'this artwork link is not valid', code: `LINK_${check.reason}` });
      const row = db.select({ id: users.id, role: users.role, settings: users.settings }).from(users).where(eq(users.id, check.userId)).get();
      if (!row || !linkUserStillActive(row.id, check.profileId)) return reply.code(403).send({ error: 'this artwork link was revoked', code: 'LINK_REVOKED' });
      const decision = decide(playerSettings(db), { userId: row.id, isAdmin: row.role === 'admin', settings: row.settings }, isRemoteRequest(req));
      if (decision.denial) return denialReply(reply, decision.denial);
    };

    app.get(
      '/playback/artwork/:kind/:id',
      { config: { ...user, publicWhen: (req: FastifyRequest) => hasLinkParams(req.query) }, preHandler: artworkGuard, schema: { params: ArtworkParams, querystring: ArtworkQuery } },
      async (req, reply) => {
      if (!sectionEnabled(req.params.kind === 'book' ? 'audiobook' : 'music')) return reply.code(404).send({ error: 'no artwork', code: 'NOT_FOUND' });
      const art = await findArtwork(db, req.params.kind, req.params.id);
      if (!art) return reply.code(404).send({ error: 'no artwork', code: 'NOT_FOUND' });
      if (art.kind === 'redirect') return reply.redirect(art.url, 302);
      return reply.header('content-type', art.mimeType).header('cache-control', 'private, max-age=86400').send(art.body);
      },
    );

    // ---- progress -----------------------------------------------------------------------------
    app.put('/playback/progress/:itemKey', { ...playerUser, schema: { params: KeyParams, body: ProgressReport, response: { 200: PlaybackProgress, ...errors } } }, async (req) =>
      deps.progress.report(ownerOf(req), req.params.itemKey, req.body, now()).progress,
    );

    // navigator.sendBeacon posts text/plain; the parser is scoped to this one route.
    await app.register(async (beacon) => {
      beacon.addContentTypeParser('text/plain', { parseAs: 'string' }, (_req, body, done) => {
        try {
          done(null, JSON.parse(body as string));
        } catch {
          done(Object.assign(new Error('the beacon body is not JSON'), { statusCode: 400 }), undefined);
        }
      });
      beacon.withTypeProvider<ZodTypeProvider>().post('/playback/progress/beacon', { ...playerUser, schema: { body: ProgressBeacon, response: { 204: z.null(), ...errors } } }, async (req, reply) => {
        const { itemKey: key, ...report } = req.body;
        deps.progress.report(ownerOf(req), key, report, now());
        return reply.code(204).send(null);
      });
    });

    // An offline queue: oldest device time first, each with the single-report rules (stale ones are not applied).
    app.post('/playback/progress/batch', { ...playerUser, config: { ...user, audit: false }, schema: { body: ProgressBatchRequest, response: { 200: ProgressBatchResponse, ...errors } } }, async (req) => {
      const owner = ownerOf(req);
      const time = (r: { clientTime?: string | undefined }) => {
        const t = r.clientTime ? Date.parse(r.clientTime) : Number.NaN;
        return Number.isFinite(t) ? t : Number.MAX_SAFE_INTEGER;
      };
      const order = req.body.reports.map((r, i) => ({ r, i })).sort((a, b) => time(a.r) - time(b.r) || a.i - b.i);
      const results: ProgressBatchResponse['results'] = new Array(order.length);
      for (const { r, i } of order) {
        const { itemKey: key, ...report } = r;
        const outcome = deps.progress.report(owner, key, report, now());
        results[i] = { itemKey: key, accepted: outcome.accepted, progress: outcome.progress };
      }
      return { results };
    });

    app.patch('/playback/progress/:itemKey', { ...playerUser, schema: { params: KeyParams, body: ProgressUpdate, response: { 200: PlaybackProgress, ...errors } } }, async (req) =>
      deps.progress.update(ownerOf(req), req.params.itemKey, req.body, now()),
    );

    app.get('/playback/progress', { ...playerUser, schema: { querystring: ProgressQuery, response: { 200: ProgressListResponse, ...errors } } }, async (req) => {
      const keys = keysOf(req.query.itemKeys);
      const found = deps.progress.effective(ownerOf(req), req.auth?.user?.settings ?? null, keys);
      return { items: keys.flatMap((k) => (found.has(k) ? [found.get(k)!] : [])) };
    });

    app.get('/playback/continue', { ...playerUser, schema: { response: { 200: ContinueResponse, ...errors } } }, async (req) => {
      const features = getSection(db, 'features');
      const items = deps.progress
        .inProgress(ownerOf(req), 120)
        .filter((p) => !p.itemKey.startsWith('movie:') && !p.itemKey.startsWith('episode:'))
        .filter((p) => (p.itemKey.startsWith('track:') ? features.music : features.audiobooks))
        .flatMap((progress) => {
          const item = playableItem(browse, progress.itemKey);
          return item ? [{ item, progress }] : [];
        })
        .slice(0, 20);
      return { items };
    });

    // ---- queue ---------------------------------------------------------------------------------
    app.get('/playback/queue', { ...playerUser, schema: { response: { 200: PlayQueue, ...errors } } }, async (req) => queue.get(ownerOf(req)));
    app.put('/playback/queue', { ...playerUser, schema: { body: PlayQueue, response: { 200: PlayQueue, ...errors } } }, async (req) => queue.put(ownerOf(req), req.body, now()));

    // ---- bookmarks ------------------------------------------------------------------------------
    app.get('/playback/bookmarks', { ...playerUser, schema: { querystring: BookmarkListQuery, response: { 200: z.array(Bookmark), ...errors } } }, async (req) =>
      bookmarks.list(ownerOf(req), req.query.itemKey),
    );
    app.post('/playback/bookmarks', { ...playerUser, schema: { body: BookmarkInput, response: { 201: Bookmark, ...errors } } }, async (req, reply) =>
      reply.code(201).send(bookmarks.create(ownerOf(req), req.body, now())),
    );
    app.put('/playback/bookmarks/:id', { ...playerUser, schema: { params: IdParams, body: BookmarkUpdate, response: { 200: Bookmark, ...errors } } }, async (req) =>
      bookmarks.update(ownerOf(req), req.params.id, req.body),
    );
    app.delete('/playback/bookmarks/:id', { ...playerUser, schema: { params: IdParams, response: { 204: z.null(), ...errors } } }, async (req, reply) => {
      bookmarks.remove(ownerOf(req), req.params.id);
      return reply.code(204).send(null);
    });

    // ---- user playlists ---------------------------------------------------------------------
    app.get('/playback/playlists', { ...playerUser, schema: { response: { 200: z.array(UserPlaylistSummary), ...errors } } }, async (req) => playlists.list(ownerOf(req)));
    app.post('/playback/playlists', { ...playerUser, schema: { body: UserPlaylistInput, response: { 201: UserPlaylistDetails, ...errors } } }, async (req, reply) =>
      reply.code(201).send(playlists.create(ownerOf(req), req.body, now())),
    );
    app.get('/playback/playlists/:id', { ...playerUser, schema: { params: IdParams, response: { 200: UserPlaylistDetails, ...errors } } }, async (req) =>
      playlists.get(ownerOf(req), req.params.id),
    );
    app.put('/playback/playlists/:id', { ...playerUser, schema: { params: IdParams, body: UserPlaylistInput, response: { 200: UserPlaylistDetails, ...errors } } }, async (req) =>
      playlists.update(ownerOf(req), req.params.id, req.body, now()),
    );
    app.delete('/playback/playlists/:id', { ...playerUser, schema: { params: IdParams, response: { 204: z.null(), ...errors } } }, async (req, reply) => {
      playlists.remove(ownerOf(req), req.params.id);
      return reply.code(204).send(null);
    });
    // Incremental track edits: each is one transaction on the stored list, so two tabs editing
    // at once cannot drop each other's changes (or tracks that have no file yet).
    app.post('/playback/playlists/:id/tracks', { ...playerUser, schema: { params: IdParams, body: PlaylistTracksAdd, response: { 200: UserPlaylistDetails, ...errors } } }, async (req) =>
      playlists.addTracks(ownerOf(req), req.params.id, req.body, now()),
    );
    app.delete('/playback/playlists/:id/tracks/:entryId', { ...playerUser, schema: { params: EntryParams, response: { 200: UserPlaylistDetails, ...errors } } }, async (req) =>
      playlists.removeEntry(ownerOf(req), req.params.id, req.params.entryId, now()),
    );
    app.patch('/playback/playlists/:id/tracks/:entryId', { ...playerUser, schema: { params: EntryParams, body: PlaylistTrackMove, response: { 200: UserPlaylistDetails, ...errors } } }, async (req) =>
      playlists.moveEntry(ownerOf(req), req.params.id, req.params.entryId, req.body, now()),
    );

    // ---- browse: music ------------------------------------------------------------------------
    app.get('/playback/music/home', { ...music, schema: { response: { 200: MusicHome, ...errors } } }, async (req) => {
      const u = browseUserOf(req);
      const owner = ownerOfBrowse(u);
      return musicHome(browse, u, owner === null ? [] : playlists.list(owner), new Date(now()));
    });
    app.get('/playback/music/albums', { ...music, schema: { querystring: BrowseQuery, response: { 200: PlayerAlbumPage, ...errors } } }, async (req) => albumPage(browse, browseUserOf(req), req.query));
    app.get('/playback/music/albums/:id', { ...music, schema: { params: IdParams, response: { 200: PlayerAlbumDetails, ...errors } } }, async (req) => {
      const album = albumDetails(browse, req.params.id);
      if (!album) throw new PlayerNotFound(`album ${req.params.id} not found or has no files`);
      return album;
    });
    app.get('/playback/music/artists', { ...music, schema: { querystring: BrowseQuery, response: { 200: PlayerArtistPage, ...errors } } }, async (req) => artistPage(browse, browseUserOf(req), req.query));
    app.get('/playback/music/artists/:id', { ...music, schema: { params: IdParams, response: { 200: PlayerArtistDetails, ...errors } } }, async (req) => {
      const artist = artistDetails(browse, browseUserOf(req), req.params.id);
      if (!artist) throw new PlayerNotFound(`artist ${req.params.id} not found or has no files`);
      return artist;
    });
    app.get('/playback/music/tracks', { ...music, schema: { querystring: BrowseQuery, response: { 200: PlayerTrackPage, ...errors } } }, async (req) => trackPage(browse, browseUserOf(req), req.query));

    // ---- browse: audiobooks ---------------------------------------------------------------------
    app.get('/playback/audiobooks/home', { ...audiobooks, schema: { response: { 200: AudiobookHome, ...errors } } }, async (req) => audiobookHome(browse, browseUserOf(req)));
    app.get('/playback/audiobooks', { ...audiobooks, schema: { querystring: BrowseQuery, response: { 200: PlayerAudiobookPage, ...errors } } }, async (req) =>
      audiobookPage(browse, browseUserOf(req), req.query),
    );
    app.get('/playback/audiobooks/:id', { ...audiobooks, schema: { params: IdParams, response: { 200: PlayerAudiobookDetails, ...errors } } }, async (req) => {
      const book = audiobookDetails(browse, browseUserOf(req), req.params.id);
      if (!book) throw new PlayerNotFound(`audiobook ${req.params.id} not found or has no files`);
      return book;
    });

    // ---- search -------------------------------------------------------------------------------
    app.get('/playback/search', { ...player, schema: { querystring: SearchQuery, response: { 200: PlayerSearchResponse, ...errors } } }, async (req) => {
      const features = getSection(db, 'features');
      const out = playerSearch(browse, browseUserOf(req), req.query.q, { music: features.music, audiobooks: features.audiobooks });
      if (playerSettings(db).video) Object.assign(out, videoSearch({ db, basePath: deps.basePath, progress: deps.progress, now }, browseUserOf(req), req.query.q));
      return out;
    });
  };
}
