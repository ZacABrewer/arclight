import { randomBytes } from 'node:crypto';
import { readdir, readFile, realpath, rm, stat, statfs, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { eq } from 'drizzle-orm';
import { downloadClientHost } from '@arclight/shared';
import type { AppContext } from '../../app.js';
import { feedsRegistry } from '../../feeds.js';
import {
  indexers,
  indexerStatus,
  movies,
  rootFolders,
  series,
  settings,
  trackedDownloads,
} from '../../db/schema.js';
import { getDownloadClientsService } from '../download-clients/index.js';
import { indexersServiceFor } from '../indexers/index.js';
import { notificationsServiceFor } from '../notifications/index.js';
import { getSection } from '../settings/service.js';
import { subtitlesServiceFor } from '../subtitles/index.js';
import { torrentServiceFor } from '../torrent/index.js';
import { vpnServiceFor } from '../vpn/service.js';
import type { HealthDeps, HealthFs } from './types.js';

// Production wiring of HealthDeps: real filesystem, database and the other modules' services.

/** Settings row (and field) holding the recycle bin folder, written by media management. */
export const RECYCLE_BIN_SETTING = { key: 'mediaManagement', field: 'recycleBin' } as const;

export const nodeHealthFs: HealthFs = {
  async isDirectory(path) {
    try {
      return (await stat(path)).isDirectory();
    } catch {
      return false;
    }
  },
  async canWrite(path) {
    const probe = join(path, `.arclight-write-test-${randomBytes(6).toString('hex')}`);
    try {
      await writeFile(probe, '');
      await rm(probe, { force: true });
      return true;
    } catch {
      return false;
    }
  },
  async isEmpty(path) {
    try {
      return (await readdir(path)).length === 0;
    } catch {
      return false;
    }
  },
  async freeSpace(path) {
    try {
      const fs = await statfs(path);
      return Number(fs.bavail) * Number(fs.bsize);
    } catch {
      return null;
    }
  },
  async mountOf(path) {
    if (process.platform !== 'linux') return null;
    try {
      return findMount(await readFile('/proc/mounts', 'utf8'), await realpath(path));
    } catch {
      return null;
    }
  },
  async owner(path) {
    if (process.platform === 'win32') return null;
    try {
      const s = await stat(path);
      return { uid: s.uid, gid: s.gid };
    } catch {
      return null;
    }
  },
};

/** The mount (from /proc/mounts text) with the longest mount point containing `path`. */
export function findMount(procMounts: string, path: string): { mountPoint: string; readOnly: boolean } | null {
  let best: { mountPoint: string; readOnly: boolean } | null = null;
  for (const line of procMounts.split('\n')) {
    const [, rawMountPoint, , options] = line.split(' ');
    if (!rawMountPoint || !options) continue;
    const mountPoint = rawMountPoint.replace(/\\([0-7]{3})/g, (_, oct: string) => String.fromCharCode(parseInt(oct, 8)));
    const contains = mountPoint === '/' || path === mountPoint || path.startsWith(`${mountPoint}/`);
    if (!contains) continue;
    if (!best || mountPoint.length >= best.mountPoint.length) {
      best = { mountPoint, readOnly: options.split(',').includes('ro') };
    }
  }
  return best;
}

function stripTrailingSeparator(path: string): string {
  return path.length > 1 ? path.replace(/[\\/]+$/, '') : path;
}

export function createHealthDeps(ctx: AppContext, env: NodeJS.ProcessEnv = process.env): HealthDeps {
  const { db } = ctx;
  const downloads = getDownloadClientsService(ctx);
  const notifications = notificationsServiceFor(ctx);

  return {
    appName: 'Arclight',
    isDocker: ctx.config.isDocker,
    configDir: ctx.config.configDir,
    platform: process.platform === 'win32' ? 'win32' : 'posix',
    now: () => new Date(),
    processIds: {
      ...(process.getuid ? { uid: process.getuid() } : {}),
      ...(process.getgid ? { gid: process.getgid() } : {}),
    },
    fs: nodeHealthFs,

    async rootFolders() {
      const roots = db.select().from(rootFolders).all();
      const itemRoots = [
        ...db.select({ root: series.rootFolderPath }).from(series).all(),
        ...db.select({ root: movies.rootFolderPath }).from(movies).all(),
      ].map((r) => stripTrailingSeparator(r.root));
      return roots.map((r) => {
        const path = stripTrailingSeparator(r.path);
        return { path: r.path, mediaType: r.mediaType, itemCount: itemRoots.filter((p) => p === path).length };
      });
    },

    downloadClients: {
      enabled: () =>
        downloads.enabledClients().map(({ config }) => ({ id: config.id, name: config.name, host: downloadClientHost(config.settings) })),
      lastPoll: (id) => {
        const s = downloads.clientStatuses().get(id);
        if (!s) return undefined;
        return s.message === undefined ? { ok: s.ok } : { ok: s.ok, message: s.message };
      },
      test: async (id) => {
        try {
          await downloads.clientById(id).test();
          return { ok: true };
        } catch (err) {
          return { ok: false, message: err instanceof Error ? err.message : String(err) };
        }
      },
      status: (id) => downloads.clientById(id).getStatus(),
      toLocal: (host, path) => downloads.remotePathToLocal(host, path),
    },

    indexers() {
      return db
        .select({ row: indexers, status: indexerStatus })
        .from(indexers)
        .leftJoin(indexerStatus, eq(indexerStatus.indexerId, indexers.id))
        .orderBy(indexers.id)
        .all()
        .map(({ row, status }) => ({
          id: row.id,
          name: row.name,
          enableRss: row.enableRss,
          enableAutomaticSearch: row.enableAutomaticSearch,
          enableInteractiveSearch: row.enableInteractiveSearch,
          ...(status?.disabledTill ? { disabledTill: status.disabledTill } : {}),
          ...(status?.initialFailure ? { initialFailure: status.initialFailure } : {}),
        }));
    },

    tmdbKeyConfigured() {
      const stored = getSection(db, 'metadata').tmdbApiKey;
      return Boolean(stored || env['ARCLIGHT_TMDB_API_KEY']?.trim());
    },

    recycleBin() {
      const row = db.select().from(settings).where(eq(settings.key, RECYCLE_BIN_SETTING.key)).get();
      const value = row?.value;
      if (typeof value !== 'object' || value === null) return null;
      const path = (value as Record<string, unknown>)[RECYCLE_BIN_SETTING.field];
      return typeof path === 'string' && path.trim() !== '' ? path : null;
    },

    pendingImports() {
      return db
        .select({ id: trackedDownloads.id, title: trackedDownloads.title })
        .from(trackedDownloads)
        .where(eq(trackedDownloads.state, 'importPending'))
        .all();
    },

    notifications: {
      enabled() {
        const statuses = notifications.connectionStatuses();
        return notifications
          .rows()
          .filter((r) => r.enabled)
          .map((r) => ({ id: r.id, name: r.name, consecutiveFailures: statuses.get(r.id)?.consecutiveFailures ?? 0 }));
      },
      misconfigured: () => notifications.misconfigured(),
    },

    async vpn() {
      const service = vpnServiceFor(ctx);
      const status = service.getStatus();
      // Never checked yet (e.g. right after start): probe once so the finding is real.
      if (status.lastChecked === null && service.settings().enabled) return service.refresh();
      return status;
    },

    async torrent() {
      return torrentServiceFor(ctx).status();
    },

    async activeDownloads() {
      return downloads.activeDownloads();
    },

    minimumFreeSpaceBytes: () => downloads.minimumFreeSpaceBytes(),

    feeds: () => feedsRegistry(ctx).summary(),

    remoteEngines: () => downloads.remoteEngineHealth(),

    whisper: () => subtitlesServiceFor(ctx).whisperStatus(),

    async flareSolverrs() {
      const proxies = indexersServiceFor(ctx).proxies;
      const rows = proxies.allRows().filter((r) => r.type === 'flaresolverr');
      return Promise.all(
        rows.map(async (r) => {
          const result = await proxies.ping(r.id);
          return { id: r.id, name: r.name, ok: result.ok, ...(result.message ? { message: result.message } : {}) };
        }),
      );
    },
  };
}
