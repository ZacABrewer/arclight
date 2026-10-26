/**
 * Path helpers for paths that live on the download client's machine. Those may be POSIX
 * or Windows paths regardless of the OS Media-Tron runs on, so `node:path` is not usable.
 */

const DRIVE_PREFIX = /^[A-Za-z]:/;

export function isRootedPath(path: string): boolean {
  return path.startsWith('/') || path.startsWith('\\') || /^[A-Za-z]:([\\/]|$)/.test(path);
}

function separatorFor(path: string): '/' | '\\' {
  if (path.includes('/')) return '/';
  if (path.includes('\\') || DRIVE_PREFIX.test(path)) return '\\';
  return '/';
}

function trimTrailingSeparators(path: string): string {
  let end = path.length;
  while (end > 1) {
    const last = path[end - 1];
    if (last !== '/' && last !== '\\') break;
    // Keep a drive root ("C:\") intact.
    if (end === 3 && DRIVE_PREFIX.test(path)) break;
    end--;
  }
  return path.slice(0, end);
}

/** Joins a child onto a base using the base's separator style. */
export function joinRemotePath(base: string, child: string): string {
  if (base === '') return child;
  const sep = separatorFor(base);
  const head = trimTrailingSeparators(base);
  const tail = child.replace(/^[\\/]+/, '').replace(/[\\/]/g, sep);
  if (tail === '') return head;
  return head.endsWith(sep) ? head + tail : head + sep + tail;
}

/** Compares two client paths ignoring trailing separators. */
export function sameRemotePath(a: string, b: string): boolean {
  return trimTrailingSeparators(a) === trimTrailingSeparators(b);
}

export function isLocalhostAddress(host: string): boolean {
  const h = host.trim().toLowerCase().replace(/^\[/, '').replace(/\]$/, '');
  if (h === 'localhost' || h.endsWith('.localhost')) return true;
  if (h === '::1' || h === '0:0:0:0:0:0:0:1') return true;
  if (/^127(\.\d{1,3}){3}$/.test(h)) return true;
  if (/^::ffff:127(\.\d{1,3}){3}$/.test(h)) return true;
  return false;
}
