import { afterEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { useState } from 'react';
import { PERMISSION_INFO, Permission } from '@media-tron/shared';
import { stubApi, renderWithClient } from './test-utils.js';
import { PermissionsMatrix, UserQuotaEditor, groupedPermissions, togglePermission } from './user-editors.js';

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
