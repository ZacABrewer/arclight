import { useEffect, useMemo, useState } from 'react';
import { Link } from '@tanstack/react-router';
import type { QualityProfile, RootFolder, Tag } from '@media-tron/shared';
import { Button } from '../../components/button.js';
import { Card } from '../../components/card.js';
import { EmptyState } from '../../components/empty-state.js';
import { ErrorView } from '../../components/error-boundary.js';
import { Input, Select } from '../../components/form.js';
import { DeleteMediaDialog } from '../../components/media/delete-media-dialog.js';
import { formatBytes, formatDate } from '../../components/media/format.js';
import { MonitorToggle, Poster, ProgressBar, TagList } from '../../components/media/media-ui.js';
import { Page } from '../../components/page.js';
import { LoadingBlock } from '../../components/spinner.js';
import { Table, type Column, type SortState } from '../../components/table.js';
import {
  useBulkUpdateMovies,
  useBulkUpdateSeries,
  useDeleteMovies,
  useDeleteSeries,
  useMovieList,
  useQualityProfiles,
  useRootFolders,
  useSeriesList,
  useSetMovieMonitored,
  useSetSeriesMonitored,
  useTags,
} from '../../hooks/library.js';
import { cx } from '../../lib/cx.js';
import {
  DEFAULT_FILTERS,
  MOVIE_STATUSES,
  SERIES_STATUSES,
  SORT_LABELS,
  STATUS_LABELS,
  activeFilterCount,
  filterRows,
  movieRow,
  seriesRow,
  sortLibraryRows,
  type LibraryFilters,
  type LibraryKind,
  type LibraryRow,
  type LibrarySort,
  type LibrarySortKey,
  type MonitoredFilter,
} from './library-filters.js';

type View = 'posters' | 'table';

function usePersistent<T>(key: string, initial: T): [T, (v: T) => void] {
  const [value, setValue] = useState<T>(() => {
    try {
      const raw = localStorage.getItem(key);
      return raw ? (JSON.parse(raw) as T) : initial;
    } catch {
      return initial;
    }
  });
  const set = (v: T) => {
    setValue(v);
    try {
      localStorage.setItem(key, JSON.stringify(v));
    } catch {
      // Storage unavailable (private mode): keep the in-memory value only.
    }
  };
  return [value, set];
}

export function SeriesLibraryPage() {
  return <LibraryIndexPage kind="series" />;
}

export function MovieLibraryPage() {
  return <LibraryIndexPage kind="movie" />;
}

export function LibraryIndexPage({ kind }: { kind: LibraryKind }) {
  const seriesQ = useSeriesList();
  const moviesQ = useMovieList();
  const query = kind === 'series' ? seriesQ : moviesQ;
  const profiles = useQualityProfiles();
  const rootFolders = useRootFolders();
  const tags = useTags();

  const [view, setView] = usePersistent<View>(`library.${kind}.view`, 'posters');
  const [sort, setSort] = usePersistent<LibrarySort>(`library.${kind}.sort`, { key: 'title', direction: 'asc' });
  const [filters, setFilters] = useState<LibraryFilters>(DEFAULT_FILTERS);
  const [selected, setSelected] = useState<ReadonlySet<number>>(new Set());

  // Switching tabs resets the selection and kind-specific filters.
  useEffect(() => {
    setSelected(new Set());
    setFilters((f) => ({ ...f, status: null }));
  }, [kind]);

  const allRows = useMemo<LibraryRow[]>(
    () => (kind === 'series' ? (seriesQ.data ?? []).map(seriesRow) : (moviesQ.data ?? []).map(movieRow)),
    [kind, seriesQ.data, moviesQ.data],
  );
  const rows = useMemo(() => sortLibraryRows(filterRows(allRows, filters), sort), [allRows, filters, sort]);

  const toggleSelected = (id: number) =>
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  const allVisibleSelected = rows.length > 0 && rows.every((r) => selected.has(r.id));
  const selectAllVisible = () => setSelected(allVisibleSelected ? new Set() : new Set(rows.map((r) => r.id)));

  const setSeriesMonitored = useSetSeriesMonitored();
  const setMovieMonitored = useSetMovieMonitored();
  const toggleMonitored = (row: LibraryRow, monitored: boolean) =>
    row.kind === 'series' ? setSeriesMonitored.mutate({ id: row.id, monitored }) : setMovieMonitored.mutate({ id: row.id, monitored });

  const profileName = (id: number) => profiles.data?.find((p) => p.id === id)?.name ?? `#${id}`;

  return (
    <Page
      title={kind === 'series' ? 'TV' : 'Movies'}
      subtitle={query.data ? `${rows.length} of ${allRows.length} ${kind === 'series' ? 'series' : 'movies'}` : undefined}
      actions={
        <Link to="/library/add" className="btn btn-primary btn-md">
          Add new
        </Link>
      }
    >
      <div className="toolbar">
        <nav className="segmented" aria-label="Library type">
          <Link to="/library/tv" aria-current={kind === 'series' ? 'page' : undefined}>
            TV
          </Link>
          <Link to="/library/movies" aria-current={kind === 'movie' ? 'page' : undefined}>
            Movies
          </Link>
        </nav>
        <Input
          type="search"
          className="toolbar-search"
          aria-label="Filter library"
          placeholder="Filter by title…"
          value={filters.search}
          onChange={(e) => setFilters({ ...filters, search: e.target.value })}
        />
        <div className="toolbar-spacer" />
        <Select
          aria-label="Sort by"
          value={sort.key}
          onChange={(e) => setSort({ ...sort, key: e.target.value as LibrarySortKey })}
          options={Object.entries(SORT_LABELS).map(([value, label]) => ({ value, label }))}
        />
        <Button
          size="sm"
          aria-label={sort.direction === 'asc' ? 'Sort ascending' : 'Sort descending'}
          onClick={() => setSort({ ...sort, direction: sort.direction === 'asc' ? 'desc' : 'asc' })}
        >
          {sort.direction === 'asc' ? '▲' : '▼'}
        </Button>
        <div className="segmented" role="group" aria-label="View">
          <button type="button" aria-pressed={view === 'posters'} onClick={() => setView('posters')}>
            Posters
          </button>
          <button type="button" aria-pressed={view === 'table'} onClick={() => setView('table')}>
            Table
          </button>
        </div>
      </div>

      <FilterBar kind={kind} filters={filters} onChange={setFilters} profiles={profiles.data} tags={tags.data} />

      {selected.size > 0 ? (
        <BulkBar
          kind={kind}
          ids={[...selected]}
          profiles={profiles.data}
          rootFolders={rootFolders.data?.filter((r) => r.mediaType === kind)}
          onClear={() => setSelected(new Set())}
          allVisibleSelected={allVisibleSelected}
          onSelectAll={selectAllVisible}
        />
      ) : null}

      {query.isPending ? (
        <LoadingBlock />
      ) : query.isError ? (
        <ErrorView error={query.error} onRetry={() => void query.refetch()} />
      ) : allRows.length === 0 ? (
        <Card>
          <EmptyState
            title={kind === 'series' ? 'No series yet' : 'No movies yet'}
            action={
              <Link to="/library/add" className="btn btn-primary btn-md">
                Add your first {kind === 'series' ? 'series' : 'movie'}
              </Link>
            }
          />
        </Card>
      ) : rows.length === 0 ? (
        <Card>
          <EmptyState
            title="Nothing matches these filters"
            action={<Button onClick={() => setFilters(DEFAULT_FILTERS)}>Clear filters</Button>}
          />
        </Card>
      ) : view === 'posters' ? (
        <div className="poster-grid">
          {rows.map((row) => (
            <PosterCard
              key={row.id}
              row={row}
              selected={selected.has(row.id)}
              onSelect={() => toggleSelected(row.id)}
              onMonitor={(m) => toggleMonitored(row, m)}
            />
          ))}
        </div>
      ) : (
        <Card flush>
          <LibraryTable
            rows={rows}
            sort={sort}
            onSort={setSort}
            selected={selected}
            onSelect={toggleSelected}
            allSelected={allVisibleSelected}
            onSelectAll={selectAllVisible}
            onMonitor={toggleMonitored}
            profileName={profileName}
            tags={tags.data}
          />
        </Card>
      )}
    </Page>
  );
}

function detailLink(row: LibraryRow) {
  return row.kind === 'series'
    ? ({ to: '/library/series/$id', params: { id: String(row.id) } } as const)
    : ({ to: '/library/movie/$id', params: { id: String(row.id) } } as const);
}

function PosterCard({
  row,
  selected,
  onSelect,
  onMonitor,
}: {
  row: LibraryRow;
  selected: boolean;
  onSelect: () => void;
  onMonitor: (monitored: boolean) => void;
}) {
  return (
    <div className={cx('poster-card', selected && 'poster-card-selected', !row.monitored && 'poster-card-unmonitored')}>
      <input type="checkbox" className="poster-card-select" aria-label={`Select ${row.title}`} checked={selected} onChange={onSelect} />
      <span className="poster-card-monitor">
        <MonitorToggle monitored={row.monitored} onChange={onMonitor} label={`${row.monitored ? 'Unmonitor' : 'Monitor'} ${row.title}`} />
      </span>
      <Link {...detailLink(row)}>
        <Poster url={row.posterUrl} title={row.title} />
        <div className="poster-card-title" title={row.title}>
          {row.title}
        </div>
      </Link>
      <ProgressBar value={row.have} total={row.total} label={`${row.title} progress`} />
      <div className="poster-card-meta">
        <span>{row.year || '—'}</span>
        <span>{formatBytes(row.sizeOnDisk)}</span>
      </div>
    </div>
  );
}

function LibraryTable({
  rows,
  sort,
  onSort,
  selected,
  onSelect,
  allSelected,
  onSelectAll,
  onMonitor,
  profileName,
  tags,
}: {
  rows: LibraryRow[];
  sort: LibrarySort;
  onSort: (s: LibrarySort) => void;
  selected: ReadonlySet<number>;
  onSelect: (id: number) => void;
  allSelected: boolean;
  onSelectAll: () => void;
  onMonitor: (row: LibraryRow, monitored: boolean) => void;
  profileName: (id: number) => string;
  tags: Tag[] | undefined;
}) {
  const columns: Column<LibraryRow>[] = [
    {
      key: 'select',
      header: <input type="checkbox" aria-label="Select all" checked={allSelected} onChange={onSelectAll} />,
      cell: (r) => <input type="checkbox" aria-label={`Select ${r.title}`} checked={selected.has(r.id)} onChange={() => onSelect(r.id)} />,
      width: '32px',
    },
    {
      key: 'monitored',
      header: <span className="sr-only">Monitored</span>,
      cell: (r) => <MonitorToggle monitored={r.monitored} onChange={(m) => onMonitor(r, m)} label={`${r.monitored ? 'Unmonitor' : 'Monitor'} ${r.title}`} />,
      width: '32px',
    },
    {
      key: 'title',
      header: 'Title',
      sortValue: (r) => r.sortTitle,
      cell: (r) => (
        <span>
          <Link {...detailLink(r)}>{r.title}</Link> <TagList ids={r.tags} tags={tags} />
        </span>
      ),
    },
    { key: 'year', header: 'Year', sortValue: (r) => r.year, cell: (r) => r.year || '—' },
    { key: 'status', header: 'Status', cell: (r) => STATUS_LABELS[r.status] ?? r.status },
    { key: 'profile', header: 'Profile', cell: (r) => profileName(r.qualityProfileId) },
    { key: 'subtitle', header: rows[0]?.kind === 'movie' ? 'Studio' : 'Network', cell: (r) => r.subtitle ?? '—' },
    {
      key: 'progress',
      header: rows[0]?.kind === 'movie' ? 'File' : 'Episodes',
      sortValue: (r) => r.have,
      cell: (r) => <ProgressBar value={r.have} total={r.total} label={`${r.title} progress`} />,
      width: '140px',
    },
    { key: 'size', header: 'Size', sortValue: (r) => r.sizeOnDisk, cell: (r) => formatBytes(r.sizeOnDisk), align: 'right' },
    { key: 'added', header: 'Added', sortValue: (r) => r.added, cell: (r) => formatDate(r.added) },
  ];

  const tableSort: SortState = { key: sort.key, direction: sort.direction };
  return (
    <Table
      columns={columns}
      rows={rows}
      rowKey={(r) => r.id}
      sort={tableSort}
      manualSort
      onSortChange={(s) => onSort({ key: s.key as LibrarySortKey, direction: s.direction })}
      caption="Library"
    />
  );
}

function FilterBar({
  kind,
  filters,
  onChange,
  profiles,
  tags,
}: {
  kind: LibraryKind;
  filters: LibraryFilters;
  onChange: (f: LibraryFilters) => void;
  profiles: QualityProfile[] | undefined;
  tags: Tag[] | undefined;
}) {
  const statuses = kind === 'series' ? SERIES_STATUSES : MOVIE_STATUSES;
  const num = (v: string) => (v === '' ? null : Number(v));
  return (
    <div className="toolbar" role="group" aria-label="Filters">
      <Select
        aria-label="Monitored filter"
        value={filters.monitored}
        onChange={(e) => onChange({ ...filters, monitored: e.target.value as MonitoredFilter })}
        options={[
          { value: 'all', label: 'All' },
          { value: 'monitored', label: 'Monitored only' },
          { value: 'unmonitored', label: 'Unmonitored only' },
        ]}
      />
      <label className="check-row">
        <input type="checkbox" checked={filters.missing} onChange={(e) => onChange({ ...filters, missing: e.target.checked })} />
        Missing files
      </label>
      <Select
        aria-label="Quality profile filter"
        value={filters.qualityProfileId?.toString() ?? ''}
        onChange={(e) => onChange({ ...filters, qualityProfileId: num(e.target.value) })}
      >
        <option value="">Any profile</option>
        {profiles?.map((p) => (
          <option key={p.id} value={p.id}>
            {p.name}
          </option>
        ))}
      </Select>
      <Select aria-label="Tag filter" value={filters.tagId?.toString() ?? ''} onChange={(e) => onChange({ ...filters, tagId: num(e.target.value) })}>
        <option value="">Any tag</option>
        {tags?.map((t) => (
          <option key={t.id} value={t.id}>
            {t.label}
          </option>
        ))}
      </Select>
      <Select
        aria-label="Status filter"
        value={filters.status ?? ''}
        onChange={(e) => onChange({ ...filters, status: e.target.value || null })}
      >
        <option value="">Any status</option>
        {statuses.map((s) => (
          <option key={s} value={s}>
            {STATUS_LABELS[s]}
          </option>
        ))}
      </Select>
      {activeFilterCount(filters) > 0 || filters.search ? (
        <Button size="sm" variant="ghost" onClick={() => onChange(DEFAULT_FILTERS)}>
          Clear filters
        </Button>
      ) : null}
    </div>
  );
}

function BulkBar({
  kind,
  ids,
  profiles,
  rootFolders,
  onClear,
  allVisibleSelected,
  onSelectAll,
}: {
  kind: LibraryKind;
  ids: number[];
  profiles: QualityProfile[] | undefined;
  rootFolders: RootFolder[] | undefined;
  onClear: () => void;
  allVisibleSelected: boolean;
  onSelectAll: () => void;
}) {
  const bulkSeries = useBulkUpdateSeries();
  const bulkMovies = useBulkUpdateMovies();
  const deleteSeries = useDeleteSeries();
  const deleteMovies = useDeleteMovies();
  const [confirmDelete, setConfirmDelete] = useState(false);
  const pending = bulkSeries.isPending || bulkMovies.isPending;

  const apply = (patch: { monitored?: boolean; qualityProfileId?: number; rootFolderPath?: string }) => {
    if (kind === 'series') bulkSeries.mutate({ ids, ...patch });
    else bulkMovies.mutate({ ids, ...patch });
  };

  const noun = kind === 'series' ? 'series' : ids.length === 1 ? 'movie' : 'movies';
  return (
    <div className="bulk-bar" role="region" aria-label="Bulk actions">
      <strong>
        {ids.length} {noun} selected
      </strong>
      <Button size="sm" variant="ghost" onClick={onSelectAll}>
        {allVisibleSelected ? 'Select none' : 'Select all'}
      </Button>
      <Button size="sm" disabled={pending} onClick={() => apply({ monitored: true })}>
        Monitor
      </Button>
      <Button size="sm" disabled={pending} onClick={() => apply({ monitored: false })}>
        Unmonitor
      </Button>
      <Select
        aria-label="Set quality profile"
        value=""
        disabled={pending}
        onChange={(e) => e.target.value && apply({ qualityProfileId: Number(e.target.value) })}
      >
        <option value="">Set profile…</option>
        {profiles?.map((p) => (
          <option key={p.id} value={p.id}>
            {p.name}
          </option>
        ))}
      </Select>
      <Select
        aria-label="Move to root folder"
        value=""
        disabled={pending}
        onChange={(e) => e.target.value && apply({ rootFolderPath: e.target.value })}
      >
        <option value="">Move to root folder…</option>
        {rootFolders?.map((r) => (
          <option key={r.id} value={r.path}>
            {r.path}
          </option>
        ))}
      </Select>
      <Button size="sm" variant="danger" onClick={() => setConfirmDelete(true)}>
        Delete
      </Button>
      <div className="toolbar-spacer" />
      <Button size="sm" variant="ghost" onClick={onClear}>
        Clear selection
      </Button>
      <DeleteMediaDialog
        open={confirmDelete}
        onClose={() => setConfirmDelete(false)}
        subject={`${ids.length} ${noun}`}
        loading={deleteSeries.isPending || deleteMovies.isPending}
        onConfirm={(opts) => {
          const m = kind === 'series' ? deleteSeries : deleteMovies;
          m.mutate(
            { ids, ...opts },
            {
              onSuccess: () => {
                setConfirmDelete(false);
                onClear();
              },
            },
          );
        }}
      />
    </div>
  );
}
