import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useNavigate } from '@tanstack/react-router';
import { libraryApi } from '../api/library.js';
import { discoverApi } from '../api/requests.js';
import { CommandPalette, DEFAULT_SHORTCUTS, GlobalSearchOverlay, KeyboardSheet, useHotkey, type ShortcutGroup } from '../arclight/index.js';
import { useRunJob, useScheduledJobs } from '../hooks/jobs.js';
import { libraryKeys } from '../hooks/library-keys.js';
import { buildCommandGroups, buildSearchGroups, buildTaskGroups, type Target } from './search-groups.js';

function useDebounced<T>(value: T, ms: number): T {
  const [v, setV] = useState(value);
  useEffect(() => {
    const t = setTimeout(() => setV(value), ms);
    return () => clearTimeout(t);
  }, [value, ms]);
  return v;
}

/** Router navigation for a search/palette target. */
export function useGo() {
  const navigate = useNavigate();
  return useCallback((target: Target) => void navigate(target as never), [navigate]);
}

export interface GlobalSearchProps {
  open: boolean;
  onClose: () => void;
  isAdmin: boolean;
  /** Debounce for the TMDB search (ms). */
  debounceMs?: number;
}

/** "/" overlay: library Series / Movies, TMDB titles, People, Settings pages, indexer search. */
export function GlobalSearch({ open, onClose, isAdmin, debounceMs = 250 }: GlobalSearchProps) {
  const go = useGo();
  const [query, setQuery] = useState('');
  const q = query.trim();
  const debounced = useDebounced(q, debounceMs);
  useEffect(() => {
    if (!open) setQuery('');
  }, [open]);

  // Library lists share the library pages' cache; fetched once the overlay opens.
  const series = useQuery({ queryKey: libraryKeys.series.list(), queryFn: () => libraryApi.series.list({ includeStatistics: true }), enabled: open, retry: false });
  const movies = useQuery({ queryKey: libraryKeys.movie.list(), queryFn: () => libraryApi.movies.list(), enabled: open, retry: false });
  const discover = useQuery({
    queryKey: ['discover', 'search', 'overlay', debounced],
    queryFn: () => discoverApi.search(debounced),
    enabled: open && debounced.length >= 2,
    retry: false,
    staleTime: 60_000,
  });

  const groups = useMemo(
    () =>
      buildSearchGroups({
        query: q,
        series: series.data ?? [],
        movies: movies.data ?? [],
        discover: debounced === q ? discover.data?.results : undefined,
        isAdmin,
        go,
      }),
    [q, debounced, series.data, movies.data, discover.data, isAdmin, go],
  );

  return (
    <GlobalSearchOverlay
      open={open}
      onClose={onClose}
      query={query}
      onQueryChange={setQuery}
      groups={groups}
      placeholder="Search series, movies, people and settings"
      loading={series.isLoading || movies.isLoading || discover.isFetching}
    />
  );
}

export interface PaletteProps {
  open: boolean;
  onClose: () => void;
  isAdmin: boolean;
  onShortcuts: () => void;
}

/** Ctrl/Cmd+K: actions (add series, add movie, search, run task…) and navigation. */
export function Palette({ open, onClose, isAdmin, onShortcuts }: PaletteProps) {
  const go = useGo();
  const [query, setQuery] = useState('');
  const [mode, setMode] = useState<'commands' | 'tasks'>('commands');
  // Selecting a row closes the palette; "Run task…" sets this to stay open on the task list.
  const keepOpen = useRef(false);
  const jobs = useScheduledJobs();
  const run = useRunJob();

  useEffect(() => {
    if (!open) {
      setQuery('');
      setMode('commands');
    }
  }, [open]);

  const close = () => {
    if (keepOpen.current) {
      keepOpen.current = false;
      return;
    }
    onClose();
  };

  const groups =
    mode === 'tasks'
      ? buildTaskGroups(query, jobs.data ?? [], (name) => run.mutate(name))
      : buildCommandGroups({
          query,
          isAdmin,
          go,
          openTasks: () => {
            keepOpen.current = true;
            setQuery('');
            setMode('tasks');
          },
          openShortcuts: onShortcuts,
        });

  return (
    <CommandPalette
      open={open}
      onClose={close}
      query={query}
      onQueryChange={setQuery}
      groups={groups}
      placeholder={mode === 'tasks' ? 'Run a task' : 'Type a command or search'}
      loading={mode === 'tasks' && jobs.isLoading}
      emptyText={mode === 'tasks' ? 'No tasks match.' : 'No matches.'}
    />
  );
}

export const SHELL_SHORTCUTS: readonly ShortcutGroup[] = [
  {
    title: 'Global',
    shortcuts: [
      { keys: ['/'], label: 'Search' },
      { keys: ['Ctrl', 'K'], label: 'Command palette' },
      { keys: ['?'], label: 'Keyboard shortcuts' },
      { keys: ['Esc'], label: 'Close dialog or overlay' },
    ],
  },
  DEFAULT_SHORTCUTS[1]!,
];

/** Every global overlay plus its key binding: "/" search, Ctrl/Cmd+K palette, "?" shortcuts. */
export interface ShellOverlaysProps {
  isAdmin: boolean;
  search: boolean;
  setSearch: (open: boolean) => void;
  sheet: boolean;
  setSheet: (open: boolean) => void;
}

export function ShellOverlays({ isAdmin, search, setSearch, sheet, setSheet }: ShellOverlaysProps) {
  const [palette, setPalette] = useState(false);

  useHotkey('?', () => setSheet(true));
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && !e.altKey && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        setSearch(false);
        setPalette((p) => !p);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [setSearch]);

  return (
    <>
      <GlobalSearch open={search} onClose={() => setSearch(false)} isAdmin={isAdmin} />
      <Palette
        open={palette}
        onClose={() => setPalette(false)}
        isAdmin={isAdmin}
        onShortcuts={() => {
          setPalette(false);
          setSheet(true);
        }}
      />
      <KeyboardSheet open={sheet} onClose={() => setSheet(false)} groups={SHELL_SHORTCUTS} />
    </>
  );
}
