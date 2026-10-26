import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { QueryClientProvider } from '@tanstack/react-query';
import { RouterProvider, createMemoryHistory, createRouter } from '@tanstack/react-router';
import { ToastProvider } from '../../components/toast.js';
import { createToastStore } from '../../lib/toast.js';
import { createQueryClient } from '../../query-client.js';
import { routeTree } from '../../router.js';
import { WIZARD_STEPS } from './setup-wizard.js';
import { I18nProvider, setLocale } from '../../i18n/index.js';

class FakeSocket {
  onopen = null;
  onmessage = null;
  onclose = null;
  close() {}
}

const admin = { id: 1, username: 'admin', role: 'admin', permissions: 2, createdAt: '2026-01-01T00:00:00.000Z', settings: {} };
const session = { user: admin, via: 'session', isAdmin: true };

type Step = { id: string; complete: boolean; optional: boolean };
let steps: Step[];
let folders: Array<{ id: number; path: string; mediaType: 'series' | 'movie'; freeSpaceBytes: number | null; accessible: boolean }>;
let calls: Array<{ url: string; method: string; body: unknown }>;
let completed: boolean;

beforeEach(() => {
  calls = [];
  completed = false;
  folders = [];
  steps = [
    { id: 'admin', complete: true, optional: false },
    { id: 'tmdb', complete: true, optional: false },
    { id: 'rootFolders', complete: false, optional: false },
    { id: 'downloadClient', complete: false, optional: true },
    { id: 'indexer', complete: false, optional: true },
  ];
  vi.stubGlobal('WebSocket', FakeSocket);
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init?: RequestInit) => {
      const method = init?.method ?? 'GET';
      const body = init?.body ? JSON.parse(String(init.body)) : undefined;
      const path = url.split('?')[0]!;
      calls.push({ url: path, method, body });
      const json = (b: unknown, status = 200) => new Response(JSON.stringify(b), { status });
      if (path === '/api/v1/auth/status') return json({ needsSetup: !completed, authMethod: 'forms', authenticated: true, session });
      if (path === '/api/v1/auth/me') return json(session);
      if (path === '/api/v1/setup/status') return json({ needsSetup: true, steps });
      if (path === '/api/v1/rootfolder' && method === 'GET') return json(folders);
      if (path === '/api/v1/filesystem') {
        return json({ path: '/media', parent: '/', directories: [{ name: 'tv', path: '/media/tv', type: 'directory' }, { name: 'movies', path: '/media/movies', type: 'directory' }], files: [] });
      }
      if (path === '/api/v1/setup/rootfolder' && method === 'POST') {
        const f = { id: folders.length + 1, path: body.path, mediaType: body.mediaType, freeSpaceBytes: 512 * 1024 ** 3, accessible: true };
        folders = [...folders, f];
        return json(f, 201);
      }
      if (path === '/api/v1/setup/admin' && method === 'POST') {
        steps = steps.map((s) => (s.id === 'admin' ? { ...s, complete: true } : s));
        return json(session, 201);
      }
      if (path === '/api/v1/user/me' && method === 'PUT') return json({ ...admin, settings: body.settings });
      if (path === '/api/v1/setup/complete' && method === 'POST') {
        completed = true;
        return json({ needsSetup: false, steps });
      }
      return json({ error: 'not found' }, 404);
    }),
  );
});
afterEach(async () => {
  vi.unstubAllGlobals();
  localStorage.clear();
  await setLocale('en');
});

function renderSetup() {
  const toasts = createToastStore();
  const queryClient = createQueryClient(toasts);
  const router = createRouter({ routeTree, context: { queryClient }, history: createMemoryHistory({ initialEntries: ['/setup'] }) });
  render(
    <QueryClientProvider client={queryClient}>
      <I18nProvider>
        <ToastProvider store={toasts}>
          <RouterProvider router={router} />
        </ToastProvider>
      </I18nProvider>
    </QueryClientProvider>,
  );
  return router;
}

describe('setup wizard (Page 08)', () => {
  it('has six steps ending with VPN, drawn as a diamond stepper with the current step marked', async () => {
    expect(WIZARD_STEPS.map((s) => s.label)).toEqual(['Admin', 'TMDB', 'Root folders', 'Download client', 'Indexer', 'VPN']);
    renderSetup();
    await screen.findByRole('heading', { name: 'Where is your media stored?' });
    const stepper = screen.getByRole('list', { name: 'Setup steps' });
    const items = within(stepper).getAllByRole('listitem');
    expect(items.map((li) => li.getAttribute('data-state'))).toEqual(['done', 'done', 'active', 'todo', 'todo', 'todo']);
    expect(items[2]!.getAttribute('aria-current')).toBe('step');
    expect(screen.getByText(/Step/).textContent).toBe('Step 3 of 6');
    // One chamfered card per step.
    expect(document.querySelectorAll('[data-chamfer]')).toHaveLength(1);
  });

  it('adds root folders from the path picker and blocks Continue until one exists', async () => {
    renderSetup();
    await screen.findByRole('heading', { name: 'Where is your media stored?' });
    expect(await screen.findByRole('option', { name: /movies/ })).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Continue' }));
    expect((await screen.findByRole('alert')).textContent).toContain('Add at least one root folder.');

    fireEvent.change(screen.getByLabelText('TV root folder'), { target: { value: '/media/tv' } });
    fireEvent.click(screen.getByRole('button', { name: 'Add' }));
    await waitFor(() => expect(calls.find((c) => c.url === '/api/v1/setup/rootfolder')?.body).toEqual({ path: '/media/tv', mediaType: 'series', createIfMissing: true }));
    const row = (await screen.findByText('/media/tv', { selector: '.wiz-added__path' })).closest('li') as HTMLElement;
    expect(within(row).getByText('512 GB')).toBeTruthy();
    expect(within(row).getByRole('button', { name: 'Remove /media/tv' })).toBeTruthy();
    // The next folder defaults to the other kind.
    expect(screen.getByLabelText('Movies root folder')).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: 'Continue' }));
    expect(await screen.findByRole('heading', { name: 'Add a download client' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Back' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Skip for now' })).toBeTruthy();
  });

  it('skips the optional steps and finishes setup from the VPN step', async () => {
    folders = [{ id: 1, path: '/media/tv', mediaType: 'series', freeSpaceBytes: null, accessible: true }];
    steps = steps.map((s) => (s.id === 'rootFolders' ? { ...s, complete: true } : s));
    const router = renderSetup();
    await screen.findByRole('heading', { name: 'Add a download client' });
    fireEvent.click(screen.getByRole('button', { name: 'Skip for now' }));
    await screen.findByRole('heading', { name: 'Add an indexer' });
    fireEvent.click(screen.getByRole('button', { name: 'Skip for now' }));
    await screen.findByRole('heading', { name: 'Protect downloads with a VPN' });
    expect(screen.getByText(/Step/).textContent).toBe('Step 6 of 6');
    fireEvent.click(screen.getByRole('button', { name: 'Finish setup' }));
    await waitFor(() => expect(calls.find((c) => c.url === '/api/v1/setup/complete')?.body).toEqual({ authMethod: 'forms' }));
    await waitFor(() => expect(router.state.location.pathname).toBe('/'));
  });

  it('offers the UI language on the first step and keeps it on the new admin account', async () => {
    steps = steps.map((s) => (s.id === 'admin' ? { ...s, complete: false } : s));
    renderSetup();
    await screen.findByRole('heading', { name: 'Create the admin account' });
    const select = screen.getByLabelText('Language') as HTMLSelectElement;
    expect([...select.options].map((o) => o.value)).toEqual(['auto', 'en', 'de', 'fr', 'es', 'nl']);
    expect([...select.options].map((o) => o.text)).toContain('Deutsch · German');
    fireEvent.change(select, { target: { value: 'de' } });
    await waitFor(() => expect(document.documentElement.lang).toBe('de'));
    expect(localStorage.getItem('arclight.locale')).toBe('de');
    // The app remounts in the new language (placeholders until German is translated); the
    // picker keeps the device choice.
    expect(await screen.findByRole('heading', { name: '[de] Create the admin account' })).toBeTruthy();
    const picker = screen.getByLabelText('[de] Language') as HTMLSelectElement;
    expect(picker.value).toBe('de');
    const [password, confirm] = [...document.querySelectorAll<HTMLInputElement>('input[type=password]')];
    fireEvent.change(password!, { target: { value: 'correct horse battery' } });
    fireEvent.change(confirm!, { target: { value: 'correct horse battery' } });
    fireEvent.submit(picker.closest('form')!);
    await waitFor(() => expect(calls.find((c) => c.url === '/api/v1/user/me' && c.method === 'PUT')?.body).toEqual({ settings: { locale: 'de' } }));
  });

  it('goes back to a finished step from the stepper', async () => {
    renderSetup();
    await screen.findByRole('heading', { name: 'Where is your media stored?' });
    fireEvent.click(screen.getByRole('button', { name: 'Back' }));
    expect(await screen.findByRole('heading', { name: 'Connect TMDB' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Test key' })).toBeTruthy();
  });
});
