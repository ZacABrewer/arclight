import { finding, type HealthCheckDef } from '../types.js';

/**
 * Hard links from each local download folder into each root folder. Separate mounts (even of
 * one disk) refuse them, which turns every import into a full copy: slow and twice the space.
 */
export const hardLinkCheck: HealthCheckDef = {
  id: 'HardLinkCheck',
  async run(deps) {
    const probe = deps.fs.canHardLink;
    if (!probe || deps.useHardlinks?.() === false) return [];
    const downloads = new Set<string>();
    for (const client of deps.downloadClients.enabled()) {
      try {
        const status = await deps.downloadClients.status(client.id);
        const local = deps.downloadClients.toLocal(client.host, status.outputRootDir);
        if (local && (await deps.fs.isDirectory(local))) downloads.add(local);
      } catch {
        // Unreachable clients are reported by DownloadClientCheck.
      }
    }
    const roots = (await deps.rootFolders()).map((r) => r.path);
    const blocked: string[] = [];
    for (const from of downloads) {
      for (const to of roots) {
        if (!(await deps.fs.isDirectory(to))) continue;
        if ((await probe.call(deps.fs, from, to)) === false) blocked.push(`${from} -> ${to}`);
      }
    }
    if (blocked.length === 0) return [];
    return [
      finding(
        this.id,
        'warning',
        `Hard links are not possible from the download folder to the library (${blocked.join(' | ')}), so every import is a full copy: slow, and it uses twice the disk space. ` +
          'Put downloads and the library under one shared folder or mount, for example /data/downloads and /data/media',
        'hard-links-not-possible',
      ),
    ];
  },
};
