import type { AppContext, AppModule } from '../../app.js';
import { releasesServiceFor } from '../releases/index.js';
import { subtitlesServiceFor } from '../subtitles/index.js';
import { additionalLanguagesRoutes } from './routes.js';
import { AdditionalLanguagesService, type AdditionalLanguagesOptions } from './service.js';

export {
  AdditionalLanguagesService,
  AdditionalLanguagesError,
  ADDITIONAL_LANGUAGE_JOB,
  type AdditionalLanguagesOptions,
  type ReleasesPort,
  type SubtitlesPort,
} from './service.js';
export * from './audio.js';
export * from './schema.js';

// "Add additional…": additional audio / subtitle languages on library items. Registered after
// releases and subtitles; it drives both through their services and the scheduler.

const services = new WeakMap<AppContext, AdditionalLanguagesService>();

export function additionalLanguagesServiceFor(ctx: AppContext, overrides: Partial<AdditionalLanguagesOptions> = {}): AdditionalLanguagesService {
  let service = services.get(ctx);
  if (!service) {
    service = new AdditionalLanguagesService({
      db: ctx.db,
      bus: ctx.bus,
      log: ctx.log.child({ module: 'additional-languages' }),
      scheduler: ctx.scheduler,
      subtitles: () => subtitlesServiceFor(ctx),
      releases: () => releasesServiceFor(ctx),
      ...overrides,
    });
    services.set(ctx, service);
  }
  return service;
}

export const additionalLanguagesModule: AppModule = (ctx) => async (app) => {
  const service = additionalLanguagesServiceFor(ctx);
  await app.register(additionalLanguagesRoutes(service));
  const unsubscribe = ctx.bus.subscribe((event) => {
    if (event.type === 'library' && event.action === 'deleted') service.pruneItem(event.mediaType, event.id);
  });
  app.addHook('onClose', async () => unsubscribe());
};
