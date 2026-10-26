import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { configure, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { SceneMapping, SceneMappingApplyResult } from '@arclight/shared';
import { renderAt, stubApi } from '../../../test/route-harness.js';
import { makeSeries } from '../test-fixtures.js';

configure({ asyncUtilTimeout: 4000 });

beforeEach(() => localStorage.clear());
afterEach(() => vi.unstubAllGlobals());

const show = makeSeries({ id: 1, title: 'Frieren', seasons: [{ seasonNumber: 1, monitored: true }] });

const manual = SceneMapping.parse({
  id: 5,
  seriesId: 1,
  kind: 'season',
  sceneSeason: 2,
  sceneEpisode: 1,
  sceneAbsolute: null,
  tvdbSeason: 1,
  tvdbEpisode: 13,
  tvdbAbsolute: null,
  sceneTitle: null,
  source: 'manual',
  comment: 'split cour',
});
const feed = SceneMapping.parse({ ...manual, id: 9, kind: 'title', sceneTitle: 'Sousou no Frieren', sceneSeason: null, sceneEpisode: null, tvdbSeason: null, tvdbEpisode: null, source: 'feed', comment: '' });

const applyResult = SceneMappingApplyResult.parse({
  checked: 4,
  remapped: [{ mediaFileId: 3, newMediaFileId: 30, path: '/tv/Frieren/Season 02/Frieren - S02E01.mkv', fromEpisodeIds: [101], toEpisodeIds: [113] }],
  unchanged: 2,
  skipped: [{ mediaFileId: 4, path: '/tv/Frieren/extra.mkv', reason: 'did not map' }],
  rescan: { scanned: 4, added: 0, unmapped: 1 },
});

function routes(extra: Record<string, unknown> = {}) {
  return stubApi({
    '/api/v1/series/1': show,
    '/api/v1/episode': [],
    '/api/v1/mediafile': [],
    '/api/v1/tag': [],
    '/api/v1/qualityprofile': [],
    '/api/v1/rootfolder': [],
    '/api/v1/series/1/scenemapping': [feed, manual],
    ...extra,
  });
}

async function openTab() {
  renderAt('/library/series/1');
  fireEvent.click(await screen.findByRole('tab', { name: 'Scene mapping' }));
  return screen.findByRole('table', { name: 'Scene mapping rules' });
}

describe('Scene mapping tab', () => {
  it('lists manual rules first and keeps feed rules read-only', async () => {
    routes();
    const table = await openTab();
    const rows = await within(table).findAllByRole('row');
    expect(rows[1]?.textContent).toContain('S02E01');
    expect(rows[1]?.textContent).toContain('S01E13');
    expect(rows[1]?.textContent).toContain('split cour');
    expect(within(rows[1]!).getByRole('button', { name: 'Edit rule S02E01' })).toBeTruthy();
    expect(rows[2]?.textContent).toContain('“Sousou no Frieren”');
    expect(within(rows[2]!).getByText('Feed')).toBeTruthy();
    expect(within(rows[2]!).getByText('Read-only')).toBeTruthy();
    expect(within(rows[2]!).queryByRole('button')).toBeNull();
  });

  it('validates, then posts a new manual rule as SceneMappingInput', async () => {
    const api = routes({ 'POST /api/v1/series/1/scenemapping': { ...manual, id: 6 } });
    await openTab();
    fireEvent.click(screen.getByRole('button', { name: 'Add rule' }));
    const dialog = await screen.findByRole('dialog', { name: 'Add rule' });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Add rule' }));
    expect(await within(dialog).findByText('Enter the scene season.')).toBeTruthy();
    expect(api.calls.some((c) => c.method === 'POST')).toBe(false);

    fireEvent.change(within(dialog).getByLabelText('Scene season'), { target: { value: '2' } });
    fireEvent.change(within(dialog).getByLabelText('Library absolute'), { target: { value: '29' } });
    fireEvent.change(within(dialog).getByLabelText('Comment'), { target: { value: 'cour 2' } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Add rule' }));
    await waitFor(() => expect(api.calls.some((c) => c.method === 'POST' && c.path === '/api/v1/series/1/scenemapping')).toBe(true));
    const post = api.calls.find((c) => c.method === 'POST');
    expect(post?.body).toEqual({
      kind: 'season',
      sceneSeason: 2,
      sceneEpisode: null,
      sceneAbsolute: null,
      tvdbSeason: null,
      tvdbEpisode: null,
      tvdbAbsolute: 29,
      sceneTitle: null,
      comment: 'cour 2',
    });
    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Add rule' })).toBeNull());
  });

  it('edits a title alias with PUT and switches the form fields by kind', async () => {
    const api = routes({ 'PUT /api/v1/series/1/scenemapping/5': manual });
    const table = await openTab();
    fireEvent.click(within(table).getByRole('button', { name: 'Edit rule S02E01' }));
    const dialog = await screen.findByRole('dialog', { name: 'Edit rule' });
    expect((within(dialog).getByLabelText('Library episode') as HTMLInputElement).value).toBe('13');
    fireEvent.change(within(dialog).getByLabelText('Type'), { target: { value: 'title' } });
    expect(within(dialog).queryByLabelText('Library episode')).toBeNull();
    fireEvent.change(within(dialog).getByLabelText('Scene title'), { target: { value: 'Frieren Beyond' } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Save changes' }));
    await waitFor(() => expect(api.calls.some((c) => c.method === 'PUT')).toBe(true));
    expect(api.calls.find((c) => c.method === 'PUT')?.body).toMatchObject({ kind: 'title', sceneTitle: 'Frieren Beyond', sceneSeason: 2, tvdbSeason: 1, tvdbEpisode: null, sceneEpisode: null });
  });

  it('deletes a manual rule after confirming', async () => {
    const api = routes({ 'DELETE /api/v1/series/1/scenemapping/5': null });
    const table = await openTab();
    fireEvent.click(within(table).getByRole('button', { name: 'Delete rule S02E01' }));
    const confirm = await screen.findByRole('dialog', { name: 'Delete the rule S02E01?' });
    fireEvent.click(within(confirm).getByRole('button', { name: 'Delete rule' }));
    await waitFor(() => expect(api.calls.some((c) => c.method === 'DELETE' && c.path === '/api/v1/series/1/scenemapping/5')).toBe(true));
  });

  it('applies the rules to existing files and shows what changed', async () => {
    const api = routes({ 'POST /api/v1/series/1/scenemapping/apply': applyResult });
    await openTab();
    fireEvent.click(screen.getByRole('button', { name: 'Apply to existing files' }));
    const confirm = await screen.findByRole('dialog', { name: 'Apply the rules to existing files?' });
    fireEvent.click(within(confirm).getByRole('button', { name: 'Apply to files' }));
    const result = await screen.findByRole('dialog', { name: 'Rules applied' });
    expect(api.calls.some((c) => c.method === 'POST' && c.path === '/api/v1/series/1/scenemapping/apply')).toBe(true);
    expect(within(result).getByText('/tv/Frieren/Season 02/Frieren - S02E01.mkv')).toBeTruthy();
    expect(within(result).getByText('Episodes 101 → 113')).toBeTruthy();
    expect(within(result).getByText('did not map')).toBeTruthy();
    expect(within(result).getByText('4 scanned · 0 added · 1 unmapped')).toBeTruthy();
  });
});
