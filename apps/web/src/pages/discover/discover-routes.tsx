import type { ReactNode } from 'react';
import { createRoute, type AnyRoute } from '@tanstack/react-router';
import { DiscoverGenrePage, DiscoverKeywordPage, DiscoverMoviesPage, DiscoverNetworkPage, DiscoverProviderPage, DiscoverStudioPage, DiscoverTvPage, parseBrowseRouteSearch } from './discover-browse.js';
import { CollectionPage } from './collection-page.js';
import { DiscoverListPage, DiscoverTrendingPage, DiscoverUpcomingPage, parseKindSearch, parseTrendingSearch } from './discover-lists.js';
import { DiscoverSearchPage, parseSearchParams } from './discover-search.js';
import { PersonPage } from './person-page.js';
import { MovieTitlePage, TvTitlePage } from './title-page.js';

// The Discover sub-routes, mounted twice: under /discover in the app and under /portal for the
// request portal (features/discover/base.tsx resolves links against the tree a page is in).
// Keep these in step with DiscoverPath and with PORTAL_ROUTE_SEGMENTS in packages/shared.

export function discoverChildren<TParent extends AnyRoute>(getParentRoute: () => TParent, Home: () => ReactNode) {
  return [
    createRoute({ getParentRoute, path: '/', component: Home }),
    createRoute({ getParentRoute, path: 'movies', validateSearch: parseBrowseRouteSearch, component: DiscoverMoviesPage }),
    createRoute({ getParentRoute, path: 'tv', validateSearch: parseBrowseRouteSearch, component: DiscoverTvPage }),
    createRoute({ getParentRoute, path: 'trending', validateSearch: parseTrendingSearch, component: DiscoverTrendingPage }),
    createRoute({ getParentRoute, path: 'upcoming', validateSearch: parseKindSearch, component: DiscoverUpcomingPage }),
    createRoute({ getParentRoute, path: 'list/$list', component: DiscoverListPage }),
    createRoute({ getParentRoute, path: 'search', validateSearch: parseSearchParams, component: DiscoverSearchPage }),
    createRoute({ getParentRoute, path: 'movie/$tmdbId', component: MovieTitlePage }),
    createRoute({ getParentRoute, path: 'tv/$tmdbId', component: TvTitlePage }),
    createRoute({ getParentRoute, path: 'person/$id', component: PersonPage }),
    createRoute({ getParentRoute, path: 'collection/$id', component: CollectionPage }),
    createRoute({ getParentRoute, path: 'genre/$id', validateSearch: parseBrowseRouteSearch, component: DiscoverGenrePage }),
    createRoute({ getParentRoute, path: 'keyword/$id', validateSearch: parseBrowseRouteSearch, component: DiscoverKeywordPage }),
    createRoute({ getParentRoute, path: 'studio/$id', validateSearch: parseBrowseRouteSearch, component: DiscoverStudioPage }),
    createRoute({ getParentRoute, path: 'network/$id', validateSearch: parseBrowseRouteSearch, component: DiscoverNetworkPage }),
    createRoute({ getParentRoute, path: 'provider/$id', validateSearch: parseBrowseRouteSearch, component: DiscoverProviderPage }),
  ] as const;
}
