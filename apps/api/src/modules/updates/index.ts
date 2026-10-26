import type { AppContext, AppModule } from '../../app.js';
import { VERSION } from '../../version.js';
import { ContainerUpdater, inWindow, type ContainerUpdaterOptions } from './containers.js';
import { createContainerUpdatesCheck, createUpdateAvailableCheck } from './health.js';
import { updatesRoutes } from './routes.js';
import { UpdatesService, type UpdatesServiceOptions } from './service.js';

export { UpdatesService, UpdatesError, UPDATES_SECTION, UPDATE_CACHE_KEY, DEVELOP_TAG, type UpdatesServiceOptions } from './service.js';
export {
  ContainerUpdater,
  ContainerUpdateError,
  inWindow,
  recreateBody,
  orderParentsFirst,
  CONTAINER_CACHE_KEY,
  DEFAULT_DOCKER_SOCKET,
  type ContainerUpdaterOptions,
} from './containers.js';
export { DockerClient, DockerError } from './docker.js';
export { parseImageRef, remoteDigest } from './registry.js';
export { createUpdateAvailableCheck, createContainerUpdatesCheck, UPDATE_AVAILABLE_ANCHOR, CONTAINER_UPDATES_ANCHOR } from './health.js';
export { compareVersions, normalizeVersion, parseVersion } from './version.js';
export { fetchGhcrTags, fetchGithubReleases, UpdateSourceError } from './github.js';

// Updates (System -> Updates, Settings -> Updates):
// - Arclight releases: GET /system/update from a cache, POST /system/update/check, the hourly
//   `UpdateCheck` job (queries GitHub once `checkIntervalHours` have passed) and the
//   `UpdateAvailable` health check.
// - Containers: labelled arclight.autoupdate=true, checked against their registry by the
//   `ContainerUpdateCheck` job once a day inside `autoUpdateWindow`, and recreated on the new
//   image through the Docker socket when `mode` is `auto` (or on "Update now"). Health check
//   `ContainerUpdatesAvailable`.

export const UPDATE_CHECK_JOB = 'UpdateCheck';
export const UPDATE_CHECK_CRON = '23 * * * *';
export const CONTAINER_UPDATE_JOB = 'ContainerUpdateCheck';
export const CONTAINER_UPDATE_CRON = '7 * * * *';
/** The container check runs once per day: skip when the last one is younger than this. */
const CONTAINER_CHECK_MIN_GAP_MS = 20 * 3_600_000;

const services = new WeakMap<AppContext, UpdatesService>();
const updaters = new WeakMap<AppContext, ContainerUpdater>();

/** `overrides` apply only when this call creates the instance (tests inject a fake fetch). */
export function updatesServiceFor(ctx: AppContext, overrides: Partial<Omit<UpdatesServiceOptions, 'db'>> = {}): UpdatesService {
  let service = services.get(ctx);
  if (!service) {
    service = new UpdatesService({ db: ctx.db, currentVersion: VERSION, isDocker: ctx.config.isDocker, ...overrides });
    services.set(ctx, service);
  }
  return service;
}

/** `overrides` apply only when this call creates the instance (tests point it at a fake Docker API). */
export function containerUpdaterFor(ctx: AppContext, overrides: Partial<Omit<ContainerUpdaterOptions, 'db'>> = {}): ContainerUpdater {
  let updater = updaters.get(ctx);
  if (!updater) {
    const socketPath = process.env['ARCLIGHT_DOCKER_SOCKET'];
    updater = new ContainerUpdater({
      db: ctx.db,
      isDocker: ctx.config.isDocker,
      log: ctx.log.child({ module: 'updates' }),
      ...(socketPath ? { socketPath } : {}),
      ...overrides,
    });
    updaters.set(ctx, updater);
  }
  return updater;
}

/** The UpdateAvailable health check bound to this app's updates service. */
export function updateAvailableCheckFor(ctx: AppContext) {
  return createUpdateAvailableCheck(() => updatesServiceFor(ctx));
}

/** The ContainerUpdatesAvailable health check bound to this app. */
export function containerUpdatesCheckFor(ctx: AppContext) {
  return createContainerUpdatesCheck(
    () => updatesServiceFor(ctx),
    () => containerUpdaterFor(ctx),
  );
}

/** One run of the ContainerUpdateCheck job (exported for tests). */
export async function runContainerUpdateJob(service: UpdatesService, updater: ContainerUpdater, now: Date): Promise<string> {
  const s = service.settings();
  if (!s.enabled) return 'update checks are off';
  const reason = await updater.unavailableReason();
  if (reason) return reason;
  if (!inWindow(now.getHours(), s.autoUpdateWindow)) return 'outside the update window';
  const last = updater.lastCheckedAt();
  if (last && now.getTime() - new Date(last).getTime() < CONTAINER_CHECK_MIN_GAP_MS) return 'already checked today';
  const items = await updater.check();
  const pending = items.filter((c) => c.updateAvailable);
  if (pending.length === 0) return `${items.length} container(s) up to date`;
  if (s.mode !== 'auto') return `updates available: ${pending.map((c) => c.name).join(', ')}`;
  const run = await updater.update();
  if (!run.ok) throw new Error(run.message);
  return run.message;
}

export const updatesModule: AppModule = (ctx) => async (app) => {
  const service = updatesServiceFor(ctx);
  const updater = containerUpdaterFor(ctx);
  await app.register(updatesRoutes(service, updater));
  ctx.scheduler.register({
    name: UPDATE_CHECK_JOB,
    cron: UPDATE_CHECK_CRON,
    handler: async () => {
      if (!service.settings().enabled) return 'update checks are off';
      if (!service.isDue()) return 'not due yet';
      const info = await service.check();
      if (info.error) throw new Error(info.error);
      return info.updateAvailable ? `${info.latestVersion} is available (running ${info.currentVersion})` : `up to date (${info.currentVersion})`;
    },
  });
  ctx.scheduler.register({
    name: CONTAINER_UPDATE_JOB,
    cron: CONTAINER_UPDATE_CRON,
    handler: () => runContainerUpdateJob(service, updater, new Date()),
  });
};
