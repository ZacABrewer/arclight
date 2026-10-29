import { useState, type ReactNode } from 'react';
import { Link } from '@tanstack/react-router';
import type { DiscoverSlider } from '@arclight/shared';
import { EmptyState, PageHeader, Segmented, Skeleton } from '../../arclight/index.js';
import { QueryError } from '../../components/media/media-kit.js';
import { DLink, useInPortal, type DiscoverTarget } from '../../features/discover/base.js';
import { SLIDER_LABELS } from '../../features/requests/status.js';
import { useFeatures } from '../../hooks/music.js';
import { useDiscoverOptions, useDiscoverTiles, useSliderItems, useSliders } from '../../hooks/requests.js';
import type { DiscoverKind } from '../../api/requests.js';
import { DiscoverRow, TileRow } from './discover-kit.js';
import { DiscoverSearchBox } from './discover-search.js';
import { t } from '../../i18n/index.js';

// Discover home: the sliders an admin enabled (Settings > Requests > Discover sliders), each
// fetched in parallel as soon as the slider list arrives. Poster sliders link "See all" to the
// full grid; genre, studio, network and streaming sliders are tile rows.

export function sliderTitle(slider: Pick<DiscoverSlider, 'title' | 'type'>): string {
  return slider.title ?? SLIDER_LABELS[slider.type];
}

/** Quick links under the page title (Music and Audiobooks while their feature flag is on). */
export function BrowseLinks() {
  const inPortal = useInPortal();
  const features = useFeatures();
  return (
    <nav className="mk-row" aria-label={t('discover.home.browse')}>
      <DLink className="mk-chip-link" to="/movies">
        {t('common.movies')}
      </DLink>
      <DLink className="mk-chip-link" to="/tv">
        {t('common.series')}
      </DLink>
      {features.music ? (
        <DLink className="mk-chip-link" to="/music">
          {t('common.music')}
        </DLink>
      ) : null}
      {features.audiobooks ? (
        <DLink className="mk-chip-link" to="/audiobooks">
          {t('common.audiobooks')}
        </DLink>
      ) : null}
      <DLink className="mk-chip-link" to="/trending">
        {t('common.trending')}
      </DLink>
      <DLink className="mk-chip-link" to="/list/$list" params={{ list: 'topRatedMovies' }}>
        {SLIDER_LABELS.topRatedMovies}
      </DLink>
      <DLink className="mk-chip-link" to="/list/$list" params={{ list: 'onTheAir' }}>
        {SLIDER_LABELS.airingTv}
      </DLink>
      {inPortal ? null : (
        <Link className="mk-chip-link" to="/requests/mine">
          {t('common.myRequests')}
        </Link>
      )}
    </nav>
  );
}

export function DiscoverHomePage() {
  return (
    <>
      <PageHeader index="02" title={t('common.discover')} actions={<DiscoverSearchBox />}>
        <BrowseLinks />
      </PageHeader>
      <DiscoverSliders />
    </>
  );
}

/** Every enabled slider, in order. Used by the app's Discover home and the portal home. */
export function DiscoverSliders() {
  const sliders = useSliders();
  const enabled = (sliders.data ?? []).filter((s) => s.enabled).sort((a, b) => a.order - b.order);
  if (sliders.isPending) return <Skeleton lines={6} />;
  if (sliders.isError) return <QueryError error={sliders.error} title={t('discover.home.couldNotLoadDiscover')} onRetry={() => void sliders.refetch()} />;
  if (enabled.length === 0) return <EmptyState title={t('discover.home.noSlidersEnabled')}>{t('discover.home.anAdminCanTurnSliders')}</EmptyState>;
  return (
    <div className="mk-stack" style={{ gap: 40 }}>
      {enabled.map((s) => (
        <SliderSection key={s.id} slider={s} />
      ))}
    </div>
  );
}

function SliderSection({ slider }: { slider: DiscoverSlider }) {
  const title = sliderTitle(slider);
  switch (slider.type) {
    case 'movieGenres':
      return <GenreTiles kind="movie" title={title} />;
    case 'tvGenres':
      return <GenreTiles kind="tv" title={title} />;
    case 'studios':
      return <CompanyTiles kind="movie" title={title} />;
    case 'networks':
      return <CompanyTiles kind="tv" title={title} />;
    case 'providers':
      return <ProviderTiles title={title} />;
    case 'trending':
      return <TrendingSlider slider={slider} />;
    default:
      return <ItemSlider slider={slider} />;
  }
}

function GenreTiles({ kind, title }: { kind: DiscoverKind; title: string }) {
  const tiles = useDiscoverTiles('genres', kind);
  return (
    <TileRow
      title={title}
      tiles={tiles.data}
      loading={tiles.isPending}
      error={tiles.error}
      variant="backdrop"
      target={(g) => ({ to: '/genre/$id', params: { id: String(g.id) }, search: { mediaType: kind } })}
      seeAll={{ to: kind === 'movie' ? '/movies' : '/tv' }}
    />
  );
}

function CompanyTiles({ kind, title }: { kind: DiscoverKind; title: string }) {
  const tiles = useDiscoverTiles('companies', kind);
  return (
    <TileRow
      title={title}
      tiles={tiles.data}
      loading={tiles.isPending}
      error={tiles.error}
      variant="logo"
      target={(c) => ({ to: kind === 'movie' ? '/studio/$id' : '/network/$id', params: { id: String(c.id) } })}
    />
  );
}

function ProviderTiles({ title }: { title: string }) {
  const options = useDiscoverOptions();
  const region = options.data?.region;
  const tiles = useDiscoverTiles('providers', 'movie', region);
  return (
    <TileRow
      title={region ? `${title} · ${region}` : title}
      tiles={tiles.data?.slice(0, 24)}
      loading={tiles.isPending}
      error={tiles.error}
      variant="logo"
      target={(p) => ({ to: '/provider/$id', params: { id: String(p.id) }, search: { mediaType: 'movie', ...(region ? { region } : {}) } })}
    />
  );
}

function TrendingSlider({ slider }: { slider: DiscoverSlider }) {
  const [timeWindow, setTimeWindow] = useState<'day' | 'week'>('day');
  const items = useSliderItems(slider.id, timeWindow);
  return (
    <DiscoverRow
      title={sliderTitle(slider)}
      items={items.data?.results}
      loading={items.isPending}
      error={items.error}
      seeAll={{ to: '/trending', search: timeWindow === 'week' ? { window: 'week' } : {} }}
      controls={
        <Segmented
          aria-label={t('discover.lists.timeWindow')}
          variant="soft"
          value={timeWindow}
          onChange={setTimeWindow}
          options={[
            { value: 'day', label: t('discover.lists.today') },
            { value: 'week', label: t('discover.lists.thisWeek') },
          ]}
        />
      }
    />
  );
}

function ItemSlider({ slider }: { slider: DiscoverSlider }) {
  const items = useSliderItems(slider.id);
  const inPortal = useInPortal();
  return (
    <DiscoverRow
      title={sliderTitle(slider)}
      items={items.data?.results}
      loading={items.isPending}
      error={items.error}
      seeAll={seeAllTarget(slider, inPortal)}
      {...(!inPortal && (slider.type === 'watchlist' || slider.type === 'recentRequests')
        ? { action: <AppLink to={slider.type === 'watchlist' ? '/watchlist' : '/requests/mine'}>{t('discover.home.seeAll')}</AppLink> }
        : {})}
    />
  );
}

/** Links to app pages outside Discover (watchlist, my requests); the portal has its own. */
function AppLink({ to, children }: { to: '/watchlist' | '/requests/mine'; children: ReactNode }) {
  return (
    <Link className="mk-action-link dk-see-all" to={to}>
      {children}
    </Link>
  );
}

/** Where a slider's "See all" goes, or null when it has no full page. */
export function seeAllTarget(slider: Pick<DiscoverSlider, 'type' | 'data'>, inPortal = false): DiscoverTarget | null {
  const firstId = slider.data?.split(/[,|]/)[0] ?? '';
  const list = (name: string): DiscoverTarget => ({ to: '/list/$list', params: { list: name } });
  switch (slider.type) {
    case 'trending':
      return { to: '/trending' };
    case 'popularMovies':
      return { to: '/movies' };
    case 'popularTv':
      return { to: '/tv' };
    case 'upcomingMovies':
      return list('upcomingMovies');
    case 'upcomingTv':
      return list('upcomingTv');
    case 'nowPlaying':
      return list('nowPlaying');
    case 'topRatedMovies':
      return list('topRatedMovies');
    case 'topRatedTv':
      return list('topRatedTv');
    case 'airingTv':
      return list('onTheAir');
    case 'recentRequests':
      return inPortal ? { to: '/requests' } : null;
    case 'tmdbMovieKeyword':
    case 'tmdbTvKeyword':
      return firstId ? { to: '/keyword/$id', params: { id: firstId }, search: { mediaType: slider.type === 'tmdbMovieKeyword' ? 'movie' : 'tv' } } : null;
    case 'tmdbMovieGenre':
    case 'tmdbTvGenre':
      return firstId ? { to: '/genre/$id', params: { id: firstId }, search: { mediaType: slider.type === 'tmdbMovieGenre' ? 'movie' : 'tv' } } : null;
    case 'tmdbStudio':
      return firstId ? { to: '/studio/$id', params: { id: firstId } } : null;
    case 'tmdbNetwork':
      return firstId ? { to: '/network/$id', params: { id: firstId } } : null;
    case 'tmdbSearch':
      return slider.data ? { to: '/search', search: { q: slider.data } } : null;
    default:
      return null;
  }
}
