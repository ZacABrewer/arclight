import { describe, expect, it, vi } from 'vitest';
import type { DiscoverItem, MediaRequest } from '@arclight/shared';
import { ApiError } from '../core/api';
import {
  DISCOVER_ROWS,
  discoverRowQuery,
  discoverState,
  discoverTitlePath,
  libraryTarget,
  requestable,
  requestBody,
  requestErrorText,
  requestStateKey,
  requestTone,
  stateTone,
} from './requests';
import { cancellable, requestSub } from './screens/requests';
import { discoverSub } from './screens/discover';

// Discover / Requests on the TV: what a tile's badge says, what a request asks for, and how a
// refused request reads.

vi.mock('@web/api/requests', () => ({
  kindOf: (m: 'movie' | 'series') => (m === 'movie' ? 'movie' : 'tv'),
  discoverApi: { trending: vi.fn(), movies: vi.fn(), tv: vi.fn(), upcoming: vi.fn(), search: vi.fn(), title: vi.fn() },
  requestsApi: { list: vi.fn(), create: vi.fn(), remove: vi.fn() },
}));

const t = (key: string, vars?: Record<string, unknown>) => (vars ? `${key}:${Object.values(vars).join(',')}` : key);

function item(over: Partial<DiscoverItem> = {}): DiscoverItem {
  return {
    mediaType: 'movie',
    tmdbId: 100,
    title: 'Example',
    year: 2026,
    overview: '',
    posterUrl: null,
    backdropUrl: null,
    mediaStatus: 'unknown',
    mediaStatus4k: 'unknown',
    requestId: null,
    requestStatus: null,
    libraryId: null,
    ...over,
  } as DiscoverItem;
}

describe('discoverState', () => {
  it('lets availability win over the request', () => {
    expect(discoverState(item({ mediaStatus: 'available', requestStatus: 'pending' }))).toBe('available');
    expect(discoverState(item({ mediaStatus: 'partiallyAvailable' }))).toBe('partial');
    expect(discoverState(item({ mediaStatus: 'processing' }))).toBe('processing');
    expect(discoverState(item({ mediaStatus: 'pending' }))).toBe('requested');
  });

  it('falls back to the newest request, and to nothing', () => {
    expect(discoverState(item({ requestStatus: 'pending' }))).toBe('requested');
    expect(discoverState(item({ requestStatus: 'approved' }))).toBe('processing');
    expect(discoverState(item({ requestStatus: 'declined' }))).toBe('declined');
    expect(discoverState(item())).toBeNull();
  });

  it('colours the badge by state', () => {
    expect(stateTone('available')).toBe('accent');
    expect(stateTone('partial')).toBe('accent');
    expect(stateTone('requested')).toBe('warn');
    expect(stateTone('processing')).toBe('warn');
    expect(stateTone('declined')).toBe('danger');
    expect(stateTone(null)).toBeNull();
  });
});

describe('libraryTarget / requestable', () => {
  it('opens a title only when it is in the Arclight library', () => {
    expect(libraryTarget(item({ mediaStatus: 'available', libraryId: 7 }))).toEqual({ kind: 'movie', id: 7 });
    expect(libraryTarget(item({ mediaType: 'series', mediaStatus: 'partiallyAvailable', libraryId: 11 }))).toEqual({ kind: 'series', id: 11 });
    // On the media server only: nothing to open.
    expect(libraryTarget(item({ mediaStatus: 'available', libraryId: 0 }))).toBeNull();
    expect(libraryTarget(item({ mediaStatus: 'pending', libraryId: 7 }))).toBeNull();
  });

  it('offers Request for new, declined and partly-there titles only', () => {
    expect(requestable(item())).toBe(true);
    expect(requestable(item({ requestStatus: 'declined' }))).toBe(true);
    expect(requestable(item({ mediaStatus: 'partiallyAvailable' }))).toBe(true);
    expect(requestable(item({ mediaStatus: 'available' }))).toBe(false);
    expect(requestable(item({ requestStatus: 'pending' }))).toBe(false);
    expect(requestable(item({ mediaStatus: 'processing' }))).toBe(false);
  });
});

describe('requestBody / paths / rows', () => {
  it('asks for every season of a show, and just the movie', () => {
    expect(requestBody('movie', 603)).toEqual({ mediaType: 'movie', tmdbId: 603 });
    expect(requestBody('series', 1399)).toEqual({ mediaType: 'series', tmdbId: 1399, seasons: 'all' });
  });

  it('builds the title path from the media type', () => {
    expect(discoverTitlePath('movie', 603)).toBe('/player/discover/movie/603');
    expect(discoverTitlePath('series', 1399)).toBe('/player/discover/tv/1399');
  });

  it('gives every row its own query key', () => {
    const keys = DISCOVER_ROWS.map((r) => JSON.stringify(discoverRowQuery(r).queryKey));
    expect(new Set(keys).size).toBe(DISCOVER_ROWS.length);
  });
});

describe('requestErrorText', () => {
  it('turns a quota refusal into the TV sentence', () => {
    expect(requestErrorText(new ApiError(403, 'Movie Quota exceeded.', '/request', 'FORBIDDEN'), t)).toBe('app.tv.request.quota');
    expect(requestErrorText(new ApiError(403, 'Series Quota exceeded.', '/request'), t)).toBe('app.tv.request.quota');
  });

  it('says when the account may not request', () => {
    expect(requestErrorText(new ApiError(403, 'not allowed to request series', '/request'), t)).toBe('app.tv.request.notAllowed');
    expect(requestErrorText(new ApiError(403, 'profile-forbidden', '/request'), t)).toBe('app.tv.request.notAllowed');
  });

  it("shows the server's message for anything else", () => {
    expect(requestErrorText(new ApiError(409, 'this movie already has an active request (#4)', '/request'), t)).toBe(
      'app.tv.request.failed:this movie already has an active request (#4)',
    );
  });
});

function req(over: Partial<MediaRequest> = {}): MediaRequest {
  return {
    id: 1,
    type: 'movie',
    status: 'pending',
    mediaTmdbId: 100,
    mediaTitle: 'Example',
    mediaYear: 2026,
    mediaPoster: null,
    mediaBackdrop: null,
    seasons: [],
    createdAt: '2026-10-01T00:00:00.000Z',
    mediaStatus: 'pending',
    libraryId: null,
    canRemove: true,
    declineReason: null,
    ...over,
  } as MediaRequest;
}

describe('My requests rows', () => {
  it('says where each request stands', () => {
    expect(requestStateKey(req())).toBe('app.tv.requests.status.pending');
    expect(requestStateKey(req({ status: 'approved', mediaStatus: 'processing' }))).toBe('app.tv.requests.status.processing');
    expect(requestStateKey(req({ status: 'approved', mediaStatus: 'available' }))).toBe('app.tv.requests.status.available');
    expect(requestStateKey(req({ status: 'approved', mediaStatus: 'partiallyAvailable' }))).toBe('app.tv.requests.status.partial');
    expect(requestStateKey(req({ status: 'declined' }))).toBe('app.tv.requests.status.declined');
    expect(requestStateKey(req({ status: 'failed' }))).toBe('app.tv.requests.status.failed');
    expect(requestTone(req())).toBe('warn');
    expect(requestTone(req({ status: 'completed', mediaStatus: 'available' }))).toBe('accent');
    expect(requestTone(req({ status: 'declined' }))).toBe('danger');
  });

  it('offers Cancel on pending requests the server lets you remove', () => {
    expect(cancellable(req())).toBe(true);
    expect(cancellable(req({ canRemove: false }))).toBe(false);
    expect(cancellable(req({ status: 'approved' }))).toBe(false);
  });

  it('lists kind, year and the seasons asked for', () => {
    expect(requestSub(req(), t)).toBe('app.tv.movie · 2026');
    expect(requestSub(req({ type: 'series', seasons: [{ seasonNumber: 1, status: 'pending' }, { seasonNumber: 2, status: 'pending' }] as MediaRequest['seasons'] }), t)).toBe(
      'app.tv.series · 2026 · app.tv.requests.seasons:1, 2',
    );
    expect(discoverSub({ mediaType: 'series', year: null }, t)).toBe('app.tv.series');
  });
});
