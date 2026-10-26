import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { QueryClientProvider } from '@tanstack/react-query';
import { RouterProvider, createMemoryHistory, createRootRoute, createRoute, createRouter } from '@tanstack/react-router';
import { TrackerAccountSettings, type Indexer } from '@arclight/shared';
import { ToastProvider } from '../../../components/toast.js';
import { createToastStore } from '../../../lib/toast.js';
import { createQueryClient } from '../../../query-client.js';
import { IndexersPage } from './indexers-page.js';
import { definitionHasAccount, parseHosts, showScrapeAccount, toTrackerBody, toTrackerDraft } from './tracker-account.js';

class FakeSocket {
  onopen = null;
  onmessage = null;
  onclose = null;
  close() {}
}

const indexer = (over: Partial<Indexer>): Indexer => ({
  id: 1,
  name: 'PrivTorznab',
  implementation: 'torznab',
  protocol: 'torrent',
  enableRss: true,
  enableAutomaticSearch: true,
  enableInteractiveSearch: true,
  priority: 25,
  tags: [],
  settings: { baseUrl: 'http://jackett', apiPath: '/api', categories: [], animeCategories: [] },
  ...over,
});

// Contract-parsed so defaults (hnrRule {}, announceHosts [], scrapeAccount true) are filled.
const account = TrackerAccountSettings.parse({ enabled: true, ratioRequired: 1, hnrRule: { minSeedHours: 72 }, announceHosts: ['tracker.example'] });

let calls: Array<{ url: string; method: string; body: unknown }>;

beforeEach(() => {
  calls = [];
  const responses: Record<string, unknown> = {
    '/api/v1/indexer': [indexer({}), indexer({ id: 2, name: 'Usenet', implementation: 'newznab', protocol: 'usenet' })],
    '/api/v1/indexer/schema': [],
    '/api/v1/indexer/categories': [],
    '/api/v1/indexerproxy': [],
    '/api/v1/tag': [],
    '/api/v1/indexer/1/tracker': account,
  };
  vi.stubGlobal('WebSocket', FakeSocket);
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init?: RequestInit) => {
      const method = init?.method ?? 'GET';
      const body = typeof init?.body === 'string' ? JSON.parse(init.body) : undefined;
      calls.push({ url, method, body });
      if (url === '/api/v1/indexer/1/tracker' && method === 'PUT') return new Response(JSON.stringify(TrackerAccountSettings.parse(body)), { status: 200 });
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

describe('tracker account model', () => {
  it('round-trips settings through the draft and leaves empty numbers out', () => {
    const draft = toTrackerDraft(TrackerAccountSettings.parse({ ...account, minBufferBytes: 10 * 1024 ** 3 }));
    expect(draft).toMatchObject({ enabled: true, ratioRequired: '1', minSeedHours: '72', minRatio: '', minBuffer: '10', announceHosts: 'tracker.example', scrapeAccount: true });
    const body = toTrackerBody({ ...draft, ratioRequired: '', minRatio: '1.5', announceHosts: 'A.example, b.example\na.example' });
    expect(body).toEqual({
      enabled: true,
      hnrRule: { minSeedHours: 72, minRatio: 1.5 },
      freeleechOnly: false,
      bufferTracking: false,
      minBufferBytes: 10 * 1024 ** 3,
      announceHosts: ['a.example', 'b.example'],
      scrapeAccount: true,
    });
    expect(TrackerAccountSettings.safeParse(body).success).toBe(true);
    expect(parseHosts('  \n')).toEqual([]);
  });

  it('shows the account-page switch only for definition indexers whose definition may have one', () => {
    expect(definitionHasAccount({ id: 'x' })).toBeUndefined();
    expect(definitionHasAccount({ hasAccount: false })).toBe(false);
    expect(definitionHasAccount({ account: { path: '/user.php' } })).toBe(true);
    expect(showScrapeAccount({ implementation: 'torznab' }, undefined)).toBe(false);
    expect(showScrapeAccount({ implementation: 'definition' }, { id: 'x' })).toBe(true);
    expect(showScrapeAccount({ implementation: 'definition' }, { hasAccount: false })).toBe(false);
  });
});

describe('indexer editor: Tracker account tab', () => {
  it('loads the account of a torrent indexer and saves it with PUT', async () => {
    renderPage();
    fireEvent.click(await screen.findByRole('button', { name: 'Edit PrivTorznab' }, { timeout: 5000 }));
    const editor = await screen.findByRole('dialog', { name: 'Edit PrivTorznab' });
    fireEvent.click(within(editor).getByRole('tab', { name: 'Tracker account' }));
    const form = await within(editor).findByRole('form', { name: 'Tracker account' }, { timeout: 5000 });
    expect((within(form).getByLabelText('Track this account') as HTMLInputElement).checked).toBe(true);
    expect((within(form).getByLabelText('Required ratio') as HTMLInputElement).value).toBe('1');
    expect((within(form).getByLabelText('Minimum seed time') as HTMLInputElement).value).toBe('72');
    // A Torznab endpoint has no definition, so no account page to read.
    expect(within(form).queryByLabelText('Read account page')).toBeNull();
    const save = within(form).getByRole('button', { name: 'Save tracker account' }) as HTMLButtonElement;
    expect(save.disabled).toBe(true);

    fireEvent.click(within(form).getByLabelText('Freeleech only'));
    fireEvent.change(within(form).getByLabelText('Minimum buffer'), { target: { value: '5' } });
    fireEvent.click(save);
    await waitFor(() => expect(calls.some((c) => c.method === 'PUT' && c.url === '/api/v1/indexer/1/tracker')).toBe(true));
    expect(calls.find((c) => c.method === 'PUT')!.body).toMatchObject({
      enabled: true,
      ratioRequired: 1,
      hnrRule: { minSeedHours: 72 },
      freeleechOnly: true,
      minBufferBytes: 5 * 1024 ** 3,
      announceHosts: ['tracker.example'],
    });
  });

  it('shows no tracker tab for a usenet indexer', async () => {
    renderPage();
    fireEvent.click(await screen.findByRole('button', { name: 'Edit Usenet' }, { timeout: 5000 }));
    const editor = await screen.findByRole('dialog', { name: 'Edit Usenet' });
    expect(within(editor).queryByRole('tab', { name: 'Tracker account' })).toBeNull();
    expect(calls.some((c) => c.url.includes('/tracker'))).toBe(false);
  });
});
