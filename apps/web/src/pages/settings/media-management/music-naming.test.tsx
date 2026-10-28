import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { QueryClientProvider } from '@tanstack/react-query';
import { RouterProvider, createMemoryHistory, createRouter } from '@tanstack/react-router';
import { NAMING_DEFAULTS } from '@arclight/shared';
import { MEDIA_MANAGEMENT_WIRE_DEFAULTS } from '../../../api/settings.js';
import { ToastProvider } from '../../../components/toast.js';
import { createToastStore } from '../../../lib/toast.js';
import { createQueryClient } from '../../../query-client.js';
import { routeTree } from '../../../router.js';
import { musicPreview, previewCaption, renderPreview } from './naming-preview.js';

class FakeSocket {
  onopen = null;
  onmessage = null;
  onclose = null;
  close() {}
}

let calls: Array<{ url: string; method: string; body: unknown }>;
let musicOn = true;

beforeEach(() => {
  calls = [];
  musicOn = true;
  vi.stubGlobal('WebSocket', FakeSocket);
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init?: RequestInit) => {
      const method = init?.method ?? 'GET';
      const body = init?.body ? JSON.parse(String(init.body)) : undefined;
      calls.push({ url, method, body });
      const json = (v: unknown) => new Response(JSON.stringify(v), { status: 200 });
      if (url === '/api/v1/settings/naming') return json(method === 'PUT' ? body : NAMING_DEFAULTS);
      if (url === '/api/v1/settings/mediamanagement') return json(MEDIA_MANAGEMENT_WIRE_DEFAULTS);
      if (url === '/api/v1/settings/features') return json({ music: musicOn, audiobooks: false });
      if (url === '/api/v1/settings/audio') return json({ trackMatchThreshold: 0.8 });
      if (url === '/api/v1/rootfolder') return json([]);
      return new Response(JSON.stringify({ error: 'not found' }), { status: 404 });
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
}

describe('music naming preview', () => {
  it('renders the music formats with FLAC samples', () => {
    expect(renderPreview(NAMING_DEFAULTS.artistFolderFormat, 'artistFolder')).toBe('Daft Punk');
    expect(renderPreview(NAMING_DEFAULTS.albumFolderFormat, 'albumFolder')).toBe('Discovery (2001)');
    expect(renderPreview(NAMING_DEFAULTS.trackFormat, 'track')).toBe('03 - Digital Love.flac');
    expect(renderPreview(NAMING_DEFAULTS.multiDiscTrackFormat, 'multiDiscTrack')).toBe('2-03 - Digital Love.flac');
    expect(renderPreview('{track:00} {Track Title} [{Quality Title}]', 'track')).toBe('03 Digital Love [FLAC].flac');
    expect(previewCaption('', 'track')).toBe('Enter a format to see a sample');
  });

  it('builds the full sample path for both multi-disc styles', () => {
    expect(musicPreview(NAMING_DEFAULTS, 'prefix', false)).toBe('Daft Punk/Discovery (2001)/03 - Digital Love.flac');
    expect(musicPreview(NAMING_DEFAULTS, 'prefix', true)).toBe('Daft Punk/Discovery (2001)/2-03 - Digital Love.flac');
    expect(musicPreview(NAMING_DEFAULTS, 'subfolder', true)).toBe('Daft Punk/Discovery (2001)/Disc 2/03 - Digital Love.flac');
  });
});

describe('Settings -> Media management -> Music naming', () => {
  it('shows the Music section with live samples and saves the music fields', async () => {
    renderAt('/settings/mediamanagement');
    const track = (await screen.findByLabelText('Track format')) as HTMLInputElement;
    expect(screen.getByTestId('sample-trackFormat').textContent).toBe('→ 03 - Digital Love.flac');
    expect(screen.getByTestId('sample-musicPath').textContent).toBe('Daft Punk/Discovery (2001)/03 - Digital Love.flac');

    fireEvent.change(track, { target: { value: '{track:00}. {Track Title}' } });
    expect(screen.getByTestId('sample-trackFormat').textContent).toBe('→ 03. Digital Love.flac');

    fireEvent.change(screen.getByLabelText('Multi-disc albums'), { target: { value: 'subfolder' } });
    // The prefix format only applies to the prefix style.
    expect(screen.queryByLabelText('Multi-disc track format')).toBeNull();
    expect(screen.getByTestId('sample-musicMultiDiscPath').textContent).toBe('Daft Punk/Discovery (2001)/Disc 2/03. Digital Love.flac');

    fireEvent.click(screen.getByLabelText('Rename tracks'));
    fireEvent.click(within(screen.getByRole('region', { name: 'Unsaved changes' })).getByRole('button', { name: 'Save changes' }));
    await waitFor(() => expect(calls.some((c) => c.method === 'PUT' && c.url === '/api/v1/settings/naming')).toBe(true));
    const put = calls.find((c) => c.method === 'PUT' && c.url === '/api/v1/settings/naming');
    expect(put!.body).toMatchObject({ renameTracks: true, trackFormat: '{track:00}. {Track Title}', multiDiscStyle: 'subfolder' });
  });

  it('is hidden while music is off', async () => {
    musicOn = false;
    renderAt('/settings/mediamanagement');
    await screen.findByLabelText('Standard episode format');
    await waitFor(() => expect(calls.some((c) => c.url === '/api/v1/settings/features')).toBe(true));
    expect(screen.queryByText('Music naming')).toBeNull();
    expect(screen.queryByLabelText('Track format')).toBeNull();
  });
});
