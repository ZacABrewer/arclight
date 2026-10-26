import type { FastifyInstance } from 'fastify';
import { MetricsSettings, SettingsErrorResponse } from '@arclight/shared';
import type { AppContext, AppModule } from '../../app.js';
import { authServiceFor } from '../auth/context.js';
import { installAuthHook } from '../auth/hook.js';
import { getDownloadClientsService } from '../download-clients/index.js';
import { getSection, setSection } from '../settings/service.js';
import { subtitlesServiceFor } from '../subtitles/index.js';
import { torrentServiceFor } from '../torrent/index.js';
import { vpnServiceFor } from '../vpn/service.js';
import { MetricsService, type MetricsServiceOptions, type MetricsSources } from './service.js';

export { MetricsService, routeLabel, type MetricsSources, type MetricsServiceOptions } from './service.js';
export { Registry, Counter, Gauge, Histogram, DEFAULT_BUCKETS, formatValue } from './registry.js';

export const METRICS_PATH = '/metrics';

/** Live sources from the per-context services (resolved at scrape time, never at boot). */
export function defaultMetricsSources(ctx: AppContext): MetricsSources {
  return {
    torrent: () => {
      const t = torrentServiceFor(ctx);
      if (!t.session) return null;
      const s = t.status();
      return { state: s.state, downloadRate: s.downloadRate, uploadRate: s.uploadRate, peers: s.peers };
    },
    vpn: () => {
      const s = vpnServiceFor(ctx).getStatus();
      return { enabled: s.enabled, connected: s.connected };
    },
    subtitlesWanted: () => {
      const subtitles = subtitlesServiceFor(ctx);
      return (['series', 'movie'] as const).reduce((n, mediaType) => n + subtitles.wanted({ mediaType, page: 1, pageSize: 1 }).totalRecords, 0);
    },
    clientStatuses: () => getDownloadClientsService(ctx).clientStatuses(),
  };
}

const services = new WeakMap<AppContext, MetricsService>();

export function metricsServiceFor(ctx: AppContext, overrides: Partial<Omit<MetricsServiceOptions, 'db'>> = {}): MetricsService {
  let service = services.get(ctx);
  if (!service) {
    service = new MetricsService({
      db: ctx.db,
      bus: ctx.bus,
      log: ctx.log.child({ module: 'metrics' }),
      sources: defaultMetricsSources(ctx),
      ...overrides,
    });
    services.set(ctx, service);
  }
  return service;
}

/**
 * Call on the ROOT Fastify instance, before any other plugin is registered, so the request
 * hooks see every route (/api/v1, /api/v3, the web app). Serves GET /metrics (Prometheus text
 * format) at the root with the same credentials as the API (X-Api-Key, ?apikey=, Basic,
 * session cookie); `metrics.allowAnonymous` turns the credential check off.
 */
export async function installMetrics(
  app: FastifyInstance,
  ctx: AppContext,
  overrides: Partial<Omit<MetricsServiceOptions, 'db'>> = {},
): Promise<MetricsService> {
  const service = metricsServiceFor(ctx, overrides);
  app.addHook('onRequest', service.onRequest);
  app.addHook('onResponse', service.onResponse);
  await app.register(async (scope) => {
    installAuthHook(scope, authServiceFor(ctx), () => getSection(ctx.db, 'metrics').allowAnonymous);
    scope.get(METRICS_PATH, async (_req, reply) => {
      reply.header('cache-control', 'no-store');
      return reply.type('text/plain; version=0.0.4; charset=utf-8').send(await service.render());
    });
  });
  service.start();
  app.addHook('onClose', async () => service.stop());
  return service;
}

/** GET/PUT /settings/metrics under /api/v1 (the scrape endpoint itself is installMetrics). */
export const metricsModule: AppModule = (ctx) => async (app) => {
  app.get('/settings/metrics', { schema: { response: { 200: MetricsSettings } } }, async () => getSection(ctx.db, 'metrics'));
  app.put(
    '/settings/metrics',
    { schema: { body: MetricsSettings, response: { 200: MetricsSettings, 400: SettingsErrorResponse } } },
    async (req) => {
      setSection(ctx.db, 'metrics', req.body);
      ctx.bus.publish({ type: 'settings', section: 'metrics' });
      return getSection(ctx.db, 'metrics');
    },
  );
};
