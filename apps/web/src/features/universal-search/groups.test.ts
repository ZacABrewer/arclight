import { describe, expect, it, vi } from 'vitest';
import type { UniversalSearchHit, UniversalSearchResponse } from '@arclight/shared';
import { NAV } from '../../nav.js';
import { buildUniversalGroups, COLLAPSED_ROWS, hitTarget, type UniversalInput } from './groups.js';
import { pageIndex } from './page-index.js';

const hit = (over: Partial<UniversalSearchHit> & Pick<UniversalSearchHit, 'kind' | 'id' | 'title'>): UniversalSearchHit => ({ subtitle: null, poster: null, status: null, parentId: null, score: 1, ...over });

const base = (over: Partial<UniversalInput> = {}): UniversalInput => ({
  query: 'dune',
  pages: pageIndex(true, NAV),
  actions: [],
  isAdmin: true,
  manageRequests: true,
  viewIssues: true,
  expanded: new Set(),
  go: vi.fn(),
  onAction: vi.fn(() => false),
  actionLabel: (r) => r.action.label,
  toggle: vi.fn(),
  ...over,
});

describe('universal search groups', () => {
  it('orders the groups and maps each kind to its group', () => {
    const server: UniversalSearchResponse = {
      query: 'dune',
      results: [
        { kind: 'movie', total: 1, hits: [hit({ kind: 'movie', id: 1, title: 'Dune', status: 'missing', subtitle: '2021' })] },
        { kind: 'indexer', total: 1, hits: [hit({ kind: 'indexer', id: 2, title: 'Dune Tracker' })] },
        { kind: 'queue', total: 1, hits: [hit({ kind: 'queue', id: 3, title: 'Dune.2021.2160p' })] },
        { kind: 'request', total: 1, hits: [hit({ kind: 'request', id: 4, title: 'Dune Messiah' })] },
      ],
    };
    const groups = buildUniversalGroups(base({ server }));
    expect(groups.map((g) => g.label)).toEqual(['Library', 'Settings', 'Activity', 'Requests and issues', 'Discover']);
    expect(groups[0]!.items[0]!.meta).toBe('Movie · 2021 · Missing');
  });

  it('shows a few rows and a "See all N" row that expands the group', () => {
    const hits = Array.from({ length: 8 }, (_, i) => hit({ kind: 'movie', id: i + 1, title: `Dune ${i}` }));
    const server: UniversalSearchResponse = { query: 'dune', results: [{ kind: 'movie', total: 12, hits }] };
    const toggle = vi.fn();
    const [library] = buildUniversalGroups(base({ server, toggle }));
    expect(library!.items).toHaveLength(COLLAPSED_ROWS + 1);
    const more = library!.items.at(-1)!;
    expect(more.label).toBe('See all 12');
    expect(more.keepOpen).toBe(true);
    more.onSelect();
    expect(toggle).toHaveBeenCalledWith('library');
    const [open] = buildUniversalGroups(base({ server, expanded: new Set(['library']) }));
    expect(open!.items).toHaveLength(8);
  });

  it('finds settings sections by their keywords, and hides settings from portal users', () => {
    const admin = buildUniversalGroups(base({ query: 'qbittorrent' }));
    expect(admin.find((g) => g.label === 'Settings')?.items[0]?.label).toBe('Download Clients');
    const portal = buildUniversalGroups(base({ query: 'qbittorrent', pages: pageIndex(false, NAV), isAdmin: false }));
    expect(portal.find((g) => g.label === 'Settings')).toBeUndefined();
  });

  it('sends portal users to the portal twins of requests and issues', () => {
    expect(hitTarget({ kind: 'request', id: 4, parentId: null }, { manageRequests: false, viewIssues: false })).toEqual({ to: '/portal/requests' });
    expect(hitTarget({ kind: 'issue', id: 5, parentId: null }, { manageRequests: false, viewIssues: false })).toEqual({ to: '/portal/issues/$id', params: { id: '5' } });
    expect(hitTarget({ kind: 'episode', id: 9, parentId: 3 }, { manageRequests: true, viewIssues: true })).toEqual({ to: '/library/series/$id', params: { id: '3' } });
  });

  it('offers discover titles that are not in the library, as Add or Request', () => {
    const tmdb = [
      { mediaType: 'movie' as const, tmdbId: 10, title: 'Dune', overview: '', mediaStatus: 'unknown' as const, mediaStatus4k: 'unknown' as const, libraryId: 1 },
      { mediaType: 'movie' as const, tmdbId: 11, title: 'Dune (1984)', overview: '', mediaStatus: 'unknown' as const, mediaStatus4k: 'unknown' as const, year: 1984 },
    ];
    const go = vi.fn();
    const discover = buildUniversalGroups(base({ discover: { tmdb }, go })).find((g) => g.label === 'Discover')!;
    expect(discover.items.map((i) => i.label)).toEqual(['Dune (1984)', 'Find people named "dune"', 'Search indexers for "dune"']);
    expect(discover.items[0]!.meta).toBe('1984 · Movie · Add');
    discover.items[0]!.onSelect();
    expect(go).toHaveBeenCalledWith({ to: '/discover/movie/$tmdbId', params: { tmdbId: '11' } });
    const portal = buildUniversalGroups(base({ discover: { tmdb }, isAdmin: false, pages: [] })).find((g) => g.label === 'Discover')!;
    expect(portal.items[0]!.meta).toBe('1984 · Movie · Request');
  });

  it('returns nothing for a blank query', () => {
    expect(buildUniversalGroups(base({ query: '   ' }))).toEqual([]);
  });
});
