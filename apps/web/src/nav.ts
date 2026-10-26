import type { RailCode } from './arclight/index.js';
import type { AppPath } from './router.js';
import { t } from './i18n/index.js';

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
  { get label() { return t('common.dashboard'); }, to: '/', rail: 'DB' },
  {
    get label() {
      return t('common.library');
    },
    to: '/library/tv',
    base: '/library',
    rail: 'LB',
    children: [
      { get label() { return t('common.tv'); }, to: '/library/tv' },
      { get label() { return t('common.movies'); }, to: '/library/movies' },
      { get label() { return t('common.collections'); }, to: '/library/collections' },
      { get label() { return t('nav.addNew'); }, to: '/library/add' },
      { get label() { return t('common.retention'); }, to: '/library/retention', adminOnly: true },
      { get label() { return t('common.hygiene'); }, to: '/library/hygiene', adminOnly: true },
    ],
  },
  {
    get label() {
      return t('common.discover');
    },
    to: '/discover',
    base: '/discover',
    rail: 'DS',
    children: [
      { get label() { return t('nav.home'); }, to: '/discover' },
      { get label() { return t('common.movies'); }, to: '/discover/movies' },
      { get label() { return t('common.tv'); }, to: '/discover/tv' },
      { get label() { return t('common.trending'); }, to: '/discover/trending' },
    ],
  },
  {
    get label() {
      return t('common.requests');
    },
    to: '/requests',
    base: '/requests',
    rail: 'RQ',
    children: [
      { get label() { return t('nav.allRequests'); }, to: '/requests' },
      { get label() { return t('common.myRequests'); }, to: '/requests/mine' },
    ],
  },
  { get label() { return t('common.issues'); }, to: '/issues', rail: 'RQ' },
  { get label() { return t('common.watchlist'); }, to: '/watchlist', rail: 'RQ' },
  { get label() { return t('common.calendar'); }, to: '/calendar', rail: 'CL' },
  {
    get label() {
      return t('common.activity');
    },
    adminOnly: true,
    to: '/activity/queue',
    base: '/activity',
    rail: 'AC',
    children: [
      { get label() { return t('common.queue'); }, to: '/activity/queue' },
      { get label() { return t('common.history'); }, to: '/activity/history' },
      { get label() { return t('common.blocklist'); }, to: '/activity/blocklist' },
      { get label() { return t('common.pending'); }, to: '/activity/pending' },
      { get label() { return t('nav.crossSeeds'); }, to: '/activity/crossseed' },
      { get label() { return t('nav.transcodeJobs'); }, to: '/activity/transcode' },
      { get label() { return t('common.manualImport'); }, to: '/activity/manual-import' },
    ],
  },
  {
    get label() {
      return t('common.wanted');
    },
    to: '/wanted/missing',
    base: '/wanted',
    rail: 'WN',
    children: [
      { get label() { return t('status.missing'); }, to: '/wanted/missing' },
      { get label() { return t('status.cutoffUnmet'); }, to: '/wanted/cutoff' },
      { get label() { return t('profileMigration.wanted.tab'); }, to: '/wanted/mismatch' },
    ],
  },
  {
    get label() {
      return t('common.subtitles');
    },
    adminOnly: true,
    to: '/subtitles/wanted',
    base: '/subtitles',
    rail: 'SB',
    children: [
      { get label() { return t('common.wanted'); }, to: '/subtitles/wanted' },
      { get label() { return t('common.history'); }, to: '/subtitles/history' },
      { get label() { return t('common.blacklist'); }, to: '/subtitles/blacklist' },
    ],
  },
  {
    get label() {
      return t('common.indexers');
    },
    adminOnly: true,
    to: '/indexers',
    base: '/indexers',
    rail: 'IX',
    children: [
      { get label() { return t('common.indexers'); }, to: '/indexers' },
      { get label() { return t('nav.stats'); }, to: '/indexers/stats' },
      { get label() { return t('nav.trackerStats'); }, to: '/indexers/trackers' },
    ],
  },
  { get label() { return t('common.search'); }, to: '/search', rail: 'IX', adminOnly: true },
  {
    get label() {
      return t('common.settings');
    },
    adminOnly: true,
    to: '/settings/mediamanagement',
    base: '/settings',
    rail: 'ST',
    pageNav: true,
    children: [
      { get label() { return t('nav.mediaManagement'); }, to: '/settings/mediamanagement' },
      { get label() { return t('common.profiles'); }, to: '/settings/profiles' },
      { get label() { return t('common.quality'); }, to: '/settings/quality' },
      { get label() { return t('nav.customFormats'); }, to: '/settings/customformats' },
      { get label() { return t('common.guides'); }, to: '/settings/guides' },
      { get label() { return t('common.indexers'); }, to: '/settings/indexers' },
      { get label() { return t('nav.indexerProxies'); }, to: '/settings/indexerproxies' },
      { get label() { return t('nav.indexerOptions'); }, to: '/settings/indexeroptions' },
      { get label() { return t('nav.indexerCatalogue'); }, to: '/settings/indexercatalogue' },
      { get label() { return t('nav.challengeSolver'); }, to: '/settings/solver' },
      { get label() { return t('nav.downloadClients'); }, to: '/settings/downloadclients' },
      { get label() { return t('nav.torrentEngine'); }, to: '/settings/torrent' },
      { get label() { return t('nav.crossSeed'); }, to: '/settings/crossseed' },
      { get label() { return t('nav.transcode'); }, to: '/settings/transcode' },
      { get label() { return t('nav.importLists'); }, to: '/settings/importlists' },
      { get label() { return t('common.notifications'); }, to: '/settings/notifications' },
      { get label() { return t('nav.mediaServers'); }, to: '/settings/mediaservers' },
      { get label() { return t('common.subtitles'); }, to: '/settings/subtitles' },
      { get label() { return t('common.vpn'); }, to: '/settings/vpn' },
      { get label() { return t('common.general'); }, to: '/settings/general' },
      { get label() { return t('common.security'); }, to: '/settings/security' },
      { get label() { return t('common.requests'); }, to: '/settings/requests' },
      { get label() { return t('nav.discordBot'); }, to: '/settings/discordbot' },
      { get label() { return t('common.users'); }, to: '/settings/users' },
      { get label() { return t('common.updates'); }, to: '/settings/updates' },
    ],
  },
  {
    get label() {
      return t('common.system');
    },
    adminOnly: true,
    to: '/system/status',
    base: '/system',
    rail: 'SY',
    children: [
      { get label() { return t('common.status'); }, to: '/system/status' },
      { get label() { return t('common.tasks'); }, to: '/system/tasks' },
      { get label() { return t('common.logs'); }, to: '/system/logs' },
      { get label() { return t('common.backups'); }, to: '/system/backup' },
      { get label() { return t('nav.health'); }, to: '/system/health' },
      { get label() { return t('common.import'); }, to: '/system/migrate' },
      { get label() { return t('common.updates'); }, to: '/system/updates' },
      { get label() { return t('nav.stats'); }, to: '/system/stats' },
      { get label() { return t('common.feeds'); }, to: '/system/feeds' },
      { get label() { return t('nav.audit'); }, to: '/system/audit' },
    ],
  },
  // In-app docs for health check fixes (the checks' wikiUrl targets), under the System rail code.
  { get label() { return t('nav.healthDocs'); }, to: '/docs/system/health', base: '/docs', rail: 'SY', adminOnly: true },
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
  { code: 'DB', get label() { return t('nav.dash'); }, get title() { return t('common.dashboard'); } },
  { code: 'LB', get label() { return t('nav.lib'); }, get title() { return t('common.library'); } },
  { code: 'DS', get label() { return t('nav.disc'); }, get title() { return t('common.discover'); } },
  { code: 'RQ', get label() { return t('nav.req'); }, get title() { return t('common.requests'); } },
  { code: 'CL', get label() { return t('nav.cal'); }, get title() { return t('common.calendar'); } },
  { code: 'WN', get label() { return t('nav.want'); }, get title() { return t('common.wanted'); } },
  { code: 'AC', get label() { return t('nav.act'); }, get title() { return t('common.activity'); } },
  { code: 'SB', get label() { return t('nav.subs'); }, get title() { return t('common.subtitles'); } },
  { code: 'IX', get label() { return t('nav.indx'); }, get title() { return t('common.indexers'); } },
  { code: 'ST', get label() { return t('nav.set'); }, get title() { return t('common.settings'); } },
  { code: 'SY', get label() { return t('nav.sys'); }, get title() { return t('common.system'); } },
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
  for (const navLeaf of tabs) {
    const hit = pathname === navLeaf.to || (navLeaf.to !== '/' && pathname.startsWith(`${navLeaf.to}/`));
    if (hit && (!best || navLeaf.to.length > best.to.length)) best = navLeaf;
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
    { id: 'home', label: t('nav.home'), href: '/', icon: 'home' },
    { id: 'library', label: t('common.library'), href: '/library/tv', icon: 'library' },
    { id: 'discover', label: t('common.discover'), href: '/discover', icon: 'discover' },
    isAdmin
      ? { id: 'activity', label: t('common.activity'), href: '/activity/queue', icon: 'activity' }
      : { id: 'requests', label: t('common.requests'), href: '/requests', icon: 'inbox' },
    { id: 'more', label: t('common.more'), href: null, icon: 'more' },
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
