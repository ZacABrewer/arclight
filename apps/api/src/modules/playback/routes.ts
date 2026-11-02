import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import type { FastifyPluginAsync, FastifyReply, FastifyRequest, RawServerDefault } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { and, eq, gt, isNull, or } from 'drizzle-orm';
import { z } from 'zod';
import {
  AudiobookHome,
  Bookmark,
  BookmarkInput,
  BookmarkListQuery,
  BookmarkUpdate,
  BrowseQuery,
  ContinueResponse,
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
  PlayerSearchResponse,
  PlayerSettings,
  PlayerTrackPage,
  PlaybackProgress,
  PlaylistTrackMove,
  PlaylistTracksAdd,
  PlayQueue,
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
  type PlayerCapabilities as Capabilities,
} from '@arclight/shared';
import type { Db } from '../../db/index.js';
import { sessions, userApiKeys, users } from '../auth/schema.js';
import { audioFiles } from '../library/schema.js';
import { getSection, setSection } from '../settings/service.js';
import { capabilitiesOf, decide, denialReply, isRemoteRequest, playerSettings, requirePlayer, subjectOf, type PlayerDecision } from './access.js';
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
  trackPage,
  type BrowseContext,
  type BrowseUser,
} from './browse.js';
import { mimeOf } from './format.js';
import { playableItem } from './items.js';
import { hasLinkParams, linkKey, linkQuery, verifyLink } from './links.js';
import type { ProgressStore } from './progress.js';
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
  now?: () => number;
}

const user = { access: { portal: true } } as const;
const ErrorBody = z.object({ error: z.string(), code: z.string() });
const errors = { 400: ErrorBody, 403: ErrorBody, 404: ErrorBody };
const IdParams = z.object({ id: z.coerce.number().int().positive() });
const EntryParams = z.object({ id: z.coerce.number().int().positive(), entryId: z.coerce.number().int().positive() });
const KeyParams = z.object({ itemKey: ItemKey });
const FileParams = z.object({ fileId: z.coerce.number().int().positive() });
const ArtworkParams = z.object({ kind: z.enum(['album', 'artist', 'book']), id: z.coerce.number().int().positive() });
const SearchQuery = z.object({ q: z.string().max(200).default('') });
const StreamQueryWithLink = StreamQuery.extend({ u: z.string().max(20).optional(), exp: z.string().max(20).optional(), sig: z.string().max(100).optional() });

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

function userIdOf(req: FastifyRequest): number {
  const id = req.auth?.user?.id;
  if (id === undefined) throw new PlayerHttpError(400, 'NO_USER', 'this request is not signed in as a user');
  return id;
}

const headerText = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v);

const browseUser = (req: FastifyRequest): BrowseUser => ({ userId: req.auth?.user?.id ?? null, settings: req.auth?.user?.settings ?? null });

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
  function sectionEnabled(kind: 'music' | 'track' | 'audiobook'): boolean {
    const features = getSection(db, 'features');
    return kind === 'audiobook' ? features.audiobooks : features.music;
  }

  /** The playable item, or 404 when it is missing, has no file or its section is off. */
  function itemOr404(key: string): PlayableItem {
    const parsed = parseItemKey(key);
    const item = parsed && sectionEnabled(parsed.kind) ? playableItem(browse, key) : null;
    if (!item) throw new PlayerNotFound(`${key} not found or has no file`);
    return item;
  }

  /** The keys of a progress query, validated (400 on a bad or too long list). */
  function keysOf(raw: string): string[] {
    const keys = [...new Set(raw.split(',').map((k) => k.trim()).filter(Boolean))];
    if (keys.length > MAX_PROGRESS_KEYS) throw new PlayerHttpError(400, 'VALIDATION', `at most ${MAX_PROGRESS_KEYS} item keys`);
    const bad = keys.find((k) => !parseItemKey(k));
    if (bad) throw new PlayerHttpError(400, 'VALIDATION', `not an item key: ${bad}`);
    return keys;
  }

  /**
   * A signed link stays usable while its user may still sign in: some unexpired session or
   * personal API key. "Sign out everywhere", a password change and deleting the user end it.
   */
  function linkUserStillActive(userId: number): boolean {
    const at = new Date(now()).toISOString();
    const session = db
      .select({ id: sessions.id })
      .from(sessions)
      .where(and(eq(sessions.userId, userId), gt(sessions.expiresAt, at)))
      .get();
    if (session) return true;
    const key = db
      .select({ id: userApiKeys.id })
      .from(userApiKeys)
      .where(and(eq(userApiKeys.userId, userId), or(isNull(userApiKeys.expiresAt), gt(userApiKeys.expiresAt, at))))
      .get();
    return key !== undefined;
  }

  /** The decision for a stream request: the signed-in caller, or the user of a valid link. */
  function streamDecision(req: FastifyRequest, query: { u?: unknown; exp?: unknown; sig?: unknown }, fileId: number): { decision: PlayerDecision; userId: number | null } | PlayerHttpError {
    const settings = playerSettings(db);
    const remote = isRemoteRequest(req);
    if (req.auth) return { decision: decide(settings, subjectOf(req), remote), userId: req.auth.user?.id ?? null };
    const check = verifyLink(linkKey(deps.apiKey()), fileId, query, now());
    if (!check.ok) return new PlayerHttpError(403, `LINK_${check.reason}`, check.reason === 'EXPIRED' ? 'this stream link has expired' : 'this stream link is not valid');
    const row = db.select({ id: users.id, role: users.role, settings: users.settings }).from(users).where(eq(users.id, check.userId)).get();
    if (!row || !linkUserStillActive(row.id)) return new PlayerHttpError(403, 'LINK_REVOKED', 'this stream link was revoked');
    return { decision: decide(settings, { userId: row.id, isAdmin: row.role === 'admin', settings: row.settings }, remote), userId: row.id };
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
    app.put('/settings/player', { schema: { body: PlayerSettings, response: { 200: PlayerSettings } } }, async (req) => setSection(db, 'player', req.body));

    // ---- access -------------------------------------------------------------------------
    app.get('/playback/me', { config: user, schema: { response: { 200: PlayerCapabilities } } }, async (req): Promise<Capabilities> =>
      capabilitiesOf(db, decide(playerSettings(db), subjectOf(req), isRemoteRequest(req))),
    );

    // ---- items and stream links ------------------------------------------------------------
    app.get('/playback/item/:itemKey', { ...player, schema: { params: KeyParams, response: { 200: PlayableItem, ...errors } } }, async (req) => itemOr404(req.params.itemKey));

    app.post('/playback/stream-links', { ...playerUser, schema: { body: StreamLinksRequest, response: { 200: StreamLinksResponse, ...errors } } }, async (req) => {
      const userId = userIdOf(req);
      const item = itemOr404(req.body.itemKey);
      const exp = Math.floor(now() / 1000) + playerSettings(db).streamLinkHours * 3600;
      const key = linkKey(deps.apiKey());
      const origin = `${req.protocol}://${req.host}`;
      const format = req.body.format === 'original' ? '' : `format=${req.body.format}&${req.body.bitrateKbps ? `bitrateKbps=${req.body.bitrateKbps}&` : ''}`;
      return {
        links: item.parts.map((p) => ({
          fileId: p.fileId,
          url: `${origin}${deps.basePath}/api/v1/stream/audio/${p.fileId}?${format}${linkQuery(key, { userId, fileId: p.fileId, exp })}`,
          expiresAt: new Date(exp * 1000).toISOString(),
        })),
      };
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
    app.get('/playback/artwork/:kind/:id', { ...player, schema: { params: ArtworkParams } }, async (req, reply) => {
      if (!sectionEnabled(req.params.kind === 'book' ? 'audiobook' : 'music')) return reply.code(404).send({ error: 'no artwork', code: 'NOT_FOUND' });
      const art = await findArtwork(db, req.params.kind, req.params.id);
      if (!art) return reply.code(404).send({ error: 'no artwork', code: 'NOT_FOUND' });
      if (art.kind === 'redirect') return reply.redirect(art.url, 302);
      return reply.header('content-type', art.mimeType).header('cache-control', 'private, max-age=86400').send(art.body);
    });

    // ---- progress -----------------------------------------------------------------------------
    app.put('/playback/progress/:itemKey', { ...playerUser, schema: { params: KeyParams, body: ProgressReport, response: { 200: PlaybackProgress, ...errors } } }, async (req) =>
      deps.progress.report(userIdOf(req), req.params.itemKey, req.body, now()).progress,
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
        deps.progress.report(userIdOf(req), key, report, now());
        return reply.code(204).send(null);
      });
    });

    app.patch('/playback/progress/:itemKey', { ...playerUser, schema: { params: KeyParams, body: ProgressUpdate, response: { 200: PlaybackProgress, ...errors } } }, async (req) =>
      deps.progress.update(userIdOf(req), req.params.itemKey, req.body, now()),
    );

    app.get('/playback/progress', { ...playerUser, schema: { querystring: ProgressQuery, response: { 200: ProgressListResponse, ...errors } } }, async (req) => {
      const keys = keysOf(req.query.itemKeys);
      const found = deps.progress.effective(userIdOf(req), req.auth?.user?.settings ?? null, keys);
      return { items: keys.flatMap((k) => (found.has(k) ? [found.get(k)!] : [])) };
    });

    app.get('/playback/continue', { ...playerUser, schema: { response: { 200: ContinueResponse, ...errors } } }, async (req) => {
      const features = getSection(db, 'features');
      const items = deps.progress
        .inProgress(userIdOf(req), 40)
        .filter((p) => (p.itemKey.startsWith('track:') ? features.music : features.audiobooks))
        .flatMap((progress) => {
          const item = playableItem(browse, progress.itemKey);
          return item ? [{ item, progress }] : [];
        })
        .slice(0, 20);
      return { items };
    });

    // ---- queue ---------------------------------------------------------------------------------
    app.get('/playback/queue', { ...playerUser, schema: { response: { 200: PlayQueue, ...errors } } }, async (req) => queue.get(userIdOf(req)));
    app.put('/playback/queue', { ...playerUser, schema: { body: PlayQueue, response: { 200: PlayQueue, ...errors } } }, async (req) => queue.put(userIdOf(req), req.body, now()));

    // ---- bookmarks ------------------------------------------------------------------------------
    app.get('/playback/bookmarks', { ...playerUser, schema: { querystring: BookmarkListQuery, response: { 200: z.array(Bookmark), ...errors } } }, async (req) =>
      bookmarks.list(userIdOf(req), req.query.itemKey),
    );
    app.post('/playback/bookmarks', { ...playerUser, schema: { body: BookmarkInput, response: { 201: Bookmark, ...errors } } }, async (req, reply) =>
      reply.code(201).send(bookmarks.create(userIdOf(req), req.body, now())),
    );
    app.put('/playback/bookmarks/:id', { ...playerUser, schema: { params: IdParams, body: BookmarkUpdate, response: { 200: Bookmark, ...errors } } }, async (req) =>
      bookmarks.update(userIdOf(req), req.params.id, req.body),
    );
    app.delete('/playback/bookmarks/:id', { ...playerUser, schema: { params: IdParams, response: { 204: z.null(), ...errors } } }, async (req, reply) => {
      bookmarks.remove(userIdOf(req), req.params.id);
      return reply.code(204).send(null);
    });

    // ---- user playlists ---------------------------------------------------------------------
    app.get('/playback/playlists', { ...playerUser, schema: { response: { 200: z.array(UserPlaylistSummary), ...errors } } }, async (req) => playlists.list(userIdOf(req)));
    app.post('/playback/playlists', { ...playerUser, schema: { body: UserPlaylistInput, response: { 201: UserPlaylistDetails, ...errors } } }, async (req, reply) =>
      reply.code(201).send(playlists.create(userIdOf(req), req.body, now())),
    );
    app.get('/playback/playlists/:id', { ...playerUser, schema: { params: IdParams, response: { 200: UserPlaylistDetails, ...errors } } }, async (req) =>
      playlists.get(userIdOf(req), req.params.id),
    );
    app.put('/playback/playlists/:id', { ...playerUser, schema: { params: IdParams, body: UserPlaylistInput, response: { 200: UserPlaylistDetails, ...errors } } }, async (req) =>
      playlists.update(userIdOf(req), req.params.id, req.body, now()),
    );
    app.delete('/playback/playlists/:id', { ...playerUser, schema: { params: IdParams, response: { 204: z.null(), ...errors } } }, async (req, reply) => {
      playlists.remove(userIdOf(req), req.params.id);
      return reply.code(204).send(null);
    });
    // Incremental track edits: each is one transaction on the stored list, so two tabs editing
    // at once cannot drop each other's changes (or tracks that have no file yet).
    app.post('/playback/playlists/:id/tracks', { ...playerUser, schema: { params: IdParams, body: PlaylistTracksAdd, response: { 200: UserPlaylistDetails, ...errors } } }, async (req) =>
      playlists.addTracks(userIdOf(req), req.params.id, req.body, now()),
    );
    app.delete('/playback/playlists/:id/tracks/:entryId', { ...playerUser, schema: { params: EntryParams, response: { 200: UserPlaylistDetails, ...errors } } }, async (req) =>
      playlists.removeEntry(userIdOf(req), req.params.id, req.params.entryId, now()),
    );
    app.patch('/playback/playlists/:id/tracks/:entryId', { ...playerUser, schema: { params: EntryParams, body: PlaylistTrackMove, response: { 200: UserPlaylistDetails, ...errors } } }, async (req) =>
      playlists.moveEntry(userIdOf(req), req.params.id, req.params.entryId, req.body, now()),
    );

    // ---- browse: music ------------------------------------------------------------------------
    app.get('/playback/music/home', { ...music, schema: { response: { 200: MusicHome, ...errors } } }, async (req) => {
      const u = browseUser(req);
      return musicHome(browse, u, u.userId === null ? [] : playlists.list(u.userId), new Date(now()));
    });
    app.get('/playback/music/albums', { ...music, schema: { querystring: BrowseQuery, response: { 200: PlayerAlbumPage, ...errors } } }, async (req) => albumPage(browse, browseUser(req), req.query));
    app.get('/playback/music/albums/:id', { ...music, schema: { params: IdParams, response: { 200: PlayerAlbumDetails, ...errors } } }, async (req) => {
      const album = albumDetails(browse, req.params.id);
      if (!album) throw new PlayerNotFound(`album ${req.params.id} not found or has no files`);
      return album;
    });
    app.get('/playback/music/artists', { ...music, schema: { querystring: BrowseQuery, response: { 200: PlayerArtistPage, ...errors } } }, async (req) => artistPage(browse, browseUser(req), req.query));
    app.get('/playback/music/artists/:id', { ...music, schema: { params: IdParams, response: { 200: PlayerArtistDetails, ...errors } } }, async (req) => {
      const artist = artistDetails(browse, browseUser(req), req.params.id);
      if (!artist) throw new PlayerNotFound(`artist ${req.params.id} not found or has no files`);
      return artist;
    });
    app.get('/playback/music/tracks', { ...music, schema: { querystring: BrowseQuery, response: { 200: PlayerTrackPage, ...errors } } }, async (req) => trackPage(browse, browseUser(req), req.query));

    // ---- browse: audiobooks ---------------------------------------------------------------------
    app.get('/playback/audiobooks/home', { ...audiobooks, schema: { response: { 200: AudiobookHome, ...errors } } }, async (req) => audiobookHome(browse, browseUser(req)));
    app.get('/playback/audiobooks', { ...audiobooks, schema: { querystring: BrowseQuery, response: { 200: PlayerAudiobookPage, ...errors } } }, async (req) =>
      audiobookPage(browse, browseUser(req), req.query),
    );
    app.get('/playback/audiobooks/:id', { ...audiobooks, schema: { params: IdParams, response: { 200: PlayerAudiobookDetails, ...errors } } }, async (req) => {
      const book = audiobookDetails(browse, browseUser(req), req.params.id);
      if (!book) throw new PlayerNotFound(`audiobook ${req.params.id} not found or has no files`);
      return book;
    });

    // ---- search -------------------------------------------------------------------------------
    app.get('/playback/search', { ...player, schema: { querystring: SearchQuery, response: { 200: PlayerSearchResponse, ...errors } } }, async (req) => {
      const features = getSection(db, 'features');
      return playerSearch(browse, browseUser(req), req.query.q, { music: features.music, audiobooks: features.audiobooks });
    });
  };
}
