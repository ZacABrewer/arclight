import { useState, type ReactNode } from 'react';
import { Link, useNavigate } from '@tanstack/react-router';
import { POPULAR_NETWORKS, POPULAR_STUDIOS, type DiscoverSlider } from '@arclight/shared';
import { EmptyState, Input, PageHeader, SectionHead, Skeleton } from '../../arclight/index.js';
import { QueryError } from '../../components/media/media-kit.js';
import { SLIDER_LABELS } from '../../features/requests/status.js';
import { useDiscoverGenres, useSliderItems, useSliders } from '../../hooks/requests.js';
import type { DiscoverKind } from '../../api/requests.js';
import { DiscoverRow } from './discover-kit.js';

export function sliderTitle(slider: Pick<DiscoverSlider, 'title' | 'type'>): string {
  return slider.title ?? SLIDER_LABELS[slider.type];
}

export function DiscoverHomePage() {
  const sliders = useSliders();
  const navigate = useNavigate();
  const [term, setTerm] = useState('');
  const enabled = (sliders.data ?? []).filter((s) => s.enabled).sort((a, b) => a.order - b.order);

  return (
    <>
      <PageHeader
        index="02"
        title="Discover"
        actions={
          <form
            role="search"
            className="mk-search"
            onSubmit={(e) => {
              e.preventDefault();
              if (term.trim()) void navigate({ to: '/discover/search', search: { q: term.trim() } });
            }}
          >
            <Input type="search" aria-label="Search movies and series" placeholder="Search movies and series" value={term} onChange={(e) => setTerm(e.target.value)} />
          </form>
        }
      >
        <nav className="mk-row" aria-label="Browse">
          <Link className="mk-chip-link" to="/discover/movies">
            Movies
          </Link>
          <Link className="mk-chip-link" to="/discover/tv">
            Series
          </Link>
          <Link className="mk-chip-link" to="/discover/trending">
            Trending
          </Link>
        </nav>
      </PageHeader>
      {sliders.isPending ? (
        <Skeleton lines={6} />
      ) : sliders.isError ? (
        <QueryError error={sliders.error} title="Could not load Discover" onRetry={() => void sliders.refetch()} />
      ) : enabled.length === 0 ? (
        <EmptyState title="No sliders enabled">An admin can turn sliders on in Settings → Requests.</EmptyState>
      ) : (
        <div className="mk-stack" style={{ gap: 40 }}>
          {enabled.map((s) => (
            <SliderSection key={s.id} slider={s} />
          ))}
        </div>
      )}
    </>
  );
}

function SliderSection({ slider }: { slider: DiscoverSlider }) {
  switch (slider.type) {
    case 'movieGenres':
      return <GenreChips kind="movie" title={sliderTitle(slider)} />;
    case 'tvGenres':
      return <GenreChips kind="tv" title={sliderTitle(slider)} />;
    case 'studios':
      return (
        <ChipSection title={sliderTitle(slider)}>
          {POPULAR_STUDIOS.map((s) => (
            <Link key={s.id} className="mk-chip-link" to="/discover/studio/$id" params={{ id: String(s.id) }}>
              {s.name}
            </Link>
          ))}
        </ChipSection>
      );
    case 'networks':
      return (
        <ChipSection title={sliderTitle(slider)}>
          {POPULAR_NETWORKS.map((n) => (
            <Link key={n.id} className="mk-chip-link" to="/discover/network/$id" params={{ id: String(n.id) }}>
              {n.name}
            </Link>
          ))}
        </ChipSection>
      );
    default:
      return <ItemSlider slider={slider} />;
  }
}

function ChipSection({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="mk-slider" aria-label={title}>
      <SectionHead label={<h2 className="al-title-m mk-section-title">{title}</h2>} />
      <div className="mk-chip-links">{children}</div>
    </section>
  );
}

function GenreChips({ kind, title }: { kind: DiscoverKind; title: string }) {
  const genres = useDiscoverGenres(kind);
  return (
    <ChipSection title={title}>
      {genres.isPending ? (
        <Skeleton width={320} height={32} />
      ) : genres.isError ? (
        <span className="al-caption">Genres are unavailable. TMDB did not answer.</span>
      ) : (
        genres.data.map((g) => (
          <Link key={g.id} className="mk-chip-link" to="/discover/genre/$id" params={{ id: String(g.id) }} search={{ mediaType: kind }}>
            {g.name}
          </Link>
        ))
      )}
    </ChipSection>
  );
}

function ItemSlider({ slider }: { slider: DiscoverSlider }) {
  const items = useSliderItems(slider.id);
  return <DiscoverRow title={sliderTitle(slider)} items={items.data?.results} loading={items.isPending} error={items.error} action={<SeeAll slider={slider} />} />;
}

export function SeeAll({ slider }: { slider: Pick<DiscoverSlider, 'type' | 'data'> }) {
  const firstId = slider.data?.split(/[,|]/)[0] ?? '';
  switch (slider.type) {
    case 'trending':
      return <Link className="mk-action-link" to="/discover/trending">See all</Link>;
    case 'popularMovies':
      return <Link className="mk-action-link" to="/discover/movies">See all</Link>;
    case 'popularTv':
      return <Link className="mk-action-link" to="/discover/tv">See all</Link>;
    case 'upcomingMovies':
      return <Link className="mk-action-link" to="/discover/upcoming" search={{ mediaType: 'movie' }}>See all</Link>;
    case 'upcomingTv':
      return <Link className="mk-action-link" to="/discover/upcoming" search={{ mediaType: 'tv' }}>See all</Link>;
    case 'watchlist':
      return <Link className="mk-action-link" to="/watchlist">See all</Link>;
    case 'recentRequests':
      return <Link className="mk-action-link" to="/requests">See all</Link>;
    case 'tmdbMovieKeyword':
    case 'tmdbTvKeyword':
      return firstId ? <Link className="mk-action-link" to="/discover/keyword/$id" params={{ id: firstId }} search={{ mediaType: slider.type === 'tmdbMovieKeyword' ? 'movie' : 'tv' }}>See all</Link> : null;
    case 'tmdbMovieGenre':
    case 'tmdbTvGenre':
      return firstId ? <Link className="mk-action-link" to="/discover/genre/$id" params={{ id: firstId }} search={{ mediaType: slider.type === 'tmdbMovieGenre' ? 'movie' : 'tv' }}>See all</Link> : null;
    case 'tmdbStudio':
      return firstId ? <Link className="mk-action-link" to="/discover/studio/$id" params={{ id: firstId }}>See all</Link> : null;
    case 'tmdbNetwork':
      return firstId ? <Link className="mk-action-link" to="/discover/network/$id" params={{ id: firstId }}>See all</Link> : null;
    case 'tmdbSearch':
      return slider.data ? <Link className="mk-action-link" to="/discover/search" search={{ q: slider.data }}>See all</Link> : null;
    default:
      return null;
  }
}
