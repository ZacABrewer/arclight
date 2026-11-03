import type { FastifyReply, FastifyRequest } from 'fastify';
import type { AppModule } from '../../app.js';
import { OriginPolicy, parseCorsOrigins } from '../../origin-policy.js';
import { authServiceFor } from '../auth/context.js';
import { credentialsOf } from '../auth/hook.js';
import { dbEventOwners, eventViewerOf, eventVisibleTo, type EventViewer } from './filter.js';

export { eventVisibleTo, eventViewerOf, dbEventOwners, type EventViewer, type EventOwners } from './filter.js';

/** How often an open socket's credentials are checked again (sign-out, revocation, a role change). */
export const EVENTS_RECHECK_MS = 30_000;

export interface EventsModuleOptions {
  recheckMs?: number;
}

// Live feed. Each socket gets a hello, then every bus event the caller may see until it closes.
// Signed-in non-admins may connect (portal access); filter.ts decides what they receive.
//
// The upgrade is refused for browser pages from other origins (Origin checked like CORS
// credentials: origin-policy.ts), since the cookie rides along on same-site pages. While open, the
// socket's credentials are resolved again every EVENTS_RECHECK_MS: a signed-out, revoked or
// deleted credential closes it (1008), and a role or permission change applies to the next event.
export const eventsModuleWith =
  (opts: EventsModuleOptions = {}): AppModule =>
  (ctx) =>
  async (app) => {
    const owners = dbEventOwners(ctx.db);
    const origins = new OriginPolicy(ctx.db, parseCorsOrigins(ctx.config.corsOrigins), { dev: !ctx.config.webDist });
    const recheckMs = opts.recheckMs ?? EVENTS_RECHECK_MS;
    const checkOrigin = async (req: FastifyRequest, reply: FastifyReply) => {
      if (!origins.allowsCredentials(req, req.headers.origin)) {
        return reply.code(403).send({ error: 'this origin may not open the live feed', code: 'FORBIDDEN' });
      }
    };
    app.get('/events', { websocket: true, preValidation: checkOrigin, config: { access: { portal: true } } }, (socket, req) => {
      // The auth hook ran before the upgrade; a missing auth here would be a wiring bug: fail closed.
      if (!req.auth) {
        socket.close(1008, 'authentication required');
        return;
      }
      let viewer: EventViewer = eventViewerOf(req.auth);
      const userId = req.auth.user?.id ?? null;
      const creds = credentialsOf(req);
      const auth = authServiceFor(ctx);
      socket.send(JSON.stringify({ type: 'hello', serverTime: new Date().toISOString() }));
      const unsubscribe = ctx.bus.subscribe((event) => {
        if (socket.readyState !== socket.OPEN) return;
        if (!eventVisibleTo(event, viewer, owners)) return;
        socket.send(JSON.stringify(event));
      });
      let checking = false;
      const timer = setInterval(() => {
        if (checking || socket.readyState !== socket.OPEN) return;
        checking = true;
        auth
          .resolve(creds)
          .then(({ auth: now }) => {
            if (!now || (now.user?.id ?? null) !== userId) socket.close(1008, 'signed out');
            else viewer = eventViewerOf(now);
          })
          // A failure to check (rate limit on Basic, a database error) ends the feed; the web app reconnects.
          .catch(() => socket.close(1008, 'could not check the sign-in'))
          .finally(() => {
            checking = false;
          });
      }, recheckMs);
      timer.unref?.();
      const stop = () => {
        clearInterval(timer);
        unsubscribe();
      };
      socket.on('close', stop);
      socket.on('error', stop);
    });
  };

export const eventsModule: AppModule = eventsModuleWith();
