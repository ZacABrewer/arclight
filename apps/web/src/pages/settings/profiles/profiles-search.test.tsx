import { afterEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { renderAt, stubApi } from '../../../test/route-harness.js';

afterEach(() => vi.unstubAllGlobals());

const quality = (id: number, name: string) => ({
  id,
  name,
  upgradeAllowed: true,
  cutoff: 3,
  items: [{ kind: 'quality', qualityId: 3, allowed: true }],
  minFormatScore: 0,
  cutoffFormatScore: 0,
  minUpgradeFormatScore: 1,
  formatItems: [],
  languages: [],
});

const release = (id: number, name: string, required: string[]) => ({ id, name, enabled: true, required, ignored: [], tags: [] });

function stub() {
  return stubApi({
    '/api/v1/qualityprofile': [quality(1, 'HD-1080p'), quality(2, 'Ultra-HD'), quality(3, 'Any')],
    '/api/v1/qualityprofile/schema': { ...quality(0, ''), id: undefined },
    '/api/v1/customformat': [],
    '/api/v1/delayprofile': [],
    '/api/v1/releaseprofile': [release(1, 'No x265', ['x265']), release(2, 'Anime groups', ['SubsPlease'])],
    '/api/v1/tag': [],
    '/api/v1/indexer': [],
    '/api/v1/rootfolder': [],
    '/api/v1/profilemigration/profiles': [],
    '/api/v1/profilemigration/settings': { enabled: false, intervalMinutes: 30, searchesPerRun: 10, maxSearchesPerDay: 100, maxAttempts: 3, retryAfterHours: 24 },
  });
}

describe('profiles page search', () => {
  it('filters quality and release profile cards by name and terms, each with "N of M"', async () => {
    stub();
    renderAt('/settings/profiles?q=hd');
    const grid = await screen.findByRole('list', { name: 'Quality profiles' });
    await waitFor(() => expect(within(grid).queryByRole('button', { name: 'Any' })).toBeNull());
    expect(within(grid).getByRole('button', { name: 'HD-1080p' })).toBeTruthy();
    expect(within(grid).getByRole('button', { name: 'Ultra-HD' })).toBeTruthy();
    expect(screen.getByText('2 of 3')).toBeTruthy();

    const box = screen.getByRole('searchbox', { name: 'Search this list' });
    fireEvent.change(box, { target: { value: 'subsplease' } });
    fireEvent.keyDown(box, { key: 'Enter' });
    const releases = await screen.findByRole('list', { name: 'Release profiles' });
    await waitFor(() => expect(within(releases).queryByRole('button', { name: 'No x265' })).toBeNull());
    expect(within(releases).getByRole('button', { name: 'Anime groups' })).toBeTruthy();
    expect(screen.getByText('1 of 2')).toBeTruthy();
    // No quality profile matches: that section offers Clear search.
    fireEvent.click(screen.getAllByRole('button', { name: 'Clear search' })[0]!);
    expect(await within(await screen.findByRole('list', { name: 'Quality profiles' })).findByRole('button', { name: 'Any' })).toBeTruthy();
  });
});
