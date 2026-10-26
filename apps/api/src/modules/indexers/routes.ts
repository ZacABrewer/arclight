import { z } from 'zod';
import {
  Indexer,
  IndexerCapabilitiesResource,
  IndexerCategory,
  IndexerCreate,
  IndexerDefinitionDetail,
  IndexerDefinitionListQuery,
  IndexerDefinitionReloadResult,
  IndexerDefinitionSummary,
  IndexerDefinitionUpload,
  IndexerGlobalSettings,
  IndexerProxy,
  IndexerProxyCreate,
  IndexerProxyTestRequest,
  IndexerProxyTestResult,
  IndexerProxyUpdate,
  IndexersErrorResponse,
  IndexerStats,
  IndexerStatsQuery,
  IndexerStatus,
  IndexerTemplate,
  IndexerTestAllItem,
  IndexerTestResult,
  IndexerUpdate,
  ManualSearchRequest,
  ReleaseResource,
  SearchGrabRequest,
  SearchGrabResponse,
} from '@arclight/shared';
import { IndexerError } from '@arclight/indexers';
import type { FastifyPluginAsync, RawServerDefault } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { DefinitionStoreError } from './definitions.js';
import { IndexersError, type IndexersErrorCode } from './errors.js';
import type { IndexersService } from './service.js';

const IdParams = z.object({ id: z.coerce.number().int().min(1) });
const DefinitionParams = z.object({ id: z.string().min(1) });
const CapsQuery = z.object({ refresh: z.stringbool().optional() });
const DownloadQuery = z.object({ url: z.string().min(1) });
const ProxyTestBody = z.object({ url: z.string().trim().min(1).optional() }).nullish();
const Empty = z.null();

const errors = {
  400: IndexersErrorResponse,
  404: IndexersErrorResponse,
  409: IndexersErrorResponse,
  502: IndexersErrorResponse,
  503: IndexersErrorResponse,
};

const statusFor: Record<IndexersErrorCode, number> = {
  NOT_FOUND: 404,
  VALIDATION: 400,
  CONFLICT: 409,
  NO_MATCH: 409,
  UNAVAILABLE: 404,
  DOWNLOAD_FAILED: 502,
};

/** Errors thrown by the release pipeline during POST /search/grab (duck-typed: no module import). */
const pipelineStatus: Record<string, number> = {
  NOT_FOUND: 404,
  VALIDATION: 400,
  UNAVAILABLE: 404,
  DOWNLOAD_FAILED: 502,
  CLIENT_UNAVAILABLE: 503,
};

export interface IndexersRoutesOptions {
  /** GET/PUT /settings/indexers; omitted = routes not registered. */
  settings?: {
    get(): IndexerGlobalSettings;
    update(value: IndexerGlobalSettings): IndexerGlobalSettings;
  };
}

export function indexersRoutes(
  service: IndexersService,
  opts: IndexersRoutesOptions = {},
): FastifyPluginAsync<Record<never, never>, RawServerDefault, ZodTypeProvider> {
  return async (app) => {
    // Typed errors map to HTTP here and nowhere else. Indexer protocol errors (caps route) are
    // an upstream problem: 502.
    app.setErrorHandler((err, req, reply) => {
      if (err instanceof IndexersError) {
        return reply.code(statusFor[err.code]).send({ error: err.message, code: err.code });
      }
      if (err instanceof DefinitionStoreError) {
        return reply.code(err.code === 'NOT_FOUND' ? 404 : 400).send({ error: err.message, code: err.code });
      }
      if (err instanceof IndexerError) {
        return reply.code(502).send({ error: err.message, code: err.code });
      }
      if (err instanceof Error && 'validation' in err && err.validation) {
        return reply.code(400).send({ error: err.message, code: 'VALIDATION' });
      }
      const code = err instanceof Error ? (err as { code?: unknown }).code : undefined;
      if (
        err instanceof Error &&
        (err.name === 'ReleasesError' || err.name === 'SettingsError') &&
        typeof code === 'string' &&
        pipelineStatus[code]
      ) {
        return reply.code(pipelineStatus[code]).send({ error: err.message, code });
      }
      req.log.error(err);
      return reply.code(500).send({ error: 'internal error' });
    });

    app.get('/indexer', { schema: { response: { 200: z.array(Indexer) } } }, async () => {
      await service.definitions.ready();
      return service.list();
    });

    app.get('/indexer/schema', { schema: { response: { 200: z.array(IndexerTemplate) } } }, async () =>
      service.templates(),
    );

    app.get('/indexer/categories', { schema: { response: { 200: z.array(IndexerCategory) } } }, async () =>
      service.categories(),
    );

    app.get('/indexer/status', { schema: { response: { 200: z.array(IndexerStatus) } } }, async () =>
      service.statuses(),
    );

    app.get(
      '/indexer/stats',
      { schema: { querystring: IndexerStatsQuery, response: { 200: IndexerStats, ...errors } } },
      async (req) => service.stats.query(req.query.days),
    );

    // ---- definition catalogue -------------------------------------------------------

    app.get(
      '/indexer/definition',
      { schema: { querystring: IndexerDefinitionListQuery, response: { 200: z.array(IndexerDefinitionSummary), ...errors } } },
      async (req) => {
        await service.definitions.ready();
        return service.definitions.list(req.query);
      },
    );

    app.post(
      '/indexer/definition/reload',
      { schema: { response: { 200: IndexerDefinitionReloadResult } } },
      async () => service.definitions.reload(),
    );

    app.get(
      '/indexer/definition/:id',
      { schema: { params: DefinitionParams, response: { 200: IndexerDefinitionDetail, ...errors } } },
      async (req) => {
        await service.definitions.ready();
        return service.definitions.detail(req.params.id);
      },
    );

    app.post(
      '/indexer/definition',
      { schema: { body: IndexerDefinitionUpload, response: { 201: IndexerDefinitionDetail, ...errors } } },
      async (req, reply) => {
        await service.definitions.ready();
        return reply.code(201).send(await service.definitions.upload(req.body.yaml));
      },
    );

    app.delete(
      '/indexer/definition/:id',
      { schema: { params: DefinitionParams, response: { 204: Empty, ...errors } } },
      async (req, reply) => {
        await service.definitions.ready();
        await service.definitions.remove(req.params.id);
        return reply.code(204).send(null);
      },
    );

    // ---- indexers -------------------------------------------------------------------

    app.post(
      '/indexer/test',
      { schema: { body: IndexerCreate, response: { 200: IndexerTestResult, ...errors } } },
      async (req) => service.test(req.body),
    );

    app.post('/indexer/testall', { schema: { response: { 200: z.array(IndexerTestAllItem) } } }, async () =>
      service.testAll(),
    );

    app.get('/indexer/:id', { schema: { params: IdParams, response: { 200: Indexer, ...errors } } }, async (req) => {
      await service.definitions.ready();
      return service.get(req.params.id);
    });

    app.get(
      '/indexer/:id/caps',
      { schema: { params: IdParams, querystring: CapsQuery, response: { 200: IndexerCapabilitiesResource, ...errors } } },
      async (req) => service.getCaps(req.params.id, { refresh: req.query.refresh ?? false }),
    );

    // Streams the release file (torrent / nzb) or redirects to a magnet. No response schema:
    // the body is binary.
    app.get(
      '/indexer/:id/download',
      { schema: { params: IdParams, querystring: DownloadQuery } },
      async (req, reply) => {
        await service.definitions.ready();
        const result = await service.downloadForUser(req.params.id, req.query.url);
        if (result.kind === 'magnet') return reply.redirect(result.magnetUrl, 302);
        return reply
          .header('content-type', result.contentType)
          .header('content-disposition', contentDisposition(result.fileName))
          .header('cache-control', 'no-store')
          .send(Buffer.from(result.data));
      },
    );

    app.post(
      '/indexer',
      { schema: { body: IndexerCreate, response: { 201: Indexer, ...errors } } },
      async (req, reply) => {
        await service.definitions.ready();
        return reply.code(201).send(service.create(req.body));
      },
    );

    app.put(
      '/indexer/:id',
      { schema: { params: IdParams, body: IndexerUpdate, response: { 200: Indexer, ...errors } } },
      async (req) => {
        await service.definitions.ready();
        return service.update(req.params.id, req.body);
      },
    );

    app.delete('/indexer/:id', { schema: { params: IdParams, response: { 204: Empty, ...errors } } }, async (req, reply) => {
      service.delete(req.params.id);
      return reply.code(204).send(null);
    });

    // ---- proxies --------------------------------------------------------------------

    app.get('/indexerproxy', { schema: { response: { 200: z.array(IndexerProxy) } } }, async () => service.proxies.list());

    app.post(
      '/indexerproxy/test',
      { schema: { body: IndexerProxyTestRequest, response: { 200: IndexerProxyTestResult, ...errors } } },
      async (req) => service.proxies.test(req.body),
    );

    app.get('/indexerproxy/:id', { schema: { params: IdParams, response: { 200: IndexerProxy, ...errors } } }, async (req) =>
      service.proxies.get(req.params.id),
    );

    app.post(
      '/indexerproxy',
      { schema: { body: IndexerProxyCreate, response: { 201: IndexerProxy, ...errors } } },
      async (req, reply) => reply.code(201).send(service.proxies.create(req.body)),
    );

    app.put(
      '/indexerproxy/:id',
      { schema: { params: IdParams, body: IndexerProxyUpdate, response: { 200: IndexerProxy, ...errors } } },
      async (req) => service.proxies.update(req.params.id, req.body),
    );

    app.delete(
      '/indexerproxy/:id',
      { schema: { params: IdParams, response: { 204: Empty, ...errors } } },
      async (req, reply) => {
        service.proxies.delete(req.params.id);
        return reply.code(204).send(null);
      },
    );

    app.post(
      '/indexerproxy/:id/test',
      { schema: { params: IdParams, body: ProxyTestBody, response: { 200: IndexerProxyTestResult, ...errors } } },
      async (req) => service.proxies.testSaved(req.params.id, req.body?.url),
    );

    // ---- settings -------------------------------------------------------------------

    const settings = opts.settings;
    if (settings) {
      app.get('/settings/indexers', { schema: { response: { 200: IndexerGlobalSettings } } }, async () => settings.get());
      app.put(
        '/settings/indexers',
        { schema: { body: IndexerGlobalSettings, response: { 200: IndexerGlobalSettings, ...errors } } },
        async (req) => settings.update(req.body),
      );
    }

    // ---- search ---------------------------------------------------------------------

    app.get(
      '/search',
      { schema: { querystring: ManualSearchRequest, response: { 200: z.array(ReleaseResource), ...errors } } },
      async (req) => service.manualSearch(req.query),
    );

    app.post(
      '/search/grab',
      { schema: { body: SearchGrabRequest, response: { 200: SearchGrabResponse, ...errors } } },
      async (req) => service.searchGrab(req.body),
    );
  };
}

/** `attachment` with an ASCII fallback name and the UTF-8 original (RFC 6266). */
function contentDisposition(fileName: string): string {
  const ascii = fileName.replace(/[^\x20-\x7e]+/g, '_').replace(/["\\]/g, '_');
  return `attachment; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(fileName)}`;
}
