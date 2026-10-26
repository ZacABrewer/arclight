import { useEffect, useRef, type ReactNode } from 'react';
import { Link } from '@tanstack/react-router';
import type { QueryKey } from '@tanstack/react-query';
import type { DiscoverItem, DiscoverPage } from '@media-tron/shared';
import { errorMessage } from '../../api/client.js';
import { Badge } from '../../components/badge.js';
import { Button } from '../../components/button.js';
import { EmptyState } from '../../components/empty-state.js';
import { ErrorView } from '../../components/error-boundary.js';
import { Poster } from '../../components/media/media-ui.js';
import { LoadingBlock, Spinner } from '../../components/spinner.js';
import { useDiscoverInfinite } from '../../hooks/requests.js';
import { availabilityBadge } from './status.js';
import './requests.css';

/** Link props for a title page. */
export function titleLink(mediaType: 'movie' | 'series', tmdbId: number) {
  return mediaType === 'movie'
    ? ({ to: '/discover/movie/$tmdbId', params: { tmdbId: String(tmdbId) } } as const)
    : ({ to: '/discover/tv/$tmdbId', params: { tmdbId: String(tmdbId) } } as const);
}

/** Poster card for a TMDB result, with the Media-Tron status badge. */
export function DiscoverCard({ item, subtitle }: { item: Pick<DiscoverItem, 'mediaType' | 'tmdbId' | 'title' | 'year' | 'posterUrl' | 'mediaStatus' | 'requestStatus'>; subtitle?: ReactNode | undefined }) {
  const badge = availabilityBadge(item.mediaStatus, item.requestStatus);
  return (
    <article className="poster-card" aria-label={item.title}>
      <Link {...titleLink(item.mediaType, item.tmdbId)}>
        <div className="discover-card-poster">
          {badge ? (
            <span className="discover-card-badge">
              <Badge tone={badge.tone}>{badge.label}</Badge>
            </span>
          ) : null}
          <Poster url={item.posterUrl ?? undefined} title={item.title} />
        </div>
        <div className="poster-card-title" title={item.title}>
          {item.title}
        </div>
      </Link>
      <div className="poster-card-meta">
        <span>{item.year ?? ''}</span>
        <span>{subtitle ?? (item.mediaType === 'movie' ? 'Movie' : 'Series')}</span>
      </div>
    </article>
  );
}

/** A titled horizontal row of cards (discover sliders, similar, recommendations). */
export function DiscoverRow({
  title,
  items,
  loading = false,
  error,
  action,
  empty = 'Nothing here yet.',
}: {
  title: ReactNode;
  items: readonly DiscoverItem[] | undefined;
  loading?: boolean;
  error?: unknown;
  action?: ReactNode;
  empty?: string;
}) {
  return (
    <section className="discover-section">
      <div className="discover-section-head">
        <h2 className="discover-section-title">{title}</h2>
        {action}
      </div>
      {loading ? (
        <Spinner inline size="sm" label="Loading" />
      ) : error ? (
        <p className="muted">{errorMessage(error)}</p>
      ) : !items || items.length === 0 ? (
        <p className="muted">{empty}</p>
      ) : (
        <div className="discover-row">
          {items.map((item) => (
            <DiscoverCard key={`${item.mediaType}-${item.tmdbId}`} item={item} />
          ))}
        </div>
      )}
    </section>
  );
}

/**
 * Infinite poster grid over a paged discover endpoint. Loads the next page when the sentinel
 * scrolls into view (IntersectionObserver), with a "Load more" button as the fallback.
 */
export function DiscoverGrid({
  queryKey,
  fetchPage,
  onFirstPage,
}: {
  queryKey: QueryKey;
  fetchPage: (page: number) => Promise<DiscoverPage>;
  /** Receives the first page (for titles like a network name). */
  onFirstPage?: (page: DiscoverPage) => void;
}) {
  const query = useDiscoverInfinite(queryKey, fetchPage);
  const sentinel = useRef<HTMLDivElement>(null);
  const { hasNextPage, isFetchingNextPage, fetchNextPage } = query;
  const first = query.data?.pages[0];

  useEffect(() => {
    if (first && onFirstPage) onFirstPage(first);
  }, [first, onFirstPage]);

  useEffect(() => {
    const el = sentinel.current;
    if (!el || typeof IntersectionObserver === 'undefined') return;
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((e) => e.isIntersecting) && hasNextPage && !isFetchingNextPage) void fetchNextPage();
      },
      { rootMargin: '600px' },
    );
    observer.observe(el);
    return () => observer.disconnect();
  }, [hasNextPage, isFetchingNextPage, fetchNextPage]);

  if (query.isPending) return <LoadingBlock />;
  if (query.isError) return <ErrorView error={query.error} onRetry={() => void query.refetch()} />;
  const items = dedupe(query.data.pages.flatMap((p) => p.results));
  if (items.length === 0) return <EmptyState title="No titles found" />;

  return (
    <>
      <div className="poster-grid" data-testid="discover-grid">
        {items.map((item) => (
          <DiscoverCard key={`${item.mediaType}-${item.tmdbId}`} item={item} />
        ))}
      </div>
      <div ref={sentinel} className="discover-sentinel" aria-hidden="true" />
      {hasNextPage ? (
        <div className="discover-more">
          <Button loading={isFetchingNextPage} onClick={() => void fetchNextPage()}>
            Load more
          </Button>
        </div>
      ) : null}
    </>
  );
}

/** TMDB pages can repeat a title across page boundaries. */
function dedupe(items: DiscoverItem[]): DiscoverItem[] {
  const seen = new Set<string>();
  return items.filter((i) => {
    const k = `${i.mediaType}-${i.tmdbId}`;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}
