import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { QueryClientProvider } from '@tanstack/react-query';
import { RouterProvider, createMemoryHistory, createRootRoute, createRoute, createRouter } from '@tanstack/react-router';
import { useState } from 'react';
import type { Indexer, IndexerCatalogue, IndexerCatalogueEntry, IndexerCategory, IndexerDefinitionSummary, IndexerTemplate } from '@arclight/shared';
import { ToastProvider } from '../../../components/toast.js';
import { createToastStore } from '../../../lib/toast.js';
import { createQueryClient } from '../../../query-client.js';
import { CATEGORY_INDENT, CategoryTree } from './indexer-fields.js';
import { indexerHealth, IndexersPage } from './indexers-page.js';

class FakeSocket {
  onopen = null;
  onmessage = null;
  onclose = null;
  close() {}
}

const def = (over: Partial<IndexerDefinitionSummary>): IndexerDefinitionSummary => ({
  id: 'yts',
  name: 'YTS',
  description: 'Movie torrents',
  language: 'en-US',
  type: 'public',
  privacy: 'public',
  protocol: 'torrent',
  links: ['https://yts.example/'],
  settingsFields: [],
  categories: [{ id: 2000, name: 'Movies' }],
  tested: true,
  source: 'builtin',
  ...over,
});

const definitions = [
  def({}),
  def({ id: 'privtracker', name: 'PrivTracker', description: 'Members only', privacy: 'private', type: 'private', tested: false }),
  def({ id: 'nzbsite', name: 'NzbSite', description: 'Usenet indexer', privacy: 'semi-private', type: 'semi-private', protocol: 'usenet', language: 'de-DE' }),
];

const template = (implementation: 'torznab' | 'newznab'): IndexerTemplate => ({
  implementation,
  implementationName: implementation === 'torznab' ? 'Torznab' : 'Newznab',
  protocol: implementation === 'torznab' ? 'torrent' : 'usenet',
  template: {
    name: implementation,
    implementation,
    enableRss: true,
    enableAutomaticSearch: true,
    enableInteractiveSearch: true,
    priority: 25,
    tags: [],
    settings: { baseUrl: '', apiPath: '/api', categories: [], animeCategories: [] },
  },
});

const indexer = (over: Partial<Indexer>): Indexer => ({
  id: 1,
  name: 'Jackett',
  implementation: 'torznab',
  protocol: 'torrent',
  enableRss: true,
  enableAutomaticSearch: true,
  enableInteractiveSearch: true,
  priority: 12,
  tags: [],
  settings: { baseUrl: 'http://jackett', apiPath: '/api', categories: [], animeCategories: [] },
  ...over,
});

const entry = (over: Partial<IndexerCatalogueEntry> & Pick<IndexerCatalogueEntry, 'id' | 'name'>): IndexerCatalogueEntry => ({
  key: `${over.kind ?? 'definition'}:${over.id}`,
  kind: 'definition',
  description: '',
  language: 'en-US',
  protocol: 'torrent',
  privacy: 'public',
  links: [],
  categoryIds: [2000],
  categoryGroups: ['movies'],
  tested: true,
  source: 'builtin',
  support: 'supported',
  ...over,
});

const catalogueEntries: IndexerCatalogueEntry[] = [
  entry({
    id: 'torznab',
    kind: 'generic',
    name: 'Torznab',
    description: 'Any Torznab endpoint',
    source: 'generic',
    privacy: 'private',
    language: '',
    preset: { implementation: 'torznab', baseUrl: '', apiPath: '/api', categories: [2000, 5000], animeCategories: [5070] },
  }),
  entry({ id: 'yts', name: 'YTS', description: 'Movie torrents', links: ['https://yts.example/'] }),
  entry({ id: 'privtracker', name: 'PrivTracker', description: 'Members only', privacy: 'private', tested: false, source: 'community', categoryGroups: ['tv'] }),
  entry({ id: 'cloudy', name: 'Cloudy', description: 'Behind a challenge', requiresFlareSolverr: true, source: 'community' }),
  entry({ id: 'capped', name: 'Capped', description: 'Login captcha', support: 'limited', supportReason: 'login.captcha (image) is not supported', source: 'community', language: 'de-DE' }),
  entry({ id: 'oddball', name: 'Oddball', description: 'Broken', support: 'unsupported', supportReason: 'id "oddball-api" does not match file name "oddball"', source: 'community', categoryGroups: [] }),
  entry({
    id: 'nzbplanet',
    kind: 'preset',
    name: 'NZBPlanet',
    description: 'General usenet indexer',
    protocol: 'usenet',
    privacy: 'semi-private',
    source: 'preset',
    links: ['https://api.nzbplanet.net'],
    preset: { implementation: 'newznab', baseUrl: 'https://api.nzbplanet.net', apiPath: '/api', categories: [2000, 5000], animeCategories: [5070], apiKeyHint: 'Your profile page' },
  }),
  entry({
    id: 'nzbgeek',
    kind: 'preset',
    name: 'NZBgeek',
    protocol: 'usenet',
    privacy: 'semi-private',
    source: 'preset',
    links: ['https://api.nzbgeek.info'],
    preset: { implementation: 'newznab', baseUrl: 'https://api.nzbgeek.info', apiPath: '/api', categories: [2000, 5000], animeCategories: [5070] },
  }),
];

const catalogue = (entries: IndexerCatalogueEntry[]): IndexerCatalogue => ({
  etag: 'W/"x"',
  counts: { total: entries.length, supported: entries.filter((e) => e.support !== 'unsupported').length, limited: 1, unsupported: 1, bySource: {} },
  community: { enabled: true, lastSuccessAt: '2026-10-26T00:00:00Z', lastError: null },
  entries,
});

let responses: Record<string, unknown>;
let calls: Array<{ url: string; method: string; body: unknown }>;

beforeEach(() => {
  calls = [];
  responses = {
    '/api/v1/indexer': [
      indexer({}),
      indexer({ id: 2, name: 'Geek', implementation: 'newznab', protocol: 'usenet', priority: 3, status: { failureCount: 2 } }),
      indexer({ id: 3, name: 'Old', enableRss: false, enableAutomaticSearch: false, enableInteractiveSearch: false }),
      indexer({ id: 4, name: 'My YTS', implementation: 'definition', settings: { baseUrl: 'https://yts.example/', apiPath: '', categories: [], animeCategories: [], definitionId: 'yts', fields: {} } }),
      indexer({ id: 5, name: 'Geek main', implementation: 'newznab', protocol: 'usenet', settings: { baseUrl: 'https://api.nzbgeek.info/', apiPath: '/api', categories: [], animeCategories: [] } }),
    ],
    '/api/v1/indexer/catalogue': catalogue(catalogueEntries),
    '/api/v1/indexer/definition/yts': { ...definitions[0], searchModes: ['search'], requiresLogin: false, warnings: [] },
    '/api/v1/indexer/schema': [template('torznab'), template('newznab')],
    '/api/v1/indexer/definition': definitions,
    '/api/v1/indexer/categories': [],
    '/api/v1/indexerproxy': [],
    '/api/v1/tag': [],
  };
  vi.stubGlobal('WebSocket', FakeSocket);
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init?: RequestInit) => {
      const method = init?.method ?? 'GET';
      const body = typeof init?.body === 'string' ? JSON.parse(init.body) : undefined;
      calls.push({ url, method, body });
      if (url === '/api/v1/indexer/test' && method === 'POST') return new Response(JSON.stringify({ ok: true, releaseCount: 42 }), { status: 200 });
      const found = responses[url];
      return found === undefined ? new Response(JSON.stringify({ error: 'not found' }), { status: 404 }) : new Response(JSON.stringify(found), { status: 200 });
    }),
  );
});

afterEach(() => vi.unstubAllGlobals());

/** The page in a minimal router (independent of the app shell). */
function renderPage(path = '/settings/indexers') {
  const toasts = createToastStore();
  const queryClient = createQueryClient(toasts);
  const root = createRootRoute();
  const routes = ['/settings/indexers', '/indexers'].map((p) => createRoute({ getParentRoute: () => root, path: p, component: IndexersPage }));
  const router = createRouter({ routeTree: root.addChildren(routes), history: createMemoryHistory({ initialEntries: [path] }) });
  render(
    <QueryClientProvider client={queryClient}>
      <ToastProvider store={toasts}>
        <RouterProvider router={router} />
      </ToastProvider>
    </QueryClientProvider>,
  );
}

async function openChooser() {
  renderPage();
  fireEvent.click(await screen.findByRole('button', { name: 'Add indexer' }));
  return screen.findByRole('dialog', { name: 'Add indexer' });
}

const listbox = (dialog: HTMLElement) => within(dialog).findByRole('listbox', { name: 'Catalogue entries' });
const optionNames = (list: HTMLElement) => within(list).getAllByRole('option').map((o) => o.getAttribute('aria-label'));

describe('indexer chooser', () => {
  it('opens wide with the search field focused and lists every entry with its facts', async () => {
    const dialog = await openChooser();
    expect(dialog.getAttribute('data-width')).toBe('1100');
    const list = await listbox(dialog);
    expect(document.activeElement).toBe(within(dialog).getByRole('searchbox', { name: 'Search indexers' }));
    expect(optionNames(list)).toEqual(['Torznab', 'Capped', 'Cloudy', 'NZBgeek', 'NZBPlanet', 'Oddball', 'PrivTracker', 'YTS']);
    const row = (name: string) => within(list).getByRole('option', { name });
    expect(within(row('YTS')).getByText('Public').className).toContain('al-chip');
    expect(within(row('YTS')).getByText('TOR').className).toContain('al-proto');
    expect(within(row('PrivTracker')).getByText('Private')).toBeTruthy();
    expect(within(row('PrivTracker')).getByText('Untested')).toBeTruthy();
    expect(within(row('PrivTracker')).getByText('Community')).toBeTruthy();
    expect(within(row('NZBPlanet')).getByText('NZB')).toBeTruthy();
    expect(within(row('NZBPlanet')).getByText('Preset')).toBeTruthy();
    expect(within(row('Capped')).getByText('Limited')).toBeTruthy();
    expect(within(row('Oddball')).getByText('Not supported yet')).toBeTruthy();
    expect(within(row('Oddball')).getByText(/does not match file name/)).toBeTruthy();
    expect(within(dialog).getByText(/8 shown · 8 total · 7 can be added · 1 not supported yet/)).toBeTruthy();
  });

  it('filters by text (name, description or URL), protocol, privacy, language, category and support', async () => {
    const dialog = await openChooser();
    const list = await listbox(dialog);
    const search = within(dialog).getByRole('searchbox', { name: 'Search indexers' });
    fireEvent.change(search, { target: { value: 'members' } });
    expect(optionNames(list)).toEqual(['PrivTracker']);
    fireEvent.change(search, { target: { value: 'nzbplanet.net' } });
    expect(optionNames(list)).toEqual(['NZBPlanet']);
    fireEvent.change(search, { target: { value: '' } });
    fireEvent.change(within(dialog).getByRole('combobox', { name: 'Protocol' }), { target: { value: 'usenet' } });
    expect(optionNames(list)).toEqual(['NZBgeek', 'NZBPlanet']);
    fireEvent.change(within(dialog).getByRole('combobox', { name: 'Protocol' }), { target: { value: 'all' } });
    fireEvent.change(within(dialog).getByRole('combobox', { name: 'Privacy' }), { target: { value: 'private' } });
    // generic endpoints ignore privacy, language and category
    expect(optionNames(list)).toEqual(['Torznab', 'PrivTracker']);
    fireEvent.change(within(dialog).getByRole('combobox', { name: 'Privacy' }), { target: { value: 'all' } });
    fireEvent.change(within(dialog).getByRole('combobox', { name: 'Language' }), { target: { value: 'de' } });
    expect(optionNames(list)).toEqual(['Torznab', 'Capped']);
    fireEvent.click(within(dialog).getByRole('button', { name: 'Clear' }));
    fireEvent.change(within(dialog).getByRole('combobox', { name: 'Category' }), { target: { value: 'tv' } });
    expect(optionNames(list)).toEqual(['Torznab', 'PrivTracker']);
    fireEvent.click(within(dialog).getByRole('button', { name: 'Clear' }));
    fireEvent.change(within(dialog).getByRole('combobox', { name: 'Source' }), { target: { value: 'community' } });
    fireEvent.click(within(dialog).getByRole('checkbox', { name: 'Hide unsupported' }));
    expect(optionNames(list)).toEqual(['Capped', 'Cloudy', 'PrivTracker']);
    fireEvent.click(within(dialog).getByRole('checkbox', { name: 'Tested only' }));
    expect(optionNames(list)).toEqual(['Capped', 'Cloudy']);
    fireEvent.change(search, { target: { value: 'nothing-like-this' } });
    expect(await within(dialog).findByText('No definitions match')).toBeTruthy();
  });

  it('sorts by a column and toggles the direction', async () => {
    const dialog = await openChooser();
    const list = await listbox(dialog);
    fireEvent.click(within(dialog).getByRole('button', { name: 'Sort by Privacy' }));
    expect(optionNames(list).slice(0, 2)).toEqual(['Torznab', 'Capped']);
    expect(optionNames(list).slice(-1)).toEqual(['PrivTracker']);
    fireEvent.click(within(dialog).getByRole('button', { name: 'Sort by Privacy' }));
    expect(optionNames(list).slice(0, 2)).toEqual(['Torznab', 'PrivTracker']);
  });

  it('greys added entries and offers Edit existing or Add another', async () => {
    const dialog = await openChooser();
    const list = await listbox(dialog);
    const yts = within(list).getByRole('option', { name: 'YTS' });
    expect(yts.getAttribute('data-added')).toBe('true');
    expect(within(yts).getByText('Added')).toBeTruthy();
    expect(within(yts).getByText(/In use as My YTS/)).toBeTruthy();
    // presets match by base URL host
    expect(within(list).getByRole('option', { name: 'NZBgeek' }).getAttribute('data-added')).toBe('true');
    expect(within(list).getByRole('option', { name: 'NZBPlanet' }).getAttribute('data-added')).toBeNull();

    fireEvent.click(yts);
    const choice = await screen.findByRole('dialog', { name: 'YTS is already added' });
    expect(within(choice).getByText('You already use it as My YTS.')).toBeTruthy();
    fireEvent.click(within(choice).getByRole('button', { name: 'Edit existing' }));
    expect(await screen.findByRole('dialog', { name: 'Edit My YTS' })).toBeTruthy();
    expect(screen.queryByRole('dialog', { name: 'Add indexer' })).toBeNull();
  });

  it('Add another opens a fresh editor for the same definition', async () => {
    const dialog = await openChooser();
    fireEvent.click(within(await listbox(dialog)).getByRole('option', { name: 'YTS' }));
    const choice = await screen.findByRole('dialog', { name: 'YTS is already added' });
    fireEvent.click(within(choice).getByRole('button', { name: 'Add another' }));
    expect(await screen.findByRole('dialog', { name: 'Add YTS' })).toBeTruthy();
  });

  it('explains why an unsupported entry cannot be added', async () => {
    const dialog = await openChooser();
    fireEvent.click(within(await listbox(dialog)).getByRole('option', { name: 'Oddball' }));
    const info = await screen.findByRole('dialog', { name: 'Oddball is not supported yet' });
    expect(within(info).getAllByText(/does not match file name/).length).toBeGreaterThan(0);
    expect(within(info).getByText(/oddball\.yml/)).toBeTruthy();
  });

  it('moves through rows with the keyboard and opens the active one with Enter', async () => {
    const dialog = await openChooser();
    const list = await listbox(dialog);
    const search = within(dialog).getByRole('searchbox', { name: 'Search indexers' });
    fireEvent.change(search, { target: { value: 'nzb' } });
    fireEvent.keyDown(search, { key: 'ArrowDown' });
    expect(document.activeElement).toBe(list);
    const activeName = () => document.getElementById(list.getAttribute('aria-activedescendant') ?? '')?.getAttribute('aria-label');
    expect(activeName()).toBe('NZBgeek');
    fireEvent.keyDown(list, { key: 'ArrowDown' });
    expect(activeName()).toBe('NZBPlanet');
    fireEvent.keyDown(list, { key: 'Home' });
    expect(activeName()).toBe('NZBgeek');
    fireEvent.keyDown(list, { key: 'End' });
    fireEvent.keyDown(list, { key: 'Enter' });
    const editor = await screen.findByRole('dialog', { name: 'Add NZBPlanet indexer' });
    expect((within(editor).getByLabelText(/^URL/) as HTMLInputElement).value).toBe('https://api.nzbplanet.net');
    expect(within(editor).getByText(/Add your API key, then Test/)).toBeTruthy();
    expect(within(editor).getByText('API key: Your profile page.')).toBeTruthy();
  });

  it('hints at the solver on rows behind a challenge when no solver proxy exists', async () => {
    const dialog = await openChooser();
    const list = await listbox(dialog);
    const notes = await within(list).findAllByRole('note');
    expect(notes).toHaveLength(1);
    expect(within(notes[0]!).getByRole('link', { name: 'Set up' }).getAttribute('href')).toBe('/settings/solver');
    expect(notes[0]!.closest('[role="option"]')?.getAttribute('aria-label')).toBe('Cloudy');
  });

  it('renders only a window of a large catalogue', async () => {
    const many = Array.from({ length: 600 }, (_, i) => entry({ id: `site${String(i).padStart(3, '0')}`, name: `Site ${String(i).padStart(3, '0')}` }));
    responses['/api/v1/indexer/catalogue'] = catalogue(many);
    const dialog = await openChooser();
    const list = await listbox(dialog);
    const rendered = within(list).getAllByRole('option');
    expect(rendered.length).toBeGreaterThan(5);
    expect(rendered.length).toBeLessThan(40);
    expect(within(dialog).getByText(/600 shown · 600 total/)).toBeTruthy();
    // jump to the end: the last row is rendered and active
    fireEvent.keyDown(list, { key: 'End' });
    expect(within(list).getByRole('option', { name: 'Site 599' }).getAttribute('aria-selected')).toBe('true');
  });
});

describe('indexer cards', () => {
  it('shows protocol, status chip, mono priority and Test / Edit buttons', async () => {
    renderPage();
    const grid = await screen.findByRole('list', { name: 'Indexers' });
    const [jackett, geek, old] = within(grid).getAllByRole('listitem');
    expect(within(jackett!).getByText('Enabled').className).toContain('al-chip');
    expect(within(jackett!).getByText('TOR')).toBeTruthy();
    const priority = within(jackett!).getByText('12');
    expect(priority.className).toContain('al-card-priority');
    expect(within(jackett!).getByRole('button', { name: 'Edit Jackett' })).toBeTruthy();

    expect(within(geek!).getByText('Failed · 2 recent failures')).toBeTruthy();
    expect(within(geek!).getByText('NZB')).toBeTruthy();
    expect(within(old!).getByText('Disabled')).toBeTruthy();

    fireEvent.click(within(jackett!).getByRole('button', { name: 'Test' }));
    expect(await within(jackett!).findByText('Test passed')).toBeTruthy();
    expect(within(jackett!).getByText('42 releases returned')).toBeTruthy();
    await waitFor(() => expect(calls.find((c) => c.url === '/api/v1/indexer/test')?.body).toMatchObject({ name: 'Jackett', implementation: 'torznab' }));
  });

  it('searches the cards by name, implementation, protocol, tag and status with "N of M"', async () => {
    responses['/api/v1/tag'] = [{ id: 7, label: 'anime-only' }];
    (responses['/api/v1/indexer'] as Indexer[])[0]!.tags = [7];
    renderPage('/settings/indexers?q=newznab');
    const grid = await screen.findByRole('list', { name: 'Indexers' });
    expect(within(grid).getAllByRole('listitem').map((c) => within(c).getAllByRole('button')[0]!.textContent)).toEqual(['Geek', 'Geek main']);
    expect(screen.getByText('2 of 5')).toBeTruthy();
    const box = screen.getByRole('searchbox', { name: 'Search this list' });
    fireEvent.change(box, { target: { value: 'anime only' } });
    fireEvent.keyDown(box, { key: 'Enter' });
    await waitFor(() => expect(within(screen.getByRole('list', { name: 'Indexers' })).getAllByRole('listitem')).toHaveLength(1));
    fireEvent.change(box, { target: { value: 'failed usenet' } });
    fireEvent.keyDown(box, { key: 'Enter' });
    await waitFor(() => expect(screen.getByText('1 of 5')).toBeTruthy());
    expect(within(screen.getByRole('list', { name: 'Indexers' })).getByText('Geek')).toBeTruthy();
  });

  it('selects only the matching indexers and clears an empty search', async () => {
    renderPage('/settings/indexers?q=geek');
    const grid = await screen.findByRole('list', { name: 'Indexers' });
    fireEvent.click(within(grid).getAllByRole('checkbox')[0]!);
    fireEvent.click(await screen.findByRole('button', { name: /select all/i }));
    expect(await screen.findByText(/2 selected/i)).toBeTruthy();
    const box = screen.getByRole('searchbox', { name: 'Search this list' });
    fireEvent.change(box, { target: { value: 'zzz' } });
    fireEvent.keyDown(box, { key: 'Enter' });
    fireEvent.click(await screen.findByRole('button', { name: 'Clear search' }));
    expect(await screen.findByRole('list', { name: 'Indexers' })).toBeTruthy();
    expect(within(screen.getByRole('list', { name: 'Indexers' })).getAllByRole('listitem')).toHaveLength(5);
  });

  it('maps status to chip tones with a cause', () => {
    const now = Date.parse('2026-10-26T12:00:00Z');
    expect(indexerHealth({ status: undefined }, now)).toEqual({ tone: 'accent', label: 'Enabled' });
    expect(indexerHealth({ status: { failureCount: 1 } }, now)).toMatchObject({ tone: 'danger', label: 'Failed · 1 recent failure' });
    const backoff = indexerHealth({ status: { failureCount: 3, disabledTill: '2026-10-26T13:00:00Z' } }, now);
    expect(backoff.tone).toBe('warn');
    expect(backoff.label).toMatch(/^Backing off · retry \d\d:\d\d$/);
    expect(indexerHealth({ status: undefined, enableRss: false, enableAutomaticSearch: false, enableInteractiveSearch: false }, now)).toEqual({ tone: 'muted', label: 'Disabled' });
  });

  it('opens the endpoint editor with stacked fields from a generic entry', async () => {
    const dialog = await openChooser();
    fireEvent.click(within(await listbox(dialog)).getByRole('option', { name: 'Torznab' }));
    const editor = await screen.findByRole('dialog', { name: 'Add Torznab indexer' });
    expect(within(editor).getByLabelText(/^URL/)).toBeTruthy();
    expect(within(editor).getByRole('button', { name: 'Test' })).toBeTruthy();
    expect(within(editor).getByRole('button', { name: 'Save' })).toBeTruthy();
  });
});

describe('category tree', () => {
  const categories: IndexerCategory[] = [
    { id: 2000, name: 'Movies', subCategories: [{ id: 2030, name: 'Movies/SD' }, { id: 2040, name: 'Movies/HD' }] },
    { id: 5000, name: 'TV', subCategories: [{ id: 5040, name: 'TV/HD' }] },
  ];

  function Harness({ initial }: { initial: number[] }) {
    const [value, setValue] = useState(initial);
    return <CategoryTree categories={categories} value={value} onChange={setValue} />;
  }

  it('indents subcategories 20px and marks a partly selected parent indeterminate', () => {
    render(<Harness initial={[2040]} />);
    const movies = screen.getByRole('checkbox', { name: /^Movies 2000/ }) as HTMLInputElement;
    const hd = screen.getByRole('checkbox', { name: /Movies\/HD/ }) as HTMLInputElement;
    expect(CATEGORY_INDENT).toBe(20);
    expect((hd.closest('li') as HTMLElement).style.paddingLeft).toBe('20px');
    expect((movies.closest('.al-cat-tree__row') as HTMLElement).style.paddingLeft).toBe('0px');
    expect(hd.checked).toBe(true);
    expect(movies.indeterminate).toBe(true);
    expect(movies.getAttribute('aria-checked')).toBe('mixed');

    // Checking the parent selects the whole branch; the parent is no longer mixed.
    fireEvent.click(movies);
    expect(movies.checked).toBe(true);
    expect(movies.indeterminate).toBe(false);
    expect((screen.getByRole('checkbox', { name: /Movies\/SD/ }) as HTMLInputElement).checked).toBe(true);
    const tv = screen.getByRole('checkbox', { name: /^TV 5000/ }) as HTMLInputElement;
    expect(tv.indeterminate).toBe(false);
    expect(tv.checked).toBe(false);
  });
});
