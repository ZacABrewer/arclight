import { useState, type CSSProperties, type ReactNode } from 'react';
import { Link } from '@tanstack/react-router';
import { Button, Chip, type ButtonProps } from '../../../arclight/index.js';
import { cx } from '../../../arclight/cx.js';
import { Loading } from '../../../components/media/media-kit.js';
import { useFeatures } from '../../../hooks/music.js';
import { useMusicSearch } from '../../../hooks/music-acquisition.js';
import { NotFoundPage } from '../../not-found.js';
import { initialOf } from './music-model.js';
import './music.css';
import { t } from '../../../i18n/index.js';

/**
 * Square artwork on the shared poster frame (border, sheen, progress bar); without an image
 * (or when it fails) the artist's or album's initial stands in. Audiobooks use it too
 * (covers are square; author headshots fall back to two initials).
 */
export function SquareArt({
  src,
  title,
  width,
  progress,
  progressTone = 'default',
  className,
  loading = 'lazy',
  fallback,
  children,
}: {
  src: string | null | undefined;
  title: string;
  width?: number | string | undefined;
  progress?: number | undefined;
  progressTone?: 'default' | 'warn' | 'muted' | undefined;
  className?: string | undefined;
  loading?: 'lazy' | 'eager' | undefined;
  /** Text shown without an image (default: the title's first letter). */
  fallback?: string | undefined;
  children?: ReactNode;
}) {
  const [failed, setFailed] = useState(false);
  const style: CSSProperties | undefined = width === undefined ? undefined : { width };
  return (
    <div className={cx('al-poster', 'music-art', className)} style={style}>
      {src && !failed ? (
        <img src={src} alt={title} loading={loading} decoding="async" onError={() => setFailed(true)} />
      ) : (
        <div className="music-art__initial" role="img" aria-label={title} data-testid="music-initial">
          <span>{fallback ?? initialOf(title)}</span>
        </div>
      )}
      {children}
      {progress !== undefined ? (
        <div className="al-poster__progress" data-tone={progressTone === 'default' ? undefined : progressTone} aria-hidden="true">
          <span style={{ '--p': `${Math.min(100, Math.max(0, progress))}%` } as CSSProperties} />
        </div>
      ) : null}
    </div>
  );
}

/** "Library / Music [/ Artist]" crumb. */
export function MusicCrumb({ artist }: { artist?: { id: number; name: string } | undefined }) {
  return (
    <>
      <Link to="/library/music">{t('common.library')}</Link> / <Link to="/library/music">{t('common.music')}</Link>
      {artist ? (
        <>
          {' / '}
          <Link to="/library/music/artist/$id" params={{ id: String(artist.id) }}>
            {artist.name}
          </Link>
        </>
      ) : null}
    </>
  );
}

/** The "music" kind chip (calendar, wanted, search results). */
export function MusicChip({ large }: { large?: boolean }) {
  return (
    <Chip tone="neutral" dot="none" large={large} data-kind="music">
      {t('common.music')}
    </Chip>
  );
}

/** Automatic search for one album (AlbumSearch), e.g. from the calendar or a list row. */
export function AlbumSearchButton({ albumId, size = 'sm', variant, label }: { albumId: number; size?: ButtonProps['size']; variant?: ButtonProps['variant']; label?: string }) {
  const search = useMusicSearch();
  return (
    <Button size={size} variant={variant} aria-label={label} loading={search.isPending} onClick={() => search.mutate({ name: 'AlbumSearch', albumIds: [albumId] })}>
      {t('common.search')}
    </Button>
  );
}

/** Music pages exist only while the flag is on: a 404 otherwise (and a skeleton while it loads). */
export function MusicGate({ children }: { children: ReactNode }) {
  const features = useFeatures();
  if (!features.ready) return <Loading />;
  if (!features.music) return <NotFoundPage />;
  return <>{children}</>;
}
