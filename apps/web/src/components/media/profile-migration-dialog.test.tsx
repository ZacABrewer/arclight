import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { QueryClientProvider } from '@tanstack/react-query';
import type { ProfileMigrationPreview, QualityProfile } from '@arclight/shared';
import { ToastProvider } from '../toast.js';
import { createToastStore } from '../../lib/toast.js';
import { createQueryClient } from '../../query-client.js';
import { ProfileMigrationDialog } from './profile-migration-dialog.js';

const profile = (id: number, name: string) =>
  ({ id, name, upgradeAllowed: true, cutoff: 0, items: [], minFormatScore: 0, cutoffFormatScore: 0, minUpgradeFormatScore: 1, formatItems: [], languages: [] }) as QualityProfile;

const preview: ProfileMigrationPreview = {
  toProfileId: 2,
  toProfileName: 'Ultra HD',
  mismatchAction: 'none',
  items: 3,
  series: 1,
  movies: 2,
  unchanged: 0,
  itemsWithoutFiles: 1,
  files: { total: 4, meets: 1, upgradeAllowed: 2, notAllowed: 1 },
  needReplacing: 3,
  estimatedDownloadBytes: 5 * 1024 ** 3,
  sample: [{ mediaType: 'movie', id: 9, title: 'Heat', fromProfiles: ['HD'], files: 1, status: 'notAllowed' }],
};

let calls: Array<{ url: string; method: string; body?: unknown }> = [];

beforeEach(() => {
  calls = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init?: RequestInit) => {
      const method = init?.method ?? 'GET';
      calls.push({ url, method, body: init?.body ? JSON.parse(String(init.body)) : undefined });
      if (url === '/api/v1/profilemigration/preview') return new Response(JSON.stringify(preview), { status: 200 });
      if (url === '/api/v1/profilemigration/apply') {
        return new Response(JSON.stringify({ preview, changedSeries: [1], changedMovies: [9, 10] }), { status: 200 });
      }
      return new Response(JSON.stringify([]), { status: 200 });
    }),
  );
});
afterEach(() => vi.unstubAllGlobals());

function renderDialog(onClose = vi.fn()) {
  const queryClient = createQueryClient(createToastStore());
  render(
    <QueryClientProvider client={queryClient}>
      <ToastProvider store={createToastStore()}>
        <ProfileMigrationDialog
          open
          onClose={onClose}
          selection={{ movieIds: [9, 10], seriesIds: [1] }}
          profiles={[profile(1, 'HD'), profile(2, 'Ultra HD')]}
          subject="3 items"
          initialToProfileId={2}
        />
      </ToastProvider>
    </QueryClientProvider>,
  );
  return onClose;
}

describe('profile migration dialog', () => {
  it('previews the move: files that meet, need replacing, are not allowed, and the estimate', async () => {
    renderDialog();
    const box = await screen.findByTestId('migration-preview');
    expect(within(box).getByText('Files it doesn\'t allow')).toBeTruthy();
    expect(within(box).getByText('Do nothing')).toBeTruthy();
    expect(within(box).getByText(/3 files don't meet the new profile/)).toBeTruthy();
    expect(within(box).getByText(/Heat/)).toBeTruthy();
    expect(calls[0]).toMatchObject({ url: '/api/v1/profilemigration/preview', body: { selection: { movieIds: [9, 10], seriesIds: [1] }, toProfileId: 2 } });
  });

  it('applies the change and closes', async () => {
    const onClose = renderDialog();
    await screen.findByTestId('migration-preview');
    fireEvent.click(screen.getByRole('button', { name: 'Change 3 items' }));
    await waitFor(() => expect(onClose).toHaveBeenCalled());
    expect(calls.find((c) => c.url === '/api/v1/profilemigration/apply')?.body).toEqual({ selection: { movieIds: [9, 10], seriesIds: [1] }, toProfileId: 2 });
  });
});
