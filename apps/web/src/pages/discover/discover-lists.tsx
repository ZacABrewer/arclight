import { useCallback, useState } from 'react';
import { getRouteApi, useNavigate } from '@tanstack/react-router';
import type { DiscoverPage } from '@arclight/shared';
import { discoverApi, type DiscoverKind } from '../../api/requests.js';
import type { ReactNode } from 'react';
import { EmptyState, PageHeader, Segmented } from '../../arclight/index.js';
import { DiscoverGrid } from './discover-kit.js';
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
    <Segmented
      aria-label="Media type"
      value={value}
      onChange={onChange}
      options={[
        { value: 'movie', label: 'Movies' },
        { value: 'tv', label: 'Series' },
      ]}
    />
  );
}

/** Page header + grid body; replaces the old Page wrapper. */
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

const genreRoute = getRouteApi('/discover/genre/$id');
export function DiscoverGenrePage() {
  const { id } = genreRoute.useParams();
  const { mediaType } = genreRoute.useSearch();
  const navigate = useNavigate();
  const genres = useDiscoverGenres(mediaType);
  const name = genres.data?.find((g) => g.id === Number(id))?.name ?? `Genre ${id}`;
  const fetchPage = useCallback((page: number) => discoverApi.genre(Number(id), { mediaType, page }), [id, mediaType]);
  return (
    <GridPage
      title={name}
      subtitle={mediaType === 'movie' ? 'Movies' : 'Series'}
      controls={<KindToggle value={mediaType} onChange={(k) => void navigate({ to: '/discover/genre/$id', params: { id }, search: { mediaType: k } })} />}
    >
      <DiscoverGrid queryKey={requestKeys.discover.list('genre', { id, mediaType })} fetchPage={fetchPage} />
    </GridPage>
  );
}

const keywordRoute = getRouteApi('/discover/keyword/$id');
export function DiscoverKeywordPage() {
  const { id } = keywordRoute.useParams();
  const { mediaType } = keywordRoute.useSearch();
  const navigate = useNavigate();
  const fetchPage = useCallback((page: number) => discoverApi.keyword(Number(id), { mediaType, page }), [id, mediaType]);
  return (
    <GridPage
      title={`Keyword ${id}`}
      controls={<KindToggle value={mediaType} onChange={(k) => void navigate({ to: '/discover/keyword/$id', params: { id }, search: { mediaType: k } })} />}
    >
      <DiscoverGrid queryKey={requestKeys.discover.list('keyword', { id, mediaType })} fetchPage={fetchPage} />
    </GridPage>
  );
}

/** Studio and network pages take their title from the first page (`title`). */
function NamedGrid({ source, id, fallback, fetch }: { source: string; id: string; fallback: string; fetch: (id: number, page: number) => Promise<DiscoverPage> }) {
  const [title, setTitle] = useState<string | null>(null);
  const fetchPage = useCallback((page: number) => fetch(Number(id), page), [fetch, id]);
  const onFirstPage = useCallback((p: DiscoverPage) => setTitle(p.title ?? null), []);
  return (
    <GridPage title={title ?? fallback}>
      <DiscoverGrid queryKey={requestKeys.discover.list(source, { id })} fetchPage={fetchPage} onFirstPage={onFirstPage} />
    </GridPage>
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
    <GridPage
      title="Trending"
      controls={
        <>
          <Segmented
            aria-label="Media type"
            value={mediaType}
            onChange={setMediaType}
            options={[
              { value: 'all', label: 'All' },
              { value: 'movie', label: 'Movies' },
              { value: 'tv', label: 'Series' },
            ]}
          />
          <Segmented
            aria-label="Time window"
            variant="soft"
            value={timeWindow}
            onChange={setTimeWindow}
            options={[
              { value: 'day', label: 'Today' },
              { value: 'week', label: 'This week' },
            ]}
          />
        </>
      }
    >
      <DiscoverGrid queryKey={requestKeys.discover.list('trending', { mediaType, timeWindow })} fetchPage={fetchPage} />
    </GridPage>
  );
}

const upcomingRoute = getRouteApi('/discover/upcoming');
export function DiscoverUpcomingPage() {
  const { mediaType } = upcomingRoute.useSearch();
  const navigate = useNavigate();
  const fetchPage = useCallback((page: number) => discoverApi.upcoming({ mediaType, page }), [mediaType]);
  return (
    <GridPage
      title={mediaType === 'movie' ? 'Upcoming movies' : 'Upcoming series'}
      controls={<KindToggle value={mediaType} onChange={(k) => void navigate({ to: '/discover/upcoming', search: { mediaType: k } })} />}
    >
      <DiscoverGrid queryKey={requestKeys.discover.list('upcoming', { mediaType })} fetchPage={fetchPage} />
    </GridPage>
  );
}

const searchRoute = getRouteApi('/discover/search');
export function DiscoverSearchPage() {
  const { q } = searchRoute.useSearch();
  const fetchPage = useCallback((page: number) => discoverApi.search(q, page), [q]);
  return (
    <GridPage title={q ? `Results for “${q}”` : 'Search'}>
      {q ? <DiscoverGrid queryKey={requestKeys.discover.list('search', { q })} fetchPage={fetchPage} /> : <EmptyState title="Nothing to search for">Type a title in the Discover search box.</EmptyState>}
    </GridPage>
  );
}
