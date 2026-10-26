import { afterEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { RequestsSettings } from '@arclight/shared';
import { defaultSettings, renderAt, stubApi } from '../../../features/requests/test-utils.js';
import { budgetLimits, budgetScopeLabel, fromBudgetDraft, newWindow, policyErrors, toBudgetDraft, toggleDay, windowSummary } from './approval-policies.js';

afterEach(() => vi.unstubAllGlobals());

const baseRoutes = { '/api/v1/discoverslider': [], '/api/v1/overriderule': [], '/api/v1/rootfolder': [], '/api/v1/qualityprofile': [], '/api/v1/tag': [] };
const users = [
  { id: 2, username: 'amy', role: 'user', permissions: 32, createdAt: '2026-01-01T00:00:00.000Z', settings: {} },
  { id: 3, username: 'bob', displayName: 'Bob', role: 'user', permissions: 32, createdAt: '2026-01-01T00:00:00.000Z', settings: {} },
];

describe('approval policy helpers', () => {
  it('summarises windows and toggles days in order', () => {
    expect(toggleDay([1, 5], 3)).toEqual([1, 3, 5]);
    expect(toggleDay([1, 3, 5], 3)).toEqual([1, 5]);
    expect(windowSummary({ days: [1, 2], startHour: 22, endHour: 6, action: 'autoApprove' }, '24h')).toBe('Mon, Tue · 22:00–06:00 next day · Auto-approve');
    expect(windowSummary({ days: [0, 1, 2, 3, 4, 5, 6], startHour: 9, endHour: 17, action: 'hold' }, '24h')).toBe('Every day · 09:00–17:00 · Hold');
    expect(policyErrors({ approvalWindows: [newWindow()] })).toEqual([]);
    expect(policyErrors({ approvalWindows: [{ ...newWindow(), days: [] }] })).toEqual(['Pick at least one day.']);
  });

  it('round-trips budgets through the editor draft and validates it', () => {
    const budget = { scope: 'user' as const, userIds: [3], movieGb: 200, tvSeasons: 10, periodDays: 30, autoApproveUnder: { sizeGb: 25 } };
    const res = fromBudgetDraft(toBudgetDraft(budget));
    expect(res).toEqual({ budget });
    expect(fromBudgetDraft({ ...toBudgetDraft(null), movieGb: '', tvSeasons: '' })).toEqual({ error: 'Set a movie size or a season limit.' });
    expect(fromBudgetDraft({ ...toBudgetDraft(null), movieGb: '50', periodDays: '400' })).toEqual({ error: 'The period is 1 to 365 days.' });
    const role = fromBudgetDraft({ ...toBudgetDraft(null), scope: 'role', role: 'user', userIds: [2], tvSeasons: '4' });
    expect(role).toEqual({ budget: { scope: 'role', role: 'user', tvSeasons: 4, periodDays: 30, autoApproveUnder: {} } });
    expect(budgetScopeLabel(budget, users)).toBe('Bob');
    expect(budgetScopeLabel({ ...budget, userIds: [] })).toBe('Each user');
    expect(budgetScopeLabel({ ...budget, scope: 'all' })).toBe('Everyone (shared)');
    expect(budgetLimits(budget)).toBe('200 GB of movies · 10 seasons');
  });
});

describe('settings → requests: approval policies and portal', () => {
  it('edits size limit, budgets, windows and the portal and saves them in one PUT', async () => {
    const settings = defaultSettings({ approvalBudgets: [{ scope: 'all', movieGb: 500, periodDays: 7, autoApproveUnder: {} }] });
    const calls = stubApi({ ...baseRoutes, '/api/v1/settings/requests': settings, '/api/v1/user': users }, (url, method, body) =>
      method === 'PUT' && url === '/api/v1/settings/requests' ? { body } : undefined,
    );
    renderAt('/settings/requests');

    fireEvent.change(await screen.findByLabelText('Auto-approve under'), { target: { value: '12.5' } });

    const budgets = screen.getByRole('region', { name: 'Approval budgets' });
    expect(within(budgets).getByText('500 GB of movies')).toBeTruthy();
    expect(within(budgets).getByText('Everyone (shared)')).toBeTruthy();
    fireEvent.click(within(budgets).getByRole('button', { name: 'Add budget' }));
    const dialog = await screen.findByRole('dialog', { name: 'Add budget' });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Keep budget' }));
    expect(within(dialog).getByRole('alert').textContent).toBe('Set a movie size or a season limit.');
    fireEvent.click(await within(dialog).findByRole('button', { name: 'Bob' }));
    fireEvent.change(within(dialog).getByLabelText('Seasons'), { target: { value: '6' } });
    fireEvent.change(within(dialog).getByLabelText('Period'), { target: { value: '14' } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Keep budget' }));
    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Add budget' })).toBeNull());
    expect(within(budgets).getByText('6 seasons')).toBeTruthy();

    const windows = screen.getByRole('region', { name: 'Approval windows' });
    fireEvent.click(within(windows).getByRole('button', { name: 'Add window' }));
    const row = within(windows).getByRole('listitem', { name: 'Window 1' });
    fireEvent.click(within(row).getByRole('button', { name: 'Sat', pressed: false }));
    fireEvent.change(within(row).getByLabelText('Action'), { target: { value: 'hold' } });

    const portal = screen.getByRole('region', { name: 'Public request portal' });
    const anon = within(portal).getByRole('switch', { name: 'Anonymous browsing' }) as HTMLInputElement;
    expect(anon.disabled).toBe(true);
    fireEvent.click(within(portal).getByRole('switch', { name: 'Public portal' }));
    fireEvent.click(anon);
    fireEvent.change(within(portal).getByLabelText('Portal message'), { target: { value: 'Ask for anything.' } });
    // Portal paths: app paths are refused, others are normalised.
    const addPath = within(portal).getByLabelText('Add portal path');
    fireEvent.change(addPath, { target: { value: '/settings' } });
    fireEvent.click(within(portal).getAllByRole('button', { name: 'Add' })[0]!);
    expect(within(portal).getByRole('alert').textContent).toBe('Arclight uses that path itself. Pick another.');
    fireEvent.change(addPath, { target: { value: 'Watch/' } });
    fireEvent.keyDown(addPath, { key: 'Enter' });
    expect(within(portal).getByText('/watch')).toBeTruthy();
    // Portal hostnames: a pasted URL keeps its hostname; portal-only can be turned off.
    const addHost = within(portal).getByLabelText('Add portal hostname');
    fireEvent.change(addHost, { target: { value: 'https://Requests.Example.com/path' } });
    fireEvent.keyDown(addHost, { key: 'Enter' });
    fireEvent.click(within(portal).getByRole('switch', { name: 'Portal only on requests.example.com' }));

    fireEvent.click(screen.getByRole('button', { name: 'Save changes' }));
    await waitFor(() => expect(calls.some((c) => c.method === 'PUT')).toBe(true));
    const sent = RequestsSettings.parse(calls.find((c) => c.method === 'PUT')?.body);
    expect(sent.autoApproveIfSizeBelowGb).toBe(12.5);
    expect(sent.approvalBudgets).toEqual([
      { scope: 'all', movieGb: 500, periodDays: 7, autoApproveUnder: {} },
      { scope: 'user', userIds: [3], tvSeasons: 6, periodDays: 14, autoApproveUnder: {} },
    ]);
    expect(sent.approvalWindows).toEqual([{ days: [1, 2, 3, 4, 5, 6], startHour: 22, endHour: 6, action: 'hold' }]);
    expect(sent.publicPortal).toEqual({
      enabled: true,
      allowAnonymousDiscover: true,
      message: 'Ask for anything.',
      paths: ['/watch'],
      hosts: [{ hostname: 'requests.example.com', portalOnly: false }],
    });
  });

  it('blocks saving while a window has no days, and removes budgets and windows', async () => {
    const settings = defaultSettings({
      approvalBudgets: [{ scope: 'user', tvSeasons: 2, periodDays: 30, autoApproveUnder: {} }],
      approvalWindows: [{ days: [6], startHour: 9, endHour: 12, action: 'autoApprove' }],
    });
    stubApi({ ...baseRoutes, '/api/v1/settings/requests': settings });
    renderAt('/settings/requests');
    const windows = await screen.findByRole('region', { name: 'Approval windows' });
    const row = within(windows).getByRole('listitem', { name: 'Window 1' });
    fireEvent.click(within(row).getByRole('button', { name: 'Sat', pressed: true }));
    expect(within(row).getByText('Pick at least one day.')).toBeTruthy();
    expect((screen.getByRole('button', { name: 'Save changes' }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(within(row).getByRole('button', { name: 'Remove window 1' }));
    expect(within(windows).queryByRole('listitem')).toBeNull();
    const budgets = screen.getByRole('region', { name: 'Approval budgets' });
    fireEvent.click(within(budgets).getByRole('button', { name: 'Remove budget 1' }));
    expect(within(budgets).getByText('No budgets')).toBeTruthy();
    expect((screen.getByRole('button', { name: 'Save changes' }) as HTMLButtonElement).disabled).toBe(false);
  });
});
