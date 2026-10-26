import type { AppContext, AppModule } from '../../app.js';
import { getLogRegistry, LOG_FILE_NAME, LogBuffer } from '../../logging.js';
import { requireAdmin } from '../auth/index.js';
import { logsRoutes } from './routes.js';
import { LogsService, type LogsSource } from './service.js';

export { LogsService, LogsError } from './service.js';
export { logsRoutes } from './routes.js';

// Log viewer: GET/DELETE /log (ring buffer), /log/file[/:name] (rotating files), /log/stream
// (WebSocket tail). The buffer and files come from the logger built in src/logging.ts; when
// the app was started with a plain pino logger (tests) an empty buffer stands in.
const fallbacks = new WeakMap<AppContext, LogsSource>();

function sourceFor(ctx: AppContext): LogsSource {
  const reg = getLogRegistry();
  if (reg) return reg;
  let fallback = fallbacks.get(ctx);
  if (!fallback) {
    fallback = { buffer: new LogBuffer(), logDir: ctx.config.logDir, fileName: LOG_FILE_NAME };
    fallbacks.set(ctx, fallback);
  }
  return fallback;
}

export const logsModule: AppModule = (ctx) => async (app) => {
  await app.register(logsRoutes(new LogsService(sourceFor(ctx)), { guard: requireAdmin }));
};
