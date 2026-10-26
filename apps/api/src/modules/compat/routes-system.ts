import { release as osRelease } from 'node:os';
import { Cron } from 'croner';
import { sql } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { authServiceFor } from '../auth/index.js';
import { healthServiceFor } from '../health/index.js';
import { getSection } from '../settings/service.js';
import { VERSION } from '../../version.js';
import { humanizeCommand } from './activity.js';
import { compact, type Json } from './common.js';
import { toV3Health } from './config.js';
import type { CompatServices } from './services.js';

// System, health, configuration and the unversioned probes. Mounted twice: the probes at the
// root (`/api`, `/ping`, `/initialize.json`), the rest under /api/v3.

const COLON_REPLACEMENT: Record<string, number> = { delete: 0, dash: 1, spaceDash: 2, spaceDashSpace: 3, smart: 4, custom: 5 };
const MULTI_EPISODE_STYLE: Record<string, number> = { extend: 0, duplicate: 1, repeat: 2, scene: 3, range: 4, prefixedRange: 5 };

function osName(): string {
  switch (process.platform) {
    case 'win32':
      return 'windows';
    case 'darwin':
      return 'osx';
    default:
      return process.platform;
  }
}

/** Minutes between two consecutive runs of a cron expression (0 when it cannot be computed). */
function cronIntervalMinutes(expr: string): number {
  try {
    const cron = new Cron(expr, { paused: true });
    const [a, b] = cron.nextRuns(2);
    cron.stop();
    return a && b ? Math.round((b.getTime() - a.getTime()) / 60_000) : 0;
  } catch {
    return 0;
  }
}

/** The probe payload apps read from /initialize.json (no API key: it is public here). */
export function initializePayload(s: CompatServices): Json {
  const settings = s.settings();
  return {
    apiRoot: '/api/v3',
    apiVersion: 'v3',
    appName: 'Media-Tron',
    instanceName: settings.instanceName,
    release: VERSION,
    version: VERSION,
    branch: 'main',
    analytics: false,
    userHash: '',
    urlBase: '',
    isProduction: process.env['NODE_ENV'] === 'production',
    theme: 'auto',
  };
}

/** Unversioned probes, registered at the root of the compat scope. */
export function probeRoutes(app: FastifyInstance, s: CompatServices): void {
  app.get('/api', async () => ({ current: 'v3', deprecated: [] }));
  app.get('/ping', async () => ({ status: 'OK' }));
  app.get('/initialize.json', async () => initializePayload(s));
  app.get('/initialize.js', async (_req, reply) => {
    const body = `window.Sonarr = ${JSON.stringify(initializePayload(s))};\nwindow.Radarr = window.Sonarr;\n`;
    return reply.type('application/javascript; charset=utf-8').send(body);
  });
}

export function systemRoutes(app: FastifyInstance, s: CompatServices): void {
  const ctx = s.ctx;

  const sqlite = (): { sqliteVersion: string; migrationVersion: number } => {
    let sqliteVersion = '';
    let migrationVersion = 0;
    try {
      sqliteVersion = ctx.db.get<{ v: string }>(sql`select sqlite_version() as v`)?.v ?? '';
    } catch {
      sqliteVersion = '';
    }
    try {
      migrationVersion = ctx.db.get<{ n: number }>(sql`select count(*) as n from __drizzle_migrations`)?.n ?? 0;
    } catch {
      migrationVersion = 0;
    }
    return { sqliteVersion, migrationVersion };
  };

  // Overseerr/Jellyseerr only check that `version` is present (and loosely compare its major for
  // v4 behaviour); Prowlarr reads X-Application-Version instead. We report the real version.
  app.get('/system/status', async () => {
    const settings = s.settings();
    const auth = authServiceFor(ctx).security();
    const { sqliteVersion, migrationVersion } = sqlite();
    return {
      appName: 'Media-Tron',
      instanceName: settings.instanceName,
      version: VERSION,
      buildTime: ctx.startedAt.toISOString(),
      isDebug: false,
      isProduction: process.env['NODE_ENV'] === 'production',
      isAdmin: false,
      isUserInteractive: false,
      startupPath: process.cwd(),
      appData: ctx.config.configDir,
      osName: osName(),
      osVersion: osRelease(),
      isNetCore: false,
      isLinux: process.platform === 'linux',
      isOsx: process.platform === 'darwin',
      isWindows: process.platform === 'win32',
      isDocker: ctx.config.isDocker,
      isContainerized: ctx.config.isDocker,
      mode: 'console',
      branch: 'main',
      authentication: auth.method === 'none' ? 'none' : auth.method,
      sqliteVersion,
      migrationVersion,
      urlBase: '',
      runtimeVersion: process.versions.node,
      runtimeName: 'node',
      startTime: ctx.startedAt.toISOString(),
      packageUpdateMechanism: ctx.config.isDocker ? 'docker' : 'builtIn',
      databaseType: 'sqLite',
      databaseVersion: sqliteVersion,
    };
  });

  app.get('/health', async () => (await healthServiceFor(ctx).current()).checks.map(toV3Health));

  app.get('/system/task', async () =>
    ctx.scheduler.listScheduled().map((job, i) =>
      compact({
        id: i + 1,
        name: humanizeCommand(job.name),
        taskName: job.name,
        interval: cronIntervalMinutes(job.interval),
        lastExecution: job.lastRun ?? undefined,
        lastStartTime: job.lastRun ?? undefined,
        nextExecution: job.nextRun ?? undefined,
        lastDuration: '00:00:00',
      }),
    ),
  );

  app.get('/system/backup', async () => []);
  app.get('/update', async () => []);

  // ---------------------------------------------------------------------------- config (read-only)
  app.get('/config/host', async (req) => {
    const auth = authServiceFor(ctx).security();
    const settings = s.settings();
    return {
      id: 1,
      bindAddress: ctx.config.host === '0.0.0.0' ? '*' : ctx.config.host,
      port: ctx.config.port,
      sslPort: 9898,
      enableSsl: false,
      launchBrowser: false,
      authenticationMethod: auth.method === 'none' ? 'none' : auth.method,
      authenticationRequired: auth.requireForLocal ? 'enabled' : 'disabledForLocalAddresses',
      analyticsEnabled: false,
      username: '',
      password: '',
      passwordConfirmation: '',
      logLevel: ctx.config.logLevel,
      logSizeLimit: 1,
      consoleLogLevel: '',
      branch: 'main',
      // Upstream returns the key to its admins; only admin callers get it here too.
      apiKey: req.auth?.isAdmin ? (auth.apiKey ?? '') : '',
      sslCertPath: '',
      sslCertPassword: '',
      urlBase: '',
      instanceName: settings.instanceName,
      applicationUrl: '',
      updateAutomatically: false,
      updateMechanism: ctx.config.isDocker ? 'docker' : 'builtIn',
      updateScriptPath: '',
      proxyEnabled: false,
      proxyType: 'http',
      proxyHostname: '',
      proxyPort: 8080,
      proxyUsername: '',
      proxyPassword: '',
      proxyBypassFilter: '',
      proxyBypassLocalAddresses: true,
      certificateValidation: 'enabled',
      backupFolder: 'Backups',
      backupInterval: 7,
      backupRetention: 28,
    };
  });

  app.get('/config/naming', async () => {
    const n = getSection(ctx.db, 'naming');
    return {
      id: 1,
      renameEpisodes: n.renameEpisodes,
      replaceIllegalCharacters: n.replaceIllegalCharacters,
      colonReplacementFormat: COLON_REPLACEMENT[n.colonReplacement] ?? 4,
      customColonReplacementFormat: n.customColonReplacement ?? '',
      multiEpisodeStyle: MULTI_EPISODE_STYLE[n.multiEpisodeStyle] ?? 5,
      standardEpisodeFormat: n.standardEpisodeFormat,
      dailyEpisodeFormat: n.dailyEpisodeFormat,
      animeEpisodeFormat: n.animeEpisodeFormat,
      seriesFolderFormat: n.seriesFolderFormat,
      seasonFolderFormat: n.seasonFolderFormat,
      specialsFolderFormat: n.specialsFolderFormat,
      // Radarr fields.
      renameMovies: n.renameMovies,
      standardMovieFormat: n.movieFormat,
      movieFolderFormat: n.movieFolderFormat,
    };
  });

  app.get('/config/mediamanagement', async () => {
    const m = getSection(ctx.db, 'mediaManagement');
    return {
      id: 1,
      autoUnmonitorPreviouslyDownloadedEpisodes: false,
      autoUnmonitorPreviouslyDownloadedMovies: false,
      recycleBin: m.recycleBinPath ?? '',
      recycleBinCleanupDays: m.recycleBinCleanupDays,
      downloadPropersAndRepacks: m.downloadPropersAndRepacks,
      createEmptySeriesFolders: m.createEmptySeriesFolders,
      createEmptyMovieFolders: m.createEmptySeriesFolders,
      deleteEmptyFolders: m.deleteEmptyFolders,
      fileDate: m.fileDateMode === 'releaseDate' ? 'release' : m.fileDateMode,
      rescanAfterRefresh: m.rescanAfterRefresh,
      autoRenameFolders: false,
      pathsDefaultStatic: false,
      setPermissionsLinux: m.setPermissions,
      chmodFolder: m.chmodFolder,
      chownGroup: m.chownGroup,
      episodeTitleRequired: m.episodeTitleRequired,
      skipFreeSpaceCheckWhenImporting: m.skipFreeSpaceCheck,
      minimumFreeSpaceWhenImporting: m.minimumFreeSpaceMb,
      copyUsingHardlinks: m.useHardlinks,
      useScriptImport: false,
      scriptImportPath: '',
      importExtraFiles: m.importExtraFiles,
      extraFileExtensions: m.extraFileExtensions.join(','),
      enableMediaInfo: m.enableMediaInfo,
    };
  });

  app.get('/config/ui', async () => ({
    id: 1,
    firstDayOfWeek: 0,
    calendarWeekColumnHeader: 'ddd M/D',
    shortDateFormat: 'MMM D YYYY',
    longDateFormat: 'dddd, MMMM D YYYY',
    timeFormat: 'h(:mm)a',
    showRelativeDates: true,
    enableColorImpairedMode: false,
    theme: 'auto',
    uiLanguage: 1,
    movieInfoLanguage: 1,
  }));
}
