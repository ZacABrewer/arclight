import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { QueryClientProvider } from '@tanstack/react-query';
import { SoulseekSettings, type SoulseekDownload, type SoulseekSettingsResponse } from '@arclight/shared';
import { ToastProvider } from '../../../components/toast.js';
import { createToastStore } from '../../../lib/toast.js';
import { createQueryClient } from '../../../query-client.js';
import { folderName } from '../../library/music/soulseek-search.js';
import { SoulseekSection, soulseekChanges } from './soulseek-section.js';

let features: { music: boolean; audiobooks: boolean };
let stored: SoulseekSettingsResponse;
let downloads: SoulseekDownload[];
let calls: Array<{ url: string; method: string; body: unknown }>;

const download: SoulseekDownload = {
  id: 7,
  albumId: 1,
  artistId: 1,
  albumTitle: 'Test Album',
  artistName: 'Test Artist',
  username: 'flac-peer',
  directory: 'Music\\Test Artist - Test Album',
  fileCount: 3,
  totalSize: 60_000_000,
  qualityName: 'FLAC',
  status: 'failed',
  progress: 0.4,
  message: 'Transfer rejected by peer',
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
};

beforeEach(() => {
  calls = [];
  features = { music: true, audiobooks: false };
  stored = { ...SoulseekSettings.parse({}), enabled: true, host: 'slskd', apiKey: '********', downloadsPath: '/downloads/slskd' };
  downloads = [download];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init?: RequestInit) => {
      const method = init?.method ?? 'GET';
      const body = typeof init?.body === 'string' ? JSON.parse(init.body) : undefined;
      calls.push({ url, method, body });
      const json = (v: unknown) => new Response(JSON.stringify(v), { status: 200 });
      if (url === '/api/v1/settings/features') return json(features);
      if (url === '/api/v1/settings/soulseek') {
        if (method === 'PUT') stored = { ...stored, ...body };
        return json(stored);
      }
      if (url === '/api/v1/soulseek/test') return json({ ok: true, version: '0.22.0', loggedIn: true, message: 'Connected' });
      if (url === '/api/v1/soulseek/downloads') return json(downloads);
      if (url === '/api/v1/soulseek/downloads/7' && method === 'DELETE') {
        downloads = [];
        return new Response(null, { status: 204 });
      }
      return new Response(JSON.stringify({ error: 'not found' }), { status: 404 });
    }),
  );
});

afterEach(() => vi.unstubAllGlobals());

function renderSection() {
  const toasts = createToastStore();
  render(
    <QueryClientProvider client={createQueryClient(toasts)}>
      <ToastProvider store={toasts}>
        <SoulseekSection />
      </ToastProvider>
    </QueryClientProvider>,
  );
}

describe('SoulseekSection', () => {
  it('stays hidden while music is off', async () => {
    features = { music: false, audiobooks: false };
    renderSection();
    await waitFor(() => expect(calls.some((c) => c.url === '/api/v1/settings/features')).toBe(true));
    expect(screen.queryByText('Soulseek (slskd)')).toBeNull();
    expect(calls.some((c) => c.url === '/api/v1/settings/soulseek')).toBe(false);
  });

  it('saves only the changed fields and keeps the masked key out of the update', async () => {
    renderSection();
    const host = await screen.findByLabelText('Host');
    fireEvent.change(host, { target: { value: 'slskd.example.com' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(calls.find((c) => c.method === 'PUT')?.body).toEqual({ host: 'slskd.example.com' }));
  });

  it('tests the unsaved settings', async () => {
    renderSection();
    fireEvent.change(await screen.findByLabelText('Port'), { target: { value: '5031' } });
    fireEvent.click(screen.getByRole('button', { name: 'Test' }));
    expect(await screen.findByText(/Connected \(slskd 0\.22\.0\)/)).toBeTruthy();
    expect(calls.find((c) => c.url === '/api/v1/soulseek/test')?.body).toMatchObject({ port: 5031, host: 'slskd' });
  });

  it('lists downloads and removes one after confirming', async () => {
    renderSection();
    expect(await screen.findByText('Transfer rejected by peer')).toBeTruthy();
    expect(screen.getAllByText('Failed').length).toBeGreaterThan(0);
    fireEvent.click(screen.getAllByRole('button', { name: 'Remove download of Test Album' })[0]!);
    const dialog = await screen.findByRole('dialog');
    fireEvent.click(within(dialog).getByRole('button', { name: 'Remove' }));
    await waitFor(() => expect(calls.some((c) => c.method === 'DELETE' && c.url === '/api/v1/soulseek/downloads/7')).toBe(true));
    expect(await screen.findByText('No Soulseek downloads yet.')).toBeTruthy();
  });
});

describe('helpers', () => {
  it('soulseekChanges keeps only changed fields', () => {
    const base = SoulseekSettings.parse({});
    expect(soulseekChanges(base, { ...base, port: 6000, autoSearch: true })).toEqual({ port: 6000, autoSearch: true });
    expect(soulseekChanges(base, base)).toEqual({});
  });

  it('folderName reads the last segment of either separator', () => {
    expect(folderName('Music\\Artist - Album')).toBe('Artist - Album');
    expect(folderName('music/Artist/Album/')).toBe('Album');
  });
});
