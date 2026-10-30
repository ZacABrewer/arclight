import { useEffect, useMemo, useState } from 'react';
import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { useNavigate } from '@tanstack/react-router';
import { audiobooksApi } from '../../api/audiobooks.js';
import { errorMessage } from '../../api/client.js';
import { musicApi } from '../../api/music.js';
import { discoverApi } from '../../api/requests.js';
import { searchApi } from '../../api/search.js';
import { GlobalSearchOverlay } from '../../arclight/index.js';
import { canManageRequestsIn, canViewIssuesIn } from '../../auth/access.js';
import { useAuth } from '../../auth/auth-context.js';
import { useToast } from '../../components/toast.js';
import { useFeatures } from '../../hooks/music.js';
import { useNav } from '../../layout/use-nav.js';
import { t } from '../../i18n/index.js';
import { InteractiveSearchModal } from '../../pages/library/interactive-search.js';
import { matchCommands, type PaletteRow } from '../command-palette/matcher.js';
import { rowLabel } from '../command-palette/palette.js';
import { pushRecent } from '../command-palette/recent.js';
import { usePaletteContextEntries, type PaletteItem } from '../command-palette/registry.js';
import { OPEN_ACTION_ID, usePaletteActions } from '../command-palette/use-palette-actions.js';
import { buildUniversalGroups, type SearchGroupId, type SearchTarget } from './groups.js';
import { pageIndex } from './page-index.js';

// The topbar search ("/"): one box over the library, discover, settings pages and entities,
// activity, requests and issues, system pages, the in-app docs and the command palette's
// actions. Local matches (pages, actions) show at once; the server lookups follow a short
// debounce and the remote discover lookups a longer one, from three characters.

function useDebounced<T>(value: T, ms: number): T {
  const [v, setV] = useState(value);
  useEffect(() => {
    const timer = setTimeout(() => setV(value), ms);
    return () => clearTimeout(timer);
  }, [value, ms]);
  return v;
}

/** Characters before the remote discover lookups (TMDB, MusicBrainz, Audible) run. */
export const DISCOVER_MIN_CHARS = 3;

export interface UniversalSearchProps {
  open: boolean;
  onClose: () => void;
  /** Continue in the command palette (actions that need a target or a confirmation). */
  openPalette: (query: string) => void;
  onShortcuts: () => void;
  /** Debounce of the server lookups (ms). */
  debounceMs?: number;
  /** Debounce of the discover lookups (ms). */
  discoverDebounceMs?: number;
}

export function UniversalSearch({ open, onClose, openPalette, onShortcuts, debounceMs = 150, discoverDebounceMs = 350 }: UniversalSearchProps) {
  const navigate = useNavigate();
  const toast = useToast();
  const { access, isAdmin } = useAuth();
  const features = useFeatures();
  const nav = useNav();
  const [query, setQuery] = useState('');
  const [expanded, setExpanded] = useState<ReadonlySet<SearchGroupId>>(new Set());
  const [interactive, setInteractive] = useState<PaletteItem | null>(null);
  const q = query.trim();
  const debounced = useDebounced(q, debounceMs);
  const remote = useDebounced(q, discoverDebounceMs);
  const discoverTerm = remote.length >= DISCOVER_MIN_CHARS ? remote : '';

  useEffect(() => {
    if (!open) setQuery('');
  }, [open]);
  useEffect(() => setExpanded(new Set()), [q]);

  const { actions, items } = usePaletteActions(open, { interactiveSearch: setInteractive, openShortcuts: onShortcuts });
  const contexts = usePaletteContextEntries();

  const server = useQuery({
    queryKey: ['search', 'universal', debounced],
    queryFn: () => searchApi.universal({ q: debounced }),
    enabled: open && debounced.length > 0,
    retry: false,
    staleTime: 30_000,
    placeholderData: keepPreviousData,
  });
  const tmdb = useQuery({
    queryKey: ['discover', 'search', 'overlay', discoverTerm],
    queryFn: () => discoverApi.search(discoverTerm),
    enabled: open && discoverTerm !== '',
    retry: false,
    staleTime: 60_000,
  });
  const artists = useQuery({
    queryKey: ['musicLookup', discoverTerm],
    queryFn: () => musicApi.artists.lookup(discoverTerm),
    enabled: open && isAdmin && features.music && discoverTerm !== '',
    retry: false,
    staleTime: 60_000,
  });
  const authors = useQuery({
    queryKey: ['audiobookLookup', 'author', discoverTerm],
    queryFn: () => audiobooksApi.authors.lookup(discoverTerm),
    enabled: open && isAdmin && features.audiobooks && discoverTerm !== '',
    retry: false,
    staleTime: 60_000,
  });

  const pages = useMemo(() => pageIndex(access, nav), [access, nav]);

  const go = (target: SearchTarget) => void navigate(target as never);

  /** An action row: run it here, or hand over to the palette for a target or a confirmation. */
  const onAction = (row: PaletteRow): boolean => {
    const needsMore = (row.action.target?.type === 'item' && !row.item) || row.action.destructive === true;
    if (needsMore) {
      onClose();
      openPalette(query);
      return true;
    }
    pushRecent({ actionId: row.action.id, ...(row.item ? { item: row.item } : {}), ...(row.text ? { text: row.text } : {}) });
    try {
      const out = row.action.run({ item: row.item, text: row.text });
      if (out instanceof Promise) out.catch((err: unknown) => toast.push({ tone: 'error', title: row.action.label, message: errorMessage(err) }));
    } catch (err) {
      toast.push({ tone: 'error', title: row.action.label, message: errorMessage(err) });
    }
    return false;
  };

  const actionRows = useMemo(() => {
    if (!q) return [];
    // Bare names are library hits here (the server answers those), so no "Open" fallback rows.
    return matchCommands({
      query: q,
      actions: actions.filter((a) => a.id !== OPEN_ACTION_ID && a.group !== 'navigate'),
      items,
      subjects: contexts.flatMap((c) => (c.subject ? [c.subject] : [])),
      contextActions: contexts.flatMap((c) => c.actions ?? []),
      limit: 6,
    }).filter((r) => r.score >= 20);
  }, [q, actions, items, contexts]);

  const groups = buildUniversalGroups({
    query: q,
    pages,
    actions: actionRows,
    server: server.data,
    discover: discoverTerm ? { tmdb: tmdb.data?.results, artists: artists.data, authors: authors.data } : undefined,
    isAdmin,
    manageRequests: canManageRequestsIn(access),
    viewIssues: canViewIssuesIn(access),
    expanded,
    go,
    onAction,
    actionLabel: rowLabel,
    toggle: (id) => setExpanded((cur) => new Set([...cur, id])),
    poster: (url) => <img className="al-cmd__thumb" src={url} alt="" loading="lazy" />,
  });
  const count = groups.reduce((n, g) => n + g.items.length, 0);

  return (
    <>
      <GlobalSearchOverlay
        open={open}
        onClose={onClose}
        query={query}
        onQueryChange={setQuery}
        groups={groups}
        placeholder={t('universalSearch.placeholder')}
        hint={t('universalSearch.hint')}
        loading={server.isFetching || tmdb.isFetching || artists.isFetching || authors.isFetching}
        status={q ? t('palette.status.results', { count }) : undefined}
      />
      <InteractiveSearchModal
        target={interactive ? (interactive.kind === 'movie' ? { movieId: interactive.id } : { seriesId: interactive.id }) : null}
        title={interactive?.title ?? ''}
        onClose={() => setInteractive(null)}
      />
    </>
  );
}
