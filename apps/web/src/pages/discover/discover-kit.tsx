import { useEffect, useRef, type ReactNode } from 'react';
import type { QueryKey } from '@tanstack/react-query';
import type { DiscoverItem, DiscoverPage, DiscoverTile, MediaStatus, PersonSummary, RequestStatus } from '@arclight/shared';
import { Button, Chip, EmptyState, Poster, SectionHead, Skeleton, type ChipTone } from '../../arclight/index.js';
import { PosterSkeletons, QueryError } from '../../components/media/media-kit.js';
import { DLink, titleTarget, type DiscoverTarget } from '../../features/discover/base.js';
import { tmdbImage } from '../../features/discover/images.js';
import { availabilityBadge } from '../../features/requests/status.js';
import { useDiscoverInfinite } from '../../hooks/requests.js';
import '../../components/media/media-kit.css';
import './discover.css';
import { t } from '../../i18n/index.js';

// Arclight versions of the discover building blocks: status chip, poster card, slider row,
// tile rows, infinite grid. Pages under pages/discover and the portal use these; links are
// relative to the discover root (features/discover/base.tsx) so the same components work in
// the app and in the portal.

/** Chip tone/dot for a request or availability label (no new colours: kit tones only). */
export function statusChipStyle(label: string): { tone: ChipTone; dot: 'fill' | 'ring' } {
  // Labels arrive translated (features/requests/status.ts), so compare in the active locale.
  const is = (...keys: string[]) => keys.some((k) => t(k) === label);
  if (is('common.available')) return { tone: 'accent', dot: 'fill' };
  if (is('common.approved', 'features.requests.status.processing')) return { tone: 'accent', dot: 'ring' };
  if (is('common.declined', 'status.failed')) return { tone: 'danger', dot: 'fill' };
  if (is('features.requests.status.pendingApproval')) return { tone: 'warn', dot: 'ring' };
  if (is('features.requests.status.notRequested')) return { tone: 'muted', dot: 'ring' };
  // Requested, Partially available, Completed
  return { tone: 'default', dot: 'ring' };
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
    <article className="al-poster-card dk-card" aria-label={item.title}>
      <DLink {...titleTarget(item.mediaType, item.tmdbId)} className="mk-link dk-card__link">
        <Poster src={tmdbImage(item.posterUrl, 'poster')} title={item.title}>
          {badge ? (
            <span className="mk-card-chip">
              <StatusLabelChip label={badge} />
            </span>
          ) : null}
        </Poster>
        <span className="al-poster-card__title-row">
          <span className="al-poster-card__title">{item.title}</span>
          {item.year ? <span className="al-num dk-year">{item.year}</span> : null}
        </span>
      </DLink>
      <div className="al-poster-card__meta">{subtitle ?? (item.mediaType === 'movie' ? t('common.movie') : t('common.series'))}</div>
      {children}
    </article>
  );
}

/** Square headshot card for a person (search results, cast). */
export function PersonCard({ person, subtitle }: { person: Pick<PersonSummary, 'tmdbId' | 'name' | 'profileUrl'>; subtitle?: ReactNode }) {
  return (
    <article className="dk-person" aria-label={person.name}>
      <DLink to="/person/$id" params={{ id: String(person.tmdbId) }} className="mk-cast__card">
        <Poster src={tmdbImage(person.profileUrl, 'profile')} title={person.name} />
        <span className="mk-cast__name">{person.name}</span>
        {subtitle ? <span className="mk-cast__role">{subtitle}</span> : null}
      </DLink>
    </article>
  );
}

/** Section header (title-m) with optional controls and a "See all" link. */
export function RowHead({ title, controls, seeAll }: { title: ReactNode; controls?: ReactNode; seeAll?: DiscoverTarget | null | undefined }) {
  return (
    <SectionHead
      className="dk-row-head"
      label={
        <div className="dk-row-head__label">
          <h2 className="al-title-m mk-section-title">{title}</h2>
          {controls}
        </div>
      }
      action={
        seeAll ? (
          <DLink {...seeAll} className="mk-action-link dk-see-all">
            {t('discover.home.seeAll')}
          </DLink>
        ) : null
      }
    />
  );
}

/** Horizontal track with ‹ › buttons on wide screens (swipe on touch). */
export function Track({ children, label, className }: { children: ReactNode; label: string; className?: string }) {
  const ref = useRef<HTMLDivElement>(null);
  const scroll = (dir: 1 | -1) => {
    const el = ref.current;
    if (el) el.scrollBy({ left: dir * Math.max(240, el.clientWidth * 0.8), behavior: 'smooth' });
  };
  return (
    <div className="dk-track">
      <button type="button" className="dk-track__nav dk-track__nav--prev" aria-label={t('discover.kit.scrollBack', { label })} onClick={() => scroll(-1)}>
        ‹
      </button>
      <div ref={ref} className={className ?? 'mk-slider__track'}>
        {children}
      </div>
      <button type="button" className="dk-track__nav dk-track__nav--next" aria-label={t('discover.kit.scrollForward', { label })} onClick={() => scroll(1)}>
        ›
      </button>
    </div>
  );
}

/** Horizontal slider of posters with a title-m header and an optional "See all". */
export function DiscoverRow({
  title,
  items,
  loading = false,
  error,
  action,
  seeAll,
  controls,
  empty = t('discover.kit.nothingHereYet'),
}: {
  title: string;
  items: readonly DiscoverItem[] | undefined;
  loading?: boolean;
  error?: unknown;
  /** Extra header action (replaces See all). */
  action?: ReactNode;
  seeAll?: DiscoverTarget | null | undefined;
  controls?: ReactNode;
  empty?: string;
}) {
  return (
    <section className="mk-slider" aria-label={title}>
      {action ? (
        <SectionHead label={<h2 className="al-title-m mk-section-title">{title}</h2>} action={action} />
      ) : (
        <RowHead title={title} controls={controls} seeAll={seeAll} />
      )}
      {loading ? (
        <div className="mk-slider__track" aria-busy="true" aria-label={t('common.loading')}>
          {Array.from({ length: 7 }, (_, i) => (
            <Skeleton key={i} shape="poster" />
          ))}
        </div>
      ) : error ? (
        <QueryError error={error} title={t('discover.kit.couldNotLoadTitle', { title: title.toLowerCase() })} />
      ) : !items || items.length === 0 ? (
        <p className="al-caption" style={{ margin: 0 }}>
          {empty}
        </p>
      ) : (
        <Track label={title}>
          {items.map((item) => (
            <DiscoverCard key={`${item.mediaType}-${item.tmdbId}`} item={item} />
          ))}
        </Track>
      )}
    </section>
  );
}

/** A row of tiles: genre backdrops (wide) or studio/network/provider logos. */
export function TileRow({
  title,
  tiles,
  loading,
  error,
  variant,
  target,
  seeAll,
}: {
  title: string;
  tiles: readonly DiscoverTile[] | undefined;
  loading: boolean;
  error?: unknown;
  variant: 'backdrop' | 'logo';
  target: (tile: DiscoverTile) => DiscoverTarget;
  seeAll?: DiscoverTarget | null | undefined;
}) {
  const trackClass = variant === 'backdrop' ? 'dk-tiles dk-tiles--backdrop' : 'dk-tiles dk-tiles--logo';
  return (
    <section className="mk-slider" aria-label={title}>
      <RowHead title={title} seeAll={seeAll} />
      {loading ? (
        <div className={trackClass} aria-busy="true" aria-label={t('common.loading')}>
          {Array.from({ length: 6 }, (_, i) => (
            <Skeleton key={i} height={variant === 'backdrop' ? 112 : 88} />
          ))}
        </div>
      ) : error || !tiles ? (
        <p className="al-caption" style={{ margin: 0 }}>
          {t('discover.kit.tilesUnavailable')}
        </p>
      ) : tiles.length === 0 ? (
        <p className="al-caption" style={{ margin: 0 }}>
          {t('discover.kit.nothingHereYet')}
        </p>
      ) : (
        <Track label={title} className={trackClass}>
          {tiles.map((tile) => (
            <DLink key={tile.id} {...target(tile)} className={`dk-tile dk-tile--${variant}`} aria-label={tile.name}>
              {tile.imageUrl ? (
                <img src={tmdbImage(tile.imageUrl, variant === 'backdrop' ? 'tile' : 'logo') ?? undefined} alt="" loading="lazy" decoding="async" />
              ) : null}
              <span className={variant === 'logo' && tile.imageUrl ? 'al-sr-only' : 'dk-tile__name'}>{tile.name}</span>
            </DLink>
          ))}
        </Track>
      )}
    </section>
  );
}

/** TMDB pages can repeat a title across page boundaries. */
export function dedupe<T extends { tmdbId: number; mediaType?: string }>(items: readonly T[]): T[] {
  const seen = new Set<string>();
  return items.filter((i) => {
    const k = `${i.mediaType ?? 'person'}-${i.tmdbId}`;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}

/** Loads the next page when `ref` scrolls within ~1.5 screens of the viewport. */
export function useInfiniteSentinel(hasNextPage: boolean, isFetchingNextPage: boolean, fetchNextPage: () => unknown) {
  const sentinel = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = sentinel.current;
    if (!el || typeof IntersectionObserver === 'undefined') return;
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((e) => e.isIntersecting) && hasNextPage && !isFetchingNextPage) void fetchNextPage();
      },
      // Fetch well before the end so the next page is usually there when the reader gets there.
      { rootMargin: '1200px 0px' },
    );
    observer.observe(el);
    return () => observer.disconnect();
  }, [hasNextPage, isFetchingNextPage, fetchNextPage]);
  return sentinel;
}

/** "Load more" fallback + the sentinel the observer watches. */
export function GridFooter({ sentinel, hasNextPage, loading, onMore, shown, total }: { sentinel: React.RefObject<HTMLDivElement | null>; hasNextPage: boolean; loading: boolean; onMore: () => void; shown: number; total?: number | undefined }) {
  return (
    <>
      <div ref={sentinel} className="mk-sentinel" aria-hidden="true" />
      <div className="mk-more dk-more">
        {total !== undefined ? (
          <span className="al-caption al-num" aria-live="polite">
            {t('discover.kit.shownOfTotal', { shown, total })}
          </span>
        ) : null}
        {hasNextPage ? (
          <Button loading={loading} onClick={onMore}>
            {t('discover.kit.loadMore')}
          </Button>
        ) : null}
      </div>
    </>
  );
}

/**
 * Infinite poster grid over a paged discover endpoint: the next page loads as the end of the
 * grid approaches, with skeletons while it arrives and "Load more" as the fallback. Pages stay
 * in the query cache, so Back restores the grid and the router restores the scroll position.
 */
export function DiscoverGrid({
  queryKey,
  fetchPage,
  onFirstPage,
  empty,
}: {
  queryKey: QueryKey;
  fetchPage: (page: number) => Promise<DiscoverPage>;
  onFirstPage?: (page: DiscoverPage) => void;
  empty?: ReactNode;
}) {
  const query = useDiscoverInfinite(queryKey, fetchPage);
  const { hasNextPage, isFetchingNextPage, fetchNextPage } = query;
  const sentinel = useInfiniteSentinel(hasNextPage, isFetchingNextPage, fetchNextPage);
  const first = query.data?.pages[0];

  useEffect(() => {
    if (first && onFirstPage) onFirstPage(first);
  }, [first, onFirstPage]);

  if (query.isPending) return <PosterSkeletons />;
  if (query.isError) return <QueryError error={query.error} title={t('discover.kit.couldNotLoadTitles')} onRetry={() => void query.refetch()} />;
  const items = dedupe(query.data.pages.flatMap((p) => p.results));
  if (items.length === 0 && !hasNextPage) return <>{empty ?? <EmptyState title={t('discover.kit.noTitlesFound')}>{t('discover.kit.tryOtherFilters')}</EmptyState>}</>;

  return (
    <>
      <div className="mk-poster-grid dk-grid" data-testid="discover-grid">
        {items.map((item) => (
          <DiscoverCard key={`${item.mediaType}-${item.tmdbId}`} item={item} />
        ))}
        {isFetchingNextPage ? Array.from({ length: 7 }, (_, i) => <Skeleton key={`s${i}`} shape="poster" />) : null}
      </div>
      <GridFooter sentinel={sentinel} hasNextPage={hasNextPage} loading={isFetchingNextPage} onMore={() => void fetchNextPage()} shown={items.length} total={first?.totalResults} />
    </>
  );
}
