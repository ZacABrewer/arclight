import { afterEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { useState } from 'react';
import { ContentRestrictions, PERMISSION_INFO, Permission, UserPermissions } from '@arclight/shared';
import { stubApi, renderWithClient } from './test-utils.js';
import { PermissionsMatrix, UserPolicyEditor, UserQuotaEditor, capsSummary, groupedPermissions, parseOptionalGb, togglePermission } from './user-editors.js';

afterEach(() => vi.unstubAllGlobals());

function Harness({ initial, onValue }: { initial: number; onValue: (v: number) => void }) {
  const [v, setV] = useState(initial);
  return (
    <PermissionsMatrix
      value={v}
      lockAdmin
      onChange={(next) => {
        setV(next);
        onValue(next);
      }}
    />
  );
}

describe('permissions matrix', () => {
  it('sets and clears single bits', () => {
    expect(togglePermission(0, Permission.REQUEST, true)).toBe(Permission.REQUEST);
    expect(togglePermission(Permission.REQUEST | Permission.VOTE, Permission.REQUEST, false)).toBe(Permission.VOTE);
    expect(togglePermission(Permission.REQUEST, Permission.REQUEST, true)).toBe(Permission.REQUEST);
    expect(groupedPermissions().flatMap(([, items]) => items)).toHaveLength(PERMISSION_INFO.length);
  });

  it('toggles bits from the checkboxes and locks the admin bit', () => {
    const values: number[] = [];
    render(<Harness initial={Permission.REQUEST} onValue={(v) => values.push(v)} />);
    expect((screen.getByLabelText('Request') as HTMLInputElement).checked).toBe(true);
    expect((screen.getByLabelText('Admin') as HTMLInputElement).disabled).toBe(true);
    fireEvent.click(screen.getByLabelText('Request 4K'));
    fireEvent.click(screen.getByLabelText('Request'));
    expect(values).toEqual([Permission.REQUEST | Permission.REQUEST_4K, Permission.REQUEST_4K]);
  });
});

describe('quota editor', () => {
  it('shows effective limits and usage, and saves blank fields as null', async () => {
    const response = {
      overrides: { movieLimit: 5, movieDays: 7, tvLimit: null, tvDays: null },
      effective: { movieLimit: 5, movieDays: 7, tvLimit: 2, tvDays: 30 },
      exempt: false,
      status: {
        movie: { days: 7, limit: 5, used: 5, remaining: 0, restricted: true },
        series: { days: 30, limit: 2, used: 1, remaining: 1, restricted: false },
      },
    };
    const calls = stubApi({ '/api/v1/user/4/quota': response }, (url, method) => (method === 'PUT' && url === '/api/v1/user/4/quota' ? { body: response } : undefined));
    renderWithClient(<UserQuotaEditor userId={4} />);
    const movieLimit = (await screen.findByLabelText('Movie request limit')) as HTMLInputElement;
    expect(movieLimit.value).toBe('5');
    expect(screen.getByTestId('quota-movie').textContent).toContain('5 of 5 per 7 days');
    expect(screen.getByText('limit reached')).toBeTruthy();
    fireEvent.change(movieLimit, { target: { value: '' } });
    fireEvent.change(screen.getByLabelText('Series request limit'), { target: { value: '3' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save quota' }));
    await waitFor(() => expect(calls.some((c) => c.method === 'PUT')).toBe(true));
    expect(calls.find((c) => c.method === 'PUT')?.body).toEqual({ movieLimit: null, movieDays: 7, tvLimit: 3, tvDays: null });
  });
});

describe('content caps and approval override', () => {
  const perms = {
    permissions: Permission.REQUEST,
    contentRestrictions: { maxCertification: { movie: 'PG', tv: null }, hideAdultContent: false },
    approvalPolicy: { autoApprove: 'inherit', autoApproveIfSizeBelowGb: null, budgetExempt: false },
  };

  it('summarises caps and parses optional sizes', () => {
    expect(capsSummary(ContentRestrictions.parse({}))).toBe('No caps');
    expect(capsSummary(ContentRestrictions.parse({ maxCertification: { movie: 'PG-13', tv: 'TV-PG' }, hideAdultContent: true }))).toBe(
      'Movies up to PG-13 · Series up to TV-PG · Adult titles hidden',
    );
    expect(parseOptionalGb('')).toBeNull();
    expect(parseOptionalGb('7.5')).toBe(7.5);
    expect(parseOptionalGb('-1')).toBeNull();
  });

  it('edits caps and the override and PUTs them with the current permissions', async () => {
    const calls = stubApi({ '/api/v1/user/4/permissions': perms }, (url, method, body) => (method === 'PUT' && url === '/api/v1/user/4/permissions' ? { body } : undefined));
    renderWithClient(<UserPolicyEditor userId={4} />);
    const movie = (await screen.findByLabelText('Highest movie rating')) as HTMLSelectElement;
    expect(movie.value).toBe('PG');
    fireEvent.change(screen.getByLabelText('Highest series rating'), { target: { value: 'TV-Y7' } });
    fireEvent.click(screen.getByRole('switch', { name: 'Hide adult titles' }));
    fireEvent.change(screen.getByLabelText('Auto-approval'), { target: { value: 'never' } });
    fireEvent.change(screen.getByLabelText('Size limit override'), { target: { value: '20' } });
    fireEvent.click(screen.getByRole('switch', { name: 'Exempt from budgets' }));
    fireEvent.click(screen.getByRole('button', { name: 'Save caps and approval' }));
    await waitFor(() => expect(calls.some((c) => c.method === 'PUT')).toBe(true));
    const sent = UserPermissions.parse(calls.find((c) => c.method === 'PUT')?.body);
    expect(sent).toEqual({
      permissions: Permission.REQUEST,
      contentRestrictions: { maxCertification: { movie: 'PG', tv: 'TV-Y7' }, hideAdultContent: true },
      approvalPolicy: { autoApprove: 'never', autoApproveIfSizeBelowGb: 20, budgetExempt: true },
    });
  });

  it('shows caps read-only on the profile', async () => {
    stubApi({ '/api/v1/user/4/permissions': { ...perms, approvalPolicy: { autoApprove: 'always', autoApproveIfSizeBelowGb: null, budgetExempt: true } } });
    renderWithClient(<UserPolicyEditor userId={4} readOnly />);
    expect(await screen.findByText('Movies up to PG')).toBeTruthy();
    expect(screen.getByText('Always auto-approve')).toBeTruthy();
    expect(screen.getByText('Exempt')).toBeTruthy();
    expect(screen.queryByRole('button')).toBeNull();
  });
});
