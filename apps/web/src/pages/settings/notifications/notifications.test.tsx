import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { QueryClientProvider } from '@tanstack/react-query';
import { RouterProvider, createMemoryHistory, createRootRoute, createRoute, createRouter } from '@tanstack/react-router';
import { ToastProvider } from '../../../components/toast.js';
import { createToastStore } from '../../../lib/toast.js';
import { createQueryClient } from '../../../query-client.js';
import { NotificationsPage, eventFlagTag } from './notifications-page.js';

type Call = { url: string; method: string; body: unknown };
let calls: Call[];

const notifications = [
  { id: 1, name: 'Discord', implementation: 'discord', tags: [], settings: { webhookUrl: 'https://discord.test/hook' }, onGrab: true, onDownload: true, onHealthIssue: false },
];
const schemas = [
  {
    implementation: 'discord',
    implementationName: 'Discord',
    description: 'Post to a Discord channel',
    fields: [{ name: 'settings.webhookUrl', label: 'Webhook URL', type: 'text', required: true }],
    template: { name: '', implementation: 'discord', tags: [], settings: {}, onGrab: false, onDownload: false, onHealthIssue: false },
  },
];

beforeEach(() => {
  calls = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init?: RequestInit) => {
      const call: Call = { url, method: init?.method ?? 'GET', body: init?.body ? JSON.parse(String(init.body)) : undefined };
      calls.push(call);
      const key = `${call.method} ${url}`;
      let body: unknown;
      if (key === 'GET /api/v1/notification') body = notifications;
      else if (key === 'GET /api/v1/notification/schema') body = schemas;
      else if (key === 'GET /api/v1/tag') body = [];
      else if (key === 'POST /api/v1/notification/test') body = { ok: true };
      else if (key === 'PUT /api/v1/notification/1') body = { id: 1, ...(call.body as object) };
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
  const route = createRoute({ getParentRoute: () => root, path: '/settings/notifications', component: NotificationsPage });
  const router = createRouter({ routeTree: root.addChildren([route]), history: createMemoryHistory({ initialEntries: ['/settings/notifications'] }) });
  render(
    <QueryClientProvider client={queryClient}>
      <ToastProvider store={toasts}>
        <RouterProvider router={router} />
      </ToastProvider>
    </QueryClientProvider>,
  );
}

describe('Settings -> Notifications', () => {
  it('labels event flags in sentence case', () => {
    expect(eventFlagTag('onGrab')).toBe('On grab');
    expect(eventFlagTag('onHealthIssue')).toBe('On health issue');
  });

  it('draws a card per connection with its event tags and Test / Edit', async () => {
    renderPage();
    const grid = await screen.findByRole('list', { name: 'Connections' });
    const card = (await within(grid).findByRole('button', { name: 'Discord' })).closest('.al-item-card') as HTMLElement;
    expect(within(card).getByText('On grab').classList.contains('al-tag')).toBe(true);
    expect(within(card).getByText('On download')).toBeTruthy();
    expect(within(card).queryByText('On health issue')).toBeNull();
    fireEvent.click(within(card).getByRole('button', { name: 'Test' }));
    expect(await within(card).findByText('Test passed')).toBeTruthy();
    expect(calls.find((c) => c.url === '/api/v1/notification/test')!.body).toMatchObject({ id: 1, name: 'Discord', onGrab: true });
  });

  it('toggles event flag checkboxes in the editor and sends them on save', async () => {
    renderPage();
    fireEvent.click(await screen.findByRole('button', { name: 'Edit Discord' }));
    const dialog = await screen.findByRole('dialog', { name: 'Edit Discord' });
    const events = within(dialog).getByRole('group', { name: 'Events' });
    const grab = within(events).getByRole('checkbox', { name: 'On grab' }) as HTMLInputElement;
    const health = within(events).getByRole('checkbox', { name: 'On health issue' }) as HTMLInputElement;
    expect(grab.checked).toBe(true);
    expect(health.checked).toBe(false);
    expect(grab.classList.contains('al-check')).toBe(true);
    fireEvent.click(grab);
    fireEvent.click(health);
    expect(grab.checked).toBe(false);
    expect(health.checked).toBe(true);
    fireEvent.click(within(dialog).getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(calls.some((c) => c.method === 'PUT')).toBe(true));
    expect(calls.find((c) => c.method === 'PUT')!.body).toMatchObject({ onGrab: false, onDownload: true, onHealthIssue: true });
  });

  it('names the object in the delete confirm', async () => {
    renderPage();
    fireEvent.click(await screen.findByRole('button', { name: 'Edit Discord' }));
    const dialog = await screen.findByRole('dialog', { name: 'Edit Discord' });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Delete' }));
    const confirm = await screen.findByRole('dialog', { name: 'Delete Discord?' });
    expect(within(confirm).getByRole('button', { name: 'Delete notification' }).className).toContain('al-btn--danger-solid');
  });
});
