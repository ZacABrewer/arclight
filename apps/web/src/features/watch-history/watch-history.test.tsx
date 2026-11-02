import { afterEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { Permission, type WatchEvent } from '@arclight/shared';
import { authRoutes, renderAt, stubApi, user } from '../requests/test-utils.js';
import { watchTitle } from './watch-history.js';

afterEach(() => vi.unstubAllGlobals());

const admin = user({ id: 1, username: 'root', role: 'admin', permissions: Permission.ADMIN });

const event = (over: Partial<WatchEvent> = {}): WatchEvent => ({
  id: 1,
  serverId: 'jf1',
  serverName: 'Living room',
  user: { mediaServerUserId: 5, name: 'amy', arclightUserId: 4, arclightUsername: 'amy-local' },
  type: 'played',
  at: '2026-10-30T20:00:00.000Z',
  itemType: 'episode',
  title: 'Pilot',
  seriesTitle: 'Example Show',
  seasonNumber: 1,
  episodeNumber: 2,
  movieId: null,
  seriesId: 7,
  episodeId: 70,
  positionMs: null,
  durationMs: null,
  client: 'Jellyfin Web',
  device: 'Firefox',
  playMethod: 'DirectPlay',
  sessionId: null,
  source: 'plugin',
  ...over,
});

describe('watch history', () => {
  it('names episodes with their series and number', () => {
    expect(watchTitle(event())).toBe('Example Show · S01E02 · Pilot');
    expect(watchTitle(event({ itemType: 'movie', title: 'A Movie' }))).toBe('A Movie');
  });

  it('lists everyone for admins and filters by user', async () => {
    const calls = stubApi({
      ...authRoutes(admin),
      '/api/v1/user': [admin, user({ id: 4, username: 'amy-local' })],
      '/api/v1/watchhistory': { page: 1, pageSize: 25, totalRecords: 1, records: [event()] },
    });
    renderAt('/activity/watchhistory');
    expect(await screen.findByText('Example Show · S01E02 · Pilot')).toBeTruthy();
    const table = screen.getByRole('table', { name: 'Watch history' });
    expect(within(table).getByText('amy-local')).toBeTruthy();
    expect(within(table).getByText('Played')).toBeTruthy();
    const filter = (await screen.findByLabelText('Filter by user')) as HTMLSelectElement;
    fireEvent.change(filter, { target: { value: '4' } });
    await waitFor(() => expect(calls.some((c) => c.url.startsWith('/api/v1/watchhistory') && c.url.includes('userId=4'))).toBe(true));
  });

  it('shows an empty state when nothing was played', async () => {
    stubApi({ ...authRoutes(admin), '/api/v1/user': [admin], '/api/v1/watchhistory': { page: 1, pageSize: 25, totalRecords: 0, records: [] } });
    renderAt('/activity/watchhistory');
    expect(await screen.findByText('No watch history yet')).toBeTruthy();
  });
});
