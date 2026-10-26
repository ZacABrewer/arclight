import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { QueryClientProvider } from '@tanstack/react-query';
import { RouterProvider, createMemoryHistory, createRouter } from '@tanstack/react-router';
import { DiscoverPage, PublicPortal, type PortalDocument } from '@arclight/shared';
import { authRoutes, makeItem, makeTitle, renderAt, stubApi, user } from '../../features/requests/test-utils.js';
import { portalLoginOptions, portalSection, portalUnavailable, titlePath } from './portal-page.js';
import { ApiError } from '../../api/client.js';
import { ToastProvider } from '../../components/toast.js';
import { createToastStore } from '../../lib/toast.js';
import { createQueryClient } from '../../query-client.js';
import { routeTree } from '../../router.js';
import { portalRewrite } from '../../features/discover/portal-location.js';

afterEach(() => vi.unstubAllGlobals());

const anonymous = { '/api/v1/auth/status': { needsSetup: false, adminExists: true, authMethod: 'forms', authenticated: false, session: null } };
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
const slider = (id: number, type: string, order: number) => ({
  id,
  type,
  order,
  isBuiltIn: true,
  enabled: true,
  title: null,
  data: null,
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
});

/** Renders the app as the server would serve it for a portal path or hostname. */
function renderPortalDocument(path: string, doc: PortalDocument) {
  const toasts = createToastStore();
  const queryClient = createQueryClient(toasts);
  const rewrite = portalRewrite(doc);
  const router = createRouter({ routeTree, context: { queryClient, portal: doc }, history: createMemoryHistory({ initialEntries: [path] }), ...(rewrite ? { rewrite } : {}) });
  render(
    <QueryClientProvider client={queryClient}>
      <ToastProvider store={toasts}>
        <RouterProvider router={router} />
      </ToastProvider>
    </QueryClientProvider>,
  );
  return { router };
}

describe('portal helpers', () => {
  it('lists login methods, builds title paths, classifies failures and picks the nav section', () => {
    expect(portalLoginOptions({ local: true, mediaServer: { kind: 'jellyfin', name: 'Living room' }, plex: false }).map((o) => o.label)).toEqual([
      'Sign in with your account',
      'Sign in with Living room',
    ]);
    expect(portalLoginOptions({ local: true, mediaServer: { kind: 'plex' }, plex: true }).map((o) => o.id)).toEqual(['local', 'plex']);
    expect(titlePath({ mediaType: 'series', tmdbId: 1399 })).toBe('/discover/tv/1399');
    expect(portalUnavailable(new ApiError(404, 'not found', '/public/portal'))).toBe('off');
    expect(portalUnavailable(new ApiError(500, 'boom', '/public/portal'))).toBe('error');
    expect(portalSection('/portal')).toBe('');
    expect(portalSection('/portal/tv')).toBe('/tv');
    expect(portalSection('/portal/tv/1399')).toBe('/movies');
    expect(portalSection('/portal/requests')).toBe('/requests');
  });
});

describe('/portal', () => {
  it('renders for anonymous visitors without the app shell: branding, message, sign-in and the Discover sliders', async () => {
    stubApi({
      ...anonymous,
      '/api/v1/public/portal': portal(),
      '/api/v1/discoverslider': [slider(1, 'popularMovies', 0)],
      '/api/v1/discover/slider/1': discoverPage([makeItem(), makeItem({ tmdbId: 1399, mediaType: 'series', title: 'Game of Thrones', year: 2011 })]),
    });
    const { router } = renderAt('/portal');
    expect(await screen.findByRole('heading', { name: 'Arclight', level: 1 })).toBeTruthy();
    expect(router.state.location.pathname).toBe('/portal');
    expect(screen.queryByRole('navigation', { name: /main/i })).toBeNull();
    expect(screen.getByText(/New titles land on Fridays/)).toBeTruthy();
    const logins = screen.getByRole('list', { name: 'Sign-in methods' });
    expect(within(logins).getByRole('link', { name: 'Sign in with Living room' }).getAttribute('href')).toBe('/login?redirect=%2Fportal');
    // Posters open the portal's own title pages; "See all" stays in the portal.
    const row = await screen.findByRole('region', { name: 'Popular movies' });
    const card = await within(row).findByRole('article', { name: 'Game of Thrones' });
    expect(within(card).getAllByRole('link')[0]!.getAttribute('href')).toBe('/portal/tv/1399');
    expect(within(row).getByRole('link', { name: 'See all' }).getAttribute('href')).toBe('/portal/movies');
    // Nav: no "My requests" for anonymous visitors.
    expect(within(screen.getByRole('navigation', { name: 'Portal' })).queryByRole('link', { name: 'My requests' })).toBeNull();
  });

  it('shows anonymous visitors a title page with "Sign in to request" and portal links', async () => {
    stubApi({
      ...anonymous,
      '/api/v1/public/portal': portal(),
      '/api/v1/discover/movie/603': makeTitle({ canRequest: false, genres: [{ id: 28, name: 'Action' }], collection: { id: 2344, name: 'The Matrix Collection' } }),
    });
    renderAt('/portal/movie/603');
    const signIn = await screen.findByRole('link', { name: 'Sign in to request' });
    expect(signIn.getAttribute('href')).toBe('/login?redirect=%2Fportal%2Fmovie%2F603');
    expect(screen.queryByRole('button', { name: 'Request' })).toBeNull();
    expect(screen.getByRole('link', { name: 'Action' }).getAttribute('href')).toBe('/portal/genre/28?mediaType=movie');
    expect(screen.getByRole('link', { name: 'View collection' }).getAttribute('href')).toBe('/portal/collection/2344');
    expect(screen.queryByRole('link', { name: /Open in library|Manage/ })).toBeNull();
  });

  it('keeps the catalogue behind sign-in when anonymous browsing is off, and says when the portal is off', async () => {
    const calls = stubApi({ ...anonymous, '/api/v1/public/portal': portal({ allowAnonymousDiscover: false, message: '' }) });
    renderAt('/portal/movies');
    expect(await screen.findByText('Sign in to browse and request titles.')).toBeTruthy();
    await waitFor(() => expect(calls.some((c) => c.url.includes('/discover/'))).toBe(false));

    cleanup();
    vi.unstubAllGlobals();
    stubApi({ ...anonymous });
    renderAt('/portal');
    expect(await screen.findByText('The request portal is off')).toBeTruthy();
  });

  it('gives signed-in users My requests and a type-ahead search that stays in the portal', async () => {
    stubApi(
      {
        ...authRoutes(user()),
        '/api/v1/public/portal': portal({ allowAnonymousDiscover: false }),
        '/api/v1/discoverslider': [],
        '/api/v1/discover/search/people': { page: 1, totalPages: 1, totalResults: 0, results: [] },
      },
      (url) => (url.startsWith('/api/v1/discover/search?') ? { body: discoverPage([makeItem({ tmdbId: 438631, title: 'Dune', year: 2021 })]) } : undefined),
    );
    const { router } = renderAt('/portal');
    // A portal user has no app pages: no way into the app, but their account and issues are here.
    expect(await screen.findAllByRole('link', { name: 'Account' })).not.toHaveLength(0);
    expect(screen.queryByRole('link', { name: 'Open Arclight' })).toBeNull();
    expect(within(screen.getByRole('navigation', { name: 'Portal' })).getByRole('link', { name: 'My requests' }).getAttribute('href')).toBe('/portal/requests');
    const box = screen.getAllByRole('combobox', { name: 'Search movies, series and people' })[0]!;
    fireEvent.focus(box);
    fireEvent.change(box, { target: { value: 'dune' } });
    const option = await screen.findByRole('option', { name: /Dune/ }, { timeout: 4000 });
    fireEvent.click(option);
    await waitFor(() => expect(router.state.location.pathname).toBe('/portal/movie/438631'));
  });
});

describe('portal paths and hostnames', () => {
  it('maps a custom portal path onto the portal routes and keeps links on that path', async () => {
    stubApi({
      ...anonymous,
      '/api/v1/public/portal': portal(),
      '/api/v1/discover/movie/603': makeTitle({ canRequest: false, genres: [{ id: 28, name: 'Action' }] }),
    });
    const { router } = renderPortalDocument('/ajkdlfjla/movie/603', { mode: 'path', base: '/ajkdlfjla' });
    expect(await screen.findByRole('link', { name: 'Action' })).toBeTruthy();
    expect(router.state.location.pathname).toBe('/portal/movie/603');
    expect(screen.getByRole('link', { name: 'Action' }).getAttribute('href')).toBe('/ajkdlfjla/genre/28?mediaType=movie');
    expect(screen.getByRole('link', { name: 'Sign in to request' }).getAttribute('href')).toBe('/login?redirect=%2Fportal%2Fmovie%2F603');
  });

  it('serves the portal at the root of a portal hostname and keeps portal-only hosts out of the app', async () => {
    stubApi({ ...authRoutes(user({ role: 'admin' })), '/api/v1/public/portal': portal(), '/api/v1/discoverslider': [] });
    const { router } = renderPortalDocument('/settings/general', { mode: 'host', portalOnly: true });
    expect(await screen.findByRole('heading', { name: 'Arclight', level: 1 })).toBeTruthy();
    await waitFor(() => expect(router.state.location.pathname).toBe('/portal'));
    expect(within(screen.getByRole('navigation', { name: 'Portal' })).getByRole('link', { name: 'Movies' }).getAttribute('href')).toBe('/movies');
    // Portal-only: no way back into the admin app from here.
    expect(screen.queryByRole('link', { name: 'Open Arclight' })).toBeNull();
  });
});
