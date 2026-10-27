import type { AppContext, AppModule } from '../../app.js';
import { getDownloadClientsService } from '../download-clients/index.js';
import { vpnServiceFor } from '../vpn/service.js';
import { registerTorrentJobs } from './jobs.js';
import { torrentRoutes } from './routes.js';
import { importedInDb, libraryPathsInDb } from './seeding-rules.js';
import { engineInsightsFor, TorrentService, type TorrentServiceOptions } from './service.js';

export {
  engineInsightsFor,
  TorrentService,
  TorrentModuleError,
  LOCKDOWN_ADDRESS,
  type TorrentClientRegistry,
  type TorrentModuleErrorCode,
  type TorrentServiceOptions,
  type TorrentVpnPort,
} from './service.js';
export { APPLY_SEEDING_RULES_JOB } from './jobs.js';

// The built-in torrent engine. Owns the single Session (started on boot when `torrent.enabled`
// and `config.torrentEngine`), the `torrent` settings section, /torrent/* routes and the VPN
// binding policy (see service.ts). `builtin` download clients reach the Session through the
// download-clients service, which this module hands a getter.

const services = new WeakMap<AppContext, TorrentService>();

/** `overrides` apply only when this call creates the instance (tests inject fakes). */
export function torrentServiceFor(
  ctx: AppContext,
  overrides: Partial<Omit<TorrentServiceOptions, 'db' | 'configDir' | 'isDocker'>> = {},
): TorrentService {
  let service = services.get(ctx);
  if (!service) {
    const created = new TorrentService({
      db: ctx.db,
      configDir: ctx.config.configDir,
      isDocker: ctx.config.isDocker,
      bus: ctx.bus,
      log: ctx.log.child({ module: 'torrent' }),
      // Resolved lazily so module registration order does not matter.
      vpn: {
        enabled: () => vpnServiceFor(ctx).settings().enabled,
        getStatus: () => vpnServiceFor(ctx).getStatus(),
        getTunnelAddress: () => vpnServiceFor(ctx).getTunnelAddress(),
      },
      downloadClients: {
        list: () => getDownloadClientsService(ctx).list(),
        create: (input) => getDownloadClientsService(ctx).create(input),
      },
      ...overrides,
    });
    const downloads = getDownloadClientsService(ctx);
    downloads.setTorrentSession(() => created.session);
    // Kill-switch state and live numbers for "why is this download not moving" in the queue.
    downloads.setEngineInsights(engineInsightsFor(created));
    // Seeding rules: import state and library folders from the database, actions on the timeline.
    created.setSeedingPorts({
      imported: (infoHash) => importedInDb(ctx.db, infoHash),
      libraryPaths: () => libraryPathsInDb(ctx.db),
      record: (infoHash, type, message, data) => downloads.recordEngineEvent(infoHash, type, { message, data }),
    });
    services.set(ctx, created);
    service = created;
  }
  return service;
}

export const torrentModule: AppModule = (ctx) => async (app) => {
  const service = torrentServiceFor(ctx);
  await app.register(torrentRoutes(service));
  registerTorrentJobs(ctx.scheduler, service);
  app.addHook('onReady', async () => {
    service.subscribe();
    if (!ctx.config.torrentEngine) {
      ctx.log.info('torrent engine not started at boot: ARCLIGHT_TORRENT_ENGINE=0');
      return;
    }
    // Not awaited: restoring large partial torrents can take longer than Fastify's ready
    // timeout, and a busy port must not keep the api from booting either.
    void service.boot().catch((err: unknown) => ctx.log.error({ err }, 'torrent engine boot failed'));
  });
  app.addHook('onClose', async () => service.shutdown());
};
