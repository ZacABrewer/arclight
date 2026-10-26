import type { AppContext, AppModule } from '../../app.js';
import { getDownloadClientsService } from '../download-clients/index.js';
import { vpnServiceFor } from '../vpn/service.js';
import { torrentRoutes } from './routes.js';
import { TorrentService, type TorrentServiceOptions } from './service.js';

export {
  TorrentService,
  TorrentModuleError,
  LOCKDOWN_ADDRESS,
  type TorrentClientRegistry,
  type TorrentModuleErrorCode,
  type TorrentServiceOptions,
  type TorrentVpnPort,
} from './service.js';

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
    getDownloadClientsService(ctx).setTorrentSession(() => created.session);
    services.set(ctx, created);
    service = created;
  }
  return service;
}

export const torrentModule: AppModule = (ctx) => async (app) => {
  const service = torrentServiceFor(ctx);
  await app.register(torrentRoutes(service));
  app.addHook('onReady', async () => {
    service.subscribe();
    if (!ctx.config.torrentEngine) return;
    // Starting is not awaited past failures: a busy port must not keep the api from booting.
    await service.boot().catch((err: unknown) => ctx.log.error({ err }, 'torrent engine boot failed'));
  });
  app.addHook('onClose', async () => service.shutdown());
};
