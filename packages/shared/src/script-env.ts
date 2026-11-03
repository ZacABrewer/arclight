/**
 * The environment handed to user scripts (custom-script notifications, subtitle
 * post-processing). Scripts get the standard variables a program needs to run (PATH, HOME,
 * locale, temp folders, the Windows system variables) plus the event's own `ARCLIGHT_*`
 * values, but not the rest of the server's environment, which can hold secrets (database or
 * API credentials passed to the container, proxy passwords and so on).
 *
 * An admin who relies on other variables lists them in `ARCLIGHT_SCRIPT_ENV` on the server
 * (comma or space separated names, `*` passes everything as before).
 */

/** Exact names kept (compared case-insensitively, as Windows does). */
const KEEP = new Set(
  [
    // Everywhere
    'PATH', 'HOME', 'USER', 'LOGNAME', 'SHELL', 'LANG', 'LANGUAGE', 'TZ', 'TERM',
    'TEMP', 'TMP', 'TMPDIR', 'PWD',
    'PUID', 'PGID', 'UMASK',
    'XDG_CONFIG_HOME', 'XDG_DATA_HOME', 'XDG_CACHE_HOME', 'XDG_RUNTIME_DIR',
    // Windows
    'PATHEXT', 'SYSTEMROOT', 'SYSTEMDRIVE', 'WINDIR', 'COMSPEC', 'OS',
    'USERNAME', 'USERDOMAIN', 'USERPROFILE', 'HOMEDRIVE', 'HOMEPATH',
    'APPDATA', 'LOCALAPPDATA', 'PROGRAMDATA', 'ALLUSERSPROFILE', 'PUBLIC',
    'PROGRAMFILES', 'PROGRAMFILES(X86)', 'PROGRAMW6432',
    'COMMONPROGRAMFILES', 'COMMONPROGRAMFILES(X86)', 'COMMONPROGRAMW6432',
    'NUMBER_OF_PROCESSORS', 'PROCESSOR_ARCHITECTURE', 'PSMODULEPATH',
    // Arclight's own non-secret runtime facts
    'ARCLIGHT_DOCKER', 'ARCLIGHT_VERSION', 'ARCLIGHT_FFMPEG', 'ARCLIGHT_FFPROBE',
  ].map((k) => k.toUpperCase()),
);

/** The server variable that widens the list. */
export const SCRIPT_ENV_PASSTHROUGH = 'ARCLIGHT_SCRIPT_ENV';

function keptByDefault(upper: string): boolean {
  return KEEP.has(upper) || upper.startsWith('LC_');
}

/**
 * `base` (normally `process.env`) reduced to the allowed names, then `extra` (the event's
 * `ARCLIGHT_*` variables) on top.
 */
export function scriptEnvironment(base: Record<string, string | undefined>, extra: Record<string, string> = {}): Record<string, string> {
  const widen = (base[SCRIPT_ENV_PASSTHROUGH] ?? Object.entries(base).find(([k]) => k.toUpperCase() === SCRIPT_ENV_PASSTHROUGH)?.[1] ?? '')
    .split(/[\s,]+/)
    .map((s) => s.trim().toUpperCase())
    .filter((s) => s !== '');
  const all = widen.includes('*');
  const named = new Set(widen);
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(base)) {
    if (value === undefined) continue;
    const upper = key.toUpperCase();
    if (upper === SCRIPT_ENV_PASSTHROUGH) continue;
    if (all || keptByDefault(upper) || named.has(upper)) out[key] = value;
  }
  return { ...out, ...extra };
}
