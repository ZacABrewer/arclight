import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { QueryClientProvider } from '@tanstack/react-query';
import { RouterProvider, createMemoryHistory, createRootRoute, createRoute, createRouter } from '@tanstack/react-router';
import { ToastProvider } from '../../../components/toast.js';
import { createToastStore } from '../../../lib/toast.js';
import { createQueryClient } from '../../../query-client.js';
import { SecurityPage } from './security-page.js';

type Call = { url: string; method: string; body: unknown };
let calls: Call[];

const users = [
  { id: 1, username: 'admin', role: 'admin', permissions: 2, createdAt: '2026-01-01T00:00:00.000Z', settings: {}, lastLoginAt: '2026-10-25T10:00:00.000Z' },
  { id: 2, username: 'amy', role: 'user', permissions: 32, createdAt: '2026-01-01T00:00:00.000Z', settings: {} },
];
const sessions = [
  { id: 10, createdAt: '2026-10-20T10:00:00.000Z', expiresAt: '2026-11-20T10:00:00.000Z', lastSeenAt: '2026-10-25T10:00:00.000Z', userAgent: 'Firefox', ip: '192.168.1.20', current: true },
  { id: 11, createdAt: '2026-10-01T10:00:00.000Z', expiresAt: '2026-11-01T10:00:00.000Z', lastSeenAt: '2026-10-02T10:00:00.000Z', userAgent: 'Safari', ip: '10.0.0.7', current: false },
];

beforeEach(() => {
  calls = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init?: RequestInit) => {
      const call: Call = { url, method: init?.method ?? 'GET', body: init?.body ? JSON.parse(String(init.body)) : undefined };
      calls.push(call);
      const key = `${call.method} ${url}`;
      if (key === 'DELETE /api/v1/auth/sessions/11') return new Response(null, { status: 204 });
      let body: unknown;
      if (key === 'GET /api/v1/settings/security') body = { method: 'forms', requireForLocal: true, sessionDays: 30, apiKey: 'k' };
      else if (key === 'GET /api/v1/user') body = users;
      else if (key === 'GET /api/v1/auth/sessions') body = sessions;
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
  const routes = ['/settings/security', '/settings/users'].map((path) => createRoute({ getParentRoute: () => root, path, component: SecurityPage }));
  const router = createRouter({ routeTree: root.addChildren(routes), history: createMemoryHistory({ initialEntries: ['/settings/security'] }) });
  render(
    <QueryClientProvider client={queryClient}>
      <ToastProvider store={toasts}>
        <RouterProvider router={router} />
      </ToastProvider>
    </QueryClientProvider>,
  );
}

describe('Settings -> Security', () => {
  it('lists users in a dense table with a link to permissions', async () => {
    renderPage();
    const table = await screen.findByRole('table', { name: 'Users' });
    expect(await within(table).findByText('amy')).toBeTruthy();
    expect(within(table).getByText('Admin').classList.contains('al-chip')).toBe(true);
    expect(within(table).getByRole('button', { name: 'Delete amy' }).className).toContain('al-btn--danger');
    expect(screen.getByRole('link', { name: 'Permissions and quotas' }).getAttribute('href')).toBe('/settings/users');
  });

  it('shows sessions with mono IPs and revokes one behind a named confirm', async () => {
    renderPage();
    const table = await screen.findByRole('table', { name: 'Your sessions' });
    const ip = await within(table).findByText('10.0.0.7');
    expect(ip.closest('td')?.className ?? '').toMatch(/mono/);
    expect((within(table).getByRole('button', { name: 'Revoke session from 192.168.1.20' }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(within(table).getByRole('button', { name: 'Revoke session from 10.0.0.7' }));
    const confirm = await screen.findByRole('dialog', { name: 'Revoke session?' });
    fireEvent.click(within(confirm).getByRole('button', { name: 'Revoke session' }));
    await waitFor(() => expect(calls.some((c) => c.method === 'DELETE' && c.url === '/api/v1/auth/sessions/11')).toBe(true));
  });

  it('saves the authentication form through the unsaved-changes bar', async () => {
    renderPage();
    fireEvent.click(await screen.findByRole('switch', { name: 'Require for local addresses' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Save changes' }));
    await waitFor(() => expect(calls.some((c) => c.method === 'PUT' && c.url === '/api/v1/settings/security')).toBe(true));
    expect(calls.find((c) => c.method === 'PUT')!.body).toEqual({ method: 'forms', requireForLocal: false, sessionDays: 30 });
  });
});
