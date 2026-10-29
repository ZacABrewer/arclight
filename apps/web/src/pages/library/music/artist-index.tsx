import { useMemo, useState, type CSSProperties } from 'react';
import { Link } from '@tanstack/react-router';
import type { Artist, ArtistStatus, QualityProfile } from '@arclight/shared';
import { ArtistStatus as ArtistStatuses } from '@arclight/shared';
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
  Segmented,
  Select,
  Table,
  buttonClass,
  type Column,
} from '../../../arclight/index.js';
import { formatBytes, formatDate } from '../../../components/media/format.js';
import { Loading, MonitorSwitch, Num, PosterSkeletons, QueryError } from '../../../components/media/media-kit.js';
import { useUiPreferences } from '../../../hooks/ui-preferences.js';
import { useArtistList, useBulkUpdateArtists, useMusicQualityProfiles, useSetArtistMonitored } from '../../../hooks/music.js';
import { clampColumns } from '../library-index.js';
import { MusicGate, SquareArt } from './music-kit.js';
import {
  ARTIST_SORT_KEYS,
  DEFAULT_ARTIST_FILTERS,
  activeArtistFilterCount,
  artistImage,
  artistSortLabel,
  artistStatusLabel,
  filterArtists,
  progressText,
  sortArtists,
  trackProgress,
  type ArtistFilters,
  type ArtistMonitoredFilter,
  type ArtistSort,
  type ArtistSortKey,
} from './music-model.js';
import '../library.css';
import './music.css';
import { t } from '../../../i18n/index.js';

type ArtistView = 'posters' | 'table';

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
      // Storage unavailable: keep the in-memory value only.
    }
  };
  return [value, set];
}

const artistLink = (a: Pick<Artist, 'id'>) => ({ to: '/library/music/artist/$id' as const, params: { id: String(a.id) } });

export function ArtistIndexPage() {
  return (
    <MusicGate>
      <ArtistIndex />
    </MusicGate>
  );
}

function ArtistIndex() {
  const artists = useArtistList();
  const profiles = useMusicQualityProfiles();
  const prefs = useUiPreferences();
  const [view, setView] = usePersistent<ArtistView>('library.music.view', 'posters');
  const [sort, setSort] = usePersistent<ArtistSort>('library.music.sort', { key: 'name', direction: 'asc' });
  const [showFilters, setShowFilters] = usePersistent<boolean>('library.filters', true);
  const [filters, setFilters] = useState<ArtistFilters>(DEFAULT_ARTIST_FILTERS);
  const [selectMode, setSelectMode] = useState(false);
  const [selected, setSelected] = useState<ReadonlySet<number>>(new Set());
  const setMonitored = useSetArtistMonitored();

  const all = artists.data ?? [];
  const rows = useMemo(() => sortArtists(filterArtists(artists.data ?? [], filters), sort), [artists.data, filters, sort]);
  const totalSize = useMemo(() => (artists.data ?? []).reduce((n, a) => n + (a.statistics?.sizeOnDisk ?? 0), 0), [artists.data]);
  const profileName = (id: number) => profiles.data?.find((p) => p.id === id)?.name ?? `#${id}`;
  const filterCount = activeArtistFilterCount(filters);
  const toggle = (id: number) =>
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  const clear = () => {
    setSelected(new Set());
    setSelectMode(false);
  };
  const monitor = (a: Artist, monitored: boolean) => setMonitored.mutate({ id: a.id, monitored });

  return (
    <div className="lib-page" style={{ '--mk-cols': clampColumns(prefs.posterColumns) } as CSSProperties}>
      <PageHeader
        index="01"
        title={t('common.music')}
        actions={
          <>
            <Button variant={selectMode ? 'secondary' : 'ghost'} aria-pressed={selectMode} onClick={() => (selectMode ? clear() : setSelectMode(true))}>
              {selectMode ? t('library.done') : t('common.select')}
            </Button>
            <Link to="/library/music/import" className={buttonClass({ variant: 'secondary' })}>
              {t('libraryImport.importExisting')}
            </Link>
            <Link to="/library/add" search={{ type: 'music' }} className={buttonClass({ variant: 'primary' })}>
              {t('music.addArtist')}
            </Link>
          </>
        }
      >
        {artists.data ? (
          <span className="mk-count">
            {rows.length !== all.length ? (
              <>
                <Num>{rows.length}</Num> {t('common.of')} <Num>{all.length}</Num> {t('music.artistNoun', { count: all.length })}
              </>
            ) : (
              <>
                <Num>{all.length}</Num> {t('music.artistNoun', { count: all.length })}
              </>
            )}{' '}
            · <Num>{formatBytes(totalSize)}</Num>
          </span>
        ) : null}
        <Segmented
          aria-label={t('library.view')}
          variant="soft"
          value={view}
          onChange={setView}
          options={[
            { value: 'posters' as const, label: t('library.posters') },
            { value: 'table' as const, label: t('library.table') },
          ]}
        />
        <Select
          aria-label={t('library.sortBy')}
          value={sort.key}
          onChange={(e) => setSort({ ...sort, key: e.target.value as ArtistSortKey })}
          options={ARTIST_SORT_KEYS.map((key) => ({ value: key, label: t('library.sortLabel', { label: artistSortLabel(key) }) }))}
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
      </PageHeader>

      {showFilters ? <ArtistFilterBar filters={filters} onChange={setFilters} profiles={profiles.data} /> : null}

      {artists.isPending ? (
        view === 'posters' ? <PosterSkeletons /> : <Loading />
      ) : artists.isError ? (
        <QueryError error={artists.error} onRetry={() => void artists.refetch()} title={t('music.couldNotLoadArtists')} />
      ) : all.length === 0 ? (
        <EmptyState
          size="lg"
          title={t('music.noArtistsYet')}
          action={
            <>
              <Link to="/library/add" search={{ type: 'music' }} className={buttonClass({ variant: 'primary' })}>
                {t('music.addArtist')}
              </Link>
              <Link to="/library/music/import" className={buttonClass({ variant: 'secondary' })}>
                {t('libraryImport.importExisting')}
              </Link>
            </>
          }
        >
          {t('music.addAnArtistFromMusicBrainz')}
        </EmptyState>
      ) : rows.length === 0 ? (
        <EmptyState title={t('library.nothingMatchesTheseFilters')} action={<Button onClick={() => setFilters(DEFAULT_ARTIST_FILTERS)}>{t('library.clearFilters')}</Button>} />
      ) : view === 'table' ? (
        <ArtistTable rows={rows} selectable={selectMode} selected={selected} onSelectionChange={setSelected} onMonitor={monitor} profileName={profileName} />
      ) : (
        <div className="mk-poster-grid" data-testid="artist-grid">
          {rows.map((a) => (
            <ArtistCard key={a.id} artist={a} selectMode={selectMode} selected={selected.has(a.id)} onSelect={() => toggle(a.id)} onMonitor={(m) => monitor(a, m)} />
          ))}
        </div>
      )}

      {selected.size > 0 ? <ArtistBulkBar ids={[...selected]} profiles={profiles.data} onClear={clear} /> : null}
    </div>
  );
}

function ArtistCard({
  artist: a,
  selectMode,
  selected,
  onSelect,
  onMonitor,
}: {
  artist: Artist;
  selectMode: boolean;
  selected: boolean;
  onSelect: () => void;
  onMonitor: (m: boolean) => void;
}) {
  const p = trackProgress(a.statistics);
  const albums = a.statistics?.albumCount ?? 0;
  const inner = (
    <>
      <SquareArt src={artistImage(a)} title={a.name} progress={p.percent} progressTone={!a.monitored ? 'muted' : p.have < p.total ? 'warn' : 'default'}>
        {selectMode ? (
          <div className="al-poster__check">
            <Checkbox aria-label={t('library.selectTitle', { title: a.name })} checked={selected} onChange={onSelect} onClick={(e) => e.stopPropagation()} />
          </div>
        ) : null}
      </SquareArt>
      <div className="al-poster-card__title-row">
        <span className="al-poster-card__title">{a.name}</span>
        <span className="al-num" style={{ fontSize: 11, color: p.have < p.total ? 'var(--al-warn-text)' : 'var(--al-text-4)' }}>
          {progressText(p)}
        </span>
      </div>
      <div className="al-poster-card__meta">
        {t('music.albumCount', { count: albums })}
        {a.statistics?.sizeOnDisk ? ` · ${formatBytes(a.statistics.sizeOnDisk)}` : ''}
      </div>
    </>
  );
  return (
    <div className="mk-poster-wrap" data-unmonitored={!a.monitored || undefined}>
      {selectMode ? null : (
        <span className="mk-poster-monitor">
          <MonitorSwitch monitored={a.monitored} onChange={onMonitor} label={t('common.monitorTitle', { monitored: a.monitored, title: a.name })} />
        </span>
      )}
      {selectMode ? (
        <div className="music-card" onClick={onSelect} style={{ cursor: 'pointer' }}>
          {inner}
        </div>
      ) : (
        <Link {...artistLink(a)} className="music-card" aria-label={a.name}>
          {inner}
        </Link>
      )}
    </div>
  );
}

function ArtistTable({
  rows,
  selectable,
  selected,
  onSelectionChange,
  onMonitor,
  profileName,
}: {
  rows: Artist[];
  selectable: boolean;
  selected: ReadonlySet<number>;
  onSelectionChange: (s: Set<number>) => void;
  onMonitor: (a: Artist, m: boolean) => void;
  profileName: (id: number) => string;
}) {
  const columns: Column<Artist>[] = [
    {
      key: 'monitored',
      header: <span className="al-sr-only">{t('status.monitored')}</span>,
      cell: (a) => <MonitorSwitch monitored={a.monitored} onChange={(m) => onMonitor(a, m)} label={t('common.monitorTitle', { monitored: a.monitored, title: a.name })} />,
      width: '56px',
    },
    {
      key: 'name',
      header: t('music.artist'),
      sortValue: (a) => a.sortName,
      cell: (a) => (
        <Link {...artistLink(a)} className="mk-link">
          {a.name}
        </Link>
      ),
    },
    { key: 'status', header: t('common.status'), cell: (a) => artistStatusLabel(a.status), muted: true },
    { key: 'profile', header: t('common.profile'), cell: (a) => profileName(a.qualityProfileId), mono: true },
    { key: 'albums', header: t('music.albums'), sortValue: (a) => a.statistics?.albumCount ?? 0, cell: (a) => a.statistics?.albumCount ?? 0, mono: true, align: 'right' },
    {
      key: 'tracks',
      header: t('music.tracks'),
      sortValue: (a) => trackProgress(a.statistics).percent,
      cell: (a) => {
        const p = trackProgress(a.statistics);
        return <Meter value={p.percent} tone={p.have < p.total ? 'warn' : 'default'} label={t('library.titleProgress', { title: a.name })} valueText={progressText(p)} />;
      },
      width: '180px',
    },
    { key: 'size', header: t('common.size'), sortValue: (a) => a.statistics?.sizeOnDisk ?? 0, cell: (a) => formatBytes(a.statistics?.sizeOnDisk), align: 'right', mono: true },
    { key: 'added', header: t('common.added'), sortValue: (a) => a.added, cell: (a) => formatDate(a.added), mono: true },
  ];
  return (
    <Table
      columns={columns}
      rows={rows}
      rowKey={(a) => a.id}
      density="dense"
      sortable={false}
      selectable={selectable}
      selected={selected}
      onSelectionChange={(keys) => onSelectionChange(new Set([...keys].map(Number)))}
      rowLabel={(a) => t('library.selectTitle', { title: a.name })}
      caption={t('common.music')}
    />
  );
}

function ArtistFilterBar({ filters, onChange, profiles }: { filters: ArtistFilters; onChange: (f: ArtistFilters) => void; profiles: QualityProfile[] | undefined }) {
  return (
    <FilterBar onClear={() => onChange(DEFAULT_ARTIST_FILTERS)} activeCount={activeArtistFilterCount(filters)} className="lib-filters">
      <Input
        type="search"
        className="mk-search"
        aria-label={t('music.filterArtists')}
        placeholder={t('music.filterByName')}
        value={filters.search}
        onChange={(e) => onChange({ ...filters, search: e.target.value })}
      />
      <Select
        aria-label={t('library.monitoredFilter')}
        value={filters.monitored}
        onChange={(e) => onChange({ ...filters, monitored: e.target.value as ArtistMonitoredFilter })}
        options={[
          { value: 'all', label: t('library.monitoredAndUnmonitored') },
          { value: 'monitored', label: t('status.monitored') },
          { value: 'unmonitored', label: t('status.unmonitored') },
        ]}
      />
      <Select
        aria-label={t('library.qualityProfileFilter')}
        value={filters.qualityProfileId?.toString() ?? ''}
        onChange={(e) => onChange({ ...filters, qualityProfileId: e.target.value ? Number(e.target.value) : null })}
        options={[{ value: '', label: t('library.anyProfile') }, ...(profiles ?? []).map((p) => ({ value: String(p.id), label: p.name }))]}
      />
      <Select
        aria-label={t('library.statusFilter')}
        value={filters.status ?? ''}
        onChange={(e) => onChange({ ...filters, status: (e.target.value || null) as ArtistStatus | null })}
        options={[{ value: '', label: t('library.anyStatus') }, ...ArtistStatuses.options.map((s) => ({ value: s, label: artistStatusLabel(s) }))]}
      />
      <Checkbox label={t('music.missingTracks')} checked={filters.missing} onChange={(e) => onChange({ ...filters, missing: e.target.checked })} />
    </FilterBar>
  );
}

function ArtistBulkBar({ ids, profiles, onClear }: { ids: number[]; profiles: QualityProfile[] | undefined; onClear: () => void }) {
  const bulk = useBulkUpdateArtists();
  const apply = (patch: { monitored?: boolean; qualityProfileId?: number; refresh?: boolean }) => bulk.mutate({ ids, ...patch });
  return (
    <FloatBar count={ids.length}>
      <Button variant="ghost" disabled={bulk.isPending} onClick={() => apply({ monitored: true })}>
        {t('common.monitor')}
      </Button>
      <Button variant="ghost" disabled={bulk.isPending} onClick={() => apply({ monitored: false })}>
        {t('common.unmonitor')}
      </Button>
      <Popover
        trigger={(props) => (
          <Button variant="ghost" disabled={bulk.isPending} {...props}>
            {t('common.profile')}
          </Button>
        )}
        placement="top-start"
        width={240}
        label={t('library.setQualityProfile')}
      >
        {(close) => (
          <Menu
            header={t('library.setQualityProfile')}
            onDone={close}
            items={(profiles ?? []).map((p) => ({ id: String(p.id), label: p.name, onSelect: () => apply({ qualityProfileId: p.id }) }))}
          />
        )}
      </Popover>
      <Button variant="ghost" disabled={bulk.isPending} onClick={() => apply({ refresh: true })}>
        {t('common.refresh')}
      </Button>
      <FloatBarDivider />
      <Button variant="ghost" className="al-floatbar__cancel" onClick={onClear}>
        {t('common.cancel')}
      </Button>
    </FloatBar>
  );
}
