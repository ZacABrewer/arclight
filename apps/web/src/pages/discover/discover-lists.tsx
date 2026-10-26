import { useCallback, useState } from 'react';
import { getRouteApi, useNavigate } from '@tanstack/react-router';
import type { DiscoverPage } from '@media-tron/shared';
import { discoverApi, type DiscoverKind } from '../../api/requests.js';
import { Page } from '../../components/page.js';
import { DiscoverGrid } from '../../features/requests/discover-ui.js';
import { useDiscoverGenres } from '../../hooks/requests.js';
import { requestKeys } from '../../hooks/request-keys.js';

// Grid pages over one discover endpoint each; all reuse DiscoverGrid.

export interface KindSearch {
  mediaType: DiscoverKind;
}

export const parseKindSearch = (search: Record<string, unknown>): KindSearch => ({
  mediaType: search.mediaType === 'tv' ? 'tv' : 'movie',
});

function KindToggle({ value, onChange }: { value: DiscoverKind; onChange: (k: DiscoverKind) => void }) {
  return (
    <div className="segmented" role="group" aria-label="Media type">
      <button type="button" aria-pressed={value === 'movie'} onClick={() => onChange('movie')}>
        Movies
      </button>
      <button type="button" aria-pressed={value === 'tv'} onClick={() => onChange('tv')}>
        Series
      </button>
    </div>
  );
}

const genreRoute = getRouteApi('/discover/genre/$id');
export function DiscoverGenrePage() {
  const { id } = genreRoute.useParams();
  const { mediaType } = genreRoute.useSearch();
  const navigate = useNavigate();
  const genres = useDiscoverGenres(mediaType);
  const name = genres.data?.find((g) => g.id === Number(id))?.name ?? `Genre ${id}`;
  const fetchPage = useCallback((page: number) => discoverApi.genre(Number(id), { mediaType, page }), [id, mediaType]);
  return (
    <Page
      title={name}
      subtitle={mediaType === 'movie' ? 'Movies' : 'Series'}
      actions={<KindToggle value={mediaType} onChange={(k) => void navigate({ to: '/discover/genre/$id', params: { id }, search: { mediaType: k } })} />}
    >
      <DiscoverGrid queryKey={requestKeys.discover.list('genre', { id, mediaType })} fetchPage={fetchPage} />
    </Page>
  );
}

const keywordRoute = getRouteApi('/discover/keyword/$id');
export function DiscoverKeywordPage() {
  const { id } = keywordRoute.useParams();
  const { mediaType } = keywordRoute.useSearch();
  const navigate = useNavigate();
  const fetchPage = useCallback((page: number) => discoverApi.keyword(Number(id), { mediaType, page }), [id, mediaType]);
  return (
    <Page
      title={`Keyword ${id}`}
      actions={<KindToggle value={mediaType} onChange={(k) => void navigate({ to: '/discover/keyword/$id', params: { id }, search: { mediaType: k } })} />}
    >
      <DiscoverGrid queryKey={requestKeys.discover.list('keyword', { id, mediaType })} fetchPage={fetchPage} />
    </Page>
  );
}

/** Studio and network pages take their title from the first page (`title`). */
function NamedGrid({ source, id, fallback, fetch }: { source: string; id: string; fallback: string; fetch: (id: number, page: number) => Promise<DiscoverPage> }) {
  const [title, setTitle] = useState<string | null>(null);
  const fetchPage = useCallback((page: number) => fetch(Number(id), page), [fetch, id]);
  const onFirstPage = useCallback((p: DiscoverPage) => setTitle(p.title ?? null), []);
  return (
    <Page title={title ?? fallback}>
      <DiscoverGrid queryKey={requestKeys.discover.list(source, { id })} fetchPage={fetchPage} onFirstPage={onFirstPage} />
    </Page>
  );
}

const studioRoute = getRouteApi('/discover/studio/$id');
export function DiscoverStudioPage() {
  const { id } = studioRoute.useParams();
  return <NamedGrid key={id} source="studio" id={id} fallback="Studio" fetch={discoverApi.studio} />;
}

const networkRoute = getRouteApi('/discover/network/$id');
export function DiscoverNetworkPage() {
  const { id } = networkRoute.useParams();
  return <NamedGrid key={id} source="network" id={id} fallback="Network" fetch={discoverApi.network} />;
}

export function DiscoverTrendingPage() {
  const [mediaType, setMediaType] = useState<'all' | 'movie' | 'tv'>('all');
  const [timeWindow, setTimeWindow] = useState<'day' | 'week'>('day');
  const fetchPage = useCallback((page: number) => discoverApi.trending({ mediaType, timeWindow, page }), [mediaType, timeWindow]);
  return (
    <Page
      title="Trending"
      actions={
        <div className="row">
          <div className="segmented" role="group" aria-label="Media type">
            {(['all', 'movie', 'tv'] as const).map((m) => (
              <button key={m} type="button" aria-pressed={mediaType === m} onClick={() => setMediaType(m)}>
                {m === 'all' ? 'All' : m === 'movie' ? 'Movies' : 'Series'}
              </button>
            ))}
          </div>
          <div className="segmented" role="group" aria-label="Time window">
            <button type="button" aria-pressed={timeWindow === 'day'} onClick={() => setTimeWindow('day')}>
              Today
            </button>
            <button type="button" aria-pressed={timeWindow === 'week'} onClick={() => setTimeWindow('week')}>
              This week
            </button>
          </div>
        </div>
      }
    >
      <DiscoverGrid queryKey={requestKeys.discover.list('trending', { mediaType, timeWindow })} fetchPage={fetchPage} />
    </Page>
  );
}

const upcomingRoute = getRouteApi('/discover/upcoming');
export function DiscoverUpcomingPage() {
  const { mediaType } = upcomingRoute.useSearch();
  const navigate = useNavigate();
  const fetchPage = useCallback((page: number) => discoverApi.upcoming({ mediaType, page }), [mediaType]);
  return (
    <Page
      title={mediaType === 'movie' ? 'Upcoming movies' : 'Upcoming series'}
      actions={<KindToggle value={mediaType} onChange={(k) => void navigate({ to: '/discover/upcoming', search: { mediaType: k } })} />}
    >
      <DiscoverGrid queryKey={requestKeys.discover.list('upcoming', { mediaType })} fetchPage={fetchPage} />
    </Page>
  );
}

const searchRoute = getRouteApi('/discover/search');
export function DiscoverSearchPage() {
  const { q } = searchRoute.useSearch();
  const fetchPage = useCallback((page: number) => discoverApi.search(q, page), [q]);
  return (
    <Page title={q ? `Results for “${q}”` : 'Search'}>
      {q ? <DiscoverGrid queryKey={requestKeys.discover.list('search', { q })} fetchPage={fetchPage} /> : <p className="muted">Type a title in the Discover search box.</p>}
    </Page>
  );
}
