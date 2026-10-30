import type { Access } from '../../auth/access.js';
import { visibleNav, type NavSection } from '../../nav.js';

// The static page index of the universal search: every page of the navigation the person may
// open, with extra search words for the sections inside settings and system pages (labels come
// from the nav, so they follow the UI language; the keywords are search aids, never shown).

export type PageGroup = 'settings' | 'system' | 'docs' | 'pages';

export interface PageEntry {
  to: string;
  label: string;
  /** The nav section ("Settings", "System"). */
  section: string;
  group: PageGroup;
  keywords: readonly string[];
}

/** Sections and synonyms inside each page. */
export const PAGE_KEYWORDS: Readonly<Record<string, readonly string[]>> = {
  '/settings/mediamanagement': ['root folders', 'naming', 'rename', 'file management', 'recycle bin', 'permissions', 'import', 'episode format', 'folders'],
  '/settings/profiles': ['quality profiles', 'delay profiles', 'release profiles', 'language', 'cutoff', 'upgrades'],
  '/settings/quality': ['quality definitions', 'sizes', 'bitrate', 'minimum', 'maximum'],
  '/settings/customformats': ['custom formats', 'scores', 'conditions', 'trash'],
  '/settings/guides': ['trash guides', 'sync', 'templates'],
  '/settings/indexers': ['trackers', 'torznab', 'newznab', 'usenet', 'torrent sites'],
  '/settings/indexerproxies': ['proxy', 'flaresolverr', 'socks', 'http proxy'],
  '/settings/indexeroptions': ['rss', 'retention', 'sync interval', 'minimum age'],
  '/settings/indexercatalogue': ['definitions', 'add indexer', 'catalogue', 'catalog'],
  '/settings/solver': ['cloudflare', 'challenge', 'captcha solver'],
  '/settings/downloadclients': ['qbittorrent', 'transmission', 'deluge', 'sabnzbd', 'nzbget', 'remote path mappings', 'completed download handling'],
  '/settings/torrent': ['built in engine', 'ports', 'speed limits', 'seeding rules', 'slow mode', 'dht'],
  '/settings/crossseed': ['cross seed', 'matching'],
  '/settings/transcode': ['ffmpeg', 'remux', 'convert', 'encode'],
  '/settings/importlists': ['lists', 'trakt', 'imdb lists', 'watchlist sync'],
  '/settings/notifications': ['connections', 'discord', 'telegram', 'email', 'webhook', 'pushover', 'quiet hours', 'alerts'],
  '/settings/mediaservers': ['plex', 'jellyfin', 'emby', 'library scan'],
  '/settings/subtitles': ['opensubtitles', 'languages', 'subtitle providers'],
  '/settings/vpn': ['proton', 'wireguard', 'kill switch', 'gluetun', 'port forwarding'],
  '/settings/general': ['host', 'port', 'url base', 'features', 'music', 'audiobooks', 'logging', 'analytics', 'language', 'theme', 'appearance'],
  '/settings/security': ['authentication', 'api key', 'password', 'login', 'sso', 'certificates'],
  '/settings/requests': ['approval', 'quotas', 'portal', 'auto approve'],
  '/settings/discordbot': ['discord', 'bot', 'slash commands'],
  '/settings/users': ['accounts', 'permissions', 'app access', 'invite'],
  '/settings/updates': ['version', 'upgrade', 'release channel', 'auto update'],
  '/settings/tags': ['labels', 'tag rules', 'auto tagging'],
  '/system/status': ['about', 'version', 'disk space', 'health'],
  '/system/tasks': ['scheduled', 'jobs', 'queue', 'rss sync', 'backup'],
  '/system/logs': ['log files', 'errors', 'debug'],
  '/system/backup': ['backups', 'restore', 'export'],
  '/system/health': ['checks', 'problems', 'warnings'],
  '/system/updates': ['changelog', 'version', 'upgrade'],
  '/system/migrate': ['import', 'sonarr', 'radarr', 'lidarr', 'readarr', 'prowlarr', 'migration'],
  '/system/audit': ['audit log', 'who changed'],
  '/system/feeds': ['rss feeds', 'calendar feed', 'ical'],
  '/docs/system/health': ['help', 'documentation', 'docs', 'fix'],
};

function groupOf(section: NavSection, to: string): PageGroup {
  if (to.startsWith('/docs')) return 'docs';
  if (section.rail === 'ST') return 'settings';
  if (section.rail === 'SY') return 'system';
  return 'pages';
}

/** Every page `access` may open, as search entries. */
export function pageIndex(access: Access | boolean, nav?: readonly NavSection[]): PageEntry[] {
  return visibleNav(access, nav).flatMap((s) =>
    (s.children ?? [{ label: s.label, to: s.to }]).map((c) => ({
      to: c.to,
      label: c.label,
      section: s.label,
      group: groupOf(s, c.to),
      keywords: [s.label, ...(PAGE_KEYWORDS[c.to] ?? [])],
    })),
  );
}
