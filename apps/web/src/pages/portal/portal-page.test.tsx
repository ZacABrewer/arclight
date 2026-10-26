import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { DiscoverPage, PublicPortal } from '@arclight/shared';
import { authRoutes, makeItem, renderAt, stubApi, user } from '../../features/requests/test-utils.js';
import { portalLoginOptions, portalUnavailable, titlePath } from './portal-page.js';
import { ApiError } from '../../api/client.js';

afterEach(() => vi.unstubAllGlobals());

const anonymous = { '/api/v1/auth/status': { needsSetup: false, authMethod: 'forms', authenticated: false, session: null } };
const portal = (over: Partial<PublicPortal> = {}): PublicPortal =>
  PublicPortal.parse({
    enabled: true,
    title: 'Arclight',
    applicationUrl: 'https://media.example.com',
    message: 'Ask for anything.\nNew titles land on Fridays.',
    allowAnonymousDiscover: true,
    loginMethods: { local: true, mediaServer: { kind: 'jellyfin', name: 'Living room' }, plex: false },
    ...over,
  });
const discoverPage = (items: ReturnType<typeof makeItem>[]) => DiscoverPage.parse({ page: 1, totalPages: 1, totalResults: items.length, results: items });

describe('portal helpers', () => {
  it('lists login methods, builds title paths and classifies failures', () => {
    expect(portalLoginOptions({ local: true, mediaServer: { kind: 'jellyfin', name: 'Living room' }, plex: false }).map((o) => o.label)).toEqual([
      'Sign in with your account',
      'Sign in with Living room',
    ]);
    expect(portalLoginOptions({ local: true, mediaServer: { kind: 'plex' }, plex: true }).map((o) => o.id)).toEqual(['local', 'plex']);
    expect(titlePath({ mediaType: 'series', tmdbId: 1399 })).toBe('/discover/tv/1399');
    expect(portalUnavailable(new ApiError(404, 'not found', '/public/portal'))).toBe('off');
    expect(portalUnavailable(new ApiError(500, 'boom', '/public/portal'))).toBe('error');
  });
});

describe('/portal', () => {
  it('renders for anonymous visitors without the app shell: branding, message, sign-in and trending', async () => {
    const calls = stubApi({
      ...anonymous,
      '/api/v1/public/portal': portal(),
      '/api/v1/discover/trending': discoverPage([makeItem(), makeItem({ tmdbId: 1399, mediaType: 'series', title: 'Game of Thrones', year: 2011 })]),
    });
    const { router } = renderAt('/portal');
    expect(await screen.findByRole('heading', { name: 'Arclight', level: 1 })).toBeTruthy();
    expect(router.state.location.pathname).toBe('/portal');
    expect(screen.queryByRole('navigation', { name: /main/i })).toBeNull();
    expect(screen.getByText(/New titles land on Fridays/)).toBeTruthy();
    const logins = screen.getByRole('list', { name: 'Sign-in methods' });
    expect(within(logins).getByRole('link', { name: 'Sign in with Living room' }).getAttribute('href')).toBe('/login');
    const card = await screen.findByRole('link', { name: 'Sign in to request Game of Thrones' });
    expect(card.getAttribute('href')).toBe('/login?redirect=%2Fdiscover%2Ftv%2F1399');
    expect(calls.find((c) => c.url.startsWith('/api/v1/discover/trending'))?.url).toContain('timeWindow=week');
  });

  it('searches anonymously and reports rate limiting', async () => {
    stubApi({ ...anonymous, '/api/v1/public/portal': portal(), '/api/v1/discover/trending': discoverPage([]) }, (url) => {
      if (url.startsWith('/api/v1/discover/search') && url.includes('query=dune')) return { body: discoverPage([makeItem({ tmdbId: 438631, title: 'Dune', year: 2021 })]) };
      if (url.startsWith('/api/v1/discover/search')) return { status: 429, body: { error: 'slow down', code: 'RATE_LIMITED' } };
      return undefined;
    });
    renderAt('/portal');
    const search = await screen.findByLabelText('Search movies and series');
    fireEvent.change(search, { target: { value: 'dune' } });
    fireEvent.click(screen.getByRole('button', { name: 'Search' }));
    expect(await screen.findByRole('link', { name: 'Sign in to request Dune' })).toBeTruthy();
    expect(screen.getByRole('region', { name: 'Browse titles' }).textContent).toContain('Results for dune');
    fireEvent.change(search, { target: { value: 'alien' } });
    fireEvent.click(screen.getByRole('button', { name: 'Search' }));
    expect(await screen.findByText(/Too many requests from this address/)).toBeTruthy();
  });

  it('hides discover when anonymous browsing is off and says when the portal is off', async () => {
    const calls = stubApi({ ...anonymous, '/api/v1/public/portal': portal({ allowAnonymousDiscover: false, message: '' }) });
    renderAt('/portal');
    expect(await screen.findByText('Sign in to browse and request titles.')).toBeTruthy();
    expect(screen.getByText('Sign in to request movies and series.')).toBeTruthy();
    await waitFor(() => expect(calls.some((c) => c.url.includes('/discover/'))).toBe(false));

    cleanup();
    vi.unstubAllGlobals();
    stubApi({ ...anonymous });
    renderAt('/portal');
    expect(await screen.findByText('The request portal is off')).toBeTruthy();
  });

  it('lets signed-in users browse with links to title pages', async () => {
    stubApi({ ...authRoutes(user()), '/api/v1/public/portal': portal({ allowAnonymousDiscover: false }), '/api/v1/discover/trending': discoverPage([makeItem()]) });
    renderAt('/portal');
    expect(await screen.findByRole('link', { name: 'Open Arclight' })).toBeTruthy();
    const link = await screen.findByRole('link', { name: /The Matrix/ });
    expect(link.getAttribute('href')).toBe('/discover/movie/603');
  });
});
