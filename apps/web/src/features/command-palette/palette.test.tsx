import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { QueryClientProvider } from '@tanstack/react-query';
import { RouterProvider, createMemoryHistory, createRootRoute, createRouter } from '@tanstack/react-router';
import type { MediaRequest, UniversalSearchResponse } from '@arclight/shared';
import { ToastProvider } from '../../components/toast.js';
import { createToastStore } from '../../lib/toast.js';
import { createQueryClient } from '../../query-client.js';
import { makeMovie, makeSeries } from '../../pages/library/test-fixtures.js';
import { UniversalSearch } from '../universal-search/universal-search.js';
import { CommandPaletteHost } from './palette.js';
import { registerPaletteContext } from './registry.js';

type Call = { path: string; search: string; method: string; body: unknown };

const universal: UniversalSearchResponse = {
  query: 'dune',
  results: [
    { kind: 'movie', total: 1, hits: [{ kind: 'movie', id: 1, title: 'Dune', subtitle: '2021', poster: null, status: 'missing', parentId: null, score: 1000 }] },
    { kind: 'indexer', total: 1, hits: [{ kind: 'indexer', id: 9, title: 'Dune Tracker', subtitle: 'Torznab', poster: null, status: 'enabled', parentId: null, score: 600 }] },
  ],
};

let calls: Call[];

const pendingRequest = (id: number): MediaRequest => ({
  id,
  type: 'movie',
  status: 'pending',
  is4k: false,
  mediaTmdbId: 600 + id,
  mediaTitle: `Title ${id}`,
  seasons: [],
  requestedBy: { id: 2, username: 'reader', displayName: 'Reader' },
  modifiedBy: null,
  tags: [],
  ignoreQuota: false,
  isAutoRequest: false,
  createdAt: '2026-10-25T10:00:00.000Z',
  updatedAt: '2026-10-25T10:00:00.000Z',
  mediaStatus: 'pending',
  canRemove: true,
});

function mockApi() {
  calls = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: string, init?: RequestInit) => {
      const url = new URL(input, 'http://localhost');
      const call = { path: url.pathname.replace('/api/v1', ''), search: url.search, method: init?.method ?? 'GET', body: init?.body ? JSON.parse(String(init.body)) : undefined };
      calls.push(call);
      const json = (v: unknown, status = 200) => new Response(JSON.stringify(v), { status, headers: { 'Content-Type': 'application/json' } });
      switch (`${call.method} ${call.path}`) {
        case 'GET /movie':
          return json([makeMovie({ id: 1, title: 'Dune', year: 2021 }), makeMovie({ id: 2, title: 'Dune: Part Two', year: 2024 })]);
        case 'GET /series':
          return json([makeSeries({ id: 3, title: 'Severance', year: 2022 })]);
        case 'POST /command/bulksearch':
          return json({ queued: 1, skipped: 0, job: null }, 202);
        case 'GET /request':
          return json({ pageInfo: { total: 2, take: 500, skip: 0 }, results: [11, 12].map((id) => pendingRequest(id)) });
        case 'POST /request/bulk/approve':
          return json({ ok: [11, 12], failed: [] });
        case 'GET /search/universal':
          return json(universal);
        default:
          return json({ error: 'not found' }, 404);
      }
    }),
  );
}

function renderWith(ui: () => React.ReactNode) {
  const toasts = createToastStore();
  const root = createRootRoute({ component: ui });
  const router = createRouter({ routeTree: root, history: createMemoryHistory({ initialEntries: ['/'] }) });
  render(
    <QueryClientProvider client={createQueryClient(toasts)}>
      <ToastProvider store={toasts}>
        <RouterProvider router={router} />
      </ToastProvider>
    </QueryClientProvider>,
  );
  return { router, toasts };
}

const typeInto = (input: HTMLElement, value: string) => fireEvent.change(input, { target: { value } });

describe('command palette', () => {
  beforeEach(() => {
    mockApi();
    localStorage.clear();
  });
  afterEach(() => vi.unstubAllGlobals());

  it('runs "upg dune" as an upgrade search for Dune and remembers it', async () => {
    const onClose = vi.fn();
    renderWith(() => <CommandPaletteHost open onClose={onClose} onShortcuts={() => {}} />);
    const palette = await screen.findByRole('dialog', { name: 'Command palette' });
    const input = within(palette).getByRole('combobox');
    typeInto(input, 'upg dune');
    const row = await within(palette).findByRole('option', { name: /Search for upgrades → Dune \(2021\)/ });
    expect(row.getAttribute('aria-selected')).toBe('true');
    fireEvent.keyDown(input, { key: 'Enter' });
    await waitFor(() => expect(calls.find((c) => c.path === '/command/bulksearch')?.body).toEqual({ mode: 'upgrade', movieIds: [1] }));
    expect(onClose).toHaveBeenCalled();
    expect(localStorage.getItem('arclight.palette.recent')).toContain('item.searchUpgrades');
  });

  it('asks for a name when the verb has none, then runs it', async () => {
    renderWith(() => <CommandPaletteHost open onClose={() => {}} onShortcuts={() => {}} />);
    const palette = await screen.findByRole('dialog', { name: 'Command palette' });
    const input = within(palette).getByRole('combobox');
    typeInto(input, 'search for upgrades');
    fireEvent.click(await within(palette).findByRole('option', { name: 'Search for upgrades…' }));
    typeInto(input, 'part two');
    fireEvent.click(await within(palette).findByRole('option', { name: /Dune: Part Two/ }));
    await waitFor(() => expect(calls.find((c) => c.path === '/command/bulksearch')?.body).toEqual({ mode: 'upgrade', movieIds: [2] }));
  });

  it('confirms bulk actions inside the palette before running them', async () => {
    const onClose = vi.fn();
    renderWith(() => <CommandPaletteHost open onClose={onClose} onShortcuts={() => {}} />);
    const palette = await screen.findByRole('dialog', { name: 'Command palette' });
    const input = within(palette).getByRole('combobox');
    typeInto(input, 'approve all');
    fireEvent.keyDown(input, { key: 'Enter' });
    const confirm = await within(palette).findByRole('option', { name: /^Approve every pending request\?/ });
    expect(onClose).not.toHaveBeenCalled();
    expect(calls.some((c) => c.path === '/request/bulk/approve')).toBe(false);
    expect(confirm.getAttribute('aria-selected')).toBe('true');
    fireEvent.keyDown(input, { key: 'Enter' });
    await waitFor(() => expect(calls.find((c) => c.path === '/request/bulk/approve')?.body).toEqual({ ids: [11, 12] }));
    expect(calls.find((c) => c.path === '/request')?.search).toContain('filter=pending');
  });

  it('goes back from the confirm step with Backspace', async () => {
    renderWith(() => <CommandPaletteHost open onClose={() => {}} onShortcuts={() => {}} />);
    const palette = await screen.findByRole('dialog', { name: 'Command palette' });
    const input = within(palette).getByRole('combobox');
    typeInto(input, 'search all missing');
    fireEvent.keyDown(input, { key: 'Enter' });
    await within(palette).findByRole('option', { name: /every missing movie/ });
    fireEvent.keyDown(input, { key: 'Backspace' });
    await within(palette).findByRole('option', { name: 'Add series' });
    expect(calls.some((c) => c.path === '/command/bulksearch')).toBe(false);
  });

  it('puts the page subject first when nothing is typed, and lists every command for "?"', async () => {
    const remove = registerPaletteContext({ subject: { kind: 'movie', id: 1, title: 'Dune' } });
    try {
      renderWith(() => <CommandPaletteHost open onClose={() => {}} onShortcuts={() => {}} />);
      const palette = await screen.findByRole('dialog', { name: 'Command palette' });
      const group = await within(palette).findByRole('group', { name: 'This page: Dune' });
      expect(within(group).getByRole('option', { name: /^Search for upgrades → Dune/ })).toBeTruthy();
      typeInto(within(palette).getByRole('combobox'), '?');
      expect(await within(palette).findByRole('group', { name: 'Navigate' })).toBeTruthy();
      expect(within(palette).getByRole('option', { name: 'Approve all pending requests' })).toBeTruthy();
    } finally {
      act(() => remove());
    }
  });

  it('passes the typed name to the add flow', async () => {
    const { router } = renderWith(() => <CommandPaletteHost open onClose={() => {}} onShortcuts={() => {}} />);
    const palette = await screen.findByRole('dialog', { name: 'Command palette' });
    const input = within(palette).getByRole('combobox');
    typeInto(input, 'add movie Blade Runner');
    await within(palette).findByRole('option', { name: 'Add movie “Blade Runner”' });
    fireEvent.keyDown(input, { key: 'Enter' });
    await waitFor(() => expect(router.state.location.pathname).toBe('/library/add'));
    expect(router.state.location.search).toEqual({ type: 'movie', term: 'Blade Runner' });
  });
});

describe('universal search', () => {
  beforeEach(() => mockApi());
  afterEach(() => vi.unstubAllGlobals());

  it('shows settings pages at once, server hits after the debounce, and opens a hit', async () => {
    const { router } = renderWith(() => <UniversalSearch open onClose={() => {}} openPalette={() => {}} onShortcuts={() => {}} debounceMs={0} discoverDebounceMs={0} />);
    const overlay = await screen.findByRole('dialog', { name: 'Search' });
    const input = within(overlay).getByRole('combobox');
    typeInto(input, 'download clients');
    const settings = await within(overlay).findByRole('group', { name: 'Settings' });
    expect(within(settings).getAllByRole('option')[0]?.textContent).toMatch(/^Download Clients/);
    typeInto(input, 'dune');
    const library = await within(overlay).findByRole('group', { name: 'Library' });
    expect(within(overlay).getByRole('group', { name: 'Settings' })).toBeTruthy();
    fireEvent.click(within(library).getByRole('option', { name: /^Dune/ }));
    await waitFor(() => expect(router.state.location.pathname).toBe('/library/movie/1'));
    expect(calls.filter((c) => c.path === '/search/universal').map((c) => c.search)).toContain('?q=dune');
  });

  it('hands actions that need a confirmation to the palette', async () => {
    const openPalette = vi.fn();
    renderWith(() => <UniversalSearch open onClose={() => {}} openPalette={openPalette} onShortcuts={() => {}} debounceMs={0} discoverDebounceMs={0} />);
    const overlay = await screen.findByRole('dialog', { name: 'Search' });
    typeInto(within(overlay).getByRole('combobox'), 'approve all');
    fireEvent.click(await within(overlay).findByRole('option', { name: /^Approve all pending requests/ }));
    expect(openPalette).toHaveBeenCalledWith('approve all');
  });
});
