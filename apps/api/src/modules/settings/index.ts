import type { AppModule } from '../../app.js';
import { settingsRoutes } from './routes.js';

export * as settingsService from './service.js';
export { SettingsError, type SettingsSection, type SectionValue } from './service.js';

// General, user-editable settings stored in the `settings` table, one section per row.
export const settingsModule: AppModule = (ctx) => async (app) => {
  await app.register(settingsRoutes(ctx.db));
};
