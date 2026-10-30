import { rankMatches, type ArtistSearchResult, type AuthorSearchResult, type DiscoverItem, type UniversalSearchHit, type UniversalSearchKind, type UniversalSearchResponse } from '@arclight/shared';
import type { ResultGroup, ResultItem } from '../../arclight/index.js';
import { t } from '../../i18n/index.js';
import type { PaletteRow } from '../command-palette/matcher.js';
import type { PageEntry, PageGroup } from './page-index.js';

// Pure builder for the topbar universal search: the static page index, the action registry's
// matches, the server's local lookups (GET /search/universal) and the debounced discover
// lookups, as grouped rows. Each group shows a few rows and a "See all N" row that expands it.

export type SearchGroupId = 'actions' | 'library' | 'discover' | 'settings' | 'activity' | 'requests' | 'system' | 'docs' | 'pages';

// Your own things first; Discover (titles not in the library, matched loosely by the providers) last.
export const GROUP_ORDER: readonly SearchGroupId[] = ['actions', 'library', 'settings', 'activity', 'requests', 'system', 'docs', 'pages', 'discover'];

/** Rows shown per group until "See all". */
export const COLLAPSED_ROWS = 5;

export const KIND_GROUP: Record<UniversalSearchKind, SearchGroupId> = {
  series: 'library',
  movie: 'library',
  episode: 'library',
  artist: 'library',
  album: 'library',
  author: 'library',
  book: 'library',
  indexer: 'settings',
  downloadClient: 'settings',
  notification: 'settings',
  importList: 'settings',
  qualityProfile: 'settings',
  customFormat: 'settings',
  user: 'settings',
  tag: 'settings',
  task: 'system',
  queue: 'activity',
  history: 'activity',
  request: 'requests',
  issue: 'requests',
};

const PAGE_GROUP: Record<PageGroup, SearchGroupId> = { settings: 'settings', system: 'system', docs: 'docs', pages: 'pages' };

/** A router target (`to` with optional params / search). */
export interface SearchTarget {
  to: string;
  params?: Record<string, string>;
  search?: Record<string, string>;
}

/** Where a server hit opens. Portal users go to the portal twins of requests and issues. */
export function hitTarget(hit: Pick<UniversalSearchHit, 'kind' | 'id' | 'parentId'>, opts: { manageRequests: boolean; viewIssues: boolean }): SearchTarget {
  const id = String(hit.id);
  switch (hit.kind) {
    case 'series':
      return { to: '/library/series/$id', params: { id } };
    case 'movie':
      return { to: '/library/movie/$id', params: { id } };
    case 'episode':
      return { to: '/library/series/$id', params: { id: String(hit.parentId ?? '') } };
    case 'artist':
      return { to: '/library/music/artist/$id', params: { id } };
    case 'album':
      return { to: '/library/music/album/$id', params: { id } };
    case 'author':
      return { to: '/library/audiobooks/author/$id', params: { id } };
    case 'book':
      return { to: '/library/audiobooks/book/$id', params: { id } };
    case 'indexer':
      return { to: '/settings/indexers' };
    case 'downloadClient':
      return { to: '/settings/downloadclients' };
    case 'notification':
      return { to: '/settings/notifications' };
    case 'importList':
      return { to: '/settings/importlists' };
    case 'qualityProfile':
      return { to: '/settings/profiles' };
    case 'customFormat':
      return { to: '/settings/customformats' };
    case 'user':
      return { to: '/settings/users' };
    case 'tag':
      return { to: '/settings/tags' };
    case 'task':
      return { to: '/system/tasks' };
    case 'queue':
      return { to: '/activity/queue' };
    case 'history':
      return { to: '/activity/history' };
    case 'request':
      return opts.manageRequests ? { to: '/requests' } : { to: '/portal/requests' };
    case 'issue':
      return opts.viewIssues ? { to: '/issues/$id', params: { id } } : { to: '/portal/issues/$id', params: { id } };
  }
}

export function groupLabel(id: SearchGroupId): string {
  switch (id) {
    case 'actions':
      return t('common.actions');
    case 'library':
      return t('common.library');
    case 'discover':
      return t('common.discover');
    case 'settings':
      return t('common.settings');
    case 'activity':
      return t('common.activity');
    case 'requests':
      return t('universalSearch.group.requests');
    case 'system':
      return t('common.system');
    case 'docs':
      return t('universalSearch.group.docs');
    case 'pages':
      return t('universalSearch.group.pages');
  }
}

export function kindLabel(kind: UniversalSearchKind): string {
  return t(`universalSearch.kind.${kind}`);
}

const KNOWN_STATUS = new Set(['monitored', 'unmonitored', 'downloaded', 'missing', 'paused', 'queued', 'downloading', 'failed']);

/** "Movie · 2021 · Missing". */
export function hitMeta(hit: UniversalSearchHit): string {
  return [kindLabel(hit.kind), hit.subtitle, hit.status && KNOWN_STATUS.has(hit.status) ? t(`status.${hit.status}`) : null].filter(Boolean).join(' · ');
}

export interface DiscoverResults {
  tmdb?: readonly DiscoverItem[] | undefined;
  artists?: readonly ArtistSearchResult[] | undefined;
  authors?: readonly AuthorSearchResult[] | undefined;
}

export interface UniversalInput {
  query: string;
  pages: readonly PageEntry[];
  actions: readonly PaletteRow[];
  server?: UniversalSearchResponse | undefined;
  discover?: DiscoverResults | undefined;
  isAdmin: boolean;
  manageRequests: boolean;
  viewIssues: boolean;
  expanded: ReadonlySet<SearchGroupId>;
  go: (target: SearchTarget) => void;
  onAction: (row: PaletteRow) => boolean;
  actionLabel: (row: PaletteRow) => string;
  toggle: (id: SearchGroupId) => void;
  poster?: (url: string, title: string) => ResultItem['leading'];
}

interface Pending {
  id: SearchGroupId;
  items: ResultItem[];
  /** Matches known (may exceed the rows fetched). */
  total: number;
}

/** Grouped rows, in GROUP_ORDER; empty groups dropped. */
export function buildUniversalGroups(input: UniversalInput): ResultGroup[] {
  const q = input.query.trim();
  if (!q) return [];
  const acc = new Map<SearchGroupId, Pending>(GROUP_ORDER.map((id) => [id, { id, items: [], total: 0 }]));
  const push = (id: SearchGroupId, item: ResultItem, total = 1) => {
    const g = acc.get(id)!;
    g.items.push(item);
    g.total += total;
  };

  // Actions from the palette's registry ("refresh dune", "approve all").
  for (const row of input.actions.slice(0, 6)) {
    const staysOpen = (row.action.target?.type === 'item' && !row.item) || row.action.destructive === true;
    push('actions', {
      id: `action-${row.action.id}-${row.item ? `${row.item.kind}${row.item.id}` : ''}-${row.text ?? ''}`,
      label: input.actionLabel(row),
      meta: t('universalSearch.meta.action'),
      keepOpen: staysOpen,
      onSelect: () => void input.onAction(row),
    });
  }

  // Server lookups: the server ranked each kind; kinds keep the contract's order.
  const opts = { manageRequests: input.manageRequests, viewIssues: input.viewIssues };
  for (const result of input.server?.results ?? []) {
    const gid = KIND_GROUP[result.kind];
    const g = acc.get(gid)!;
    g.total += result.total - result.hits.length;
    for (const hit of result.hits) {
      push(gid, {
        id: `hit-${hit.kind}-${hit.id}`,
        label: hit.title,
        meta: hitMeta(hit),
        leading: hit.poster && input.poster ? input.poster(hit.poster, hit.title) : undefined,
        onSelect: () => input.go(hitTarget(hit, opts)),
      });
    }
  }

  // Pages (settings sections, system pages, docs), ranked with the shared matcher.
  for (const { item: p } of rankMatches(q, input.pages, (p) => p.label, (p) => p.keywords)) {
    push(PAGE_GROUP[p.group], { id: `page-${p.to}`, label: p.label, meta: p.section, onSelect: () => input.go({ to: p.to }) });
  }

  // Discover: titles not in the library, to add (admins) or request.
  const d = input.discover;
  for (const item of d?.tmdb ?? []) {
    if (item.libraryId != null) continue;
    const kind = item.mediaType === 'series' ? 'tv' : 'movie';
    const base = input.isAdmin ? '/discover' : '/portal';
    push('discover', {
      id: `tmdb-${item.mediaType}-${item.tmdbId}`,
      label: item.title,
      meta: [item.year ? String(item.year) : null, item.mediaType === 'series' ? t('universalSearch.kind.series') : t('universalSearch.kind.movie'), input.isAdmin ? t('universalSearch.meta.add') : t('universalSearch.meta.request')].filter(Boolean).join(' · '),
      onSelect: () => input.go({ to: `${base}/${kind}/$tmdbId`, params: { tmdbId: String(item.tmdbId) } }),
    });
  }
  if (input.isAdmin) {
    for (const a of d?.artists ?? []) {
      if (a.artistId != null) continue;
      push('discover', {
        id: `mb-${a.mbArtistId}`,
        label: a.name,
        meta: [a.disambiguation, t('universalSearch.kind.artist'), t('universalSearch.meta.add')].filter(Boolean).join(' · '),
        onSelect: () => input.go({ to: '/library/add', search: { type: 'music', term: a.name } }),
      });
    }
    for (const a of d?.authors ?? []) {
      if (a.authorId != null) continue;
      push('discover', {
        id: `author-${a.asin ?? a.olAuthorId ?? a.name}`,
        label: a.name,
        meta: [t('universalSearch.kind.author'), t('universalSearch.meta.add')].join(' · '),
        onSelect: () => input.go({ to: '/library/add', search: { type: 'audiobook', term: a.name } }),
      });
    }
  }
  // People and the indexer search stay one keypress away.
  push('discover', { id: 'people', label: t('layout.searchGroups.findPeopleNamedQ', { q }), meta: t('common.discover'), onSelect: () => input.go({ to: input.isAdmin ? '/discover/search' : '/portal/search', search: { q } }) }, 0);
  if (input.isAdmin) push('discover', { id: 'indexers', label: t('layout.searchGroups.searchIndexersForQ', { q }), meta: t('common.indexers'), onSelect: () => input.go({ to: '/search', search: { q } }) }, 0);

  return GROUP_ORDER.flatMap((id) => {
    const g = acc.get(id)!;
    if (g.items.length === 0) return [];
    const open = input.expanded.has(id);
    const items = open ? g.items : g.items.slice(0, COLLAPSED_ROWS);
    const hidden = Math.max(g.items.length, g.total) > items.length;
    if (hidden && !open) {
      items.push({ id: `more-${id}`, label: t('universalSearch.seeAll', { count: Math.max(g.total, g.items.length) }), keepOpen: true, onSelect: () => input.toggle(id) });
    }
    return [{ label: groupLabel(id), items }];
  });
}
