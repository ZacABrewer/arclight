import { afterEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import type { ProfileMigrationProgress } from '@arclight/shared';
import { renderAt, stubApi } from '../../../test/route-harness.js';

const hd = {
  id: 1,
  name: 'HD-1080p',
  upgradeAllowed: true,
  cutoff: 3,
  items: [{ kind: 'quality', qualityId: 3, allowed: true }],
  minFormatScore: 0,
  cutoffFormatScore: 0,
  minUpgradeFormatScore: 1,
  formatItems: [],
  languages: [],
};

const progress = (over: Partial<ProfileMigrationProgress> = {}): ProfileMigrationProgress => ({
  qualityProfileId: 1,
  qualityProfileName: 'HD-1080p',
  settings: { qualityProfileId: 1, mismatchAction: 'replace', autoEnabled: true, paused: false },
  items: 40,
  mismatchedItems: 27,
  files: { meets: 13, upgradeAllowed: 20, notAllowed: 7 },
  queue: { remaining: 12, inProgress: 2, done: 10, failed: 3 },
  pendingSearches: 9,
  evaluatedAt: '2026-10-26T10:00:00.000Z',
  ...over,
});

const settings = { enabled: true, intervalMinutes: 30, searchesPerRun: 10, maxSearchesPerDay: 100, maxAttempts: 3, retryAfterHours: 24 };

function stub() {
  return stubApi({
    '/api/v1/qualityprofile': [hd],
    '/api/v1/qualityprofile/schema': { ...hd, id: undefined, name: '' },
    '/api/v1/customformat': [],
    '/api/v1/delayprofile': [],
    '/api/v1/releaseprofile': [],
    '/api/v1/tag': [],
    '/api/v1/rootfolder': [],
    '/api/v1/profilemigration/profiles': [progress()],
    '/api/v1/profilemigration/settings': settings,
    'PUT /api/v1/profilemigration/profiles/1': (init: RequestInit | undefined) => progress({ settings: { ...progress().settings, ...JSON.parse(String(init?.body)) } }),
    'POST /api/v1/profilemigration/profiles/1/search': () => new Response(JSON.stringify({ searches: 9, job: null }), { status: 202 }),
    'POST /api/v1/profilemigration/profiles/1/retry': progress({ queue: { remaining: 15, inProgress: 2, done: 10, failed: 0 } }),
  });
}

afterEach(() => vi.unstubAllGlobals());

describe('profile migration on the profiles page', () => {
  it('shows how many items do not meet each profile, and the replacement progress', async () => {
    stub();
    renderAt('/settings/profiles');
    const counts = await screen.findAllByTestId('profile-mismatch-count');
    expect(counts[0]!.textContent).toBe("27 items don't meet this profile");
    expect((await screen.findByTestId('migration-progress')).textContent).toBe('12 remaining · 2 in progress · 10 done · 3 failed');
  });

  it('changes the rule and pauses the automatic mode', async () => {
    const api = stub();
    renderAt('/settings/profiles');
    const rule = await screen.findByLabelText("When files don't meet HD-1080p");
    fireEvent.change(rule, { target: { value: 'replaceIfBetter' } });
    await waitFor(() => expect(api.calls.some((c) => c.method === 'PUT' && (c.body as { mismatchAction?: string }).mismatchAction === 'replaceIfBetter')).toBe(true));
    fireEvent.click(screen.getByRole('button', { name: 'Pause' }));
    await waitFor(() => expect(api.calls.some((c) => c.method === 'PUT' && (c.body as { paused?: boolean }).paused === true)).toBe(true));
  });

  it('asks before "search all now", naming the number of searches', async () => {
    const api = stub();
    renderAt('/settings/profiles');
    fireEvent.click(await screen.findByRole('button', { name: 'Search all now' }));
    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByText(/This starts 9 searches/)).toBeTruthy();
    fireEvent.click(within(dialog).getByRole('button', { name: 'Start 9 searches' }));
    await waitFor(() => expect(api.calls.some((c) => c.method === 'POST' && c.path === '/api/v1/profilemigration/profiles/1/search')).toBe(true));
  });
});
