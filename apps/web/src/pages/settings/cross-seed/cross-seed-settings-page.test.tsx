import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { configure, fireEvent, screen, waitFor } from '@testing-library/react';
import { CrossSeedSettings, type Indexer } from '@arclight/shared';
import { renderAt, stubApi, type FakeApi } from '../../../test/route-harness.js';
import { toCrossSeedBody, toCrossSeedDraft, torrentIndexers } from './cross-seed-settings-page.js';

configure({ asyncUtilTimeout: 5000 });

const settings = CrossSeedSettings.parse({ enabled: true, indexerIds: [1], excludeTags: [], downloadClientId: 7 });

const indexer = (over: Partial<Indexer>): Indexer => ({
  id: 1,
  name: 'TrackerA',
  implementation: 'torznab',
  protocol: 'torrent',
  enableRss: true,
  enableAutomaticSearch: true,
  enableInteractiveSearch: true,
  priority: 12,
  tags: [],
  settings: { baseUrl: 'http://jackett', apiPath: '/api', categories: [], animeCategories: [] },
  ...over,
});

const builtin = {
  id: 7,
  name: 'Built-in',
  enable: true,
  protocol: 'torrent',
  priority: 1,
  removeCompletedDownloads: true,
  removeFailedDownloads: true,
  tags: [],
  implementation: 'builtin',
  settings: { category: 'tv', postImportCategory: '', savePath: '', categories: [], initialState: 'start' },
};

let api: FakeApi;

beforeEach(() => {
  api = stubApi({
    '/api/v1/settings/crossseed': settings,
    'PUT /api/v1/settings/crossseed': (init: RequestInit | undefined) => JSON.parse(String(init?.body)),
    '/api/v1/indexer': [indexer({}), indexer({ id: 2, name: 'TrackerB' })],
    '/api/v1/downloadclient': [builtin],
    '/api/v1/tag': [],
  });
});
afterEach(() => vi.unstubAllGlobals());

describe('Settings -> Cross-seed', () => {
  it('round-trips the defaults through the draft and rejects an out-of-range tolerance', () => {
    const defaults = CrossSeedSettings.parse({});
    const result = toCrossSeedBody(toCrossSeedDraft(defaults));
    expect(result).toEqual({ ok: true, body: defaults });
    const bad = toCrossSeedBody({ ...toCrossSeedDraft(defaults), sizeTolerancePercent: '25' });
    expect(bad).toMatchObject({ ok: false, field: 'sizeTolerancePercent', error: 'Check Size tolerance.' });
    expect(toCrossSeedBody({ ...toCrossSeedDraft(defaults), maxPerRun: '' })).toMatchObject({ ok: false, field: 'maxPerRun' });
  });

  it('offers torrent indexers only', () => {
    const usenet = indexer({ id: 9, name: 'NZBgeek', implementation: 'newznab', protocol: 'usenet' });
    expect(torrentIndexers([indexer({}), usenet])).toEqual([{ value: 1, label: 'TrackerA' }]);
  });

  it('renders the saved settings and PUTs the full settings on save', async () => {
    renderAt('/settings/crossseed');
    const tolerance = (await screen.findByLabelText('Size tolerance')) as HTMLInputElement;
    expect(tolerance.value).toBe('0.5');
    expect((screen.getByLabelText('Schedule') as HTMLInputElement).value).toBe('0 4 * * *');
    expect((screen.getByLabelText('Category') as HTMLInputElement).value).toBe('cross-seed');
    await waitFor(() => expect((screen.getByLabelText('Download client') as HTMLSelectElement).value).toBe('7'));

    fireEvent.change(tolerance, { target: { value: '1.5' } });
    fireEvent.click(screen.getByRole('switch', { name: 'Search on import' }));
    fireEvent.change(screen.getByLabelText('Files per run'), { target: { value: '20' } });
    fireEvent.click(await screen.findByRole('button', { name: 'Save changes' }));

    await waitFor(() => expect(api.calls.some((c) => c.method === 'PUT')).toBe(true));
    const body = api.calls.find((c) => c.method === 'PUT')!.body;
    expect(body).toEqual({ ...settings, sizeTolerancePercent: 1.5, onImport: true, maxPerRun: 20 });
  });

  it('blocks Save while a number is out of range', async () => {
    renderAt('/settings/crossseed');
    fireEvent.change(await screen.findByLabelText('Search interval'), { target: { value: '0' } });
    expect(await screen.findByText('Check Search interval.')).toBeTruthy();
    expect((screen.getByRole('button', { name: 'Save changes' }) as HTMLButtonElement).disabled).toBe(true);
  });
});
