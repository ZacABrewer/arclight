// Pure helpers for remote path mappings. Remote paths may be POSIX or Windows regardless
// of the OS Arclight runs on, so `node:path` is not used for them.

export type PathPlatform = 'posix' | 'win32';

function isWindowsStyle(path: string): boolean {
  return /^[A-Za-z]:/.test(path) || path.startsWith('\\\\') || (path.includes('\\') && !path.includes('/'));
}

function separatorOf(path: string): '/' | '\\' {
  return isWindowsStyle(path) ? '\\' : '/';
}

/** Normalises a path to directory form: one trailing separator in the path's own style. */
export function toDirectoryForm(path: string): string {
  const sep = separatorOf(path);
  const unified = sep === '\\' ? path.replace(/\//g, '\\') : path;
  const trimmed = unified.replace(/[\\/]+$/, '');
  return trimmed + sep;
}

/** True when `path` is an absolute path Arclight itself could open on `platform`. */
export function isValidLocalPath(path: string, platform: PathPlatform): boolean {
  if (path.trim() === '') return false;
  if (platform === 'win32') return /^[A-Za-z]:[\\/]/.test(path) || /^\\\\[^\\]+\\[^\\]+/.test(path);
  return path.startsWith('/');
}

function samePrefix(path: string, prefix: string): boolean {
  if (isWindowsStyle(prefix)) return path.toLowerCase().startsWith(prefix.toLowerCase());
  return path.startsWith(prefix);
}

/**
 * Replaces `fromPrefix` (directory form) at the start of `path` with `toPrefix`
 * (directory form), converting the remaining separators to `toPrefix`'s style.
 * Returns undefined when `path` is not under `fromPrefix`.
 */
export function replacePrefix(path: string, fromPrefix: string, toPrefix: string): string | undefined {
  const fromSep = separatorOf(fromPrefix);
  const normalised = fromSep === '\\' ? path.replace(/\//g, '\\') : path;
  const bare = fromPrefix.slice(0, -1);
  let suffix: string;
  if (samePrefix(normalised, fromPrefix)) {
    suffix = normalised.slice(fromPrefix.length);
  } else if (normalised.length === bare.length && samePrefix(normalised, bare)) {
    // The directory itself, given without its trailing separator.
    return toPrefix.slice(0, -1) || toPrefix;
  } else {
    return undefined;
  }
  const toSep = separatorOf(toPrefix);
  return toPrefix + suffix.split(/[\\/]/).join(toSep);
}

export interface PathMapping {
  host: string;
  remotePath: string;
  localPath: string;
}

/** First mapping (in the given order) for `host` whose remote path prefixes `path` wins. */
export function mapRemoteToLocal(mappings: readonly PathMapping[], host: string, path: string): string {
  const h = host.trim().toLowerCase();
  for (const m of mappings) {
    if (m.host.trim().toLowerCase() !== h) continue;
    const mapped = replacePrefix(path, m.remotePath, m.localPath);
    if (mapped !== undefined) return mapped;
  }
  return path;
}

export function mapLocalToRemote(mappings: readonly PathMapping[], host: string, path: string): string {
  const h = host.trim().toLowerCase();
  for (const m of mappings) {
    if (m.host.trim().toLowerCase() !== h) continue;
    const mapped = replacePrefix(path, m.localPath, m.remotePath);
    if (mapped !== undefined) return mapped;
  }
  return path;
}
