import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { QueryClientProvider } from '@tanstack/react-query';
import { RouterProvider, createMemoryHistory, createRouter } from '@tanstack/react-router';
import type { DownloadClientField, DownloadClientImplementationSchema, QueueItem } from '@arclight/shared';
import { ProtocolBadge } from '../../../components/protocol-badge.js';
import { ToastProvider } from '../../../components/toast.js';
import { createToastStore } from '../../../lib/toast.js';
import { createQueryClient } from '../../../query-client.js';
import { routeTree } from '../../../router.js';
import { downloadClientTestOutcome, sortedSchemas, toDownloadClientBody } from './download-clients-page.js';

class FakeSocket {
  onopen = null;
  onmessage = null;
  onclose = null;
  close() {}
}

const KINDS = [
  ['qbittorrent', 'qBittorrent', 'torrent', 'Free BitTorrent client with a WebUI.'],
  ['transmission', 'Transmission', 'torrent', 'Lightweight BitTorrent daemon over JSON RPC.'],
  ['deluge', 'Deluge', 'torrent', 'BitTorrent client driven through the Deluge Web UI.'],
  ['rtorrent', 'rTorrent', 'torrent', 'rTorrent over XML-RPC.'],
  ['sabnzbd', 'SABnzbd', 'usenet', 'Usenet (NZB) downloader with a web API.'],
  ['nzbget', 'NZBGet', 'usenet', 'Usenet (NZB) downloader over JSON-RPC.'],
] as const;

const commonFields: DownloadClientField[] = [
  { name: 'name', label: 'Name', type: 'text', helpText: 'A name.', required: true, advanced: false },
];

function settingsFieldsFor(kind: string): DownloadClientField[] {
  const fields: DownloadClientField[] = [
    { name: 'settings.host', label: 'Host', type: 'text', helpText: 'Hostname.', required: true, advanced: false, default: 'localhost' },
    { name: 'settings.port', label: 'Port', type: 'number', helpText: 'Port.', required: true, advanced: false, min: 1, max: 65535 },
  ];
  if (kind === 'sabnzbd') {
    fields.push({ name: 'settings.apiKey', label: 'API Key', type: 'password', helpText: 'SABnzbd API key.', required: false, advanced: false });
  } else {
    fields.push({ name: 'settings.password', label: 'Password', type: 'password', helpText: 'Password.', required: false, advanced: false });
  }
  return fields;
}

// Deliberately usenet-first to check the add dialog puts torrent clients first.
const schemas: DownloadClientImplementationSchema[] = [...KINDS]
  .reverse()
  .map(([implementation, implementationName, protocol, description]) => ({
    implementation,
    implementationName,
    protocol,
    description,
    fields: [...commonFields, ...settingsFieldsFor(implementation)],
    template: {
      name: implementationName,
      implementation,
      enable: true,
      protocol,
      priority: 1,
      removeCompletedDownloads: true,
      removeFailedDownloads: true,
      tags: [],
      settings: { host: 'localhost', port: 8080 },
    } as unknown as DownloadClientImplementationSchema['template'],
  }));

const builtinSchema: DownloadClientImplementationSchema = {
  implementation: 'builtin',
  implementationName: 'Built-in',
  protocol: 'torrent',
  description: '',
  fields: [
    ...commonFields,
    { name: 'settings.category', label: 'Category', type: 'text', helpText: 'Category.', required: false, advanced: false },
    { name: 'settings.categories', label: 'Categories', type: 'text', helpText: 'Per-category folders.', required: false, advanced: false },
    { name: 'settings.seedRatioLimit', label: 'Seed ratio limit', type: 'number', helpText: 'Ratio.', required: false, advanced: false, min: 0 },
    { name: 'settings.seedTimeLimitMinutes', label: 'Seed time limit', type: 'number', helpText: 'Minutes.', required: false, advanced: false, min: 0 },
  ],
  template: {
    name: 'Built-in',
    implementation: 'builtin',
    enable: true,
    protocol: 'torrent',
    priority: 1,
    removeCompletedDownloads: true,
    removeFailedDownloads: true,
    tags: [],
    settings: { category: 'tv', postImportCategory: '', savePath: '', categories: [{ name: 'tv', savePath: '/data/tv' }], initialState: 'start' },
  },
};

const queueItem = (over: Partial<QueueItem>): QueueItem => ({
  id: 1,
  downloadId: 'abc',
  downloadClientId: 1,
  downloadClientName: 'Client',
  title: 'Show.S01E01.1080p',
  status: 'downloading',
  trackedStatus: 'ok',
  statusMessages: [],
  protocol: 'torrent',
  sizeBytes: 1000,
  sizeLeftBytes: 500,
  progress: 0.5,
  added: '2026-10-25T10:00:00.000Z',
  trackedState: 'downloading',
  seriesId: 1,
  ...over,
});

const testRequests: unknown[] = [];
const saveRequests: unknown[] = [];

const responses: Record<string, unknown> = {
  '/api/v1/downloadclient': [],
  '/api/v1/downloadclient/schema': [...schemas, builtinSchema],
  '/api/v1/remotepathmapping': [],
  '/api/v1/tag': [],
  '/api/v1/queue/status': { totalCount: 2, errors: 0, warnings: 0, unknownCount: 0 },
};

beforeEach(() => {
  testRequests.length = 0;
  saveRequests.length = 0;
  vi.stubGlobal('WebSocket', FakeSocket);
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: string, init?: RequestInit) => {
      const url = String(input);
      const path = url.split('?')[0]!;
      if (path === '/api/v1/downloadclient/test' && init?.method === 'POST') {
        testRequests.push(JSON.parse(String(init.body)));
        return new Response(JSON.stringify({ ok: true, version: '4.3.1', warnings: [] }), { status: 200 });
      }
      if (path === '/api/v1/downloadclient' && init?.method === 'POST') {
        const body = JSON.parse(String(init.body));
        saveRequests.push(body);
        return new Response(JSON.stringify({ ...body, id: 9 }), { status: 201 });
      }
      if (path === '/api/v1/queue') {
        const records = [queueItem({ id: 1, protocol: 'usenet', title: 'Usenet.Release' }), queueItem({ id: 2, protocol: 'torrent', title: 'Torrent.Release' })];
        return new Response(
          JSON.stringify({ page: 1, pageSize: 20, sortKey: 'added', sortDirection: 'desc', totalRecords: 2, records }),
          { status: 200 },
        );
      }
      const body = responses[path];
      return body === undefined
        ? new Response(JSON.stringify({ error: 'not found' }), { status: 404 })
        : new Response(JSON.stringify(body), { status: 200 });
    }),
  );
});

afterEach(() => vi.unstubAllGlobals());

function renderAt(path: string) {
  const toasts = createToastStore();
  const queryClient = createQueryClient(toasts);
  const router = createRouter({ routeTree, context: { queryClient }, history: createMemoryHistory({ initialEntries: [path] }) });
  render(
    <QueryClientProvider client={queryClient}>
      <ToastProvider store={toasts}>
        <RouterProvider router={router} />
      </ToastProvider>
    </QueryClientProvider>,
  );
  return router;
}

async function openAddDialog() {
  renderAt('/settings/downloadclients');
  fireEvent.click(await screen.findByText('Add download client'));
  return screen.findByRole('dialog');
}

describe('download client settings', () => {
  it('lists all six kinds with descriptions and protocol badges in the add dialog', async () => {
    const dialog = await openAddDialog();
    for (const [, name, protocol, description] of KINDS) {
      const card = within(dialog).getByText(name).closest('button')!;
      expect(within(card).getByText(description)).toBeTruthy();
      expect(within(card).getByText(protocol)).toBeTruthy();
    }
  });

  it('orders torrent kinds before usenet kinds', () => {
    const sorted = sortedSchemas(schemas);
    expect(sorted.map((s) => s.protocol)).toEqual(['torrent', 'torrent', 'torrent', 'torrent', 'usenet', 'usenet']);
    expect(sorted).toHaveLength(6);
  });

  it('renders the form from the chosen kind template', async () => {
    const dialog = await openAddDialog();
    fireEvent.click(within(dialog).getByText('SABnzbd'));
    expect(await screen.findByRole('heading', { name: 'Add SABnzbd' })).toBeTruthy();
    expect(screen.getByLabelText(/API Key/)).toBeTruthy();
    expect((screen.getByLabelText(/^Host/) as HTMLInputElement).value).toBe('localhost');
  });

  it('tests a usenet client with its own implementation and settings', async () => {
    const dialog = await openAddDialog();
    fireEvent.click(within(dialog).getByText('NZBGet'));
    await screen.findByRole('heading', { name: 'Add NZBGet' });
    fireEvent.click(screen.getByRole('button', { name: 'Test' }));
    expect(await screen.findByText('Test passed')).toBeTruthy();
    expect(testRequests).toEqual([expect.objectContaining({ implementation: 'nzbget', protocol: 'usenet', settings: expect.objectContaining({ host: 'localhost' }) })]);
  });

  it('maps a test result to a test outcome', () => {
    expect(downloadClientTestOutcome({ ok: true, version: '4.0', apiVersion: '2.0', warnings: ['w'] })).toEqual({
      ok: true,
      message: 'version 4.0 (API 2.0)',
      warnings: ['w'],
      errors: [],
    });
    expect(downloadClientTestOutcome({ ok: false, warnings: [], error: { code: 'auth', message: 'bad key' } }).errors).toEqual(['bad key (auth)']);
  });

  it('shows Built-in with a description and edits the categories array', async () => {
    const dialog = await openAddDialog();
    const card = within(dialog).getByText('Built-in').closest('button')!;
    expect(within(card).getByText(/own BitTorrent engine/)).toBeTruthy();
    fireEvent.click(card);
    await screen.findByRole('heading', { name: 'Add Built-in' });
    expect(screen.queryByLabelText(/^Host/)).toBeNull();
    expect((screen.getByLabelText('Category 1 save path') as HTMLInputElement).value).toBe('/data/tv');

    fireEvent.click(screen.getByRole('button', { name: 'Add category' }));
    fireEvent.change(screen.getByLabelText('Category 2 name'), { target: { value: 'movies' } });
    fireEvent.change(screen.getByLabelText('Category 2 save path'), { target: { value: '/data/movies' } });
    fireEvent.click(screen.getByRole('button', { name: 'Add category' }));
    expect(screen.getByLabelText('Category 3 name')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Remove category 1' }));
    // Typing then clearing an optional number must not send '' or NaN.
    fireEvent.change(screen.getByLabelText(/^Seed ratio limit/), { target: { value: '1.5' } });
    fireEvent.change(screen.getByLabelText(/^Seed ratio limit/), { target: { value: '' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));

    await waitFor(() => expect(saveRequests).toHaveLength(1));
    const body = saveRequests[0] as { settings: Record<string, unknown> };
    expect(body.settings.categories).toEqual([{ name: 'movies', savePath: '/data/movies' }]);
    expect(body.settings).not.toHaveProperty('seedRatioLimit');
    expect(body.settings).not.toHaveProperty('seedTimeLimitMinutes');
  });

  it('omits empty optional numbers from the save body', () => {
    const fields = builtinSchema.fields;
    const body = toDownloadClientBody(
      { implementation: 'builtin', settings: { seedRatioLimit: '', seedTimeLimitMinutes: Number.NaN, categories: [{ name: ' tv ', savePath: '/tv' }, { name: '', savePath: '' }] } },
      fields,
    ) as unknown as { settings: Record<string, unknown> };
    expect(body.settings).toEqual({ categories: [{ name: 'tv', savePath: '/tv' }] });
  });

  it('drops the read-only id from the save body', () => {
    expect(toDownloadClientBody({ id: 3, name: 'SAB', implementation: 'sabnzbd' })).toEqual({ name: 'SAB', implementation: 'sabnzbd' });
  });
});

describe('protocol badges', () => {
  it('renders distinct badges for usenet and torrent', () => {
    render(
      <>
        <ProtocolBadge protocol="usenet" />
        <ProtocolBadge protocol="torrent" />
      </>,
    );
    expect(screen.getByText('usenet').className).toContain('badge-info');
    expect(screen.getByText('torrent').className).toContain('badge-ok');
  });

  it('shows a protocol badge per row in the queue', async () => {
    renderAt('/activity/queue');
    const usenetRow = (await screen.findByText('Usenet.Release')).closest('tr')!;
    const torrentRow = screen.getByText('Torrent.Release').closest('tr')!;
    expect(within(usenetRow).getByText('usenet').className).toContain('badge');
    expect(within(torrentRow).getByText('torrent').className).toContain('badge');
  });
});
