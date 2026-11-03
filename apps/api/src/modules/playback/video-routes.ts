import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import type { FastifyPluginAsync, FastifyReply, FastifyRequest, RawServerDefault } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { and, eq } from 'drizzle-orm';
import { z } from 'zod';
import {
  isVideoKind,
  parseItemKey,
  PlayerMovieDetails,
  PlayerMoviePage,
  PlayerSeriesDetails,
  PlayerSeriesPage,
  VideoArtworkType,
  VideoBrowseQuery,
  VideoHome,
  VideoSession,
  VideoSessionRequest,
  VideoStreamQuery,
  VideoWatchedRequest,
  VideoWatchedResponse,
  type ContentRestrictions,
  type VideoInfo,
  type VideoSessionSubtitle,
  type VideoSubtitleTrack,
} from '@arclight/shared';
import type { Db } from '../../db/index.js';
import { users } from '../auth/schema.js';
import { episodes, movies, series } from '../library/schema.js';
import { restrictionsFor, restrictionsForProfile } from '../requests/certification.js';
import { subtitleFiles } from '../subtitles/schema.js';
import { decide, decisionOf, denialReply, isRemoteRequest, linkUserStillActive, playerSettings, requirePlayer, subjectOf, type PlayerDecision } from './access.js';
import { folderImage, remote, type Artwork } from './artwork.js';
import { browseUserOf, ownerOfBrowse } from './browse.js';
import type { PlaybackOwner } from './progress.js';
import { hasLinkParams, linkKey, linkQuery, verifyArtworkLink, verifyLink } from './links.js';
import type { ProgressStore } from './progress.js';
import { etagOf, notModified, parseRange, rangeStillValid } from './range.js';
import { FfmpegMissing, TranscodeBusy, type AudioTranscoder, type RunningTranscode } from './transcode.js';
import { markWatched, movieDetails, moviePage, seriesDetails, seriesPage, videoHome, type VideoBrowseContext } from './video-browse.js';
import { buildVideoStreamArgs, decideVideo, defaultVideoKbps, durationOf, externalSubtitleCodec, isTextSubtitle, videoContainerOf, videoMimeOf, type LiveVideoSpec, type VideoPlan } from './video-info.js';
import { episodeFiles, mediaFileAllowed, playableFilesOf, videoInfoForFile, withinRestrictions, type MediaFileRow } from './video-items.js';
import { firstOutput, MediaCacheError, type EncoderDetector, type MediaCache } from './video-stream.js';

// Movies & TV routes of the player: the playback session (direct play / remux / transcode with
// reason codes), GET|HEAD /stream/video/:mediaFileId (ranges for direct play; fragmented MP4 from
// a live ffmpeg otherwise), WebVTT subtitles, movie/series/episode artwork, browse and "mark
// watched". Every route passes the player guard and the Movies & TV switch (Settings â†’ Player),
// and nothing outside the user's content restrictions is listed, opened or streamed.

export interface VideoDeps {
  db: Db;
  basePath: string;
  progress: ProgressStore;
  apiKey: () => string;
  /** Live remux/transcode slots (Settings â†’ Player: live video slots). */
  transcoder: AudioTranscoder;
  encoders: EncoderDetector;
  cache: MediaCache;
  now?: () => number;
}

const user = { access: { portal: true } } as const;
const ErrorBody = z.object({ error: z.string(), code: z.string() });
const errors = { 400: ErrorBody, 403: ErrorBody, 404: ErrorBody };
const IdParams = z.object({ id: z.coerce.number().int().positive() });
const FileParams = z.object({ mediaFileId: z.coerce.number().int().positive() });
const SubtitleParams = z.object({ mediaFileId: z.coerce.number().int().positive(), subId: z.string().regex(/^(e[0-9]+|x[1-9][0-9]*)$/) });
// `p`: the household profile a link plays as (links.ts); absent on owner links.
const LinkParams = { u: z.string().max(20).optional(), p: z.string().max(20).optional(), exp: z.string().max(20).optional(), sig: z.string().max(100).optional() };
const StreamQuery = VideoStreamQuery.omit({ u: true, exp: true, sig: true }).extend(LinkParams);
const ArtworkQuery = z.object({ ...LinkParams, type: VideoArtworkType.optional(), w: z.enum(['342', '780', '1280', 'original']).optional() });

class VideoHttpError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

const headerText = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v);
/** Whose per-profile rows a request writes (400 NO_USER without a user). */
function ownerOrThrow(req: FastifyRequest): PlaybackOwner {
  const owner = ownerOfBrowse(browseUserOf(req));
  if (owner === null) throw new VideoHttpError(400, 'NO_USER', 'this request is not signed in as a user');
  return owner;
}
const restrictionsOfRequest = (req: FastifyRequest): ContentRestrictions | null => restrictionsFor(req.auth);
/** The profile a signed link names: a non-owner profile's id, else null (the owner, no `p=`). */
const linkProfileOf = (req: FastifyRequest): number | null => (req.auth?.profile && !req.auth.profile.isOwner ? req.auth.profile.id : null);

// ---- TMDB image sizes ----------------------------------------------------------------------------

const TMDB_SIZES: Record<VideoArtworkType, Record<'342' | '780' | '1280' | 'original', string>> = {
  poster: { '342': 'w342', '780': 'w780', '1280': 'original', original: 'original' },
  fanart: { '342': 'w300', '780': 'w780', '1280': 'w1280', original: 'original' },
  logo: { '342': 'w300', '780': 'w500', '1280': 'original', original: 'original' },
};

/** TMDB image URLs get the size the client asked for; other URLs pass through. */
export function sizedImageUrl(url: string, type: VideoArtworkType, width: '342' | '780' | '1280' | 'original' | undefined): string {
  if (!width) return url;
  return url.replace(/(image\.tmdb\.org\/t\/p\/)(w\d+|h\d+|original)\//, `$1${TMDB_SIZES[type][width]}/`);
}

const COVER: Record<VideoArtworkType, string[]> = { poster: ['poster'], fanart: ['fanart', 'banner'], logo: ['clearlogo'] };
const FOLDER_NAMES: Record<VideoArtworkType, string[]> = { poster: ['poster', 'folder', 'cover'], fanart: ['fanart', 'backdrop', 'background'], logo: ['logo', 'clearlogo'] };

/** Catalogue image (TMDB, sized), else an image file in the item's folder. */
async function titleArtwork(row: { images: Array<{ coverType: string; url: string; remoteUrl?: string | null | undefined }>; path: string }, type: VideoArtworkType, width: '342' | '780' | '1280' | 'original' | undefined): Promise<Artwork> {
  const found = remote(row.images, COVER[type]);
  if (found && found.kind === 'redirect') return { kind: 'redirect', url: sizedImageUrl(found.url, type, width) };
  return folderImage(row.path, FOLDER_NAMES[type]);
}

// ---- labels ------------------------------------------------------------------------------------

const languageNames = new Intl.DisplayNames(['en'], { type: 'language' });

function languageName(code: string | null): string | null {
  if (!code) return null;
  try {
    const name = languageNames.of(code);
    return name && name.toLowerCase() !== code.toLowerCase() ? name : code;
  } catch {
    return code;
  }
}

/** "English (Forced)", "German (SDH)", the track title, or "Track 3". */
export function subtitleLabel(t: VideoSubtitleTrack, index: number): string {
  const base = languageName(t.language) ?? t.title ?? `Track ${index + 1}`;
  const flags = [t.forced ? 'Forced' : null, t.hearingImpaired ? 'SDH' : null].filter(Boolean);
  return flags.length > 0 ? `${base} (${flags.join(', ')})` : base;
}

export function videoRoutes(deps: VideoDeps): FastifyPluginAsync<Record<never, never>, RawServerDefault, ZodTypeProvider> {
  const { db } = deps;
  const now = deps.now ?? Date.now;
  const browse: VideoBrowseContext = { db, basePath: deps.basePath, progress: deps.progress, now };
  const guard = requirePlayer(db);
  const guardUser = requirePlayer(db, { needsUser: true });

  /** The guard, then 404 while Movies & TV is turned off (Settings â†’ Player). */
  const videoOn =
    (base: typeof guard) =>
    async (req: FastifyRequest, reply: FastifyReply): Promise<void> => {
      await base(req, reply);
      if (reply.sent) return;
      if (!playerSettings(db).video) await reply.code(404).send({ error: 'Movies & TV is turned off (Settings â†’ Player)', code: 'SECTION_OFF' });
    };
  const video = { config: user, preHandler: videoOn(guard) } as const;
  const videoUser = { config: user, preHandler: videoOn(guardUser) } as const;

  interface StreamAccess {
    decision: PlayerDecision;
    userId: number | null;
    restrictions: ContentRestrictions | null;
  }

  /** Who a stream/subtitle request plays for: the signed-in caller, or a valid `video:` link's user. */
  function streamAccess(req: FastifyRequest, query: { u?: unknown; exp?: unknown; sig?: unknown }, mediaFileId: number): StreamAccess | VideoHttpError {
    const settings = playerSettings(db);
    const remoteReq = isRemoteRequest(req);
    if (req.auth) return { decision: decide(settings, subjectOf(req), remoteReq), userId: req.auth.user?.id ?? null, restrictions: restrictionsOfRequest(req) };
    const check = verifyLink(linkKey(deps.apiKey()), mediaFileId, query, now(), 'video');
    if (!check.ok) return new VideoHttpError(403, `LINK_${check.reason}`, check.reason === 'EXPIRED' ? 'this stream link has expired' : 'this stream link is not valid');
    const row = db.select({ id: users.id, role: users.role, settings: users.settings }).from(users).where(eq(users.id, check.userId)).get();
    if (!row || !linkUserStillActive(db, row.id, now(), check.profileId)) return new VideoHttpError(403, 'LINK_REVOKED', 'this stream link was revoked');
    // The link's profile caps apply on top of the account's (a Kids link never plays uncapped).
    let restrictions: ContentRestrictions | null;
    try {
      restrictions = restrictionsForProfile(db, row.id, check.profileId);
    } catch {
      return new VideoHttpError(403, 'LINK_REVOKED', 'this stream link was revoked');
    }
    return {
      decision: decide(settings, { userId: row.id, isAdmin: row.role === 'admin', settings: row.settings }, remoteReq),
      userId: row.id,
      restrictions,
    };
  }

  /** The media file a stream request may open (access, Movies & TV on, restrictions), or the error reply. */
  async function openFile(req: FastifyRequest, reply: FastifyReply, mediaFileId: number): Promise<{ access: StreamAccess; file: MediaFileRow } | null> {
    const access = streamAccess(req, req.query as Record<string, unknown>, mediaFileId);
    if (access instanceof VideoHttpError) {
      await reply.code(access.status).send({ error: access.message, code: access.code });
      return null;
    }
    if (access.decision.denial) {
      await denialReply(reply, access.decision.denial);
      return null;
    }
    if (!playerSettings(db).video) {
      await reply.code(404).send({ error: 'Movies & TV is turned off (Settings â†’ Player)', code: 'SECTION_OFF' });
      return null;
    }
    const file = mediaFileAllowed(db, mediaFileId, access.restrictions);
    if (!file) {
      await reply.code(404).send({ error: `video file ${mediaFileId} not found`, code: 'NOT_FOUND' });
      return null;
    }
    return { access, file };
  }

  /** Signed artwork links (as for audio artwork), remembering whose restrictions apply. */
  const artworkSubjects = new WeakMap<FastifyRequest, ContentRestrictions | null>();
  const artworkGuard = async (req: FastifyRequest, reply: FastifyReply) => {
    if (req.auth) {
      await videoOn(guard)(req, reply);
      artworkSubjects.set(req, restrictionsOfRequest(req));
      return;
    }
    const check = verifyArtworkLink(linkKey(deps.apiKey()), req.query as Record<string, unknown>, now());
    if (!check.ok) return reply.code(403).send({ error: check.reason === 'EXPIRED' ? 'this artwork link has expired' : 'this artwork link is not valid', code: `LINK_${check.reason}` });
    const row = db.select({ id: users.id, role: users.role, settings: users.settings }).from(users).where(eq(users.id, check.userId)).get();
    if (!row || !linkUserStillActive(db, row.id, now(), check.profileId)) return reply.code(403).send({ error: 'this artwork link was revoked', code: 'LINK_REVOKED' });
    let linkRestrictions: ContentRestrictions | null;
    try {
      linkRestrictions = restrictionsForProfile(db, row.id, check.profileId);
    } catch {
      return reply.code(403).send({ error: 'this artwork link was revoked', code: 'LINK_REVOKED' });
    }
    const decision = decide(playerSettings(db), { userId: row.id, isAdmin: row.role === 'admin', settings: row.settings }, isRemoteRequest(req));
    if (decision.denial) return denialReply(reply, decision.denial);
    if (!playerSettings(db).video) return reply.code(404).send({ error: 'Movies & TV is turned off (Settings â†’ Player)', code: 'SECTION_OFF' });
    artworkSubjects.set(req, linkRestrictions);
  };

  async function sendArtwork(reply: FastifyReply, art: Artwork) {
    if (!art) return reply.code(404).send({ error: 'no artwork', code: 'NOT_FOUND' });
    if (art.kind === 'redirect') return reply.header('cache-control', 'private, max-age=86400').redirect(art.url, 302);
    return reply.header('content-type', art.mimeType).header('cache-control', 'private, max-age=86400').send(art.body);
  }

  /** Starts ffmpeg for a remux/transcode; a hardware encoder that fails before any output is retried in software. */
  async function startLive(
    path: string,
    spec: LiveVideoSpec,
    userId: number | null,
    onProc: (p: RunningTranscode) => void,
    isClosed: () => boolean,
    log: FastifyRequest['log'],
  ): Promise<{ proc: RunningTranscode; hwaccel: string } | null> {
    let current = spec;
    if (spec.method === 'transcode') {
      const bin = await deps.transcoder.binaryPath();
      if (bin) {
        const choice = await deps.encoders.pick(bin);
        current = { ...spec, hwaccel: choice.hwaccel, zscale: choice.zscale };
      }
    }
    for (;;) {
      // The client left (a seek aborts the old request): start nothing, and take no slot.
      if (isClosed()) return null;
      const proc = await deps.transcoder.startArgs(buildVideoStreamArgs(path, current), userId);
      onProc(proc);
      if (await firstOutput(proc.stdout)) return { proc, hwaccel: current.hwaccel ?? 'none' };
      proc.kill();
      // No output because the client went away and we killed ffmpeg: not the encoder's fault.
      if (isClosed()) return null;
      const hw = current.hwaccel ?? 'none';
      if (current.method !== 'transcode' || hw === 'none') return null;
      log.warn({ hwaccel: hw }, 'hardware video encoding failed for a live stream; using software from now on');
      deps.encoders.markBroken(hw);
      current = { ...current, hwaccel: 'none' };
    }
  }

  return async (app) => {
    app.setErrorHandler((err, req, reply) => {
      if (err instanceof VideoHttpError) return reply.code(err.status).send({ error: err.message, code: err.code });
      if (err instanceof Error && 'validation' in err && err.validation) return reply.code(400).send({ error: err.message, code: 'VALIDATION' });
      const status = (err as { statusCode?: number }).statusCode;
      if (status && status >= 400 && status < 500) return reply.code(status).send({ error: (err as Error).message, code: 'BAD_REQUEST' });
      req.log.error({ err }, 'unhandled video playback error');
      return reply.code(500).send({ error: 'internal error', code: 'INTERNAL' });
    });

    // ---- session --------------------------------------------------------------------------
    app.post('/playback/video/session', { ...videoUser, schema: { body: VideoSessionRequest, response: { 200: VideoSession, ...errors } } }, async (req) => {
      const userId = req.auth!.user!.id;
      const body = req.body;
      const parsed = parseItemKey(body.itemKey);
      if (!parsed || !isVideoKind(parsed.kind)) throw new VideoHttpError(400, 'NOT_VIDEO', `${body.itemKey} is not a movie or an episode`);
      const files = playableFilesOf(db, parsed.kind, parsed.id, restrictionsOfRequest(req));
      if (!files) throw new VideoHttpError(404, 'NOT_FOUND', `${body.itemKey} not found or has no file`);
      const decision = decisionOf(req)!;
      const subtitleOf = (info: VideoInfo) => {
        if (!body.subtitle) return null;
        const t = info.subtitleTracks.find((s) => s.id === body.subtitle);
        if (!t) throw new VideoHttpError(400, 'NO_SUBTITLE', `subtitle ${body.subtitle} does not exist in this file`);
        return t;
      };
      const audioOf = (info: VideoInfo) => {
        if (body.audioTrack !== undefined && info.audioTracks.some((a) => a.index === body.audioTrack)) return body.audioTrack;
        return (info.audioTracks.find((a) => a.default) ?? info.audioTracks[0])?.index ?? 0;
      };
      const planFor = (f: (typeof files)[number]): VideoPlan =>
        decideVideo({ info: f.info, baseRange: f.baseRange, profile: body.profile, audioTrack: audioOf(f.info), subtitle: subtitleOf(f.info), quality: body.quality, userCapKbps: decision.maxBitrateKbps });
      let chosen: (typeof files)[number];
      if (body.mediaFileId !== undefined) {
        const f = files.find((x) => x.file.id === body.mediaFileId);
        if (!f) throw new VideoHttpError(404, 'NOT_FOUND', `file ${body.mediaFileId} is not a version of ${body.itemKey}`);
        chosen = f;
      } else {
        // External subtitle ids belong to one file: only versions that have the asked-for track
        // are candidates (none: 400 below). Then the best one the device plays as it is, else the best.
        const candidates = body.subtitle ? files.filter((f) => f.info.subtitleTracks.some((s) => s.id === body.subtitle)) : files;
        const pool = candidates.length > 0 ? candidates : files;
        chosen = pool.find((f) => planFor(f).method === 'direct') ?? pool[0]!;
      }
      const plan = planFor(chosen);
      const audioTrack = audioOf(chosen.info);
      const fileId = chosen.file.id;
      const startMs = plan.method === 'direct' ? 0 : (body.startMs ?? 0);
      const exp = Math.floor(now() / 1000) + playerSettings(db).streamLinkHours * 3600;
      const sig = linkQuery(linkKey(deps.apiKey()), { userId, profileId: linkProfileOf(req), fileId, exp }, 'video');
      const origin = `${req.protocol}://${req.host}${deps.basePath}/api/v1`;
      const params = new URLSearchParams({ m: plan.method });
      if (plan.method !== 'direct') {
        params.set('a', String(audioTrack));
        params.set('s', String(startMs));
        params.set('ac', plan.copyAudio ? 'copy' : plan.audioChannels >= 6 ? 'aac6' : 'aac2');
      }
      if (plan.method === 'transcode') {
        if (plan.height) params.set('h', String(plan.height));
        if (plan.videoKbps) params.set('k', String(plan.videoKbps));
        if (plan.videoCodec) params.set('vc', plan.videoCodec);
        if (plan.burn) params.set('b', plan.burn);
      }
      const subtitles: VideoSessionSubtitle[] = chosen.info.subtitleTracks.flatMap((t, i) =>
        t.text ? [{ id: t.id, label: subtitleLabel(t, i), language: t.language, forced: t.forced, default: t.default, url: `${origin}/stream/subtitle/${fileId}/${t.id}.vtt?${sig}` }] : [],
      );
      return {
        itemKey: body.itemKey,
        mediaFileId: fileId,
        method: plan.method,
        reasons: plan.reasons,
        url: `${origin}/stream/video/${fileId}?${params.toString()}&${sig}`,
        mimeType: plan.method === 'direct' ? videoMimeOf(chosen.info.container) : 'video/mp4',
        streamStartMs: startMs,
        seekable: plan.method === 'direct',
        durationMs: durationOf(chosen.file.mediaInfo ?? null, null),
        audioTrack,
        subtitles,
        burnedSubtitle: plan.burn,
        expiresAt: new Date(exp * 1000).toISOString(),
      };
    });

    // ---- the stream --------------------------------------------------------------------------
    app.route({
      method: ['GET', 'HEAD'],
      url: '/stream/video/:mediaFileId',
      config: { ...user, publicWhen: (req: FastifyRequest) => hasLinkParams(req.query) },
      schema: { params: FileParams, querystring: StreamQuery },
      handler: async (req, reply) => {
        const opened = await openFile(req, reply, req.params.mediaFileId);
        if (!opened) return reply;
        const { access, file } = opened;
        let info;
        try {
          info = await stat(file.path);
        } catch {
          return reply.code(404).send({ error: 'the file is missing on disk', code: 'FILE_MISSING' });
        }
        const head = req.method === 'HEAD';
        const q = req.query;
        const vinfo = videoInfoForFile(db, file);
        const cap = access.decision.maxBitrateKbps;
        let method = q.m;
        // The cap is enforced here too: a stream over it is transcoded at the cap whatever the link says.
        if (method !== 'transcode' && cap > 0 && (vinfo.bitrateKbps ?? 0) > cap) method = 'transcode';
        reply.header('cache-control', 'private, no-cache');

        if (method === 'direct') {
          const etag = etagOf(info);
          reply.header('accept-ranges', 'bytes').header('etag', etag).header('last-modified', info.mtime.toUTCString()).header('content-type', videoMimeOf(videoContainerOf(file.path, file.mediaInfo?.container)));
          const rangeHeader = req.headers.range;
          if (!rangeHeader && notModified(req.headers, etag, info.mtime)) return reply.code(304).send();
          const range = rangeStillValid(headerText(req.headers['if-range']), etag, info.mtime) ? parseRange(rangeHeader, info.size) : ({ kind: 'full' } as const);
          if (range.kind === 'unsatisfiable') return reply.code(416).header('content-range', `bytes */${info.size}`).type('application/json').send({ error: 'range not satisfiable', code: 'RANGE' });
          if (range.kind === 'partial') {
            reply.code(206).header('content-range', `bytes ${range.start}-${range.end}/${info.size}`).header('content-length', range.end - range.start + 1);
            return head ? reply.send() : reply.send(createReadStream(file.path, { start: range.start, end: range.end }));
          }
          reply.code(200).header('content-length', info.size);
          return head ? reply.send() : reply.send(createReadStream(file.path));
        }

        reply.header('content-type', 'video/mp4').header('accept-ranges', 'none');
        if (head) return deps.transcoder.canStart(access.userId) ? reply.code(200).send() : reply.code(503).header('retry-after', '5').send();
        const audio = vinfo.audioTracks.find((a) => a.index === q.a) ?? vinfo.audioTracks.find((a) => a.default) ?? vinfo.audioTracks[0] ?? null;
        const ac = q.ac ?? (audio && ['aac', 'mp3', 'ac3', 'eac3'].includes(audio.codec) ? 'copy' : 'aac2');
        const spec: LiveVideoSpec = {
          method,
          audioTrack: audio?.index ?? null,
          audioCodec: audio?.codec ?? null,
          audioChannelsIn: audio?.channels ?? null,
          copyAudio: ac === 'copy',
          audioChannels: ac === 'aac6' ? 6 : 2,
          startMs: q.s ?? 0,
          sourceVideoCodec: vinfo.videoCodec,
        };
        if (method === 'transcode') {
          const height = Math.min(q.h ?? vinfo.height ?? 1080, vinfo.height ?? 4320);
          const audioKbps = spec.audioChannels >= 6 ? 384 : 192;
          let kbps = q.k ?? defaultVideoKbps(height);
          if (cap > 0) kbps = Math.max(300, Math.min(kbps, cap - audioKbps));
          let burn: LiveVideoSpec['burn'] = null;
          if (q.b) burn = burnSource(db, file, vinfo, q.b);
          Object.assign(spec, { videoCodec: q.vc ?? 'h264', height, sourceHeight: vinfo.height, videoKbps: kbps, tonemap: vinfo.dynamicRange !== 'sdr', fps: vinfo.fps, burn });
        }
        let proc: RunningTranscode | null = null;
        let closed = false;
        reply.raw.on('close', () => {
          closed = true;
          proc?.kill();
        });
        let started;
        try {
          started = await startLive(
            file.path,
            spec,
            access.userId,
            (p) => {
              proc = p;
              if (closed) p.kill();
            },
            () => closed,
            req.log,
          );
        } catch (err) {
          if (err instanceof TranscodeBusy) return reply.code(503).header('content-type', 'application/json').header('retry-after', '5').send({ error: err.message, code: err.code });
          if (err instanceof FfmpegMissing) return reply.code(503).header('content-type', 'application/json').send({ error: err.message, code: err.code });
          throw err;
        }
        if (!started) {
          if (closed) return reply;
          return reply.code(500).header('content-type', 'application/json').send({ error: 'ffmpeg could not stream this file', code: 'STREAM_FAILED' });
        }
        started.proc.stdout.on('error', () => started.proc.kill());
        reply.header('x-arclight-video', `${method}/${started.hwaccel}`);
        return reply.code(200).send(started.proc.stdout);
      },
    });

    // ---- subtitles ------------------------------------------------------------------------------
    app.get(
      '/stream/subtitle/:mediaFileId/:subId.vtt',
      { config: { ...user, publicWhen: (req: FastifyRequest) => hasLinkParams(req.query) }, schema: { params: SubtitleParams, querystring: z.object(LinkParams) } },
      async (req, reply) => {
        const opened = await openFile(req, reply, req.params.mediaFileId);
        if (!opened) return reply;
        const { file } = opened;
        const id = req.params.subId;
        let path: string;
        try {
          if (id.startsWith('e')) {
            const ordinal = Number(id.slice(1));
            const stream = file.mediaInfo?.subtitleStreams?.[ordinal];
            if (!stream || !isTextSubtitle(stream.codec)) return reply.code(404).send({ error: `no text subtitle ${id} in this file`, code: 'NOT_FOUND' });
            path = await deps.cache.subtitle({ kind: 'embedded', mediaFileId: file.id, path: file.path, ordinal });
          } else {
            const sub = db
              .select()
              .from(subtitleFiles)
              .where(and(eq(subtitleFiles.id, Number(id.slice(1))), eq(subtitleFiles.mediaFileId, file.id)))
              .get();
            if (!sub?.path || sub.embedded || !isTextSubtitle(externalSubtitleCodec({ path: sub.path, codec: sub.codec }))) return reply.code(404).send({ error: `no text subtitle ${id} for this file`, code: 'NOT_FOUND' });
            path = await deps.cache.subtitle({ kind: 'external', subtitleId: sub.id, path: sub.path });
          }
        } catch (err) {
          if (err instanceof MediaCacheError) return reply.code(err.code === 'FFMPEG_MISSING' || err.code === 'BUSY' ? 503 : err.code === 'SOURCE_MISSING' ? 404 : 422).send({ error: err.message, code: err.code });
          throw err;
        }
        // Cast receivers fetch text tracks cross-origin; the URL is signed, so any origin may read it.
        return reply.header('content-type', 'text/vtt; charset=utf-8').header('cache-control', 'private, max-age=3600').header('access-control-allow-origin', '*').send(createReadStream(path));
      },
    );

    // ---- artwork ----------------------------------------------------------------------------------
    // Static segments win over /playback/artwork/:kind/:id (album/artist/book), which stays in routes.ts.
    const artworkRoute = { config: { ...user, publicWhen: (req: FastifyRequest) => hasLinkParams(req.query) }, preHandler: artworkGuard, schema: { params: IdParams, querystring: ArtworkQuery } } as const;
    app.get('/playback/artwork/movie/:id', artworkRoute, async (req, reply) => {
      const row = db.select({ images: movies.images, path: movies.path, certification: movies.certification }).from(movies).where(eq(movies.id, req.params.id)).get();
      if (!row || !withinCaps(artworkSubjects.get(req) ?? null, 'movie', row.certification)) return sendArtwork(reply, null);
      return sendArtwork(reply, await titleArtwork(row, req.query.type ?? 'poster', req.query.w));
    });
    app.get('/playback/artwork/series/:id', artworkRoute, async (req, reply) => {
      const row = db.select({ images: series.images, path: series.path, certification: series.certification }).from(series).where(eq(series.id, req.params.id)).get();
      if (!row || !withinCaps(artworkSubjects.get(req) ?? null, 'series', row.certification)) return sendArtwork(reply, null);
      return sendArtwork(reply, await titleArtwork(row, req.query.type ?? 'poster', req.query.w));
    });
    app.get('/playback/artwork/episode/:id', artworkRoute, async (req, reply) => {
      const row = db
        .select({ episode: episodes, images: series.images, path: series.path, certification: series.certification, runtime: series.runtimeMinutes })
        .from(episodes)
        .innerJoin(series, eq(series.id, episodes.seriesId))
        .where(eq(episodes.id, req.params.id))
        .get();
      if (!row || !withinCaps(artworkSubjects.get(req) ?? null, 'series', row.certification)) return sendArtwork(reply, null);
      const file = episodeFiles(db, row.episode).sort((a, b) => (a.id === row.episode.episodeFileId ? -1 : b.id === row.episode.episodeFileId ? 1 : 0))[0];
      if (file) {
        try {
          const thumb = await deps.cache.thumbnail(file.id, file.path, durationOf(file.mediaInfo ?? null, row.episode.runtimeMinutes ?? row.runtime));
          return reply.header('content-type', 'image/jpeg').header('cache-control', 'private, max-age=86400').send(createReadStream(thumb));
        } catch (err) {
          req.log.debug({ err, episodeId: row.episode.id }, 'no episode thumbnail; using the series backdrop');
        }
      }
      return sendArtwork(reply, await titleArtwork(row, 'fanart', req.query.w ?? '780'));
    });

    // ---- browse ----------------------------------------------------------------------------------
    app.get('/playback/video/home', { ...video, schema: { response: { 200: VideoHome, ...errors } } }, async (req) => videoHome(browse, browseUserOf(req)));
    app.get('/playback/movies', { ...video, schema: { querystring: VideoBrowseQuery, response: { 200: PlayerMoviePage, ...errors } } }, async (req) => moviePage(browse, browseUserOf(req), req.query));
    app.get('/playback/movies/:id', { ...video, schema: { params: IdParams, response: { 200: PlayerMovieDetails, ...errors } } }, async (req) => {
      const movie = movieDetails(browse, browseUserOf(req), req.params.id);
      if (!movie) throw new VideoHttpError(404, 'NOT_FOUND', `movie ${req.params.id} not found or has no file`);
      return movie;
    });
    app.get('/playback/series', { ...video, schema: { querystring: VideoBrowseQuery, response: { 200: PlayerSeriesPage, ...errors } } }, async (req) => seriesPage(browse, browseUserOf(req), req.query));
    app.get('/playback/series/:id', { ...video, schema: { params: IdParams, response: { 200: PlayerSeriesDetails, ...errors } } }, async (req) => {
      const show = seriesDetails(browse, browseUserOf(req), req.params.id);
      if (!show) throw new VideoHttpError(404, 'NOT_FOUND', `series ${req.params.id} not found or has no episodes with files`);
      return show;
    });

    app.post('/playback/watched', { ...videoUser, schema: { body: VideoWatchedRequest, response: { 200: VideoWatchedResponse, ...errors } } }, async (req) => ({
      updated: markWatched(browse, ownerOrThrow(req), req.body),
    }));
  };
}

const withinCaps = (r: ContentRestrictions | null, type: 'movie' | 'series', certification: string | null): boolean => withinRestrictions(r, type, certification);

/** What to burn in for `id`: an embedded image subtitle (ordinal) or an external image file. */
function burnSource(db: Db, file: MediaFileRow, info: VideoInfo, id: string): LiveVideoSpec['burn'] {
  const track = info.subtitleTracks.find((t) => t.id === id);
  if (!track) return null;
  if (track.source === 'embedded') return { ordinal: Number(id.slice(1)) };
  const sub = db
    .select({ path: subtitleFiles.path })
    .from(subtitleFiles)
    .where(and(eq(subtitleFiles.id, Number(id.slice(1))), eq(subtitleFiles.mediaFileId, file.id)))
    .get();
  return sub?.path ? { path: sub.path } : null;
}

