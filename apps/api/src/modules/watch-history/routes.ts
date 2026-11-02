import { z } from 'zod';
import {
  MediaServerAccountRow,
  MediaServerSyncStatus,
  NowPlayingEntry,
  UserSyncServerResult,
  WatchedByEntry,
  WatchEventPage,
  WatchHistoryErrorResponse,
  WatchHistoryQuery,
  WatchHistorySettings,
  WatchSyncServerResult,
  WatchTitleParams,
  type Job,
} from '@arclight/shared';
import type { FastifyPluginAsync, RawServerDefault } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import type { AppContext } from '../../app.js';
import type { MediaServersService } from '../media-servers/index.js';
import { getSection, setSection } from '../settings/service.js';
import type { WatchHistory } from './index.js';
import { WATCH_SYNC_JOB, USER_SYNC_JOB, watchSyncCron } from './jobs.js';

const IdParams = z.object({ id: z.string().min(1) });
const SyncBody = z.object({ full: z.boolean().default(false) }).nullish();
const errors = { 400: WatchHistoryErrorResponse, 404: WatchHistoryErrorResponse, 409: WatchHistoryErrorResponse };
/** GET /watchhistory is open to every signed-in user; the query scopes non-admins to their own history. */
const portal = { access: { portal: true } } as const;

export function watchHistoryRoutes(ctx: AppContext, wh: WatchHistory, servers: MediaServersService): FastifyPluginAsync<Record<never, never>, RawServerDefault, ZodTypeProvider> {
  const requireServer = (id: string) => servers.stored().find((s) => s.id === id);
  /** Runs `handler` as a job sharing the scheduled job's one-at-a-time key; null when one is already running. */
  const asJob = async <T>(name: string, handler: () => Promise<T>): Promise<T | null> => {
    let out: T | null = null;
    const { done } = ctx.scheduler.runTask(
      name,
      'manual',
      async () => {
        out = await handler();
        return 'done';
      },
      { key: name },
    );
    const job: Job = await done;
    if (job.status === 'cancelled') return null;
    return out;
  };

  return async (app) => {
    app.get('/watchhistory', { config: portal, schema: { querystring: WatchHistoryQuery, response: { 200: WatchEventPage, ...errors } } }, async (req) => {
      const auth = req.auth!;
      return wh.queries.events(req.query, { isAdmin: auth.isAdmin, userId: auth.user?.id ?? null });
    });

    app.get('/watchhistory/title/:mediaType/:id', { schema: { params: WatchTitleParams, response: { 200: z.array(WatchedByEntry), ...errors } } }, async (req) =>
      wh.queries.watchedBy(req.params.mediaType, req.params.id),
    );

    app.get('/watchhistory/nowplaying', { schema: { response: { 200: z.array(NowPlayingEntry) } } }, async () => wh.queries.nowPlaying());

    app.get('/settings/watchhistory', { schema: { response: { 200: WatchHistorySettings } } }, async () => getSection(ctx.db, 'watchHistory'));

    app.put('/settings/watchhistory', { schema: { body: WatchHistorySettings, response: { 200: WatchHistorySettings, ...errors } } }, async (req) => {
      const before = getSection(ctx.db, 'watchHistory');
      const saved = setSection(ctx.db, 'watchHistory', req.body);
      if (saved.syncIntervalMinutes !== before.syncIntervalMinutes && ctx.scheduler.has(WATCH_SYNC_JOB)) {
        ctx.scheduler.update(WATCH_SYNC_JOB, watchSyncCron(saved.syncIntervalMinutes));
      }
      return saved;
    });

    app.get('/mediaserver/:id/sync', { schema: { params: IdParams, response: { 200: MediaServerSyncStatus, ...errors } } }, async (req, reply) => {
      const config = requireServer(req.params.id);
      if (!config) return reply.code(404).send({ error: `Media server ${req.params.id} not found`, code: 'NOT_FOUND' });
      return wh.queries.syncStatus(config);
    });

    app.post('/mediaserver/:id/sync', { schema: { params: IdParams, body: SyncBody, response: { 200: WatchSyncServerResult, ...errors } } }, async (req, reply) => {
      const config = requireServer(req.params.id);
      if (!config) return reply.code(404).send({ error: `Media server ${req.params.id} not found`, code: 'NOT_FOUND' });
      if (!servers.watchSyncServers().some((s) => s.id === config.id)) {
        return reply.code(400).send({ error: 'watch-history sync is off for this server (or it is not an enabled Jellyfin/Emby server)', code: 'VALIDATION' });
      }
      const result = await asJob(WATCH_SYNC_JOB, () => wh.sync.syncWatch({ serverId: config.id, full: req.body?.full ?? false }));
      if (!result) return reply.code(409).send({ error: 'a watch-history sync is already running', code: 'CONFLICT' });
      return result.servers[0]!;
    });

    app.post('/mediaserver/:id/usersync', { schema: { params: IdParams, response: { 200: UserSyncServerResult, ...errors } } }, async (req, reply) => {
      const config = requireServer(req.params.id);
      if (!config) return reply.code(404).send({ error: `Media server ${req.params.id} not found`, code: 'NOT_FOUND' });
      const result = await asJob(USER_SYNC_JOB, () => wh.sync.syncUsers({ serverId: config.id }));
      if (!result) return reply.code(409).send({ error: 'a user sync is already running', code: 'CONFLICT' });
      const own = result.servers[0];
      if (!own) return reply.code(400).send({ error: 'user sync reads enabled Jellyfin/Emby servers only', code: 'VALIDATION' });
      return own;
    });

    app.get('/mediaserver/:id/accounts', { schema: { params: IdParams, response: { 200: z.array(MediaServerAccountRow), ...errors } } }, async (req, reply) => {
      if (!requireServer(req.params.id)) return reply.code(404).send({ error: `Media server ${req.params.id} not found`, code: 'NOT_FOUND' });
      return wh.queries.accounts(req.params.id);
    });
  };
}
