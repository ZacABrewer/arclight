import type { FastifyPluginAsync } from 'fastify';
import { CompatSettings, SettingsErrorResponse } from '@arclight/shared';
import type { AppContext, AppModule } from '../../app.js';
import { authServiceFor, installAuthHook } from '../auth/index.js';
import { getSection, setSection, SettingsError } from '../settings/service.js';
import { CommandRunner } from './commands.js';
import { createCommandResolver } from './dispatch.js';
import { compatErrorHandler } from './errors.js';
import { defaultCompatMetadata, type CompatMetadata } from './lookup.js';
import { radarrRoutes } from './routes-radarr.js';
import { sharedRoutes } from './routes-shared.js';
import { sonarrRoutes } from './routes-sonarr.js';
import { probeRoutes, systemRoutes } from './routes-system.js';
import { createServices } from './services.js';

// Compatibility API: Sonarr-v3 and Radarr-v3 shaped endpoints so third-party tools (Overseerr,
// Jellyseerr, Bazarr, Prowlarr, Notifiarr, Homarr, Recyclarr, LunaSea, nzb360 ...) can talk to
// Arclight as if it were Sonarr or Radarr. Both shapes share /api/v3, split by resource:
// series/episode/episodefile/calendar/wanted are Sonarr-shaped, movie/moviefile/collection are
// Radarr-shaped, everything else is Sonarr-shaped with harmless Radarr-only fields added.
//
// Two registrations (app.ts):
//   app.register(compatApi(ctx))            at the ROOT (it owns /api, /ping, /initialize.json
//                                           and /api/v3; it installs the auth hook on its own
//                                           encapsulated scope, so it must not sit inside the
//                                           /api/v1 plugin)
//   compatModule in the /api/v1 module list  GET/PUT /api/v1/settings/compat

export const COMPAT_PREFIX = '/api/v3';

/** Compat routes that answer without credentials (matched on the route pattern). */
export const COMPAT_PUBLIC_ROUTES: ReadonlySet<string> = new Set(['/api', '/ping', '/initialize.json', '/initialize.js']);

export function isCompatPublicRoute(routeUrl: string | undefined): boolean {
  return routeUrl !== undefined && COMPAT_PUBLIC_ROUTES.has(routeUrl);
}

export interface CompatApiOptions {
  /** Metadata source for lookups and adds; defaults to TMDB through the metadata settings. */
  metadata?: CompatMetadata;
}

/** The root-level plugin serving the compatibility API. */
export function compatApi(ctx: AppContext, opts: CompatApiOptions = {}): FastifyPluginAsync {
  return async (app) => {
    // Disabled: every compat route answers 404, before authentication.
    app.addHook('onRequest', async (_req, reply) => {
      if (!getSection(ctx.db, 'compat').enabled) return reply.code(404).send({ message: 'NotFound' });
    });
    // Same credentials as /api/v1: session cookie, Basic, X-Api-Key / ?apikey=, local bypass.
    const auth = authServiceFor(ctx);
    auth.ensureApiKey();
    // Before an admin exists only the ping answers (like /api/v1/system/ping).
    installAuthHook(app, auth, { isPublic: isCompatPublicRoute, setupBootstrap: (url) => url === '/ping' });
    // Prowlarr gates application sync on this header.
    app.addHook('onSend', async (_req, reply, payload) => {
      reply.header('X-Application-Version', getSection(ctx.db, 'compat').advertisedVersion);
      return payload;
    });
    app.setErrorHandler(compatErrorHandler);

    const metadata = opts.metadata ?? defaultCompatMetadata(ctx);
    const runner = new CommandRunner(ctx, createCommandResolver(ctx, metadata));
    const services = createServices(ctx, metadata, runner);

    probeRoutes(app, services);
    await app.register(
      async (v3) => {
        sonarrRoutes(v3, services);
        radarrRoutes(v3, services);
        sharedRoutes(v3, services);
        systemRoutes(v3, services);
      },
      { prefix: COMPAT_PREFIX },
    );
  };
}

/** /api/v1/settings/compat (enable toggle, instance name, advertised version). */
export const compatModule: AppModule = (ctx) => async (app) => {
  app.setErrorHandler((err, req, reply) => {
    if (err instanceof SettingsError) return reply.code(400).send({ error: err.message, code: err.code });
    if (err instanceof Error && 'validation' in err && err.validation) {
      return reply.code(400).send({ error: err.message, code: 'VALIDATION' });
    }
    req.log.error({ err }, 'unhandled compat settings error');
    return reply.code(500).send({ error: 'internal error' });
  });

  app.get('/settings/compat', { schema: { response: { 200: CompatSettings } } }, async () => getSection(ctx.db, 'compat'));

  app.put(
    '/settings/compat',
    { schema: { body: CompatSettings, response: { 200: CompatSettings, 400: SettingsErrorResponse } } },
    async (req) => {
      const saved = setSection(ctx.db, 'compat', req.body);
      ctx.bus.publish({ type: 'settings', section: 'compat' });
      return saved;
    },
  );
};

export { CommandRunner } from './commands.js';
export type { CompatMetadata } from './lookup.js';
