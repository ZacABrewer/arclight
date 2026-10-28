import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { QueryClientProvider } from '@tanstack/react-query';
import { RouterProvider, createMemoryHistory, createRootRoute, createRoute, createRouter } from '@tanstack/react-router';
import type { FeatureSettings, Indexer, IndexerCategory } from '@arclight/shared';
import { ToastProvider } from '../../../components/toast.js';
import { createToastStore } from '../../../lib/toast.js';
import { createQueryClient } from '../../../query-client.js';
import { indexerFields } from './indexer-fields.js';
import { IndexersPage } from './indexers-page.js';

// Music / audiobook category pickers in the Torznab/Newznab editor, gated on the feature flags.

class FakeSocket {
  onopen = null;
  onmessage = null;
  onclose = null;
  close() {}
}

const categories: IndexerCategory[] = [
  { id: 2000, name: 'Movies', subCategories: [{ id: 2040, name: 'Movies/HD' }] },
  {
    id: 3000,
    name: 'Audio',
    subCategories: [
      { id: 3010, name: 'Audio/MP3' },
      { id: 3030, name: 'Audio/Audiobook' },
      { id: 3040, name: 'Audio/Lossless' },
    ],
  },
];

const jackett: Indexer = {
  id: 1,
  name: 'Jackett',
  implementation: 'torznab',
  protocol: 'torrent',
  enableRss: true,
  enableAutomaticSearch: true,
  enableInteractiveSearch: true,
  priority: 12,
  tags: [],
  settings: {
    baseUrl: 'http://jackett.example.invalid',
    apiPath: '/api',
    categories: [2000],
    animeCategories: [],
    musicCategories: [3010],
    audiobookCategories: [3030],
  },
};

let features: FeatureSettings;
let calls: Array<{ url: string; method: string; body: unknown }>;

beforeEach(() => {
  calls = [];
  features = { music: false, audiobooks: false };
  vi.stubGlobal('WebSocket', FakeSocket);
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init?: RequestInit) => {
      const method = init?.method ?? 'GET';
      const body = typeof init?.body === 'string' ? JSON.parse(init.body) : undefined;
      calls.push({ url, method, body });
      const responses: Record<string, unknown> = {
        '/api/v1/indexer': [jackett],
        '/api/v1/indexer/categories': categories,
        '/api/v1/indexer/schema': [],
        '/api/v1/indexer/definition': [],
        '/api/v1/indexerproxy': [],
        '/api/v1/tag': [],
        '/api/v1/settings/features': features,
      };
      if (url === '/api/v1/indexer/1' && method === 'PUT') return new Response(JSON.stringify({ ...jackett, ...body }), { status: 200 });
      const found = responses[url];
      return found === undefined ? new Response(JSON.stringify({ error: 'not found' }), { status: 404 }) : new Response(JSON.stringify(found), { status: 200 });
    }),
  );
});

afterEach(() => vi.unstubAllGlobals());

function renderPage() {
  const toasts = createToastStore();
  const queryClient = createQueryClient(toasts);
  const root = createRootRoute();
  const route = createRoute({ getParentRoute: () => root, path: '/settings/indexers', component: IndexersPage });
  const router = createRouter({ routeTree: root.addChildren([route]), history: createMemoryHistory({ initialEntries: ['/settings/indexers'] }) });
  render(
    <QueryClientProvider client={queryClient}>
      <ToastProvider store={toasts}>
        <RouterProvider router={router} />
      </ToastProvider>
    </QueryClientProvider>,
  );
}

async function openEditor(): Promise<HTMLElement> {
  renderPage();
  fireEvent.click(await screen.findByRole('button', { name: 'Edit Jackett' }));
  return screen.findByRole('dialog', { name: 'Edit Jackett' });
}

describe('indexerFields', () => {
  const names = (f: ReturnType<typeof indexerFields>) => f.map((x) => x.name);

  it('leaves the audio pickers out while the features are off', () => {
    expect(names(indexerFields('torznab'))).not.toContain('settings.musicCategories');
    expect(names(indexerFields('newznab', { music: false, audiobooks: false }))).not.toContain('settings.audiobookCategories');
  });

  it('adds each picker after the existing category fields when its feature is on', () => {
    const music = names(indexerFields('torznab', { music: true }));
    expect(music).toContain('settings.musicCategories');
    expect(music).not.toContain('settings.audiobookCategories');
    expect(music.indexOf('settings.musicCategories')).toBe(music.indexOf('settings.animeCategories') + 1);
    const both = names(indexerFields('newznab', { music: true, audiobooks: true }));
    expect(both.slice(both.indexOf('settings.categories'), both.indexOf('settings.categories') + 4)).toEqual([
      'settings.categories',
      'settings.animeCategories',
      'settings.musicCategories',
      'settings.audiobookCategories',
    ]);
  });
});

describe('indexer editor audio pickers', () => {
  it('hides both pickers when music and audiobooks are off', async () => {
    const editor = await openEditor();
    await waitFor(() => expect(calls.some((c) => c.url === '/api/v1/settings/features')).toBe(true));
    expect(within(editor).queryByText('Music categories')).toBeNull();
    expect(within(editor).queryByText('Audiobook categories')).toBeNull();
  });

  it('shows the music picker with the saved selection and saves changes', async () => {
    features = { music: true, audiobooks: false };
    const editor = await openEditor();
    await within(editor).findByText('Music categories');
    expect(within(editor).queryByText('Audiobook categories')).toBeNull();

    const trees = within(editor).getAllByRole('list', { name: 'Categories' });
    const musicTree = trees[trees.length - 1]!;
    const mp3 = within(musicTree).getByRole('checkbox', { name: /Audio\/MP3/ }) as HTMLInputElement;
    const lossless = within(musicTree).getByRole('checkbox', { name: /Audio\/Lossless/ }) as HTMLInputElement;
    expect(mp3.checked).toBe(true);
    expect(lossless.checked).toBe(false);
    fireEvent.click(lossless);

    fireEvent.click(within(editor).getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(calls.find((c) => c.method === 'PUT')).toBeTruthy());
    const put = calls.find((c) => c.method === 'PUT');
    expect(put?.url).toBe('/api/v1/indexer/1');
    expect(put?.body).toMatchObject({ settings: { categories: [2000], musicCategories: [3010, 3040], audiobookCategories: [3030] } });
  });

  it('shows the audiobook picker when audiobooks are on', async () => {
    features = { music: false, audiobooks: true };
    const editor = await openEditor();
    await within(editor).findByText('Audiobook categories');
    expect(within(editor).queryByText('Music categories')).toBeNull();
    const trees = within(editor).getAllByRole('list', { name: 'Categories' });
    const bookTree = trees[trees.length - 1]!;
    expect((within(bookTree).getByRole('checkbox', { name: /Audio\/Audiobook/ }) as HTMLInputElement).checked).toBe(true);
  });
});
