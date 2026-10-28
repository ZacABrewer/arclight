import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { QueryClientProvider } from '@tanstack/react-query';
import { RouterProvider, createMemoryHistory, createRootRoute, createRoute, createRouter } from '@tanstack/react-router';
import { SECRET_MASK } from '@arclight/shared';
import { ToastProvider } from '../../../components/toast.js';
import { createToastStore } from '../../../lib/toast.js';
import { createQueryClient } from '../../../query-client.js';
import { GeneralPage, metadataErrors, toMetadataUpdate } from './general-page.js';

type Call = { url: string; method: string; body: unknown };
let calls: Call[];
let apiKey: string;

beforeEach(() => {
  calls = [];
  apiKey = 'abc123def456';
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init?: RequestInit) => {
      const call: Call = { url, method: init?.method ?? 'GET', body: init?.body ? JSON.parse(String(init.body)) : undefined };
      calls.push(call);
      const key = `${call.method} ${url}`;
      let body: unknown;
      if (key === 'GET /api/v1/settings/metadata') body = { tmdbApiKey: SECRET_MASK, language: 'en-US', region: 'US' };
      else if (key === 'PUT /api/v1/settings/metadata') body = { tmdbApiKey: SECRET_MASK, language: 'fr-FR', region: 'FR' };
      else if (key === 'GET /api/v1/settings/security') body = { method: 'forms', requireForLocal: true, sessionDays: 30, apiKey };
      else if (key === 'POST /api/v1/settings/security/apikey') {
        apiKey = 'new-key-789';
        body = { apiKey };
      }
      if (body === undefined) return new Response(JSON.stringify({ error: 'not found' }), { status: 404 });
      return new Response(JSON.stringify(body), { status: 200 });
    }),
  );
});

afterEach(() => vi.unstubAllGlobals());

function renderPage() {
  const toasts = createToastStore();
  const queryClient = createQueryClient(toasts);
  const root = createRootRoute();
  const routes = [
    createRoute({ getParentRoute: () => root, path: '/settings/general', component: GeneralPage }),
    createRoute({ getParentRoute: () => root, path: '/system/backup', component: () => <p>Backups page</p> }),
  ];
  const router = createRouter({ routeTree: root.addChildren(routes), history: createMemoryHistory({ initialEntries: ['/settings/general'] }) });
  render(
    <QueryClientProvider client={queryClient}>
      <ToastProvider store={toasts}>
        <RouterProvider router={router} />
      </ToastProvider>
    </QueryClientProvider>,
  );
}

describe('metadata helpers', () => {
  it('keeps the stored key for the mask, clears on empty, replaces otherwise', () => {
    expect(toMetadataUpdate({ tmdbApiKey: SECRET_MASK, language: ' en-US ', region: 'us' })).toEqual({ language: 'en-US', region: 'US' });
    expect(toMetadataUpdate({ tmdbApiKey: '', language: 'en-US', region: 'US' }).tmdbApiKey).toBeNull();
    expect(toMetadataUpdate({ tmdbApiKey: ' k ', language: 'en-US', region: 'US' }).tmdbApiKey).toBe('k');
    expect(metadataErrors({ language: 'en', region: 'USA' }).region).toBe('Use a two-letter code');
  });
});

describe('Settings -> General', () => {
  it('shows the API key as a mono read-only field with Copy and a danger Regenerate behind a named confirm', async () => {
    renderPage();
    const input = (await screen.findByLabelText('API key')) as HTMLInputElement;
    expect(input.readOnly).toBe(true);
    expect(input.className).toMatch(/mono/);
    await waitFor(() => expect(input.value).not.toBe(''));
    const copy = screen.getByRole('button', { name: 'Copy' });
    expect(copy.className).toContain('al-btn--secondary');
    const regenerate = screen.getByRole('button', { name: 'Regenerate' });
    expect(regenerate.className).toContain('al-btn--danger');

    fireEvent.click(regenerate);
    const confirm = await screen.findByRole('dialog', { name: 'Regenerate API key?' });
    fireEvent.click(within(confirm).getByRole('button', { name: 'Regenerate API key' }));
    await waitFor(() => expect(calls.some((c) => c.method === 'POST' && c.url === '/api/v1/settings/security/apikey')).toBe(true));
    await waitFor(() => expect((screen.getByLabelText('API key') as HTMLInputElement).value).toBe('new-key-789'));
  });

  it('round-trips the masked TMDB key: an unchanged mask is omitted from the save', async () => {
    renderPage();
    const key = (await screen.findByLabelText(/TMDB API key/)) as HTMLInputElement;
    expect(key.type).toBe('password');
    expect(key.value).toBe('');
    expect(key.placeholder).toContain('unchanged');
    fireEvent.change(screen.getByLabelText(/Metadata language/), { target: { value: 'fr-FR' } });
    fireEvent.change(screen.getByLabelText(/Region/), { target: { value: 'fr' } });
    expect((await screen.findByRole('region', { name: 'Unsaved changes' })).textContent).toContain('2 unsaved changes');
    fireEvent.click(screen.getByRole('button', { name: 'Save changes' }));
    await waitFor(() => expect(calls.some((c) => c.method === 'PUT')).toBe(true));
    expect(calls.find((c) => c.method === 'PUT')!.body).toEqual({ language: 'fr-FR', region: 'FR' });
  });

  it('sends a newly typed TMDB key', async () => {
    renderPage();
    fireEvent.change(await screen.findByLabelText(/TMDB API key/), { target: { value: 'tmdb-new' } });
    fireEvent.click(await screen.findByRole('button', { name: 'Save changes' }));
    await waitFor(() => expect(calls.some((c) => c.method === 'PUT')).toBe(true));
    expect(calls.find((c) => c.method === 'PUT')!.body).toEqual({ language: 'en-US', region: 'US', tmdbApiKey: 'tmdb-new' });
  });

  it('shows the UI section (account-only without a user) and links to backups', async () => {
    renderPage();
    expect(await screen.findByText(/UI preferences belong to a user account/)).toBeTruthy();
    expect(screen.getByText('Theme')).toBeTruthy();
    const link = screen.getByRole('link', { name: 'Open backups' });
    expect(link.getAttribute('href')).toBe('/system/backup');
  });
});
