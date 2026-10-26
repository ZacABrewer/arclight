import type { AppContext, AppModule } from '../../app.js';
import { getDownloadClientsService } from '../download-clients/index.js';
import { torrentServiceFor } from '../torrent/index.js';
import { vpnServiceFor } from '../vpn/service.js';
import { registerTransferMetricsJobs } from './jobs.js';
import { transferMetricsRoutes } from './routes.js';
import { TransferMetricsService, type TransferMetricsOptions, type TransferSources } from './service.js';

export {
  TransferMetricsService,
  TransferMetricsError,
  DEFAULT_SAMPLE_INTERVAL_MS,
  DEFAULT_MINUTE_RETENTION_DAYS,
  DEFAULT_HOURLY_RETENTION_DAYS,
  type TransferSources,
  type TransferMetricsOptions,
} from './service.js';
export { TRANSFER_METRICS_ROLLUP_JOB, TRANSFER_METRICS_PRUNE_JOB, registerTransferMetricsJobs } from './jobs.js';
export * from './schema.js';

// Transfer history (GET /metrics/downloads/:queueId, /metrics/engine, /metrics/vpn): samples the
// numbers the queue, the torrent engine and the VPN service already keep; no polling of its own.

/** Live sources from the per-context services (resolved per sample, so module order does not matter). */
export function defaultTransferSources(ctx: AppContext): TransferSources {
  return {
    downloads: () =>
      getDownloadClientsService(ctx)
        .listTracked(['downloading'])
        .map((d) => ({ id: d.id, downloadId: d.downloadId, progress: d.progress, live: d.live })),
    engine: () => {
      const torrent = torrentServiceFor(ctx);
      if (!torrent.session) return null;
      const s = torrent.status();
      return { downloadRate: s.downloadRate, uploadRate: s.uploadRate, peers: s.peers, activeTorrents: s.torrents.downloading + s.torrents.seeding };
    },
    vpn: () => vpnServiceFor(ctx).getStatus(),
  };
}

const services = new WeakMap<AppContext, TransferMetricsService>();

export function transferMetricsServiceFor(ctx: AppContext, overrides: Partial<Omit<TransferMetricsOptions, 'db'>> = {}): TransferMetricsService {
  let service = services.get(ctx);
  if (!service) {
    service = new TransferMetricsService({
      db: ctx.db,
      bus: ctx.bus,
      log: ctx.log.child({ module: 'transfer-metrics' }),
      sources: defaultTransferSources(ctx),
      ...overrides,
    });
    services.set(ctx, service);
  }
  return service;
}

export const transferMetricsModuleWith =
  (overrides: Partial<Omit<TransferMetricsOptions, 'db'>> = {}): AppModule =>
  (ctx) =>
  async (app) => {
    const service = transferMetricsServiceFor(ctx, overrides);
    await app.register(transferMetricsRoutes(service));
    registerTransferMetricsJobs(ctx.scheduler, service);
    app.addHook('onReady', async () => service.start());
    app.addHook('onClose', async () => service.stop());
  };

export const transferMetricsModule: AppModule = transferMetricsModuleWith();
