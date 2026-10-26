import { finding, type HealthCheckDef } from '../types.js';

/**
 * Root folders, first matching condition wins: none configured, missing, not writable, empty
 * while items live there (an unmounted share leaves an empty mountpoint).
 */
export const rootFolderCheck: HealthCheckDef = {
  id: 'RootFolderCheck',
  async run(deps) {
    const roots = await deps.rootFolders();
    if (roots.length === 0) {
      return [
        finding(
          this.id,
          'warning',
          'No root folders are configured. Add one in Settings > Media Management before adding series or movies',
          'no-root-folders',
        ),
      ];
    }

    const missing: string[] = [];
    for (const r of roots) if (!(await deps.fs.isDirectory(r.path))) missing.push(r.path);
    if (missing.length === 1) return [finding(this.id, 'error', `Missing root folder: ${missing[0]}`, 'missing-root-folder')];
    if (missing.length > 1) {
      return [finding(this.id, 'error', `Multiple root folders are missing: ${missing.join(' | ')}`, 'missing-root-folder')];
    }

    const unwritable: string[] = [];
    for (const r of roots) if (!(await deps.fs.canWrite(r.path))) unwritable.push(r.path);
    if (unwritable.length > 0) {
      const plural = unwritable.length > 1 ? 's' : '';
      return [
        finding(
          this.id,
          'error',
          `${deps.appName} cannot write to root folder${plural}: ${unwritable.join(' | ')}. Check permissions for the user running ${deps.appName}`,
          'root-folder-not-writable',
        ),
      ];
    }

    const empty: string[] = [];
    for (const r of roots) if (r.itemCount > 0 && (await deps.fs.isEmpty(r.path))) empty.push(r.path);
    if (empty.length === 1) return [finding(this.id, 'warning', `Empty root folder: ${empty[0]}`, 'empty-root-folder')];
    if (empty.length > 1) {
      return [finding(this.id, 'warning', `Multiple root folders are empty: ${empty.join(' | ')}`, 'empty-root-folder')];
    }
    return [];
  },
};

/** A root folder sits on a read-only mount. */
export const mountReadOnlyCheck: HealthCheckDef = {
  id: 'MountCheck',
  async run(deps) {
    const seen = new Map<string, string>();
    for (const r of await deps.rootFolders()) {
      if (!(await deps.fs.isDirectory(r.path))) continue;
      const mount = await deps.fs.mountOf(r.path);
      if (mount?.readOnly && !seen.has(mount.mountPoint)) seen.set(mount.mountPoint, r.path);
    }
    if (seen.size === 0) return [];
    const entries = [...seen].map(([mountPoint, path]) => `${mountPoint} (${path})`).join(', ');
    return [finding(this.id, 'error', `Mount containing a library path is mounted read-only: ${entries}`, 'library-mount-ro')];
  },
};

/** The configured recycle bin is missing or cannot be written. */
export const recycleBinCheck: HealthCheckDef = {
  id: 'RecyclingBinCheck',
  async run(deps) {
    const path = deps.recycleBin();
    if (!path) return [];
    if ((await deps.fs.isDirectory(path)) && (await deps.fs.canWrite(path))) return [];
    return [
      finding(
        this.id,
        'error',
        `Unable to write to configured recycling bin folder: ${path}. Ensure this path exists and is writable by the user running ${deps.appName}`,
        'cannot-write-recycle-bin',
      ),
    ];
  },
};
