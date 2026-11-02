import { useState } from 'react';
import { getRouteApi, Link } from '@tanstack/react-router';
import type { Ebook } from '@arclight/shared';
import { Button, PageHeader } from '../../../arclight/index.js';
import { Loading, QueryError } from '../../../components/media/media-kit.js';
import { useBooksCommand, useEbookSeries } from '../../../hooks/books.js';
import { BooksCrumb, BooksGate } from './books-kit.js';
import { byPosition } from './books-model.js';
import { BooksReleaseModal, type BooksReleaseTarget } from './books-releases.js';
import { BookGroup } from './ebook-author-details.js';
import '../library.css';
import { t } from '../../../i18n/index.js';

const route = getRouteApi('/library/books/series/$id');

export function EbookSeriesDetailsPage() {
  return (
    <BooksGate>
      <SeriesView />
    </BooksGate>
  );
}

function SeriesView() {
  const { id: rawId } = route.useParams();
  const id = Number(rawId);
  const series = useEbookSeries(id);
  const command = useBooksCommand();
  const [searching, setSearching] = useState<BooksReleaseTarget | null>(null);

  if (!Number.isInteger(id) || id <= 0) return <QueryError error={new Error(t('books.invalidId', { rawId }))} title={t('books.notFound')} />;
  if (series.isPending) return <Loading />;
  if (series.isError) return <QueryError error={series.error} onRetry={() => void series.refetch()} title={t('books.couldNotLoad')} />;
  const s = series.data;
  const books = [...s.books].sort(byPosition);
  const monitoredIds = books.filter((b) => b.monitored && !b.hasFile).map((b) => b.id);

  return (
    <div className="lib-page bk-details">
      <PageHeader
        title={s.name}
        subtitle={
          <>
            <BooksCrumb /> · {t('books.bookCount', { count: books.length })}
          </>
        }
        actions={
          <Button
            variant="primary"
            disabled={monitoredIds.length === 0}
            loading={command.isPending}
            onClick={() => command.mutate({ name: 'EbookSearch', ebookIds: monitoredIds })}
          >
            {t('library.seriesDetails.searchMonitored')}
          </Button>
        }
      />
      {s.overview ? <p className="bk-note">{s.overview}</p> : null}
      {s.audiobookCount > 0 ? (
        <p className="bk-note" data-testid="audiobook-note">
          {t('books.series.audiobookNote', { count: s.audiobookCount })} <Link to="/library/audiobooks">{t('books.series.openAudiobooks')}</Link>
        </p>
      ) : null}
      <BookGroup
        label={t('books.series.readingOrder')}
        seriesId={s.id}
        books={books}
        showAuthor
        onInteractive={(b: Ebook) => setSearching({ kind: 'ebook', id: b.id, title: b.title })}
      />
      <BooksReleaseModal target={searching} onClose={() => setSearching(null)} />
    </div>
  );
}
