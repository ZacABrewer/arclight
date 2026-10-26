import type { IssueListQuery, RequestListQuery } from '@arclight/shared';
import type { DiscoverKind } from '../api/requests.js';

// Query keys for requests, discover, issues and watchlists. live.ts invalidates the
// first-segment families on `request` and `issue` events. Requests settings live under
// ['settings'] so a `settings` event refreshes them like every other settings section.
export const requestKeys = {
  requests: {
    all: ['requests'] as const,
    lists: ['requests', 'list'] as const,
    list: (query: RequestListQuery) => ['requests', 'list', query] as const,
    count: ['requests', 'count'] as const,
    detail: (id: number) => ['requests', 'detail', id] as const,
  },
  discover: {
    all: ['discover'] as const,
    titles: ['discover', 'title'] as const,
    title: (kind: DiscoverKind, tmdbId: number) => ['discover', 'title', kind, tmdbId] as const,
    list: (source: string, params: unknown) => ['discover', 'list', source, params] as const,
    genres: (kind: DiscoverKind) => ['discover', 'genres', kind] as const,
    person: (id: number) => ['discover', 'person', id] as const,
    slider: (id: number) => ['discover', 'slider', id] as const,
  },
  sliders: ['discoverslider'] as const,
  issues: {
    all: ['issues'] as const,
    list: (query: IssueListQuery) => ['issues', 'list', query] as const,
    count: ['issues', 'count'] as const,
    detail: (id: number) => ['issues', 'detail', id] as const,
  },
  overrideRules: ['overriderule'] as const,
  watchlist: {
    all: ['watchlist'] as const,
    list: (userId: number | undefined) => ['watchlist', 'list', userId ?? 'me'] as const,
  },
  users: {
    all: ['requestusers'] as const,
    permissions: (id: number) => ['requestusers', id, 'permissions'] as const,
    quota: (id: number) => ['requestusers', id, 'quota'] as const,
    settings: (id: number) => ['requestusers', id, 'settings'] as const,
  },
  settings: ['settings', 'requests'] as const,
};
