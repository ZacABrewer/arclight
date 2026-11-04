import { createReadStream } from 'node:fs';
import type { FastifyPluginAsync, FastifyReply, FastifyRequest, RawServerDefault } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { eq } from 'drizzle-orm';
import { z } from 'zod';
import {
  HLS_MIME_TYPE,
  RUNG_UNSUSTAINABLE,
  VideoHlsHealth,
  VideoHlsRungId,
  type VideoDeviceProfile,
  type VideoDynamicRange,
  type VideoHlsInfo,
  type VideoInfo,
  type VideoQuality,
  type VideoSubtitleTrack,
} from '@arclight/shared';
import type { Db } from '../../db/index.js';
import { users } from '../auth/schema.js';
import { restrictionsFor, restrictionsForProfile } from '../requests/certification.js';
import { decide, denialReply, isRemoteRequest, linkUserStillActive, playerSettings, subjectOf } from './access.js';
import { hasLinkParams, linkKey } from './links.js';
import { TranscodeBusy } from './transcode.js';
import type { KeyframeIndexer } from './hls/keyframes.js';
import { buildLadder, type Ladder } from './hls/ladder.js';
import { hlsLinkQuery, verifyHlsLink } from './hls/links.js';
import { HlsSessions, RungUnsustainable, SegmentFailed, SegmentNotReady, type HlsSession, type HlsSessionInit } from './hls/jobs.js';
import type { PipelineCaps } from './hls/pipeline.js';
import { segmentAt, segmentPlan } from './hls/plan.js';
import { masterPlaylist, mediaPlaylist } from './hls/playlist.js';
import { mediaFileAllowed, type MediaFileRow } from './video-items.js';
import type { StreamFeed } from './active-streams-routes.js';

// HLS delivery for Movies & TV (0.24): the session route builds a ladder and an HlsSession
// (openHlsSession); these routes serve its playlists, init and media segments, health, and end
// it. Playlists and segments are signed per session (`vhls:` links), so hls.js, Media3, Safari
// and cast receivers fetch them without cookies; every request re-checks the user's access.

export interface HlsDeps {
  db: Db;
  apiKey: () => string;
  sessions: HlsSessions;
  keyframes: KeyframeIndexer;
  /** The pipeline caps of this box (tested once per process). */
  caps: () => Promise<PipelineCaps>;
  now?: () => number;
  /** Activity -> Now playing (playlist and segment requests keep a stream alive). */
  streams?: StreamFeed;
}

export interface HlsOpenInput {
  userId: number;
  profileId: number | null;
  deviceKey: string;
  file: MediaFileRow;
  info: VideoInfo;
  baseRange: VideoDynamicRange | null;
  profile: VideoDeviceProfile;
  audioTrack: number;
  subtitle: VideoSubtitleTrack | null;
  quality: VideoQuality;
  capKbps: number;
  bandwidthKbps?: number;
  remote: boolean;
  startMs: number;
  durationMs: number;
  /** `<proto>://<host><base>/api/v1` */
  origin: string;
  exp: number;
  /** The burn-in source of an image subtitle id. */
  burnSource: (id: string) => HlsSessionInit['burnSource'];
}

export interface HlsOpened {
  session: HlsSession;
  ladder: Ladder;
  hls: VideoHlsInfo;
}

/** Builds the ladder and the session (throws TranscodeBusy when nothing can be produced now). */
export async function openHlsSession(deps: HlsDeps, input: HlsOpenInput): Promise<HlsOpened> {
  const index = await deps.keyframes.get(input.file.id, input.file.path);
  const durationSec = Math.max(1, input.durationMs / 1000);
  const plan = segmentPlan(index, durationSec);
  const caps = await deps.caps();
  const ladder = buildLadder({
    info: input.info,
    baseRange: input.baseRange,
    profile: input.profile,
    audioTrack: input.audioTrack,
    subtitle: input.subtitle,
    quality: input.quality,
    capKbps: input.capKbps,
    ...(input.bandwidthKbps ? { bandwidthKbps: input.bandwidthKbps } : {}),
    remote: input.remote,
    plan,
    index,
    caps,
    predict: (jc) => deps.sessions.capacity.predict(jc),
  });
  if (ladder.busy || ladder.rungs.length === 0) throw new TranscodeBusy('the server cannot convert another video right now; try again shortly');
  const session = await deps.sessions.create(
    {
      userId: input.userId,
      deviceKey: input.deviceKey,
      mediaFileId: input.file.id,
      input: input.file.path,
      info: input.info,
      plan,
      index,
      ladder,
      caps,
      burnSource: ladder.burn ? input.burnSource(ladder.burn.id) : null,
    },
    input.startMs / 1000,
  );
  const q = hlsLinkQuery(linkKey(deps.apiKey()), { userId: input.userId, profileId: input.profileId, sessionId: session.id, exp: input.exp });
  const base = `${input.origin}/stream/hls/${session.id}`;
  // Prewarm: the first segment the client will ask for.
  const startSeg = segmentAt(plan, input.startMs / 1000);
  void session.segment(ladder.startRung, startSeg).catch(() => undefined);
  return {
    session,
    ladder,
    hls: {
      masterUrl: `${base}/master.m3u8?${q}`,
      rungs: ladder.rungs.map((r, level) => ({ id: r.id, height: r.height, videoKbps: r.videoKbps, codec: r.codec, range: r.range, level })),
      startRung: ladder.startRung,
      healthUrl: `${input.origin}/playback/video/session/${session.id}/health?${q}`,
    },
  };
}

const LinkParams = { u: z.string().max(20).optional(), p: z.string().max(20).optional(), exp: z.string().max(20).optional(), sig: z.string().max(100).optional() };
const LinkQuery = z.object(LinkParams);
const SessionParams = z.object({ sessionId: z.string().regex(/^[0-9a-f]{32}$/) });
const RungParams = SessionParams.extend({ rung: VideoHlsRungId });
const SegmentParams = RungParams.extend({ n: z.coerce.number().int().min(0).max(1_000_000) });
const ErrorBody = z.object({ error: z.string(), code: z.string() });

const portal = { access: { portal: true } } as const;
const linked = { ...portal, publicWhen: (req: FastifyRequest) => hasLinkParams(req.query) } as const;
/** How long one request's access check is trusted for the same session (playlists and segments come fast). */
const ACCESS_TTL_MS = 30_000;

export function hlsRoutes(deps: HlsDeps): FastifyPluginAsync<Record<never, never>, RawServerDefault, ZodTypeProvider> {
  const { db } = deps;
  const now = deps.now ?? Date.now;
  const accessCache = new Map<string, number>();

  /** The session a request may use, or a sent error reply (null). */
  async function sessionOf(req: FastifyRequest, reply: FastifyReply, sessionId: string): Promise<HlsSession | null> {
    const session = deps.sessions.get(sessionId);
    const q = req.query as Record<string, unknown>;
    let userId: number;
    let profileId: number | null = null;
    if (hasLinkParams(q)) {
      const check = verifyHlsLink(linkKey(deps.apiKey()), sessionId, q, now());
      if (!check.ok) {
        await reply.code(403).send({ error: check.reason === 'EXPIRED' ? 'this stream link has expired' : 'this stream link is not valid', code: `LINK_${check.reason}` });
        return null;
      }
      userId = check.userId;
      profileId = check.profileId;
    } else if (req.auth?.user) {
      userId = req.auth.user.id;
    } else {
      await reply.code(403).send({ error: 'this stream link is not valid', code: 'LINK_MALFORMED' });
      return null;
    }
    if (!session || session.userId !== userId) {
      await reply.code(404).send({ error: 'this playback session has ended', code: 'SESSION_GONE' });
      return null;
    }
    const key = `${sessionId}:${userId}:${profileId ?? ''}:${isRemoteRequest(req) ? 'r' : 'l'}`;
    const checked = accessCache.get(key);
    if (checked === undefined || now() - checked > ACCESS_TTL_MS) {
      const settings = playerSettings(db);
      let subject = subjectOf(req);
      if (!req.auth) {
        const row = db.select({ id: users.id, role: users.role, settings: users.settings }).from(users).where(eq(users.id, userId)).get();
        if (!row || !linkUserStillActive(db, row.id, now(), profileId)) {
          await reply.code(403).send({ error: 'this stream link was revoked', code: 'LINK_REVOKED' });
          return null;
        }
        subject = { userId: row.id, isAdmin: row.role === 'admin', settings: row.settings };
      }
      const decision = decide(settings, subject, isRemoteRequest(req));
      if (decision.denial) {
        await denialReply(reply, decision.denial);
        return null;
      }
      if (!settings.video) {
        await reply.code(404).send({ error: 'Movies & TV is turned off (Settings → Player)', code: 'SECTION_OFF' });
        return null;
      }
      let allowed = false;
      try {
        allowed = mediaFileAllowed(db, session.init.mediaFileId, req.auth ? restrictionsFor(req.auth) : restrictionsForProfile(db, userId, profileId)) !== null;
      } catch {
        allowed = false;
      }
      if (!allowed) {
        await reply.code(404).send({ error: 'this playback session has ended', code: 'SESSION_GONE' });
        return null;
      }
      if (accessCache.size > 5000) accessCache.clear();
      accessCache.set(key, now());
    }
    deps.streams?.streams.hlsTouched(session.id);
    return session;
  }

  const queryOf = (req: FastifyRequest): string => {
    const q = req.query as Record<string, string | undefined>;
    const p = new URLSearchParams();
    for (const k of ['u', 'p', 'exp', 'sig'] as const) if (q[k] !== undefined) p.set(k, q[k]!);
    return p.toString();
  };

  const cors = (reply: FastifyReply) => reply.header('access-control-allow-origin', '*').header('access-control-expose-headers', 'x-arclight-encode');

  return async (app) => {
    app.get('/stream/hls/:sessionId/master.m3u8', { config: linked, schema: { params: SessionParams, querystring: LinkQuery } }, async (req, reply) => {
      const session = await sessionOf(req, reply, req.params.sessionId);
      if (!session) return reply;
      session.touch();
      const body = masterPlaylist(session.init.ladder.rungs, session.init.ladder.audio, queryOf(req), session.init.info.fps);
      return cors(reply).header('content-type', HLS_MIME_TYPE).header('cache-control', 'private, no-cache').send(body);
    });

    app.get('/stream/hls/:sessionId/:rung/index.m3u8', { config: linked, schema: { params: RungParams, querystring: LinkQuery } }, async (req, reply) => {
      const session = await sessionOf(req, reply, req.params.sessionId);
      if (!session) return reply;
      if (!session.rungs.has(req.params.rung)) return reply.code(404).send({ error: 'no such rung', code: 'NOT_FOUND' });
      session.touch();
      return cors(reply).header('content-type', HLS_MIME_TYPE).header('cache-control', 'private, max-age=60').send(mediaPlaylist(session.plan, queryOf(req)));
    });

    const sendFile = (reply: FastifyReply, session: HlsSession, path: string, type: string) => {
      const header = session.encodeHeader();
      if (header) reply.header('x-arclight-encode', header);
      return cors(reply).header('content-type', type).header('cache-control', 'private, max-age=3600').send(createReadStream(path));
    };

    const segmentError = (reply: FastifyReply, session: HlsSession, err: unknown) => {
      const header = session.encodeHeader();
      if (header) reply.header('x-arclight-encode', header);
      cors(reply);
      if (err instanceof RungUnsustainable) return reply.code(409).send({ error: 'the server cannot keep up with this quality; pick a lower one', code: RUNG_UNSUSTAINABLE });
      if (err instanceof SegmentNotReady) return reply.code(503).header('retry-after', '1').send({ error: 'still encoding', code: 'SEGMENT_NOT_READY' });
      if (err instanceof TranscodeBusy) return reply.code(503).header('retry-after', '5').send({ error: err.message, code: err.code });
      if (err instanceof SegmentFailed) return reply.code(err.message === 'no such segment' || err.message === 'no such rung' ? 404 : 500).send({ error: err.message, code: 'SEGMENT_FAILED' });
      throw err;
    };

    app.get('/stream/hls/:sessionId/:rung/init.mp4', { config: linked, schema: { params: RungParams, querystring: LinkQuery } }, async (req, reply) => {
      const session = await sessionOf(req, reply, req.params.sessionId);
      if (!session) return reply;
      try {
        return sendFile(reply, session, await session.initSegment(req.params.rung), 'video/mp4');
      } catch (err) {
        return segmentError(reply, session, err);
      }
    });

    app.get('/stream/hls/:sessionId/:rung/:n.m4s', { config: linked, schema: { params: SegmentParams, querystring: LinkQuery } }, async (req, reply) => {
      const session = await sessionOf(req, reply, req.params.sessionId);
      if (!session) return reply;
      try {
        return sendFile(reply, session, await session.segment(req.params.rung, req.params.n), 'video/iso.segment');
      } catch (err) {
        return segmentError(reply, session, err);
      }
    });

    app.get('/playback/video/session/:sessionId/health', { config: linked, schema: { params: SessionParams, querystring: LinkQuery, response: { 200: VideoHlsHealth, 403: ErrorBody, 404: ErrorBody } } }, async (req, reply) => {
      const session = await sessionOf(req, reply, req.params.sessionId);
      if (!session) return reply;
      cors(reply).header('cache-control', 'no-store');
      return session.health();
    });

    // Ends the session now (the client closed the player or changed item). Cookie or bearer only.
    app.delete('/playback/video/session/:sessionId', { config: portal, schema: { params: SessionParams, response: { 204: z.null(), 404: ErrorBody } } }, async (req, reply) => {
      const session = deps.sessions.get(req.params.sessionId);
      const userId = req.auth?.user?.id;
      if (!session || userId === undefined || session.userId !== userId) return reply.code(404).send({ error: 'this playback session has ended', code: 'SESSION_GONE' });
      await deps.sessions.delete(session.id);
      deps.streams?.streams.hlsEnded(session.id);
      return reply.code(204).send(null);
    });
  };
}
