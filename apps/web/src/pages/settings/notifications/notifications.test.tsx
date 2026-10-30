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
  { id: 1, name: 'Discord', implementation: 'discord', tags: [], settings: { webhookUrl: 'https://discord.test/hook', mentions: ['@here'] }, onGrab: true, onDownload: true, onHealthIssue: false },
];
const schemas = [
  {
    implementation: 'discord',
    implementationName: 'Discord',
    description: 'Post to a Discord channel',
    // The server's shape: names are keys of `settings`, list types have no widget of their own.
    fields: [
      { name: 'webhookUrl', label: 'Webhook URL', type: 'url', required: true, secret: true },
      { name: 'mentions', label: 'Mentions', type: 'textList', required: false, secret: false },
    ],
    template: {
      name: '',
      implementation: 'discord',
      tags: [],
      settings: {},
      onGrab: false,
      onDownload: false,
      onHealthIssue: false,
      onDownloadStalled: false,
      onKillSwitch: false,
      onDailySummary: false,
      supportsOnDailySummary: false,
      respectQuietHours: true,
    },
  },
];

const alertSettings = {
  quietHours: { enabled: true, start: '22:00', end: '07:00', days: [0, 1, 2, 3, 4, 5, 6] },
  dailySummary: { enabled: true, time: '08:00' },
  heldAlerts: 3,
  quietNow: true,
};

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
      else if (key === 'GET /api/v1/settings/alerts') body = alertSettings;
      else if (key === 'PUT /api/v1/settings/alerts') body = { ...(call.body as object), heldAlerts: 3, quietNow: true };
      if (body === undefined) return new Response(JSON.stringify({ error: 'not found' }), { status: 404 });
      return new Response(JSON.stringify(body), { status: 200 });
    }),
  );
});

afterEach(() => vi.unstubAllGlobals());

function renderPage(path = '/settings/notifications') {
  const toasts = createToastStore();
  const queryClient = createQueryClient(toasts);
  const root = createRootRoute();
  const route = createRoute({ getParentRoute: () => root, path: '/settings/notifications', component: NotificationsPage });
  const router = createRouter({ routeTree: root.addChildren([route]), history: createMemoryHistory({ initialEntries: [path] }) });
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

  it('searches connections by name, implementation and trigger', async () => {
    notifications.push({ id: 2, name: 'Pager', implementation: 'email', tags: [], settings: { webhookUrl: '', mentions: [] }, onGrab: false, onDownload: false, onHealthIssue: true });
    try {
      renderPage('/settings/notifications?q=health%20issue');
      const grid = await screen.findByRole('list', { name: 'Connections' });
      expect(await within(grid).findByRole('button', { name: 'Pager' })).toBeTruthy();
      expect(within(grid).queryByRole('button', { name: 'Discord' })).toBeNull();
      expect(screen.getByText('1 of 2')).toBeTruthy();
      const box = screen.getByRole('searchbox', { name: 'Search this list' });
      fireEvent.change(box, { target: { value: 'discord grab' } });
      fireEvent.keyDown(box, { key: 'Enter' });
      expect(await within(screen.getByRole('list', { name: 'Connections' })).findByRole('button', { name: 'Discord' })).toBeTruthy();
      fireEvent.change(box, { target: { value: 'slack' } });
      fireEvent.keyDown(box, { key: 'Enter' });
      fireEvent.click(await screen.findByRole('button', { name: 'Clear search' }));
      await waitFor(() => expect(screen.getByText('Pager')).toBeTruthy());
    } finally {
      notifications.pop();
    }
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

  it('edits settings fields and saves them under settings, lists as arrays', async () => {
    renderPage();
    fireEvent.click(await screen.findByRole('button', { name: 'Edit Discord' }));
    const dialog = await screen.findByRole('dialog', { name: 'Edit Discord' });
    expect((within(dialog).getByLabelText(/Webhook URL/) as HTMLInputElement).value).toBe('https://discord.test/hook');
    const mentions = within(dialog).getByLabelText(/Mentions/) as HTMLTextAreaElement;
    expect(mentions.value).toBe('@here');
    fireEvent.change(mentions, { target: { value: '@here\n@everyone' } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(calls.some((c) => c.method === 'PUT')).toBe(true));
    const body = calls.find((c) => c.method === 'PUT')!.body as Record<string, unknown>;
    expect(body.settings).toEqual({ webhookUrl: 'https://discord.test/hook', mentions: ['@here', '@everyone'] });
    expect(body).not.toHaveProperty('webhookUrl');
  });

  it('groups the download-problem triggers with their own labels, hiding unsupported ones', async () => {
    renderPage();
    fireEvent.click(await screen.findByRole('button', { name: 'Edit Discord' }));
    const dialog = await screen.findByRole('dialog', { name: 'Edit Discord' });
    const problems = within(dialog).getByRole('group', { name: 'Download problem events' });
    expect(within(problems).getAllByRole('checkbox').map((c) => c.closest('label')?.textContent)).toEqual(['Download stalled', 'Kill switch paused downloads']);
    // Not repeated in the general events group.
    expect(within(within(dialog).getByRole('group', { name: 'Events' })).queryByRole('checkbox', { name: /stalled/i })).toBeNull();
    fireEvent.click(within(problems).getByRole('checkbox', { name: 'Download stalled' }));
    fireEvent.click(within(dialog).getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(calls.some((c) => c.method === 'PUT')).toBe(true));
    const body = calls.find((c) => c.method === 'PUT')!.body as Record<string, unknown>;
    expect(body.onDownloadStalled).toBe(true);
    expect(body.onKillSwitch).not.toBe(true);
  });

  it('defaults Respect quiet hours on for rows saved without it, and saves the choice', async () => {
    renderPage();
    fireEvent.click(await screen.findByRole('button', { name: 'Edit Discord' }));
    const dialog = await screen.findByRole('dialog', { name: 'Edit Discord' });
    const quiet = within(dialog).getByRole('checkbox', { name: /Respect quiet hours/ }) as HTMLInputElement;
    expect(quiet.checked).toBe(true);
    expect(within(dialog).getByText(/held during quiet hours and sent as one batch/)).toBeTruthy();
    fireEvent.click(quiet);
    fireEvent.click(within(dialog).getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(calls.some((c) => c.method === 'PUT')).toBe(true));
    expect(calls.find((c) => c.method === 'PUT')!.body).toMatchObject({ respectQuietHours: false });
  });

  it('shows quiet-hours status and saves quiet hours and the daily summary', async () => {
    renderPage();
    const section = (await screen.findByText('Quiet hours are in effect now · 3 alerts held')).closest('section') as HTMLElement;
    expect(section.getAttribute('aria-label')).toBe('Quiet hours and daily summary');
    const start = within(section).getByLabelText('Start') as HTMLInputElement;
    expect(start.value).toBe('22:00');
    fireEvent.change(start, { target: { value: '23:30' } });
    const days = within(section).getByRole('group', { name: 'Days' });
    expect(within(days).getAllByRole('checkbox')).toHaveLength(7);
    fireEvent.click(within(days).getByRole('checkbox', { name: 'Sat' }));
    fireEvent.click(within(section).getByRole('switch', { name: 'Daily summary' }));
    fireEvent.click(within(section).getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(calls.some((c) => c.method === 'PUT' && c.url === '/api/v1/settings/alerts')).toBe(true));
    expect(calls.find((c) => c.method === 'PUT' && c.url === '/api/v1/settings/alerts')!.body).toEqual({
      quietHours: { enabled: true, start: '23:30', end: '07:00', days: [0, 1, 2, 3, 4, 5] },
      dailySummary: { enabled: false, time: '08:00' },
    });
    expect(await screen.findByText('Quiet hours and daily summary saved')).toBeTruthy();
  });

  it('blocks saving an invalid time', async () => {
    renderPage();
    const time = (await screen.findByLabelText('Summary time')) as HTMLInputElement;
    const section = time.closest('section') as HTMLElement;
    fireEvent.change(time, { target: { value: '' } });
    expect(within(section).getByText('Use HH:MM (24-hour)')).toBeTruthy();
    expect((within(section).getByRole('button', { name: 'Save' }) as HTMLButtonElement).disabled).toBe(true);
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
