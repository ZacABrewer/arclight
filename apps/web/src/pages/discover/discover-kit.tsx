import { useEffect, useRef, type ReactNode } from 'react';
import { Link } from '@tanstack/react-router';
import type { QueryKey } from '@tanstack/react-query';
import type { DiscoverItem, DiscoverPage, MediaStatus, RequestStatus } from '@arclight/shared';
import { Button, Chip, EmptyState, Poster, SectionHead, Skeleton, type ChipTone } from '../../arclight/index.js';
import { PosterSkeletons, QueryError } from '../../components/media/media-kit.js';
import { titleLink } from '../../features/requests/title-link.js';
import { availabilityBadge } from '../../features/requests/status.js';
import { useDiscoverInfinite } from '../../hooks/requests.js';
import '../../components/media/media-kit.css';

// Arclight versions of the discover building blocks: status chip, poster card, slider row,
// infinite grid. Pages under pages/discover and pages/requests use these.

/** Chip tone/dot for a request or availability label (no new colours: kit tones only). */
export function statusChipStyle(label: string): { tone: ChipTone; dot: 'fill' | 'ring' } {
  switch (label) {
    case 'Available':
      return { tone: 'accent', dot: 'fill' };
    case 'Approved':
    case 'Processing':
      return { tone: 'accent', dot: 'ring' };
    case 'Declined':
    case 'Failed':
      return { tone: 'danger', dot: 'fill' };
    case 'Pending approval':
      return { tone: 'warn', dot: 'ring' };
    case 'Not requested':
      return { tone: 'muted', dot: 'ring' };
    default:
      // Requested, Partially available, Completed
      return { tone: 'default', dot: 'ring' };
  }
}

export function StatusLabelChip({ label, large }: { label: string; large?: boolean | undefined }) {
  const s = statusChipStyle(label);
  return (
    <Chip tone={s.tone} dot={s.dot} large={large}>
      {label}
    </Chip>
  );
}

type CardItem = Pick<DiscoverItem, 'mediaType' | 'tmdbId' | 'title' | 'year' | 'posterUrl' | 'mediaStatus' | 'requestStatus'>;

export function cardBadge(mediaStatus: MediaStatus, requestStatus?: RequestStatus | null): string | null {
  return availabilityBadge(mediaStatus, requestStatus)?.label ?? null;
}

/** 2:3 poster card for a TMDB title with the request/availability chip over the artwork. */
export function DiscoverCard({ item, subtitle, children }: { item: CardItem; subtitle?: ReactNode | undefined; children?: ReactNode }) {
  const badge = cardBadge(item.mediaStatus, item.requestStatus);
  return (
    <article className="al-poster-card" aria-label={item.title}>
      <Link {...titleLink(item.mediaType, item.tmdbId)} className="mk-link" style={{ display: 'flex', flexDirection: 'column', gap: 9 }}>
        <Poster src={item.posterUrl} title={item.title}>
          {badge ? (
            <span className="mk-card-chip">
              <StatusLabelChip label={badge} />
            </span>
          ) : null}
        </Poster>
        <span className="al-poster-card__title-row">
          <span className="al-poster-card__title">{item.title}</span>
          {item.year ? <span className="al-num" style={{ fontSize: 11, color: 'var(--al-text-4)' }}>{item.year}</span> : null}
        </span>
      </Link>
      <div className="al-poster-card__meta">{subtitle ?? (item.mediaType === 'movie' ? 'Movie' : 'Series')}</div>
      {children}
    </article>
  );
}

/** Horizontal slider of posters with a title-m header and an optional "See all". */
export function DiscoverRow({
  title,
  items,
  loading = false,
  error,
  action,
  empty = 'Nothing here yet.',
}: {
  title: string;
  items: readonly DiscoverItem[] | undefined;
  loading?: boolean;
  error?: unknown;
  action?: ReactNode;
  empty?: string;
}) {
  return (
    <section className="mk-slider" aria-label={title}>
      <SectionHead label={<h2 className="al-title-m mk-section-title">{title}</h2>} action={action} />
      {loading ? (
        <div className="mk-slider__track" aria-busy="true" aria-label="Loading">
          {Array.from({ length: 6 }, (_, i) => (
            <Skeleton key={i} shape="poster" />
          ))}
        </div>
      ) : error ? (
        <QueryError error={error} title={`Could not load ${title.toLowerCase()}`} />
      ) : !items || items.length === 0 ? (
        <p className="al-caption" style={{ margin: 0 }}>
          {empty}
        </p>
      ) : (
        <div className="mk-slider__track">
          {items.map((item) => (
            <DiscoverCard key={`${item.mediaType}-${item.tmdbId}`} item={item} />
          ))}
        </div>
      )}
    </section>
  );
}

/** TMDB pages can repeat a title across page boundaries. */
export function dedupe(items: readonly DiscoverItem[]): DiscoverItem[] {
  const seen = new Set<string>();
  return items.filter((i) => {
    const k = `${i.mediaType}-${i.tmdbId}`;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}

/**
 * Infinite poster grid over a paged discover endpoint: the next page loads when the sentinel
 * scrolls into view, with "Load more" as the fallback.
 */
export function DiscoverGrid({
  queryKey,
  fetchPage,
  onFirstPage,
}: {
  queryKey: QueryKey;
  fetchPage: (page: number) => Promise<DiscoverPage>;
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

  if (query.isPending) return <PosterSkeletons />;
  if (query.isError) return <QueryError error={query.error} title="Could not load titles" onRetry={() => void query.refetch()} />;
  const items = dedupe(query.data.pages.flatMap((p) => p.results));
  if (items.length === 0) return <EmptyState title="No titles found">Try other filters.</EmptyState>;

  return (
    <>
      <div className="mk-poster-grid" data-testid="discover-grid">
        {items.map((item) => (
          <DiscoverCard key={`${item.mediaType}-${item.tmdbId}`} item={item} />
        ))}
      </div>
      <div ref={sentinel} className="mk-sentinel" aria-hidden="true" />
      {hasNextPage ? (
        <div className="mk-more">
          <Button loading={isFetchingNextPage} onClick={() => void fetchNextPage()}>
            Load more
          </Button>
        </div>
      ) : null}
    </>
  );
}
