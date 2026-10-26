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
      { label: 'TV', to: '/library/tv', phase: 'Phase 1' },
      { label: 'Movies', to: '/library/movies', phase: 'Phase 1' },
    ],
  },
  { label: 'Discover', to: '/discover', glyph: '✦', phase: 'Phase 4' },
  { label: 'Requests', to: '/requests', glyph: '✉', phase: 'Phase 4' },
  { label: 'Calendar', to: '/calendar', glyph: '▦', phase: 'Phase 1' },
  {
    label: 'Activity',
    to: '/activity/queue',
    base: '/activity',
    glyph: '⇅',
    children: [
      { label: 'Queue', to: '/activity/queue', phase: 'Phase 1' },
      { label: 'History', to: '/activity/history', phase: 'Phase 1' },
      { label: 'Blocklist', to: '/activity/blocklist', phase: 'Phase 1' },
    ],
  },
  {
    label: 'Wanted',
    to: '/wanted/missing',
    base: '/wanted',
    glyph: '☆',
    children: [
      { label: 'Missing', to: '/wanted/missing', phase: 'Phase 1' },
      { label: 'Cutoff Unmet', to: '/wanted/cutoff-unmet', phase: 'Phase 1' },
    ],
  },
  { label: 'Subtitles', to: '/subtitles', glyph: '❝', phase: 'Phase 3' },
  { label: 'Indexers', to: '/indexers', glyph: '⌕', phase: 'Phase 1' },
  {
    label: 'Settings',
    to: '/settings/media-management',
    base: '/settings',
    glyph: '⚙',
    children: [
      { label: 'Media Management', to: '/settings/media-management', phase: 'Phase 1' },
      { label: 'Profiles', to: '/settings/profiles', phase: 'Phase 1' },
      { label: 'Quality', to: '/settings/quality', phase: 'Phase 1' },
      { label: 'Custom Formats', to: '/settings/custom-formats', phase: 'Phase 1' },
      { label: 'Indexers', to: '/settings/indexers', phase: 'Phase 1' },
      { label: 'Download Clients', to: '/settings/download-clients', phase: 'Phase 1' },
      { label: 'Notifications', to: '/settings/notifications', phase: 'Phase 1' },
      { label: 'General', to: '/settings/general', phase: 'Phase 1' },
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
      { label: 'Logs', to: '/system/logs', phase: 'Phase 1' },
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
