import type { AppModule } from '../../app.js';
import { searchRoutes } from './routes.js';

export { universalSearch, searchScopeOf, type SearchScope } from './service.js';

// Universal search (GET /search/universal): the topbar's server-side lookups over the library,
// settings entities, tasks, activity, requests and issues, scoped to what the caller may see.

export const searchModule: AppModule = (ctx) => async (app) => {
  await app.register(searchRoutes(ctx.db));
};
