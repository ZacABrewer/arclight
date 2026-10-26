import { finding, type HealthCheckDef, type HealthClientStatus, type HealthDeps } from '../types.js';

/** No enabled client, or the first enabled client that cannot be reached. */
export const downloadClientCheck: HealthCheckDef = {
  id: 'DownloadClientCheck',
  async run(deps) {
    const clients = deps.downloadClients.enabled();
    if (clients.length === 0) {
      return [finding(this.id, 'warning', 'No download client is available', 'no-download-client-is-available')];
    }
    for (const client of clients) {
      // The queue poller talks to every client each minute; reuse its outcome and only probe
      // live when it has not run yet.
      const result = deps.downloadClients.lastPoll(client.id) ?? (await deps.downloadClients.test(client.id));
      if (!result.ok) {
        const suffix = result.message ? ` ${result.message}` : '';
        return [
          finding(
            this.id,
            'error',
            `Unable to communicate with ${client.name}.${suffix}`,
            'unable-to-communicate-with-download-client',
          ),
        ];
      }
    }
    return [];
  },
};

/** Reachable clients with their status; unreachable ones are reported by DownloadClientCheck. */
async function reachableStatuses(deps: HealthDeps) {
  const out: Array<{ name: string; host: string; status: HealthClientStatus }> = [];
  for (const client of deps.downloadClients.enabled()) {
    if (deps.downloadClients.lastPoll(client.id)?.ok === false) continue;
    try {
      out.push({ name: client.name, host: client.host, status: await deps.downloadClients.status(client.id) });
    } catch {
      // Communication problems belong to DownloadClientCheck.
    }
  }
  return out;
}

/** A client deletes completed downloads itself, racing the importer. */
export const downloadClientRemovesCompletedCheck: HealthCheckDef = {
  id: 'DownloadClientRemovesCompletedCheck',
  async run(deps) {
    const hit = (await reachableStatuses(deps)).find((c) => c.status.removesCompletedDownloads);
    if (!hit) return [];
    return [
      finding(
        this.id,
        'warning',
        `Download client ${hit.name} is set to remove completed downloads. This can result in downloads being removed from your client before ${deps.appName} can import them.`,
        'download-client-removes-completed-downloads',
      ),
    ];
  },
};

function isValidLocalPath(path: string, platform: HealthDeps['platform']): boolean {
  if (path.trim() === '') return false;
  if (platform === 'win32') return /^[A-Za-z]:[\\/]/.test(path) || /^\\\\[^\\]+\\[^\\]+/.test(path);
  return path.startsWith('/');
}

/**
 * The folder a client saves into (after remote path mappings) must be a valid local path that
 * exists. Which message applies depends on Docker and whether the client is on this host;
 * note the order differs between the invalid and the missing case.
 */
export const remotePathMappingCheck: HealthCheckDef = {
  id: 'RemotePathMappingCheck',
  async run(deps) {
    const os = deps.platform === 'win32' ? 'Windows' : 'Linux';
    const err = (message: string, anchor: string) => [finding(this.id, 'error', message, anchor)];
    for (const { name, host, status } of await reachableStatuses(deps)) {
      if (status.outputRootDir.trim() === '') continue;
      const path = deps.downloadClients.toLocal(host, status.outputRootDir);

      if (!isValidLocalPath(path, deps.platform)) {
        if (!status.isLocalhost) {
          return err(
            `Remote download client ${name} places downloads in ${path} but this is not a valid ${os} path. Review your remote path mappings and download client settings.`,
            'bad-remote-path-mapping',
          );
        }
        if (deps.isDocker) {
          return err(
            `You are using docker; download client ${name} places downloads in ${path} but this is not a valid ${os} path. Review your remote path mappings and download client settings.`,
            'docker-bad-remote-path-mapping',
          );
        }
        return err(
          `Local download client ${name} places downloads in ${path} but this is not a valid ${os} path. Review your download client settings.`,
          'bad-download-client-settings',
        );
      }

      if (await deps.fs.isDirectory(path)) continue;
      if (deps.isDocker) {
        return err(
          `You are using docker; download client ${name} places downloads in ${path} but this directory does not appear to exist inside the container. Review your remote path mappings and container volume settings.`,
          'docker-bad-remote-path-mapping',
        );
      }
      if (!status.isLocalhost) {
        return err(
          `Remote download client ${name} places downloads in ${path} but this directory does not appear to exist. Likely missing or incorrect remote path mapping.`,
          'bad-remote-path-mapping',
        );
      }
      return err(
        `Download client ${name} places downloads in ${path} but ${deps.appName} cannot see this directory. You may need to adjust the folder's permissions.`,
        'permissions-error',
      );
    }
    return [];
  },
};

/** How long a completed download may wait for import before it needs a human. */
export const STALE_IMPORT_MS = 6 * 60 * 60_000;

/**
 * Downloads that completed but have waited for import longer than the threshold. The wait is
 * measured from when this process first saw the item pending (the tracker keeps no
 * "completed at"), so the check is stateful: create one per health service.
 */
export function createStaleImportCheck(thresholdMs: number = STALE_IMPORT_MS): HealthCheckDef {
  const firstSeen = new Map<number, number>();
  return {
    id: 'ImportPendingCheck',
    async run(deps) {
      const now = deps.now().getTime();
      const pending = deps.pendingImports();
      const ids = new Set(pending.map((p) => p.id));
      for (const id of firstSeen.keys()) if (!ids.has(id)) firstSeen.delete(id);
      const stale = pending.filter((p) => {
        const since = firstSeen.get(p.id) ?? now;
        firstSeen.set(p.id, since);
        return now - since >= thresholdMs;
      });
      if (stale.length === 0) return [];
      const hours = Math.round(thresholdMs / 3_600_000);
      const many = stale.length > 1;
      return [
        finding(
          this.id,
          'warning',
          `${stale.length} download${many ? 's' : ''} completed but ${many ? 'have' : 'has'} been waiting for import for more than ${hours} hours; manual interaction required: ${stale.map((s) => s.title).join(', ')}`,
          'downloads-awaiting-manual-import',
        ),
      ];
    },
  };
}
