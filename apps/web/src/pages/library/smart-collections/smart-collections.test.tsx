import { afterEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { SmartCollectionCriteria, type LeavingSoon, type SmartCollection } from '@arclight/shared';
import { renderAt, stubApi } from '../../../test/route-harness.js';
import { criteriaSummary, decades, draftDecade, draftFrom, EMPTY_DRAFT, toInput, validateDraft } from './collection-model.js';

afterEach(() => vi.unstubAllGlobals());

const collection = (over: Partial<SmartCollection> = {}): SmartCollection => ({
  id: 1,
  name: '90s thrillers',
  enabled: true,
  mediaType: 'movie',
  criteria: SmartCollectionCriteria.parse({ genres: ['Thriller'], yearFrom: 1990, yearTo: 1999 }),
  sort: 'rating',
  limit: 50,
  createdAt: '2026-10-01T00:00:00.000Z',
  updatedAt: '2026-10-01T00:00:00.000Z',
  sync: [{ serverId: 'jf', serverName: 'Jellyfin', remoteId: 'abc', itemCount: 12, missing: 1, lastSyncAt: '2026-10-02T00:00:00.000Z', lastError: null }],
  ...over,
});

const leaving: LeavingSoon = {
  enabled: true,
  days: 14,
  name: 'Leaving Soon',
  items: [{ mediaType: 'movie', id: 7, tmdbId: 949, title: 'Heat', year: 1995, posterUrl: null, removeAt: '2026-11-10T00:00:00.000Z' }],
  sync: [],
};

describe('smart collection model', () => {
  it('round-trips a rule, validates fields and summarises criteria', () => {
    const d = draftFrom(collection());
    expect(d.yearFrom).toBe('1990');
    expect(draftDecade(d)).toBe(1990);
    expect(toInput(d)).toMatchObject({ name: '90s thrillers', sort: 'rating', limit: 50, criteria: { genres: ['Thriller'], yearFrom: 1990, yearTo: 1999, minRating: null, list: null } });
    expect(validateDraft(EMPTY_DRAFT)).toEqual({ name: 'Give the collection a name.' });
    expect(validateDraft(EMPTY_DRAFT, { requireName: false })).toEqual({});
    const bad = validateDraft({ ...EMPTY_DRAFT, name: 'x', yearFrom: '2000', yearTo: '1990', minRating: '11', limit: '0', tmdbCollectionIds: ['abc'] });
    expect(Object.keys(bad).sort()).toEqual(['limit', 'minRating', 'tmdbCollectionIds', 'yearTo']);
    expect(criteriaSummary(collection())).toEqual(['Thriller', '1990–1999']);
    expect(decades(new Date('2026-06-01T00:00:00Z'))[0]).toBe(2020);
  });
});

describe('Library → Smart collections', () => {
  it('lists rules with their sync state and the Leaving Soon titles', async () => {
    stubApi({ '/api/v1/collections/smart': [collection()], '/api/v1/collections/leavingsoon': leaving });
    renderAt('/library/smartcollections');
    const rules = await screen.findByRole('region', { name: 'Collections' });
    expect(await within(rules).findByText('90s thrillers')).toBeTruthy();
    expect(within(rules).getByText('Jellyfin: 12 · 1 missing')).toBeTruthy();
    expect(within(rules).getByText('Rating, top 50')).toBeTruthy();
    const ls = screen.getByRole('region', { name: 'Leaving Soon' });
    expect(await within(ls).findByText('Heat')).toBeTruthy();
  });

  it('previews a new rule as it is edited and saves it', async () => {
    const api = stubApi({
      '/api/v1/collections/smart': [],
      '/api/v1/collections/leavingsoon': leaving,
      'POST /api/v1/collections/smart/preview': { total: 30, items: [{ mediaType: 'movie', id: 7, tmdbId: 949, title: 'Heat', year: 1995, posterUrl: null, removeAt: null }] },
      'POST /api/v1/collections/smart': collection({ id: 2, name: 'Crime' }),
    });
    renderAt('/library/smartcollections');
    fireEvent.click((await screen.findAllByRole('button', { name: 'Add collection' }))[0]!);
    const dialog = await screen.findByRole('dialog');
    fireEvent.change(within(dialog).getByLabelText('Decade'), { target: { value: '1990' } });
    const preview = within(dialog).getByRole('region', { name: 'Preview' });
    expect(await within(preview).findByText('30 titles match', {}, { timeout: 3000 })).toBeTruthy();
    expect(within(preview).getByText('and 29 more')).toBeTruthy();
    await waitFor(() => expect(api.calls.filter((c) => c.path === '/api/v1/collections/smart/preview').at(-1)?.body).toMatchObject({ name: 'Preview', criteria: { yearFrom: 1990, yearTo: 1999 } }));

    fireEvent.click(within(dialog).getByRole('button', { name: 'Create collection' }));
    expect(within(dialog).getByText('Give the collection a name.')).toBeTruthy();
    fireEvent.change(within(dialog).getByLabelText('Name'), { target: { value: 'Crime' } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Create collection' }));
    await waitFor(() => expect(api.calls.some((c) => c.method === 'POST' && c.path === '/api/v1/collections/smart')).toBe(true));
    expect(api.calls.find((c) => c.method === 'POST' && c.path === '/api/v1/collections/smart')?.body).toMatchObject({ name: 'Crime', criteria: { yearFrom: 1990 } });
  });

  it('syncs now and shows the result, and deletes after a confirm', async () => {
    const api = stubApi({
      '/api/v1/collections/smart': [collection()],
      '/api/v1/collections/leavingsoon': leaving,
      'POST /api/v1/collections/sync': { collections: 2, servers: 1, added: 5, removed: 1, created: 1, deleted: 0, errors: ['Emby: timed out'] },
      'DELETE /api/v1/collections/smart/1': null,
    });
    renderAt('/library/smartcollections');
    fireEvent.click(await screen.findByRole('button', { name: 'Sync now' }));
    expect(await screen.findByText('Synced 2 collections on 1 servers: 5 added, 1 removed, 1 created, 0 deleted.')).toBeTruthy();
    expect(screen.getByText('Emby: timed out')).toBeTruthy();

    fireEvent.click(await screen.findByRole('button', { name: 'Delete 90s thrillers' }));
    const confirm = await screen.findByRole('dialog');
    fireEvent.click(within(confirm).getByRole('button', { name: 'Delete' }));
    await waitFor(() => expect(api.calls.some((c) => c.method === 'DELETE' && c.path === '/api/v1/collections/smart/1')).toBe(true));
  });
});
