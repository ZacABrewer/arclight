import type { AppModule } from '../../app.js';
import { runHouseholdBackfill } from './backfill.js';
import { householdRoutes } from './routes.js';
import { householdsFor } from './service.js';

export { householdProfiles, profileMyList, profilePlaybackQueue, type HouseholdProfileRow } from './schema.js';
export { ownerProfileOf, ensureOwnerProfiles, backfillProfileIds, runHouseholdBackfill } from './backfill.js';
export { HouseholdService, HouseholdError, householdsFor, type RequestProfile } from './service.js';

// Household profiles ("Who's watching?", spec §2): owner profiles and the profile_id backfill
// at startup, the /households and /users/:userId/profiles routes. The auth service attaches the
// active profile to every request (auth/service.ts withProfile) and the hook confines non-owner
// profiles to the player (auth/hook.ts PROFILE_ROUTES).

export const householdsModule: AppModule = (ctx) => async (app) => {
  const result = runHouseholdBackfill(ctx.db);
  if (result.profiles > 0 || result.rows > 0 || result.queues > 0) {
    ctx.log.info(result, 'household profiles backfilled');
  }
  await app.register(householdRoutes(householdsFor(ctx.db), ctx.db));
};
