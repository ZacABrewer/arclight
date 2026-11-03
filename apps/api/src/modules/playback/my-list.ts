import type { FastifyPluginAsync, FastifyReply, FastifyRequest, RawServerDefault } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { and, count, desc, eq, inArray, isNotNull } from 'drizzle-orm';
import { z } from 'zod';
import { itemKey, MY_LIST_MAX, MyListKey, MyListResponse, type ContentRestrictions, type VideoCard } from '@arclight/shared';
import type { Db } from '../../db/index.js';
import { profileMyList } from '../households/schema.js';
import { episodes, movies, series } from '../library/schema.js';
import { requirePlayer, playerSettings } from './access.js';
import { browseUserOf, ownerOfBrowse } from './browse.js';
import type { ProgressStore } from './progress.js';
import { progressFor, restrictionsOf } from './video-browse.js';
import { imageUrl, withinRestrictions } from './video-items.js';

// My List (spec §1.2, §3.2): per household profile, movies and series the profile saved for
// later. Separate from the request watchlist (per account, TMDB-keyed). Every route needs a user
// and the player; titles outside the profile's content limits are left out of the list (they
// stay stored, so lifting a limit brings them back) and cannot be added (404, as on details).

export interface MyListDeps {
  db: Db;
  basePath: string;
  progress: ProgressStore;
  now?: () => number;
}

const CHUNK = 500;

/** Which of `keys` are on the profile's list (featured, details and home rows read this). */
export async function myListHas(db: Db, profileId: number, keys: readonly string[]): Promise<Set<string>> {
  const out = new Set<string>();
  const wanted = [...new Set(keys)];
  for (let i = 0; i < wanted.length; i += CHUNK) {
    const rows = db
      .select({ itemKey: profileMyList.itemKey })
      .from(profileMyList)
      .where(and(eq(profileMyList.profileId, profileId), inArray(profileMyList.itemKey, wanted.slice(i, i + CHUNK))))
      .all();
    for (const r of rows) out.add(r.itemKey);
  }
  return out;
}

/** The stored keys, newest first. */
export function myListKeys(db: Db, profileId: number): string[] {
  return db
    .select({ itemKey: profileMyList.itemKey })
    .from(profileMyList)
    .where(eq(profileMyList.profileId, profileId))
    .orderBy(desc(profileMyList.addedAt), desc(profileMyList.id))
    .all()
    .map((r) => r.itemKey);
}

function parseKey(key: string): { kind: 'movie' | 'series'; id: number } {
  const [kind, id] = key.split(':') as ['movie' | 'series', string];
  return { kind, id: Number(id) };
}

/** True when the title exists, has something to play and is within the caps. */
function playable(db: Db, kind: 'movie' | 'series', id: number, r: ContentRestrictions | null): boolean {
  if (kind === 'movie') {
    const row = db.select({ certification: movies.certification }).from(movies).where(and(eq(movies.id, id), eq(movies.hasFile, true))).get();
    return row !== undefined && withinRestrictions(r, 'movie', row.certification);
  }
  const row = db.select({ certification: series.certification }).from(series).where(eq(series.id, id)).get();
  if (!row || !withinRestrictions(r, 'series', row.certification)) return false;
  const ep = db
    .select({ id: episodes.id })
    .from(episodes)
    .where(and(eq(episodes.seriesId, id), eq(episodes.hasFile, true), isNotNull(episodes.episodeFileId)))
    .get();
  return ep !== undefined;
}

/** The cards of `keys` in order; missing, file-less and restricted titles are left out. */
export function myListCards(deps: MyListDeps, user: ReturnType<typeof browseUserOf>, keys: readonly string[]): VideoCard[] {
  const { db, basePath } = deps;
  const r = restrictionsOf(user);
  const movieIds = keys.flatMap((k) => (k.startsWith('movie:') ? [parseKey(k).id] : []));
  const seriesIds = keys.flatMap((k) => (k.startsWith('series:') ? [parseKey(k).id] : []));
  const movieRows = new Map<number, typeof movies.$inferSelect>();
  const seriesRows = new Map<number, typeof series.$inferSelect>();
  const seriesWithFiles = new Set<number>();
  for (let i = 0; i < movieIds.length; i += CHUNK) {
    for (const m of db.select().from(movies).where(and(inArray(movies.id, movieIds.slice(i, i + CHUNK)), eq(movies.hasFile, true))).all()) {
      if (withinRestrictions(r, 'movie', m.certification)) movieRows.set(m.id, m);
    }
  }
  for (let i = 0; i < seriesIds.length; i += CHUNK) {
    const ids = seriesIds.slice(i, i + CHUNK);
    for (const s of db.select().from(series).where(inArray(series.id, ids)).all()) {
      if (withinRestrictions(r, 'series', s.certification)) seriesRows.set(s.id, s);
    }
    for (const e of db
      .selectDistinct({ seriesId: episodes.seriesId })
      .from(episodes)
      .where(and(inArray(episodes.seriesId, ids), eq(episodes.hasFile, true), isNotNull(episodes.episodeFileId)))
      .all()) {
      seriesWithFiles.add(e.seriesId);
    }
  }
  const progress = progressFor({ db, basePath, progress: deps.progress }, user, [...movieRows.keys()].map((id) => itemKey('movie', id)));
  const out: VideoCard[] = [];
  for (const key of keys) {
    const { kind, id } = parseKey(key);
    if (kind === 'movie') {
      const m = movieRows.get(id);
      if (!m) continue;
      const p = progress.get(itemKey('movie', id));
      out.push({
        itemKey: itemKey('movie', id),
        kind: 'movie',
        id,
        title: m.title,
        subtitle: null,
        year: m.year || null,
        posterUrl: imageUrl(basePath, 'movie', id, m.images, 'poster', '342'),
        backdropUrl: imageUrl(basePath, 'movie', id, m.images, 'fanart', '1280'),
        thumbUrl: null,
        progress: p && (p.played || p.positionMs > 0) ? { positionMs: p.positionMs, durationMs: p.durationMs, played: p.played } : null,
        badges: [],
      });
    } else {
      const s = seriesRows.get(id);
      if (!s || !seriesWithFiles.has(id)) continue;
      out.push({
        itemKey: null,
        kind: 'series',
        id,
        title: s.title,
        subtitle: s.network ?? null,
        year: s.year || null,
        posterUrl: imageUrl(basePath, 'series', id, s.images, 'poster', '342'),
        backdropUrl: imageUrl(basePath, 'series', id, s.images, 'fanart', '1280'),
        thumbUrl: null,
        progress: null,
        badges: [],
      });
    }
  }
  return out;
}

const user = { access: { portal: true } } as const;
const ErrorBody = z.object({ error: z.string(), code: z.string().optional() });
const errors = { 400: ErrorBody, 403: ErrorBody, 404: ErrorBody, 409: ErrorBody };
const KeyParams = z.object({ key: MyListKey });

function profileOf(req: FastifyRequest, reply: FastifyReply): { profileId: number; user: ReturnType<typeof browseUserOf> } | null {
  const u = browseUserOf(req);
  const owner = ownerOfBrowse(u);
  if (owner === null) {
    void reply.code(400).send({ error: 'this request is not signed in as a user', code: 'NO_USER' });
    return null;
  }
  return { profileId: owner.profileId, user: u };
}

export function myListRoutes(deps: MyListDeps): FastifyPluginAsync<Record<never, never>, RawServerDefault, ZodTypeProvider> {
  const { db } = deps;
  const now = deps.now ?? Date.now;
  const guardUser = requirePlayer(db, { needsUser: true });
  /** The player guard, then 404 while Movies & TV is off (Settings → Player). */
  const preHandler = async (req: FastifyRequest, reply: FastifyReply) => {
    await guardUser(req, reply);
    if (reply.sent) return;
    if (!playerSettings(db).video) await reply.code(404).send({ error: 'Movies & TV is turned off (Settings → Player)', code: 'SECTION_OFF' });
  };
  const opts = { config: user, preHandler } as const;

  return async (app) => {
    app.get('/playback/my-list', { ...opts, schema: { response: { 200: MyListResponse, ...errors } } }, async (req, reply) => {
      const who = profileOf(req, reply);
      if (!who) return reply;
      return { items: myListCards(deps, who.user, myListKeys(db, who.profileId)) };
    });

    app.put('/playback/my-list/:key', { ...opts, schema: { params: KeyParams, response: { 204: z.null(), ...errors } } }, async (req, reply) => {
      const who = profileOf(req, reply);
      if (!who) return reply;
      const { kind, id } = parseKey(req.params.key);
      if (!playable(db, kind, id, restrictionsOf(who.user))) return reply.code(404).send({ error: `${req.params.key} not found`, code: 'NOT_FOUND' });
      const added = db.transaction((tx) => {
        const exists = tx
          .select({ id: profileMyList.id })
          .from(profileMyList)
          .where(and(eq(profileMyList.profileId, who.profileId), eq(profileMyList.itemKey, req.params.key)))
          .get();
        if (exists) return true;
        const total = tx.select({ n: count() }).from(profileMyList).where(eq(profileMyList.profileId, who.profileId)).get()?.n ?? 0;
        if (total >= MY_LIST_MAX) return false;
        tx.insert(profileMyList)
          .values({ profileId: who.profileId, itemKey: req.params.key, addedAt: new Date(now()).toISOString() })
          .onConflictDoNothing()
          .run();
        return true;
      });
      if (!added) return reply.code(409).send({ error: 'limit-reached', code: 'LIMIT_REACHED' });
      return reply.code(204).send(null);
    });

    app.delete('/playback/my-list/:key', { ...opts, schema: { params: KeyParams, response: { 204: z.null(), ...errors } } }, async (req, reply) => {
      const who = profileOf(req, reply);
      if (!who) return reply;
      db.delete(profileMyList)
        .where(and(eq(profileMyList.profileId, who.profileId), eq(profileMyList.itemKey, req.params.key)))
        .run();
      return reply.code(204).send(null);
    });
  };
}
