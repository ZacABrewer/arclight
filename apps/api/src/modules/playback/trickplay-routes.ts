import { createReadStream } from 'node:fs';
import type { FastifyPluginAsync, FastifyReply, FastifyRequest, RawServerDefault } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { eq } from 'drizzle-orm';
import { z } from 'zod';
import { TrickplayManifest } from '@arclight/shared';
import type { Db } from '../../db/index.js';
import { users } from '../auth/schema.js';
import { restrictionsOfSettings } from '../requests/certification.js';
import { decide, denialReply, isRemoteRequest, linkUserStillActive, playerSettings, requirePlayer, subjectOf } from './access.js';
import { hasLinkParams, linkKey, linkQuery, verifyLink } from './links.js';
import { TRICKPLAY_COLUMNS, TRICKPLAY_INTERVAL_MS, TRICKPLAY_ROWS, TRICKPLAY_TILE_WIDTH, type TrickplayService } from './trickplay.js';
import { mediaFileAllowed } from './video-items.js';
import { fileStamp } from './video-stream.js';

// Scrub-thumbnail routes: the manifest (player access, the caller's content limits), the sheets
// themselves (signed `trickplay:` links so native players and <img> can load them without a
// cookie), and the admin cache size / clear under Settings > Player.

export interface TrickplayRouteDeps {
  db: Db;
  basePath: string;
  apiKey: () => string;
  service: TrickplayService;
  now?: () => number;
}

const user = { access: { portal: true } } as const;
const ErrorBody = z.object({ error: z.string(), code: z.string() });
const errors = { 400: ErrorBody, 403: ErrorBody, 404: ErrorBody };
const FileParams = z.object({ mediaFileId: z.coerce.number().int().positive() });
const SheetParams = z.object({ mediaFileId: z.coerce.number().int().positive(), sheet: z.coerce.number().int().min(0).max(100_000) });
const SheetQuery = z.object({ u: z.string().max(20).optional(), exp: z.string().max(20).optional(), sig: z.string().max(100).optional(), v: z.string().max(64).optional() });
/** GET /settings/player/trickplay-cache (admin). */
export const TrickplayCacheSize = z.object({ bytes: z.number().int(), files: z.number().int() });

/** A manifest with no sheets (pending / unavailable). */
export function emptyManifest(mediaFileId: number, status: 'pending' | 'unavailable'): TrickplayManifest {
  return {
    mediaFileId,
    status,
    intervalMs: TRICKPLAY_INTERVAL_MS,
    tileWidth: TRICKPLAY_TILE_WIDTH,
    tileHeight: 0,
    columns: TRICKPLAY_COLUMNS,
    rows: TRICKPLAY_ROWS,
    tileCount: 0,
    sheets: [],
  };
}

/**
 * The client manifest of a file for `userId`, with absolute signed sheet URLs; generation is
 * queued when the file has none yet and the setting makes sheets on play. null when the setting is off.
 */
export async function signedTrickplay(
  deps: Pick<TrickplayRouteDeps, 'db' | 'apiKey' | 'service' | 'now'>,
  mediaFileId: number,
  userId: number,
  origin: string,
): Promise<TrickplayManifest | null> {
  const settings = playerSettings(deps.db);
  if (settings.trickplay === 'off') return null;
  const st = await deps.service.status(mediaFileId, { enqueue: true });
  if (st.status !== 'ready') return emptyManifest(mediaFileId, st.status);
  const m = st.manifest;
  const now = deps.now ?? Date.now;
  const exp = Math.floor(now() / 1000) + settings.streamLinkHours * 3600;
  const sig = linkQuery(linkKey(deps.apiKey()), { userId, fileId: mediaFileId, exp }, 'trickplay');
  const v = encodeURIComponent(m.stamp);
  return {
    mediaFileId,
    status: 'ready',
    intervalMs: m.intervalMs,
    tileWidth: m.tileWidth,
    tileHeight: m.tileHeight,
    columns: m.columns,
    rows: m.rows,
    tileCount: m.tileCount,
    sheets: Array.from({ length: m.sheetCount }, (_, n) => `${origin}/stream/trickplay/${mediaFileId}/${n}.jpg?${sig}&v=${v}`),
  };
}

export function trickplayRoutes(deps: TrickplayRouteDeps): FastifyPluginAsync<Record<never, never>, RawServerDefault, ZodTypeProvider> {
  const { db } = deps;
  const now = deps.now ?? Date.now;
  const guardUser = requirePlayer(db, { needsUser: true });
  const videoUser = async (req: FastifyRequest, reply: FastifyReply): Promise<void> => {
    await guardUser(req, reply);
    if (reply.sent) return;
    if (!playerSettings(db).video) await reply.code(404).send({ error: 'Movies & TV is turned off (Settings → Player)', code: 'SECTION_OFF' });
  };
  const restrictionsOfRequest = (req: FastifyRequest) => (req.auth?.user ? restrictionsOfSettings(req.auth.user.settings) : null);

  return async (app) => {
    app.get(
      '/playback/video/trickplay/:mediaFileId',
      { config: user, preHandler: videoUser, schema: { params: FileParams, response: { 200: TrickplayManifest, ...errors } } },
      async (req, reply) => {
        const id = req.params.mediaFileId;
        if (!mediaFileAllowed(db, id, restrictionsOfRequest(req))) return reply.code(404).send({ error: `video file ${id} not found`, code: 'NOT_FOUND' });
        const origin = `${req.protocol}://${req.host}${deps.basePath}/api/v1`;
        return (await signedTrickplay(deps, id, req.auth!.user!.id, origin)) ?? emptyManifest(id, 'unavailable');
      },
    );

    app.get(
      '/stream/trickplay/:mediaFileId/:sheet.jpg',
      { config: { ...user, publicWhen: (req: FastifyRequest) => hasLinkParams(req.query) }, schema: { params: SheetParams, querystring: SheetQuery } },
      async (req, reply) => {
        const id = req.params.mediaFileId;
        const settings = playerSettings(db);
        let restrictions;
        if (req.auth) {
          const decision = decide(settings, subjectOf(req), isRemoteRequest(req));
          if (decision.denial) return denialReply(reply, decision.denial);
          restrictions = restrictionsOfRequest(req);
        } else {
          const check = verifyLink(linkKey(deps.apiKey()), id, req.query, now(), 'trickplay');
          if (!check.ok) return reply.code(403).send({ error: check.reason === 'EXPIRED' ? 'this link has expired' : 'this link is not valid', code: `LINK_${check.reason}` });
          const row = db.select({ id: users.id, role: users.role, settings: users.settings }).from(users).where(eq(users.id, check.userId)).get();
          if (!row || !linkUserStillActive(db, row.id, now())) return reply.code(403).send({ error: 'this link was revoked', code: 'LINK_REVOKED' });
          const decision = decide(settings, { userId: row.id, isAdmin: row.role === 'admin', settings: row.settings }, isRemoteRequest(req));
          if (decision.denial) return denialReply(reply, decision.denial);
          restrictions = restrictionsOfSettings(row.settings);
        }
        if (!settings.video) return reply.code(404).send({ error: 'Movies & TV is turned off (Settings → Player)', code: 'SECTION_OFF' });
        const file = mediaFileAllowed(db, id, restrictions);
        if (!file) return reply.code(404).send({ error: `video file ${id} not found`, code: 'NOT_FOUND' });
        const v = req.query.v ?? '';
        // A sheet of an older version of the file (replaced since the manifest was made) is gone.
        if (!v || (await fileStamp(file.path)) !== v) return reply.code(404).send({ error: 'these scrub thumbnails are out of date', code: 'STALE' });
        const path = await deps.service.sheetPath(id, req.params.sheet, v);
        if (!path) return reply.code(404).send({ error: 'no such sheet', code: 'NOT_FOUND' });
        return reply.header('content-type', 'image/jpeg').header('cache-control', 'private, max-age=86400').send(createReadStream(path));
      },
    );

    // ---- admin: Settings > Player ---------------------------------------------------------
    app.get('/settings/player/trickplay-cache', { schema: { response: { 200: TrickplayCacheSize } } }, async () => deps.service.cacheSize());
    app.delete('/settings/player/trickplay-cache', {}, async (_req, reply) => {
      await deps.service.clear();
      return reply.code(204).send(null);
    });
  };
}
