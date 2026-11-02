import { useMemo, useState } from 'react';
import type { BrowseSort, PlayerAudiobook } from '@arclight/shared';
import { Button, Icon, Input, Meter, Select } from '../../../arclight/index.js';
import { useT } from '../../../i18n/index.js';
import { useAudiobookHome, useAudiobooks, type BrowseFilters } from './api.js';
import { BookCard } from './cards.js';
import { names, progressShare, timeLeftLabel } from './format.js';
import { Artwork, Empty, GridSkeleton, LoadError, LoadMore, PageTitle, PlayerLink, Shelf, playerPaths, useDebounced } from './kit.js';
import { usePlayerActions } from './player-hooks.js';

const BOOK_SORTS: readonly BrowseSort[] = ['name', 'artist', 'added', 'played'];
const DESC: ReadonlySet<BrowseSort> = new Set(['added', 'played']);

/** /player/books: the audiobook shelf. */
export function BooksHomePage() {
  const t = useT();
  const home = useAudiobookHome();

  let shelves;
  if (home.isPending) shelves = <GridSkeleton count={6} label={t('player.browse.loading')} />;
  else if (home.isError) shelves = <LoadError title={t('player.browse.books.loadFailed')} error={home.error} onRetry={() => void home.refetch()} />;
  else {
    const d = home.data;
    shelves = (
      <>
        {d.continueListening.length ? (
          <section className="pb-section" aria-labelledby="pb-continue">
            <h2 className="pb-section__title" id="pb-continue">
              {t('player.browse.books.continue')}
            </h2>
            <ul className="pb-continue">
              {d.continueListening.map((b) => (
                <ContinueCard key={b.id} book={b} />
              ))}
            </ul>
          </section>
        ) : null}
        {d.recentlyAdded.length ? (
          <Shelf title={t('player.browse.books.recentlyAdded')}>
            {d.recentlyAdded.map((b) => (
              <BookCard key={b.id} book={b} />
            ))}
          </Shelf>
        ) : null}
        {d.series.map((s) => (
          <Shelf key={s.id} title={t('player.browse.books.seriesShelf', { series: s.title })}>
            {s.books.map((b) => (
              <BookCard key={b.id} book={b} />
            ))}
          </Shelf>
        ))}
        {d.finished.length ? (
          <Shelf title={t('player.browse.books.finished')}>
            {d.finished.map((b) => (
              <BookCard key={b.id} book={b} />
            ))}
          </Shelf>
        ) : null}
      </>
    );
  }

  return (
    <div className="pb-page">
      <PageTitle actions={<PlayerLink to={playerPaths.search} className="al-btn al-btn--secondary">{t('player.browse.search.open')}</PlayerLink>}>
        {t('player.browse.books.title')}
      </PageTitle>
      {shelves}
      <AllBooks />
    </div>
  );
}

/** "Continue listening" card: cover, progress bar, time left, Resume. */
function ContinueCard({ book }: { book: PlayerAudiobook }) {
  const t = useT();
  const player = usePlayerActions();
  const share = progressShare(book.progress, book.durationMs);
  const left = timeLeftLabel(book.progress, book.durationMs);
  return (
    <li className="pb-continue__card">
      <PlayerLink to={playerPaths.book(book.id)} className="pb-continue__art">
        <Artwork src={book.artworkUrl} alt={book.title} />
      </PlayerLink>
      <div className="pb-continue__body">
        <PlayerLink to={playerPaths.book(book.id)} className="pb-card__title">
          {book.title}
        </PlayerLink>
        <span className="pb-card__sub">{names(book.authors) ?? t('player.browse.book.unknownAuthor')}</span>
        <Meter value={Math.round(share * 100)} label={t('player.browse.book.progressLabel', { title: book.title })} />
        <span className="pb-card__meta al-num">{left}</span>
        <Button variant="primary" size="sm" icon={<Icon name="play" />} onClick={() => player.playItem(book.itemKey)} aria-label={t('player.browse.book.resumeNamed', { title: book.title })}>
          {t('player.browse.book.resume')}
        </Button>
      </div>
    </li>
  );
}

/** Every audiobook, sortable and searchable. */
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
    <section className="pb-section" aria-labelledby="pb-all-books">
      <h2 className="pb-section__title" id="pb-all-books">
        {t('player.browse.books.all')}
      </h2>
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
      {q.isPending ? (
        <GridSkeleton label={t('player.browse.loading')} />
      ) : q.isError ? (
        <LoadError title={t('player.browse.books.loadFailed')} error={q.error} onRetry={() => void q.refetch()} />
      ) : items.length === 0 ? (
        filters.search ? (
          <Empty title={t('player.browse.library.noMatch')}>{t('player.browse.library.noMatchBody')}</Empty>
        ) : (
          <Empty title={t('player.browse.books.emptyTitle')}>{t('player.browse.books.emptyBody')}</Empty>
        )
      ) : (
        <>
          <ul className="pb-grid" aria-label={t('player.browse.books.all')}>
            {items.map((b) => (
              <BookCard key={b.id} book={b} showLeft />
            ))}
          </ul>
          <LoadMore shown={items.length} total={total} hasMore={!!q.hasNextPage} loading={q.isFetchingNextPage} onMore={() => void q.fetchNextPage()} />
        </>
      )}
    </section>
  );
}
