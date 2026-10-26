import type { AppPath } from './router.js';

// The sidebar tree. Labels here are also the titles of the ComingSoon placeholders, so a
// route's name is written once. `phase` tells the placeholder which roadmap phase builds it.

export interface NavLeaf {
  label: string;
  to: AppPath;
  phase?: string;
  /** Hidden from users with role `user` (the api refuses them anyway). */
  adminOnly?: boolean;
}

export interface NavSection extends NavLeaf {
  /** Short glyph shown in the sidebar until the Phase 5 icon set arrives. */
  glyph: string;
  /** Path prefix that marks the section active (defaults to `to`). */
  base?: string;
  children?: readonly NavLeaf[];
}

export const NAV: readonly NavSection[] = [
  { label: 'Dashboard', to: '/', glyph: '◇' },
  {
    label: 'Library',
    to: '/library/tv',
    base: '/library',
    glyph: '▤',
    children: [
      { label: 'TV', to: '/library/tv' },
      { label: 'Movies', to: '/library/movies' },
      { label: 'Add New', to: '/library/add' },
    ],
  },
  {
    label: 'Discover',
    to: '/discover',
    base: '/discover',
    glyph: '✦',
    children: [
      { label: 'Home', to: '/discover' },
      { label: 'Movies', to: '/discover/movies' },
      { label: 'TV', to: '/discover/tv' },
    ],
  },
  {
    label: 'Requests',
    to: '/requests',
    base: '/requests',
    glyph: '✉',
    children: [
      { label: 'All requests', to: '/requests' },
      { label: 'My requests', to: '/requests/mine' },
    ],
  },
  { label: 'Issues', to: '/issues', glyph: '⚑' },
  { label: 'Watchlist', to: '/watchlist', glyph: '★' },
  { label: 'Calendar', to: '/calendar', glyph: '▦' },
  {
    label: 'Activity',
    adminOnly: true,
    to: '/activity/queue',
    base: '/activity',
    glyph: '⇅',
    children: [
      { label: 'Queue', to: '/activity/queue' },
      { label: 'History', to: '/activity/history' },
      { label: 'Blocklist', to: '/activity/blocklist' },
      { label: 'Pending', to: '/activity/pending' },
      { label: 'Manual Import', to: '/activity/manual-import' },
    ],
  },
  {
    label: 'Wanted',
    to: '/wanted/missing',
    base: '/wanted',
    glyph: '☆',
    children: [
      { label: 'Missing', to: '/wanted/missing' },
      { label: 'Cutoff Unmet', to: '/wanted/cutoff' },
    ],
  },
  {
    label: 'Subtitles',
    adminOnly: true,
    to: '/subtitles/wanted',
    base: '/subtitles',
    glyph: '❝',
    children: [
      { label: 'Wanted', to: '/subtitles/wanted' },
      { label: 'History', to: '/subtitles/history' },
      { label: 'Blacklist', to: '/subtitles/blacklist' },
    ],
  },
  { label: 'Search', to: '/search', glyph: '⌕', adminOnly: true },
  {
    label: 'Indexers',
    adminOnly: true,
    to: '/indexers',
    base: '/indexers',
    glyph: '⛁',
    children: [
      { label: 'Indexers', to: '/indexers' },
      { label: 'Stats', to: '/indexers/stats' },
    ],
  },
  {
    label: 'Settings',
    adminOnly: true,
    to: '/settings/mediamanagement',
    base: '/settings',
    glyph: '⚙',
    children: [
      { label: 'Media Management', to: '/settings/mediamanagement' },
      { label: 'Profiles', to: '/settings/profiles' },
      { label: 'Quality', to: '/settings/quality' },
      { label: 'Custom Formats', to: '/settings/customformats' },
      { label: 'Indexers', to: '/settings/indexers' },
      { label: 'Indexer Proxies', to: '/settings/indexerproxies' },
      { label: 'Indexer Options', to: '/settings/indexeroptions' },
      { label: 'Download Clients', to: '/settings/downloadclients' },
      { label: 'Torrent Engine', to: '/settings/torrent' },
      { label: 'Import Lists', to: '/settings/importlists' },
      { label: 'Notifications', to: '/settings/notifications' },
      { label: 'Subtitles', to: '/settings/subtitles' },
      { label: 'VPN', to: '/settings/vpn' },
      { label: 'General', to: '/settings/general' },
      { label: 'Security', to: '/settings/security' },
      { label: 'Requests', to: '/settings/requests' },
      { label: 'Users', to: '/settings/users' },
    ],
  },
  {
    label: 'System',
    adminOnly: true,
    to: '/system/status',
    base: '/system',
    glyph: '⌘',
    children: [
      { label: 'Status', to: '/system/status' },
      { label: 'Tasks', to: '/system/tasks' },
      { label: 'Logs', to: '/system/logs' },
      { label: 'Backups', to: '/system/backup' },
      { label: 'Health', to: '/system/health' },
      { label: 'Import', to: '/system/migrate' },
    ],
  },
];

/** The sidebar as a given role sees it. */
export function visibleNav(isAdmin: boolean, nav: readonly NavSection[] = NAV): NavSection[] {
  if (isAdmin) return [...nav];
  return nav
    .filter((s) => !s.adminOnly)
    .map((s) => (s.children ? { ...s, children: s.children.filter((c) => !c.adminOnly) } : s));
}

/** Find the nav entry for a path (used for placeholder titles and the document title). */
export function navEntry(path: string): { label: string; phase?: string | undefined; section?: string } | undefined {
  for (const section of NAV) {
    if (section.to === path && !section.children) return section;
    for (const child of section.children ?? []) {
      if (child.to === path) {
        return { label: child.label, phase: child.phase, section: section.label };
      }
    }
  }
  return undefined;
}

export function isSectionActive(section: NavSection, pathname: string): boolean {
  const base = section.base ?? section.to;
  if (base === '/') return pathname === '/';
  return pathname === base || pathname.startsWith(`${base}/`);
}
