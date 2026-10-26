import { afterEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { RequestPolicyExplanation } from '@arclight/shared';
import { authRoutes, makeRequest, renderAt, stubApi, user } from './test-utils.js';
import { policyOutcomeTone, policyRuleLabel, policySummary } from './policy-drawer.js';

afterEach(() => vi.unstubAllGlobals());

const page = (results: unknown[]) => ({ pageInfo: { total: results.length, take: 20, skip: 0 }, results });

const policy = RequestPolicyExplanation.parse({
  requestId: 5,
  status: 'pending',
  decision: 'hold',
  held: true,
  estimatedSizeBytes: 4 * 1024 ** 3,
  nextWindowAt: '2026-10-27T22:00:00.000Z',
  steps: [
    { rule: 'permission', outcome: 'skip', message: 'no auto-approve permission' },
    { rule: 'size', outcome: 'pass', message: '4.0 GiB is under 10 GiB' },
    { rule: 'window', outcome: 'fail', message: 'outside every auto-approve window' },
  ],
});

describe('policy helpers', () => {
  it('labels rules, tones outcomes and summarises the decision', () => {
    expect(policyRuleLabel('budget')).toBe('Budgets');
    expect(policyRuleLabel('userOverride')).toBe('User override');
    expect(policyOutcomeTone('pass')).toBe('accent');
    expect(policyOutcomeTone('fail')).toBe('warn');
    expect(policyOutcomeTone('skip')).toBe('muted');
    expect(policySummary(policy, Date.parse('2026-10-26T22:00:00.000Z'))).toContain('Approved automatically when the next window opens');
    expect(policySummary({ ...policy, held: false, decision: 'approve' })).toBe('The policies would approve this request now.');
    expect(policySummary({ ...policy, held: false, decision: 'pending' })).toBe('No policy approves this request. It waits for a manager.');
  });
});

describe('held requests', () => {
  it('shows a Held chip on the admin list and explains it in a drawer', async () => {
    const calls = stubApi({
      '/api/v1/request': page([makeRequest({ id: 5, heldByPolicy: true }), makeRequest({ id: 6, mediaTitle: 'Alien', mediaTmdbId: 348 })]),
      '/api/v1/request/5/policy': policy,
    });
    renderAt('/requests');
    const chip = await screen.findByRole('button', { name: 'Why The Matrix is held' });
    expect(screen.queryByRole('button', { name: 'Why Alien is held' })).toBeNull();
    expect(calls.some((c) => c.url.includes('/policy'))).toBe(false);
    fireEvent.click(chip);
    const drawer = await screen.findByRole('dialog', { name: 'Why The Matrix is held' });
    expect(await within(drawer).findByText('outside every auto-approve window')).toBeTruthy();
    expect(within(drawer).getByText('4.0 GiB')).toBeTruthy();
    const steps = within(drawer).getByRole('list', { name: 'Approval checks' });
    expect(within(steps).getAllByRole('listitem')).toHaveLength(3);
    expect(within(steps).getByText('Not met')).toBeTruthy();
    expect(within(drawer).getByRole('status').textContent).toContain('Held by an approval window');
    await waitFor(() => expect(calls.filter((c) => c.url === '/api/v1/request/5/policy')).toHaveLength(1));
  });

  it('shows the Held chip on my requests and reports a failed explanation', async () => {
    stubApi({ ...authRoutes(user()), '/api/v1/request': page([makeRequest({ id: 9, heldByPolicy: true })]) }, (url) =>
      url === '/api/v1/request/9/policy' ? { status: 500, body: { error: 'boom', code: 'INTERNAL' } } : undefined,
    );
    renderAt('/requests/mine');
    fireEvent.click(await screen.findByRole('button', { name: 'Why The Matrix is held' }));
    const drawer = await screen.findByRole('dialog', { name: 'Why The Matrix is held' });
    expect(await within(drawer).findByText('Could not load the approval policy')).toBeTruthy();
  });

  it('does not show the chip once the request is no longer pending', async () => {
    stubApi({ '/api/v1/request': page([makeRequest({ id: 5, status: 'approved', heldByPolicy: true })]) });
    renderAt('/requests');
    expect(await screen.findAllByRole('link', { name: 'The Matrix' })).toBeTruthy();
    expect(screen.queryByText('Held')).toBeNull();
  });
});
