import { afterEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import type { RetentionCandidate, RetentionRule } from '@arclight/shared';
import { renderAt, stubApi } from '../../../test/route-harness.js';
import { applyAfterText, candidateStatus, conditionLabel, defaultCondition, emptyRule, GIB, normaliseRule, parseUserList, scopeLabel, summarize, validateRule } from './retention-model.js';

afterEach(() => vi.unstubAllGlobals());

const NOW = Date.parse('2026-10-26T12:00:00.000Z');

const rule = (over: Partial<RetentionRule> = {}): RetentionRule => ({
  id: 1,
  name: 'Watched movies',
  enabled: true,
  mediaType: 'movie',
  scope: { type: 'all' },
  conditions: [{ type: 'watchedByAll' }, { type: 'addedOlderThanDays', days: 30 }],
  graceDays: 7,
  action: 'deleteFiles',
  addExclusion: false,
  keepIfRequestedWithinDays: null,
  keepIfInCollection: false,
  dryRun: true,
  createdAt: '2026-10-01T00:00:00.000Z',
  updatedAt: '2026-10-01T00:00:00.000Z',
  ...over,
});

const candidate = (over: Partial<RetentionCandidate> = {}): RetentionCandidate => ({
  id: 10,
  ruleId: 1,
  ruleName: 'Watched movies',
  mediaType: 'movie',
  mediaId: 7,
  tmdbId: 949,
  title: 'Heat',
  year: 1995,
  sizeBytes: 20 * GIB,
  action: 'deleteFiles',
  reasons: ['Watched by every user', 'Added 400 days ago'],
  watchedBy: ['alice'],
  status: 'pending',
  dryRun: false,
  firstSeenAt: '2026-10-20T00:00:00.000Z',
  lastSeenAt: '2026-10-26T00:00:00.000Z',
  applyAfter: '2026-10-27T00:00:00.000Z',
  appliedAt: null,
  keptAt: null,
  error: null,
  ...over,
});

describe('retention model', () => {
  it('labels every condition kind in plain words', () => {
    expect(conditionLabel({ type: 'watchedByAll' })).toBe('Watched by every user');
    expect(conditionLabel({ type: 'watchedByAny' })).toBe('Watched by any user');
    expect(conditionLabel({ type: 'watchedByUsers', users: ['alice', 'bob'] })).toBe('Watched by alice, bob');
    expect(conditionLabel({ type: 'addedOlderThanDays', days: 1 })).toBe('Added more than 1 day ago');
    expect(conditionLabel({ type: 'notWatchedWithinDays', days: 90 })).toBe('Not watched in 90 days');
    expect(conditionLabel({ type: 'sizeAbove', bytes: 50 * GIB })).toBe('Larger than 50.0 GB');
  });

  it('creates default conditions with sensible values', () => {
    expect(defaultCondition('watchedByUsers')).toEqual({ type: 'watchedByUsers', users: [] });
    expect(defaultCondition('notWatchedWithinDays')).toEqual({ type: 'notWatchedWithinDays', days: 180 });
    expect(defaultCondition('sizeAbove')).toEqual({ type: 'sizeAbove', bytes: 50 * GIB });
  });

  it('describes the scope with tag names', () => {
    expect(scopeLabel({ type: 'all' })).toBe('Whole library');
    expect(scopeLabel({ type: 'tags', tagIds: [1, 9] }, [{ id: 1, label: 'kids' }])).toBe('Tags: kids, #9');
    expect(scopeLabel({ type: 'rootFolders', paths: ['/movies'] })).toBe('Root folders: /movies');
  });

  it('validates names, conditions and scope', () => {
    expect(validateRule({ ...emptyRule(), name: 'Old' })).toEqual([]);
    expect(validateRule(emptyRule())).toContain('Name the rule.');
    expect(validateRule({ ...emptyRule(), name: 'old' }, ['Old'])[0]).toMatch(/already exists/);
    expect(validateRule({ ...emptyRule(), name: 'x', conditions: [] })).toContain('Add at least one condition.');
    expect(validateRule({ ...emptyRule(), name: 'x', conditions: [{ type: 'watchedByUsers', users: [] }] })[0]).toMatch(/at least one user/);
    expect(validateRule({ ...emptyRule(), name: 'x', scope: { type: 'tags', tagIds: [] } as never })).toContain('Pick at least one tag.');
  });

  it('drops fields the action or media type does not use', () => {
    const out = normaliseRule({ ...emptyRule(), name: '  Old  ', mediaType: 'series', action: 'unmonitor', addExclusion: true, keepIfInCollection: true });
    expect(out).toMatchObject({ name: 'Old', addExclusion: false, keepIfInCollection: false });
    expect(normaliseRule({ ...emptyRule(), action: 'deleteItem', addExclusion: true }).addExclusion).toBe(true);
  });

  it('summarises candidates for the cards', () => {
    const s = summarize(
      [
        candidate(),
        candidate({ id: 11, dryRun: true }),
        candidate({ id: 12, applyAfter: '2026-12-30T00:00:00.000Z' }),
        candidate({ id: 13, status: 'kept' }),
        candidate({ id: 14, status: 'failed', error: 'disk' }),
      ],
      NOW,
    );
    expect(s).toEqual({ pending: 3, kept: 1, failed: 1, dueSoon: 1, pendingBytes: 60 * GIB });
  });

  it('labels candidate status and apply time', () => {
    expect(candidateStatus(candidate({ status: 'failed', error: 'Permission denied' }))).toEqual({ label: 'Failed · Permission denied', tone: 'danger' });
    expect(candidateStatus(candidate({ dryRun: true })).label).toBe('Dry run');
    expect(candidateStatus(candidate()).label).toBe('Waiting');
    expect(applyAfterText(candidate(), NOW)).toBe('in 1d');
    expect(applyAfterText(candidate({ applyAfter: '2026-10-01T00:00:00.000Z' }), NOW)).toBe('Due now');
    expect(applyAfterText(candidate({ status: 'kept' }), NOW)).toBe('Never');
  });

  it('parses a comma-separated user list without duplicates', () => {
    expect(parseUserList(' alice, bob,,alice ')).toEqual(['alice', 'bob']);
  });
});

function retentionRoutes(extra: Record<string, unknown> = {}) {
  return stubApi({
    '/api/v1/retentionrule': [rule()],
    '/api/v1/retention/candidates': [candidate(), candidate({ id: 11, title: 'Alien', year: 1979, status: 'kept' })],
    '/api/v1/tag': [{ id: 1, label: 'kids' }],
    '/api/v1/rootfolder': [{ id: 2, path: '/data/movies', mediaType: 'movie', accessible: true, freeSpaceBytes: 1e12 }],
    ...extra,
  });
}

describe('Library → Retention', () => {
  it('shows summary cards, rules and candidates', async () => {
    retentionRoutes();
    renderAt('/library/retention');
    const rules = await screen.findByRole('region', { name: 'Rules' });
    expect(await within(rules).findByText('Watched movies')).toBeTruthy();
    expect(within(rules).getByText('Added more than 30 days ago')).toBeTruthy();
    const cards = await screen.findByRole('list', { name: 'Retention summary' });
    expect(within(cards).getByRole('listitem', { name: 'waiting' }).textContent).toContain('1');
    const cands = screen.getByRole('region', { name: 'Candidates' });
    expect(within(cands).getByText('Heat')).toBeTruthy();
    expect(within(cands).getAllByText('Watched by every user').length).toBe(2);
  });

  it('filters candidates by status', async () => {
    retentionRoutes();
    renderAt('/library/retention');
    const cands = await screen.findByRole('region', { name: 'Candidates' });
    await within(cands).findByText('Alien');
    fireEvent.click(within(cands).getByRole('button', { name: 'Kept' }));
    await waitFor(() => expect(within(cands).queryByText('Heat')).toBeNull());
    expect(within(cands).getByText('Alien')).toBeTruthy();
  });

  it('keeps a candidate and applies another after a named confirm', async () => {
    const api = retentionRoutes({
      'POST /api/v1/retention/candidate/10/keep': candidate({ status: 'kept' }),
      'POST /api/v1/retention/candidate/10/apply': candidate({ status: 'applied', appliedAt: '2026-10-26T12:00:00.000Z' }),
    });
    renderAt('/library/retention');
    fireEvent.click(await screen.findByRole('button', { name: 'Keep Heat' }));
    await waitFor(() => expect(api.calls.some((c) => c.method === 'POST' && c.path.endsWith('/candidate/10/keep'))).toBe(true));
    fireEvent.click(screen.getByRole('button', { name: 'Apply now Heat' }));
    const dialog = await screen.findByRole('dialog');
    fireEvent.click(within(dialog).getByRole('button', { name: 'Delete files Heat' }));
    await waitFor(() => expect(api.calls.some((c) => c.method === 'POST' && c.path.endsWith('/candidate/10/apply'))).toBe(true));
  });

  it('previews a dry-run sweep with skipped rules and server errors', async () => {
    const api = retentionRoutes({
      'POST /api/v1/retention/sweep': {
        dryRun: true,
        rulesEvaluated: 1,
        rulesSkipped: [{ ruleId: 2, ruleName: 'Stale series', reason: 'Jellyfin unreachable' }],
        serverErrors: [{ server: 'Jellyfin', message: 'timeout' }],
        staged: 0,
        dropped: 0,
        applied: 0,
        failed: 0,
        matches: [{ ruleId: 1, ruleName: 'Watched movies', mediaType: 'movie', mediaId: 7, title: 'Heat', action: 'deleteFiles', reasons: ['Watched'], sizeBytes: GIB }],
      },
    });
    renderAt('/library/retention');
    fireEvent.click(await screen.findByRole('button', { name: 'Sweep now (dry run)' }));
    const dialog = await screen.findByRole('dialog', { name: 'Sweep preview' });
    expect(within(dialog).getByText(/Jellyfin could not be read: timeout/)).toBeTruthy();
    expect(within(dialog).getByText(/Jellyfin unreachable/)).toBeTruthy();
    expect(within(dialog).getByRole('table', { name: 'Sweep matches' }).textContent).toContain('Heat');
    expect(api.calls.find((c) => c.path === '/api/v1/retention/sweep')?.body).toEqual({ dryRun: true });
  });

  it('creates a rule with a conditions builder and validates first', async () => {
    const api = retentionRoutes({
      'POST /api/v1/retentionrule': (init: RequestInit | undefined) => ({ ...rule({ id: 2 }), ...(JSON.parse(String(init?.body)) as object) }),
    });
    renderAt('/library/retention');
    fireEvent.click(await screen.findByRole('button', { name: 'Add rule' }));
    const dialog = await screen.findByRole('dialog', { name: 'Add retention rule' });
    // Saving with no name explains why.
    fireEvent.click(within(dialog).getByRole('button', { name: 'Add rule' }));
    expect(within(dialog).getByRole('alert').textContent).toContain('Name the rule.');

    fireEvent.change(within(dialog).getByLabelText('Name'), { target: { value: 'Big and old' } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Add condition' }));
    fireEvent.change(within(dialog).getByLabelText('Condition 2 kind'), { target: { value: 'sizeAbove' } });
    fireEvent.change(within(dialog).getByLabelText('Condition 2 size'), { target: { value: '40' } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Remove condition 1' }));
    fireEvent.change(within(dialog).getByLabelText('Grace period'), { target: { value: '14' } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Add rule' }));
    await waitFor(() => expect(api.calls.some((c) => c.method === 'POST' && c.path === '/api/v1/retentionrule')).toBe(true));
    expect(api.calls.find((c) => c.method === 'POST' && c.path === '/api/v1/retentionrule')?.body).toMatchObject({
      name: 'Big and old',
      conditions: [{ type: 'sizeAbove', bytes: 40 * GIB }],
      graceDays: 14,
      dryRun: true,
    });
  });

  it('edits and deletes a rule', async () => {
    const api = retentionRoutes({
      'PUT /api/v1/retentionrule/1': (init: RequestInit | undefined) => ({ ...rule(), ...(JSON.parse(String(init?.body)) as object) }),
      'DELETE /api/v1/retentionrule/1': null,
    });
    renderAt('/library/retention');
    fireEvent.click(await screen.findByRole('button', { name: 'Edit Watched movies' }));
    const dialog = await screen.findByRole('dialog', { name: 'Edit Watched movies' });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Unmonitor' }));
    fireEvent.click(within(dialog).getByRole('button', { name: 'Save rule' }));
    await waitFor(() => expect(api.calls.find((c) => c.method === 'PUT')?.body).toMatchObject({ action: 'unmonitor', name: 'Watched movies' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());

    fireEvent.click(screen.getByRole('button', { name: 'Delete Watched movies' }));
    fireEvent.click(within(await screen.findByRole('dialog')).getByRole('button', { name: 'Delete rule' }));
    await waitFor(() => expect(api.calls.some((c) => c.method === 'DELETE' && c.path === '/api/v1/retentionrule/1')).toBe(true));
  });
});
