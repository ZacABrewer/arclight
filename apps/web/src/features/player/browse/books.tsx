import { useEffect, useMemo, useState } from 'react';
import type { BrowseSort } from '@arclight/shared';
import { Input, Select } from '../../../arclight/index.js';
import { useT } from '../../../i18n/index.js';
import { Row } from '../redesign/row.js';
import { RdError, RdLoading } from '../redesign/pages/common.js';
import { useAudiobookHome, useAudiobooks, type BrowseFilters } from './api.js';
import { BookTile, ContinueBookTile } from './cards.js';
import { PlayerLink, playerPaths, useDebounced } from './kit.js';
import { AudioHead, AudioLoadMore, AudioNotice, AudioPage, AudioSection } from './rd-audio.js';

const BOOK_SORTS: readonly BrowseSort[] = ['name', 'artist', 'added', 'played'];
const DESC: ReadonlySet<BrowseSort> = new Set(['added', 'played']);
/** The full list's opening filters (the head's count reads the same first page). */
const BOOKS_DEFAULT_FILTERS: BrowseFilters = { sort: 'name', desc: false };

/**
 * /player/books (the template's Books screen): the head with the audiobook count, Continue
 * listening (time left and progress), the server's shelves, then the whole library as a grid.
 */
export function BooksHomePage() {
  const t = useT();
  const home = useAudiobookHome();
  const all = useAudiobooks(BOOKS_DEFAULT_FILTERS);
  const total = all.data?.pages[0]?.total;

  useEffect(() => {
    document.title = `${t('player.browse.books.title')} · ${t('player.documentTitle')}`;
  }, [t]);

  let rows;
  if (home.isPending) rows = <RdLoading />;
  else if (home.isError) rows = <RdError title={t('player.browse.books.loadFailed')} error={home.error} onRetry={() => void home.refetch()} />;
  else {
    const d = home.data;
    rows = (
      <div className="rd-rows rd-music-rows">
        <Row title={t('player.browse.books.continue')}>
          {d.continueListening.map((b) => (
            <ContinueBookTile key={b.id} book={b} />
          ))}
        </Row>
        <Row title={t('player.browse.books.recentlyAdded')}>
          {d.recentlyAdded.map((b) => (
            <BookTile key={b.id} book={b} />
          ))}
        </Row>
        {d.series.map((s) => (
          <Row key={s.id} title={t('player.browse.books.seriesShelf', { series: s.title })}>
            {s.books.map((b) => (
              <BookTile key={b.id} book={b} />
            ))}
          </Row>
        ))}
        <Row title={t('player.browse.books.finished')}>
          {d.finished.map((b) => (
            <BookTile key={b.id} book={b} />
          ))}
        </Row>
      </div>
    );
  }

  return (
    <AudioPage>
      <AudioHead
        title={t('player.browse.books.title')}
        sub={total !== undefined ? t('player.browse.booksCount', { count: total }) : null}
        actions={
          <PlayerLink to={playerPaths.search} className="rd-btn rd-btn--secondary">
            {t('player.browse.search.open')}
          </PlayerLink>
        }
      />
      {rows}
      <AllBooks />
    </AudioPage>
  );
}

/** Every audiobook as a grid of the same tiles, sortable and searchable. */
function AllBooks() {
  const t = useT();
  const [search, setSearch] = useState('');
  const [sort, setSort] = useState<BrowseSort>('name');
  const debounced = useDebounced(search, 300);
  const filters: BrowseFilters = useMemo(() => ({ search: debounced.trim() || undefined, sort, desc: DESC.has(sort) }), [debounced, sort]);
  const q = useAudiobooks(filters);
  const items = q.data?.pages.flatMap((p) => p.items) ?? [];
  const total = q.data?.pages[0]?.total ?? 0;

  return (
    <AudioSection title={t('player.browse.books.all')} className="rd-book-library">
      <div className="pb-filters rd-music-filters">
        <div className="pb-filters__row">
        <label className="pb-filters__search">
          <span className="pb-visually-hidden">{t('player.browse.books.searchLabel')}</span>
          <Input type="search" value={search} onChange={(e) => setSearch(e.target.value)} placeholder={t('player.browse.books.searchLabel')} />
        </label>
        <label className="pb-filters__field">
          <span className="pb-filters__label">{t('player.browse.library.sort')}</span>
          <Select
            value={sort}
            onChange={(e) => setSort(e.target.value as BrowseSort)}
            options={BOOK_SORTS.map((s) => ({ value: s, label: s === 'artist' ? t('player.browse.sort.author') : t(`player.browse.sort.${s}`) }))}
          />
        </label>
        </div>
      </div>
      {q.isPending ? (
        <RdLoading />
      ) : q.isError ? (
        <RdError title={t('player.browse.books.loadFailed')} error={q.error} onRetry={() => void q.refetch()} />
      ) : items.length === 0 ? (
        filters.search ? (
          <AudioNotice title={t('player.browse.library.noMatch')}>{t('player.browse.library.noMatchBody')}</AudioNotice>
        ) : (
          <AudioNotice title={t('player.browse.books.emptyTitle')}>{t('player.browse.books.emptyBody')}</AudioNotice>
        )
      ) : (
        <>
          <ul className="rd-music-grid" aria-label={t('player.browse.books.all')}>
            {items.map((b) => (
              <li key={b.id}>
                <BookTile book={b} fill />
              </li>
            ))}
          </ul>
          <AudioLoadMore shown={items.length} total={total} hasMore={!!q.hasNextPage} loading={q.isFetchingNextPage} onMore={() => void q.fetchNextPage()} />
        </>
      )}
    </AudioSection>
  );
}
