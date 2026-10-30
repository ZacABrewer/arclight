import { useMemo } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useNavigate } from '@tanstack/react-router';
import type { BulkSearchCommandInput, ScheduledJob } from '@arclight/shared';
import { audiobooksApi } from '../../api/audiobooks.js';
import { errorMessage } from '../../api/client.js';
import { jobsApi } from '../../api/jobs.js';
import { libraryApi } from '../../api/library.js';
import { musicApi } from '../../api/music.js';
import { requestsApi } from '../../api/requests.js';
import { torrentApi, type TorrentAction } from '../../api/torrent.js';
import { applyTheme } from '../../arclight/index.js';
import { useAuth } from '../../auth/auth-context.js';
import { useToast } from '../../components/toast.js';
import { audiobookKeys } from '../../hooks/audiobook-keys.js';
import { useAudiobookCommand, useSetAuthorMonitored, useSetBooksMonitored } from '../../hooks/audiobooks.js';
import { useBulkRename, useBulkSearch } from '../../hooks/bulk.js';
import { useHealthScan } from '../../hooks/health-scan.js';
import { useRunJob } from '../../hooks/jobs.js';
import { useAutomaticSearch, useRefreshMedia, useSetMovieMonitored, useSetSeriesMonitored } from '../../hooks/library.js';
import { libraryKeys } from '../../hooks/library-keys.js';
import { useAnalyzeMedia } from '../../hooks/media-analysis.js';
import { useFeatures, useMusicCommand, useSetArtistMonitored } from '../../hooks/music.js';
import { musicKeys } from '../../hooks/music-keys.js';
import { queryKeys } from '../../hooks/query-keys.js';
import { requestKeys } from '../../hooks/request-keys.js';
import { torrentKeys } from '../../hooks/torrent.js';
import { useSaveUiPreferences } from '../../hooks/ui-preferences.js';
import { t } from '../../i18n/index.js';
import { visibleNav } from '../../nav.js';
import { useNav } from '../../layout/use-nav.js';
import { activeThemeOf } from '../themes/resolve.js';
import { useThemeCatalog } from '../themes/use-themes.js';
import { allowedActions, type ItemKind, type PaletteAction, type PaletteItem, type RunContext } from './registry.js';

// Builds the palette's action registry from the existing API hooks: item verbs, global commands,
// navigation, scheduled tasks and themes. Lists load only while the palette is open and share the
// library pages' cache.

const KIND_PATH: Record<ItemKind, string> = {
  movie: '/library/movie/$id',
  series: '/library/series/$id',
  artist: '/library/music/artist/$id',
  author: '/library/audiobooks/author/$id',
  book: '/library/audiobooks/book/$id',
};

export function itemPath(item: Pick<PaletteItem, 'kind' | 'id'>): { to: string; params: { id: string } } {
  return { to: KIND_PATH[item.kind], params: { id: String(item.id) } };
}

/** The id of the action a bare item name runs. */
export const OPEN_ACTION_ID = 'item.open';

export interface PaletteHost {
  /** Open the interactive-search modal for a movie or series. */
  interactiveSearch: (item: PaletteItem) => void;
  openShortcuts: () => void;
}

export interface PaletteData {
  actions: PaletteAction[];
  items: PaletteItem[];
  loading: boolean;
}

const VIDEO: readonly ItemKind[] = ['movie', 'series'];
const ALL_KINDS: readonly ItemKind[] = ['movie', 'series', 'artist', 'author', 'book'];

export function usePaletteActions(open: boolean, host: PaletteHost): PaletteData {
  const navigate = useNavigate();
  const go = (to: string, extra: object = {}) => void navigate({ to, ...extra } as never);
  const toast = useToast();
  const qc = useQueryClient();
  const { access, user, isAdmin } = useAuth();
  const features = useFeatures();
  const nav = useNav();
  const library = access.admin || access.areas.includes('library');
  const admin = access.admin;

  // Library lists: the same keys (and fetchers) as the library pages, so they are usually cached.
  const series = useQuery({ queryKey: libraryKeys.series.list(), queryFn: () => libraryApi.series.list({ includeStatistics: true }), enabled: open && library, retry: false });
  const movies = useQuery({ queryKey: libraryKeys.movie.list(), queryFn: () => libraryApi.movies.list(), enabled: open && library, retry: false });
  const artists = useQuery({ queryKey: musicKeys.artists.list(), queryFn: musicApi.artists.list, enabled: open && library && features.music, retry: false });
  const authors = useQuery({ queryKey: audiobookKeys.authors.list(), queryFn: audiobooksApi.authors.list, enabled: open && admin && features.audiobooks, retry: false });
  const books = useQuery({ queryKey: [...audiobookKeys.books.all, 'palette'], queryFn: audiobooksApi.books.listAll, enabled: open && admin && features.audiobooks, retry: false, staleTime: 60_000 });
  const jobs = useQuery<ScheduledJob[]>({ queryKey: queryKeys.jobs.scheduled, queryFn: jobsApi.scheduled, enabled: open && admin, retry: false });
  const themes = useThemeCatalog();
  const engine = useQuery({ queryKey: torrentKeys.status, queryFn: torrentApi.status, enabled: open && admin, retry: false });

  const automatic = useAutomaticSearch();
  const bulkSearch = useBulkSearch();
  const refresh = useRefreshMedia();
  const musicCommand = useMusicCommand();
  const audiobookCommand = useAudiobookCommand();
  const monitorMovie = useSetMovieMonitored();
  const monitorSeries = useSetSeriesMonitored();
  const monitorArtist = useSetArtistMonitored();
  const monitorAuthor = useSetAuthorMonitored();
  const monitorBooks = useSetBooksMonitored();
  const rename = useBulkRename();
  const analyze = useAnalyzeMedia();
  const healthScan = useHealthScan();
  const runJob = useRunJob();
  const savePrefs = useSaveUiPreferences();

  const items = useMemo<PaletteItem[]>(
    () => [
      ...(series.data ?? []).map((s) => ({ kind: 'series' as const, id: s.id, title: s.title, year: s.year })),
      ...(movies.data ?? []).map((m) => ({ kind: 'movie' as const, id: m.id, title: m.title, year: m.year })),
      ...(artists.data ?? []).map((a) => ({ kind: 'artist' as const, id: a.id, title: a.name })),
      ...(authors.data ?? []).map((a) => ({ kind: 'author' as const, id: a.id, title: a.name })),
      ...(books.data ?? []).map((b) => ({ kind: 'book' as const, id: b.id, title: b.title })),
    ],
    [series.data, movies.data, artists.data, authors.data, books.data],
  );

  const done = (title: string, message?: string) => toast.push({ tone: 'ok', title, message, durationMs: 4_000 });
  const failed = (title: string, err: unknown) => toast.push({ tone: 'error', title, message: errorMessage(err) });

  /** Runs `fn` for an item; the kind-specific branches use the existing mutation hooks. */
  const need = (ctx: RunContext): PaletteItem => {
    if (!ctx.item) throw new Error('palette: item action without an item');
    return ctx.item;
  };

  const setMonitored = (item: PaletteItem, monitored: boolean) => {
    const ok = { onSuccess: () => done(monitored ? t('palette.toast.monitored', { title: item.title }) : t('palette.toast.unmonitored', { title: item.title })) };
    switch (item.kind) {
      case 'movie':
        return monitorMovie.mutate({ id: item.id, monitored }, ok);
      case 'series':
        return monitorSeries.mutate({ id: item.id, monitored }, ok);
      case 'artist':
        return monitorArtist.mutate({ id: item.id, monitored }, ok);
      case 'author':
        return monitorAuthor.mutate({ id: item.id, monitored }, ok);
      case 'book':
        return monitorBooks.mutate({ bookIds: [item.id], monitored }, ok);
    }
  };

  const searchItem = (item: PaletteItem) => {
    switch (item.kind) {
      case 'movie':
        return automatic.mutate({ movieId: item.id });
      case 'series':
        return automatic.mutate({ seriesId: item.id });
      case 'artist':
        return automatic.mutate({ artistId: item.id });
      case 'author':
        return automatic.mutate({ authorId: item.id });
      case 'book':
        return automatic.mutate({ bookIds: [item.id] });
    }
  };

  const refreshItem = (item: PaletteItem) => {
    if (item.kind === 'movie') refresh.mutate({ target: { movieId: item.id } });
    else if (item.kind === 'series') refresh.mutate({ target: { seriesId: item.id } });
    else if (item.kind === 'artist') musicCommand.mutate({ name: 'RefreshArtist', artistId: item.id });
    else if (item.kind === 'author') audiobookCommand.mutate({ name: 'RefreshAuthor', authorId: item.id });
  };

  const HEALTH_IDS: Record<ItemKind, 'movieIds' | 'seriesIds' | 'artistIds' | 'authorIds' | 'bookIds'> = { movie: 'movieIds', series: 'seriesIds', artist: 'artistIds', author: 'authorIds', book: 'bookIds' };
  const checkHealth = (item: PaletteItem) =>
    healthScan.mutate({ [HEALTH_IDS[item.kind]]: [item.id] }, { onSuccess: () => done(t('palette.toast.healthStarted', { title: item.title })) });

  const videoIds = (item: PaletteItem) => (item.kind === 'movie' ? { movieIds: [item.id] } : { seriesIds: [item.id] });

  const allTorrents = async (action: TorrentAction) => {
    const title = action === 'pause' ? t('palette.action.pauseAll') : t('palette.action.resumeAll');
    try {
      const list = await torrentApi.list();
      const todo = list.filter((x) => (action === 'pause' ? x.state !== 'paused' : x.state === 'paused'));
      let ok = 0;
      for (const x of todo) {
        try {
          await torrentApi.action(x.id, action);
          ok += 1;
        } catch {
          // Counted as not done below.
        }
      }
      void qc.invalidateQueries({ queryKey: torrentKeys.all });
      void qc.invalidateQueries({ queryKey: ['queue'] });
      toast.push({
        tone: ok === todo.length ? 'ok' : 'warning',
        title: action === 'pause' ? t('palette.toast.paused', { count: ok }) : t('palette.toast.resumed', { count: ok }),
        message: ok < todo.length ? t('palette.toast.notDone', { count: todo.length - ok }) : undefined,
        durationMs: 5_000,
      });
    } catch (err) {
      failed(title, err);
    }
  };

  const approveAll = async () => {
    try {
      const page = await requestsApi.list({ filter: 'pending', take: 500 });
      const ids = page.results.map((r) => r.id);
      if (ids.length === 0) {
        toast.push({ tone: 'info', title: t('palette.toast.noPending'), durationMs: 4_000 });
        return;
      }
      const r = await requestsApi.bulkApprove(ids);
      void qc.invalidateQueries({ queryKey: requestKeys.requests.all });
      void qc.invalidateQueries({ queryKey: requestKeys.discover.all });
      toast.push({
        tone: r.failed.length ? 'warning' : 'ok',
        title: t('palette.toast.approved', { count: r.ok.length }),
        message: r.failed.length ? t('palette.toast.notDone', { count: r.failed.length }) : undefined,
        durationMs: 5_000,
      });
    } catch (err) {
      failed(t('palette.action.approveAll'), err);
    }
  };

  const bulk = (body: BulkSearchCommandInput) => bulkSearch.mutate(body);

  const actions: PaletteAction[] = [];
  const itemAction = (a: Omit<PaletteAction, 'group' | 'target' | 'run'> & { kinds: readonly ItemKind[]; run: (item: PaletteItem) => unknown }) => {
    const kinds = a.kinds.filter((k) => (k === 'artist' ? features.music : k === 'author' || k === 'book' ? features.audiobooks : true));
    if (kinds.length === 0) return;
    const { kinds: _k, run, ...rest } = a;
    actions.push({ ...rest, group: 'item', target: { type: 'item', kinds }, run: (ctx) => run(need(ctx)) });
  };

  // ---- item verbs (one line each)
  itemAction({ id: OPEN_ACTION_ID, label: t('palette.action.open'), keywords: ['go', 'show', 'view'], kinds: ALL_KINDS, permission: 'library', run: (i) => go(itemPath(i).to, { params: itemPath(i).params }) });
  itemAction({ id: 'item.searchUpgrades', label: t('palette.action.searchUpgrades'), keywords: ['upgrade', 'cutoff', 'better'], kinds: VIDEO, permission: 'admin', run: (i) => bulk({ mode: 'upgrade', ...videoIds(i) }) });
  itemAction({ id: 'item.search', label: t('palette.action.search'), keywords: ['automatic', 'find', 'grab'], kinds: ALL_KINDS, permission: 'admin', run: searchItem });
  itemAction({ id: 'item.interactive', label: t('palette.action.interactiveSearch'), keywords: ['manual', 'releases'], kinds: VIDEO, permission: 'admin', run: host.interactiveSearch });
  itemAction({ id: 'item.refresh', label: t('palette.action.refresh'), keywords: ['update', 'metadata', 'rescan'], kinds: ['movie', 'series', 'artist', 'author'], permission: 'admin', run: refreshItem });
  itemAction({ id: 'item.monitor', label: t('palette.action.monitor'), keywords: ['watch', 'track'], kinds: ALL_KINDS, permission: 'admin', run: (i) => setMonitored(i, true) });
  itemAction({ id: 'item.unmonitor', label: t('palette.action.unmonitor'), keywords: ['stop', 'ignore'], kinds: ALL_KINDS, permission: 'admin', run: (i) => setMonitored(i, false) });
  itemAction({
    id: 'item.rename',
    label: t('palette.action.renameFiles'),
    keywords: ['organize', 'naming'],
    kinds: VIDEO,
    permission: 'admin',
    destructive: true,
    confirm: (ctx) => t('palette.confirm.rename', { title: ctx.item?.title ?? '' }),
    run: (i) => rename.mutate(videoIds(i)),
  });
  itemAction({ id: 'item.health', label: t('palette.action.checkHealth'), keywords: ['scan', 'corrupt', 'verify', 'broken'], kinds: ALL_KINDS, permission: 'admin', run: checkHealth });
  itemAction({ id: 'item.analyze', label: t('palette.action.analyze'), keywords: ['ffprobe', 'mediainfo', 'probe'], kinds: VIDEO, permission: 'admin', run: (i) => analyze.mutate(i.kind === 'movie' ? { movieId: i.id } : { seriesId: i.id }) });

  // ---- global commands
  const global = (a: Omit<PaletteAction, 'group'>) => actions.push({ ...a, group: 'global' });
  global({ id: 'global.addSeries', label: t('palette.action.addSeries'), keywords: ['new', 'tv', 'show'], target: { type: 'text' }, permission: 'admin', run: (c) => go('/library/add', { search: { type: 'series', ...(c.text ? { term: c.text } : {}) } }) });
  global({ id: 'global.addMovie', label: t('palette.action.addMovie'), keywords: ['new', 'film'], target: { type: 'text' }, permission: 'admin', run: (c) => go('/library/add', { search: { type: 'movie', ...(c.text ? { term: c.text } : {}) } }) });
  if (features.music) global({ id: 'global.addArtist', label: t('palette.action.addArtist'), keywords: ['new', 'music', 'band'], target: { type: 'text' }, permission: 'admin', run: (c) => go('/library/add', { search: { type: 'music', ...(c.text ? { term: c.text } : {}) } }) });
  if (features.audiobooks) global({ id: 'global.addAuthor', label: t('palette.action.addAuthor'), keywords: ['new', 'audiobook', 'writer'], target: { type: 'text' }, permission: 'admin', run: (c) => go('/library/add', { search: { type: 'audiobook', ...(c.text ? { term: c.text } : {}) } }) });
  global({ id: 'global.searchIndexers', label: t('palette.action.searchIndexers'), keywords: ['indexer', 'manual', 'releases'], target: { type: 'text' }, permission: 'admin', hint: '/', run: (c) => go('/search', { search: { q: c.text ?? '' } }) });
  global({
    id: 'global.searchMissing',
    label: t('palette.action.searchMissing'),
    keywords: ['wanted', 'all'],
    permission: 'admin',
    destructive: true,
    confirm: () => t('palette.confirm.searchMissing'),
    run: () => bulk({ mode: 'missing', allMovies: true, allEpisodes: true }),
  });
  global({
    id: 'global.searchCutoff',
    label: t('palette.action.searchCutoff'),
    keywords: ['upgrades', 'unmet', 'all', 'wanted'],
    permission: 'admin',
    destructive: true,
    confirm: () => t('palette.confirm.searchCutoff'),
    run: () => bulk({ mode: 'upgrade', allMovies: true, allEpisodes: true }),
  });
  global({ id: 'global.approveAll', label: t('palette.action.approveAll'), keywords: ['requests', 'pending', 'accept'], permission: 'requests', destructive: true, confirm: () => t('palette.confirm.approveAll'), run: approveAll });
  if (engine.data?.enabled) {
    global({ id: 'global.pauseAll', label: t('palette.action.pauseAll'), keywords: ['downloads', 'torrents', 'stop'], permission: 'admin', destructive: true, confirm: () => t('palette.confirm.pauseAll'), run: () => allTorrents('pause') });
    global({ id: 'global.resumeAll', label: t('palette.action.resumeAll'), keywords: ['downloads', 'torrents', 'start', 'unpause'], permission: 'admin', destructive: true, confirm: () => t('palette.confirm.resumeAll'), run: () => allTorrents('resume') });
  }
  global({ id: 'global.stalled', label: t('palette.action.stalled'), keywords: ['queue', 'stuck', 'downloads'], permission: 'admin', run: () => go('/activity/queue', { search: { q: 'warning' } }) });
  global({ id: 'global.manualImport', label: t('palette.action.manualImport'), keywords: ['files'], permission: 'admin', run: () => go('/activity/manual-import') });
  global({ id: 'global.request', label: t('palette.action.request'), keywords: ['discover', 'ask'], permission: 'any', run: () => go(admin ? '/discover' : '/portal') });
  global({ id: 'global.shortcuts', label: t('palette.action.shortcuts'), keywords: ['keyboard', 'keys', 'help'], permission: 'any', hint: '?', run: host.openShortcuts });

  // ---- scheduled tasks
  for (const job of jobs.data ?? []) {
    actions.push({
      id: `task.${job.name}`,
      label: t('palette.action.runTask', { name: job.name }),
      keywords: ['task', 'job', 'run'],
      meta: job.enabled ? job.interval : t('common.disabled'),
      group: 'task',
      permission: 'admin',
      run: () => runJob.mutate(job.name),
    });
  }

  // ---- themes
  const catalog = themes.data;
  if (catalog && (catalog.allowUserChoice || isAdmin)) {
    for (const theme of catalog.themes) {
      actions.push({
        id: `theme.${theme.id}`,
        label: t('palette.action.switchTheme', { name: theme.name }),
        keywords: ['theme', 'appearance', 'colour', 'color', theme.colorScheme],
        meta: theme.colorScheme === 'dark' ? t('palette.meta.dark') : t('palette.meta.light'),
        group: 'theme',
        permission: 'any',
        run: () => {
          applyTheme(activeThemeOf(theme));
          if (user) savePrefs.mutate({ theme: theme.id });
          done(t('palette.toast.theme', { name: theme.name }));
        },
      });
    }
  }

  // ---- navigation: every page the person may open
  for (const s of visibleNav(access, nav)) {
    for (const c of s.children ?? [{ label: s.label, to: s.to }]) {
      actions.push({
        id: `nav.${c.to}`,
        label: s.children ? `${s.label} › ${c.label}` : c.label,
        keywords: ['go', 'open', 'page'],
        meta: t('layout.searchGroups.goTo'),
        group: 'navigate',
        permission: 'any',
        run: () => go(c.to),
      });
    }
  }

  const loading = series.isLoading || movies.isLoading || artists.isLoading || authors.isLoading || books.isLoading;
  return { actions: allowedActions(actions, access), items, loading };
}
