import { z } from 'zod';
import {
  CollectionItem,
  CollectionPreview,
  CollectionsSettings,
  CollectionSyncResult,
  CollectionSyncState,
  ErrorResponse,
  JELLYFIN_USER_HEADER,
  LeavingSoon,
  SmartCollection,
  SmartCollectionInput,
} from '@arclight/shared';
import type { FastifyPluginAsync, RawServerDefault } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import type { Db } from '../../db/index.js';
import { PluginError, type PluginUser } from '../jellyfin-plugin/index.js';
import { setSection, SettingsError } from '../settings/service.js';
import { CollectionsError, type CollectionsService } from './service.js';

const IdParams = z.object({ id: z.coerce.number().int().positive() });
const LimitQuery = z.object({ limit: z.coerce.number().int().min(1).max(1000).default(200) });
const SyncOverview = z.object({ servers: z.array(z.object({ id: z.string(), name: z.string() })), states: z.array(CollectionSyncState.extend({ collectionKey: z.string() })) });
const PluginLeavingSoon = z.object({ name: z.string(), days: z.number().int(), items: z.array(CollectionItem) });
const errors = { 400: ErrorResponse, 403: ErrorResponse, 404: ErrorResponse };

export interface CollectionsRouteDeps {
  db: Db;
  service: CollectionsService;
  /** Runs a sync now (the job's handler, so it shares its lock). */
  syncNow: () => Promise<CollectionSyncResult>;
  pluginUser: (header: string | undefined) => Promise<PluginUser>;
}

export function collectionsRoutes(deps: CollectionsRouteDeps): FastifyPluginAsync<Record<never, never>, RawServerDefault, ZodTypeProvider> {
  const { db, service } = deps;
  return async (app) => {
    app.setErrorHandler((err, req, reply) => {
      if (err instanceof CollectionsError) return reply.code(err.code === 'NOT_FOUND' ? 404 : 400).send({ error: err.message, code: err.code });
      if (err instanceof PluginError) return reply.code(err.status).send({ error: err.message, code: err.code });
      if (err instanceof SettingsError) return reply.code(400).send({ error: err.message, code: err.code });
      if (err instanceof z.ZodError) return reply.code(400).send({ error: z.prettifyError(err), code: 'VALIDATION' });
      if (err instanceof Error && 'validation' in err && err.validation) return reply.code(400).send({ error: err.message, code: 'VALIDATION' });
      req.log.error({ err }, 'unhandled collections error');
      return reply.code(500).send({ error: 'internal error' });
    });

    // ------------------------------------------------------------ admin

    app.get('/collections/smart', { schema: { response: { 200: z.array(SmartCollection) } } }, async () => service.list());
    app.post('/collections/smart', { schema: { body: SmartCollectionInput, response: { 201: SmartCollection, ...errors } } }, async (req, reply) =>
      reply.code(201).send(service.create(req.body)),
    );
    app.post('/collections/smart/preview', { schema: { body: SmartCollectionInput, querystring: LimitQuery, response: { 200: CollectionPreview, ...errors } } }, async (req) =>
      service.preview(req.body, req.query.limit),
    );
    app.get('/collections/smart/:id', { schema: { params: IdParams, response: { 200: SmartCollection, ...errors } } }, async (req) => service.get(req.params.id));
    app.put('/collections/smart/:id', { schema: { params: IdParams, body: SmartCollectionInput, response: { 200: SmartCollection, ...errors } } }, async (req) =>
      service.update(req.params.id, req.body),
    );
    app.delete('/collections/smart/:id', { schema: { params: IdParams, response: { 204: z.null(), ...errors } } }, async (req, reply) => {
      service.delete(req.params.id);
      return reply.code(204).send(null);
    });
    app.get('/collections/smart/:id/items', { schema: { params: IdParams, querystring: LimitQuery, response: { 200: CollectionPreview, ...errors } } }, async (req) =>
      service.items(req.params.id, req.query.limit),
    );

    app.get('/collections/leavingsoon', { schema: { response: { 200: LeavingSoon } } }, async () => service.leavingSoon());

    app.get('/collections/sync', { schema: { response: { 200: SyncOverview } } }, async () => ({
      servers: service.targetServers().map((s) => ({ id: s.id, name: s.name })),
      states: service.syncStates(),
    }));
    app.post('/collections/sync', { schema: { response: { 200: CollectionSyncResult } } }, async () => deps.syncNow());

    app.get('/settings/collections', { schema: { response: { 200: CollectionsSettings } } }, async () => service.settings());
    app.put('/settings/collections', { schema: { body: CollectionsSettings, response: { 200: CollectionsSettings, ...errors } } }, async (req) => {
      setSection(db, 'collections', req.body);
      return service.settings();
    });

    // ------------------------------------------------------------ Jellyfin plugin

    app.get('/jellyfin/leaving-soon', { schema: { response: { 200: PluginLeavingSoon, ...errors } } }, async (req) => {
      const h = req.headers[JELLYFIN_USER_HEADER];
      await deps.pluginUser(Array.isArray(h) ? h[0] : h);
      const s = service.settings().leavingSoon;
      if (!s.enabled || !s.showInJellyfin) throw new PluginError(403, 'disabled', 'Leaving Soon is turned off in Arclight (Settings > Library > Collections)');
      return { name: s.name, days: s.days, items: service.leavingSoonItems(s.days).map(({ candidate: _c, ...i }) => i) };
    });
  };
}
