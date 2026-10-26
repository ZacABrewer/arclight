import { useEffect, useState } from 'react';
import { Link, useNavigate } from '@tanstack/react-router';
import type { Movie, SearchCommandRequest, WantedEpisode } from '@arclight/shared';
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
import { useToast } from '../../components/toast.js';
import { useAutomaticSearch, useCutoffUnmet, useMissing, useQualityProfiles } from '../../hooks/library.js';
import './wanted.css';

const PAGE_SIZE = 50;
/** Largest page the api allows; "Search all" collects ids with one request of this size. */
const MAX_PAGE = 500;

type Mode = 'missing' | 'cutoff';
type Kind = 'episodes' | 'movies';

const MODE_TABS = [
  { id: 'missing', label: 'Missing' },
  { id: 'cutoff', label: 'Cutoff unmet' },
] as const;

const KIND_OPTIONS = [
  { value: 'episodes' as const, label: 'Episodes' },
  { value: 'movies' as const, label: 'Movies' },
];

export function WantedMissingPage() {
  return <WantedPage mode="missing" />;
}

export function WantedCutoffPage() {
  return <WantedPage mode="cutoff" />;
}

/** Short mono date: "21 Feb 2025". */
export function shortDate(value: string | null | undefined): string {
  return formatDate(value, { day: 'numeric', month: 'short', year: 'numeric' });
}

function WantedPage({ mode }: { mode: Mode }) {
  const navigate = useNavigate();
  const [kind, setKind] = useState<Kind>('episodes');
  useEffect(() => {
    document.title = `${mode === 'missing' ? 'Missing' : 'Cutoff unmet'} · Arclight`;
  }, [mode]);
  return (
    <div className="wanted-page">
      <PageHeader index="05" title="Wanted">
        <Tabs
          compact
          aria-label="Wanted lists"
          value={mode}
          tabs={MODE_TABS}
          onChange={(id) => void navigate({ to: id === 'missing' ? '/wanted/missing' : '/wanted/cutoff' })}
        />
        <Segmented aria-label="Media type" options={KIND_OPTIONS} value={kind} onChange={setKind} />
      </PageHeader>
      {kind === 'episodes' ? <EpisodesList key={`e-${mode}`} mode={mode} /> : <MoviesList key={`m-${mode}`} mode={mode} />}
    </div>
  );
}

function useWantedList(mode: Mode, kind: Kind, page: number) {
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
    if (requests.length > 1) toast.push({ tone: 'info', title: `Queued ${requests.length} searches` });
  };
  return { run, running, search };
}

function statusChip(mode: Mode) {
  return mode === 'missing' ? <StatusChip status="missing" /> : <StatusChip status="cutoffUnmet" />;
}

interface ListShellProps<T> {
  mode: Mode;
  noun: string;
  total: number | undefined;
  page: number;
  onPage: (p: number) => void;
  rows: T[] | undefined;
  loading: boolean;
  columns: Column<T>[];
  rowKey: (r: T) => number;
  rowLabel: (r: T) => string;
  mobileRow: (r: T) => { title: string; sub: string };
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
    <EmptyState title={p.mode === 'missing' ? `No missing ${p.noun}` : `No ${p.noun} below cutoff`}>
      {p.mode === 'missing' ? 'Every monitored item that has aired is on disk.' : 'Every file meets its profile cutoff.'}
    </EmptyState>
  );
  return (
    <Pane
      flush
      title={p.total === undefined ? p.noun.toUpperCase() : `${p.total} ${p.noun}`}
      actions={
        <Button variant="primary" size="sm" disabled={!p.total} loading={p.running} onClick={p.onSearchAll}>
          Search all
        </Button>
      }
    >
      {mobile ? (
        p.loading ? (
          <Loading />
        ) : (p.rows ?? []).length === 0 ? (
          empty
        ) : (
          <div className="mk-mlist" role="list" aria-label={`Wanted ${p.noun}`}>
            {(p.rows ?? []).map((r) => {
              const m = p.mobileRow(r);
              return (
                <SwipeRow key={p.rowKey(r)} onSearch={() => p.onSearchRows([p.rowKey(r)])} searchLabel={`Search ${p.rowLabel(r)}`}>
                  <div className="mk-mrow" role="listitem">
                    <div style={{ minWidth: 0 }}>
                      <div className="mk-mrow__title">{m.title}</div>
                      <div className="mk-mrow__sub al-num">{m.sub}</div>
                    </div>
                    {statusChip(p.mode)}
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
          rowLabel={(r) => `Select ${p.rowLabel(r)}`}
          empty={empty}
          caption={`Wanted ${p.noun}`}
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
                Search selected
              </Button>
              <Button variant="ghost" loading={p.running} onClick={p.onSearchAll}>
                Search all
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

function EpisodesList({ mode }: { mode: Mode }) {
  const [page, setPage] = useState(1);
  const [selected, setSelected] = useState<Set<RowKey>>(new Set());
  const list = useWantedList(mode, 'episodes', page);
  const batch = useBatchSearch();
  const toast = useToast();

  if (list.isError) return <QueryError error={list.error} onRetry={() => void list.refetch()} title="Could not load wanted episodes" />;
  if (list.data === null) return <CutoffPending />;
  const records = list.data ? (list.data.records as WantedEpisode[]) : undefined;

  const searchAll = async () => {
    try {
      const all =
        mode === 'missing'
          ? await libraryApi.wanted.missingEpisodes({ page: 1, pageSize: MAX_PAGE })
          : await libraryApi.wanted.cutoffEpisodes({ page: 1, pageSize: MAX_PAGE });
      const ids = all.records.map((r) => r.id);
      if (ids.length) await batch.run([{ episodeIds: ids }]);
    } catch (err) {
      toast.error('Search failed', errorMessage(err));
    }
  };

  const label = (r: WantedEpisode) => `${r.seriesTitle} ${episodeCode(r.seasonNumber, r.episodeNumber)}`;
  const columns: Column<WantedEpisode>[] = [
    {
      key: 'series',
      header: 'Series',
      cell: (r) => (
        <Link className="mk-link" to="/library/series/$id" params={{ id: String(r.seriesId) }}>
          {r.seriesTitle}
        </Link>
      ),
    },
    { key: 'episode', header: 'Episode', mono: true, cell: (r) => episodeCode(r.seasonNumber, r.episodeNumber), width: '96px' },
    { key: 'title', header: 'Title', muted: true, cell: (r) => r.title || '—' },
    { key: 'airDate', header: 'Air date', mono: true, cell: (r) => shortDate(r.airDateUtc ?? r.airDate), width: '130px' },
    { key: 'status', header: 'Status', cell: () => statusChip(mode), width: '150px' },
    {
      key: 'search',
      header: <span className="al-sr-only">Actions</span>,
      align: 'right',
      width: '96px',
      cell: (r) => (
        <Button size="sm" aria-label={`Search ${label(r)}`} onClick={() => batch.search.mutate({ episodeIds: [r.id] })}>
          Search
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
      mobileRow={(r) => ({ title: r.seriesTitle, sub: `${episodeCode(r.seasonNumber, r.episodeNumber)} · ${shortDate(r.airDateUtc ?? r.airDate)}` })}
      selected={selected}
      onSelect={setSelected}
      running={batch.running}
      onSearchRows={(ids) => void batch.run([{ episodeIds: ids }])}
      onSearchAll={() => void searchAll()}
    />
  );
}

function MoviesList({ mode }: { mode: Mode }) {
  const [page, setPage] = useState(1);
  const [selected, setSelected] = useState<Set<RowKey>>(new Set());
  const list = useWantedList(mode, 'movies', page);
  const profiles = useQualityProfiles();
  const batch = useBatchSearch();
  const toast = useToast();

  if (list.isError) return <QueryError error={list.error} onRetry={() => void list.refetch()} title="Could not load wanted movies" />;
  if (list.data === null) return <CutoffPending />;
  const records = list.data ? (list.data.records as Movie[]) : undefined;

  const searchAll = async () => {
    try {
      const all =
        mode === 'missing'
          ? await libraryApi.wanted.missingMovies({ page: 1, pageSize: MAX_PAGE })
          : await libraryApi.wanted.cutoffMovies({ page: 1, pageSize: MAX_PAGE });
      await batch.run(all.records.map((m) => ({ movieId: m.id })));
    } catch (err) {
      toast.error('Search failed', errorMessage(err));
    }
  };

  const columns: Column<Movie>[] = [
    {
      key: 'title',
      header: 'Title',
      cell: (r) => (
        <Link className="mk-link" to="/library/movie/$id" params={{ id: String(r.id) }}>
          {r.title}
        </Link>
      ),
    },
    { key: 'year', header: 'Year', mono: true, cell: (r) => r.year || '—', width: '72px' },
    { key: 'profile', header: 'Profile', muted: true, cell: (r) => profiles.data?.find((p) => p.id === r.qualityProfileId)?.name ?? `#${r.qualityProfileId}` },
    { key: 'cinemas', header: 'In cinemas', mono: true, cell: (r) => shortDate(r.inCinemas) },
    { key: 'digital', header: 'Digital', mono: true, cell: (r) => shortDate(r.digitalRelease) },
    { key: 'physical', header: 'Physical', mono: true, cell: (r) => shortDate(r.physicalRelease) },
    { key: 'status', header: 'Status', cell: () => statusChip(mode), width: '150px' },
    {
      key: 'search',
      header: <span className="al-sr-only">Actions</span>,
      align: 'right',
      width: '96px',
      cell: (r) => (
        <Button size="sm" aria-label={`Search ${r.title}`} onClick={() => batch.search.mutate({ movieId: r.id })}>
          Search
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
      mobileRow={(r) => ({ title: r.title, sub: `${r.year || '—'} · ${shortDate(r.digitalRelease ?? r.inCinemas)}` })}
      selected={selected}
      onSelect={setSelected}
      running={batch.running}
      onSearchRows={(ids) => void batch.run(ids.map((movieId) => ({ movieId })))}
      onSearchAll={() => void searchAll()}
    />
  );
}

function CutoffPending() {
  // TODO(contract): GET /wanted/cutoff/{episodes,movies} is not served by apps/api yet.
  return (
    <EmptyState title="Cutoff unmet is not available yet">
      The api does not serve the cutoff unmet lists yet. They appear here once the route lands.
    </EmptyState>
  );
}
