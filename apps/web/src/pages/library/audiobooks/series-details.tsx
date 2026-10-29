import { useMemo } from 'react';
import { getRouteApi, Link } from '@tanstack/react-router';
import { EmptyState, KeyValue, Meter } from '../../../arclight/index.js';
import { Loading, MonitorSwitch, QueryError } from '../../../components/media/media-kit.js';
import { useBookSeries, useSetBooksMonitored } from '../../../hooks/audiobooks.js';
import { DetailsHero } from '../details-kit.js';
import { AudiobookCrumb, AudiobookGate, BookCoverArt, authorLink } from './audiobook-kit.js';
import { BookCard } from './book-card.js';
import { creditNames, formatRuntime, parsePosition, sortSeriesEntries } from './audiobook-model.js';
import '../library.css';
import { t } from '../../../i18n/index.js';

const route = getRouteApi('/library/audiobooks/series/$id');

export function SeriesDetailsPage() {
  return (
    <AudiobookGate>
      <SeriesDetailsView />
    </AudiobookGate>
  );
}

function SeriesDetailsView() {
  const { id: rawId } = route.useParams();
  const id = Number(rawId);
  const series = useBookSeries(id);
  const setBooks = useSetBooksMonitored();
  const entries = useMemo(() => {
    const s = series.data;
    if (!s) return [];
    return sortSeriesEntries(
      s.books.map((book) => {
        const link = book.series.find((x) => x.seriesId === s.id);
        return { book, position: link?.position ?? null, positionSort: link?.positionSort ?? parsePosition(link?.position) };
      }),
    );
  }, [series.data]);

  if (!Number.isInteger(id) || id <= 0) return <QueryError error={new Error(t('audiobooks.invalidSeriesId', { rawId }))} title={t('audiobooks.seriesNotFound')} />;
  if (series.isPending) return <Loading />;
  if (series.isError) return <QueryError error={series.error} onRetry={() => void series.refetch()} title={t('audiobooks.couldNotLoadThisSeries')} />;
  const s = series.data;
  const have = s.books.filter((b) => b.hasFile).length;
  const allMonitored = s.books.length > 0 && s.books.every((b) => b.monitored);
  const runtime = s.books.reduce((n, b) => n + (b.runtimeMinutes ?? 0), 0);
  const first = entries[0]?.book;

  return (
    <div className="lib-details music-details">
      <DetailsHero
        label={t('audiobooks.seriesOverview')}
        art={first ? <BookCoverArt book={{ title: s.name, images: first.images }} className="mk-hero__poster" loading="eager" /> : undefined}
        title={s.name}
        crumb={<AudiobookCrumb author={s.authors[0]} />}
        meta={t('audiobooks.bookCount', { count: s.books.length })}
        chips={
          <MonitorSwitch
            monitored={allMonitored}
            label={t('common.monitorTitle', { monitored: allMonitored, title: s.name })}
            onChange={(m) => setBooks.mutate({ seriesId: s.id, bookIds: s.books.map((b) => b.id), monitored: m })}
          />
        }
        facts={
          <KeyValue
            layout="grid"
            columns={3}
            items={[
              {
                label: t('audiobooks.authors'),
                value: (
                  <span>
                    {s.authors.map((a, i) => (
                      <span key={a.id}>
                        {i > 0 ? ', ' : null}
                        <Link {...authorLink(a)} className="mk-link">
                          {a.name}
                        </Link>
                      </span>
                    ))}
                  </span>
                ),
              },
              { label: t('audiobooks.available'), value: <Meter value={s.books.length ? (have / s.books.length) * 100 : 0} label={t('library.seriesDetails.labelProgress', { label: s.name })} valueText={`${have}/${s.books.length}`} /> },
              { label: t('audiobooks.runtime'), value: formatRuntime(runtime) },
            ]}
          />
        }
        overview={s.overview}
      />
      {entries.length === 0 ? (
        <EmptyState title={t('audiobooks.noBooks')}>{t('audiobooks.noBooksBody')}</EmptyState>
      ) : (
        <div className="music-album-grid" data-testid="series-books">
          {entries.map((e) => (
            <BookCard
              key={e.book.id}
              book={e.book}
              position={e.position}
              byline={s.authors.length > 1 ? creditNames(e.book) : undefined}
              onMonitor={(m) => setBooks.mutate({ seriesId: s.id, bookIds: [e.book.id], monitored: m })}
            />
          ))}
        </div>
      )}
    </div>
  );
}
