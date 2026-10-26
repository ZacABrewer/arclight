import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import type { MigrateApp, MigrateSourceCandidate } from '@media-tron/shared';

// Auto-detection of existing installations: the usual container mounts (`/config/sonarr.db`
// when the old app's config volume is mounted into Media-Tron), Windows service installs
// under %ProgramData%, and Linux package installs. Only paths that exist are returned.

export interface DetectOptions {
  exists?: (path: string) => boolean;
  env?: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
  home?: string;
}

interface Layout {
  app: MigrateApp;
  /** Database path relative to the install root, and the config file relative to the same root. */
  db: string;
  config: string | null;
}

const LAYOUTS: Layout[] = [
  { app: 'sonarr', db: 'sonarr.db', config: 'config.xml' },
  { app: 'radarr', db: 'radarr.db', config: 'config.xml' },
  { app: 'prowlarr', db: 'prowlarr.db', config: 'config.xml' },
  { app: 'bazarr', db: 'db/bazarr.db', config: 'config/config.yaml' },
  { app: 'seerr', db: 'db/db.sqlite3', config: 'settings.json' },
];

const APP_DIRS: Record<MigrateApp, string[]> = {
  sonarr: ['sonarr', 'Sonarr'],
  radarr: ['radarr', 'Radarr'],
  prowlarr: ['prowlarr', 'Prowlarr'],
  bazarr: ['bazarr', 'Bazarr'],
  seerr: ['overseerr', 'jellyseerr', 'seerr'],
};

function join(sep: '/' | '\\', ...parts: string[]): string {
  return parts
    .map((p, i) => (i === 0 ? p.replace(/[\\/]+$/, '') : p.replace(/^[\\/]+|[\\/]+$/g, '')))
    .filter((p) => p !== '')
    .join(sep)
    .replace(/[\\/]/g, sep);
}

export function detectSources(opts: DetectOptions = {}): MigrateSourceCandidate[] {
  const exists = opts.exists ?? existsSync;
  const env = opts.env ?? process.env;
  const platform = opts.platform ?? process.platform;
  const home = opts.home ?? homedir();
  const out: MigrateSourceCandidate[] = [];
  const seen = new Set<string>();

  const consider = (sep: '/' | '\\', root: string, layout: Layout, origin: string) => {
    const dbPath = join(sep, root, layout.db);
    if (seen.has(dbPath.toLowerCase()) || !exists(dbPath)) return;
    seen.add(dbPath.toLowerCase());
    let configPath: string | null = layout.config ? join(sep, root, layout.config) : null;
    if (layout.app === 'bazarr' && configPath && !exists(configPath)) {
      const ini = join(sep, root, 'config/config.ini');
      configPath = exists(ini) ? ini : null;
    } else if (configPath && !exists(configPath)) configPath = null;
    out.push({ app: layout.app, dbPath, configPath, origin });
  };

  // Container mounts: the old app's config volume mounted at a well-known path.
  const extra = (env['MEDIATRON_MIGRATE_DIRS'] ?? '').split(platform === 'win32' ? ';' : ':').filter(Boolean);
  const bases = ['/config', '/import', '/migrate', '/mnt/import', ...extra];
  for (const layout of LAYOUTS) {
    for (const base of bases) {
      consider('/', base, layout, 'container mount');
      for (const dir of APP_DIRS[layout.app]) consider('/', `${base}/${dir}`, layout, 'container mount');
    }
    for (const dir of APP_DIRS[layout.app]) consider('/', `/${dir}`, layout, 'container mount');
  }

  if (platform === 'win32') {
    const programData = env['ProgramData'] ?? env['PROGRAMDATA'] ?? 'C:\\ProgramData';
    consider('\\', `${programData}\\Sonarr`, LAYOUTS[0]!, 'Windows ProgramData');
    consider('\\', `${programData}\\Radarr`, LAYOUTS[1]!, 'Windows ProgramData');
    consider('\\', `${programData}\\Prowlarr`, LAYOUTS[2]!, 'Windows ProgramData');
    consider('\\', `${programData}\\Bazarr\\data`, LAYOUTS[3]!, 'Windows ProgramData');
    consider('\\', 'C:\\Bazarr\\data', LAYOUTS[3]!, 'Windows install');
    consider('\\', `${programData}\\Jellyseerr`, LAYOUTS[4]!, 'Windows ProgramData');
  } else {
    consider('/', '/var/lib/sonarr', LAYOUTS[0]!, 'Linux package');
    consider('/', '/var/lib/radarr', LAYOUTS[1]!, 'Linux package');
    consider('/', '/var/lib/prowlarr', LAYOUTS[2]!, 'Linux package');
    consider('/', `${home}/.config/Sonarr`, LAYOUTS[0]!, 'user config');
    consider('/', `${home}/.config/Radarr`, LAYOUTS[1]!, 'user config');
    consider('/', `${home}/.config/Prowlarr`, LAYOUTS[2]!, 'user config');
    consider('/', '/opt/bazarr/data', LAYOUTS[3]!, 'Linux install');
    consider('/', '/opt/overseerr/config', LAYOUTS[4]!, 'Linux install');
    consider('/', '/opt/jellyseerr/config', LAYOUTS[4]!, 'Linux install');
  }
  return out;
}
