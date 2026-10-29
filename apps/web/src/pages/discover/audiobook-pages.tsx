import { Fragment } from 'react';
import { useParams, useSearch } from '@tanstack/react-router';
import { AudibleRegion, type AudioAuthorDetail, type AudioBookDetail } from '@arclight/shared';
import { KeyValue, PageHeader, Skeleton, Tag, type KeyValueItem } from '../../arclight/index.js';
import { DLink } from '../../features/discover/base.js';
import { useAudioAuthor, useAudioBook } from '../../hooks/audio-requests.js';
import { formatRuntime } from '../library/audiobooks/audiobook-model.js';
import { AudioFeatureGate, AudioGrid, AudioHero, AudioQueryError, AudioRow, AudioSearchForm } from './audio-kit.js';
import { AudioHomeSections, AudioSearchResults } from './music-pages.js';
import { t } from '../../i18n/index.js';

// Audiobooks in Discover: the home sliders with a search box (/audiobooks?q=), book pages
// (authors, narrators, runtime, series, more by the author) and author pages (book grid,
// "Request author"). Catalogue: Audible via /discover/audiobooks, per marketplace (?region=).
// Off (EmptyState) while the audiobooks feature flag is off.

/** `?region=` of book and author pages (an Audible marketplace). */
export const parseRegionSearch = (search: Record<string, unknown>): { region?: AudibleRegion } => {
  const parsed = AudibleRegion.safeParse(search['region']);
  return parsed.success ? { region: parsed.data } : {};
};

export function AudiobooksHomePage() {
  return (
    <AudioFeatureGate domain="audiobook">
      <AudiobooksHome />
    </AudioFeatureGate>
  );
}

function AudiobooksHome() {
  const { q = '' } = useSearch({ strict: false }) as { q?: string };
  return (
    <>
      <PageHeader index="02" title={t('common.audiobooks')} actions={<AudioSearchForm key={q} domain="audiobook" initial={q} />} />
      {q ? <AudioSearchResults domain="audiobook" query={q} /> : <AudioHomeSections domain="audiobook" />}
    </>
  );
}

function useAsinAndRegion(): { asin: string; region: AudibleRegion | undefined } {
  const params = useParams({ strict: false }) as { asin?: string };
  const search = useSearch({ strict: false }) as { region?: AudibleRegion };
  return { asin: params.asin ?? '', region: search.region };
}

export function AudiobookBookPage() {
  const { asin, region } = useAsinAndRegion();
  return (
    <AudioFeatureGate domain="audiobook">
      <BookLoader key={`${asin}-${region ?? ''}`} asin={asin} region={region} />
    </AudioFeatureGate>
  );
}

function BookLoader({ asin, region }: { asin: string; region: AudibleRegion | undefined }) {
  const book = useAudioBook(asin, region);
  if (book.isPending) return <Skeleton lines={8} />;
  if (book.isError) return <AudioQueryError domain="audiobook" error={book.error} title={t('discover.audio.couldNotLoadBook')} onRetry={() => void book.refetch()} />;
  return <BookView book={book.data} />;
}

function Crumb() {
  return (
    <>
      <DLink to="">{t('common.discover')}</DLink> / <DLink to="/audiobooks">{t('common.audiobooks')}</DLink>
    </>
  );
}

function BookView({ book }: { book: AudioBookDetail }) {
  const { item } = book;
  const region = item.region ? { region: item.region } : undefined;
  const primary = book.authors.find((a) => a.foreignId);
  const authors = book.authors.length ? (
    <span className="dk-names">
      {book.authors.map((a, i) => (
        <Fragment key={`${a.name}-${i}`}>
          {i > 0 ? ', ' : null}
          {a.foreignId ? (
            <DLink to="/audiobooks/author/$asin" params={{ asin: a.foreignId }} search={region}>
              {a.name}
            </DLink>
          ) : (
            a.name
          )}
        </Fragment>
      ))}
    </span>
  ) : (
    '—'
  );
  const series = book.series.map((s) => (s.position ? t('discover.audio.seriesPosition', { name: s.name, position: s.position }) : s.name)).join(', ');
  const facts: KeyValueItem[] = [
    { label: book.authors.length > 1 ? t('audiobooks.authors') : t('audiobooks.author'), value: authors, mono: false },
    { label: t('audiobooks.narrators'), value: book.narrators.join(', ') || '—', mono: false },
    { label: t('common.runtime'), value: formatRuntime(book.runtimeMinutes) },
    ...(series ? [{ label: t('audiobooks.series'), value: series, mono: false }] : []),
    { label: t('discover.browse.releaseDate'), value: item.releaseDate ?? (item.year ? String(item.year) : '—') },
    ...(book.publisher ? [{ label: t('audiobooks.publisher'), value: book.publisher, mono: false }] : []),
  ];
  const meta = [t('discover.audio.audiobook'), book.language, book.abridged ? t('discover.audio.abridged') : null].filter(Boolean).join(' · ');
  return (
    <>
      <AudioHero
        item={item}
        label={t('discover.audio.bookOverview')}
        crumb={<Crumb />}
        meta={meta}
        chips={book.genres.slice(0, 6).map((g) => (
          <Tag key={g}>{g}</Tag>
        ))}
        facts={<KeyValue layout="grid" columns={Math.min(facts.length, 4)} items={facts} />}
        overview={book.overview}
      />
      {book.moreByAuthor.length > 0 ? (
        <AudioRow
          title={t('discover.audio.moreBy', { name: primary?.name ?? book.authors[0]?.name ?? '' })}
          items={book.moreByAuthor}
          seeAll={primary?.foreignId ? { to: '/audiobooks/author/$asin', params: { asin: primary.foreignId }, search: region } : null}
        />
      ) : null}
    </>
  );
}

export function AudiobookAuthorPage() {
  const { asin, region } = useAsinAndRegion();
  return (
    <AudioFeatureGate domain="audiobook">
      <AuthorLoader key={`${asin}-${region ?? ''}`} asin={asin} region={region} />
    </AudioFeatureGate>
  );
}

function AuthorLoader({ asin, region }: { asin: string; region: AudibleRegion | undefined }) {
  const author = useAudioAuthor(asin, region);
  if (author.isPending) return <Skeleton lines={8} />;
  if (author.isError) return <AudioQueryError domain="audiobook" error={author.error} title={t('discover.audio.couldNotLoadAuthor')} onRetry={() => void author.refetch()} />;
  return <AuthorView author={author.data} />;
}

function AuthorView({ author }: { author: AudioAuthorDetail }) {
  const { item } = author;
  return (
    <div className="mk-stack" style={{ gap: 40 }}>
      <AudioHero
        item={item}
        label={t('discover.audio.authorOverview')}
        crumb={<Crumb />}
        meta={t('audiobooks.author')}
        chips={author.genres.slice(0, 6).map((g) => (
          <Tag key={g}>{g}</Tag>
        ))}
        overview={author.overview}
      />
      <AudioGrid title={t('audiobooks.books')} items={author.books} />
    </div>
  );
}
