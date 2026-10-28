import { join } from 'node:path';
import type { ThemeSettings } from '@arclight/shared';
import type { AppContext, AppModule } from '../../app.js';
import { feedsRegistry, hourlyCron } from '../../feeds.js';
import type { Scheduler } from '../../scheduler.js';
import { themesRoutes } from './routes.js';
import { ThemesService, type ThemesServiceOptions } from './service.js';
import { bundledThemesDir } from './store.js';

export { ThemesService, type ThemesServiceOptions } from './service.js';
export { bundledThemesDir, mergePacks, readPack, readPacks, ThemePackError } from './store.js';

// Theme packs: the catalogue and pack files every client loads, and the sync that brings new and
// updated packs from the repository's themes/ folder.

export const THEMES_SYNC_JOB = 'ThemesSync';

/** The boot-time sync waits for the VPN and the rest of the start-up work. */
const BOOT_SYNC_DELAY_MS = 90_000;

const services = new WeakMap<AppContext, ThemesService>();

export function themesServiceFor(ctx: AppContext, overrides: Partial<ThemesServiceOptions> = {}): ThemesService {
  let service = services.get(ctx);
  if (!service) {
    service = new ThemesService({
      db: ctx.db,
      log: ctx.log.child({ module: 'themes' }),
      bundledDir: bundledThemesDir(),
      syncedDir: join(ctx.config.configDir, 'themes'),
      ...overrides,
    });
    services.set(ctx, service);
  }
  return service;
}

/** Cron for the pack sync (minute 41, off the hour), null when disabled. */
export function themesCronFor(settings: Pick<ThemeSettings, 'syncEnabled' | 'syncIntervalHours'>): string | null {
  return settings.syncEnabled ? hourlyCron(settings.syncIntervalHours, 41) : null;
}

function reschedule(scheduler: Scheduler, settings: ThemeSettings): void {
  if (scheduler.has(THEMES_SYNC_JOB)) scheduler.update(THEMES_SYNC_JOB, themesCronFor(settings));
}

export const themesModule: AppModule = (ctx) => async (app) => {
  const service = themesServiceFor(ctx);
  await app.register(themesRoutes(service, { onSettingsChanged: (s) => reschedule(ctx.scheduler, s) }));
  const cron = themesCronFor(service.settings());
  ctx.scheduler.register({
    name: THEMES_SYNC_JOB,
    ...(cron ? { cron } : {}),
    handler: async ({ signal }) => {
      const r = await service.sync({ signal });
      if (!r.ok) throw new Error(r.error ?? 'theme sync failed');
      return r.changed.length > 0 ? `installed ${r.changed.join(', ')}` : 'up to date';
    },
  });
  const unregister = feedsRegistry(ctx).register({
    id: 'themes',
    name: 'Theme packs',
    status: () => {
      const s = service.settings();
      const st = service.syncState();
      return {
        enabled: s.syncEnabled,
        intervalMs: s.syncIntervalHours * 3_600_000,
        lastSyncAt: st.lastSyncAt,
        lastSuccessAt: st.lastError ? null : st.lastSyncAt,
        lastError: st.lastError,
        detail: `${service.themes().length} theme(s)`,
      };
    },
  });
  // A first sync shortly after start when the last one is older than the interval (or never ran).
  let boot: NodeJS.Timeout | null = null;
  app.addHook('onReady', async () => {
    const s = service.settings();
    const last = Date.parse(service.syncState().lastSyncAt ?? '');
    if (!s.syncEnabled || (Number.isFinite(last) && Date.now() - last < s.syncIntervalHours * 3_600_000)) return;
    boot = setTimeout(() => void service.sync(), BOOT_SYNC_DELAY_MS);
    boot.unref();
  });
  app.addHook('onClose', async () => {
    if (boot) clearTimeout(boot);
    unregister();
  });
};
