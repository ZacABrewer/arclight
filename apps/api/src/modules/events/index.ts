import type { AppModule } from '../../app.js';
import { dbEventOwners, eventViewerOf, eventVisibleTo } from './filter.js';

export { eventVisibleTo, eventViewerOf, dbEventOwners, type EventViewer, type EventOwners } from './filter.js';

// Live feed. Each socket gets a hello, then every bus event the caller may see until it closes.
// Signed-in non-admins may connect (portal access); filter.ts decides what they receive.
export const eventsModule: AppModule = (ctx) => async (app) => {
  const owners = dbEventOwners(ctx.db);
  app.get('/events', { websocket: true, config: { access: { portal: true } } }, (socket, req) => {
    // The auth hook ran before the upgrade; a missing auth here would be a wiring bug: fail closed.
    if (!req.auth) {
      socket.close(1008, 'authentication required');
      return;
    }
    const viewer = eventViewerOf(req.auth);
    socket.send(JSON.stringify({ type: 'hello', serverTime: new Date().toISOString() }));
    const unsubscribe = ctx.bus.subscribe((event) => {
      if (socket.readyState !== socket.OPEN) return;
      if (!eventVisibleTo(event, viewer, owners)) return;
      socket.send(JSON.stringify(event));
    });
    socket.on('close', unsubscribe);
    socket.on('error', unsubscribe);
  });
};
