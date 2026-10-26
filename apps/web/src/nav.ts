import type { AppPath } from './router.js';

// The sidebar tree. Labels here are also the titles of the ComingSoon placeholders, so a
// route's name is written once. `phase` tells the placeholder which roadmap phase builds it.

export interface NavLeaf {
  label: string;
  to: AppPath;
  phase?: string;
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
  { label: 'Discover', to: '/discover', glyph: '✦', phase: 'Phase 4' },
  { label: 'Requests', to: '/requests', glyph: '✉', phase: 'Phase 4' },
  { label: 'Calendar', to: '/calendar', glyph: '▦' },
  {
    label: 'Activity',
    to: '/activity/queue',
    base: '/activity',
    glyph: '⇅',
    children: [
      { label: 'Queue', to: '/activity/queue' },
      { label: 'History', to: '/activity/history' },
      { label: 'Blocklist', to: '/activity/blocklist' },
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
  { label: 'Subtitles', to: '/subtitles', glyph: '❝', phase: 'Phase 3' },
  { label: 'Indexers', to: '/indexers', glyph: '⌕', phase: 'Phase 1' },
  {
    label: 'Settings',
    to: '/settings/mediamanagement',
    base: '/settings',
    glyph: '⚙',
    children: [
      { label: 'Media Management', to: '/settings/mediamanagement' },
      { label: 'Profiles', to: '/settings/profiles' },
      { label: 'Quality', to: '/settings/quality' },
      { label: 'Custom Formats', to: '/settings/customformats' },
      { label: 'Indexers', to: '/settings/indexers' },
      { label: 'Download Clients', to: '/settings/downloadclients' },
      { label: 'Notifications', to: '/settings/notifications' },
      { label: 'General', to: '/settings/general' },
    ],
  },
  {
    label: 'System',
    to: '/system/status',
    base: '/system',
    glyph: '⌘',
    children: [
      { label: 'Status', to: '/system/status' },
      { label: 'Tasks', to: '/system/tasks' },
      { label: 'Logs', to: '/system/logs' },
      { label: 'Health', to: '/system/health' },
    ],
  },
];

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
