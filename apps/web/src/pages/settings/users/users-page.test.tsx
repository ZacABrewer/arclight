import { afterEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { QueryClientProvider } from '@tanstack/react-query';
import { RouterProvider, createMemoryHistory, createRootRoute, createRoute, createRouter } from '@tanstack/react-router';
import { ToastProvider } from '../../../components/toast.js';
import { createToastStore } from '../../../lib/toast.js';
import { createQueryClient } from '../../../query-client.js';
import { stubApi } from '../../../test/route-harness.js';
import { UsersPage } from './users-page.js';

afterEach(() => vi.unstubAllGlobals());

const users = [
  { id: 1, username: 'admin', role: 'admin', permissions: 2, createdAt: '2026-01-01T00:00:00.000Z', settings: {} },
  { id: 2, username: 'amy', displayName: 'Amy Pond', role: 'user', permissions: 32, createdAt: '2026-01-01T00:00:00.000Z', settings: {} },
  { id: 3, username: 'rory', role: 'user', permissions: 32, createdAt: '2026-01-01T00:00:00.000Z', settings: {} },
];

function renderPage(path: string) {
  stubApi({ '/api/v1/user': users });
  const toasts = createToastStore();
  const root = createRootRoute();
  const routes = ['/settings/users', '/settings/security'].map((p) => createRoute({ getParentRoute: () => root, path: p, component: UsersPage }));
  const router = createRouter({ routeTree: root.addChildren(routes), history: createMemoryHistory({ initialEntries: [path] }) });
  render(
    <QueryClientProvider client={createQueryClient(toasts)}>
      <ToastProvider store={toasts}>
        <RouterProvider router={router} />
      </ToastProvider>
    </QueryClientProvider>,
  );
}

describe('Settings → Users search', () => {
  it('filters by username, display name and role with "N of M"', async () => {
    renderPage('/settings/users?q=pond');
    const table = await screen.findByRole('table', { name: 'Users' });
    await waitFor(() => expect(within(table).getAllByRole('row')).toHaveLength(2));
    expect(within(table).getByText('Amy Pond')).toBeTruthy();
    expect(screen.getByText('1 of 3')).toBeTruthy();
    const box = screen.getByRole('searchbox', { name: 'Search this list' });
    fireEvent.change(box, { target: { value: 'admin' } });
    fireEvent.keyDown(box, { key: 'Enter' });
    await waitFor(() => expect(screen.getByText('1 of 3')).toBeTruthy());
    expect(within(screen.getByRole('table', { name: 'Users' })).getByText('admin')).toBeTruthy();
  });

  it('clears a search that matches nobody', async () => {
    renderPage('/settings/users?q=nobody-here');
    fireEvent.click(await screen.findByRole('button', { name: 'Clear search' }));
    const table = await screen.findByRole('table', { name: 'Users' });
    await waitFor(() => expect(within(table).getAllByRole('row')).toHaveLength(4));
  });
});
