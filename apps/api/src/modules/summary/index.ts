import { createHealthDeps, healthServiceFor, nodeHealthFs } from '../health/index.js';
import { notificationsServiceFor } from '../notifications/index.js';
import { getSection } from '../settings/service.js';
import { rootFolders } from '../../db/schema.js';
import type { AppContext, AppModule } from '../../app.js';
import { summaryRoutes } from './routes.js';
import { SummaryService, summaryCron, type SummaryServiceOptions, type SummaryVolume } from './service.js';

export { SummaryService, summaryCron, SUMMARY_RETENTION_DAYS, type SummaryVolume, type SummaryServiceOptions } from './service.js';
export * from './schema.js';

// Daily summary and the alert settings (quiet hours, summary time). The summary is built by
// the DailySummary job at the configured local time and sent through `onDailySummary`.

export const DAILY_SUMMARY_JOB = 'DailySummary';

const services = new WeakMap<AppContext, SummaryService>();

/** Root folders plus each enabled download client's download folder (local path). */
async function volumesFor(ctx: AppContext): Promise<SummaryVolume[]> {
  const out: SummaryVolume[] = ctx.db
    .select({ path: rootFolders.path })
    .from(rootFolders)
    .all()
    .map((r) => ({ path: r.path, kind: 'rootFolder' as const }));
  const deps = createHealthDeps(ctx);
  for (const client of deps.downloadClients.enabled()) {
    try {
      const status = await deps.downloadClients.status(client.id);
      if (status.outputRootDir) out.push({ path: deps.downloadClients.toLocal(client.host, status.outputRootDir), kind: 'download' });
    } catch (err) {
      ctx.log.debug({ err, client: client.name }, 'daily summary: download folder unknown');
    }
  }
  return out;
}

export function summaryServiceFor(ctx: AppContext, overrides: Partial<SummaryServiceOptions> = {}): SummaryService {
  let service = services.get(ctx);
  if (!service) {
    const notifications = notificationsServiceFor(ctx);
    service = new SummaryService({
      db: ctx.db,
      log: ctx.log.child({ module: 'summary' }),
      bus: ctx.bus,
      volumes: () => volumesFor(ctx),
      freeSpace: (path) => nodeHealthFs.freeSpace(path),
      healthIssues: async () => (await healthServiceFor(ctx).current()).checks.filter((c) => c.status !== 'ok'),
      notify: async (event) => {
        await notifications.dispatch(event);
      },
      quietState: () => ({ heldAlerts: notifications.heldCount(), quietNow: notifications.isQuietNow() }),
      settingsChanged: (s) => {
        if (ctx.scheduler.has(DAILY_SUMMARY_JOB)) ctx.scheduler.update(DAILY_SUMMARY_JOB, summaryCron(s.dailySummary));
      },
      ...overrides,
    });
    services.set(ctx, service);
  }
  return service;
}

export const summaryModuleWith =
  (overrides: Partial<SummaryServiceOptions> = {}): AppModule =>
  (ctx) =>
  async (app) => {
    const service = summaryServiceFor(ctx, overrides);
    await app.register(summaryRoutes(service));

    const unsubscribe = ctx.bus.subscribe((event) => {
      if (event.type !== 'torrent') return;
      try {
        service.recordLockdown(event.action, event.reason, event.infoHashes.length);
      } catch (err) {
        ctx.log.warn({ err }, 'could not record a kill-switch lockdown');
      }
    });
    app.addHook('onClose', async () => unsubscribe());

    const cron = summaryCron(getSection(ctx.db, 'alerts').dailySummary);
    ctx.scheduler.register({
      name: DAILY_SUMMARY_JOB,
      ...(cron ? { cron } : {}),
      handler: async () => {
        const summary = await service.generate({ notify: true });
        const c = summary.counts;
        return `${c.grabbed} grabbed, ${c.imported} imported, ${c.failed} failed, ${summary.downloading.count} downloading`;
      },
    });
  };

export const summaryModule: AppModule = summaryModuleWith();
