import type { AppModule } from '../../app.js';

// Live feed. Each socket gets a hello, then every bus event until it closes.
export const eventsModule: AppModule = (ctx) => async (app) => {
  app.get('/events', { websocket: true }, (socket) => {
    socket.send(JSON.stringify({ type: 'hello', serverTime: new Date().toISOString() }));
    const unsubscribe = ctx.bus.subscribe((event) => {
      if (socket.readyState === socket.OPEN) socket.send(JSON.stringify(event));
    });
    socket.on('close', unsubscribe);
    socket.on('error', unsubscribe);
  });
};
