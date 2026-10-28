import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { QueryClientProvider } from '@tanstack/react-query';
import { RouterProvider, createMemoryHistory, createRootRoute, createRoute, createRouter } from '@tanstack/react-router';
import type { ImportList, ImportListFoundItem, ImportListSchema } from '@arclight/shared';
import { FoundInLists } from '../../../components/media/found-in-lists.js';
import { ToastProvider } from '../../../components/toast.js';
import { createToastStore, type ToastStore } from '../../../lib/toast.js';
import { createQueryClient } from '../../../query-client.js';
import { routeTree } from '../../../router.js';
import { toListBody } from './fields.js';
import { ImportListsPage } from './import-lists-page.js';

class FakeSocket {
  onopen = null;
  onmessage = null;
  onclose = null;
  close() {}
}

const schemas: ImportListSchema[] = [
  {
    implementation: 'tmdbList',
    implementationName: 'TMDB List',
    supportedMediaTypes: ['series', 'movie', 'both'],
    requiresTraktAuth: false,
    fields: [{ name: 'listId', label: 'List id', type: 'text', required: true, secret: false }],
  },
  {
    implementation: 'trakt',
    implementationName: 'Trakt List',
    supportedMediaTypes: ['series', 'movie', 'both'],
    requiresTraktAuth: true,
    fields: [
      { name: 'clientId', label: 'Trakt client id', type: 'text', required: true, secret: false },
      { name: 'clientSecret', label: 'Trakt client secret', type: 'password', required: false, secret: true },
      { name: 'accessToken', label: 'Access token', type: 'password', required: false, secret: true, readOnly: true },
      { name: 'username', label: 'Username', type: 'text', required: true, secret: false },
      { name: 'listName', label: 'List name (slug)', type: 'text', required: true, secret: false },
      { name: 'limit', label: 'Limit', type: 'number', required: false, secret: false, default: 100, min: 1, max: 1000 },
    ],
  },
  {
    implementation: 'stevenLu',
    implementationName: 'StevenLu Popular Movies',
    supportedMediaTypes: ['movie'],
    requiresTraktAuth: false,
    fields: [{ name: 'url', label: 'Feed URL', type: 'url', required: false, secret: false, default: 'https://example.test/movies.json' }],
  },
];

const baseList: ImportList = {
  id: 1,
  name: 'Marvel',
  implementation: 'tmdbList',
  enabled: true,
  enableAutomaticAdd: true,
  searchOnAdd: false,
  monitorOption: 'all',
  seriesType: 'standard',
  seasonFolder: true,
  rootFolderPath: '/media/movies',
  movieRootFolderPath: null,
  qualityProfileId: 1,
  tags: [],
  minimumAvailability: 'released',
  mediaType: 'movie',
  settings: { listId: '42' },
  lastSyncAt: new Date(Date.now() - 2 * 3600_000).toISOString(),
  lastSyncError: null,
};

const lists: ImportList[] = [
  baseList,
  { ...baseList, id: 2, name: 'Broken feed', implementation: 'stevenLu', enabled: false, lastSyncAt: null, lastSyncError: 'HTTP 500 from feed' },
];

const allItems: ImportListFoundItem[] = [
  { importListId: 1, importListName: 'Marvel', mediaType: 'movie', tmdbId: 1726, title: 'Iron Man', year: 2008, inLibrary: true, excluded: false },
  { importListId: 1, importListName: 'Marvel', mediaType: 'movie', tmdbId: 1724, title: 'The Incredible Hulk', year: 2008, inLibrary: false, excluded: false },
];

type Call = { url: string; method: string; body: unknown };
type Handler = (call: Call) => unknown;

let calls: Call[];
let overrides: Record<string, Handler>;
let settingsState: unknown;
let exclusions: Array<Record<string, unknown>>;

function routes(call: Call): unknown {
  const key = `${call.method} ${call.url}`;
  const override = overrides[key];
  if (override) return override(call);
  switch (key) {
    case 'GET /api/v1/importlist':
      return lists;
    case 'GET /api/v1/importlist/schema':
      return schemas;
    case 'GET /api/v1/importlist/items':
      return allItems;
    case 'GET /api/v1/importlist/1/items':
      return allItems.map(({ importListName: _n, ...rest }) => rest);
    case 'GET /api/v1/rootfolder':
      return [
        { id: 1, path: '/media/tv', mediaType: 'series', accessible: true },
        { id: 2, path: '/media/movies', mediaType: 'movie', accessible: true },
      ];
    case 'GET /api/v1/qualityprofile?mediaDomain=video':
      return [{ id: 1, name: 'HD-1080p', upgradeAllowed: true, cutoff: 3, items: [{ kind: 'quality', qualityId: 3, allowed: true }], minFormatScore: 0, cutoffFormatScore: 0, minUpgradeFormatScore: 1, formatItems: [], languages: [] }];
    case 'GET /api/v1/tag':
      return [{ id: 7, label: 'kids' }];
    case 'GET /api/v1/importlistexclusion':
      return exclusions;
    case 'POST /api/v1/importlistexclusion': {
      const created = { id: 99, ...(call.body as object) };
      exclusions = [...exclusions, created];
      return created;
    }
    case 'DELETE /api/v1/importlistexclusion/5':
      exclusions = exclusions.filter((x) => x.id !== 5);
      return null;
    case 'GET /api/v1/settings/importlists':
      return settingsState;
    case 'PUT /api/v1/settings/importlists':
      settingsState = call.body;
      return call.body;
    case 'POST /api/v1/importlist':
      return { ...baseList, ...(call.body as object), id: 3, lastSyncAt: null, lastSyncError: null };
    case 'POST /api/v1/importlist/sync':
      return { lists: 2, fetched: 10, added: 3, skippedExisting: 5, skippedExcluded: 1, failed: 1, cleaned: 0, errors: [{ importListId: 2, name: 'Broken feed', message: 'HTTP 500' }] };
    default:
      return undefined;
  }
}

beforeEach(() => {
  calls = [];
  overrides = {};
  settingsState = { syncIntervalHours: 6, cleanLibraryLevel: 'disabled', cleanLibraryTags: [] };
  exclusions = [{ id: 5, mediaType: 'movie', tmdbId: 1771, title: 'Captain America: The First Avenger', year: 2011 }];
  vi.stubGlobal('WebSocket', FakeSocket);
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init?: RequestInit) => {
      const call: Call = { url, method: init?.method ?? 'GET', body: init?.body ? JSON.parse(String(init.body)) : undefined };
      calls.push(call);
      const body = routes(call);
      if (body === undefined) return new Response(JSON.stringify({ error: 'not found' }), { status: 404 });
      if (body === null) return new Response(null, { status: 204 });
      return new Response(JSON.stringify(body), { status: call.method === 'POST' && !url.includes('/test') && !url.includes('/sync') && !url.includes('/trakt') ? 201 : 200 });
    }),
  );
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

function renderPage(node = <ImportListsPage />): ToastStore {
  const toasts = createToastStore();
  const queryClient = createQueryClient(toasts);
  // SettingsPage reads the router location, so the page renders inside a one-route router.
  const root = createRootRoute();
  const route = createRoute({ getParentRoute: () => root, path: '/settings/importlists', component: () => node });
  const router = createRouter({ routeTree: root.addChildren([route]), history: createMemoryHistory({ initialEntries: ['/settings/importlists'] }) });
  render(
    <QueryClientProvider client={queryClient}>
      <ToastProvider store={toasts}>
        <RouterProvider router={router} />
      </ToastProvider>
    </QueryClientProvider>,
  );
  return toasts;
}

const posted = (path: string) => calls.filter((c) => c.method === 'POST' && c.url === `/api/v1${path}`);

async function openAdd(name: string) {
  fireEvent.click(await screen.findByRole('button', { name: 'Add list' }));
  const picker = await screen.findByRole('dialog', { name: 'Add import list' });
  fireEvent.click(within(picker).getByRole('button', { name: new RegExp(`^${name}`) }));
  return screen.findByRole('dialog', { name: `Add ${name}` });
}

describe('Settings -> Import Lists', () => {
  it('renders list cards with type, media type, state, last sync, item count and errors', async () => {
    renderPage();
    const title = await screen.findByRole('button', { name: 'Marvel' });
    const card = title.closest('.al-item-card') as HTMLElement;
    expect(within(card).getByText('TMDB List')).toBeTruthy();
    expect(within(card).getByText('Movies')).toBeTruthy();
    expect(within(card).getByText('Enabled')).toBeTruthy();
    expect(within(card).getByText('2h ago')).toBeTruthy();
    await waitFor(() => expect(card.textContent).toMatch(/2 items/));

    const broken = screen.getByRole('button', { name: 'Broken feed' }).closest('.al-item-card') as HTMLElement;
    expect(within(broken).getByText('Sync failed')).toBeTruthy();
    expect(within(broken).getByRole('alert').textContent).toBe('HTTP 500 from feed');
    expect(within(broken).getByText(/never/)).toBeTruthy();
  });

  it('draws the lists as an Arclight card grid with kind, enabled chip, mono sync interval and Edit', async () => {
    renderPage();
    const grid = await screen.findByRole('list', { name: 'Import lists' });
    expect(grid.classList.contains('al-card-grid')).toBe(true);
    const card = (await within(grid).findByRole('button', { name: 'Marvel' })).closest('.al-item-card') as HTMLElement;
    expect(card.classList.contains('al-pane')).toBe(true);
    expect(within(card).getByText('TMDB List')).toBeTruthy();
    const chip = within(card).getByText('Enabled');
    expect(chip.classList.contains('al-chip')).toBe(true);
    const interval = await within(card).findByTestId('sync-interval');
    expect(interval.textContent).toBe('every 6 h');
    expect(interval.classList.contains('al-num')).toBe(true);
    fireEvent.click(within(card).getByRole('button', { name: 'Edit Marvel' }));
    expect(await screen.findByRole('dialog', { name: 'Edit Marvel' })).toBeTruthy();
    // The Add tile closes the grid.
    expect(within(grid).getByRole('button', { name: /Add import list/ })).toBeTruthy();
  });

  it('offers every implementation from the schema with a description', async () => {
    renderPage();
    fireEvent.click(await screen.findByRole('button', { name: 'Add list' }));
    const picker = await screen.findByRole('dialog', { name: 'Add import list' });
    const choices = within(picker).getAllByRole('button').filter((b) => b.classList.contains('al-chooser__item'));
    expect(choices.map((b) => b.querySelector('.al-chooser__name')?.textContent)).toEqual(['TMDB List', 'Trakt List', 'StevenLu Popular Movies']);
    expect(within(picker).getByText('A public TMDB list by its id.')).toBeTruthy();
    expect(within(picker).getByText('Trakt auth')).toBeTruthy();
  });

  it('creates a list with schema settings and list-level defaults', async () => {
    renderPage();
    const dialog = await openAdd('TMDB List');
    expect((within(dialog).getByLabelText(/^Series root folder/) as HTMLSelectElement).value).toBe('/media/tv');
    expect((within(dialog).getByLabelText(/^Movie root folder/) as HTMLSelectElement).value).toBe('/media/movies');
    fireEvent.change(within(dialog).getByLabelText(/^Media type/), { target: { value: 'movie' } });
    expect((within(dialog).getByLabelText(/^Root folder/) as HTMLSelectElement).value).toBe('/media/movies');
    expect(within(dialog).queryByLabelText(/^Movie root folder/)).toBeNull();
    fireEvent.change(within(dialog).getByLabelText(/^List id/), { target: { value: '1234' } });
    fireEvent.click(within(dialog).getByLabelText(/^Search on add/));
    fireEvent.click(within(dialog).getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(posted('/importlist')).toHaveLength(1));
    expect(posted('/importlist')[0]!.body).toMatchObject({
      name: 'TMDB List',
      implementation: 'tmdbList',
      mediaType: 'movie',
      rootFolderPath: '/media/movies',
      movieRootFolderPath: null,
      qualityProfileId: 1,
      minimumAvailability: 'released',
      tags: [],
      settings: { listId: '1234' },
    });
  });

  it('hides series-only defaults for movie lists and requires schema fields', async () => {
    renderPage();
    const dialog = await openAdd('StevenLu Popular Movies');
    expect(within(dialog).queryByLabelText(/^Monitor$/)).toBeNull();
    expect(within(dialog).queryByLabelText(/^Series type/)).toBeNull();
    expect(within(dialog).getByLabelText(/^Minimum availability/)).toBeTruthy();
    expect((within(dialog).getByLabelText(/^Feed URL/) as HTMLInputElement).value).toBe('https://example.test/movies.json');

    fireEvent.click(await screen.findByRole('button', { name: 'Add list' }));
    const picker = await screen.findByRole('dialog', { name: 'Add import list' });
    fireEvent.click(within(picker).getByRole('button', { name: /^TMDB List/ }));
    const tmdb = await screen.findByRole('dialog', { name: 'Add TMDB List' });
    fireEvent.click(within(tmdb).getByRole('button', { name: 'Save' }));
    expect(await within(tmdb).findByText('List id is required')).toBeTruthy();
    expect(posted('/importlist')).toHaveLength(0);
  });

  it('runs the Trakt device flow, polls at the interval and sets the authRef on the list', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    let polls = 0;
    overrides['POST /api/v1/importlist/trakt/device'] = () => ({
      deviceCode: 'dev-123',
      userCode: 'ABCD-1234',
      verificationUrl: 'https://trakt.tv/activate',
      expiresIn: 600,
      interval: 5,
    });
    overrides['POST /api/v1/importlist/trakt/poll'] = () => {
      polls += 1;
      return polls < 3 ? { status: 'pending' } : { status: 'authorized', authRef: 'ref-xyz' };
    };
    renderPage();
    const dialog = await openAdd('Trakt List');
    fireEvent.change(within(dialog).getByLabelText(/^Trakt client id/), { target: { value: 'cid' } });
    fireEvent.change(within(dialog).getByLabelText(/^Trakt client secret/), { target: { value: 'csecret' } });
    fireEvent.change(within(dialog).getByLabelText(/^Username/), { target: { value: 'me' } });
    fireEvent.change(within(dialog).getByLabelText(/^List name/), { target: { value: 'watch-later' } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Authenticate with Trakt' }));

    const code = await within(dialog).findByTestId('trakt-user-code');
    expect(code.textContent).toBe('ABCD-1234');
    expect(code.classList.contains('al-trakt__code')).toBe(true);
    expect(within(dialog).getByText(/Waiting for Trakt to confirm/)).toBeTruthy();
    expect(within(within(dialog).getByRole('group', { name: 'Trakt authentication' })).getByRole('button', { name: 'Cancel' }).className).toContain('al-btn--ghost');
    expect(within(dialog).getByRole('link', { name: 'https://trakt.tv/activate' })).toBeTruthy();
    expect(posted('/importlist/trakt/device')[0]!.body).toEqual({ clientId: 'cid' });

    // Nothing is polled before the first interval elapses.
    await act(async () => vi.advanceTimersByTimeAsync(4000));
    expect(posted('/importlist/trakt/poll')).toHaveLength(0);
    for (let i = 0; i < 3; i++) await act(async () => vi.advanceTimersByTimeAsync(5000));
    expect(await within(dialog).findByText(/Authorized with Trakt/)).toBeTruthy();
    expect(posted('/importlist/trakt/poll')).toHaveLength(3);
    expect(posted('/importlist/trakt/poll')[0]!.body).toEqual({ deviceCode: 'dev-123', clientId: 'cid', clientSecret: 'csecret' });

    fireEvent.click(within(dialog).getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(posted('/importlist')).toHaveLength(1));
    expect(posted('/importlist')[0]!.body).toMatchObject({
      implementation: 'trakt',
      settings: { clientId: 'cid', clientSecret: 'csecret', username: 'me', listName: 'watch-later', authRef: 'ref-xyz', limit: 100 },
    });
  });

  it('stops polling and explains when the Trakt code expires', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    overrides['POST /api/v1/importlist/trakt/device'] = () => ({
      deviceCode: 'dev-1',
      userCode: 'WXYZ',
      verificationUrl: 'https://trakt.tv/activate',
      expiresIn: 600,
      interval: 2,
    });
    overrides['POST /api/v1/importlist/trakt/poll'] = () => ({ status: 'expired' });
    renderPage();
    const dialog = await openAdd('Trakt List');
    fireEvent.change(within(dialog).getByLabelText(/^Trakt client id/), { target: { value: 'cid' } });
    fireEvent.change(within(dialog).getByLabelText(/^Trakt client secret/), { target: { value: 's' } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Authenticate with Trakt' }));
    await within(dialog).findByTestId('trakt-user-code');
    await act(async () => vi.advanceTimersByTimeAsync(2000));
    expect((await within(dialog).findByText(/code expired/)).textContent).toMatch(/Try again/);
    await act(async () => vi.advanceTimersByTimeAsync(10_000));
    expect(posted('/importlist/trakt/poll')).toHaveLength(1);
  });

  it('asks for the client id before starting the Trakt flow', async () => {
    renderPage();
    const dialog = await openAdd('Trakt List');
    fireEvent.click(within(dialog).getByRole('button', { name: 'Authenticate with Trakt' }));
    expect((await within(dialog).findByText('Enter the Trakt client id first.')).getAttribute('role')).toBe('alert');
    expect(posted('/importlist/trakt/device')).toHaveLength(0);
  });

  it('tests a saved list and previews the first items', async () => {
    overrides['POST /api/v1/importlist/test'] = () => ({
      ok: true,
      itemCount: 37,
      items: [
        { mediaType: 'movie', tmdbId: 1726, title: 'Iron Man', year: 2008, inLibrary: true, excluded: false },
        { mediaType: 'movie', tmdbId: 10138, title: 'Iron Man 2', year: 2010, inLibrary: false, excluded: true },
      ],
    });
    renderPage();
    fireEvent.click(await screen.findByRole('button', { name: 'Marvel' }));
    const dialog = await screen.findByRole('dialog', { name: 'Edit Marvel' });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Test' }));
    const result = await within(dialog).findByRole('region', { name: 'Test result' });
    expect(within(result).getByText(/37 items found/)).toBeTruthy();
    expect(within(result).getByText('Iron Man 2')).toBeTruthy();
    expect(within(result).getByText('Excluded')).toBeTruthy();
    expect(within(result).getByText('In library')).toBeTruthy();
    expect(posted('/importlist/test')[0]!.body).toMatchObject({ id: 1, implementation: 'tmdbList', settings: { listId: '42' } });
  });

  it('shows a failed test with the api message', async () => {
    overrides['POST /api/v1/importlist/test'] = () => ({ ok: false, error: { code: 'FETCH', message: 'TMDB list 42 not found' } });
    renderPage();
    fireEvent.click(await screen.findByRole('button', { name: 'Marvel' }));
    const dialog = await screen.findByRole('dialog', { name: 'Edit Marvel' });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Test' }));
    expect(await within(dialog).findByText('TMDB list 42 not found')).toBeTruthy();
    expect(within(dialog).getByText('Test failed')).toBeTruthy();
  });

  it('opens the per-list items preview and excludes an item from it', async () => {
    renderPage();
    fireEvent.click(await screen.findByRole('button', { name: 'Preview items in Marvel' }));
    const dialog = await screen.findByRole('dialog', { name: 'Items in Marvel' });
    expect(await within(dialog).findByText('The Incredible Hulk')).toBeTruthy();
    expect(within(dialog).getByText((_, el) => el?.tagName === 'P' && el.textContent === '2 items from the last sync.')).toBeTruthy();
    fireEvent.click(within(dialog).getByRole('button', { name: 'Exclude The Incredible Hulk' }));
    await waitFor(() => expect(posted('/importlistexclusion')).toHaveLength(1));
    expect(posted('/importlistexclusion')[0]!.body).toEqual({ mediaType: 'movie', tmdbId: 1724, title: 'The Incredible Hulk', year: 2008 });
  });

  it('syncs every list on "Sync now" and reports the outcome', async () => {
    const toasts = renderPage();
    fireEvent.click(await screen.findByRole('button', { name: 'Sync now' }));
    await waitFor(() => expect(posted('/importlist/sync')).toHaveLength(1));
    await waitFor(() => expect(toasts.list().some((t) => t.title === 'Synced 2 lists')).toBe(true));
    const toast = toasts.list().find((t) => t.title === 'Synced 2 lists')!;
    expect(toast.tone).toBe('warning');
    expect(toast.message).toMatch(/3 added/);
  });

  it('adds and removes exclusions', async () => {
    renderPage();
    expect(await screen.findByText('Captain America: The First Avenger')).toBeTruthy();
    const form = screen.getByRole('form', { name: 'Add exclusion' });
    const add = within(form).getByRole('button', { name: 'Add exclusion' }) as HTMLButtonElement;
    expect(add.disabled).toBe(true);
    fireEvent.change(within(form).getByLabelText('Exclusion type'), { target: { value: 'series' } });
    fireEvent.change(within(form).getByLabelText('TMDB id'), { target: { value: '1399' } });
    fireEvent.change(within(form).getByLabelText('Exclusion title'), { target: { value: 'Game of Thrones' } });
    fireEvent.change(within(form).getByLabelText('Exclusion year'), { target: { value: '2011' } });
    fireEvent.click(add);
    expect(await screen.findByText('Game of Thrones')).toBeTruthy();
    expect(posted('/importlistexclusion')[0]!.body).toEqual({ mediaType: 'series', tmdbId: 1399, title: 'Game of Thrones', year: 2011 });

    fireEvent.click(screen.getByRole('button', { name: 'Remove Captain America: The First Avenger' }));
    await waitFor(() => expect(screen.queryByText('Captain America: The First Avenger')).toBeNull());
    expect(calls.some((c) => c.method === 'DELETE' && c.url === '/api/v1/importlistexclusion/5')).toBe(true);
  });

  it('removes an exclusion from the exclusions table', async () => {
    renderPage();
    const table = await screen.findByRole('table', { name: 'List exclusions' });
    expect(await within(table).findByText('Captain America: The First Avenger')).toBeTruthy();
    const year = within(table).getByText('2011');
    expect(year.closest('td')?.className ?? '').toMatch(/mono/);
    fireEvent.click(within(table).getByRole('button', { name: 'Remove Captain America: The First Avenger' }));
    await waitFor(() => expect(calls.some((c) => c.method === 'DELETE' && c.url === '/api/v1/importlistexclusion/5')).toBe(true));
    await waitFor(() => expect(within(table).queryByText('Captain America: The First Avenger')).toBeNull());
  });

  it('saves the import list options', async () => {
    renderPage();
    const form = await screen.findByRole('form', { name: 'Import list options' });
    const interval = (await within(form).findByLabelText('Sync interval (hours)')) as HTMLInputElement;
    expect(interval.value).toBe('6');
    fireEvent.change(interval, { target: { value: '12' } });
    fireEvent.change(within(form).getByLabelText('Clean library level'), { target: { value: 'unmonitor' } });
    fireEvent.click(await within(form).findByRole('button', { name: 'kids' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Save changes' }));
    await waitFor(() => expect(calls.some((c) => c.method === 'PUT' && c.url === '/api/v1/settings/importlists')).toBe(true));
    expect(calls.find((c) => c.method === 'PUT')!.body).toEqual({ syncIntervalHours: 12, cleanLibraryLevel: 'unmonitor', cleanLibraryTags: [7] });
  });

  it('blocks saving an out-of-range sync interval', async () => {
    renderPage();
    const form = await screen.findByRole('form', { name: 'Import list options' });
    fireEvent.change(await within(form).findByLabelText('Sync interval (hours)'), { target: { value: '500' } });
    expect(within(form).getByText('Enter 1 to 168 hours')).toBeTruthy();
    expect((screen.getByRole('button', { name: 'Save changes' }) as HTMLButtonElement).disabled).toBe(true);
  });
});

describe('FoundInLists', () => {
  it('shows one chip per list a title was found in', async () => {
    overrides['GET /api/v1/importlist/items?mediaType=movie&tmdbId=1726'] = () => [
      allItems[0],
      { ...allItems[0], importListId: 4, importListName: 'Trakt watchlist' },
      allItems[0],
    ];
    renderPage(<FoundInLists mediaType="movie" tmdbId={1726} />);
    const group = await screen.findByRole('list', { name: 'Found in lists' });
    expect(within(group).getAllByRole('listitem').map((c) => c.textContent)).toEqual(['Marvel', 'Trakt watchlist']);
  });

  it('renders nothing when the title is on no list', async () => {
    overrides['GET /api/v1/importlist/items?mediaType=series&tmdbId=5'] = () => [];
    renderPage(<FoundInLists mediaType="series" tmdbId={5} />);
    await waitFor(() => expect(calls.some((c) => c.url.includes('tmdbId=5'))).toBe(true));
    expect(screen.queryByRole('list', { name: 'Found in lists' })).toBeNull();
  });
});

describe('import list helpers and routing', () => {
  it('builds the body: drops empty settings, clears the movie root unless mediaType is both', () => {
    const body = toListBody({
      name: ' Mine ',
      implementation: 'tmdbPopular',
      mediaType: 'series',
      rootFolderPath: '/tv',
      movieRootFolderPath: '/movies',
      qualityProfileId: '2',
      monitorOption: 'future',
      seriesType: 'anime',
      minimumAvailability: 'released',
      tags: [1],
      settings: { listType: 'popular', minVotes: undefined, languages: [], yearFrom: '' },
    });
    expect(body).toMatchObject({ name: 'Mine', movieRootFolderPath: null, qualityProfileId: 2, settings: { listType: 'popular', languages: [] } });
    expect(Object.keys(body.settings ?? {})).toEqual(['listType', 'languages']);
    expect(toListBody({ mediaType: 'both', movieRootFolderPath: '/movies', settings: {} }).movieRootFolderPath).toBe('/movies');
  });

  it('serves the page at /settings/importlists with a sidebar entry', async () => {
    const toasts = createToastStore();
    const queryClient = createQueryClient(toasts);
    const router = createRouter({ routeTree, context: { queryClient }, history: createMemoryHistory({ initialEntries: ['/settings/importlists'] }) });
    render(
      <QueryClientProvider client={queryClient}>
        <ToastProvider store={toasts}>
          <RouterProvider router={router} />
        </ToastProvider>
      </QueryClientProvider>,
    );
    expect(await screen.findByRole('heading', { level: 2, name: 'Import lists' })).toBeTruthy();
    expect(screen.getAllByRole('link', { name: 'Import lists' }).length).toBeGreaterThan(0);
    expect(await screen.findByRole('button', { name: 'Marvel' })).toBeTruthy();
  });
});
