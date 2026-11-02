import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { QueryClientProvider } from '@tanstack/react-query';
import { ToastProvider } from '../../components/toast.js';
import { createToastStore } from '../../lib/toast.js';
import { createQueryClient } from '../../query-client.js';
import { PersonalDestinations, defaultEvents } from './personal-destinations.js';

type Call = { url: string; method: string; body: unknown };
let calls: Call[];
let enabled: boolean;
let destinations: Array<Record<string, unknown>>;

const ntfySchema = {
  implementation: 'ntfy',
  implementationName: 'ntfy',
  fields: [
    { name: 'topic', label: 'Topic', type: 'text', required: true, secret: false },
    { name: 'accessToken', label: 'Access token', type: 'password', required: false, secret: true },
  ],
  template: { name: '', implementation: 'ntfy', tags: [], settings: { serverUrl: 'https://ntfy.example.com' } },
};
const discordSchema = {
  implementation: 'discord',
  implementationName: 'Discord',
  fields: [{ name: 'webhookUrl', label: 'Webhook URL', type: 'url', required: true, secret: true }],
  template: { name: '', implementation: 'discord', tags: [], settings: {} },
};

const saved = {
  id: 4,
  userId: 7,
  name: 'My phone',
  implementation: 'ntfy',
  enabled: true,
  events: ['requestAvailable'],
  settings: { topic: 'arclight-me', accessToken: '********' },
  templates: {},
  quietHours: null,
  status: { consecutiveFailures: 1, lastError: 'Topic not found' },
  addedAt: '2026-10-01T00:00:00.000Z',
  updatedAt: '2026-10-01T00:00:00.000Z',
};

beforeEach(() => {
  calls = [];
  enabled = true;
  destinations = [{ ...saved }];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init?: RequestInit) => {
      const call: Call = { url, method: init?.method ?? 'GET', body: init?.body ? JSON.parse(String(init.body)) : undefined };
      calls.push(call);
      const key = `${call.method} ${url}`;
      let body: unknown;
      let status = 200;
      if (key === 'GET /api/v1/user/7/notification-destination/options') {
        body = { enabled, implementations: ['ntfy', 'discord'], events: ['requestApproved', 'requestAvailable', 'requestDeclined', 'issueUpdated', 'watchlistAvailable'], schemas: [ntfySchema, discordSchema] };
      } else if (key === 'GET /api/v1/user/7/notification-destination') body = destinations;
      else if (key === 'POST /api/v1/user/7/notification-destination') {
        body = { ...saved, ...(call.body as object), id: 5 };
        status = 201;
      } else if (key === 'PUT /api/v1/user/7/notification-destination/4') body = { ...saved, ...(call.body as object) };
      else if (key === 'DELETE /api/v1/user/7/notification-destination/4') {
        destinations = [];
        return new Response(null, { status: 204 });
      } else if (key === 'POST /api/v1/user/7/notification-destination/test') {
        body = (call.body as { id?: number }).id ? { ok: false, message: 'Topic not found', code: 'notFound' } : { ok: true };
      } else if (key === 'GET /api/v1/user/7/notification-destination/4/deliveries') {
        body = [{ id: 1, eventType: 'requestAvailable', title: 'Dune is available', state: 'failed', attempts: 3, error: 'Topic not found', test: false, at: '2026-10-30T10:00:00.000Z' }];
      } else if (key === 'GET /api/v1/notification/templates') body = { keys: ['default', 'grab', 'requestApproved', 'requestAvailable'], variables: [] };
      else if (key === 'POST /api/v1/notification/preview') body = { subject: 'Arclight', title: 'Dune is available', body: 'Enjoy', values: {} };
      if (body === undefined) return new Response(JSON.stringify({ error: 'not found' }), { status: 404 });
      return new Response(JSON.stringify(body), { status });
    }),
  );
});

afterEach(() => vi.unstubAllGlobals());

function renderPanel() {
  const toasts = createToastStore();
  render(
    <QueryClientProvider client={createQueryClient(toasts)}>
      <ToastProvider store={toasts}>
        <PersonalDestinations userId={7} />
      </ToastProvider>
    </QueryClientProvider>,
  );
}

describe('Personal notification destinations', () => {
  it('starts new destinations with the default events the user may pick', () => {
    expect(defaultEvents(['requestApproved', 'requestPending', 'watchlistAvailable'])).toEqual(['requestApproved', 'watchlistAvailable']);
  });

  it('lists destinations with their service, events and failure summary', async () => {
    renderPanel();
    expect(await screen.findByText('My phone')).toBeTruthy();
    expect(screen.getByText('My request is available')).toBeTruthy();
    expect(screen.getByText('Failing')).toBeTruthy();
    expect(screen.getByText('1 consecutive failure · last error: Topic not found')).toBeTruthy();
  });

  it('sends a test of a saved destination and shows the failure', async () => {
    renderPanel();
    await screen.findByText('My phone');
    fireEvent.click(screen.getByRole('button', { name: 'Send test' }));
    expect(await screen.findByText('Test failed')).toBeTruthy();
    expect(screen.getByText('Topic not found (notFound)')).toBeTruthy();
    expect(calls.find((c) => c.url.endsWith('/notification-destination/test'))!.body).toMatchObject({ id: 4, name: 'My phone', implementation: 'ntfy' });
  });

  it('adds a destination with the chosen service, fields and events', async () => {
    renderPanel();
    fireEvent.click(await screen.findByRole('button', { name: 'Add destination' }));
    const dialog = await screen.findByRole('dialog', { name: 'Add destination' });
    const service = within(dialog).getByLabelText('Service') as HTMLSelectElement;
    expect([...service.options].map((o) => o.textContent)).toEqual(['ntfy', 'Discord']);
    fireEvent.change(within(dialog).getByLabelText(/Topic/), { target: { value: 'my-topic' } });
    const events = within(dialog).getByRole('group', { name: 'Notify me about' });
    expect((within(events).getByRole('checkbox', { name: /New on my watchlist/ }) as HTMLInputElement).checked).toBe(true);
    fireEvent.click(within(events).getByRole('checkbox', { name: /My request was declined/ }));
    fireEvent.click(within(dialog).getByRole('button', { name: 'Send test' }));
    expect(await within(dialog).findByText('Test passed')).toBeTruthy();
    fireEvent.click(within(dialog).getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(calls.some((c) => c.method === 'POST' && c.url === '/api/v1/user/7/notification-destination')).toBe(true));
    const body = calls.find((c) => c.method === 'POST' && c.url === '/api/v1/user/7/notification-destination')!.body as Record<string, unknown>;
    expect(body).toMatchObject({
      name: 'ntfy',
      implementation: 'ntfy',
      enabled: true,
      settings: { serverUrl: 'https://ntfy.example.com', topic: 'my-topic' },
      events: ['requestApproved', 'requestAvailable', 'issueUpdated', 'watchlistAvailable'],
      quietHours: null,
      templates: {},
    });
    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Add destination' })).toBeNull());
  });

  it('switches the form when another service is picked', async () => {
    renderPanel();
    fireEvent.click(await screen.findByRole('button', { name: 'Add destination' }));
    const dialog = await screen.findByRole('dialog', { name: 'Add destination' });
    fireEvent.change(within(dialog).getByLabelText('Service'), { target: { value: 'discord' } });
    const next = await screen.findByRole('dialog', { name: 'Add destination' });
    expect((within(next).getByLabelText('Service') as HTMLSelectElement).value).toBe('discord');
    expect(within(next).getByLabelText(/Webhook URL/)).toBeTruthy();
    expect(within(next).queryByLabelText(/Topic/)).toBeNull();
  });

  it('edits own quiet hours and shows the delivery log of a saved destination', async () => {
    renderPanel();
    fireEvent.click(await screen.findByRole('button', { name: 'Edit My phone' }));
    const dialog = await screen.findByRole('dialog', { name: 'Edit My phone' });
    fireEvent.click(within(dialog).getByRole('tab', { name: 'Delivery log' }));
    expect(await within(dialog).findByText('Dune is available')).toBeTruthy();
    fireEvent.click(within(dialog).getByRole('tab', { name: 'Quiet hours' }));
    fireEvent.click(within(dialog).getByRole('radio', { name: 'Own quiet hours' }));
    fireEvent.click(within(dialog).getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(calls.some((c) => c.method === 'PUT')).toBe(true));
    expect(calls.find((c) => c.method === 'PUT')!.body).toMatchObject({
      settings: { topic: 'arclight-me', accessToken: '********' },
      quietHours: { enabled: true, start: '22:00', end: '07:00' },
    });
  });

  it('offers only template events the destination can get', async () => {
    renderPanel();
    fireEvent.click(await screen.findByRole('button', { name: 'Edit My phone' }));
    const dialog = await screen.findByRole('dialog', { name: 'Edit My phone' });
    fireEvent.click(within(dialog).getByRole('tab', { name: 'Templates' }));
    const event = (await within(dialog).findByLabelText('Event')) as HTMLSelectElement;
    expect([...event.options].map((o) => o.value)).toEqual(['default', 'requestApproved', 'requestAvailable']);
  });

  it('deletes a destination after confirming', async () => {
    renderPanel();
    fireEvent.click(await screen.findByRole('button', { name: 'Edit My phone' }));
    const dialog = await screen.findByRole('dialog', { name: 'Edit My phone' });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Delete' }));
    const confirm = await screen.findByRole('dialog', { name: 'Delete My phone?' });
    fireEvent.click(within(confirm).getByRole('button', { name: 'Delete destination' }));
    await waitFor(() => expect(calls.some((c) => c.method === 'DELETE' && c.url === '/api/v1/user/7/notification-destination/4')).toBe(true));
    expect(await screen.findByText('No destinations yet.')).toBeTruthy();
  });

  it('explains when the admin switched personal destinations off', async () => {
    enabled = false;
    renderPanel();
    expect(await screen.findByText(/turned off personal notification destinations/)).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Add destination' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Edit My phone' })).toBeNull();
  });
});
