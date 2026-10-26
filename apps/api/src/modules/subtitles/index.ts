import type { AppContext, AppModule } from '../../app.js';
import { EventTranslator, notificationsServiceFor } from '../notifications/index.js';
import { registerSubtitleJobs } from './jobs.js';
import { subtitlesRoutes } from './routes.js';
import { SubtitlesService, type SubtitlesServiceOptions } from './service.js';

export { SubtitlesService, SubtitlesError, type FileContext, type SubtitlesServiceOptions } from './service.js';
export { SUBTITLE_JOBS } from './jobs.js';
export { execFileRunner, type ProcessRunner, type RunResult } from './runner.js';
export * from './schema.js';

// One service per app context (wiring and the routes share it).
const services = new WeakMap<AppContext, SubtitlesService>();

export function subtitlesServiceFor(ctx: AppContext, overrides: Partial<SubtitlesServiceOptions> = {}): SubtitlesService {
  let service = services.get(ctx);
  if (!service) {
    const translator = new EventTranslator({ db: ctx.db, log: ctx.log.child({ module: 'notifications' }) });
    service = new SubtitlesService({
      db: ctx.db,
      bus: ctx.bus,
      log: ctx.log.child({ module: 'subtitles' }),
      notify: async (event) => {
        await notificationsServiceFor(ctx).dispatch(event);
      },
      describeMedia: (mediaType, id) => translator.media(mediaType, id),
      ...overrides,
    });
    services.set(ctx, service);
  }
  return service;
}

/** Profiles, wanted, history, blacklist, providers, manual search/upload, sync and jobs. */
export const subtitlesModule: AppModule = (ctx) => async (app) => {
  const service = subtitlesServiceFor(ctx);
  await app.register(subtitlesRoutes(service));
  registerSubtitleJobs(ctx.scheduler, service);
  // Media files that disappear take their subtitle rows with them.
  const unsubscribe = ctx.bus.subscribe((event) => {
    if (event.type === 'library' && (event.action === 'deleted' || event.action === 'fileDeleted')) service.pruneOrphans();
  });
  app.addHook('onClose', async () => {
    unsubscribe();
    await service.idle();
  });
};
