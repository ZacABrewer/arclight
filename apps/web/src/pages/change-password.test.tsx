import { afterEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { PASSWORD_MIN_LENGTH } from '@arclight/shared';
import { authRoutes, renderAt, stubApi, user } from '../features/requests/test-utils.js';
import { passwordErrors } from './change-password.js';

afterEach(() => vi.unstubAllGlobals());

async function openDialog() {
  fireEvent.click(await screen.findByRole('button', { name: 'Change password' }));
  return screen.findByRole('dialog', { name: 'Change password' });
}

function fill(dialog: HTMLElement, current: string, next: string, confirm: string) {
  fireEvent.change(within(dialog).getByLabelText('Current password'), { target: { value: current } });
  fireEvent.change(within(dialog).getByLabelText('New password'), { target: { value: next } });
  fireEvent.change(within(dialog).getByLabelText('Confirm new password'), { target: { value: confirm } });
}

describe('change password', () => {
  it('validates length, match and the current password', () => {
    expect(passwordErrors({ currentPassword: '', newPassword: 'short', confirmPassword: 'other' })).toEqual({
      currentPassword: 'Enter your current password.',
      newPassword: `Use at least ${PASSWORD_MIN_LENGTH} characters.`,
      confirmPassword: 'The passwords do not match.',
    });
    expect(passwordErrors({ currentPassword: 'old', newPassword: 'x'.repeat(PASSWORD_MIN_LENGTH), confirmPassword: 'x'.repeat(PASSWORD_MIN_LENGTH) })).toEqual({});
  });

  it('blocks a short or mismatched password without calling the api', async () => {
    const calls = stubApi(authRoutes(user()));
    renderAt('/profile');
    const dialog = await openDialog();
    fill(dialog, 'old-password', 'short', 'shorter');
    fireEvent.click(within(dialog).getByRole('button', { name: 'Change password' }));
    expect(await within(dialog).findByText(`Use at least ${PASSWORD_MIN_LENGTH} characters.`)).toBeTruthy();
    expect(within(dialog).getByText('The passwords do not match.')).toBeTruthy();
    expect(calls.some((c) => c.url === '/api/v1/user/me/password')).toBe(false);
  });

  it('puts the new password and toasts on success', async () => {
    const calls = stubApi(authRoutes(user()), (url, method) => (method === 'PUT' && url === '/api/v1/user/me/password' ? { status: 204 } : undefined));
    const { toasts } = renderAt('/profile');
    const dialog = await openDialog();
    fill(dialog, 'old-password', 'new-password-1', 'new-password-1');
    fireEvent.click(within(dialog).getByRole('button', { name: 'Change password' }));
    await waitFor(() =>
      expect(calls.find((c) => c.url === '/api/v1/user/me/password')).toEqual({
        url: '/api/v1/user/me/password',
        method: 'PUT',
        body: { currentPassword: 'old-password', newPassword: 'new-password-1' },
      }),
    );
    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Change password' })).toBeNull());
    expect(toasts.list().some((t) => t.title === 'Password changed')).toBe(true);
  });

  it('shows the server message when the current password is wrong', async () => {
    stubApi(authRoutes(user()), (url, method) =>
      method === 'PUT' && url === '/api/v1/user/me/password' ? { status: 401, body: { error: 'current password is incorrect', code: 'INVALID_CREDENTIALS' } } : undefined,
    );
    renderAt('/profile');
    const dialog = await openDialog();
    fill(dialog, 'wrong', 'new-password-1', 'new-password-1');
    fireEvent.click(within(dialog).getByRole('button', { name: 'Change password' }));
    expect(await within(dialog).findByText('Current password is incorrect')).toBeTruthy();
    expect(screen.getByRole('dialog', { name: 'Change password' })).toBeTruthy();
  });
});
