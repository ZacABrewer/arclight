import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { Link, useNavigate } from '@tanstack/react-router';
import type { ItemSearchStatus, Movie, QueueSummaryItem, SearchCommandRequest, SearchItemType, WantedEpisode } from '@arclight/shared';
import { errorMessage } from '../../api/client.js';
import { libraryApi } from '../../api/library.js';
import {
  Button,
  EmptyState,
  PageHeader,
  Paginator,
  Pane,
  Segmented,
  StatusChip,
  Table,
  Tabs,
  type Column,
  type RowKey,
} from '../../arclight/index.js';
import { episodeCode, formatDate } from '../../components/media/format.js';
import { Loading, QueryError, SwipeRow, useIsMobile } from '../../components/media/media-kit.js';
import { buildQueueIndex, QueueStateChip, SearchStatusLines } from '../../components/media/pipeline-status.js';
import { useToast } from '../../components/toast.js';
import { useQueueSummary } from '../../hooks/activity.js';
import { useAutomaticSearch, useCutoffUnmet, useMissing, useQualityProfiles } from '../../hooks/library.js';
import { useSearchStatus } from '../../hooks/search-status.js';
import { wantedVersionsColumn } from '../library/versions/versions-editor.js';
import { wantedVersionsSuffix } from '../library/versions/versions-model.js';
import { ProfileMismatchList } from './profile-mismatch.js';
import './wanted.css';
import { t } from '../../i18n/index.js';

const PAGE_SIZE = 50;
/** Largest page the api allows; "Search all" collects ids with one request of this size. */
const MAX_PAGE = 500;

type Mode = 'missing' | 'cutoff' | 'mismatch';
/** The lists backed by the library's wanted queries (the mismatch list has its own). */
type ListMode = Exclude<Mode, 'mismatch'>;
type Kind = 'episodes' | 'movies';

const MODE_TABS = [
  { id: 'missing', get label() { return t('status.missing'); } },
  { id: 'cutoff', get label() { return t('status.cutoffUnmet'); } },
  { id: 'mismatch', get label() { return t('profileMigration.wanted.tab'); } },
] as const;

const MODE_PATHS = { missing: '/wanted/missing', cutoff: '/wanted/cutoff', mismatch: '/wanted/mismatch' } as const;
const MODE_TITLES: Record<Mode, string> = { missing: 'Missing', cutoff: 'Cutoff unmet', mismatch: 'Profile mismatch' };

const KIND_OPTIONS = [
  { value: 'episodes' as const, get label() { return t('common.episodes'); } },
  { value: 'movies' as const, get label() { return t('common.movies'); } },
];

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
  const navigate = useNavigate();
  const [kind, setKind] = useState<Kind>('episodes');
  useEffect(() => {
    document.title = t('wanted.valueArclight', { value: MODE_TITLES[mode] });
  }, [mode]);
  return (
    <div className="wanted-page">
      <PageHeader index="05" title={t('common.wanted')}>
        <Tabs
          compact
          aria-label={t('wanted.wantedLists')}
          value={mode}
          tabs={MODE_TABS}
          onChange={(id) => void navigate({ to: MODE_PATHS[id as Mode] })}
        />
        <Segmented aria-label={t('common.mediaType')} options={KIND_OPTIONS} value={kind} onChange={setKind} />
      </PageHeader>
      {mode === 'mismatch' ? (
        <ProfileMismatchList key={`p-${kind}`} kind={kind} />
      ) : kind === 'episodes' ? (
        <EpisodesList key={`e-${mode}`} mode={mode} />
      ) : (
        <MoviesList key={`m-${mode}`} mode={mode} />
      )}
    </div>
  );
}

function useWantedList(mode: ListMode, kind: Kind, page: number) {
  // Both hooks are always called (rules of hooks); only the one for this mode is enabled.
  const missing = useMissing(kind, page, PAGE_SIZE, mode === 'missing');
  const cutoff = useCutoffUnmet(kind, page, PAGE_SIZE, mode === 'cutoff');
  return mode === 'missing' ? missing : cutoff;
}

/** Runs searches one at a time and reports a summary toast. */
function useBatchSearch() {
  const search = useAutomaticSearch();
  const toast = useToast();
  const [running, setRunning] = useState(false);
  const run = async (requests: SearchCommandRequest[]) => {
    setRunning(true);
    try {
      for (const r of requests) await search.mutateAsync(r);
    } catch {
      // The mutation already raised an error toast; stop the batch.
    } finally {
      setRunning(false);
    }
    if (requests.length > 1) toast.push({ tone: 'info', title: t('wanted.queuedRequestscountSearches', { requestsCount: requests.length }) });
  };
  return { run, running, search };
}

function statusChip(mode: ListMode, queued?: QueueSummaryItem) {
  if (queued) return <QueueStateChip item={queued} />;
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
  noun: string;
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
}

/** Shared frame: header actions, rich selectable table (desktop) or swipe rows (mobile), paginator. */
function ListShell<T>(p: ListShellProps<T>) {
  const mobile = useIsMobile();
  const pages = Math.max(1, Math.ceil((p.total ?? 0) / PAGE_SIZE));
  const empty = (
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
          {t('wanted.searchAll')}
        </Button>
      }
    >
      {mobile ? (
        p.loading ? (
          <Loading />
        ) : (p.rows ?? []).length === 0 ? (
          empty
        ) : (
          <div className="mk-mlist" role="list" aria-label={t('wanted.wantedNoun', { noun: p.noun })}>
            {(p.rows ?? []).map((r) => {
              const m = p.mobileRow(r);
              return (
                <SwipeRow key={p.rowKey(r)} onSearch={() => p.onSearchRows([p.rowKey(r)])} searchLabel={t('wanted.searchRowlabel', { rowLabel: p.rowLabel(r) })}>
                  <div className="mk-mrow" role="listitem">
                    <div style={{ minWidth: 0 }}>
                      <div className="mk-mrow__title">{m.title}</div>
                      <div className="mk-mrow__sub al-num">{m.sub}</div>
                      {m.extra}
                    </div>
                    {m.chip ?? statusChip(p.mode)}
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
          onSelectionChange={p.onSelect}
          rowLabel={(r) => t('wanted.selectRowlabel', { rowLabel: p.rowLabel(r) })}
          empty={empty}
          caption={t('wanted.wantedNoun', { noun: p.noun })}
          bulkActions={(keys, clear) => (
            <>
              <Button
                variant="ghost"
                loading={p.running}
                onClick={() => {
                  p.onSearchRows([...keys].map(Number));
                  clear();
                }}
              >
                {t('wanted.searchSelected')}
              </Button>
              <Button variant="ghost" loading={p.running} onClick={p.onSearchAll}>
                {t('wanted.searchAll')}
              </Button>
            </>
          )}
        />
      )}
      {pages > 1 ? (
        <div className="wanted-foot">
          <Paginator page={p.page} pageCount={pages} onPageChange={p.onPage} />
        </div>
      ) : null}
    </Pane>
  );
}

function EpisodesList({ mode }: { mode: ListMode }) {
  const [page, setPage] = useState(1);
  const [selected, setSelected] = useState<Set<RowKey>>(new Set());
  const list = useWantedList(mode, 'episodes', page);
  const batch = useBatchSearch();
  const toast = useToast();
  const records = list.data ? (list.data.records as WantedEpisode[]) : undefined;
  const pipeline = usePipeline('episode', records?.map((r) => r.id) ?? []);

  if (list.isError) return <QueryError error={list.error} onRetry={() => void list.refetch()} title={t('wanted.couldNotLoadWantedEpisodes')} />;

  const searchAll = async () => {
    try {
      const all =
        mode === 'missing'
          ? await libraryApi.wanted.missingEpisodes({ page: 1, pageSize: MAX_PAGE })
          : await libraryApi.wanted.cutoffEpisodes({ page: 1, pageSize: MAX_PAGE });
      const ids = all.records.map((r) => r.id);
      if (ids.length) await batch.run([{ episodeIds: ids }]);
    } catch (err) {
      toast.error(t('common.searchFailed'), errorMessage(err));
    }
  };

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
    { key: 'status', header: t('common.status'), cell: (r) => statusChip(mode, pipeline.queued(r.id)), width: '150px' },
    searchColumn<WantedEpisode>(pipeline),
    ...wantedVersionsColumn(records, t('wanted.versions')),
    {
      key: 'search',
      header: <span className="al-sr-only">{t('common.actions')}</span>,
      align: 'right',
      width: '96px',
      cell: (r) => (
        <Button size="sm" aria-label={t('wanted.searchLabel', { label: label(r) })} onClick={() => batch.search.mutate({ episodeIds: [r.id] })}>
          {t('common.search')}
        </Button>
      ),
    },
  ];

  return (
    <ListShell
      mode={mode}
      noun="episodes"
      total={list.data?.totalRecords}
      page={page}
      onPage={(p) => {
        setPage(p);
        setSelected(new Set());
      }}
      rows={records}
      loading={list.isPending}
      columns={columns}
      rowKey={(r) => r.id}
      rowLabel={label}
      mobileRow={(r) => ({
        title: r.seriesTitle,
        sub: `${episodeCode(r.seasonNumber, r.episodeNumber)} · ${shortDate(r.airDateUtc ?? r.airDate)}${wantedVersionsSuffix(r.wantedVersions)}`,
        extra: <SearchStatusLines status={pipeline.status(r.id)} compact />,
        chip: statusChip(mode, pipeline.queued(r.id)),
      })}
      selected={selected}
      onSelect={setSelected}
      running={batch.running}
      onSearchRows={(ids) => void batch.run([{ episodeIds: ids }])}
      onSearchAll={() => void searchAll()}
    />
  );
}

function MoviesList({ mode }: { mode: ListMode }) {
  const [page, setPage] = useState(1);
  const [selected, setSelected] = useState<Set<RowKey>>(new Set());
  const list = useWantedList(mode, 'movies', page);
  const profiles = useQualityProfiles();
  const batch = useBatchSearch();
  const toast = useToast();
  const records = list.data ? (list.data.records as Movie[]) : undefined;
  const pipeline = usePipeline('movie', records?.map((r) => r.id) ?? []);

  if (list.isError) return <QueryError error={list.error} onRetry={() => void list.refetch()} title={t('wanted.couldNotLoadWantedMovies')} />;

  const searchAll = async () => {
    try {
      const all =
        mode === 'missing'
          ? await libraryApi.wanted.missingMovies({ page: 1, pageSize: MAX_PAGE })
          : await libraryApi.wanted.cutoffMovies({ page: 1, pageSize: MAX_PAGE });
      await batch.run(all.records.map((m) => ({ movieId: m.id })));
    } catch (err) {
      toast.error(t('common.searchFailed'), errorMessage(err));
    }
  };

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
    { key: 'status', header: t('common.status'), cell: (r) => statusChip(mode, pipeline.queued(r.id)), width: '150px' },
    searchColumn<Movie>(pipeline),
    ...wantedVersionsColumn(records, t('wanted.versions')),
    {
      key: 'search',
      header: <span className="al-sr-only">{t('common.actions')}</span>,
      align: 'right',
      width: '96px',
      cell: (r) => (
        <Button size="sm" aria-label={t('wanted.searchTitle', { title: r.title })} onClick={() => batch.search.mutate({ movieId: r.id })}>
          {t('common.search')}
        </Button>
      ),
    },
  ];

  return (
    <ListShell
      mode={mode}
      noun="movies"
      total={list.data?.totalRecords}
      page={page}
      onPage={(p) => {
        setPage(p);
        setSelected(new Set());
      }}
      rows={records}
      loading={list.isPending}
      columns={columns}
      rowKey={(r) => r.id}
      rowLabel={(r) => r.title}
      mobileRow={(r) => ({
        title: r.title,
        sub: `${r.year || '—'} · ${shortDate(r.digitalRelease ?? r.inCinemas)}${wantedVersionsSuffix(r.wantedVersions)}`,
        extra: <SearchStatusLines status={pipeline.status(r.id)} compact />,
        chip: statusChip(mode, pipeline.queued(r.id)),
      })}
      selected={selected}
      onSelect={setSelected}
      running={batch.running}
      onSearchRows={(ids) => void batch.run(ids.map((movieId) => ({ movieId })))}
      onSearchAll={() => void searchAll()}
    />
  );
}
