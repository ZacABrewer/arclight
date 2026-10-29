import { afterEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, within } from '@testing-library/react';
import { BulkBar, type BulkAction } from './bulk-bar.js';

afterEach(() => vi.unstubAllGlobals());

function actions(log: string[]): BulkAction[] {
  return [
    { id: 'search', label: 'Search', onSelect: () => log.push('search') },
    { id: 'profile', label: 'Profile', options: [{ id: '1', label: 'HD', onSelect: () => log.push('profile:1') }] },
    { id: 'delete', label: 'Delete', danger: true, onSelect: () => log.push('delete') },
  ];
}

/** Phone width: matchMedia answers true for the mobile query. */
function stubMobile() {
  vi.stubGlobal('matchMedia', (query: string) => ({ matches: query.includes('max-width'), media: query, addEventListener: () => {}, removeEventListener: () => {} }));
}

describe('BulkBar', () => {
  it('stays hidden with nothing selected unless open', () => {
    const { rerender } = render(<BulkBar count={0} actions={actions([])} onClear={() => {}} />);
    expect(screen.queryByRole('toolbar')).toBeNull();
    rerender(<BulkBar count={0} open actions={actions([])} onClear={() => {}} />);
    const bar = screen.getByRole('toolbar', { name: 'Bulk actions' });
    // Nothing selected yet: the actions wait.
    expect((within(bar).getByRole('button', { name: 'Search' }) as HTMLButtonElement).disabled).toBe(true);
  });

  it('offers Select all while fewer rows are selected, and shows the total in all-matching mode', () => {
    const onSelectAll = vi.fn();
    const { rerender } = render(<BulkBar count={2} total={120} onSelectAll={onSelectAll} actions={actions([])} onClear={() => {}} />);
    fireEvent.click(screen.getByRole('button', { name: 'Select all 120' }));
    expect(onSelectAll).toHaveBeenCalled();
    rerender(<BulkBar count={50} total={120} allMatching onSelectAll={onSelectAll} actions={actions([])} onClear={() => {}} />);
    expect(screen.getByText('120 selected')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Select all 120' })).toBeNull();
  });

  it('desktop: plain actions are buttons, pickers open a menu, Cancel clears', () => {
    const log: string[] = [];
    const onClear = vi.fn();
    render(<BulkBar count={3} actions={actions(log)} onClear={onClear} />);
    fireEvent.click(screen.getByRole('button', { name: 'Search' }));
    fireEvent.click(screen.getByRole('button', { name: 'Profile' }));
    fireEvent.click(screen.getByRole('menuitem', { name: 'HD' }));
    fireEvent.click(screen.getByRole('button', { name: 'Delete' }));
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(log).toEqual(['search', 'profile:1', 'delete']);
    expect(onClear).toHaveBeenCalled();
  });

  it('phone width: every action folds into one Actions menu; a picker opens its options', () => {
    stubMobile();
    const log: string[] = [];
    render(<BulkBar count={3} actions={actions(log)} onClear={() => {}} />);
    expect(screen.queryByRole('button', { name: 'Search' })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Actions' }));
    fireEvent.click(screen.getByRole('menuitem', { name: 'Profile ›' }));
    fireEvent.click(screen.getByRole('menuitem', { name: 'HD' }));
    fireEvent.click(screen.getByRole('button', { name: 'Actions' }));
    fireEvent.click(screen.getByRole('menuitem', { name: 'Search' }));
    expect(log).toEqual(['profile:1', 'search']);
  });
});
