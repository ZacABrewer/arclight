import type { AppContext, AppModule } from '../../app.js';
import type { IcsDayEvent } from './ics.js';
import { calendarRoutes, type IcsEventSource } from './routes.js';
import { CalendarService } from './service.js';

export { CalendarService, CalendarError, ICS_TOKEN_KEY, resolveRange } from './service.js';
export { renderIcs, escapeText, foldLine, type IcsDayEvent } from './ics.js';
export type { IcsEventSource } from './routes.js';

// Other modules (books) add feed events per context; read on every feed request, so module
// order does not matter.
const icsSources = new WeakMap<AppContext, IcsEventSource[]>();

export function registerIcsEventSource(ctx: AppContext, source: IcsEventSource): void {
  icsSources.set(ctx, [...(icsSources.get(ctx) ?? []), source]);
}

// The calendar owns no tables: it reads the library tables and keeps its feed token in the
// `settings` table under `calendar.icsToken`.
export const calendarModule: AppModule = (ctx) => async (app) => {
  const extra = (range: Parameters<IcsEventSource>[0]): IcsDayEvent[] => (icsSources.get(ctx) ?? []).flatMap((source) => source(range));
  await app.register(calendarRoutes(new CalendarService(ctx.db), undefined, extra));
};
