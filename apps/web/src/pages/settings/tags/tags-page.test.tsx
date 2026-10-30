import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { configure, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { QueryClientProvider } from '@tanstack/react-query';
import { TagRule, TagRuleRunResult, TagUsage } from '@arclight/shared';
import { renderAt, stubApi, type FakeApi } from '../../../test/route-harness.js';
import { createQueryClient } from '../../../query-client.js';
import { AutoTagChips } from '../../../components/media/auto-tag-chips.js';
import { tagFromSearch } from '../../library/library-filters.js';
import { fieldsFor, moveId, templateExample, templateVariablesFor } from './tags-model.js';

configure({ asyncUtilTimeout: 5000 });

const tags = [
  { id: 1, label: 'genre:horror' },
  { id: 2, label: 'anime' },
  { id: 3, label: 'old' },
];

const usage = [
  TagUsage.parse({ id: 1, label: 'genre:horror', counts: { movie: 212 }, total: 212, behaviourUses: 0, autoApplied: 212, rules: [{ id: 7, name: 'Genre tags' }] }),
  TagUsage.parse({ id: 2, label: 'anime', counts: { series: 4, delayProfile: 1, indexer: 2 }, total: 7, behaviourUses: 3, autoApplied: 0, rules: [] }),
  TagUsage.parse({ id: 3, label: 'old', counts: {}, total: 0, behaviourUses: 0, autoApplied: 0, rules: [] }),
];

const rule = TagRule.parse({
  id: 7,
  name: 'Genre tags',
  enabled: true,
  appliesTo: ['movie', 'series'],
  match: 'all',
  conditions: [{ kind: 'set', field: 'genre', op: 'any', values: ['Horror'] }],
  addTags: ['genre:{genre}'],
  removeTagIds: [],
  removeWhenUnmatched: true,
  sortOrder: 0,
  starterKey: 'genre',
  appliedCount: 212,
  lastRun: null,
  createdAt: '2026-10-01T00:00:00.000Z',
  updatedAt: '2026-10-01T00:00:00.000Z',
});
const rule2 = TagRule.parse({ ...rule, id: 8, name: 'Kids', starterKey: null, addTags: ['kids'], sortOrder: 1 });

const runResult = (dryRun: boolean) =>
  TagRuleRunResult.parse({
    dryRun,
    itemsEvaluated: 500,
    itemsMatched: 215,
    itemsChanged: 215,
    matchedByType: { movie: 215 },
    add: [{ label: 'genre:horror', count: 212, isNew: false }],
    remove: [{ label: 'genre:drama', count: 3, isNew: false }],
    samples: [],
    behaviour: [{ label: 'anime', uses: { indexer: 2 } }],
    durationMs: 12,
  });

let api: FakeApi;

beforeEach(() => {
  api = stubApi({
    '/api/v1/tag': tags,
    '/api/v1/tag/usage': usage,
    '/api/v1/tagrule': [rule, rule2],
    '/api/v1/tagrule/options': { values: { genre: ['Horror', 'Drama'] }, users: [{ id: 1, name: 'alex' }], qualityProfiles: [] },
    'DELETE /api/v1/tag/2': null,
    'POST /api/v1/tag/2/merge': tags[0],
    'PUT /api/v1/tagrule/order': [rule2, rule],
    'POST /api/v1/tagrule/run': (init: RequestInit | undefined) => runResult((JSON.parse(String(init?.body)) as { dryRun: boolean }).dryRun),
    'POST /api/v1/tagrule/preview': runResult(true),
  });
});
afterEach(() => vi.unstubAllGlobals());

describe('Settings -> Tags model', () => {
  it('offers only fields and variables the selected item types have', () => {
    expect(fieldsFor(['artist'])).toContain('albumType');
    expect(fieldsFor(['artist'])).not.toContain('resolution');
    expect(fieldsFor(['movie'])).toContain('collection');
    expect(fieldsFor(['movie'])).not.toContain('network');
    expect(templateVariablesFor(['author'])).toContain('narrator');
    expect(templateVariablesFor(['author'])).not.toContain('decade');
  });

  it('shows a sanitised example of a template', () => {
    expect(templateExample('genre:{genre}')).toBe('genre:science-fiction');
    expect(templateExample('Decade {decade}')).toBe('decade-1990s');
  });

  it('moves rule ids and reads ?tag=', () => {
    expect(moveId([1, 2, 3], 1, -1)).toEqual([2, 1, 3]);
    expect(moveId([1, 2, 3], 0, -1)).toBeNull();
    expect(tagFromSearch({ tag: 5 })).toBe(5);
    expect(tagFromSearch({ tag: '7' })).toBe(7);
    expect(tagFromSearch({ tag: 'x' })).toBeNull();
    expect(tagFromSearch({})).toBeNull();
  });
});

describe('Settings -> Tags page', () => {
  it('lists tags with usage, behaviour marker, creating rule and a filtered library link', async () => {
    renderAt('/settings/tags');
    const table = await screen.findByRole('table', { name: 'Tags' });
    const horror = (await within(table).findByText('genre:horror')).closest('tr')!;
    expect(within(horror).getByText('Genre tags')).toBeTruthy();
    expect(within(horror).getByRole('link', { name: 'Show movies' }).getAttribute('href')).toBe('/library/movies?tag=1');
    const anime = within(table).getByText('anime').closest('tr')!;
    expect(within(anime).getByText('Drives behaviour')).toBeTruthy();
    expect(within(anime).getByText('Added by hand')).toBeTruthy();
    expect(within(table).getByText('old').closest('tr')!.textContent).toContain('Unused');
    expect(screen.getByRole('button', { name: 'Delete unused (1)' })).toBeTruthy();
  });

  it('warns before deleting a tag in use and lists where it is used', async () => {
    renderAt('/settings/tags');
    fireEvent.click(await screen.findByRole('button', { name: 'Delete anime' }));
    const dialog = await screen.findByRole('dialog', { name: 'Delete anime?' });
    expect(within(dialog).getByText(/This tag is in use/)).toBeTruthy();
    const list = within(dialog).getByRole('list', { name: 'Used by' });
    expect(list.textContent).toContain('2 × indexers (Drives behaviour)');
    expect(list.textContent).toContain('4 × series');
    fireEvent.click(within(dialog).getByRole('button', { name: 'Delete tag' }));
    await waitFor(() => expect(api.calls.some((c) => c.method === 'DELETE' && c.path === '/api/v1/tag/2')).toBe(true));
  });

  it('merges a tag into another', async () => {
    renderAt('/settings/tags');
    fireEvent.click(await screen.findByRole('button', { name: 'Merge anime' }));
    const dialog = await screen.findByRole('dialog', { name: 'Merge anime' });
    fireEvent.change(within(dialog).getByLabelText('Merge into'), { target: { value: '1' } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Merge' }));
    await waitFor(() => expect(api.calls.find((c) => c.method === 'POST' && c.path === '/api/v1/tag/2/merge')?.body).toEqual({ intoId: 1 }));
  });

  it('shows a dry run before Run now, with the behaviour warning, then runs for real', async () => {
    renderAt('/settings/tags');
    fireEvent.click(await screen.findByRole('button', { name: 'Run Genre tags now' }));
    const dialog = await screen.findByRole('dialog', { name: 'Run Genre tags' });
    expect(await within(dialog).findByText('Add genre:horror to 212 items')).toBeTruthy();
    expect(within(dialog).getByText('Remove genre:drama from 3 items')).toBeTruthy();
    expect(within(dialog).getByRole('list', { name: /These tags are used by settings/ }).textContent).toContain('2 × indexers');
    expect(api.calls.find((c) => c.path === '/api/v1/tagrule/run')?.body).toEqual({ ruleIds: [7], dryRun: true });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Apply changes' }));
    await waitFor(() => expect(api.calls.filter((c) => c.path === '/api/v1/tagrule/run').at(-1)?.body).toEqual({ ruleIds: [7], dryRun: false }));
  });

  it('reorders rules', async () => {
    renderAt('/settings/tags');
    fireEvent.click(await screen.findByRole('button', { name: 'Move Kids up' }));
    await waitFor(() => expect(api.calls.find((c) => c.method === 'PUT' && c.path === '/api/v1/tagrule/order')?.body).toEqual({ ids: [8, 7] }));
  });

  it('rule editor: fields follow the item types, the template helper inserts variables, and the draft is previewed', async () => {
    renderAt('/settings/tags');
    fireEvent.click((await screen.findAllByRole('button', { name: 'Add rule' }))[0]!);
    const dialog = await screen.findByRole('dialog', { name: 'Add tag rule' });
    fireEvent.change(within(dialog).getByLabelText('Name'), { target: { value: 'Album types' } });
    fireEvent.click(within(dialog).getByLabelText('Movies'));
    fireEvent.click(within(dialog).getByLabelText('Series'));
    fireEvent.click(within(dialog).getByLabelText('Artists'));
    fireEvent.click(within(dialog).getByRole('button', { name: 'Add condition' }));
    const fieldSelect = within(dialog).getByLabelText('Condition 1 field') as HTMLSelectElement;
    const values = [...fieldSelect.options].map((o) => o.value);
    expect(values).toContain('albumType');
    expect(values).not.toContain('resolution');
    fireEvent.change(fieldSelect, { target: { value: 'monitored' } });

    const helper = within(dialog).getByRole('group', { name: 'Template variables' });
    expect(within(helper).queryByRole('button', { name: '{decade}' })).toBeNull();
    fireEvent.change(within(dialog).getByLabelText('Tag 1'), { target: { value: 'type:' } });
    fireEvent.click(within(helper).getByRole('button', { name: '{albumtype}' }));
    expect((within(dialog).getByLabelText('Tag 1') as HTMLInputElement).value).toBe('type:{albumtype}');
    expect(within(dialog).getByText('Example: type:album')).toBeTruthy();

    await waitFor(() => expect(api.calls.some((c) => c.path === '/api/v1/tagrule/preview')).toBe(true));
    const preview = api.calls.filter((c) => c.path === '/api/v1/tagrule/preview').at(-1)!.body as { rule: Record<string, unknown> };
    expect(preview.rule).toMatchObject({ name: 'Album types', appliesTo: ['artist'], addTags: ['type:{albumtype}'], conditions: [{ kind: 'bool', field: 'monitored', value: true }] });
    expect(await within(dialog).findByText('Add genre:horror to 212 items')).toBeTruthy();
  });
});

describe('Auto-applied tag marker', () => {
  it('marks tags a rule added and names the rule in a tooltip', async () => {
    stubApi({ '/api/v1/tagrule/applied': [{ tagId: 1, ruleId: 7, ruleName: 'Genre tags' }] });
    render(
      <QueryClientProvider client={createQueryClient()}>
        <AutoTagChips entityType="movie" entityId={3} ids={[1, 2]} tags={tags} />
      </QueryClientProvider>,
    );
    const auto = await screen.findByLabelText('genre:horror, Added by rule: Genre tags');
    expect(auto.querySelector('.mk-tag-auto')).toBeTruthy();
    expect(screen.getByText('anime').querySelector('.mk-tag-auto')).toBeNull();
    fireEvent.focus(auto);
    expect(await screen.findByRole('tooltip')).toBeTruthy();
    expect(document.body.textContent).toContain('Added by rule: Genre tags');
  });

  it('shows plain tags when ownership cannot be read', async () => {
    stubApi({});
    render(
      <QueryClientProvider client={createQueryClient()}>
        <AutoTagChips entityType="series" entityId={3} ids={[2]} tags={tags} />
      </QueryClientProvider>,
    );
    expect(await screen.findByText('anime')).toBeTruthy();
    expect(document.querySelector('.mk-tag-auto')).toBeNull();
  });
});
