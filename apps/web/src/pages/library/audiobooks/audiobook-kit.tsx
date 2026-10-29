import type { ReactNode } from 'react';
import { Link } from '@tanstack/react-router';
import type { BookFormatType } from '@arclight/shared';
import { Button, Chip, type ButtonProps } from '../../../arclight/index.js';
import { Loading } from '../../../components/media/media-kit.js';
import { useFeatures } from '../../../hooks/music.js';
import { useAudiobookSearch } from '../../../hooks/audiobook-acquisition.js';
import { NotFoundPage } from '../../not-found.js';
import { SquareArt } from '../music/music-kit.js';
import { authorImage, authorInitials, bookCover, formatTypeLabel } from './audiobook-model.js';
import '../music/music.css';
import './audiobooks.css';
import { t } from '../../../i18n/index.js';

/** An author's headshot on the square frame, two initials without one. */
export function AuthorArt({
  author,
  className,
  progress,
  progressTone,
  loading,
  children,
}: {
  author: { name: string; images: Parameters<typeof authorImage>[0]['images'] };
  className?: string | undefined;
  progress?: number | undefined;
  progressTone?: 'default' | 'warn' | 'muted' | undefined;
  loading?: 'lazy' | 'eager' | undefined;
  children?: ReactNode;
}) {
  return (
    <SquareArt
      src={authorImage(author)}
      title={author.name}
      fallback={authorInitials(author.name)}
      className={['ab-author-art', className].filter(Boolean).join(' ')}
      progress={progress}
      progressTone={progressTone}
      loading={loading}
    >
      {children}
    </SquareArt>
  );
}

/** A book cover (square, like Audible's), the title's initial without one. */
export function BookCoverArt({
  book,
  className,
  progress,
  progressTone,
  loading,
  children,
}: {
  book: { title: string; images: Parameters<typeof bookCover>[0]['images'] };
  className?: string | undefined;
  progress?: number | undefined;
  progressTone?: 'default' | 'warn' | 'muted' | undefined;
  loading?: 'lazy' | 'eager' | undefined;
  children?: ReactNode;
}) {
  return (
    <SquareArt src={bookCover(book)} title={book.title} className={className} progress={progress} progressTone={progressTone} loading={loading}>
      {children}
    </SquareArt>
  );
}

/** "Library / Audiobooks [/ Author]" crumb. */
export function AudiobookCrumb({ author }: { author?: { id: number; name: string } | undefined }) {
  return (
    <>
      <Link to="/library/audiobooks">{t('common.library')}</Link> / <Link to="/library/audiobooks">{t('common.audiobooks')}</Link>
      {author ? (
        <>
          {' / '}
          <Link to="/library/audiobooks/author/$id" params={{ id: String(author.id) }}>
            {author.name}
          </Link>
        </>
      ) : null}
    </>
  );
}

/** The "audiobook" kind chip (calendar, wanted, activity rows). */
export function AudiobookChip({ large }: { large?: boolean }) {
  return (
    <Chip tone="neutral" dot="none" large={large} data-kind="audiobook">
      {t('audiobooks.audiobook')}
    </Chip>
  );
}

/** Unabridged / abridged / dramatized. Abridged is flagged: most people want the full text. */
export function FormatTypeChip({ type, large }: { type: BookFormatType | null | undefined; large?: boolean }) {
  if (!type) return null;
  return (
    <Chip tone={type === 'abridged' ? 'warn' : 'muted'} dot="none" large={large} data-testid="format-type-chip">
      {formatTypeLabel(type)}
    </Chip>
  );
}

/** Automatic search for one book (BookSearch), e.g. from the calendar or a list row. */
export function BookSearchButton({ bookId, size = 'sm', variant, label }: { bookId: number; size?: ButtonProps['size']; variant?: ButtonProps['variant']; label?: string }) {
  const search = useAudiobookSearch();
  return (
    <Button size={size} variant={variant} aria-label={label} loading={search.isPending} onClick={() => search.mutate({ name: 'BookSearch', bookIds: [bookId] })}>
      {t('common.search')}
    </Button>
  );
}

/** Audiobook pages exist only while the flag is on: a 404 otherwise (and a skeleton while it loads). */
export function AudiobookGate({ children }: { children: ReactNode }) {
  const features = useFeatures();
  if (!features.ready) return <Loading />;
  if (!features.audiobooks) return <NotFoundPage />;
  return <>{children}</>;
}

/** Route helpers (typed paths). */
export const authorLink = (a: { id: number }) => ({ to: '/library/audiobooks/author/$id' as const, params: { id: String(a.id) } });
export const bookLink = (b: { id: number }) => ({ to: '/library/audiobooks/book/$id' as const, params: { id: String(b.id) } });
export const seriesLink = (s: { id: number } | { seriesId: number }) => ({
  to: '/library/audiobooks/series/$id' as const,
  params: { id: String('seriesId' in s ? s.seriesId : s.id) },
});
