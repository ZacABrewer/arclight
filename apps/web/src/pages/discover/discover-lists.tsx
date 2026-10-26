import { useCallback, type ReactNode } from 'react';
import { useNavigate, useParams, useSearch } from '@tanstack/react-router';
import { DiscoverListName } from '@arclight/shared';
import { discoverApi, type DiscoverKind } from '../../api/requests.js';
import { EmptyState, PageHeader, Segmented } from '../../arclight/index.js';
import { useDiscoverNavigate } from '../../features/discover/base.js';
import { SLIDER_LABELS } from '../../features/requests/status.js';
import { requestKeys } from '../../hooks/request-keys.js';
import { DiscoverGrid } from './discover-kit.js';
import { t } from '../../i18n/index.js';

// Grid pages over one ready-made list each: trending (with time window), upcoming, and
// /list/:list (popular, top rated, now playing, airing).

export interface KindSearch {
  mediaType: DiscoverKind;
}

export const parseKindSearch = (search: Record<string, unknown>): KindSearch => ({
  mediaType: search['mediaType'] === 'tv' ? 'tv' : 'movie',
});

export interface TrendingSearch {
  mediaType?: 'movie' | 'tv';
  window?: 'week';
}

export const parseTrendingSearch = (search: Record<string, unknown>): TrendingSearch => ({
  ...(search['mediaType'] === 'movie' || search['mediaType'] === 'tv' ? { mediaType: search['mediaType'] } : {}),
  ...(search['window'] === 'week' ? { window: 'week' as const } : {}),
});

/** Page header + grid body. */
function GridPage({ title, subtitle, controls, children }: { title: string; subtitle?: ReactNode; controls?: ReactNode; children: ReactNode }) {
  return (
    <>
      <PageHeader index="02" title={title} subtitle={subtitle}>
        {controls}
      </PageHeader>
      {children}
    </>
  );
}

function useSetSearch() {
  const navigate = useNavigate();
  return (search: Record<string, unknown>) => void navigate({ to: '.', search, replace: true } as unknown as Parameters<typeof navigate>[0]);
}

export function DiscoverTrendingPage() {
  const search = parseTrendingSearch(useSearch({ strict: false }) as Record<string, unknown>);
  const set = useSetSearch();
  const mediaType = search.mediaType ?? 'all';
  const timeWindow = search.window ?? 'day';
  const fetchPage = useCallback((page: number) => discoverApi.trending({ mediaType, timeWindow, page }), [mediaType, timeWindow]);
  const update = (next: { mediaType?: 'all' | 'movie' | 'tv'; window?: 'day' | 'week' }) => {
    const m = next.mediaType ?? mediaType;
    const w = next.window ?? timeWindow;
    set({ ...(m === 'all' ? {} : { mediaType: m }), ...(w === 'week' ? { window: 'week' } : {}) });
  };
  return (
    <GridPage
      title={t('common.trending')}
      controls={
        <>
          <Segmented
            aria-label={t('common.mediaType')}
            value={mediaType}
            onChange={(v) => update({ mediaType: v })}
            options={[
              { value: 'all', label: t('common.all') },
              { value: 'movie', label: t('common.movies') },
              { value: 'tv', label: t('common.series') },
            ]}
          />
          <Segmented
            aria-label={t('discover.lists.timeWindow')}
            variant="soft"
            value={timeWindow}
            onChange={(v) => update({ window: v })}
            options={[
              { value: 'day', label: t('discover.lists.today') },
              { value: 'week', label: t('discover.lists.thisWeek') },
            ]}
          />
        </>
      }
    >
      <DiscoverGrid queryKey={requestKeys.discover.list('trending', { mediaType, timeWindow })} fetchPage={fetchPage} />
    </GridPage>
  );
}

export function DiscoverUpcomingPage() {
  const { mediaType } = parseKindSearch(useSearch({ strict: false }) as Record<string, unknown>);
  const go = useDiscoverNavigate();
  const fetchPage = useCallback((page: number) => discoverApi.upcoming({ mediaType, page }), [mediaType]);
  return (
    <GridPage
      title={mediaType === 'movie' ? t('discover.lists.upcomingMovies') : t('discover.lists.upcomingSeries')}
      controls={
        <Segmented
          aria-label={t('common.mediaType')}
          value={mediaType}
          onChange={(k) => void go({ to: '/upcoming', search: { mediaType: k }, replace: true })}
          options={[
            { value: 'movie', label: t('common.movies') },
            { value: 'tv', label: t('common.series') },
          ]}
        />
      }
    >
      <DiscoverGrid queryKey={requestKeys.discover.list('upcoming', { mediaType })} fetchPage={fetchPage} />
    </GridPage>
  );
}

/** Title of a ready-made list. */
export function listTitle(list: DiscoverListName): string {
  switch (list) {
    case 'popularMovies':
      return SLIDER_LABELS.popularMovies;
    case 'popularTv':
      return SLIDER_LABELS.popularTv;
    case 'upcomingMovies':
      return t('discover.lists.upcomingMovies');
    case 'upcomingTv':
      return t('discover.lists.upcomingSeries');
    case 'nowPlaying':
      return SLIDER_LABELS.nowPlaying;
    case 'topRatedMovies':
      return SLIDER_LABELS.topRatedMovies;
    case 'topRatedTv':
      return SLIDER_LABELS.topRatedTv;
    case 'airingToday':
      return t('discover.lists.airingToday');
    case 'onTheAir':
      return SLIDER_LABELS.airingTv;
  }
}

/** /list/:list: one ready-made TMDB list as an infinite grid. */
export function DiscoverListPage() {
  const params = useParams({ strict: false }) as { list?: string };
  const parsed = DiscoverListName.safeParse(params.list);
  const list = parsed.success ? parsed.data : null;
  const fetchPage = useCallback((page: number) => discoverApi.list(list ?? 'popularMovies', { page }), [list]);
  if (!list) return <EmptyState title={t('discover.lists.unknownList')}>{t('discover.lists.unknownListHelp')}</EmptyState>;
  return (
    <GridPage title={listTitle(list)}>
      <DiscoverGrid queryKey={requestKeys.discover.list('list', { list })} fetchPage={fetchPage} />
    </GridPage>
  );
}
