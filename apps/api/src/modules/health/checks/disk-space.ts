import { finding, formatMiB, GIB, type HealthCheckDef } from '../types.js';

/** Less than 1 GiB free on the volume holding the config directory (database, logs). */
export const configDiskSpaceCheck: HealthCheckDef = {
  id: 'ConfigDiskSpace',
  async run(deps) {
    const free = await deps.fs.freeSpace(deps.configDir);
    if (free === null || free > GIB) return [];
    return [
      finding(this.id, 'warning', `Less than 1 GiB free on the config volume (${formatMiB(free)})`, 'config-disk-space-low'),
    ];
  },
};

/** Less than 1 GiB free on any accessible root folder. */
export const rootFolderFreeSpaceCheck: HealthCheckDef = {
  id: 'RootFolderFreeSpace',
  async run(deps) {
    const low: string[] = [];
    for (const root of await deps.rootFolders()) {
      if (!(await deps.fs.isDirectory(root.path))) continue; // reported by RootFolderCheck
      const free = await deps.fs.freeSpace(root.path);
      if (free !== null && free < GIB) low.push(`${root.path} (${formatMiB(free)})`);
    }
    if (low.length === 0) return [];
    return [
      finding(this.id, 'warning', `Less than 1 GiB free on root folder(s): ${low.join(' | ')}`, 'root-folder-low-free-space'),
    ];
  },
};
