import type { RailCode } from './arclight/index.js';
import type { AppPath } from './router.js';

// The navigation tree. Each section sits under one of the 11 rail codes (several sections can
// share a code: Issues and Watchlist live under RQ, Search under IX); the shell turns the
// sections under the active code into the section tabs above the page. Labels here are also
// the titles of the ComingSoon placeholders, so a route's name is written once.

export interface NavLeaf {
  label: string;
  to: AppPath;
  phase?: string;
  /** Hidden from users with role `user` (the api refuses them anyway). */
  adminOnly?: boolean;
}

export interface NavSection extends NavLeaf {
  /** Rail code the section lives under (handoff README: DB LB DS RQ CL WN AC SB IX ST SY). */
  rail: RailCode;
  /** The page draws its own sub-navigation (Settings, Page 06); the shell shows no section tabs. */
  pageNav?: boolean;
  /** Path prefix that marks the section active (defaults to `to`). */
  base?: string;
  children?: readonly NavLeaf[];
}

export const NAV: readonly NavSection[] = [
  { label: 'Dashboard', to: '/', rail: 'DB' },
  {
    label: 'Library',
    to: '/library/tv',
    base: '/library',
    rail: 'LB',
    children: [
      { label: 'TV', to: '/library/tv' },
      { label: 'Movies', to: '/library/movies' },
      { label: 'Add new', to: '/library/add' },
    ],
  },
  {
    label: 'Discover',
    to: '/discover',
    base: '/discover',
    rail: 'DS',
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
    rail: 'RQ',
    children: [
      { label: 'All requests', to: '/requests' },
      { label: 'My requests', to: '/requests/mine' },
    ],
  },
  { label: 'Issues', to: '/issues', rail: 'RQ' },
  { label: 'Watchlist', to: '/watchlist', rail: 'RQ' },
  { label: 'Calendar', to: '/calendar', rail: 'CL' },
  {
    label: 'Activity',
    adminOnly: true,
    to: '/activity/queue',
    base: '/activity',
    rail: 'AC',
    children: [
      { label: 'Queue', to: '/activity/queue' },
      { label: 'History', to: '/activity/history' },
      { label: 'Blocklist', to: '/activity/blocklist' },
      { label: 'Pending', to: '/activity/pending' },
      { label: 'Manual import', to: '/activity/manual-import' },
    ],
  },
  {
    label: 'Wanted',
    to: '/wanted/missing',
    base: '/wanted',
    rail: 'WN',
    children: [
      { label: 'Missing', to: '/wanted/missing' },
      { label: 'Cutoff unmet', to: '/wanted/cutoff' },
    ],
  },
  {
    label: 'Subtitles',
    adminOnly: true,
    to: '/subtitles/wanted',
    base: '/subtitles',
    rail: 'SB',
    children: [
      { label: 'Wanted', to: '/subtitles/wanted' },
      { label: 'History', to: '/subtitles/history' },
      { label: 'Blacklist', to: '/subtitles/blacklist' },
    ],
  },
  {
    label: 'Indexers',
    adminOnly: true,
    to: '/indexers',
    base: '/indexers',
    rail: 'IX',
    children: [
      { label: 'Indexers', to: '/indexers' },
      { label: 'Stats', to: '/indexers/stats' },
    ],
  },
  { label: 'Search', to: '/search', rail: 'IX', adminOnly: true },
  {
    label: 'Settings',
    adminOnly: true,
    to: '/settings/mediamanagement',
    base: '/settings',
    rail: 'ST',
    pageNav: true,
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
    rail: 'SY',
    children: [
      { label: 'Status', to: '/system/status' },
      { label: 'Tasks', to: '/system/tasks' },
      { label: 'Logs', to: '/system/logs' },
      { label: 'Backups', to: '/system/backup' },
      { label: 'Health', to: '/system/health' },
      { label: 'Import', to: '/system/migrate' },
      { label: 'Updates', to: '/system/updates' },
    ],
  },
];

/** The navigation as a given role sees it. */
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

// ---------------------------------------------------------------------------------------
// Rail, section tabs and mobile tabs (pure; the shell renders them)
// ---------------------------------------------------------------------------------------

/** Order, 9px labels and names of the 11 rail codes (mirrors arclight RAIL_ITEMS). */
export const RAIL_CODES: ReadonlyArray<{ code: RailCode; label: string; title: string }> = [
  { code: 'DB', label: 'DASH', title: 'Dashboard' },
  { code: 'LB', label: 'LIB', title: 'Library' },
  { code: 'DS', label: 'DISC', title: 'Discover' },
  { code: 'RQ', label: 'REQ', title: 'Requests' },
  { code: 'CL', label: 'CAL', title: 'Calendar' },
  { code: 'WN', label: 'WANT', title: 'Wanted' },
  { code: 'AC', label: 'ACT', title: 'Activity' },
  { code: 'SB', label: 'SUBS', title: 'Subtitles' },
  { code: 'IX', label: 'INDX', title: 'Indexers' },
  { code: 'ST', label: 'SET', title: 'Settings' },
  { code: 'SY', label: 'SYS', title: 'System' },
];

export interface RailEntry {
  code: RailCode;
  label: string;
  title: string;
  href: AppPath;
}

/** Rail items for a role: a code shows when at least one section under it is visible. */
export function railFor(isAdmin: boolean, nav: readonly NavSection[] = NAV): RailEntry[] {
  const visible = visibleNav(isAdmin, nav);
  return RAIL_CODES.flatMap((r) => {
    const first = visible.find((s) => s.rail === r.code);
    return first ? [{ ...r, href: first.to }] : [];
  });
}

/** The section that owns `pathname`, if any. */
export function activeSection(pathname: string, nav: readonly NavSection[] = NAV): NavSection | undefined {
  return nav.find((s) => isSectionActive(s, pathname));
}

/** Rail code for a path; null when no section owns it (404, profile, design). */
export function activeRailCode(pathname: string, nav: readonly NavSection[] = NAV): RailCode | null {
  return activeSection(pathname, nav)?.rail ?? null;
}

/**
 * Section tabs shown above the page for the rail code that owns `pathname`: the children of
 * every visible section under that code, and childless sections as one tab each. Empty when
 * the page draws its own sub-nav or there is only one destination.
 */
export function sectionTabs(pathname: string, isAdmin: boolean, nav: readonly NavSection[] = NAV): NavLeaf[] {
  const code = activeRailCode(pathname, nav);
  if (!code) return [];
  const sections = visibleNav(isAdmin, nav).filter((s) => s.rail === code);
  if (sections.some((s) => s.pageNav)) return [];
  const leaves = sections.flatMap((s): NavLeaf[] => (s.children ? [...s.children] : [{ label: s.label, to: s.to }]));
  return leaves.length > 1 ? leaves : [];
}

/** The tab that matches `pathname` best (longest prefix), so detail pages keep their tab lit. */
export function activeTab(pathname: string, tabs: readonly NavLeaf[]): NavLeaf | undefined {
  let best: NavLeaf | undefined;
  for (const t of tabs) {
    const hit = pathname === t.to || (t.to !== '/' && pathname.startsWith(`${t.to}/`));
    if (hit && (!best || t.to.length > best.to.length)) best = t;
  }
  return best;
}

export type MobileTabId = 'home' | 'library' | 'discover' | 'activity' | 'requests' | 'more';

export interface MobileTab {
  id: MobileTabId;
  label: string;
  href: AppPath | null;
  icon: 'home' | 'library' | 'discover' | 'activity' | 'inbox' | 'more';
}

/** Bottom tab bar (Page 10): Home, Library, Discover, Activity (Requests for role user), More. */
export function mobileTabsFor(isAdmin: boolean): MobileTab[] {
  return [
    { id: 'home', label: 'Home', href: '/', icon: 'home' },
    { id: 'library', label: 'Library', href: '/library/tv', icon: 'library' },
    { id: 'discover', label: 'Discover', href: '/discover', icon: 'discover' },
    isAdmin
      ? { id: 'activity', label: 'Activity', href: '/activity/queue', icon: 'activity' }
      : { id: 'requests', label: 'Requests', href: '/requests', icon: 'inbox' },
    { id: 'more', label: 'More', href: null, icon: 'more' },
  ];
}

export function activeMobileTab(pathname: string, isAdmin: boolean): MobileTabId {
  const code = activeRailCode(pathname);
  if (code === 'DB') return 'home';
  if (code === 'LB') return 'library';
  if (code === 'DS') return 'discover';
  if (code === 'AC' && isAdmin) return 'activity';
  if (code === 'RQ' && !isAdmin) return 'requests';
  return 'more';
}
