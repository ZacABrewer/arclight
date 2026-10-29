import { useMemo, useState, type ReactNode } from 'react';
import { getRouteApi, Link, useNavigate } from '@tanstack/react-router';
import { AUDIBLE_REGION_TLD, type BookDetails } from '@arclight/shared';
import { Button, EmptyState, KeyValue, StatusChip, Table, Tabs, type Column } from '../../../arclight/index.js';
import { DeleteMediaDialog } from '../../../components/media/delete-media-dialog.js';
import { formatBytes, formatDate } from '../../../components/media/format.js';
import { Loading, MonitorSwitch, QueryError } from '../../../components/media/media-kit.js';
import { useBook, useDeleteBook, useSetBooksMonitored } from '../../../hooks/audiobooks.js';
import { useAudiobookSearch } from '../../../hooks/audiobook-acquisition.js';
import { DetailsHero } from '../details-kit.js';
import { AudioFilesTable } from '../media-files-table.js';
import { AudiobookCrumb, AudiobookGate, BookCoverArt, FormatTypeChip, authorLink, seriesLink } from './audiobook-kit.js';
import { AudiobookInteractiveSearchModal } from './audiobook-release-table.js';
import { audibleUrl, authorBackdrop, bookYear, chapterRows, formatOffset, formatRuntime, positionLabel } from './audiobook-model.js';
import { formatDuration } from '../music/music-model.js';
import '../library.css';
import { t } from '../../../i18n/index.js';

const route = getRouteApi('/library/audiobooks/book/$id');

export function BookDetailsPage() {
  return (
    <AudiobookGate>
      <BookDetailsView />
    </AudiobookGate>
  );
}

function BookDetailsView() {
  const { id: rawId } = route.useParams();
  const id = Number(rawId);
  const book = useBook(id);
  const setMonitored = useSetBooksMonitored();
  const del = useDeleteBook();
  const search = useAudiobookSearch();
  const navigate = useNavigate();
  const [tab, setTab] = useState('chapters');
  const [interactive, setInteractive] = useState(false);
  const [deleting, setDeleting] = useState(false);

  if (!Number.isInteger(id) || id <= 0) return <QueryError error={new Error(t('audiobooks.invalidBookId', { rawId }))} title={t('audiobooks.bookNotFound')} />;
  if (book.isPending) return <Loading />;
  if (book.isError) return <QueryError error={book.error} onRetry={() => void book.refetch()} title={t('audiobooks.couldNotLoadThisBook')} />;
  const b = book.data;
  const tld = b.region ? AUDIBLE_REGION_TLD[b.region] : 'com';

  return (
    <div className="lib-details music-details">
      <DetailsHero
        label={t('audiobooks.bookOverview')}
        backdrop={authorBackdrop(b.author)}
        art={<BookCoverArt book={b} className="mk-hero__poster" loading="eager" />}
        title={b.title}
        year={bookYear(b)}
        crumb={<AudiobookCrumb author={b.author} />}
        meta={[b.subtitle, <Credits key="credits" book={b} />, b.genres.slice(0, 3).join(', ') || null, b.runtimeMinutes ? formatRuntime(b.runtimeMinutes) : null]
          .filter(Boolean)
          .reduce<ReactNode[]>((out, part, i) => (i === 0 ? [part] : [...out, ' · ', part]), [])}
        chips={
          <>
            <MonitorSwitch
              monitored={b.monitored}
              onChange={(m) => setMonitored.mutate({ authorId: b.authorId, bookIds: [b.id], monitored: m })}
              label={t('common.monitorTitle', { monitored: b.monitored, title: b.title })}
            />
            <StatusChip status={b.hasFile ? 'downloaded' : b.monitored ? 'missing' : 'unmonitored'} large />
            <FormatTypeChip type={b.formatType} large />
          </>
        }
        facts={
          <KeyValue
            layout="grid"
            columns={4}
            items={[
              { label: t('common.released'), value: b.releaseDate ? formatDate(b.releaseDate) : '—' },
              { label: t('audiobooks.runtime'), value: formatRuntime(b.runtimeMinutes) },
              { label: t('audiobooks.publisher'), value: b.publisher || '—' },
              { label: t('common.sizeOnDisk'), value: formatBytes(b.statistics?.sizeOnDisk) },
            ]}
          />
        }
        overview={b.overview}
        actions={
          <>
            <Button variant="primary" loading={search.isPending} onClick={() => search.mutate({ name: 'BookSearch', bookIds: [b.id] })}>
              {t('common.search')}
            </Button>
            <Button onClick={() => setInteractive(true)}>{t('library.seriesDetails.interactiveSearch')}</Button>
            <Button variant="danger" onClick={() => setDeleting(true)}>
              {t('common.delete')}
            </Button>
          </>
        }
      >
        {b.narrators.length ? (
          <p className="ab-narrators" data-testid="narrators">
            <span>{t('audiobooks.narratedBy')}</span> <strong>{b.narrators.join(', ')}</strong>
          </p>
        ) : null}
        {b.series.length || b.asin ? (
          <ul className="ab-series-links" aria-label={t('audiobooks.seriesLinks')}>
            {b.series.map((s) => (
              <li key={s.seriesId}>
                <Link {...seriesLink(s)}>{[s.name, positionLabel(s.position)].filter(Boolean).join(' · ')}</Link>
              </li>
            ))}
            {b.asin ? (
              <li>
                <a href={audibleUrl('book', b.asin, tld)} target="_blank" rel="noopener noreferrer">
                  {t('audiobooks.audible')}
                </a>
              </li>
            ) : null}
          </ul>
        ) : null}
      </DetailsHero>

      <Tabs
        aria-label={t('audiobooks.bookSections')}
        value={tab}
        onChange={setTab}
        tabs={[
          { id: 'chapters', label: t('audiobooks.chapters'), count: b.chapters.length, content: <ChapterList book={b} /> },
          { id: 'files', label: t('common.files'), count: b.files.length, content: <AudioFilesTable files={b.files} error={null} loading={false} parts /> },
        ]}
      />
      <AudiobookInteractiveSearchModal
        target={interactive ? { bookId: b.id, authorId: b.authorId } : null}
        title={`${b.author.name} – ${b.title}`}
        bookTitles={new Map([[b.id, b.title]])}
        onClose={() => setInteractive(false)}
      />
      <DeleteMediaDialog
        open={deleting}
        onClose={() => setDeleting(false)}
        subject={b.title}
        noun={t('audiobooks.bookNoun', { count: 1 })}
        path={b.path ?? b.author.path}
        loading={del.isPending}
        onConfirm={(opts) =>
          del.mutate(
            { id: b.id, ...opts },
            {
              onSuccess: () => {
                setDeleting(false);
                void navigate(authorLink({ id: b.authorId }));
              },
            },
          )
        }
      />
    </div>
  );
}

/** "by A, B" with links to the credited authors that are in the library. */
function Credits({ book }: { book: BookDetails }) {
  const credits = book.authorCredits.length ? book.authorCredits : [{ name: book.author.name, authorId: book.author.id }];
  return (
    <span>
      {credits.map((c, i) => (
        <span key={`${c.name}-${i}`}>
          {i > 0 ? ', ' : null}
          {c.authorId ? (
            <Link {...authorLink({ id: c.authorId })} className="mk-link">
              {c.name}
            </Link>
          ) : (
            c.name
          )}
        </span>
      ))}
    </span>
  );
}

type ChapterRow = ReturnType<typeof chapterRows>[number];

function ChapterList({ book }: { book: BookDetails }) {
  const rows = useMemo(() => chapterRows(book.chapters, book.runtimeMinutes), [book.chapters, book.runtimeMinutes]);
  if (rows.length === 0) return <EmptyState title={t('audiobooks.noChapters')}>{t('audiobooks.noChaptersBody')}</EmptyState>;
  const columns: Column<ChapterRow>[] = [
    { key: 'index', header: '#', cell: (c) => String(c.index).padStart(2, '0'), mono: true, width: '56px', muted: true },
    { key: 'title', header: t('common.title'), cell: (c) => c.title },
    { key: 'start', header: t('audiobooks.start'), cell: (c) => formatOffset(c.startMs), mono: true, align: 'right', width: '100px' },
    { key: 'duration', header: t('music.duration'), cell: (c) => formatDuration(c.durationMs), mono: true, align: 'right', width: '100px' },
  ];
  return <Table columns={columns} rows={rows} rowKey={(c) => c.index} density="dense" sortable={false} caption={t('audiobooks.chapters')} />;
}
