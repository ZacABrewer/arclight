import type { MigratePathMapping } from '@media-tron/shared';

// Path remapping between the old app's view of the filesystem and Media-Tron's (different
// containers mount the same share at different places, or the old app ran on Windows).
// The longest matching `from` prefix wins; matching is on whole path segments, separator
// agnostic, and case-insensitive for Windows-style prefixes.

function isWindowsStyle(p: string): boolean {
  return /^[A-Za-z]:[\\/]/.test(p) || p.startsWith('\\\\');
}

function trimTrailing(p: string): string {
  const t = p.replace(/[\\/]+$/, '');
  return t === '' ? p.slice(0, 1) : t;
}

function separatorFor(p: string): '/' | '\\' {
  return p.includes('\\') && !p.includes('/') ? '\\' : '/';
}

export interface RemapResult {
  path: string;
  mapped: boolean;
}

export function remapPath(path: string, mappings: readonly MigratePathMapping[]): RemapResult {
  const ranked = [...mappings].sort((a, b) => trimTrailing(b.from).length - trimTrailing(a.from).length);
  for (const m of ranked) {
    const from = trimTrailing(m.from);
    const insensitive = isWindowsStyle(from) || isWindowsStyle(path);
    const norm = (s: string) => {
      const unified = s.replace(/\\/g, '/');
      return insensitive ? unified.toLowerCase() : unified;
    };
    const p = norm(path);
    const f = norm(from);
    if (p !== f && !p.startsWith(f.endsWith('/') ? f : `${f}/`)) continue;
    const rest = path.slice(from.length).replace(/^[\\/]+/, '');
    const to = trimTrailing(m.to);
    const sep = separatorFor(to);
    const tail = rest === '' ? '' : rest.split(/[\\/]+/).join(sep);
    if (tail === '') return { path: to, mapped: true };
    return { path: to.endsWith(sep) ? `${to}${tail}` : `${to}${sep}${tail}`, mapped: true };
  }
  return { path, mapped: false };
}

/** Join a folder and a relative path using the folder's separator style. */
export function joinPath(folder: string, relative: string): string {
  const sep = separatorFor(folder);
  const rel = relative.replace(/^[\\/]+/, '').split(/[\\/]+/).join(sep);
  const base = folder.replace(/[\\/]+$/, '');
  return rel === '' ? base : `${base}${sep}${rel}`;
}

/** Parent folder in the path's own separator style. */
export function parentPath(path: string): string {
  const trimmed = path.replace(/[\\/]+$/, '');
  const idx = Math.max(trimmed.lastIndexOf('/'), trimmed.lastIndexOf('\\'));
  if (idx <= 0) return trimmed.slice(0, idx + 1) || trimmed;
  const parent = trimmed.slice(0, idx);
  return /^[A-Za-z]:$/.test(parent) ? `${parent}\\` : parent;
}

/** True when `child` equals or lies inside `parent` (separator/case tolerant). */
export function isInside(parent: string, child: string): boolean {
  const insensitive = isWindowsStyle(parent) || isWindowsStyle(child);
  const norm = (s: string) => {
    const u = trimTrailing(s.replace(/\\/g, '/'));
    return insensitive ? u.toLowerCase() : u;
  };
  const p = norm(parent);
  const c = norm(child);
  return c === p || c.startsWith(p.endsWith('/') ? p : `${p}/`);
}

export function samePath(a: string, b: string): boolean {
  return isInside(a, b) && isInside(b, a);
}
