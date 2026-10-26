import { useState } from 'react';
import { Link } from '@tanstack/react-router';
import type { Movie, WantedEpisode } from '@media-tron/shared';
import { ApiError, errorMessage } from '../../api/client.js';
import { libraryApi } from '../../api/library.js';
import { Button } from '../../components/button.js';
import { Card } from '../../components/card.js';
import { EmptyState } from '../../components/empty-state.js';
import { ErrorView } from '../../components/error-boundary.js';
import { EpisodeStatusChip } from '../../components/media/media-ui.js';
import { episodeCode, formatDate } from '../../components/media/format.js';
import { Page } from '../../components/page.js';
import { Table, type Column } from '../../components/table.js';
import { Tabs } from '../../components/tabs.js';
import { useToast } from '../../components/toast.js';
import { useAutomaticSearch, useCutoffUnmet, useMissing, useQualityProfiles } from '../../hooks/library.js';
import '../../components/media/media.css';

const PAGE_SIZE = 50;
/** Largest page the api allows; "search all" collects ids with one request of this size. */
const MAX_PAGE = 500;

type Mode = 'missing' | 'cutoff';

export function WantedMissingPage() {
  return <WantedPage mode="missing" />;
}

export function WantedCutoffPage() {
  return <WantedPage mode="cutoff" />;
}

function WantedPage({ mode }: { mode: Mode }) {
  return (
    <Page title={mode === 'missing' ? 'Missing' : 'Cutoff unmet'}>
      <Tabs
        tabs={[
          { id: 'episodes', label: 'Episodes', content: <EpisodesTab mode={mode} /> },
          { id: 'movies', label: 'Movies', content: <MoviesTab mode={mode} /> },
        ]}
      />
    </Page>
  );
}

function useWantedList(mode: Mode, kind: 'episodes' | 'movies', page: number) {
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
  const run = async (requests: Array<Parameters<typeof search.mutateAsync>[0]>) => {
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
  return { run, running };
}

function EpisodesTab({ mode }: { mode: Mode }) {
  const [page, setPage] = useState(1);
  const [selected, setSelected] = useState<ReadonlySet<number>>(new Set());
  const list = useWantedList(mode, 'episodes', page);
  const batch = useBatchSearch();
  const toast = useToast();
  const records = (list.data?.records ?? []) as WantedEpisode[];

  if (list.isError) return <ErrorView error={list.error} onRetry={() => void list.refetch()} />;
  if (list.data === null) return <CutoffPending />;

  const toggle = (id: number) =>
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  const allSelected = records.length > 0 && records.every((r) => selected.has(r.id));

  const searchAll = async () => {
    try {
      const all =
        mode === 'missing'
          ? await libraryApi.wanted.missingEpisodes({ page: 1, pageSize: MAX_PAGE })
          : await libraryApi.wanted.cutoffEpisodes({ page: 1, pageSize: MAX_PAGE });
      const ids = all.records.map((r) => r.id);
      if (ids.length) await batch.run([{ episodeIds: ids }]);
    } catch (err) {
      toast.error('Search failed', err instanceof ApiError ? err.message : errorMessage(err));
    }
  };

  const columns: Column<WantedEpisode>[] = [
    {
      key: 'select',
      header: (
        <input
          type="checkbox"
          aria-label="Select all"
          checked={allSelected}
          onChange={() => setSelected(allSelected ? new Set() : new Set(records.map((r) => r.id)))}
        />
      ),
      cell: (r) => <input type="checkbox" aria-label={`Select ${r.seriesTitle} ${episodeCode(r.seasonNumber, r.episodeNumber)}`} checked={selected.has(r.id)} onChange={() => toggle(r.id)} />,
      width: '32px',
    },
    {
      key: 'series',
      header: 'Series',
      cell: (r) => (
        <Link to="/library/series/$id" params={{ id: String(r.seriesId) }}>
          {r.seriesTitle}
        </Link>
      ),
    },
    { key: 'episode', header: 'Episode', cell: (r) => episodeCode(r.seasonNumber, r.episodeNumber) },
    { key: 'title', header: 'Title', cell: (r) => r.title || '—' },
    { key: 'airDate', header: 'Air date', cell: (r) => formatDate(r.airDateUtc ?? r.airDate) },
    { key: 'status', header: 'Status', cell: (r) => <EpisodeStatusChip episode={r} /> },
  ];

  return (
    <Card
      flush
      actions={
        <>
          <Button size="sm" disabled={selected.size === 0} loading={batch.running} onClick={() => void batch.run([{ episodeIds: [...selected] }])}>
            Search selected ({selected.size})
          </Button>
          <Button size="sm" variant="primary" disabled={!list.data?.totalRecords} loading={batch.running} onClick={() => void searchAll()}>
            Search all
          </Button>
        </>
      }
      title={list.data ? `${list.data.totalRecords} episodes` : 'Episodes'}
    >
      <Table
        columns={columns}
        rows={list.data ? records : undefined}
        loading={list.isPending}
        rowKey={(r) => r.id}
        sortable={false}
        empty={<EmptyState title={mode === 'missing' ? 'No missing episodes' : 'No episodes below cutoff'} />}
        caption="Wanted episodes"
      />
      <Pager page={page} pageSize={PAGE_SIZE} total={list.data?.totalRecords ?? 0} onPage={(p) => { setPage(p); setSelected(new Set()); }} />
    </Card>
  );
}

function MoviesTab({ mode }: { mode: Mode }) {
  const [page, setPage] = useState(1);
  const [selected, setSelected] = useState<ReadonlySet<number>>(new Set());
  const list = useWantedList(mode, 'movies', page);
  const profiles = useQualityProfiles();
  const batch = useBatchSearch();
  const toast = useToast();
  const records = (list.data?.records ?? []) as Movie[];

  if (list.isError) return <ErrorView error={list.error} onRetry={() => void list.refetch()} />;
  if (list.data === null) return <CutoffPending />;

  const allSelected = records.length > 0 && records.every((r) => selected.has(r.id));
  const toggle = (id: number) =>
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

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
      key: 'select',
      header: (
        <input
          type="checkbox"
          aria-label="Select all"
          checked={allSelected}
          onChange={() => setSelected(allSelected ? new Set() : new Set(records.map((r) => r.id)))}
        />
      ),
      cell: (r) => <input type="checkbox" aria-label={`Select ${r.title}`} checked={selected.has(r.id)} onChange={() => toggle(r.id)} />,
      width: '32px',
    },
    {
      key: 'title',
      header: 'Title',
      cell: (r) => (
        <Link to="/library/movie/$id" params={{ id: String(r.id) }}>
          {r.title}
        </Link>
      ),
    },
    { key: 'year', header: 'Year', cell: (r) => r.year || '—' },
    { key: 'profile', header: 'Profile', cell: (r) => profiles.data?.find((p) => p.id === r.qualityProfileId)?.name ?? `#${r.qualityProfileId}` },
    { key: 'cinemas', header: 'In cinemas', cell: (r) => formatDate(r.inCinemas) },
    { key: 'digital', header: 'Digital', cell: (r) => formatDate(r.digitalRelease) },
    { key: 'physical', header: 'Physical', cell: (r) => formatDate(r.physicalRelease) },
  ];

  return (
    <Card
      flush
      title={list.data ? `${list.data.totalRecords} movies` : 'Movies'}
      actions={
        <>
          <Button
            size="sm"
            disabled={selected.size === 0}
            loading={batch.running}
            onClick={() => void batch.run([...selected].map((movieId) => ({ movieId })))}
          >
            Search selected ({selected.size})
          </Button>
          <Button size="sm" variant="primary" disabled={!list.data?.totalRecords} loading={batch.running} onClick={() => void searchAll()}>
            Search all
          </Button>
        </>
      }
    >
      <Table
        columns={columns}
        rows={list.data ? records : undefined}
        loading={list.isPending}
        rowKey={(r) => r.id}
        sortable={false}
        empty={<EmptyState title={mode === 'missing' ? 'No missing movies' : 'No movies below cutoff'} />}
        caption="Wanted movies"
      />
      <Pager page={page} pageSize={PAGE_SIZE} total={list.data?.totalRecords ?? 0} onPage={(p) => { setPage(p); setSelected(new Set()); }} />
    </Card>
  );
}

function CutoffPending() {
  return (
    <Card>
      {/* TODO(contract): GET /wanted/cutoff/{episodes,movies} is not served by apps/api yet. */}
      <EmptyState title="Cutoff unmet is not available yet">
        <p className="muted">The api does not serve the cutoff-unmet lists yet. They will appear here once the route lands.</p>
      </EmptyState>
    </Card>
  );
}

export function Pager({ page, pageSize, total, onPage }: { page: number; pageSize: number; total: number; onPage: (p: number) => void }) {
  const pages = Math.max(1, Math.ceil(total / pageSize));
  if (pages <= 1) return null;
  return (
    <nav className="pager" aria-label="Pagination">
      <Button size="sm" disabled={page <= 1} onClick={() => onPage(page - 1)}>
        Previous
      </Button>
      <span className="muted">
        Page {page} of {pages}
      </span>
      <Button size="sm" disabled={page >= pages} onClick={() => onPage(page + 1)}>
        Next
      </Button>
    </nav>
  );
}
