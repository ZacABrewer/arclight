import { useMemo, useState, type ReactNode } from 'react';
import type { BrowseSort } from '@arclight/shared';
import { Input, Segmented, Select } from '../../../arclight/index.js';
import { cx } from '../../../arclight/cx.js';
import { useT } from '../../../i18n/index.js';
import { useAlbums, useArtists, type BrowseFilters } from './api.js';
import { AlbumCard, AlbumRow, ArtistCard, ArtistRow } from './cards.js';
import { LETTERS } from './format.js';
import { Empty, GridSkeleton, LoadError, LoadMore, PageTitle, useDebounced, useStoredChoice } from './kit.js';
import { MusicNav } from './music-nav.js';

export type ViewMode = 'grid' | 'list';
const VIEWS: readonly ViewMode[] = ['grid', 'list'];
export const VIEW_STORAGE_KEY = 'arclight.player.browse.view';

/** Sorts that read newest/most first. */
const DESC_SORTS: ReadonlySet<BrowseSort> = new Set(['added', 'played', 'year']);

interface Controls {
  filters: BrowseFilters;
  /** Genres seen so far (the contract has no genre list endpoint). */
  bar: (genres: readonly string[]) => ReactNode;
  view: ViewMode;
}

function useLibraryControls(kind: 'albums' | 'artists', sorts: readonly BrowseSort[]): Controls {
  const t = useT();
  const [view, setView] = useStoredChoice<ViewMode>(`${VIEW_STORAGE_KEY}.${kind}`, VIEWS, 'grid');
  const [search, setSearch] = useState('');
  const [sort, setSort] = useState<BrowseSort>('name');
  const [genre, setGenre] = useState('');
  const [letter, setLetter] = useState('');
  const debounced = useDebounced(search, 300);
  const filters: BrowseFilters = useMemo(
    () => ({ search: debounced.trim() || undefined, sort, desc: DESC_SORTS.has(sort), genre: genre || undefined, letter: letter || undefined }),
    [debounced, sort, genre, letter],
  );

  const bar = (genres: readonly string[]) => {
    const genreOptions = [...new Set([...genres, ...(genre ? [genre] : [])])].sort((a, b) => a.localeCompare(b));
    return (
      <div className="pb-filters">
        <div className="pb-filters__row">
          <label className="pb-filters__search">
            <span className="pb-visually-hidden">{t(`player.browse.library.search.${kind}`)}</span>
            <Input type="search" value={search} onChange={(e) => setSearch(e.target.value)} placeholder={t(`player.browse.library.search.${kind}`)} />
          </label>
          <label className="pb-filters__field">
            <span className="pb-filters__label">{t('player.browse.library.sort')}</span>
            <Select value={sort} onChange={(e) => setSort(e.target.value as BrowseSort)} options={sorts.map((s) => ({ value: s, label: t(`player.browse.sort.${s}`) }))} />
          </label>
          <label className="pb-filters__field">
            <span className="pb-filters__label">{t('player.browse.library.genre')}</span>
            <Select value={genre} onChange={(e) => setGenre(e.target.value)}>
              <option value="">{t('player.browse.library.allGenres')}</option>
              {genreOptions.map((g) => (
                <option key={g} value={g}>
                  {g}
                </option>
              ))}
            </Select>
          </label>
          <Segmented<ViewMode>
            variant="soft"
            aria-label={t('player.browse.library.view')}
            value={view}
            onChange={setView}
            options={[
              { value: 'grid', label: t('player.browse.library.grid') },
              { value: 'list', label: t('player.browse.library.list') },
            ]}
          />
        </div>
        <nav className="pb-rail" aria-label={t('player.browse.library.jump')}>
          <button type="button" className="pb-rail__btn" aria-pressed={letter === ''} onClick={() => setLetter('')}>
            {t('player.browse.library.allLetters')}
          </button>
          {LETTERS.map((l) => (
            <button
              key={l}
              type="button"
              className="pb-rail__btn"
              aria-pressed={letter === l}
              aria-label={l === '#' ? t('player.browse.library.letterOther') : t('player.browse.library.letter', { letter: l })}
              onClick={() => setLetter(letter === l ? '' : l)}
            >
              {l}
            </button>
          ))}
        </nav>
      </div>
    );
  };
  return { filters, bar, view };
}

/** /player/music/albums */
export function AlbumsPage() {
  const t = useT();
  const c = useLibraryControls('albums', ['name', 'artist', 'added', 'played', 'year']);
  const q = useAlbums(c.filters);
  const items = q.data?.pages.flatMap((p) => p.items) ?? [];
  const total = q.data?.pages[0]?.total ?? 0;
  const genres = [...new Set(items.flatMap((a) => a.genres))];
  const filtered = !!(c.filters.search || c.filters.genre || c.filters.letter);

  return (
    <div className="pb-page">
      <PageTitle>{t('player.browse.nav.albums')}</PageTitle>
      <MusicNav />
      {c.bar(genres)}
      {q.isPending ? (
        <GridSkeleton label={t('player.browse.loading')} />
      ) : q.isError ? (
        <LoadError title={t('player.browse.library.albumsFailed')} error={q.error} onRetry={() => void q.refetch()} />
      ) : items.length === 0 ? (
        filtered ? (
          <Empty title={t('player.browse.library.noMatch')}>{t('player.browse.library.noMatchBody')}</Empty>
        ) : (
          <Empty title={t('player.browse.music.emptyTitle')}>{t('player.browse.music.emptyBody')}</Empty>
        )
      ) : (
        <>
          <ul className={cx(c.view === 'grid' ? 'pb-grid' : 'pb-list')} aria-label={t('player.browse.nav.albums')} data-view={c.view}>
            {items.map((a) => (c.view === 'grid' ? <AlbumCard key={a.id} album={a} /> : <AlbumRow key={a.id} album={a} />))}
          </ul>
          <LoadMore shown={items.length} total={total} hasMore={!!q.hasNextPage} loading={q.isFetchingNextPage} onMore={() => void q.fetchNextPage()} />
        </>
      )}
    </div>
  );
}

/** /player/music/artists */
export function ArtistsPage() {
  const t = useT();
  const c = useLibraryControls('artists', ['name', 'added', 'played']);
  const q = useArtists(c.filters);
  const items = q.data?.pages.flatMap((p) => p.items) ?? [];
  const total = q.data?.pages[0]?.total ?? 0;
  const genres = [...new Set(items.flatMap((a) => a.genres))];
  const filtered = !!(c.filters.search || c.filters.genre || c.filters.letter);

  return (
    <div className="pb-page">
      <PageTitle>{t('player.browse.nav.artists')}</PageTitle>
      <MusicNav />
      {c.bar(genres)}
      {q.isPending ? (
        <GridSkeleton label={t('player.browse.loading')} />
      ) : q.isError ? (
        <LoadError title={t('player.browse.library.artistsFailed')} error={q.error} onRetry={() => void q.refetch()} />
      ) : items.length === 0 ? (
        filtered ? (
          <Empty title={t('player.browse.library.noMatch')}>{t('player.browse.library.noMatchBody')}</Empty>
        ) : (
          <Empty title={t('player.browse.music.emptyTitle')}>{t('player.browse.music.emptyBody')}</Empty>
        )
      ) : (
        <>
          <ul className={cx(c.view === 'grid' ? 'pb-grid' : 'pb-list')} aria-label={t('player.browse.nav.artists')} data-view={c.view}>
            {items.map((a) => (c.view === 'grid' ? <ArtistCard key={a.id} artist={a} /> : <ArtistRow key={a.id} artist={a} />))}
          </ul>
          <LoadMore shown={items.length} total={total} hasMore={!!q.hasNextPage} loading={q.isFetchingNextPage} onMore={() => void q.fetchNextPage()} />
        </>
      )}
    </div>
  );
}
