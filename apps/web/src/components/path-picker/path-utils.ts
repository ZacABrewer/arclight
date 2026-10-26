import { t } from '../../i18n/index.js';
// Pure path helpers for the folder browser. The api answers with native paths (backslashes
// on Windows); these never touch the filesystem.

export interface Crumb {
  label: string;
  /** Path to list when the crumb is clicked ('' = the roots / drive list). */
  path: string;
}

/** Label of the virtual root above drives/mounts (read per call so it follows the locale). */
export const rootLabel = () => t('components.pathPicker.computer');
/** @deprecated English label; use rootLabel(). */
export const ROOT_LABEL = 'Computer'; // i18n-ignore: English source, kept for tests

export function isWindowsPath(path: string): boolean {
  return /^[A-Za-z]:/.test(path) || path.startsWith('\\\\');
}

/** Breadcrumbs for a listing path: roots first, the path itself last. */
export function breadcrumbs(path: string): Crumb[] {
  if (path === '') return [{ label: rootLabel(), path: '' }];
  if (isWindowsPath(path)) {
    const crumbs: Crumb[] = [{ label: rootLabel(), path: '' }];
    let root: string;
    let rest: string;
    if (path.startsWith('\\\\')) {
      const parts = path.slice(2).split('\\').filter(Boolean);
      root = `\\\\${parts.slice(0, 2).join('\\')}`;
      crumbs.push({ label: root, path: `${root}\\` });
      rest = parts.slice(2).join('\\');
    } else {
      root = path.slice(0, 2).toUpperCase();
      crumbs.push({ label: root, path: `${root}\\` });
      rest = path.slice(2);
    }
    let acc = root;
    for (const part of rest.split(/[\\/]/).filter(Boolean)) {
      acc = `${acc}\\${part}`;
      crumbs.push({ label: part, path: acc });
    }
    return crumbs;
  }
  const crumbs: Crumb[] = [{ label: '/', path: '/' }];
  let acc = '';
  for (const part of path.split('/').filter(Boolean)) {
    acc = `${acc}/${part}`;
    crumbs.push({ label: part, path: acc });
  }
  return crumbs;
}

/** True when the path is (or looks like) absolute on either platform. */
export function isAbsolutePath(path: string): boolean {
  return path.startsWith('/') || isWindowsPath(path);
}

/** Last segment of a path (`C:\Media\TV` -> `TV`, `C:\` -> `C:`). */
export function baseName(path: string): string {
  const parts = path.split(/[\\/]/).filter(Boolean);
  return parts[parts.length - 1] ?? path;
}

/** A folder name the api will accept from the "new folder" box. */
export function isValidFolderName(name: string): boolean {
  const n = name.trim();
  if (n === '' || n === '.' || n === '..') return false;
  return !/[\\/<>:"|?*]/.test(n);
}
