import { isAbsolute, resolve } from 'node:path';
import { isInside, realpathOfExisting } from '@arclight/engine-agent';
import type { DownloadClientResource } from '@arclight/shared';
import type { Db } from '../../db/index.js';
import { rootFolders } from '../../db/schema.js';

// Where "Move storage" may put a torrent's files (DATA-27): inside a folder the admin already
// configured for downloads or the library, never an arbitrary path such as /etc or the config
// directory. The roots are the engine downloads folder, every built-in client's save path and
// per-category folders, and the library root folders. The check compares real paths (the target
// may not exist yet, so its deepest existing ancestor is resolved), so a symlink or junction
// inside a root cannot lead out of it.

/** The configured folders a torrent may be moved into. */
export function moveRoots(db: Db, downloadsRoot: string, clients: readonly DownloadClientResource[]): string[] {
  const roots = new Set<string>([downloadsRoot]);
  for (const client of clients) {
    if (client.implementation !== 'builtin') continue;
    const settings = client.settings as { savePath?: unknown; categories?: unknown };
    if (typeof settings.savePath === 'string' && settings.savePath.trim()) roots.add(settings.savePath.trim());
    if (Array.isArray(settings.categories)) {
      for (const c of settings.categories as Array<{ savePath?: unknown }>) {
        if (typeof c?.savePath === 'string' && c.savePath.trim()) roots.add(c.savePath.trim());
      }
    }
  }
  for (const row of db.select({ path: rootFolders.path }).from(rootFolders).all()) {
    if (row.path) roots.add(row.path);
  }
  return [...roots].filter((r) => isAbsolute(r)).map((r) => resolve(r));
}

/** The first root that contains `target` (real paths compared), or null when none does. */
export async function containingRoot(target: string, roots: readonly string[]): Promise<string | null> {
  if (!isAbsolute(target)) return null;
  const lexical = resolve(target);
  const real = await realpathOfExisting(lexical);
  for (const root of roots) {
    if (!isInside(root, lexical)) continue;
    if (isInside(await realpathOfExisting(root), real)) return root;
  }
  return null;
}
