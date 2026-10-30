import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { Link } from '@tanstack/react-router';
import type { BulkSearchCommandInput, ItemSearchStatus, Movie, QueueSummaryItem, SearchItemType, WantedAlbum, WantedBook, WantedEpisode, WantedReleaseFilter } from '@arclight/shared';
import { errorMessage } from '../../api/client.js';
import {
  Button,
  Checkbox,
  EmptyState,
  PageHeader,
  Paginator,
  Pane,
  Segmented,
  StatusChip,
  Table,
  type Column,
  type RowKey,
} from '../../arclight/index.js';
import { episodeCode, formatDate } from '../../components/media/format.js';
import { Loading, QueryError, SwipeRow, useIsMobile } from '../../components/media/media-kit.js';
import { buildQueueIndex, QueueStateChip, SearchStatusLines } from '../../components/media/pipeline-status.js';
import { useToast } from '../../components/toast.js';
import { ListSearchBar, ListSearchEmpty, useListSearch } from '../../components/list-search.js';
import { BulkBar, type BulkAction } from '../../components/media/bulk-bar.js';
import { useBulkSearch, useSetEpisodesMonitored } from '../../hooks/bulk.js';
import { useQueueSummary } from '../../hooks/activity.js';
import { useAutomaticSearch, useBulkUpdateMovies, useCutoffUnmet, useMissing, useQualityProfiles } from '../../hooks/library.js';
import { useSearchStatus } from '../../hooks/search-status.js';
import { useFeatures, useMusicQualityProfiles, useSetAlbumsMonitored, useWantedAlbums } from '../../hooks/music.js';
import { useMusicReleasesSettings, useMusicSearch } from '../../hooks/music-acquisition.js';
import { musicApi } from '../../api/music.js';
import { albumTypeLabel, progressText, trackProgress } from '../library/music/music-model.js';
import { useAudiobookQualityProfiles, useSetBooksMonitored, useWantedBooks } from '../../hooks/audiobooks.js';
import { useAudiobookSearch } from '../../hooks/audiobook-acquisition.js';
import { audiobooksApi } from '../../api/audiobooks.js';
import { AudiobookChip } from '../library/audiobooks/audiobook-kit.js';
import { positionLabel, primarySeries } from '../library/audiobooks/audiobook-model.js';
import { wantedVersionsColumn } from '../library/versions/versions-editor.js';
import { wantedVersionsSuffix } from '../library/versions/versions-model.js';
import {
  dateReleaseState,
  episodeReleaseState,
  movieReleaseState,
  ReleaseAwareSearchButton,
  UpcomingChip,
  type ReleaseState,
} from '../../components/media/release-state.js';
import { ProfileMismatchList } from './profile-mismatch.js';
import { ReleaseFilterBar, useReleaseFilter } from './release-filter.js';
import './wanted.css';
import { t } from '../../i18n/index.js';

const PAGE_SIZE = 50;
/** Largest page the api allows; "Search all" on albums / books collects ids with one request of this size (episodes and movies are queued server-side). */
const MAX_PAGE = 500;

type Mode = 'missing' | 'cutoff' | 'mismatch';
/** The lists backed by the library's wanted queries (the mismatch list has its own). */
type ListMode = Exclude<Mode, 'mismatch'>;
type Kind = 'episodes' | 'movies' | 'albums' | 'books';
/** The kinds the video lists (and the profile-mismatch list) know. */
type VideoKind = Exclude<Kind, 'albums' | 'books'>;

const MODE_TITLES: Record<Mode, string> = { missing: 'Missing', cutoff: 'Cutoff unmet', mismatch: 'Profile mismatch' };

const KIND_OPTIONS: ReadonlyArray<{ value: Kind; label: string }> = [
  { value: 'episodes', get label() { return t('common.episodes'); } },
  { value: 'movies', get label() { return t('common.movies'); } },
];
const ALBUM_OPTION: { value: Kind; label: string } = { value: 'albums', get label() { return t('music.albums'); } };
const BOOK_OPTION: { value: Kind; label: string } = { value: 'books', get label() { return t('audiobooks.books'); } };

export function WantedMissingPage() {
  return <WantedPage mode="missing" />;
}

export function WantedCutoffPage() {
  return <WantedPage mode="cutoff" />;
}

export function WantedMismatchPage() {
  return <WantedPage mode="mismatch" />;
}

/** Short mono date: "21 Feb 2025". */
export function shortDate(value: string | null | undefined): string {
  return formatDate(value, { day: 'numeric', month: 'short', year: 'numeric' });
}

function WantedPage({ mode }: { mode: Mode }) {
  const [picked, setKind] = useState<Kind>('episodes');
  const features = useFeatures();
  // Albums: missing and cutoff unmet only, and only while music is on.
  const albums = features.music && mode !== 'mismatch';
  // Books: the same, while audiobooks are on.
  const books = features.audiobooks && mode !== 'mismatch';
  const kind: Kind = (picked === 'albums' && !albums) || (picked === 'books' && !books) ? 'episodes' : picked;
  const options = [...KIND_OPTIONS, ...(albums ? [ALBUM_OPTION] : []), ...(books ? [BOOK_OPTION] : [])];
  useEffect(() => {
    document.title = t('wanted.valueArclight', { value: MODE_TITLES[mode] });
  }, [mode]);
  return (
    <div className="wanted-page">
      <PageHeader index="05" title={t('common.wanted')}>
        <Segmented aria-label={t('common.mediaType')} options={options} value={kind} onChange={setKind} />
      </PageHeader>
      {mode === 'mismatch' ? (
        <ProfileMismatchList key={`p-${kind}`} kind={kind === 'albums' || kind === 'books' ? 'episodes' : kind} />
      ) : kind === 'albums' ? (
        <AlbumsList key={`a-${mode}`} mode={mode} />
      ) : kind === 'books' ? (
        <BooksList key={`b-${mode}`} mode={mode} />
      ) : kind === 'episodes' ? (
        <EpisodesList key={`e-${mode}`} mode={mode} />
      ) : (
        <MoviesList key={`m-${mode}`} mode={mode} />
      )}
    </div>
  );
}

function useWantedList(mode: ListMode, kind: VideoKind, page: number, q: string, release: WantedReleaseFilter) {
  // Both hooks are always called (rules of hooks); only the one for this mode is enabled.
  const missing = useMissing(kind, page, PAGE_SIZE, mode === 'missing', q, release);
  const cutoff = useCutoffUnmet(kind, page, PAGE_SIZE, mode === 'cutoff', q, release);
  return mode === 'missing' ? missing : cutoff;
}

type ListSearch = ReturnType<typeof useListSearch>;
type ListRelease = ReturnType<typeof useReleaseFilter>;

/**
 * Page, selection, the text search (`?q=`) and the release filter (`?released=` and the date
 * range), shared by every media type, of one wanted list. The lists are server-paged: a new
 * query or filter goes back to page 1 and drops the selection.
 */
function useListState() {
  const search = useListSearch();
  const release = useReleaseFilter();
  const [page, setPage] = useState(1);
  const [selected, setSelected] = useState<Set<RowKey>>(new Set());
  const listKey = `${search.q}#${release.key}`;
  const [seenKey, setSeenKey] = useState(listKey);
  if (seenKey !== listKey) {
    setSeenKey(listKey);
    setPage(1);
    setSelected(new Set());
  }
  const onPage = (p: number) => {
    setPage(p);
    setSelected(new Set());
  };
  return { search, release, page, onPage, selected, setSelected };
}

/** The `searchUnreleased` setting (Settings → Media management): Search buttons stay on for upcoming rows. */
function useSearchUnreleased(): boolean {
  return useMusicReleasesSettings().data?.searchUnreleased ?? false;
}

/** The bulk search body's part for "all": the list's text search and release filter. */
function allQuery(q: string | undefined, release: WantedReleaseFilter) {
  return { ...(q ? { q } : {}), ...release };
}

/** The search box placeholder per media type: what the server matches. */
function searchPlaceholder(kind: Kind): string {
  switch (kind) {
    case 'episodes':
      return t('wanted.search.episodes');
    case 'movies':
      return t('listSearch.ph.titles');
    case 'albums':
      return t('wanted.search.albums');
    case 'books':
      return t('wanted.search.books');
  }
}

function statusChip(mode: ListMode, queued?: QueueSummaryItem, release?: ReleaseState) {
  if (queued) return <QueueStateChip item={queued} />;
  // Not out yet: the date it comes out instead of Missing (searches skip it until then).
  if (release && !release.released) return <UpcomingChip date={release.date} />;
  return mode === 'missing' ? <StatusChip status="missing" /> : <StatusChip status="cutoffUnmet" />;
}

/**
 * What the pipeline is doing about the rows on the page: their last / next automatic search
 * (one request per page) and whether they are in the download queue (one shared request).
 */
function usePipeline(kind: SearchItemType, ids: readonly number[]) {
  const status = useSearchStatus(kind, ids);
  const queue = useQueueSummary();
  return useMemo(() => {
    const byId = new Map<number, ItemSearchStatus>((status.data ?? []).map((s) => [s.id, s]));
    const index = buildQueueIndex(queue.data);
    const queued = (id: number) => (kind === 'movie' ? index.movies.get(id) : index.episodes.get(id));
    return { status: (id: number) => byId.get(id), queued };
  }, [status.data, queue.data, kind]);
}

function searchColumn<T extends { id: number }>(pipeline: ReturnType<typeof usePipeline>): Column<T> {
  return {
    key: 'automatic',
    header: t('components.media.pipeline.automaticSearch'),
    cell: (r) => <SearchStatusLines status={pipeline.status(r.id)} />,
  };
}

interface ListShellProps<T> {
  mode: ListMode;
  kind: Kind;
  noun: string;
  /** The list's text search; the rows and `total` are already the server's answer to it. */
  search: ListSearch;
  /** The list's release filter (likewise applied by the server). */
  release: ListRelease;
  /** Whether a row is out yet (upcoming rows cannot be searched). */
  rowRelease: (r: T) => ReleaseState;
  /** The `searchUnreleased` setting: upcoming rows may be searched after all. */
  allowUnreleased: boolean;
  total: number | undefined;
  page: number;
  onPage: (p: number) => void;
  rows: T[] | undefined;
  loading: boolean;
  columns: Column<T>[];
  rowKey: (r: T) => number;
  rowLabel: (r: T) => string;
  mobileRow: (r: T) => { title: string; sub: string; extra?: ReactNode; chip?: ReactNode };
  selected: Set<RowKey>;
  onSelect: (s: Set<RowKey>) => void;
  running: boolean;
  onSearchRows: (ids: number[]) => void;
  onSearchAll: () => void;
  /**
   * The bulk bar's actions for the selection. `all` = "Select all N" was chosen: the action
   * applies to everything the list holds (every page), not just `ids`.
   */
  bulkActions: (sel: { ids: number[]; all: boolean }, done: () => void) => BulkAction[];
}

/** The search verb of a list: missing items are searched, cutoff-unmet items upgraded. */
export function bulkSearchLabel(mode: ListMode): string {
  return mode === 'missing' ? t('wanted.searchSelected') : t('bulk.searchUpgrades');
}

/** Shared frame: header actions, rich selectable table (desktop) or swipe rows (mobile), paginator. */
function ListShell<T>(p: ListShellProps<T>) {
  const mobile = useIsMobile();
  const pages = Math.max(1, Math.ceil((p.total ?? 0) / PAGE_SIZE));
  // "Select all N" across pages; any change to the row selection drops back to the rows.
  const [allMatching, setAllMatching] = useState(false);
  // A new search or filter is a new list: "all matching" meant the old one.
  const listKey = `${p.search.q}#${p.release.key}`;
  const [seenKey, setSeenKey] = useState(listKey);
  if (seenKey !== listKey) {
    setSeenKey(listKey);
    setAllMatching(false);
  }
  const select = (next: Set<RowKey>) => {
    setAllMatching(false);
    p.onSelect(next);
  };
  const clear = () => select(new Set());
  const toggle = (key: number) => {
    const next = new Set(p.selected);
    if (next.has(key)) next.delete(key);
    else next.add(key);
    select(next);
  };
  const ids = [...p.selected].map(Number);
  const empty = p.search.active ? (
    <ListSearchEmpty query={p.search.q} onClear={p.search.clear} />
  ) : p.release.key !== '||' ? (
    <EmptyState title={t('wanted.release.empty', { noun: p.noun })} action={<Button onClick={() => p.release.setFilter({})}>{t('wanted.release.clear')}</Button>}>
      {t('wanted.release.emptyHint')}
    </EmptyState>
  ) : (
    <EmptyState title={p.mode === 'missing' ? t('wanted.noMissingNoun', { noun: p.noun }) : t('wanted.noNounBelowCutoff', { noun: p.noun })}>
      {p.mode === 'missing' ? t('wanted.everyMonitoredItemThatHas') : t('wanted.everyFileMeetsItsProfile')}
    </EmptyState>
  );
  return (
    <Pane
      flush
      title={p.total === undefined ? p.noun.toUpperCase() : `${p.total} ${p.noun}`}
      actions={
        <Button variant="primary" size="sm" disabled={!p.total} loading={p.running} onClick={p.onSearchAll}>
          {/* With a search, "Search all" queues only the matching rows (the query goes along). */}
          {p.search.active ? t('wanted.searchAllMatching') : t('wanted.searchAll')}
        </Button>
      }
    >
      <ListSearchBar
        className="wanted-search"
        value={p.search.q}
        onChange={p.search.setQ}
        placeholder={searchPlaceholder(p.kind)}
        shown={p.loading ? undefined : p.total}
      />
      <ReleaseFilterBar filter={p.release.filter} onChange={p.release.setFilter} />
      {mobile ? (
        p.loading ? (
          <Loading />
        ) : (p.rows ?? []).length === 0 ? (
          empty
        ) : (
          <div className="mk-mlist" role="list" aria-label={t('wanted.wantedNoun', { noun: p.noun })}>
            {(p.rows ?? []).map((r) => {
              const m = p.mobileRow(r);
              const key = p.rowKey(r);
              const release = p.rowRelease(r);
              const searchable = release.released || p.allowUnreleased;
              return (
                <SwipeRow
                  key={key}
                  onSearch={searchable ? () => p.onSearchRows([key]) : undefined}
                  searchLabel={t('wanted.searchRowlabel', { rowLabel: p.rowLabel(r) })}
                >
                  <div className="mk-mrow mk-mrow--check" role="listitem">
                    <Checkbox aria-label={t('wanted.selectRowlabel', { rowLabel: p.rowLabel(r) })} checked={p.selected.has(key)} onChange={() => toggle(key)} />
                    <div style={{ minWidth: 0 }}>
                      <div className="mk-mrow__title">{m.title}</div>
                      <div className="mk-mrow__sub al-num">{m.sub}</div>
                      {m.extra}
                    </div>
                    {m.chip ?? statusChip(p.mode, undefined, release)}
                  </div>
                </SwipeRow>
              );
            })}
          </div>
        )
      ) : (
        <Table
          columns={p.columns}
          rows={p.rows}
          loading={p.loading}
          rowKey={p.rowKey}
          density="rich"
          sortable={false}
          selectable
          selected={p.selected}
          onSelectionChange={select}
          rowLabel={(r) => t('wanted.selectRowlabel', { rowLabel: p.rowLabel(r) })}
          empty={empty}
          caption={t('wanted.wantedNoun', { noun: p.noun })}
        />
      )}
      <BulkBar
        count={ids.length}
        total={p.total}
        allMatching={allMatching}
        onSelectAll={() => {
          p.onSelect(new Set((p.rows ?? []).map(p.rowKey)));
          setAllMatching(true);
        }}
        actions={p.bulkActions({ ids, all: allMatching }, clear)}
        onClear={clear}
      />
      {pages > 1 ? (
        <div className="wanted-foot">
          <Paginator page={p.page} pageCount={pages} onPageChange={p.onPage} />
        </div>
      ) : null}
    </Pane>
  );
}

function EpisodesList({ mode }: { mode: ListMode }) {
  const { search, release, page, onPage, selected, setSelected } = useListState();
  const q = search.q || undefined;
  const list = useWantedList(mode, 'episodes', page, search.q, release.filter);
  const allowUnreleased = useSearchUnreleased();
  const one = useAutomaticSearch();
  const bulk = useBulkSearch();
  const monitor = useSetEpisodesMonitored();
  const records = list.data ? (list.data.records as WantedEpisode[]) : undefined;
  const pipeline = usePipeline('episode', records?.map((r) => r.id) ?? []);

  if (list.isError) return <QueryError error={list.error} onRetry={() => void list.refetch()} title={t('wanted.couldNotLoadWantedEpisodes')} />;

  // Missing → the missing rules, cutoff unmet → an upgrade search (profile cutoff honoured server-side).
  const searchMode = mode === 'missing' ? 'missing' : 'upgrade';
  // "All" is every row the (searched, filtered) list holds: the server applies the same `q`
  // and release filter, and skips (and counts) the rows that are not out yet.
  const all: BulkSearchCommandInput = { mode: searchMode, allEpisodes: true, ...allQuery(q, release.filter) };
  const searchAll = () => bulk.mutate(all);

  const label = (r: WantedEpisode) => `${r.seriesTitle} ${episodeCode(r.seasonNumber, r.episodeNumber)}`;
  const columns: Column<WantedEpisode>[] = [
    {
      key: 'series',
      header: t('common.series'),
      cell: (r) => (
        <Link className="mk-link" to="/library/series/$id" params={{ id: String(r.seriesId) }}>
          {r.seriesTitle}
        </Link>
      ),
    },
    { key: 'episode', header: t('common.episode'), mono: true, cell: (r) => episodeCode(r.seasonNumber, r.episodeNumber), width: '96px' },
    { key: 'title', header: t('common.title'), muted: true, cell: (r) => r.title || '—' },
    { key: 'airDate', header: t('wanted.airDate'), mono: true, cell: (r) => shortDate(r.airDateUtc ?? r.airDate), width: '130px' },
    { key: 'status', header: t('common.status'), cell: (r) => statusChip(mode, pipeline.queued(r.id), episodeReleaseState(r)), width: '170px' },
    searchColumn<WantedEpisode>(pipeline),
    ...wantedVersionsColumn(records, t('wanted.versions')),
    {
      key: 'search',
      header: <span className="al-sr-only">{t('common.actions')}</span>,
      align: 'right',
      width: '96px',
      cell: (r) => (
        <ReleaseAwareSearchButton
          state={episodeReleaseState(r)}
          allowUnreleased={allowUnreleased}
          label={t('wanted.searchLabel', { label: label(r) })}
          onClick={() => one.mutate({ episodeIds: [r.id] })}
        >
          {t('common.search')}
        </ReleaseAwareSearchButton>
      ),
    },
  ];

  return (
    <ListShell
      mode={mode}
      kind="episodes"
      search={search}
      release={release}
      rowRelease={(r) => episodeReleaseState(r)}
      allowUnreleased={allowUnreleased}
      noun="episodes"
      total={list.data?.totalRecords}
      page={page}
      onPage={onPage}
      rows={records}
      loading={list.isPending}
      columns={columns}
      rowKey={(r) => r.id}
      rowLabel={label}
      mobileRow={(r) => ({
        title: r.seriesTitle,
        sub: `${episodeCode(r.seasonNumber, r.episodeNumber)} · ${shortDate(r.airDateUtc ?? r.airDate)}${wantedVersionsSuffix(r.wantedVersions)}`,
        extra: <SearchStatusLines status={pipeline.status(r.id)} compact />,
        chip: statusChip(mode, pipeline.queued(r.id), episodeReleaseState(r)),
      })}
      selected={selected}
      onSelect={setSelected}
      running={bulk.isPending}
      onSearchRows={(ids) => one.mutate({ episodeIds: ids })}
      onSearchAll={searchAll}
      bulkActions={(sel, done) => [
        {
          id: 'search',
          label: bulkSearchLabel(mode),
          loading: bulk.isPending,
          onSelect: () => bulk.mutate(sel.all ? all : { mode: searchMode, episodeIds: sel.ids }, { onSuccess: done }),
        },
        {
          id: 'unmonitor',
          label: t('common.unmonitor'),
          disabled: sel.all || monitor.isPending,
          onSelect: () => monitor.mutate({ episodeIds: sel.ids, monitored: false }, { onSuccess: done }),
        },
      ]}
    />
  );
}

function MoviesList({ mode }: { mode: ListMode }) {
  const { search, release, page, onPage, selected, setSelected } = useListState();
  const q = search.q || undefined;
  const list = useWantedList(mode, 'movies', page, search.q, release.filter);
  const allowUnreleased = useSearchUnreleased();
  const profiles = useQualityProfiles();
  const one = useAutomaticSearch();
  const bulk = useBulkSearch();
  const update = useBulkUpdateMovies();
  const records = list.data ? (list.data.records as Movie[]) : undefined;
  const pipeline = usePipeline('movie', records?.map((r) => r.id) ?? []);

  if (list.isError) return <QueryError error={list.error} onRetry={() => void list.refetch()} title={t('wanted.couldNotLoadWantedMovies')} />;

  const searchMode = mode === 'missing' ? 'missing' : 'upgrade';
  const all: BulkSearchCommandInput = { mode: searchMode, allMovies: true, ...allQuery(q, release.filter) };
  const searchAll = () => bulk.mutate(all);

  const columns: Column<Movie>[] = [
    {
      key: 'title',
      header: t('common.title'),
      cell: (r) => (
        <Link className="mk-link" to="/library/movie/$id" params={{ id: String(r.id) }}>
          {r.title}
        </Link>
      ),
    },
    { key: 'year', header: t('common.year'), mono: true, cell: (r) => r.year || '—', width: '72px' },
    { key: 'profile', header: t('common.profile'), muted: true, cell: (r) => profiles.data?.find((p) => p.id === r.qualityProfileId)?.name ?? `#${r.qualityProfileId}` },
    { key: 'cinemas', header: t('common.inCinemas'), mono: true, cell: (r) => shortDate(r.inCinemas) },
    { key: 'digital', header: t('wanted.digital'), mono: true, cell: (r) => shortDate(r.digitalRelease) },
    { key: 'physical', header: t('wanted.physical'), mono: true, cell: (r) => shortDate(r.physicalRelease) },
    { key: 'status', header: t('common.status'), cell: (r) => statusChip(mode, pipeline.queued(r.id), movieReleaseState(r)), width: '170px' },
    searchColumn<Movie>(pipeline),
    ...wantedVersionsColumn(records, t('wanted.versions')),
    {
      key: 'search',
      header: <span className="al-sr-only">{t('common.actions')}</span>,
      align: 'right',
      width: '96px',
      cell: (r) => (
        <ReleaseAwareSearchButton
          state={movieReleaseState(r)}
          allowUnreleased={allowUnreleased}
          label={t('wanted.searchTitle', { title: r.title })}
          onClick={() => one.mutate({ movieId: r.id })}
        >
          {t('common.search')}
        </ReleaseAwareSearchButton>
      ),
    },
  ];

  return (
    <ListShell
      mode={mode}
      kind="movies"
      search={search}
      release={release}
      rowRelease={(r) => movieReleaseState(r)}
      allowUnreleased={allowUnreleased}
      noun="movies"
      total={list.data?.totalRecords}
      page={page}
      onPage={onPage}
      rows={records}
      loading={list.isPending}
      columns={columns}
      rowKey={(r) => r.id}
      rowLabel={(r) => r.title}
      mobileRow={(r) => ({
        title: r.title,
        sub: `${r.year || '—'} · ${shortDate(r.digitalRelease ?? r.inCinemas)}${wantedVersionsSuffix(r.wantedVersions)}`,
        extra: <SearchStatusLines status={pipeline.status(r.id)} compact />,
        chip: statusChip(mode, pipeline.queued(r.id), movieReleaseState(r)),
      })}
      selected={selected}
      onSelect={setSelected}
      running={bulk.isPending}
      onSearchRows={(ids) => (ids.length === 1 ? one.mutate({ movieId: ids[0]! }) : bulk.mutate({ mode: searchMode, movieIds: ids }))}
      onSearchAll={searchAll}
      bulkActions={(sel, done) => [
        {
          id: 'search',
          label: bulkSearchLabel(mode),
          loading: bulk.isPending,
          onSelect: () => bulk.mutate(sel.all ? all : { mode: searchMode, movieIds: sel.ids }, { onSuccess: done }),
        },
        {
          id: 'unmonitor',
          label: t('common.unmonitor'),
          disabled: sel.all || update.isPending,
          onSelect: () => update.mutate({ ids: sel.ids, monitored: false }, { onSuccess: done }),
        },
      ]}
    />
  );
}

/**
 * The ids of `rows` a search may look for: rows that are not out yet are left out (unless
 * `searchUnreleased` is on) and a toast says how many. Album and book searches are commands
 * by id, so the page does the skipping the bulk search endpoint does for episodes and movies.
 */
function searchableIds<T extends { id: number }>(
  rows: readonly T[],
  state: (r: T) => ReleaseState,
  allowUnreleased: boolean,
  toast: ReturnType<typeof useToast>,
): number[] {
  const ids = rows.filter((r) => allowUnreleased || state(r).released).map((r) => r.id);
  const skipped = rows.length - ids.length;
  if (skipped > 0) {
    toast.push({
      tone: 'info',
      title: ids.length === 0 ? t('bulk.toast.nothingToSearch') : t('wanted.release.searchingReleased', { count: ids.length }),
      message: t('bulk.toast.skippedUnreleased', { count: skipped }),
    });
  }
  return ids;
}

/** Albums missing tracks / below cutoff: AlbumSearch for the selected rows, one row, or all of them. */
function AlbumsList({ mode }: { mode: ListMode }) {
  const { search: listSearch, release, page, onPage, selected, setSelected } = useListState();
  const list = useWantedAlbums(mode, page, PAGE_SIZE, true, listSearch.q, release.filter);
  const profiles = useMusicQualityProfiles();
  const search = useMusicSearch();
  const setAlbums = useSetAlbumsMonitored();
  const toast = useToast();
  const allowUnreleased = useSearchUnreleased();
  if (list.isError) return <QueryError error={list.error} onRetry={() => void list.refetch()} title={t('music.wanted.couldNotLoad')} />;
  const rows = list.data?.records;
  const total = list.data?.totalRecords;
  const label = (r: WantedAlbum) => `${r.artistName} - ${r.title}`;
  const searchAlbums = (picked: readonly WantedAlbum[]) => {
    const albumIds = searchableIds(picked, (r) => dateReleaseState(r), allowUnreleased, toast);
    if (albumIds.length) search.mutate({ name: 'AlbumSearch', albumIds });
  };
  const byIds = (ids: number[]) => (rows ?? []).filter((r) => ids.includes(r.id));
  const searchAll = async () => {
    try {
      // The same search and filter as the list, so "all" is what the list shows.
      const query = { page: 1, pageSize: MAX_PAGE, q: listSearch.q || undefined, ...release.filter };
      const all = mode === 'missing' ? await musicApi.wanted.missing(query) : await musicApi.wanted.cutoff(query);
      searchAlbums(all.records);
    } catch (err) {
      toast.error(t('common.searchFailed'), errorMessage(err));
    }
  };
  const columns: Column<WantedAlbum>[] = [
    {
      key: 'artist',
      header: t('music.artist'),
      cell: (r) => (
        <Link className="mk-link" to="/library/music/artist/$id" params={{ id: String(r.artistId) }}>
          {r.artistName}
        </Link>
      ),
    },
    {
      key: 'album',
      header: t('music.album'),
      cell: (r) => (
        <Link className="mk-link" to="/library/music/album/$id" params={{ id: String(r.id) }}>
          {r.title}
        </Link>
      ),
    },
    { key: 'type', header: t('common.type'), muted: true, cell: (r) => albumTypeLabel(r.primaryType), width: '96px' },
    { key: 'released', header: t('common.released'), mono: true, cell: (r) => shortDate(r.releaseDate), width: '130px' },
    { key: 'tracks', header: t('music.tracks'), mono: true, cell: (r) => progressText(trackProgress(r.statistics)), width: '96px' },
    { key: 'profile', header: t('common.profile'), muted: true, cell: (r) => profiles.data?.find((p) => p.id === r.qualityProfileId)?.name ?? `#${r.qualityProfileId}` },
    { key: 'status', header: t('common.status'), cell: (r) => statusChip(mode, undefined, dateReleaseState(r)), width: '170px' },
    {
      key: 'search',
      header: <span className="al-sr-only">{t('common.actions')}</span>,
      align: 'right',
      width: '96px',
      cell: (r) => (
        <ReleaseAwareSearchButton
          state={dateReleaseState(r)}
          allowUnreleased={allowUnreleased}
          label={t('wanted.searchLabel', { label: label(r) })}
          onClick={() => searchAlbums([r])}
        >
          {t('common.search')}
        </ReleaseAwareSearchButton>
      ),
    },
  ];
  return (
    <ListShell
      mode={mode}
      kind="albums"
      search={listSearch}
      release={release}
      rowRelease={(r) => dateReleaseState(r)}
      allowUnreleased={allowUnreleased}
      noun={t('music.albumNoun', { count: 2 })}
      total={total}
      page={page}
      onPage={onPage}
      rows={rows}
      loading={list.isPending}
      columns={columns}
      rowKey={(r) => r.id}
      rowLabel={label}
      mobileRow={(r) => ({
        title: r.title,
        sub: `${r.artistName} · ${shortDate(r.releaseDate)} · ${progressText(trackProgress(r.statistics))}`,
      })}
      selected={selected}
      onSelect={setSelected}
      running={search.isPending}
      onSearchRows={(ids) => searchAlbums(byIds(ids))}
      onSearchAll={() => void searchAll()}
      bulkActions={(sel, done) => [
        {
          id: 'search',
          label: bulkSearchLabel(mode),
          loading: search.isPending,
          onSelect: () => {
            if (sel.all) void searchAll();
            else searchAlbums(byIds(sel.ids));
            done();
          },
        },
        {
          id: 'unmonitor',
          label: t('common.unmonitor'),
          disabled: sel.all || setAlbums.isPending,
          // artistId 0: the selection spans artists, so no single artist page is patched.
          onSelect: () => setAlbums.mutate({ artistId: 0, albumIds: sel.ids, monitored: false }, { onSuccess: done }),
        },
      ]}
    />
  );
}

/** "Book 3 · Series" for a wanted row, or null outside a series. */
function seriesText(r: WantedBook): string | null {
  const s = primarySeries(r);
  if (!s) return null;
  const pos = positionLabel(s.position);
  return pos ? `${s.name} · ${pos}` : s.name;
}

/** Books missing / below cutoff: BookSearch for the selected rows, one row, or all of them. */
function BooksList({ mode }: { mode: ListMode }) {
  const { search: listSearch, release, page, onPage, selected, setSelected } = useListState();
  const list = useWantedBooks(mode, page, PAGE_SIZE, true, listSearch.q, release.filter);
  const profiles = useAudiobookQualityProfiles();
  const search = useAudiobookSearch();
  const setBooks = useSetBooksMonitored();
  const toast = useToast();
  const allowUnreleased = useSearchUnreleased();
  if (list.isError) return <QueryError error={list.error} onRetry={() => void list.refetch()} title={t('audiobooks.wanted.couldNotLoad')} />;
  const rows = list.data?.records;
  const total = list.data?.totalRecords;
  const label = (r: WantedBook) => `${r.authorName} – ${r.title}`;
  const searchBooks = (picked: readonly WantedBook[]) => {
    const bookIds = searchableIds(picked, (r) => dateReleaseState(r), allowUnreleased, toast);
    if (bookIds.length) search.mutate({ name: 'BookSearch', bookIds });
  };
  const byIds = (ids: number[]) => (rows ?? []).filter((r) => ids.includes(r.id));
  const searchAll = async () => {
    try {
      const query = { page: 1, pageSize: MAX_PAGE, q: listSearch.q || undefined, ...release.filter };
      const all = mode === 'missing' ? await audiobooksApi.wanted.missing(query) : await audiobooksApi.wanted.cutoff(query);
      searchBooks(all.records);
    } catch (err) {
      toast.error(t('common.searchFailed'), errorMessage(err));
    }
  };
  const columns: Column<WantedBook>[] = [
    {
      key: 'author',
      header: t('audiobooks.author'),
      cell: (r) => (
        <Link className="mk-link" to="/library/audiobooks/author/$id" params={{ id: String(r.authorId) }}>
          {r.authorName}
        </Link>
      ),
    },
    {
      key: 'book',
      header: t('audiobooks.book'),
      cell: (r) => (
        <span className="mk-row" style={{ gap: 8, flexWrap: 'wrap' }}>
          <Link className="mk-link" to="/library/audiobooks/book/$id" params={{ id: String(r.id) }}>
            {r.title}
          </Link>
          <AudiobookChip />
        </span>
      ),
    },
    { key: 'series', header: t('audiobooks.series'), muted: true, cell: (r) => seriesText(r) ?? '—' },
    { key: 'released', header: t('common.released'), mono: true, cell: (r) => shortDate(r.releaseDate), width: '130px' },
    { key: 'profile', header: t('common.profile'), muted: true, cell: (r) => profiles.data?.find((p) => p.id === r.qualityProfileId)?.name ?? `#${r.qualityProfileId}` },
    { key: 'status', header: t('common.status'), cell: (r) => statusChip(mode, undefined, dateReleaseState(r)), width: '170px' },
    {
      key: 'search',
      header: <span className="al-sr-only">{t('common.actions')}</span>,
      align: 'right',
      width: '96px',
      cell: (r) => (
        <ReleaseAwareSearchButton
          state={dateReleaseState(r)}
          allowUnreleased={allowUnreleased}
          label={t('wanted.searchLabel', { label: label(r) })}
          onClick={() => searchBooks([r])}
        >
          {t('common.search')}
        </ReleaseAwareSearchButton>
      ),
    },
  ];
  return (
    <ListShell
      mode={mode}
      kind="books"
      search={listSearch}
      release={release}
      rowRelease={(r) => dateReleaseState(r)}
      allowUnreleased={allowUnreleased}
      noun={t('audiobooks.bookNoun', { count: 2 })}
      total={total}
      page={page}
      onPage={onPage}
      rows={rows}
      loading={list.isPending}
      columns={columns}
      rowKey={(r) => r.id}
      rowLabel={label}
      mobileRow={(r) => ({
        title: r.title,
        sub: [r.authorName, seriesText(r), shortDate(r.releaseDate)].filter(Boolean).join(' · '),
      })}
      selected={selected}
      onSelect={setSelected}
      running={search.isPending}
      onSearchRows={(ids) => searchBooks(byIds(ids))}
      onSearchAll={() => void searchAll()}
      bulkActions={(sel, done) => [
        {
          id: 'search',
          label: bulkSearchLabel(mode),
          loading: search.isPending,
          onSelect: () => {
            if (sel.all) void searchAll();
            else searchBooks(byIds(sel.ids));
            done();
          },
        },
        {
          id: 'unmonitor',
          label: t('common.unmonitor'),
          disabled: sel.all || setBooks.isPending,
          onSelect: () => setBooks.mutate({ bookIds: sel.ids, monitored: false }, { onSuccess: done }),
        },
      ]}
    />
  );
}
