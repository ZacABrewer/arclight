import { afterEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import type { GuideProfileInfo, GuidesDiff, GuidesDiffItem, GuidesSettings, GuidesStatus } from '@arclight/shared';
import { renderAt, stubApi } from '../../../test/route-harness.js';
import { applyAllIds, diffItemDetail, diffItemTitle, groupDiff, mappingFor, repoLabel, setMapping, validateGuides } from './guides-model.js';

afterEach(() => vi.unstubAllGlobals());

const settings: GuidesSettings = {
  enabled: true,
  source: 'trash',
  repoUrl: 'https://raw.githubusercontent.com/TRaSH-Guides/Guides/',
  branch: 'master',
  apps: ['radarr'],
  syncIntervalHours: 24,
  mode: 'notify',
  profiles: [{ guideProfileName: 'HD Bluray + WEB', localQualityProfileId: 1, app: 'radarr' }],
  includeFormats: [],
  excludeFormats: ['BR-DISK'],
  scoreAllSyncedFormats: true,
};

const status: GuidesStatus = {
  enabled: true,
  mode: 'notify',
  source: 'trash',
  repoUrl: settings.repoUrl,
  branch: 'master',
  syncIntervalHours: 24,
  lastSyncAt: '2026-10-26T01:00:00Z',
  lastSuccessAt: '2026-10-26T01:00:00Z',
  lastError: null,
  lastAppliedAt: null,
  pendingCount: 3,
  pendingSince: '2026-10-26T01:00:00Z',
  lastFetch: { files: 40, cached: 38, requests: 3 },
  syncedFormats: 12,
};

const spec = { implementation: 'releaseTitle' as const, name: 'DV', negate: false, required: true, fields: { pattern: 'DV' } };

const create: Extract<GuidesDiffItem, { kind: 'createFormat' }> = {
  kind: 'createFormat',
  id: 'format:dv',
  guideId: 'dv',
  app: 'radarr',
  name: 'DV (WEBDL)',
  formatId: null,
  before: null,
  after: { name: 'DV (WEBDL)', includeWhenRenaming: false, specifications: [spec] },
  warnings: [],
};
const adopt: GuidesDiffItem = { ...create, kind: 'adoptFormat', id: 'format:x265', guideId: 'x265', name: 'x265 (HD)', formatId: 8, before: { name: 'x265 (HD)', includeWhenRenaming: false, specifications: [] }, warnings: ['Unsupported spec: size'] };
const score: GuidesDiffItem = {
  kind: 'setScore',
  id: 'score:1:dv',
  guideId: 'dv',
  app: 'radarr',
  profileId: 1,
  profileName: 'HD-1080p',
  guideProfileName: 'HD Bluray + WEB',
  formatName: 'DV (WEBDL)',
  formatId: null,
  before: null,
  after: -10000,
};

const diff: GuidesDiff = {
  generatedAt: '2026-10-26T01:00:00Z',
  revision: 'r1',
  items: [score, create, adopt],
  staleFormats: [{ formatId: 9, name: 'Old format', guideId: 'old' }],
  warnings: ['Guide profile "Remux" not found'],
};

const guideProfiles: GuideProfileInfo[] = [
  { app: 'radarr', trashId: 'p1', name: 'HD Bluray + WEB', description: 'Good 1080p', scoreSet: 'default', formats: [{ name: 'DV (WEBDL)', guideId: 'dv' }], mappedTo: 1 },
  { app: 'radarr', trashId: 'p2', name: 'UHD Bluray + WEB', description: '', scoreSet: 'default', formats: [], mappedTo: null },
];

const qualityProfile = (id: number, name: string) => ({
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

function stubGuides(extra: Record<string, unknown> = {}) {
  return stubApi({
    '/api/v1/settings/guides': settings,
    'PUT /api/v1/settings/guides': (init: RequestInit | undefined) => JSON.parse(String(init?.body)) as unknown,
    '/api/v1/guides/status': status,
    '/api/v1/guides/diff': diff,
    '/api/v1/guides/profiles': guideProfiles,
    '/api/v1/qualityprofile': [qualityProfile(1, 'HD-1080p'), qualityProfile(2, 'UHD-2160p')],
    'POST /api/v1/guides/apply': { applied: ['format:dv'], skipped: [], formatsCreated: 1, formatsUpdated: 0, scoresSet: 0, pendingCount: 2 },
    'POST /api/v1/guides/sync': { mode: 'notify', changes: 3, applied: null, pendingCount: 3, warnings: [], fetch: { files: 40, cached: 38, requests: 3 } },
    ...extra,
  });
}

describe('guides model', () => {
  it('titles and details diff rows', () => {
    expect(diffItemTitle(create)).toBe('DV (WEBDL)');
    expect(diffItemTitle(score)).toBe('DV (WEBDL) on HD-1080p');
    expect(diffItemDetail(score)).toBe('unset → -10000');
    expect(diffItemDetail({ ...score, before: 50 } as GuidesDiffItem)).toBe('50 → -10000');
    expect(diffItemDetail(create)).toBe('1 spec');
    expect(diffItemDetail(adopt)).toBe('0 → 1 specs');
  });

  it('groups by kind in display order and leaves adoptions out of Apply all', () => {
    expect(groupDiff(diff.items).map((g) => g.kind)).toEqual(['createFormat', 'adoptFormat', 'setScore']);
    expect(applyAllIds(diff.items)).toEqual(['score:1:dv', 'format:dv']);
  });

  it('maps and unmaps guide profiles case-insensitively', () => {
    expect(mappingFor(settings.profiles, 'hd bluray + web', 'radarr')).toBe(1);
    expect(mappingFor(settings.profiles, 'HD Bluray + WEB', 'sonarr')).toBeNull();
    expect(mappingFor([{ guideProfileName: 'Any', localQualityProfileId: 4 }], 'any', 'sonarr')).toBe(4);
    const next = setMapping(settings.profiles, 'HD Bluray + WEB', 'radarr', 2);
    expect(next).toEqual([{ guideProfileName: 'HD Bluray + WEB', localQualityProfileId: 2, app: 'radarr' }]);
    expect(setMapping(next, 'hd bluray + web', 'radarr', null)).toEqual([]);
  });

  it('validates the settings form', () => {
    expect(validateGuides(settings)).toEqual({});
    expect(validateGuides({ ...settings, source: 'custom', repoUrl: 'not a url' }).repoUrl).toMatch(/full URL/);
    expect(validateGuides({ ...settings, source: 'custom', repoUrl: 'ftp://x/' }).repoUrl).toBe('Use an http(s) URL');
    // The trash source ignores repoUrl.
    expect(validateGuides({ ...settings, repoUrl: 'nope' }).repoUrl).toBeUndefined();
    expect(validateGuides({ ...settings, branch: ' ', apps: [], syncIntervalHours: 200 })).toEqual({ branch: 'Enter a branch', apps: 'Pick at least one', syncIntervalHours: 'Use 1 to 168 hours' });
  });

  it('shows the repository the source reads', () => {
    expect(repoLabel('trash', 'https://example.com/', 'main')).toBe('https://raw.githubusercontent.com/TRaSH-Guides/Guides/main');
    expect(repoLabel('custom', 'https://example.com/', 'main')).toBe('https://example.com/main');
  });
});

describe('Settings → Guides', () => {
  it('renders the form, status pane, mappings and diff', async () => {
    stubGuides();
    renderAt('/settings/guides');
    expect(await screen.findByLabelText('Branch')).toBeTruthy();
    const statusPane = screen.getByRole('region', { name: 'Guide status' });
    expect(await within(statusPane).findByText('40 files · 38 cached · 3 requests')).toBeTruthy();
    expect(within(statusPane).getByText('Notify only')).toBeTruthy();
    const select = (await screen.findByLabelText('Local profile for HD Bluray + WEB')) as HTMLSelectElement;
    expect(select.value).toBe('1');
    expect(((await screen.findByLabelText('Local profile for UHD Bluray + WEB')) as HTMLSelectElement).value).toBe('');
    await screen.findByText('Old format');
    const pending = screen.getByRole('region', { name: 'Pending changes' });
    expect(within(pending).getByRole('region', { name: 'New format' })).toBeTruthy();
    expect(within(pending).getByText('unset → -10000')).toBeTruthy();
    expect(within(pending).getByText('Old format')).toBeTruthy();
    expect(within(pending).getByText('Guide profile "Remux" not found')).toBeTruthy();
    expect(within(pending).getByText('Unsupported spec: size')).toBeTruthy();
    // The trash source locks the repository URL.
    expect((screen.getByLabelText('Repository URL') as HTMLInputElement).disabled).toBe(true);
  });

  it('applies only the ticked items', async () => {
    const api = stubGuides();
    renderAt('/settings/guides');
    await screen.findByText('Old format');
    const pending = screen.getByRole('region', { name: 'Pending changes' });
    const applySelected = within(pending).getByRole('button', { name: /Apply selected/ }) as HTMLButtonElement;
    expect(applySelected.disabled).toBe(true);
    fireEvent.click(within(pending).getByLabelText('x265 (HD)'));
    fireEvent.click(within(pending).getByLabelText('DV (WEBDL) on HD-1080p'));
    fireEvent.click(within(pending).getByRole('button', { name: 'Apply selected (2)' }));
    await waitFor(() => expect(api.calls.find((c) => c.path === '/api/v1/guides/apply')?.body).toEqual({ ids: ['format:x265', 'score:1:dv'] }));
    expect(await screen.findByText('Applied 1 change')).toBeTruthy();
  });

  it('applies everything with Apply all and syncs on demand', async () => {
    const api = stubGuides();
    renderAt('/settings/guides');
    await screen.findByText('Old format');
    const pending = screen.getByRole('region', { name: 'Pending changes' });
    fireEvent.click(within(pending).getByRole('button', { name: 'Apply all' }));
    await waitFor(() => expect(api.calls.find((c) => c.path === '/api/v1/guides/apply')?.body).toEqual({}));
    fireEvent.click(within(screen.getByRole('region', { name: 'Guide status' })).getByRole('button', { name: 'Sync now' }));
    expect(await screen.findByText('3 changes found')).toBeTruthy();
    expect(api.calls.some((c) => c.method === 'POST' && c.path === '/api/v1/guides/sync')).toBe(true);
  });

  it('saves a new mapping, mode and exclude list', async () => {
    const api = stubGuides();
    renderAt('/settings/guides');
    fireEvent.change(await screen.findByLabelText('Local profile for UHD Bluray + WEB'), { target: { value: '2' } });
    fireEvent.click(screen.getByRole('button', { name: 'Apply' }));
    fireEvent.change(screen.getByLabelText('Exclude'), { target: { value: 'LQ' } });
    fireEvent.keyDown(screen.getByLabelText('Exclude'), { key: 'Enter' });
    fireEvent.click(await screen.findByRole('button', { name: 'Save changes' }));
    await waitFor(() => expect(api.calls.find((c) => c.method === 'PUT')).toBeTruthy());
    const body = api.calls.find((c) => c.method === 'PUT')?.body as GuidesSettings;
    expect(body.mode).toBe('apply');
    expect(body.excludeFormats).toEqual(['BR-DISK', 'LQ']);
    expect(body.profiles).toContainEqual({ guideProfileName: 'UHD Bluray + WEB', localQualityProfileId: 2, app: 'radarr' });
  });

  it('blocks saving an invalid custom repository', async () => {
    const api = stubGuides();
    renderAt('/settings/guides');
    fireEvent.click(await screen.findByRole('button', { name: 'Custom' }));
    fireEvent.change(screen.getByLabelText('Repository URL'), { target: { value: 'github' } });
    expect(await screen.findByText(/Enter a full URL/)).toBeTruthy();
    const saveBtn = (await screen.findByRole('button', { name: 'Save changes' })) as HTMLButtonElement;
    expect(saveBtn.disabled).toBe(true);
    fireEvent.click(saveBtn);
    expect(api.calls.some((c) => c.method === 'PUT')).toBe(false);
  });

  it('shows the last sync error and an empty diff', async () => {
    stubGuides({
      '/api/v1/guides/status': { ...status, lastError: 'Guide unreachable (502)', pendingCount: 0 },
      '/api/v1/guides/diff': { ...diff, items: [], staleFormats: [], warnings: [] },
    });
    renderAt('/settings/guides');
    expect(await screen.findByText('Last sync failed: Guide unreachable (502)')).toBeTruthy();
    expect(await screen.findByText('No pending changes')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Apply all' })).toBeNull();
  });
});
