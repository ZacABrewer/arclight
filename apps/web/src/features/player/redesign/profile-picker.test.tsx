import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { ProfilePicker, type PickerProfile } from './profile-picker.js';

// The picker's Add tile, the pencil Manage button and edit mode (features spec §1).

const owner: PickerProfile = { id: 1, name: 'Owner', color: '#7c6cf0', initial: 'O', hasPin: false };
const kid: PickerProfile = { id: 2, name: 'Kid', color: '#e0913a', initial: 'K', hasPin: true };

afterEach(cleanup);

function picker(over: Partial<Parameters<typeof ProfilePicker>[0]> = {}) {
  const props = { profiles: [owner, kid], activeId: 1, onSelect: vi.fn(async () => {}), layout: 'wide' as const, ...over };
  return { ...render(<ProfilePicker {...props} />), props };
}

describe('ProfilePicker', () => {
  it('shows the Add tile only with canAdd and below the maximum', () => {
    const onAdd = vi.fn();
    picker({ canAdd: true, max: 12, onAdd });
    fireEvent.click(screen.getByRole('button', { name: 'Add profile' }));
    expect(onAdd).toHaveBeenCalledOnce();
    cleanup();
    picker({ canAdd: true, max: 2, onAdd });
    expect(screen.queryByRole('button', { name: 'Add profile' })).toBeNull();
    cleanup();
    picker({ canAdd: false, max: 12, onAdd });
    expect(screen.queryByRole('button', { name: 'Add profile' })).toBeNull();
  });

  it('the pencil button asks for edit mode; without onManage there is none', () => {
    const onManage = vi.fn();
    picker({ onManage });
    expect(screen.getByRole('heading', { name: 'Who’s watching?' })).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Manage profiles' }));
    expect(onManage).toHaveBeenCalledOnce();
    cleanup();
    picker();
    expect(screen.queryByRole('button', { name: 'Manage profiles' })).toBeNull();
  });

  it('edit mode: the title, Done, and a tile edits instead of switching (no PIN asked)', () => {
    const onEdit = vi.fn();
    const onManage = vi.fn();
    const { props } = picker({ managing: true, onEdit, onManage, canAdd: true, max: 12, onAdd: vi.fn() });
    expect(screen.getByRole('heading', { name: 'Manage profiles' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Done' })).toBeTruthy();
    // The Add tile stays in edit mode.
    expect(screen.getByRole('button', { name: 'Add profile' })).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Edit Kid' }));
    expect(onEdit).toHaveBeenCalledWith(kid);
    expect(props.onSelect).not.toHaveBeenCalled();
    expect(screen.queryByText('Enter the PIN for Kid')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Done' }));
    expect(onManage).toHaveBeenCalledOnce();
  });

  it('Escape in edit mode returns to pick mode', () => {
    const onManage = vi.fn();
    picker({ managing: true, onManage, onEdit: vi.fn() });
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(onManage).toHaveBeenCalledOnce();
    cleanup();
    // Not in pick mode.
    const again = vi.fn();
    picker({ onManage: again });
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(again).not.toHaveBeenCalled();
  });

  it('pick mode selects the profile', () => {
    const { props } = picker({ onManage: vi.fn() });
    fireEvent.click(screen.getByRole('button', { name: 'Owner' }));
    expect(props.onSelect).toHaveBeenCalledWith(owner);
  });

  it('moves focus to the given tile', () => {
    picker({ focusId: 2 });
    expect(document.activeElement?.getAttribute('data-profile-id')).toBe('2');
  });
});
