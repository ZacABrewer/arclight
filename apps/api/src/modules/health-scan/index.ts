import type { AppContext, AppModule } from '../../app.js';
import { blocklistServiceFor } from '../blocklist/index.js';
import { notificationsServiceFor } from '../notifications/index.js';
import { releasesServiceFor } from '../releases/index.js';
import type { SearchTarget } from '../releases/service.js';
import { applySchedule, registerHealthScanJobs, startScan } from './jobs.js';
import { healthScanRoutes } from './routes.js';
import { HealthScanService, type HealthScanServiceOptions } from './service.js';
import { FfmpegHealthTools, type HealthTools } from './tools.js';

export { HealthScanService, HealthScanError, mergeTargets, defaultStat, type ScanItem, type ScanResult, type HealthScanSummaryEvent } from './service.js';
export { FfmpegHealthTools, locatePriorityTools, errorLines, spawnProcess, type HealthTools, type ProcessFn, type RunResult } from './tools.js';
export * from './checks.js';
export { HEALTH_SCAN_JOB, HEALTH_CHECK_JOB, registerHealthScanJobs, scanMessage } from './jobs.js';
export * from './schema.js';

// Library health scan: broken or wrong files (missing, unreadable, corrupt, decode errors,
// truncated, missing streams, wrong audio language, album / book structure), the HealthScan
// job, and the fix actions. Results show under Library → Hygiene → Health.

export const REPLACE_SEARCH_JOB = 'HealthReplaceSearch';

const services = new WeakMap<AppContext, HealthScanService>();

/** Test seams; production passes none. */
export type HealthScanModuleOptions = Partial<Pick<HealthScanServiceOptions, 'tools' | 'statFile' | 'search' | 'notify' | 'blocklist' | 'now'>>;

export function healthScanFor(ctx: AppContext, opts: HealthScanModuleOptions = {}): HealthScanService {
  let service = services.get(ctx);
  if (!service) {
    const tools: HealthTools = opts.tools ?? new FfmpegHealthTools();
    service = new HealthScanService({
      db: ctx.db,
      tools,
      bus: ctx.bus,
      log: ctx.log.child({ module: 'health-scan' }),
      ...(opts.now ? { now: opts.now } : {}),
      ...(opts.statFile ? { statFile: opts.statFile } : {}),
      blocklist: opts.blocklist ?? ((input) => void blocklistServiceFor(ctx).add(input)),
      search: opts.search ?? ((targets) => startReplaceSearch(ctx, targets)),
      notify:
        opts.notify ??
        ((summary) =>
          notificationsServiceFor(ctx).dispatch({
            type: 'healthScan',
            instanceName: 'Arclight',
            timestamp: new Date().toISOString(),
            findings: summary.newFindings,
            totalNew: summary.totalNew,
            totalOpen: summary.totalOpen,
            filesChecked: summary.filesChecked,
          })),
    });
    services.set(ctx, service);
  }
  return service;
}

/** One job searching each replaced item in turn. */
function startReplaceSearch(ctx: AppContext, targets: SearchTarget[]): number {
  const releases = releasesServiceFor(ctx);
  return ctx.scheduler.runTask(
    REPLACE_SEARCH_JOB,
    'manual',
    async ({ signal, log }) => {
      let grabbed = 0;
      let failed = 0;
      for (const t of targets) {
        if (signal.aborted) break;
        try {
          grabbed += (await releases.searchFor(t, { userInvoked: true, signal })).grabbed.length;
        } catch (err) {
          failed++;
          log.warn({ err, target: t }, 'replacement search failed');
        }
      }
      return `searched ${targets.length} item${targets.length === 1 ? '' : 's'} for replacements: ${grabbed} grabbed${failed ? `, ${failed} failed` : ''}`;
    },
    { key: `${REPLACE_SEARCH_JOB}:${JSON.stringify(targets)}` },
  ).job.id;
}

export const healthScanModuleWith =
  (opts: HealthScanModuleOptions = {}): AppModule =>
  (ctx) =>
  async (app) => {
    const service = healthScanFor(ctx, opts);
    await app.register(
      healthScanRoutes(service, {
        startScan: (req) => startScan(ctx.scheduler, service, req),
        onSettingsChanged: () => applySchedule(ctx.scheduler, service),
      }),
    );
    registerHealthScanJobs(ctx.scheduler, service);
  };

export const healthScanModule: AppModule = healthScanModuleWith();
