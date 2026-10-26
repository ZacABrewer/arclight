import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { QueryClientProvider } from '@tanstack/react-query';
import { RouterProvider, createMemoryHistory, createRootRoute, createRoute, createRouter } from '@tanstack/react-router';
import { useState } from 'react';
import type { Indexer, IndexerCategory, IndexerDefinitionSummary, IndexerTemplate } from '@arclight/shared';
import { ToastProvider } from '../../../components/toast.js';
import { createToastStore } from '../../../lib/toast.js';
import { createQueryClient } from '../../../query-client.js';
import { EMPTY_CATALOGUE_FILTER, filterDefinitions, filterTemplates } from './definition-fields.js';
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

let responses: Record<string, unknown>;
let calls: Array<{ url: string; method: string; body: unknown }>;

beforeEach(() => {
  calls = [];
  responses = {
    '/api/v1/indexer': [
      indexer({}),
      indexer({ id: 2, name: 'Geek', implementation: 'newznab', protocol: 'usenet', priority: 3, status: { failureCount: 2 } }),
      indexer({ id: 3, name: 'Old', enableRss: false, enableAutomaticSearch: false, enableInteractiveSearch: false }),
    ],
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

describe('indexer chooser filters', () => {
  it('filters definitions and endpoint templates by search text', () => {
    expect(filterDefinitions(definitions, { ...EMPTY_CATALOGUE_FILTER, text: 'members' }).map((d) => d.id)).toEqual(['privtracker']);
    expect(filterDefinitions(definitions, { ...EMPTY_CATALOGUE_FILTER, text: 'de-de usenet' }).map((d) => d.id)).toEqual(['nzbsite']);
    expect(filterDefinitions(definitions, { ...EMPTY_CATALOGUE_FILTER, text: '' }).map((d) => d.name)).toEqual(['NzbSite', 'PrivTracker', 'YTS']);
    const templates = [template('torznab'), template('newznab'), { ...template('torznab'), implementation: 'definition' as const }];
    expect(filterTemplates(templates, 'newz').map((t) => t.implementation)).toEqual(['newznab']);
    expect(filterTemplates(templates, 'usenet').map((t) => t.implementation)).toEqual(['newznab']);
    expect(filterTemplates(templates, '')).toHaveLength(2);
  });

  it('narrows both chooser tabs as the user types in the search field', async () => {
    const dialog = await openChooser();
    const endpoints = await within(dialog).findByRole('list', { name: 'Endpoint types' });
    expect(within(endpoints).getAllByRole('button')).toHaveLength(2);
    fireEvent.change(within(dialog).getByRole('searchbox', { name: 'Search indexers' }), { target: { value: 'torz' } });
    expect(within(endpoints).getAllByRole('button').map((b) => b.getAttribute('aria-label'))).toEqual(['Add Torznab']);

    fireEvent.click(within(dialog).getByRole('tab', { name: 'Catalogue' }));
    fireEvent.change(within(dialog).getByRole('searchbox', { name: 'Search indexers' }), { target: { value: 'members' } });
    const list = await within(dialog).findByRole('list', { name: 'Definitions' });
    expect(within(list).getAllByRole('button').map((b) => b.getAttribute('aria-label'))).toEqual(['Add PrivTracker']);
    fireEvent.change(within(dialog).getByRole('searchbox', { name: 'Search indexers' }), { target: { value: 'nothing-like-this' } });
    expect(await within(dialog).findByText('No definitions match')).toBeTruthy();
  });

  it('shows a privacy chip and protocol badge on every catalogue row', async () => {
    const dialog = await openChooser();
    fireEvent.click(within(dialog).getByRole('tab', { name: 'Catalogue' }));
    const list = await within(dialog).findByRole('list', { name: 'Definitions' });
    const row = (name: string) => within(list).getByRole('button', { name: `Add ${name}` });
    expect(within(row('YTS')).getByText('Public').className).toContain('al-chip');
    expect(within(row('YTS')).getByText('TOR').className).toContain('al-proto');
    expect(within(row('PrivTracker')).getByText('Private')).toBeTruthy();
    expect(within(row('PrivTracker')).getByText('Untested')).toBeTruthy();
    expect(within(row('NzbSite')).getByText('Semi-private')).toBeTruthy();
    expect(within(row('NzbSite')).getByText('NZB')).toBeTruthy();
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

  it('maps status to chip tones with a cause', () => {
    const now = Date.parse('2026-10-26T12:00:00Z');
    expect(indexerHealth({ status: undefined }, now)).toEqual({ tone: 'accent', label: 'Enabled' });
    expect(indexerHealth({ status: { failureCount: 1 } }, now)).toMatchObject({ tone: 'danger', label: 'Failed · 1 recent failure' });
    const backoff = indexerHealth({ status: { failureCount: 3, disabledTill: '2026-10-26T13:00:00Z' } }, now);
    expect(backoff.tone).toBe('warn');
    expect(backoff.label).toMatch(/^Backing off · retry \d\d:\d\d$/);
    expect(indexerHealth({ status: undefined, enableRss: false, enableAutomaticSearch: false, enableInteractiveSearch: false }, now)).toEqual({ tone: 'muted', label: 'Disabled' });
  });

  it('opens the 640 editor with stacked fields from a template', async () => {
    const dialog = await openChooser();
    fireEvent.click(await within(dialog).findByRole('button', { name: 'Add Torznab' }));
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
