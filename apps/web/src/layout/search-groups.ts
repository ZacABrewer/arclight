import type { DiscoverItem, ScheduledJob } from '@arclight/shared';
import type { ResultGroup, ResultItem } from '../arclight/index.js';
import { NAV, visibleNav, type NavLeaf } from '../nav.js';
import { libraryMatches, type LibraryMatch } from './search-matches.js';
import { t } from '../i18n/index.js';

// Pure builders for the global search overlay and the command palette. The shell components
// fetch the data and pass a `go` callback; everything here is plain data in, groups out.

/** Navigation target the shell resolves with the router. */
export type Target =
  | { to: '/library/series/$id' | '/library/movie/$id'; params: { id: string } }
  | { to: '/discover/tv/$tmdbId' | '/discover/movie/$tmdbId'; params: { tmdbId: string } }
  | { to: '/search' | '/discover/search'; search: { q: string } }
  | { to: string };

interface Titled {
  id: number;
  title: string;
  year?: number | null | undefined;
  sortTitle?: string | undefined;
}

export interface SearchInput {
  query: string;
  series: readonly Titled[];
  movies: readonly Titled[];
  /** TMDB results from /discover/search (titles; the api drops people). */
  discover?: readonly DiscoverItem[] | undefined;
  isAdmin: boolean;
  go: (target: Target) => void;
  /** Max rows per group. */
  limit?: number | undefined;
}

function norm(s: string): string {
  return s.toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '').trim();
}

/** Every word of the query appears in the text. */
export function matchesWords(text: string, query: string): boolean {
  const q = norm(query);
  if (!q) return false;
  const item = norm(text);
  return q.split(/\s+/).every((w) => item.includes(w));
}

/** Settings and System pages a role may open, as "Settings › Indexers" search targets. */
export function settingsPages(isAdmin: boolean): Array<NavLeaf & { section: string }> {
  return visibleNav(isAdmin, NAV)
    .filter((s) => s.rail === 'ST' || s.rail === 'SY')
    .flatMap((s) => (s.children ?? []).map((c) => ({ ...c, section: s.label })));
}

function libraryItem(m: LibraryMatch, go: SearchInput['go']): ResultItem {
  return {
    id: `${m.kind}-${m.id}`,
    label: m.title,
    meta: m.year ? t('layout.searchGroups.yearInLibrary', { year: m.year }) : t('common.inLibrary'),
    onSelect: () => go({ to: m.kind === 'series' ? '/library/series/$id' : '/library/movie/$id', params: { id: String(m.id) } }),
  };
}

function discoverItem(d: DiscoverItem, go: SearchInput['go']): ResultItem {
  const inLibrary = d.libraryId != null;
  return {
    id: `tmdb-${d.mediaType}-${d.tmdbId}`,
    label: d.title,
    meta: `${d.year ? `${d.year} · ` : ''}${inLibrary ? 'In library' : 'TMDB'}`,
    onSelect: () =>
      inLibrary
        ? go({ to: d.mediaType === 'series' ? '/library/series/$id' : '/library/movie/$id', params: { id: String(d.libraryId) } })
        : go({ to: d.mediaType === 'series' ? '/discover/tv/$tmdbId' : '/discover/movie/$tmdbId', params: { tmdbId: String(d.tmdbId) } }),
  };
}

/**
 * Global search groups, in order: Series, Movies, People, Settings, then the indexer search
 * row (admins). Library matches come before TMDB titles; a TMDB title already listed from the
 * library is not repeated. Empty groups are dropped.
 */
export function buildSearchGroups({ query, series, movies, discover = [], isAdmin, go, limit = 6 }: SearchInput): ResultGroup[] {
  const q = query.trim();
  if (!q) return [];
  const lib = libraryMatches(q, series, movies, limit * 2);
  const libSeries = lib.filter((m) => m.kind === 'series');
  const libMovies = lib.filter((m) => m.kind === 'movie');
  const seen = (kind: 'series' | 'movie', libraryId: number | null | undefined) =>
    libraryId != null && (kind === 'series' ? libSeries : libMovies).some((m) => m.id === libraryId);
  const tmdb = (kind: 'series' | 'movie') => discover.filter((d) => d.mediaType === kind && !seen(kind, d.libraryId));

  const groups: ResultGroup[] = [
    { label: t('common.series'), items: [...libSeries.map((m) => libraryItem(m, go)), ...tmdb('series').map((d) => discoverItem(d, go))].slice(0, limit) },
    { label: t('common.movies'), items: [...libMovies.map((m) => libraryItem(m, go)), ...tmdb('movie').map((d) => discoverItem(d, go))].slice(0, limit) },
    {
      label: t('layout.searchGroups.people'),
      items: [{ id: 'people', label: t('layout.searchGroups.findPeopleNamedQ', { q }), meta: t('common.discover'), onSelect: () => go({ to: '/discover/search', search: { q } }) }],
    },
    {
      label: t('common.settings'),
      items: settingsPages(isAdmin)
        .filter((p) => matchesWords(`${p.section} ${p.label}`, q))
        .slice(0, limit)
        .map((p) => ({ id: `nav-${p.to}`, label: p.label, meta: p.section, onSelect: () => go({ to: p.to }) })),
    },
  ];
  if (isAdmin) {
    groups.push({
      label: t('common.indexers'),
      items: [{ id: 'indexers', label: t('layout.searchGroups.searchIndexersForQ', { q }), hint: '↵', onSelect: () => go({ to: '/search', search: { q } }) }],
    });
  }
  return groups.filter((g) => g.items.length > 0);
}

export interface CommandInput {
  query: string;
  isAdmin: boolean;
  go: (target: Target) => void;
  /** Switch the palette to the task list (keeps it open). */
  openTasks: () => void;
  openShortcuts: () => void;
}

/** Command palette: Actions, then Navigate (every page the role can open), filtered by the query. */
export function buildCommandGroups({ query, isAdmin, go, openTasks, openShortcuts }: CommandInput): ResultGroup[] {
  const q = query.trim();
  const actions: ResultItem[] = isAdmin
    ? [
        { id: 'add-series', label: t('layout.searchGroups.addSeries'), onSelect: () => go({ to: '/library/add' }) },
        { id: 'add-movie', label: t('layout.searchGroups.addMovie'), onSelect: () => go({ to: '/library/add' }) },
        { id: 'search', label: q ? t('layout.searchGroups.searchIndexersForQ', { q }) : t('layout.searchGroups.searchIndexers'), hint: '/', onSelect: () => go({ to: '/search', search: { q } }) },
        { id: 'run-task', label: t('layout.searchGroups.runTask'), onSelect: openTasks },
        { id: 'manual-import', label: t('layout.searchGroups.importFilesManually'), onSelect: () => go({ to: '/activity/manual-import' }) },
        { id: 'shortcuts', label: t('layout.searchGroups.showKeyboardShortcuts'), hint: '?', onSelect: openShortcuts },
      ]
    : [
        { id: 'request', label: t('layout.searchGroups.requestATitle'), onSelect: () => go({ to: '/discover' }) },
        { id: 'shortcuts', label: t('layout.searchGroups.showKeyboardShortcuts'), hint: '?', onSelect: openShortcuts },
      ];
  const pages: ResultItem[] = visibleNav(isAdmin, NAV).flatMap((s) =>
    (s.children ?? [{ label: s.label, to: s.to }]).map((c) => ({
      id: `go-${c.to}`,
      label: s.children ? `${s.label} › ${c.label}` : c.label,
      meta: t('layout.searchGroups.goTo'),
      onSelect: () => go({ to: c.to }),
    })),
  );
  // The search action always matches (it carries the query); others filter by label.
  const keep = (i: ResultItem) => !q || i.id === 'search' || matchesWords(String(i.label), q);
  return [
    { label: t('common.actions'), items: actions.filter(keep) },
    { label: t('layout.searchGroups.navigate'), items: pages.filter(keep) },
  ].filter((g) => g.items.length > 0);
}

/** "Run task…" second step: scheduled jobs filtered by the query. */
export function buildTaskGroups(query: string, jobs: readonly ScheduledJob[], run: (name: string) => void): ResultGroup[] {
  const q = query.trim();
  const items = jobs
    .filter((j) => !q || matchesWords(j.name, q))
    .map((j) => ({ id: `task-${j.name}`, label: j.name, meta: j.enabled ? j.interval : t('common.disabled'), onSelect: () => run(j.name) }));
  return items.length ? [{ label: t('layout.searchGroups.runTask2'), items }] : [];
}
