import type { AppModule } from '../../app.js';
import { profilesRoutes } from './routes.js';
import { getSection } from '../settings/service.js';
import { ProfilesService } from './service.js';

export { ProfilesService, ProfileError, qualityProfileDomainMismatch } from './service.js';
export type { ProfileChange } from './routes.js';
export * from './schema.js';

export const profilesModule: AppModule = (ctx) => async (app) => {
  const service = new ProfilesService({
    db: ctx.db,
    log: ctx.log.child({ module: 'profiles' }),
    // The library module owns the "is this profile referenced" answer; until it is wired
    // through the context, nothing is considered in use.
  });
  service.seedDefaults();
  const features = getSection(ctx.db, 'features');
  if (features.music) service.seedMusicDefaults();
  if (features.audiobooks) service.seedAudiobookDefaults();
  await app.register(profilesRoutes(service, (change) => ctx.bus.publish({ type: 'profile', ...change })));
};
