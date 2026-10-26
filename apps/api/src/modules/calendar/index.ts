import type { AppModule } from '../../app.js';
import { calendarRoutes } from './routes.js';
import { CalendarService } from './service.js';

export { CalendarService, CalendarError, ICS_TOKEN_KEY, resolveRange } from './service.js';
export { renderIcs, escapeText, foldLine } from './ics.js';

// The calendar owns no tables: it reads the library tables and keeps its feed token in the
// `settings` table under `calendar.icsToken`.
export const calendarModule: AppModule = (ctx) => async (app) => {
  await app.register(calendarRoutes(new CalendarService(ctx.db)));
};
