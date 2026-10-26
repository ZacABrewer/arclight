import { useEffect, useMemo, useState, type CSSProperties } from 'react';
import { Link, useNavigate } from '@tanstack/react-router';
import type { QualityProfile, RootFolder, Tag } from '@arclight/shared';
import {
  Button,
  Checkbox,
  CountBadge,
  EmptyState,
  FilterBar,
  FloatBar,
  FloatBarDivider,
  Input,
  Menu,
  Meter,
  PageHeader,
  Popover,
  PosterCard,
  Poster,
  SectionHead,
  Segmented,
  Select,
  Slider,
  StatusChip,
  Table,
  buttonClass,
  type Column,
  type SortState,
} from '../../arclight/index.js';
import { DeleteMediaDialog } from '../../components/media/delete-media-dialog.js';
import { AddAdditionalDialog } from '../../features/additional-languages/add-additional-dialog.js';
import { formatBytes, formatDate } from '../../components/media/format.js';
import { useUiPreferences } from '../../hooks/ui-preferences.js';
import { Loading, MonitorSwitch, Num, PosterSkeletons, QueryError, TagChips } from '../../components/media/media-kit.js';
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
import {
  DEFAULT_FILTERS,
  MOVIE_STATUSES,
  SERIES_STATUSES,
  SORT_LABELS,
  STATUS_LABELS,
  activeFilterCount,
  filterRows,
  groupCollections,
  movieRow,
  progressTone,
  rowMeta,
  seriesRow,
  sortLibraryRows,
  type LibraryFilters,
  type LibraryKind,
  type LibraryRow,
  type LibrarySort,
  type LibrarySortKey,
  type MonitoredFilter,
} from './library-filters.js';
import './library.css';
import { t } from '../../i18n/index.js';

export type LibraryView = 'posters' | 'table' | 'overview' | 'collections';

/** Poster grid column count: the size slider's range (Page 02). */
export const MIN_COLUMNS = 5;
export const MAX_COLUMNS = 10;

export function clampColumns(n: number): number {
  return Number.isFinite(n) ? Math.min(MAX_COLUMNS, Math.max(MIN_COLUMNS, Math.round(n))) : 7;
}

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

/** A number kept in sessionStorage; null until set. */
function useSessionNumber(key: string): [number | null, (v: number) => void] {
  const [value, setValue] = useState<number | null>(() => {
    try {
      const raw = sessionStorage.getItem(key);
      const n = raw === null ? NaN : Number(raw);
      return Number.isFinite(n) ? n : null;
    } catch {
      return null;
    }
  });
  const set = (v: number) => {
    setValue(v);
    try {
      sessionStorage.setItem(key, String(v));
    } catch {
      // Storage unavailable: keep the in-memory value only.
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

function noun(kind: LibraryKind, n: number): string {
  return t('library.index.noun', { kind, count: n });
}

export function LibraryIndexPage({ kind }: { kind: LibraryKind }) {
  const seriesQ = useSeriesList();
  const moviesQ = useMovieList();
  const query = kind === 'series' ? seriesQ : moviesQ;
  const profiles = useQualityProfiles();
  const rootFolders = useRootFolders();
  const tags = useTags();
  const navigate = useNavigate();

  const [storedView, setView] = usePersistent<LibraryView>(`library.${kind}.view`, 'posters');
  const view: LibraryView = kind === 'series' && storedView === 'collections' ? 'posters' : storedView;
  const [sort, setSort] = usePersistent<LibrarySort>(`library.${kind}.sort`, { key: 'title', direction: 'asc' });
  // The UI preference (Settings → General → UI) is the default; moving the slider wins for this browser session.
  const prefs = useUiPreferences();
  const [columnsOverride, setColumns] = useSessionNumber('library.columns');
  const columns = columnsOverride ?? prefs.posterColumns;
  const [showFilters, setShowFilters] = usePersistent<boolean>('library.filters', true);
  const [filters, setFilters] = useState<LibraryFilters>(DEFAULT_FILTERS);
  const [selectMode, setSelectMode] = useState(false);
  const [selected, setSelected] = useState<ReadonlySet<number>>(new Set());

  // Switching kind resets the selection and kind-specific filters.
  useEffect(() => {
    setSelected(new Set());
    setSelectMode(false);
    setFilters((f) => ({ ...f, status: null }));
  }, [kind]);

  const allRows = useMemo<LibraryRow[]>(
    () => (kind === 'series' ? (seriesQ.data ?? []).map(seriesRow) : (moviesQ.data ?? []).map(movieRow)),
    [kind, seriesQ.data, moviesQ.data],
  );
  const rows = useMemo(() => sortLibraryRows(filterRows(allRows, filters), sort), [allRows, filters, sort]);
  const totalSize = useMemo(() => allRows.reduce((sum, r) => sum + r.sizeOnDisk, 0), [allRows]);

  const toggleSelected = (id: number) =>
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  const clearSelection = () => {
    setSelected(new Set());
    setSelectMode(false);
  };

  const setSeriesMonitored = useSetSeriesMonitored();
  const setMovieMonitored = useSetMovieMonitored();
  const toggleMonitored = (row: LibraryRow, monitored: boolean) =>
    row.kind === 'series' ? setSeriesMonitored.mutate({ id: row.id, monitored }) : setMovieMonitored.mutate({ id: row.id, monitored });

  const profileName = (id: number) => profiles.data?.find((p) => p.id === id)?.name ?? `#${id}`;
  const filterCount = activeFilterCount(filters) + (filters.search ? 1 : 0);
  const addLabel = kind === 'series' ? t('library.addSeries') : t('library.addMovie');
  const viewOptions = [
    { value: 'posters' as const, label: t('library.posters') },
    { value: 'table' as const, label: t('library.table') },
    { value: 'overview' as const, label: t('library.overview') },
    ...(kind === 'movie' ? [{ value: 'collections' as const, label: t('common.collections') }] : []),
  ];

  return (
    <div className="lib-page" style={{ '--mk-cols': clampColumns(columns) } as CSSProperties}>
      <PageHeader
        index="01"
        title={t('common.library')}
        actions={
          <>
            <Button
              variant={selectMode ? 'secondary' : 'ghost'}
              aria-pressed={selectMode}
              onClick={() => (selectMode ? clearSelection() : setSelectMode(true))}
            >
              {selectMode ? t('library.done') : t('common.select')}
            </Button>
            <Link to="/library/add" className={buttonClass({ variant: 'primary' })}>
              {addLabel}
            </Link>
          </>
        }
      >
        <Segmented
          aria-label={t('library.libraryType')}
          value={kind}
          onChange={(k) => void navigate({ to: k === 'series' ? '/library/tv' : '/library/movies' })}
          options={[
            { value: 'series', label: t('common.series') },
            { value: 'movie', label: t('common.movies') },
          ]}
        />
        {query.data ? (
          <span className="mk-count">
            {rows.length !== allRows.length ? (
              <>
                <Num>{rows.length}</Num> {t('common.of')} <Num>{allRows.length}</Num> {noun(kind, allRows.length)}
              </>
            ) : (
              <>
                <Num>{allRows.length}</Num> {noun(kind, allRows.length)}
              </>
            )}{' '}
            · <Num>{formatBytes(totalSize)}</Num>
          </span>
        ) : null}
        <Segmented aria-label={t('library.view')} variant="soft" value={view} onChange={setView} options={viewOptions} />
        <Select
          aria-label={t('library.sortBy')}
          value={sort.key}
          onChange={(e) => setSort({ ...sort, key: e.target.value as LibrarySortKey })}
          options={Object.entries(SORT_LABELS).map(([value, label]) => ({ value, label: t('library.sortLabel', { label }) }))}
        />
        <Button
          size="sm"
          aria-label={sort.direction === 'asc' ? t('library.sortAscending') : t('library.sortDescending')}
          onClick={() => setSort({ ...sort, direction: sort.direction === 'asc' ? 'desc' : 'asc' })}
        >
          {sort.direction === 'asc' ? '↑' : '↓'}
        </Button>
        <Button aria-expanded={showFilters} onClick={() => setShowFilters(!showFilters)}>
          {t('library.filter')} {filterCount > 0 ? <CountBadge>{filterCount}</CountBadge> : null}
        </Button>
        {view === 'posters' || view === 'collections' ? (
          <Slider
            className="mk-hide-mobile"
            label={t('common.size')}
            min={MIN_COLUMNS}
            max={MAX_COLUMNS}
            value={clampColumns(MIN_COLUMNS + MAX_COLUMNS - columns)}
            showValue={false}
            aria-label={t('library.posterSize')}
            onChange={(v) => setColumns(MIN_COLUMNS + MAX_COLUMNS - v)}
          />
        ) : null}
      </PageHeader>

      {showFilters ? <LibraryFilterBar kind={kind} filters={filters} onChange={setFilters} profiles={profiles.data} tags={tags.data} /> : null}

      {query.isPending ? (
        view === 'posters' ? <PosterSkeletons /> : <Loading />
      ) : query.isError ? (
        <QueryError error={query.error} onRetry={() => void query.refetch()} title={t('library.couldNotLoadTheLibrary')} />
      ) : allRows.length === 0 ? (
        <EmptyState
          size="lg"
          title={kind === 'series' ? t('library.noSeriesYet') : t('library.noMoviesYet')}
          action={
            <>
              <Link to="/library/add" className={buttonClass({ variant: 'primary' })}>
                {addLabel}
              </Link>
              <Link to="/activity/manual-import" className={buttonClass({ variant: 'secondary' })}>
                {t('library.importFolder')}
              </Link>
            </>
          }
        >
          {t('library.addOneOrImportA')}
        </EmptyState>
      ) : rows.length === 0 ? (
        <EmptyState title={t('library.nothingMatchesTheseFilters')} action={<Button onClick={() => setFilters(DEFAULT_FILTERS)}>{t('library.clearFilters')}</Button>} />
      ) : view === 'table' ? (
        <LibraryTable
          rows={rows}
          sort={sort}
          onSort={setSort}
          selectable={selectMode}
          selected={selected}
          onSelectionChange={setSelected}
          onMonitor={toggleMonitored}
          profileName={profileName}
          tags={tags.data}
        />
      ) : view === 'overview' ? (
        <div className="mk-overview">
          {rows.map((row) => (
            <OverviewRow
              key={row.id}
              row={row}
              selectMode={selectMode}
              selected={selected.has(row.id)}
              onSelect={() => toggleSelected(row.id)}
              onMonitor={(m) => toggleMonitored(row, m)}
              profileName={profileName}
            />
          ))}
        </div>
      ) : view === 'collections' ? (
        <CollectionsView
          rows={rows}
          selectMode={selectMode}
          selected={selected}
          onSelect={toggleSelected}
          onMonitor={toggleMonitored}
        />
      ) : (
        <div className="mk-poster-grid" data-testid="library-grid">
          {rows.map((row) => (
            <LibraryPoster
              key={row.id}
              row={row}
              selectMode={selectMode}
              selected={selected.has(row.id)}
              onSelect={() => toggleSelected(row.id)}
              onMonitor={(m) => toggleMonitored(row, m)}
            />
          ))}
        </div>
      )}

      {selected.size > 0 ? (
        <BulkBar
          kind={kind}
          ids={[...selected]}
          profiles={profiles.data}
          rootFolders={rootFolders.data?.filter((r) => r.mediaType === kind)}
          tags={tags.data}
          onClear={clearSelection}
        />
      ) : null}
    </div>
  );
}

export function detailLink(row: Pick<LibraryRow, 'kind' | 'id'>) {
  return row.kind === 'series'
    ? ({ to: '/library/series/$id', params: { id: String(row.id) } } as const)
    : ({ to: '/library/movie/$id', params: { id: String(row.id) } } as const);
}

function countText(row: LibraryRow): string {
  return row.kind === 'series' ? `${row.have}/${row.total}` : row.have ? '1/1' : '0/1';
}

function LibraryPoster({
  row,
  selectMode,
  selected,
  onSelect,
  onMonitor,
}: {
  row: LibraryRow;
  selectMode: boolean;
  selected: boolean;
  onSelect: () => void;
  onMonitor: (monitored: boolean) => void;
}) {
  const progress = row.total > 0 ? (row.have / row.total) * 100 : 0;
  const card = (
    <PosterCard
      src={row.posterUrl}
      title={row.title}
      selected={selected}
      progress={progress}
      progressTone={progressTone(row)}
      count={countText(row)}
      countTone={progressTone(row) === 'warn' ? 'warn' : 'default'}
      meta={rowMeta(row)}
      onClick={selectMode ? onSelect : undefined}
      overlay={
        selectMode ? (
          <Checkbox aria-label={t('library.selectTitle', { title: row.title })} checked={selected} onChange={onSelect} onClick={(e) => e.stopPropagation()} />
        ) : undefined
      }
    />
  );
  return (
    <div className="mk-poster-wrap" data-unmonitored={!row.monitored || undefined}>
      {selectMode ? null : (
        <span className="mk-poster-monitor">
          <MonitorSwitch monitored={row.monitored} onChange={onMonitor} label={t('common.monitorTitle', { monitored: row.monitored, title: row.title })} />
        </span>
      )}
      {selectMode ? (
        card
      ) : (
        <Link {...detailLink(row)} className="lib-poster-link" aria-label={row.title}>
          {card}
        </Link>
      )}
    </div>
  );
}

function OverviewRow({
  row,
  selectMode,
  selected,
  onSelect,
  onMonitor,
  profileName,
}: {
  row: LibraryRow;
  selectMode: boolean;
  selected: boolean;
  onSelect: () => void;
  onMonitor: (m: boolean) => void;
  profileName: (id: number) => string;
}) {
  const progress = row.total > 0 ? (row.have / row.total) * 100 : 0;
  return (
    <article className="mk-overview-row" aria-label={row.title} aria-selected={selectMode ? selected : undefined}>
      <Poster src={row.posterUrl} title={row.title} progress={progress} progressTone={progressTone(row)} />
      <div className="mk-overview-row__body">
        <div className="mk-row" style={{ flexWrap: 'nowrap' }}>
          {selectMode ? <Checkbox aria-label={t('library.selectTitle', { title: row.title })} checked={selected} onChange={onSelect} /> : null}
          <Link {...detailLink(row)} className="mk-overview-row__title mk-link">
            {row.title}
          </Link>
        </div>
        <p className="mk-overview-row__text">{row.overview || t('common.noOverviewAvailable')}</p>
        <div className="mk-row" style={{ gap: 8 }}>
          <StatusChip status={row.monitored ? 'monitored' : 'unmonitored'} />
          <span className="al-quality">{profileName(row.qualityProfileId)}</span>
          <span className="mk-muted" style={{ fontSize: 13 }}>
            {rowMeta(row)}
            {STATUS_LABELS[row.status] ? ` · ${STATUS_LABELS[row.status]}` : ''}
          </span>
        </div>
      </div>
      <div className="mk-overview-row__aside">
        <MonitorSwitch monitored={row.monitored} onChange={onMonitor} label={t('common.monitorTitle', { monitored: row.monitored, title: row.title })} />
        <Num className="mk-muted">{countText(row)}</Num>
        <Num className="mk-muted">{formatBytes(row.sizeOnDisk)}</Num>
      </div>
    </article>
  );
}

function CollectionsView({
  rows,
  selectMode,
  selected,
  onSelect,
  onMonitor,
}: {
  rows: LibraryRow[];
  selectMode: boolean;
  selected: ReadonlySet<number>;
  onSelect: (id: number) => void;
  onMonitor: (row: LibraryRow, m: boolean) => void;
}) {
  const groups = useMemo(() => groupCollections(rows), [rows]);
  if (groups.length === 0) {
    return <EmptyState title={t('library.noCollectionsYet')}>{t('library.moviesThatBelongToA')}</EmptyState>;
  }
  return (
    <div className="mk-stack" data-testid="collections">
      {groups.map((g) => (
        <section key={g.tmdbId} className="mk-stack-sm" aria-label={g.title}>
          <SectionHead
            label={<h2 className="al-title-m mk-section-title">{g.title}</h2>}
            action={
              <div className="lib-collection-meter">
                <Meter
                  value={(g.owned / g.movies.length) * 100}
                  label={`${g.title}: ${g.owned} of ${g.movies.length} on disk`}
                  valueText={`${g.owned}/${g.movies.length}`}
                />
              </div>
            }
          />
          <div className="mk-poster-grid">
            {g.movies.map((row) => (
              <LibraryPoster
                key={row.id}
                row={row}
                selectMode={selectMode}
                selected={selected.has(row.id)}
                onSelect={() => onSelect(row.id)}
                onMonitor={(m) => onMonitor(row, m)}
              />
            ))}
          </div>
        </section>
      ))}
    </div>
  );
}

function LibraryTable({
  rows,
  sort,
  onSort,
  selectable,
  selected,
  onSelectionChange,
  onMonitor,
  profileName,
  tags,
}: {
  rows: LibraryRow[];
  sort: LibrarySort;
  onSort: (s: LibrarySort) => void;
  selectable: boolean;
  selected: ReadonlySet<number>;
  onSelectionChange: (s: Set<number>) => void;
  onMonitor: (row: LibraryRow, monitored: boolean) => void;
  profileName: (id: number) => string;
  tags: Tag[] | undefined;
}) {
  const isMovie = rows[0]?.kind === 'movie';
  const columns: Column<LibraryRow>[] = [
    {
      key: 'monitored',
      header: <span className="al-sr-only">{t('status.monitored')}</span>,
      cell: (r) => <MonitorSwitch monitored={r.monitored} onChange={(m) => onMonitor(r, m)} label={t('common.monitorTitle', { monitored: r.monitored, title: r.title })} />,
      width: '56px',
    },
    {
      key: 'title',
      header: t('common.title'),
      sortValue: (r) => r.sortTitle,
      cell: (r) => (
        <span className="mk-row" style={{ gap: 8 }}>
          <Link {...detailLink(r)} className="mk-link">
            {r.title}
          </Link>
          <TagChips ids={r.tags} tags={tags} />
        </span>
      ),
    },
    { key: 'year', header: t('common.year'), sortValue: (r) => r.year, cell: (r) => r.year || '—', mono: true, width: '72px' },
    { key: 'status', header: t('common.status'), cell: (r) => STATUS_LABELS[r.status] ?? r.status, muted: true },
    { key: 'profile', header: t('common.profile'), cell: (r) => profileName(r.qualityProfileId), mono: true },
    { key: 'subtitle', header: isMovie ? t('common.studio') : t('common.network'), cell: (r) => r.subtitle ?? '—', muted: true },
    {
      key: 'progress',
      header: isMovie ? t('common.file') : t('common.episodes'),
      sortValue: (r) => r.have,
      cell: (r) => (
        <Meter
          value={r.total > 0 ? (r.have / r.total) * 100 : 0}
          tone={progressTone(r) === 'warn' ? 'warn' : 'default'}
          label={t('library.titleProgress', { title: r.title })}
          valueText={countText(r)}
        />
      ),
      width: '180px',
    },
    { key: 'size', header: t('common.size'), sortValue: (r) => r.sizeOnDisk, cell: (r) => formatBytes(r.sizeOnDisk), align: 'right', mono: true },
    { key: 'added', header: t('common.added'), sortValue: (r) => r.added, cell: (r) => formatDate(r.added), mono: true },
  ];
  const tableSort: SortState = { key: sort.key, direction: sort.direction };
  return (
    <Table
      columns={columns}
      rows={rows}
      rowKey={(r) => r.id}
      density="dense"
      sort={tableSort}
      manualSort
      onSortChange={(s) => onSort({ key: s.key as LibrarySortKey, direction: s.direction })}
      selectable={selectable}
      selected={selected}
      onSelectionChange={(keys) => onSelectionChange(new Set([...keys].map(Number)))}
      rowLabel={(r) => t('library.selectTitle', { title: r.title })}
      caption={t('common.library')}
    />
  );
}

function LibraryFilterBar({
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
    <FilterBar onClear={() => onChange(DEFAULT_FILTERS)} activeCount={activeFilterCount(filters) + (filters.search ? 1 : 0)} className="lib-filters">
      <Input
        type="search"
        className="mk-search"
        aria-label={t('library.filterLibrary')}
        placeholder={t('library.filterByTitle')}
        value={filters.search}
        onChange={(e) => onChange({ ...filters, search: e.target.value })}
      />
      <Select
        aria-label={t('library.monitoredFilter')}
        value={filters.monitored}
        onChange={(e) => onChange({ ...filters, monitored: e.target.value as MonitoredFilter })}
        options={[
          { value: 'all', label: t('library.monitoredAndUnmonitored') },
          { value: 'monitored', label: t('status.monitored') },
          { value: 'unmonitored', label: t('status.unmonitored') },
        ]}
      />
      <Select
        aria-label={t('library.qualityProfileFilter')}
        value={filters.qualityProfileId?.toString() ?? ''}
        onChange={(e) => onChange({ ...filters, qualityProfileId: num(e.target.value) })}
        options={[{ value: '', label: t('library.anyProfile') }, ...(profiles ?? []).map((p) => ({ value: String(p.id), label: p.name }))]}
      />
      <Select
        aria-label={t('library.tagFilter')}
        value={filters.tagId?.toString() ?? ''}
        onChange={(e) => onChange({ ...filters, tagId: num(e.target.value) })}
        options={[{ value: '', label: t('library.anyTag') }, ...(tags ?? []).map((item) => ({ value: String(item.id), label: item.label }))]}
      />
      <Select
        aria-label={t('library.statusFilter')}
        value={filters.status ?? ''}
        onChange={(e) => onChange({ ...filters, status: e.target.value || null })}
        options={[{ value: '', label: t('library.anyStatus') }, ...statuses.map((s) => ({ value: s, label: STATUS_LABELS[s] ?? s }))]}
      />
      <Checkbox label={t('library.missingFiles')} checked={filters.missing} onChange={(e) => onChange({ ...filters, missing: e.target.checked })} />
    </FilterBar>
  );
}

function BulkBar({
  kind,
  ids,
  profiles,
  rootFolders,
  tags,
  onClear,
}: {
  kind: LibraryKind;
  ids: number[];
  profiles: QualityProfile[] | undefined;
  rootFolders: RootFolder[] | undefined;
  tags: Tag[] | undefined;
  onClear: () => void;
}) {
  const bulkSeries = useBulkUpdateSeries();
  const bulkMovies = useBulkUpdateMovies();
  const deleteSeries = useDeleteSeries();
  const deleteMovies = useDeleteMovies();
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [addingLanguage, setAddingLanguage] = useState(false);
  const pending = bulkSeries.isPending || bulkMovies.isPending;
  const languageTargets = useMemo(() => ids.map((id) => (kind === 'series' ? { seriesId: id } : { movieId: id })), [ids, kind]);

  const apply = (patch: { monitored?: boolean; qualityProfileId?: number; rootFolderPath?: string; tags?: { add?: number[]; remove?: number[] } }) => {
    if (kind === 'series') bulkSeries.mutate({ ids, ...patch });
    else bulkMovies.mutate({ ids, ...patch });
  };

  const menuTrigger = (label: string) => (props: Parameters<Parameters<typeof Popover>[0]['trigger']>[0]) => (
    <Button variant="ghost" disabled={pending} {...props}>
      {label}
    </Button>
  );

  return (
    <FloatBar count={ids.length}>
      <Button variant="ghost" disabled={pending} onClick={() => apply({ monitored: true })}>
        {t('common.monitor')}
      </Button>
      <Button variant="ghost" disabled={pending} onClick={() => apply({ monitored: false })}>
        {t('common.unmonitor')}
      </Button>
      <Popover trigger={menuTrigger(t('common.profile'))} placement="top-start" width={240} label={t('library.setQualityProfile')}>
        {(close) => (
          <Menu
            header={t('library.setQualityProfile')}
            onDone={close}
            items={(profiles ?? []).map((p) => ({ id: String(p.id), label: p.name, onSelect: () => apply({ qualityProfileId: p.id }) }))}
          />
        )}
      </Popover>
      <Popover trigger={menuTrigger(t('common.rootFolder'))} placement="top-start" width={280} label={t('library.moveToRootFolder')}>
        {(close) => (
          <Menu
            header={t('library.moveToRootFolder')}
            onDone={close}
            items={(rootFolders ?? []).map((r) => ({ id: r.path, label: <span className="al-num">{r.path}</span>, onSelect: () => apply({ rootFolderPath: r.path }) }))}
          />
        )}
      </Popover>
      <Popover trigger={menuTrigger(t('common.tags'))} placement="top-start" width={240} label={t('library.changeTags')}>
        {(close) => (
          <Menu
            header={t('library.addOrRemoveATag')}
            onDone={close}
            items={(tags ?? []).flatMap((entry) => [
              { id: `add-${entry.id}`, label: t('library.addLabel', { label: entry.label }), onSelect: () => apply({ tags: { add: [entry.id] } }) },
              { id: `remove-${entry.id}`, label: t('library.removeLabel', { label: entry.label }), onSelect: () => apply({ tags: { remove: [entry.id] } }) },
            ])}
          />
        )}
      </Popover>
      <Button variant="ghost" disabled={pending} onClick={() => setAddingLanguage(true)}>
        {t('features.additionalLanguages.addAdditional')}
      </Button>
      <FloatBarDivider />
      <Button variant="danger" onClick={() => setConfirmDelete(true)}>
        {t('common.delete')}
      </Button>
      <Button variant="ghost" className="al-floatbar__cancel" onClick={onClear}>
        {t('common.cancel')}
      </Button>
      <AddAdditionalDialog
        open={addingLanguage}
        onClose={() => setAddingLanguage(false)}
        targets={languageTargets}
        title={`${ids.length} ${noun(kind, ids.length)}`}
      />
      <DeleteMediaDialog
        open={confirmDelete}
        onClose={() => setConfirmDelete(false)}
        subject={`${ids.length} ${noun(kind, ids.length)}`}
        noun={noun(kind, ids.length)}
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
    </FloatBar>
  );
}
