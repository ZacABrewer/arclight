import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { QueryClientProvider } from '@tanstack/react-query';
import type { SoulseekCandidate } from '@arclight/shared';
import { ToastProvider } from '../../../components/toast.js';
import { createToastStore } from '../../../lib/toast.js';
import { createQueryClient } from '../../../query-client.js';
import { SoulseekSearchModal } from './soulseek-search.js';

const file = (n: number) => ({ filename: `Music\\Artist - Album\\0${n} - Song.flac`, size: 1000, bitRate: null, bitDepth: 16, sampleRate: 44100, lengthSeconds: 200 });

const candidate = (over: Partial<SoulseekCandidate>): SoulseekCandidate => ({
  username: 'flac-peer',
  directory: 'Music\\Artist - Album',
  files: [file(1), file(2)],
  totalSize: 2000,
  qualityId: 1,
  qualityName: 'FLAC',
  matchedTracks: 2,
  wantedTracks: 2,
  totalTracks: 2,
  confidence: 0.95,
  freeSlot: true,
  queueLength: 0,
  uploadSpeed: 1000,
  score: 2,
  accepted: true,
  rejections: [],
  ...over,
});

let calls: Array<{ url: string; method: string; body: unknown }>;

beforeEach(() => {
  calls = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init?: RequestInit) => {
      const method = init?.method ?? 'GET';
      const body = typeof init?.body === 'string' ? JSON.parse(init.body) : undefined;
      calls.push({ url, method, body });
      if (url === '/api/v1/soulseek/search')
        return new Response(
          JSON.stringify({
            query: 'Artist Album',
            candidates: [candidate({}), candidate({ username: 'mp3-peer', qualityName: 'MP3-320', score: 1, accepted: false, rejections: ['notAnUpgrade'] })],
          }),
        );
      if (url === '/api/v1/soulseek/grab')
        return new Response(
          JSON.stringify({
            id: 1,
            albumId: 5,
            artistId: 1,
            albumTitle: 'Album',
            artistName: 'Artist',
            username: 'flac-peer',
            directory: body.directory,
            fileCount: 2,
            totalSize: 2000,
            qualityName: 'FLAC',
            status: 'queued',
            progress: 0,
            message: null,
            createdAt: '2026-01-01T00:00:00.000Z',
            updatedAt: '2026-01-01T00:00:00.000Z',
          }),
          { status: 201 },
        );
      return new Response(JSON.stringify({ error: 'not found' }), { status: 404 });
    }),
  );
});

afterEach(() => vi.unstubAllGlobals());

describe('SoulseekSearchModal', () => {
  it('searches on open, shows rejections and grabs the chosen folder', async () => {
    const toasts = createToastStore();
    const onClose = vi.fn();
    render(
      <QueryClientProvider client={createQueryClient(toasts)}>
        <ToastProvider store={toasts}>
          <SoulseekSearchModal albumId={5} title="Artist – Album" onClose={onClose} />
        </ToastProvider>
      </QueryClientProvider>,
    );
    expect((await screen.findAllByText('Not an upgrade over the files on disk')).length).toBeGreaterThan(0);
    expect(calls.find((c) => c.url === '/api/v1/soulseek/search')?.body).toEqual({ albumId: 5 });
    expect((screen.getByLabelText('Query') as HTMLInputElement).value).toBe('Artist Album');

    fireEvent.click(screen.getAllByRole('button', { name: 'Grab Artist - Album from flac-peer' })[0]!);
    await waitFor(() => expect(onClose).toHaveBeenCalled());
    expect(calls.find((c) => c.url === '/api/v1/soulseek/grab')?.body).toEqual({
      albumId: 5,
      username: 'flac-peer',
      directory: 'Music\\Artist - Album',
      files: [
        { filename: 'Music\\Artist - Album\\01 - Song.flac', size: 1000 },
        { filename: 'Music\\Artist - Album\\02 - Song.flac', size: 1000 },
      ],
      qualityName: 'FLAC',
    });
  });
});
