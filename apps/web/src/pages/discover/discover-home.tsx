import { useState } from 'react';
import { Link, useNavigate } from '@tanstack/react-router';
import { POPULAR_NETWORKS, POPULAR_STUDIOS, type DiscoverSlider } from '@media-tron/shared';
import { Card } from '../../components/card.js';
import { EmptyState } from '../../components/empty-state.js';
import { ErrorView } from '../../components/error-boundary.js';
import { Input } from '../../components/form.js';
import { Page } from '../../components/page.js';
import { LoadingBlock, Spinner } from '../../components/spinner.js';
import { DiscoverRow } from '../../features/requests/discover-ui.js';
import { SLIDER_LABELS } from '../../features/requests/status.js';
import { useDiscoverGenres, useSliderItems, useSliders } from '../../hooks/requests.js';
import type { DiscoverKind } from '../../api/requests.js';

export function sliderTitle(slider: Pick<DiscoverSlider, 'title' | 'type'>): string {
  return slider.title ?? SLIDER_LABELS[slider.type];
}

export function DiscoverHomePage() {
  const sliders = useSliders();
  const navigate = useNavigate();
  const [term, setTerm] = useState('');

  return (
    <Page
      title="Discover"
      actions={
        <form
          role="search"
          onSubmit={(e) => {
            e.preventDefault();
            if (term.trim()) void navigate({ to: '/discover/search', search: { q: term.trim() } });
          }}
        >
          <Input type="search" aria-label="Search movies and series" placeholder="Search movies and series" value={term} onChange={(e) => setTerm(e.target.value)} />
        </form>
      }
    >
      {sliders.isPending ? (
        <LoadingBlock />
      ) : sliders.isError ? (
        <ErrorView error={sliders.error} onRetry={() => void sliders.refetch()} />
      ) : sliders.data.filter((s) => s.enabled).length === 0 ? (
        <Card>
          <EmptyState title="No sliders enabled">
            <p className="muted">An admin can enable sliders in Settings → Requests.</p>
          </EmptyState>
        </Card>
      ) : (
        [...sliders.data]
          .filter((s) => s.enabled)
          .sort((a, b) => a.order - b.order)
          .map((s) => <SliderSection key={s.id} slider={s} />)
      )}
    </Page>
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
            <Link key={s.id} className="genre-chip" to="/discover/studio/$id" params={{ id: String(s.id) }}>
              {s.name}
            </Link>
          ))}
        </ChipSection>
      );
    case 'networks':
      return (
        <ChipSection title={sliderTitle(slider)}>
          {POPULAR_NETWORKS.map((n) => (
            <Link key={n.id} className="genre-chip" to="/discover/network/$id" params={{ id: String(n.id) }}>
              {n.name}
            </Link>
          ))}
        </ChipSection>
      );
    default:
      return <ItemSlider slider={slider} />;
  }
}

function ChipSection({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="discover-section">
      <div className="discover-section-head">
        <h2 className="discover-section-title">{title}</h2>
      </div>
      <div className="genre-chips">{children}</div>
    </section>
  );
}

function GenreChips({ kind, title }: { kind: DiscoverKind; title: string }) {
  const genres = useDiscoverGenres(kind);
  return (
    <ChipSection title={title}>
      {genres.isPending ? (
        <Spinner inline size="sm" label="Loading genres" />
      ) : genres.isError ? (
        <span className="muted">Genres are unavailable.</span>
      ) : (
        genres.data.map((g) => (
          <Link key={g.id} className="genre-chip" to="/discover/genre/$id" params={{ id: String(g.id) }} search={{ mediaType: kind }}>
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

function SeeAll({ slider }: { slider: DiscoverSlider }) {
  const firstId = slider.data?.split(/[,|]/)[0] ?? '';
  switch (slider.type) {
    case 'trending':
      return <Link className="link-subtle" to="/discover/trending">See all</Link>;
    case 'popularMovies':
      return <Link className="link-subtle" to="/discover/movies">See all</Link>;
    case 'popularTv':
      return <Link className="link-subtle" to="/discover/tv">See all</Link>;
    case 'upcomingMovies':
      return <Link className="link-subtle" to="/discover/upcoming" search={{ mediaType: 'movie' }}>See all</Link>;
    case 'upcomingTv':
      return <Link className="link-subtle" to="/discover/upcoming" search={{ mediaType: 'tv' }}>See all</Link>;
    case 'watchlist':
      return <Link className="link-subtle" to="/watchlist">See all</Link>;
    case 'recentRequests':
      return <Link className="link-subtle" to="/requests">See all</Link>;
    case 'tmdbMovieKeyword':
    case 'tmdbTvKeyword':
      return firstId ? (
        <Link className="link-subtle" to="/discover/keyword/$id" params={{ id: firstId }} search={{ mediaType: slider.type === 'tmdbMovieKeyword' ? 'movie' : 'tv' }}>
          See all
        </Link>
      ) : null;
    case 'tmdbMovieGenre':
    case 'tmdbTvGenre':
      return firstId ? (
        <Link className="link-subtle" to="/discover/genre/$id" params={{ id: firstId }} search={{ mediaType: slider.type === 'tmdbMovieGenre' ? 'movie' : 'tv' }}>
          See all
        </Link>
      ) : null;
    case 'tmdbStudio':
      return firstId ? <Link className="link-subtle" to="/discover/studio/$id" params={{ id: firstId }}>See all</Link> : null;
    case 'tmdbNetwork':
      return firstId ? <Link className="link-subtle" to="/discover/network/$id" params={{ id: firstId }}>See all</Link> : null;
    case 'tmdbSearch':
      return slider.data ? <Link className="link-subtle" to="/discover/search" search={{ q: slider.data }}>See all</Link> : null;
    default:
      return null;
  }
}
