import { useEffect, useId, useRef, useState, type CSSProperties, type ReactNode } from 'react';
import { Link, useParams, useRouterState } from '@tanstack/react-router';
import { Button, EmptyState, ErrorBlock, Icon, Mark, Skeleton } from '../../../arclight/index.js';
import { cx } from '../../../arclight/cx.js';
import { errorMessage } from '../../../api/client.js';
import { useT } from '../../../i18n/index.js';
import './browse.css';

// Shared pieces for the player browse pages: links, artwork, shelves and the
// loading / error / empty states.

/** Concrete player paths (the router registers the matching patterns). */
export const playerPaths = {
  music: '/player/music',
  albums: '/player/music/albums',
  artists: '/player/music/artists',
  album: (id: number) => `/player/music/album/${id}`,
  artist: (id: number) => `/player/music/artist/${id}`,
  playlists: '/player/music/playlists',
  playlist: (id: number) => `/player/music/playlist/${id}`,
  books: '/player/books',
  book: (id: number) => `/player/books/${id}`,
  search: '/player/search',
};

export interface PlayerLinkProps {
  to: string;
  children?: ReactNode;
  className?: string | undefined;
  'aria-label'?: string | undefined;
  'aria-current'?: 'page' | undefined;
  onClick?: (() => void) | undefined;
}

/**
 * A router link to a concrete player path. One cast point: the /player routes are wired in
 * router.tsx by the player core, so this folder cannot name their typed patterns.
 */
export function PlayerLink({ to, ...rest }: PlayerLinkProps) {
  // Exact: the router otherwise marks a link current on every route under it, so /player (Home)
  // read as the current tab on every page. Callers that track a section set aria-current themselves.
  const props = { to, activeOptions: { exact: true }, ...rest } as unknown as Parameters<typeof Link>[0];
  return <Link {...props} />;
}

/** A numeric route param ($albumId, $bookId, ...); NaN when missing. */
export function useNumericParam(name: string): number {
  const params = useParams({ strict: false }) as Record<string, string | undefined>;
  const raw = params[name];
  return raw && /^[1-9][0-9]*$/.test(raw) ? Number(raw) : Number.NaN;
}

/** `value`, settled for `ms` (search boxes). */
export function useDebounced<T>(value: T, ms = 300): T {
  const [settled, setSettled] = useState(value);
  useEffect(() => {
    const id = setTimeout(() => setSettled(value), ms);
    return () => clearTimeout(id);
  }, [value, ms]);
  return settled;
}

/**
 * The search box text from the page's `?q=` (a link like /player/search?q=dune): the box starts
 * with it and follows it when the URL changes. Typing stays local and does not rewrite the URL.
 */
export function useUrlQuery(max = 100): [string, (v: string) => void] {
  const fromUrl = useRouterState({
    select: (s) => {
      const v = (s.location.search as Record<string, unknown> | undefined)?.q;
      return typeof v === 'string' ? v : typeof v === 'number' ? String(v) : '';
    },
  }).slice(0, max);
  const [text, setText] = useState(fromUrl);
  useEffect(() => setText(fromUrl), [fromUrl]);
  return [text, setText];
}

/** A per-browser preference in localStorage (view mode); falls back quietly when storage is blocked. */
export function useStoredChoice<V extends string>(key: string, allowed: readonly V[], fallback: V): [V, (v: V) => void] {
  const [value, setValue] = useState<V>(() => {
    try {
      const raw = localStorage.getItem(key);
      return raw && (allowed as readonly string[]).includes(raw) ? (raw as V) : fallback;
    } catch {
      return fallback;
    }
  });
  const set = (v: V) => {
    setValue(v);
    try {
      localStorage.setItem(key, v);
    } catch {
      // Private window or blocked storage: the choice lasts for this visit only.
    }
  };
  return [value, set];
}

/** Square (music) or 2:3 artwork with the brand mark standing in when there is no image. */
export function Artwork({
  src,
  alt,
  size,
  shape = 'square',
  progress,
  className,
  children,
  loading = 'lazy',
}: {
  src: string | null | undefined;
  /** Empty: decorative (the card's text already names it). */
  alt: string;
  size?: number | string | undefined;
  shape?: 'square' | 'round' | undefined;
  /** 0..1 progress bar along the bottom edge. */
  progress?: number | undefined;
  className?: string | undefined;
  children?: ReactNode;
  loading?: 'lazy' | 'eager' | undefined;
}) {
  const [failed, setFailed] = useState(false);
  const style: CSSProperties | undefined = size === undefined ? undefined : { width: size };
  return (
    <div className={cx('pb-art', shape === 'round' && 'pb-art--round', className)} style={style}>
      {src && !failed ? (
        <img src={src} alt={alt} loading={loading} decoding="async" onError={() => setFailed(true)} />
      ) : (
        <div className="pb-art__placeholder" data-testid="pb-art-placeholder" role={alt ? 'img' : undefined} aria-label={alt || undefined}>
          <Mark size={36} />
        </div>
      )}
      {children}
      {progress !== undefined && progress > 0 ? (
        <div className="pb-art__progress" aria-hidden="true">
          <span style={{ width: `${Math.round(Math.min(1, progress) * 100)}%` }} />
        </div>
      ) : null}
    </div>
  );
}

/** Format badge: "FLAC 24/96" plus the lossless marker. */
export function FormatBadge({ label, lossless }: { label: string | null; lossless: boolean }) {
  const t = useT();
  if (!label && !lossless) return null;
  return (
    <span className="pb-badge" data-lossless={lossless || undefined}>
      {lossless ? <span className="pb-badge__diamond" aria-hidden="true" /> : null}
      {label ?? t('player.browse.lossless')}
      {lossless && label ? <span className="pb-visually-hidden">{`, ${t('player.browse.lossless')}`}</span> : null}
    </span>
  );
}

/** Three bars beside the playing item (still under reduced motion). */
export function NowPlayingBars({ playing }: { playing: boolean }) {
  const t = useT();
  return (
    <span className={cx('pb-eq', playing && 'pb-eq--live')} role="img" aria-label={playing ? t('player.browse.nowPlaying') : t('player.browse.paused')}>
      <span />
      <span />
      <span />
    </span>
  );
}

export function PageTitle({ eyebrow, children, actions }: { eyebrow?: ReactNode; children: ReactNode; actions?: ReactNode }) {
  return (
    <header className="pb-head">
      <div className="pb-head__text">
        {eyebrow ? <p className="pb-eyebrow">{eyebrow}</p> : null}
        <h1 className="pb-title">{children}</h1>
      </div>
      {actions ? <div className="pb-head__actions">{actions}</div> : null}
    </header>
  );
}

/**
 * A horizontal shelf. The row is a focusable, labelled region so arrow keys scroll it; the
 * two buttons page it for mouse users.
 */
export function Shelf({ title, action, children, id }: { title: string; action?: ReactNode; children: ReactNode; id?: string }) {
  const t = useT();
  const rowRef = useRef<HTMLUListElement>(null);
  const page = (dir: 1 | -1) => {
    const el = rowRef.current;
    if (!el) return;
    const reduce = typeof window.matchMedia === 'function' && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    el.scrollBy?.({ left: dir * Math.max(200, el.clientWidth * 0.8), behavior: reduce ? 'auto' : 'smooth' });
  };
  const autoId = useId();
  const headingId = id ?? autoId;
  return (
    <section className="pb-shelf" aria-labelledby={headingId}>
      <div className="pb-shelf__head">
        <h2 className="pb-shelf__title" id={headingId}>
          {title}
        </h2>
        <div className="pb-shelf__tools">
          {action}
          <Button variant="ghost" size="sm" className="pb-shelf__page" icon={<Icon name="chevronLeft" />} aria-label={t('player.browse.shelf.back', { title })} onClick={() => page(-1)} />
          <Button variant="ghost" size="sm" className="pb-shelf__page" icon={<Icon name="chevronRight" />} aria-label={t('player.browse.shelf.forward', { title })} onClick={() => page(1)} />
        </div>
      </div>
      <ul ref={rowRef} className="pb-shelf__row" tabIndex={0} aria-labelledby={headingId}>
        {children}
      </ul>
    </section>
  );
}

/** Placeholder cards while a grid or shelf loads. */
export function GridSkeleton({ count = 12, label }: { count?: number; label: string }) {
  return (
    <div className="pb-grid" role="status" aria-label={label} aria-busy="true">
      {Array.from({ length: count }, (_, i) => (
        <div key={i} className="pb-card">
          <Skeleton shape="block" style={{ aspectRatio: '1 / 1', height: 'auto' }} />
          <Skeleton lines={2} />
        </div>
      ))}
    </div>
  );
}

/** Placeholder for a details page (hero + rows). */
export function DetailsSkeleton({ label }: { label: string }) {
  return (
    <div className="pb-page" role="status" aria-label={label} aria-busy="true">
      <div className="pb-hero">
        <Skeleton className="pb-hero__art" style={{ aspectRatio: '1 / 1', height: 'auto' }} />
        <div className="pb-hero__body">
          <Skeleton lines={3} />
        </div>
      </div>
      <Skeleton lines={5} />
    </div>
  );
}

export function LoadError({ title, error, onRetry }: { title: string; error: unknown; onRetry: () => void }) {
  return (
    <ErrorBlock title={title} onRetry={onRetry}>
      {errorMessage(error)}
    </ErrorBlock>
  );
}

export function Empty({ title, children, action }: { title: string; children?: ReactNode; action?: ReactNode }) {
  return (
    <EmptyState title={title} action={action} icon={<span className="pb-empty-mark"><Mark size={40} /></span>}>
      {children}
    </EmptyState>
  );
}

/** "Load more" under a paged grid, with the running count. */
export function LoadMore({ shown, total, hasMore, loading, onMore }: { shown: number; total: number; hasMore: boolean; loading: boolean; onMore: () => void }) {
  const t = useT();
  return (
    <div className="pb-more">
      <p className="pb-muted" aria-live="polite">
        {t('player.browse.showing', { shown, total })}
      </p>
      {hasMore ? (
        <Button onClick={onMore} loading={loading}>
          {t('player.browse.loadMore')}
        </Button>
      ) : null}
    </div>
  );
}

/** Shuffle glyph in the kit's icon idiom (the shared set has none yet). */
export function ShuffleIcon() {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      viewBox="0 0 24 24"
      width={16}
      height={16}
      fill="none"
      stroke="currentColor"
      strokeWidth={1.5}
      strokeLinecap="square"
      strokeLinejoin="miter"
      className="al-icon"
      aria-hidden="true"
      focusable="false"
    >
      <path d="M3 7h4l10 10h4M3 17h4l3-3M14 10l3-3h4M18 4l3 3-3 3M18 14l3 3-3 3" />
    </svg>
  );
}
