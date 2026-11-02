import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { QueryClientProvider } from '@tanstack/react-query';
import { RouterProvider, createMemoryHistory, createRootRoute, createRoute, createRouter } from '@tanstack/react-router';
import { ToastProvider } from '../../../components/toast.js';
import { createToastStore } from '../../../lib/toast.js';
import { createQueryClient } from '../../../query-client.js';
import { NotificationsPage, deliveryErrors, eventFlagTag, notificationTestOutcome } from './notifications-page.js';
import { notificationFormFields } from '../../../api/notifications.js';
import { SchemaForm } from '../../../components/forms/schema-form.js';
import { insertAt, setTemplate } from '../../../features/notifications/template-editor.js';
import { deliveryStatusSummary } from '../../../features/notifications/labels.js';

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
      onDownloadRejected: false,
      onKillSwitch: false,
      onDailySummary: false,
      supportsOnDailySummary: false,
      respectQuietHours: true,
    },
  },
];

const templateMeta = {
  keys: ['default', 'grab', 'import', 'requestApproved'],
  variables: [
    { name: 'mediaTitle', description: 'Title of the series or movie' },
    { name: 'quality', description: 'Release quality' },
  ],
};

const deliveries = [
  { id: 11, eventType: 'grab', title: 'Grabbed Severance S02E01', state: 'sent', attempts: 1, test: false, at: '2026-10-30T10:00:00.000Z' },
  { id: 10, eventType: 'import', title: 'Imported Dune', state: 'failed', attempts: 3, error: '401 Unauthorized', code: 'unauthorized', test: false, at: '2026-10-30T09:00:00.000Z' },
  { id: 9, eventType: 'test', title: 'Test message', state: 'held', attempts: 0, test: true, at: '2026-10-30T08:00:00.000Z' },
];

const users = [
  { id: 2, username: 'alex', displayName: 'Alex', role: 'user', permissions: 0, createdAt: '2026-01-01T00:00:00.000Z', settings: {} },
  { id: 3, username: 'sam', role: 'user', permissions: 0, createdAt: '2026-01-01T00:00:00.000Z', settings: {} },
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
      else if (key === 'GET /api/v1/notification/templates') body = templateMeta;
      else if (key === 'GET /api/v1/notification/1/deliveries') body = deliveries;
      else if (key === 'GET /api/v1/user') body = users;
      else if (key === 'POST /api/v1/notification/preview') {
        const req = call.body as { eventType: string; template?: { title?: string; body?: string } };
        const broken = req.template?.body?.includes('{{#');
        body = {
          subject: 'Arclight',
          title: broken ? 'Grabbed: Severance' : (req.template?.title ?? 'Grabbed: Severance').replace('{{mediaTitle}}', 'Severance'),
          body: req.template?.body ?? 'WEBDL-1080p',
          values: { mediaTitle: 'Severance', quality: 'WEBDL-1080p' },
          ...(broken ? { error: 'unclosed section' } : {}),
        };
      }
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
    expect(within(problems).getAllByRole('checkbox').map((c) => c.closest('label')?.textContent)).toEqual(['Download stalled', 'Download rejected (unsafe)', 'Kill switch paused downloads']);
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
      personalDestinations: true,
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

  it('switches personal destinations off for every user', async () => {
    renderPage();
    const toggle = (await screen.findByRole('switch', { name: 'Personal destinations' })) as HTMLInputElement;
    expect(toggle.checked).toBe(true);
    const section = toggle.closest('section') as HTMLElement;
    fireEvent.click(toggle);
    fireEvent.click(within(section).getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(calls.some((c) => c.method === 'PUT' && c.url === '/api/v1/settings/alerts')).toBe(true));
    expect(calls.find((c) => c.method === 'PUT' && c.url === '/api/v1/settings/alerts')!.body).toMatchObject({ personalDestinations: false });
  });

  it('saves media kind, quality and user filters', async () => {
    renderPage();
    fireEvent.click(await screen.findByRole('button', { name: 'Edit Discord' }));
    const dialog = await screen.findByRole('dialog', { name: 'Edit Discord' });
    fireEvent.click(within(dialog).getByRole('tab', { name: 'Filters' }));
    const kinds = within(dialog).getByRole('group', { name: 'Media kinds' });
    fireEvent.click(within(kinds).getByRole('checkbox', { name: 'Movies' }));
    const quality = within(dialog).getByPlaceholderText('Add a quality');
    fireEvent.change(quality, { target: { value: 'WEBDL-1080p' } });
    fireEvent.keyDown(quality, { key: 'Enter' });
    const people = await within(dialog).findByRole('group', { name: 'Users' });
    fireEvent.click(await within(people).findByRole('button', { name: 'Alex' }));
    expect(within(people).getByRole('button', { name: 'Alex' }).getAttribute('aria-pressed')).toBe('true');
    fireEvent.click(within(dialog).getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(calls.some((c) => c.method === 'PUT')).toBe(true));
    expect(calls.find((c) => c.method === 'PUT')!.body).toMatchObject({ filters: { mediaTypes: ['movie'], qualities: ['WEBDL-1080p'], users: [2] } });
  });

  it('edits a template per event with a live preview from the api', async () => {
    renderPage();
    fireEvent.click(await screen.findByRole('button', { name: 'Edit Discord' }));
    const dialog = await screen.findByRole('dialog', { name: 'Edit Discord' });
    fireEvent.click(within(dialog).getByRole('tab', { name: 'Templates' }));
    const event = (await within(dialog).findByLabelText('Event')) as HTMLSelectElement;
    expect([...event.options].map((o) => o.value)).toEqual(['default', 'grab', 'import', 'requestApproved']);
    fireEvent.change(event, { target: { value: 'grab' } });
    const title = within(dialog).getByLabelText(/^Title/) as HTMLInputElement;
    fireEvent.change(title, { target: { value: 'Got ' } });
    title.focus();
    title.setSelectionRange(4, 4);
    fireEvent.click(within(dialog).getByRole('button', { name: /\{\{mediaTitle\}\}/ }));
    expect(title.value).toBe('Got {{mediaTitle}}');
    const preview = within(dialog).getByRole('region', { name: 'Preview' });
    expect(await within(preview).findByText('Got Severance')).toBeTruthy();
    expect(calls.some((c) => c.url === '/api/v1/notification/preview' && (c.body as { eventType: string }).eventType === 'grab')).toBe(true);
    // A syntax problem comes back as preview.error.
    fireEvent.change(within(dialog).getByLabelText(/^Body/), { target: { value: '{{#episode}} oops' } });
    expect(await within(preview).findByText(/unclosed section/)).toBeTruthy();
    fireEvent.click(within(dialog).getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(calls.some((c) => c.method === 'PUT')).toBe(true));
    expect(calls.find((c) => c.method === 'PUT')!.body).toMatchObject({ templates: { grab: { title: 'Got {{mediaTitle}}', body: '{{#episode}} oops' } } });
  });

  it('saves own quiet hours, rate limit and attempts, blocking out-of-range numbers', async () => {
    renderPage();
    fireEvent.click(await screen.findByRole('button', { name: 'Edit Discord' }));
    const dialog = await screen.findByRole('dialog', { name: 'Edit Discord' });
    fireEvent.click(within(dialog).getByRole('tab', { name: 'Delivery' }));
    fireEvent.click(within(dialog).getByRole('radio', { name: 'Own quiet hours' }));
    fireEvent.change(within(dialog).getByLabelText('Start'), { target: { value: '21:00' } });
    fireEvent.change(within(dialog).getByLabelText('Messages per minute'), { target: { value: '10' } });
    const attempts = within(dialog).getByLabelText('Attempts per message');
    fireEvent.change(attempts, { target: { value: '9' } });
    expect(within(dialog).getByText('Use a whole number from 1 to 6.')).toBeTruthy();
    fireEvent.click(within(dialog).getByRole('button', { name: 'Save' }));
    expect(calls.some((c) => c.method === 'PUT')).toBe(false);
    fireEvent.change(attempts, { target: { value: '5' } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(calls.some((c) => c.method === 'PUT')).toBe(true));
    expect(calls.find((c) => c.method === 'PUT')!.body).toMatchObject({
      quietHours: { enabled: true, start: '21:00', end: '07:00' },
      rateLimitPerMinute: 10,
      maxAttempts: 5,
    });
  });

  it('shows the delivery log and the failure summary on the card', async () => {
    const row = notifications[0] as Record<string, unknown>;
    const wasEnabled = row.enabled;
    row.status = { consecutiveFailures: 2, lastError: '401 Unauthorized' };
    row.enabled = true;
    try {
      renderPage();
      const grid = await screen.findByRole('list', { name: 'Connections' });
      const card = (await within(grid).findByRole('button', { name: 'Discord' })).closest('.al-item-card') as HTMLElement;
      expect(within(card).getByText('Failing')).toBeTruthy();
      expect(within(card).getByText('2 consecutive failures · last error: 401 Unauthorized')).toBeTruthy();
      fireEvent.click(within(card).getByRole('button', { name: 'Edit Discord' }));
      const dialog = await screen.findByRole('dialog', { name: 'Edit Discord' });
      fireEvent.click(within(dialog).getByRole('tab', { name: 'Delivery log' }));
      expect(await within(dialog).findByText('Grabbed Severance S02E01')).toBeTruthy();
      expect(within(dialog).getByText('unauthorized: 401 Unauthorized')).toBeTruthy();
      expect(within(dialog).getByText('Sent')).toBeTruthy();
      expect(within(dialog).getByText('Held (quiet hours)')).toBeTruthy();
      expect(calls.some((c) => c.url === '/api/v1/notification/1/deliveries')).toBe(true);
    } finally {
      delete row.status;
      row.enabled = wasEnabled;
    }
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

describe('notification editor helpers', () => {
  it('shows the api failure text of a test', () => {
    expect(notificationTestOutcome({ ok: false, message: 'Webhook rejected', code: 'unauthorized' })).toEqual({ ok: false, warnings: [], errors: ['Webhook rejected (unauthorized)'] });
    expect(notificationTestOutcome({ ok: true })).toEqual({ ok: true, warnings: [], errors: [] });
  });

  it('validates the delivery numbers and quiet hours', () => {
    expect(deliveryErrors({ rateLimitPerMinute: 0, maxAttempts: 3, quietHours: null })).toEqual({});
    expect(Object.keys(deliveryErrors({ rateLimitPerMinute: 601, maxAttempts: 0, quietHours: { enabled: true, start: '25:00', end: '07:00', days: [] } })).sort()).toEqual([
      'maxAttempts',
      'quietHours',
      'rateLimitPerMinute',
    ]);
  });

  it('keeps templates tidy and inserts variables at the caret', () => {
    expect(setTemplate({ grab: { title: 'x' } }, 'grab', { title: '', body: '' })).toEqual({});
    expect(setTemplate({}, 'default', { title: 'Hi', body: '' })).toEqual({ default: { title: 'Hi' } });
    expect(insertAt('Hello world', '{{x}}', 6, 11)).toEqual({ text: 'Hello {{x}}', caret: 11 });
    expect(insertAt('abc', '!', null, null)).toEqual({ text: 'abc!', caret: 4 });
  });

  it('summarises a failing destination', () => {
    expect(deliveryStatusSummary({ consecutiveFailures: 0 })).toBeNull();
    expect(deliveryStatusSummary({ consecutiveFailures: 1 })).toBe('1 consecutive failure');
  });

  it('renders textarea fields and notes masked secret list entries', () => {
    const fields = notificationFormFields([
      { name: 'body', label: 'Body template', type: 'textarea', required: false, secret: false },
      { name: 'urls', label: 'Apprise URLs', type: 'textList', required: true, secret: true },
    ]);
    render(<SchemaForm fields={fields} values={{ settings: { body: 'Hello', urls: '********\n********' } }} onChange={() => {}} />);
    const body = screen.getByLabelText(/Body template/);
    expect(body.tagName).toBe('TEXTAREA');
    expect((body as HTMLTextAreaElement).value).toBe('Hello');
    expect(screen.getByLabelText(/Apprise URLs/).tagName).toBe('TEXTAREA');
    expect(screen.getByText(/Saved entries show as \*{8}/)).toBeTruthy();
  });
});
