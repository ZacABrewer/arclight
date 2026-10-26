import type { AppModule } from '../../app.js';
import { profilesRoutes } from './routes.js';
import { ProfilesService } from './service.js';

export { ProfilesService, ProfileError } from './service.js';
export * from './schema.js';

export const profilesModule: AppModule = (ctx) => async (app) => {
  const service = new ProfilesService({
    db: ctx.db,
    log: ctx.log.child({ module: 'profiles' }),
    // The library module owns the "is this profile referenced" answer; until it is wired
    // through the context, nothing is considered in use.
  });
  service.seedDefaults();
  await app.register(profilesRoutes(service));
};
