import { useMemo, useState, type CSSProperties, type ReactNode } from 'react';
import { Link } from '@tanstack/react-router';
import type { BooksFormatProfile, BooksKind, BooksWantedItem, ComicSeries, EbookAuthor } from '@arclight/shared';
import { formatsOfKind } from '@arclight/shared';
import {
  Button,
  Checkbox,
  CountBadge,
  EmptyState,
  FilterBar,
  Input,
  Meter,
  PageHeader,
  SectionLabel,
  Segmented,
  Select,
  Table,
  buttonClass,
  type Column,
} from '../../../arclight/index.js';
import { BulkBar, type BulkAction } from '../../../components/media/bulk-bar.js';
import { formatBytes, formatDate } from '../../../components/media/format.js';
import { Loading, MonitorSwitch, Num, PosterSkeletons, QueryError } from '../../../components/media/media-kit.js';
import { useToast } from '../../../components/toast.js';
import {
  useBooksCommand,
  useBooksFormatProfiles,
  useBooksWanted,
  useComicSeriesList,
  useDeleteComicSeries,
  useDeleteEbookAuthor,
  useEbookAuthors,
  useUpdateComicSeries,
  useUpdateEbookAuthor,
} from '../../../hooks/books.js';
import { useUiPreferences } from '../../../hooks/ui-preferences.js';
import { clampColumns } from '../library-index.js';
import { BooksDeleteDialog, BooksGate, BooksSearchButton, CoverArt, comicSeriesLink, ebookAuthorLink, seriesTypeLabel, usePersistent } from './books-kit.js';
import {
  DEFAULT_SHELF_FILTERS,
  SHELF_SORT_KEYS,
  activeShelfFilterCount,
  filterAuthors,
  filterComics,
  formatLabel,
  recentlyAdded,
  shelfProgress,
  sortAuthors,
  sortComics,
  type ShelfFilters,
  type ShelfMonitoredFilter,
  type ShelfSort,
  type ShelfSortKey,
} from './books-model.js';
import '../library.css';
import { t } from '../../../i18n/index.js';

type ShelfView = 'posters' | 'table';

/** How many cards the "Recently added" and "Wanted" rows show. */
const ROW_SIZE = 3;

export function BooksShelfPage() {
  return (
    <BooksGate>
      <BooksShelf />
    </BooksGate>
  );
}

function sortLabel(key: ShelfSortKey, kind: BooksKind): string {
  switch (key) {
    case 'name':
      return kind === 'ebook' ? t('books.sort.author') : t('common.title');
    case 'added':
      return t('common.added');
    case 'count':
      return kind === 'ebook' ? t('books.sort.books') : t('books.sort.issues');
    case 'progress':
      return t('common.available');
    case 'size':
      return t('common.size');
  }
}

function BooksShelf() {
  const prefs = useUiPreferences();
  const [kind, setKind] = usePersistent<BooksKind>('library.books.kind', 'ebook');
  const [view, setView] = usePersistent<ShelfView>('library.books.view', 'posters');
  const [sort, setSort] = usePersistent<ShelfSort>('library.books.sort', { key: 'name', direction: 'asc' });
  const [showFilters, setShowFilters] = usePersistent<boolean>('library.filters', true);
  const [filters, setFilters] = useState<ShelfFilters>(DEFAULT_SHELF_FILTERS);
  const [selectMode, setSelectMode] = useState(false);
  const [selected, setSelected] = useState<ReadonlySet<number>>(new Set());
  const authors = useEbookAuthors(kind === 'ebook');
  const comics = useComicSeriesList(kind === 'comic');
  const profiles = useBooksFormatProfiles();
  const wanted = useBooksWanted({ kind, reason: 'missing', page: 1, pageSize: ROW_SIZE });

  const clear = () => {
    setSelected(new Set());
    setSelectMode(false);
  };
  const switchKind = (next: BooksKind) => {
    clear();
    setFilters({ ...filters, format: null });
    setKind(next);
  };
  const query = kind === 'ebook' ? authors : comics;
  const total = query.data?.length ?? 0;
  const authorRows = useMemo(() => sortAuthors(filterAuthors(authors.data ?? [], filters, profiles.data), sort), [authors.data, filters, profiles.data, sort]);
  const comicRows = useMemo(() => sortComics(filterComics(comics.data ?? [], filters, profiles.data), sort), [comics.data, filters, profiles.data, sort]);
  const shown = kind === 'ebook' ? authorRows.length : comicRows.length;
  const size = useMemo(() => (query.data ?? []).reduce((n, x) => n + x.statistics.sizeOnDisk, 0), [query.data]);
  const filterCount = activeShelfFilterCount(filters);
  const toggle = (id: number) =>
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  const rescan = useBooksCommand();
  const addLink = (
    <Link to="/library/books/add" className={buttonClass({ variant: 'primary' })}>
      {kind === 'ebook' ? t('books.addAuthorOrBook') : t('books.addComic')}
    </Link>
  );
  const noun = kind === 'ebook' ? t('books.authorNoun', { count: total }) : t('books.comicSeriesNoun', { count: total });

  return (
    <div className="lib-page bk-shelf" style={{ '--mk-cols': clampColumns(prefs.posterColumns) } as CSSProperties}>
      <PageHeader
        index="01"
        title={t('books.title')}
        actions={
          <>
            <Button variant={selectMode ? 'secondary' : 'ghost'} aria-pressed={selectMode} onClick={() => (selectMode ? clear() : setSelectMode(true))}>
              {selectMode ? t('library.done') : t('common.select')}
            </Button>
            <Button variant="ghost" loading={rescan.isPending} onClick={() => rescan.mutate({ name: 'RescanBooks' })}>
              {t('books.rescan')}
            </Button>
            <Link to="/library/books/wanted" className={buttonClass({ variant: 'secondary' })}>
              {t('books.wanted.title')}
            </Link>
            <Link to="/settings/books" className={buttonClass({ variant: 'ghost' })}>
              {t('common.settings')}
            </Link>
            {addLink}
          </>
        }
      >
        <Segmented
          aria-label={t('books.kindLabel')}
          variant="solid"
          value={kind}
          onChange={switchKind}
          options={[
            { value: 'ebook' as const, label: t('books.kind.ebooks') },
            { value: 'comic' as const, label: t('books.kind.comics') },
          ]}
        />
        {query.data ? (
          <span className="mk-count">
            {shown !== total ? (
              <>
                <Num>{shown}</Num> {t('common.of')} <Num>{total}</Num> {noun}
              </>
            ) : (
              <>
                <Num>{total}</Num> {noun}
              </>
            )}{' '}
            · <Num>{formatBytes(size)}</Num>
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
          onChange={(e) => setSort({ ...sort, key: e.target.value as ShelfSortKey })}
          options={SHELF_SORT_KEYS.map((key) => ({ value: key, label: t('library.sortLabel', { label: sortLabel(key, kind) }) }))}
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

      {showFilters ? <ShelfFilterBar kind={kind} filters={filters} onChange={setFilters} shown={shown} /> : null}

      {query.isPending ? (
        view === 'posters' ? <PosterSkeletons /> : <Loading />
      ) : query.isError ? (
        <QueryError error={query.error} onRetry={() => void query.refetch()} title={t('books.couldNotLoad')} />
      ) : total === 0 ? (
        <EmptyState size="lg" title={kind === 'ebook' ? t('books.noAuthorsYet') : t('books.noComicsYet')} action={addLink}>
          {kind === 'ebook' ? t('books.addAnAuthorHint') : t('books.addAComicHint')}
        </EmptyState>
      ) : (
        <>
          {filterCount === 0 && !selectMode ? (
            <ShelfRows kind={kind} authors={authors.data} comics={comics.data} wanted={wanted.data?.records} wantedTotal={wanted.data?.totalRecords ?? 0} />
          ) : null}
          {shown === 0 ? (
            <EmptyState title={t('library.nothingMatchesTheseFilters')} action={<Button onClick={() => setFilters(DEFAULT_SHELF_FILTERS)}>{t('library.clearFilters')}</Button>} />
          ) : kind === 'ebook' ? (
            view === 'table' ? (
              <AuthorTable rows={authorRows} profiles={profiles.data} selectable={selectMode} selected={selected} onSelectionChange={setSelected} />
            ) : (
              <div className="mk-poster-grid" data-testid="books-grid">
                {authorRows.map((a) => (
                  <AuthorCard key={a.id} author={a} selectMode={selectMode} selected={selected.has(a.id)} onSelect={() => toggle(a.id)} />
                ))}
              </div>
            )
          ) : view === 'table' ? (
            <ComicTable rows={comicRows} profiles={profiles.data} selectable={selectMode} selected={selected} onSelectionChange={setSelected} />
          ) : (
            <div className="mk-poster-grid" data-testid="books-grid">
              {comicRows.map((s) => (
                <ComicCard key={s.id} series={s} selectMode={selectMode} selected={selected.has(s.id)} onSelect={() => toggle(s.id)} />
              ))}
            </div>
          )}
        </>
      )}

      {selectMode || selected.size > 0 ? (
        <ShelfBulkBar
          kind={kind}
          ids={[...selected]}
          total={shown}
          open={selectMode}
          onSelectAll={() => setSelected(new Set((kind === 'ebook' ? authorRows : comicRows).map((x) => x.id)))}
          onClear={clear}
        />
      ) : null}
    </div>
  );
}

// ---------------------------------------------------------------------------------------
// Filters
// ---------------------------------------------------------------------------------------

function ShelfFilterBar({ kind, filters, onChange, shown }: { kind: BooksKind; filters: ShelfFilters; onChange: (f: ShelfFilters) => void; shown: number }) {
  return (
    <div className="bk-filters">
      <FilterBar onClear={() => onChange(DEFAULT_SHELF_FILTERS)} activeCount={activeShelfFilterCount(filters)} className="lib-filters">
        <Input
          type="search"
          className="mk-search"
          aria-label={t('books.filterShelf')}
          placeholder={kind === 'ebook' ? t('books.searchAuthors') : t('books.searchComics')}
          value={filters.search}
          onChange={(e) => onChange({ ...filters, search: e.target.value })}
        />
        <Select
          aria-label={t('library.monitoredFilter')}
          value={filters.monitored}
          onChange={(e) => onChange({ ...filters, monitored: e.target.value as ShelfMonitoredFilter })}
          options={[
            { value: 'all', label: t('library.monitoredAndUnmonitored') },
            { value: 'monitored', label: t('status.monitored') },
            { value: 'unmonitored', label: t('status.unmonitored') },
          ]}
        />
        <Checkbox label={t('books.missingOnly')} checked={filters.missing} onChange={(e) => onChange({ ...filters, missing: e.target.checked })} />
      </FilterBar>
      <div className="bk-chips" role="group" aria-label={t('books.formatFilter')}>
        <button type="button" className="bk-chip" aria-pressed={filters.format === null} onClick={() => onChange({ ...filters, format: null })}>
          {t('books.allFormats')}
        </button>
        {formatsOfKind(kind).map((f) => (
          <button key={f} type="button" className="bk-chip" aria-pressed={filters.format === f} onClick={() => onChange({ ...filters, format: filters.format === f ? null : f })}>
            {formatLabel(f)}
          </button>
        ))}
        <span className="bk-chips__count al-num">{t('books.shownCount', { count: shown })}</span>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------------------
// Recently added / Wanted rows
// ---------------------------------------------------------------------------------------

function ShelfRows({
  kind,
  authors,
  comics,
  wanted,
  wantedTotal,
}: {
  kind: BooksKind;
  authors: EbookAuthor[] | undefined;
  comics: ComicSeries[] | undefined;
  wanted: BooksWantedItem[] | undefined;
  wantedTotal: number;
}) {
  const recent = kind === 'ebook' ? recentlyAdded(authors ?? [], ROW_SIZE) : recentlyAdded(comics ?? [], ROW_SIZE);
  return (
    <>
      {recent.length > 0 ? (
        <section className="bk-row" aria-labelledby="bk-row-recent">
          <div className="bk-row__head">
            <SectionLabel id="bk-row-recent">{t('books.recentlyAdded')}</SectionLabel>
          </div>
          <div className="bk-row__grid">
            {kind === 'ebook'
              ? (recent as EbookAuthor[]).map((a) => (
                  <RowCard
                    key={a.id}
                    cover={a.imageUrl}
                    title={a.name}
                    byline={t('books.bookCount', { count: a.statistics.bookCount })}
                    facts={[
                      [t('common.added'), formatDate(a.added)],
                      [t('common.available'), `${a.statistics.availableCount}/${a.statistics.monitoredCount}`],
                    ]}
                    actions={
                      <Link {...ebookAuthorLink(a)} className={buttonClass({ size: 'sm', variant: 'secondary' })}>
                        {t('common.open')}
                      </Link>
                    }
                  />
                ))
              : (recent as ComicSeries[]).map((s) => (
                  <RowCard
                    key={s.id}
                    cover={s.coverUrl}
                    title={s.startYear ? `${s.title} (${s.startYear})` : s.title}
                    byline={s.publisher ?? ''}
                    facts={[
                      [t('common.added'), formatDate(s.added)],
                      [t('common.issues'), `${s.statistics.availableCount}/${s.statistics.monitoredCount}`],
                    ]}
                    actions={
                      <Link {...comicSeriesLink(s)} className={buttonClass({ size: 'sm', variant: 'secondary' })}>
                        {t('common.open')}
                      </Link>
                    }
                  />
                ))}
          </div>
        </section>
      ) : null}
      {wanted && wanted.length > 0 ? (
        <section className="bk-row" aria-labelledby="bk-row-wanted">
          <div className="bk-row__head">
            <SectionLabel id="bk-row-wanted" count={wantedTotal}>
              {t('books.wanted.title')}
            </SectionLabel>
            <Link to="/library/books/wanted" className="mk-link bk-row__more">
              {t('books.seeAll')}
            </Link>
          </div>
          <div className="bk-row__grid">
            {wanted.map((w) => (
              <RowCard
                key={`${w.kind}-${w.id}`}
                cover={w.coverUrl}
                title={w.title}
                byline={w.parentTitle}
                facts={[
                  [t('common.released'), w.releaseDate ? formatDate(w.releaseDate) : t('common.tba')],
                  [t('books.lastSearched'), w.lastSearchedAt ? formatDate(w.lastSearchedAt) : t('common.never')],
                ]}
                actions={
                  <>
                    <BooksSearchButton kind={w.kind} id={w.id} variant="secondary" label={t('books.searchFor', { title: w.title })} />
                    <Link
                      {...(w.kind === 'ebook' ? ebookAuthorLink({ id: w.parentId }) : comicSeriesLink({ id: w.parentId }))}
                      className={buttonClass({ size: 'sm', variant: 'ghost' })}
                    >
                      {t('common.open')}
                    </Link>
                  </>
                }
              />
            ))}
          </div>
        </section>
      ) : null}
    </>
  );
}

function RowCard({ cover, title, byline, facts, actions }: { cover: string | null; title: string; byline: string; facts: Array<[string, string]>; actions: ReactNode }) {
  return (
    <article className="bk-rowcard">
      <CoverArt src={cover} title={title} className="bk-rowcard__cover" />
      <div className="bk-rowcard__body">
        <div className="bk-rowcard__title">{title}</div>
        {byline ? <div className="bk-rowcard__byline">{byline}</div> : null}
        <dl className="bk-rowcard__facts">
          {facts.map(([k, v]) => (
            <div key={k}>
              <dt>{k}</dt>
              <dd className="al-num">{v}</dd>
            </div>
          ))}
        </dl>
        <div className="bk-rowcard__actions">{actions}</div>
      </div>
    </article>
  );
}

// ---------------------------------------------------------------------------------------
// Posters
// ---------------------------------------------------------------------------------------

function ShelfCard({
  href,
  cover,
  title,
  meta,
  count,
  monitored,
  progress,
  selectMode,
  selected,
  onSelect,
  onMonitor,
}: {
  href: ReturnType<typeof ebookAuthorLink> | ReturnType<typeof comicSeriesLink>;
  cover: string | null;
  title: string;
  meta: string;
  count: { have: number; total: number; percent: number };
  monitored: boolean;
  progress: number;
  selectMode: boolean;
  selected: boolean;
  onSelect: () => void;
  onMonitor: (m: boolean) => void;
}) {
  const complete = count.have >= count.total;
  const inner = (
    <>
      <CoverArt src={cover} title={title} progress={progress} progressTone={!monitored ? 'muted' : complete ? 'default' : 'warn'}>
        {selectMode ? (
          <div className="al-poster__check">
            <Checkbox aria-label={t('library.selectTitle', { title })} checked={selected} onChange={onSelect} onClick={(e) => e.stopPropagation()} />
          </div>
        ) : complete && count.total > 0 ? (
          <span className="bk-done" aria-label={t('books.complete')}>
            ✓
          </span>
        ) : null}
      </CoverArt>
      <div className="al-poster-card__title-row">
        <span className="al-poster-card__title">{title}</span>
        <span className="al-num" style={{ fontSize: 11, color: complete ? 'var(--al-text-4)' : 'var(--al-warn-text)' }}>
          {count.have}/{count.total}
        </span>
      </div>
      {meta ? <div className="al-poster-card__meta">{meta}</div> : null}
    </>
  );
  return (
    <div className="mk-poster-wrap" data-unmonitored={!monitored || undefined}>
      {selectMode ? null : (
        <span className="mk-poster-monitor">
          <MonitorSwitch monitored={monitored} onChange={onMonitor} label={t('common.monitorTitle', { monitored, title })} />
        </span>
      )}
      {selectMode ? (
        <div className="music-card" onClick={onSelect} style={{ cursor: 'pointer' }}>
          {inner}
        </div>
      ) : (
        <Link {...href} className="music-card" aria-label={title}>
          {inner}
        </Link>
      )}
    </div>
  );
}

function AuthorCard({ author: a, selectMode, selected, onSelect }: { author: EbookAuthor; selectMode: boolean; selected: boolean; onSelect: () => void }) {
  const update = useUpdateEbookAuthor();
  const p = shelfProgress(a.statistics);
  return (
    <ShelfCard
      href={ebookAuthorLink(a)}
      cover={a.imageUrl}
      title={a.name}
      meta={[t('books.bookCount', { count: a.statistics.bookCount }), a.statistics.sizeOnDisk ? formatBytes(a.statistics.sizeOnDisk) : ''].filter(Boolean).join(' · ')}
      count={p}
      monitored={a.monitored}
      progress={p.percent}
      selectMode={selectMode}
      selected={selected}
      onSelect={onSelect}
      onMonitor={(monitored) => update.mutate({ id: a.id, body: { monitored } })}
    />
  );
}

function ComicCard({ series: s, selectMode, selected, onSelect }: { series: ComicSeries; selectMode: boolean; selected: boolean; onSelect: () => void }) {
  const update = useUpdateComicSeries();
  const p = shelfProgress(s.statistics);
  return (
    <ShelfCard
      href={comicSeriesLink(s)}
      cover={s.coverUrl}
      title={s.title}
      meta={[s.publisher, s.startYear?.toString()].filter(Boolean).join(' · ')}
      count={p}
      monitored={s.monitored}
      progress={p.percent}
      selectMode={selectMode}
      selected={selected}
      onSelect={onSelect}
      onMonitor={(monitored) => update.mutate({ id: s.id, body: { monitored } })}
    />
  );
}

// ---------------------------------------------------------------------------------------
// Tables
// ---------------------------------------------------------------------------------------

const profileName = (profiles: readonly BooksFormatProfile[] | undefined, id: number) => profiles?.find((p) => p.id === id)?.name ?? `#${id}`;

function progressColumn<T extends { statistics: { monitoredCount: number; availableCount: number } }>(label: (row: T) => string): Column<T> {
  return {
    key: 'progress',
    header: t('common.available'),
    sortValue: (r) => shelfProgress(r.statistics).percent,
    cell: (r) => {
      const p = shelfProgress(r.statistics);
      return <Meter value={p.percent} tone={p.have < p.total ? 'warn' : 'default'} label={t('library.titleProgress', { title: label(r) })} valueText={`${p.have}/${p.total}`} />;
    },
    width: '180px',
  };
}

function AuthorTable({
  rows,
  profiles,
  selectable,
  selected,
  onSelectionChange,
}: {
  rows: EbookAuthor[];
  profiles: BooksFormatProfile[] | undefined;
  selectable: boolean;
  selected: ReadonlySet<number>;
  onSelectionChange: (s: Set<number>) => void;
}) {
  const update = useUpdateEbookAuthor();
  const columns: Column<EbookAuthor>[] = [
    {
      key: 'monitored',
      header: <span className="al-sr-only">{t('status.monitored')}</span>,
      label: t('status.monitored'),
      cell: (a) => <MonitorSwitch monitored={a.monitored} onChange={(monitored) => update.mutate({ id: a.id, body: { monitored } })} label={t('common.monitorTitle', { monitored: a.monitored, title: a.name })} />,
      width: '56px',
    },
    {
      key: 'author',
      header: t('books.sort.author'),
      cell: (a) => (
        <Link {...ebookAuthorLink(a)} className="mk-link">
          {a.name}
        </Link>
      ),
    },
    { key: 'profile', header: t('books.formatProfile'), cell: (a) => profileName(profiles, a.formatProfileId), mono: true },
    { key: 'books', header: t('books.sort.books'), cell: (a) => a.statistics.bookCount, mono: true, align: 'right' },
    { key: 'series', header: t('common.series'), cell: (a) => a.statistics.seriesCount, mono: true, align: 'right' },
    progressColumn<EbookAuthor>((a) => a.name),
    { key: 'size', header: t('common.size'), cell: (a) => formatBytes(a.statistics.sizeOnDisk), align: 'right', mono: true },
    { key: 'added', header: t('common.added'), cell: (a) => formatDate(a.added), mono: true },
  ];
  return (
    <Table
      columns={columns}
      rows={rows}
      rowKey={(a) => a.id}
      sortable={false}
      selectable={selectable}
      selected={selected}
      onSelectionChange={(keys) => onSelectionChange(new Set([...keys].map(Number)))}
      rowLabel={(a) => t('library.selectTitle', { title: a.name })}
      caption={t('books.kind.ebooks')}
    />
  );
}

function ComicTable({
  rows,
  profiles,
  selectable,
  selected,
  onSelectionChange,
}: {
  rows: ComicSeries[];
  profiles: BooksFormatProfile[] | undefined;
  selectable: boolean;
  selected: ReadonlySet<number>;
  onSelectionChange: (s: Set<number>) => void;
}) {
  const update = useUpdateComicSeries();
  const columns: Column<ComicSeries>[] = [
    {
      key: 'monitored',
      header: <span className="al-sr-only">{t('status.monitored')}</span>,
      label: t('status.monitored'),
      cell: (s) => <MonitorSwitch monitored={s.monitored} onChange={(monitored) => update.mutate({ id: s.id, body: { monitored } })} label={t('common.monitorTitle', { monitored: s.monitored, title: s.title })} />,
      width: '56px',
    },
    {
      key: 'title',
      header: t('common.title'),
      cell: (s) => (
        <Link {...comicSeriesLink(s)} className="mk-link">
          {s.title}
        </Link>
      ),
    },
    { key: 'publisher', header: t('books.publisher'), cell: (s) => s.publisher ?? '—', muted: true },
    { key: 'year', header: t('books.year'), cell: (s) => s.startYear ?? '—', mono: true },
    { key: 'type', header: t('common.type'), cell: (s) => seriesTypeLabel(s.seriesType) },
    { key: 'profile', header: t('books.formatProfile'), cell: (s) => profileName(profiles, s.formatProfileId), mono: true },
    progressColumn<ComicSeries>((s) => s.title),
    { key: 'size', header: t('common.size'), cell: (s) => formatBytes(s.statistics.sizeOnDisk), align: 'right', mono: true },
  ];
  return (
    <Table
      columns={columns}
      rows={rows}
      rowKey={(s) => s.id}
      sortable={false}
      selectable={selectable}
      selected={selected}
      onSelectionChange={(keys) => onSelectionChange(new Set([...keys].map(Number)))}
      rowLabel={(s) => t('library.selectTitle', { title: s.title })}
      caption={t('books.kind.comics')}
    />
  );
}

// ---------------------------------------------------------------------------------------
// Bulk actions
// ---------------------------------------------------------------------------------------

function ShelfBulkBar({ kind, ids, total, open, onSelectAll, onClear }: { kind: BooksKind; ids: number[]; total: number; open: boolean; onSelectAll: () => void; onClear: () => void }) {
  const updateAuthor = useUpdateEbookAuthor();
  const updateComic = useUpdateComicSeries();
  const delAuthor = useDeleteEbookAuthor();
  const delComic = useDeleteComicSeries();
  const command = useBooksCommand();
  const toast = useToast();
  const [deleting, setDeleting] = useState(false);
  const [busy, setBusy] = useState(false);
  const noun = kind === 'ebook' ? t('books.authorNoun', { count: ids.length }) : t('books.comicSeriesNoun', { count: ids.length });

  const setMonitored = async (monitored: boolean) => {
    setBusy(true);
    try {
      for (const id of ids) {
        if (kind === 'ebook') await updateAuthor.mutateAsync({ id, body: { monitored } });
        else await updateComic.mutateAsync({ id, body: { monitored } });
      }
      toast.push({ tone: 'ok', title: t('bulk.toast.updated', { count: ids.length }), durationMs: 4_000 });
    } catch {
      // The mutation raised its own error toast.
    } finally {
      setBusy(false);
    }
  };
  const actions: BulkAction[] = [
    {
      id: 'search',
      label: t('common.search'),
      loading: command.isPending,
      onSelect: () => command.mutate(kind === 'ebook' ? { name: 'EbookAuthorSearch', authorIds: ids } : { name: 'ComicSeriesSearch', seriesIds: ids }),
    },
    { id: 'monitor', label: t('common.monitor'), disabled: busy, onSelect: () => void setMonitored(true) },
    { id: 'unmonitor', label: t('common.unmonitor'), disabled: busy, onSelect: () => void setMonitored(false) },
    {
      id: 'refresh',
      label: t('common.refresh'),
      onSelect: () => command.mutate(kind === 'ebook' ? { name: 'RefreshEbookAuthor', authorIds: ids } : { name: 'RefreshComicSeries', seriesIds: ids }),
    },
    { id: 'delete', label: t('common.delete'), danger: true, onSelect: () => setDeleting(true) },
  ];
  return (
    <BulkBar count={ids.length} total={total} onSelectAll={onSelectAll} open={open} actions={actions} onClear={onClear}>
      <BooksDeleteDialog
        open={deleting}
        onClose={() => setDeleting(false)}
        subject={`${ids.length} ${noun}`}
        loading={delAuthor.isPending || delComic.isPending}
        onConfirm={(deleteFiles) => {
          void (async () => {
            try {
              for (const id of ids) {
                if (kind === 'ebook') await delAuthor.mutateAsync({ id, deleteFiles });
                else await delComic.mutateAsync({ id, deleteFiles });
              }
              toast.push({ tone: 'ok', title: t('bulk.toast.deleted', { count: ids.length }) });
              setDeleting(false);
              onClear();
            } catch {
              // The mutation raised its own error toast; keep the dialog open.
            }
          })();
        }}
      />
    </BulkBar>
  );
}
