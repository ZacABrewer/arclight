import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { ApiError } from '../../../api/client.js';
import { ProfilePicker, type PickerProfile } from './profile-picker.js';

// The picker's way back to an owner profile without a PIN: the server answers password-required,
// the picker asks for the account password and sends it with the switch.

const OWNER: PickerProfile = { id: 1, name: 'Owner', color: '#3b82f6', initial: 'O', hasPin: false, isOwner: true };
const KIDS: PickerProfile = { id: 2, name: 'Kids', color: '#22c55e', initial: 'K', hasPin: false };

describe('ProfilePicker and the account password', () => {
  it('asks for the password after password-required and retries with it; a wrong one says so', async () => {
    const user = userEvent.setup();
    const onSelect = vi.fn(async (_p: PickerProfile, _pin?: string, password?: string) => {
      if (password === undefined) throw new ApiError(401, 'password-required', '/households/profiles/1/select');
      if (password !== 'right') throw new ApiError(401, 'password-wrong', '/households/profiles/1/select');
    });
    render(<ProfilePicker layout="wide" profiles={[OWNER, KIDS]} activeId={KIDS.id} onSelect={onSelect} />);
    await user.click(screen.getByRole('button', { name: /Owner/ }));
    const field = await screen.findByLabelText('Enter the account password to switch to Owner');
    await user.type(field, 'nope');
    await user.click(screen.getByRole('button', { name: 'Continue' }));
    expect((await screen.findByRole('alert')).textContent).toBe('Wrong password. Try again.');
    await user.type(screen.getByLabelText('Enter the account password to switch to Owner'), 'right');
    await user.click(screen.getByRole('button', { name: 'Continue' }));
    expect(onSelect).toHaveBeenLastCalledWith(OWNER, undefined, 'right');
  });

  it('an account that must sign in again gets the message on the picker', async () => {
    const user = userEvent.setup();
    const onSelect = vi.fn(async () => {
      throw new ApiError(403, 'reauth-required', '/households/profiles/1/select');
    });
    render(<ProfilePicker layout="wide" profiles={[OWNER, KIDS]} activeId={KIDS.id} onSelect={onSelect} />);
    await user.click(screen.getByRole('button', { name: /Owner/ }));
    expect((await screen.findByRole('alert')).textContent).toBe('To switch to Owner, sign out and sign in again.');
  });
});
