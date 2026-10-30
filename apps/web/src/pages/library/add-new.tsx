import { useEffect, useMemo, useState } from 'react';
import { Link, useSearch } from '@tanstack/react-router';
import type { MetadataSearchResult, MetadataSearchType } from '@arclight/shared';
import { errorMessage } from '../../api/client.js';
import { isMissingTmdbKey } from '../../api/metadata.js';
import { Button, Chip, EmptyState, ErrorBlock, Input, PageHeader, Poster, Segmented, Select, buttonClass } from '../../arclight/index.js';
import { Loading } from '../../components/media/media-kit.js';
import { useMovieList, useQualityProfiles, useRootFolders, useSeriesList } from '../../hooks/library.js';
import { useDebouncedValue, useMetadataSearch } from '../../hooks/metadata.js';
import { useFeatures } from '../../hooks/music.js';
import { AddArtistResults } from './music/add-artist.js';
import { AddAuthorResults } from './audiobooks/add-author.js';
import { AddBookResults, BOOK_SEARCH_FIELDS, bookSearchFieldLabel, type BookSearchField } from './audiobooks/add-book.js';
import { AddDialog } from './add-dialog.js';
import { resultMeta } from './add-form.js';
import './library.css';
import { t } from '../../i18n/index.js';

/** Add New tabs: the TMDB kinds, plus Music (MusicBrainz) and Audiobooks (Audible catalogue) while their flags are on. */
export type AddNewType = MetadataSearchType | 'music' | 'audiobook';

/**
 * `/library/add?type=music` / `?type=audiobook` opens the Music or Audiobooks tab ("Add artist",
 * "Add author"); `?type=movie` / `?type=series` the TMDB kind, and `?term=` fills the search box
 * (the command palette's "Add movie Dune").
 */
export function parseAddNewSearch(search: Record<string, unknown>): { type?: 'movie' | 'series' | 'music' | 'audiobook'; term?: string } {
  const type = search.type === 'music' || search.type === 'audiobook' || search.type === 'movie' || search.type === 'series' ? search.type : undefined;
  const term = typeof search.term === 'string' && search.term.trim() ? search.term.trim().slice(0, 200) : undefined;
  return { ...(type ? { type } : {}), ...(term ? { term } : {}) };
}

const ADD_TYPES: readonly AddNewType[] = ['movie', 'series', 'music', 'audiobook'];

type AudiobookTarget = 'author' | 'book';

export function AddNewPage() {
  const params = useSearch({ strict: false }) as { type?: string; term?: string };
  const features = useFeatures();
  const [term, setTerm] = useState(params.term ?? '');
  const [picked, setType] = useState<AddNewType>(ADD_TYPES.find((x) => x === params.type) ?? 'all');
  // A new deep link while the page is open (the command palette) replaces the search.
  useEffect(() => {
    if (params.term !== undefined) setTerm(params.term);
    const linked = ADD_TYPES.find((x) => x === params.type);
    if (linked) setType(linked);
  }, [params.term, params.type]);
  const [abTarget, setAbTarget] = useState<AudiobookTarget>('author');
  const [bookField, setBookField] = useState<BookSearchField>('any');
  // Music and Audiobooks fall back to "All" while their flag is off (or still loading).
  const type: AddNewType = (picked === 'music' && !features.music) || (picked === 'audiobook' && !features.audiobooks) ? 'all' : picked;
  const music = type === 'music';
  const audiobook = type === 'audiobook';
  const tmdb = !music && !audiobook;
  const debounced = useDebouncedValue(term, 400);
  const search = useMetadataSearch(tmdb ? debounced : '', tmdb ? (type as MetadataSearchType) : 'all');
  const [adding, setAdding] = useState<MetadataSearchResult | null>(null);

  const series = useSeriesList();
  const movies = useMovieList();
  const rootFolders = useRootFolders();
  const profiles = useQualityProfiles();

  const inLibrary = useMemo(() => {
    const m = new Map<string, number>();
    for (const s of series.data ?? []) m.set(`series:${s.tmdbId}`, s.id);
    for (const mv of movies.data ?? []) m.set(`movie:${mv.tmdbId}`, mv.id);
    return m;
  }, [series.data, movies.data]);

  const active = debounced.trim().length >= 2;

  return (
    <div>
      <PageHeader
        index="01"
        title={t('library.addNew.addNew')}
        subtitle={music ? t('music.add.subtitle') : audiobook ? t('audiobooks.add.subtitle') : t('library.addNew.searchTmdbForASeries')}
      />
      <div className="lib-add-search" role="search">
        <Input
          type="search"
          size="lg"
          aria-label={music ? t('music.add.searchMusicBrainz') : audiobook ? t('audiobooks.add.searchCatalogue') : t('library.addNew.searchTmdb')}
          placeholder={
            music ? t('music.add.artistPlaceholder') : audiobook ? (abTarget === 'author' ? t('audiobooks.add.authorPlaceholder') : t('audiobooks.add.bookPlaceholder')) : t('library.addNew.titleEGTheExpanse')
          }
          autoFocus
          value={term}
          onChange={(e) => setTerm(e.target.value)}
          end={search.isFetching ? '…' : undefined}
        />
        <Segmented
          aria-label={t('library.addNew.resultType')}
          variant="soft"
          value={type}
          onChange={setType}
          options={[
            { value: 'all', label: t('common.all') },
            { value: 'series', label: t('common.series') },
            { value: 'movie', label: t('common.movies') },
            ...(features.music ? [{ value: 'music' as const, label: t('common.music') }] : []),
            ...(features.audiobooks ? [{ value: 'audiobook' as const, label: t('common.audiobooks') }] : []),
          ]}
        />
        {audiobook ? (
          <Segmented
            aria-label={t('audiobooks.add.searchFor')}
            variant="soft"
            value={abTarget}
            onChange={setAbTarget}
            options={[
              { value: 'author' as const, label: t('audiobooks.authors') },
              { value: 'book' as const, label: t('audiobooks.books') },
            ]}
          />
        ) : null}
        {audiobook && abTarget === 'book' ? (
          <Select
            aria-label={t('audiobooks.add.searchBy')}
            value={bookField}
            onChange={(e) => setBookField(e.target.value as BookSearchField)}
            options={BOOK_SEARCH_FIELDS.map((f) => ({ value: f, label: bookSearchFieldLabel(f) }))}
          />
        ) : null}
        <Link to="/activity/manual-import" className={buttonClass({ variant: 'ghost' })}>
          {t('library.addNew.importFolder')}
        </Link>
      </div>

      {music ? (
        <AddArtistResults term={debounced} />
      ) : audiobook ? (
        abTarget === 'author' ? (
          <AddAuthorResults term={debounced} />
        ) : (
          <AddBookResults term={debounced} field={bookField} />
        )
      ) : !active ? (
        <EmptyState title={t('library.addNew.typeATitleToSearch')}>{t('library.addNew.resultsComeFromTmdbTitles')}</EmptyState>
      ) : search.isError ? (
        isMissingTmdbKey(search.error) ? (
          <EmptyState
            title={t('library.addNew.tmdbHasNoApiKey')}
            action={
              // The TMDB key lives on Settings → General (metadata section).
              <Link className={buttonClass({ variant: 'primary' })} to="/settings/general">
                {t('library.addNew.addTmdbKey')}
              </Link>
            }
          >
            {errorMessage(search.error)}
          </EmptyState>
        ) : (
          <ErrorBlock title={t('library.addNew.tmdbSearchFailed')} onRetry={() => void search.refetch()} retryLabel={t('library.addNew.tryAgain')}>
            {errorMessage(search.error)}
          </ErrorBlock>
        )
      ) : search.isPending ? (
        <Loading label={t('library.addNew.searching')} />
      ) : search.data.length === 0 ? (
        <EmptyState title={t('library.addNew.noResultsForDebounced', { debounced: debounced.trim() })}>{t('library.addNew.checkTheSpellingOrTry')}</EmptyState>
      ) : (
        <div role="list" aria-label={t('common.searchResults')}>
          {search.data.map((r) => (
            <ResultRow key={`${r.mediaType}-${r.tmdbId}`} result={r} libraryId={inLibrary.get(`${r.mediaType}:${r.tmdbId}`)} onAdd={() => setAdding(r)} />
          ))}
        </div>
      )}

      <AddDialog result={adding} onClose={() => setAdding(null)} rootFolders={rootFolders.data ?? []} profiles={profiles.data ?? []} />
    </div>
  );
}

function ResultRow({ result, libraryId, onAdd }: { result: MetadataSearchResult; libraryId: number | undefined; onAdd: () => void }) {
  return (
    <article className="mk-result" role="listitem" aria-label={result.title}>
      <Poster src={result.images.poster} title={result.title} />
      <div style={{ minWidth: 0 }}>
        <h2 className="mk-result__title">
          {result.title}
          {result.year ? <span className="al-num mk-muted">{result.year}</span> : null}
          {libraryId !== undefined ? <Chip tone="accent">{t('common.inLibrary')}</Chip> : null}
        </h2>
        <div className="mk-result__meta">
          {resultMeta(result)}
          {result.ratings.tmdb.votes > 0 ? (
            <>
              {t('library.addNew.tmdb')} <span className="al-num">{result.ratings.tmdb.value.toFixed(1)}</span>
            </>
          ) : null}
          {result.originalTitle && result.originalTitle !== result.title ? ` · ${result.originalTitle}` : null}
        </div>
        <p className="mk-result__overview">{result.overview || t('common.noOverviewAvailable')}</p>
      </div>
      <div>
        {libraryId !== undefined ? (
          <Link
            className={buttonClass({ variant: 'ghost', size: 'sm' })}
            {...(result.mediaType === 'series'
              ? { to: '/library/series/$id' as const, params: { id: String(libraryId) } }
              : { to: '/library/movie/$id' as const, params: { id: String(libraryId) } })}
          >
            {t('common.open')}
          </Link>
        ) : (
          <Button size="sm" variant="secondary" aria-label={t('library.addNew.addTitle', { title: result.title })} onClick={onAdd}>
            {t('common.add')}
          </Button>
        )}
      </div>
    </article>
  );
}
