import { isAbsolute, parse, relative, resolve, sep } from 'node:path';

/**
 * Structural checks every root folder path must pass, whatever adds it (the settings page, a
 * config import or a migration): absolute, and not a filesystem root. A root folder of `/` or
 * `C:\` would make every "is this inside a root folder" check pass for any path.
 * Returns the reason it is refused, or null when the path is fine.
 */
export function rootFolderPathProblem(raw: string): string | null {
  const path = raw.trim();
  if (path === '' || !isAbsolute(path)) return 'root folder path must be absolute';
  // A bare drive (`C:` or `C:\`) or `/`; UNC shares (`\\nas\media`) are normal roots.
  if (/^[A-Za-z]:[\\/]*$/.test(path) || /^[\\/]+$/.test(path)) return 'root folder may not be a drive or filesystem root';
  const full = resolve(path);
  const isUnc = /^[\\/]{2}[^\\/]/.test(full);
  if (!isUnc && full === parse(full).root) return 'root folder may not be a drive or filesystem root';
  return null;
}

/** True when `child` lies strictly inside `parent` (not equal to it). */
export function isStrictlyInside(parent: string, child: string): boolean {
  const rel = relative(resolve(parent), resolve(child));
  return rel !== '' && rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel);
}

/** True when `path` lies strictly inside one of `roots`. */
export function insideAnyRoot(roots: readonly string[], path: string): boolean {
  return roots.some((root) => rootFolderPathProblem(root) === null && isStrictlyInside(root, path));
}
