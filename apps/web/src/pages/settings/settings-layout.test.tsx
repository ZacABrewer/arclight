import { describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, renderHook, screen } from '@testing-library/react';
import { RouterProvider, createMemoryHistory, createRootRoute, createRoute, createRouter } from '@tanstack/react-router';
import { useState, type ReactNode } from 'react';
import { SETTINGS_NAV_ITEMS, SaveBar, SettingsPage, countChanges, useDraft } from './settings-layout.js';

function renderInRouter(path: string, ui: () => ReactNode) {
  const root = createRootRoute();
  const routes = ['/settings/mediamanagement', '/settings/indexers', '/indexers'].map((p) => createRoute({ getParentRoute: () => root, path: p, component: ui }));
  const router = createRouter({ routeTree: root.addChildren(routes), history: createMemoryHistory({ initialEntries: [path] }) });
  render(<RouterProvider router={router} />);
  return router;
}

describe('countChanges', () => {
  it('counts changed leaves, treating arrays as one value', () => {
    expect(countChanges({ a: 1, b: { c: 2, d: 3 } }, { a: 1, b: { c: 2, d: 3 } })).toBe(0);
    expect(countChanges({ a: 1, b: { c: 2, d: 3 } }, { a: 2, b: { c: 5, d: 3 } })).toBe(2);
    expect(countChanges({ list: [1, 2] }, { list: [2, 1] })).toBe(1);
    expect(countChanges({ a: undefined }, {})).toBe(0);
    expect(countChanges({ a: null }, { a: { x: 1, y: 2 } })).toBe(2);
  });
});

describe('useDraft', () => {
  it('tracks edits, discards them and resets when the saved value changes', () => {
    const { result, rerender } = renderHook(({ saved }) => useDraft(saved), { initialProps: { saved: { rename: false, format: 'A' } } });
    expect(result.current.changes).toBe(0);
    act(() => result.current.set((d) => ({ ...d, rename: true })));
    expect(result.current.changes).toBe(1);
    act(() => result.current.set((d) => ({ ...d, format: 'B' })));
    expect(result.current.changes).toBe(2);
    act(() => result.current.discard());
    expect(result.current.dirty).toBe(false);
    act(() => result.current.set((d) => ({ ...d, format: 'C' })));
    rerender({ saved: { rename: false, format: 'C' } });
    expect(result.current.changes).toBe(0);
  });
});

describe('SaveBar', () => {
  it('is hidden with no changes', () => {
    const { container } = render(<SaveBar count={0} onSave={() => {}} onDiscard={() => {}} />);
    expect(container.innerHTML).toBe('');
  });

  it('shows the count with ghost Discard and primary Save changes', () => {
    const onSave = vi.fn();
    const onDiscard = vi.fn();
    render(<SaveBar count={2} onSave={onSave} onDiscard={onDiscard} />);
    const bar = screen.getByRole('region', { name: 'Unsaved changes' });
    expect(bar.textContent).toContain('2 unsaved changes');
    const discard = screen.getByRole('button', { name: 'Discard' });
    const save = screen.getByRole('button', { name: 'Save changes' });
    expect(discard.className).toContain('al-btn--ghost');
    expect(save.className).toContain('al-btn--primary');
    fireEvent.click(save);
    fireEvent.click(discard);
    expect(onSave).toHaveBeenCalledOnce();
    expect(onDiscard).toHaveBeenCalledOnce();
  });

  it('uses the singular for one change and can block Save', () => {
    render(<SaveBar count={1} disabled onSave={() => {}} onDiscard={() => {}} />);
    expect(screen.getByRole('region', { name: 'Unsaved changes' }).textContent).toContain('1 unsaved change');
    expect((screen.getByRole('button', { name: 'Save changes' }) as HTMLButtonElement).disabled).toBe(true);
  });
});

function DemoPage() {
  const draft = useDraft({ rename: false });
  const [adv, setAdv] = useState(false);
  return (
    <SettingsPage
      title="Media management"
      advanced={{ value: adv, onChange: setAdv }}
      standalone={{ index: '08', title: 'Indexers' }}
      save={{ count: draft.changes, onSave: () => {}, onDiscard: draft.discard }}
    >
      <button type="button" onClick={() => draft.set({ rename: !draft.value.rename })}>
        flip
      </button>
      <span>{adv ? 'advanced on' : 'advanced off'}</span>
    </SettingsPage>
  );
}

describe('SettingsPage', () => {
  it('renders the grouped sub-nav with the active item marked', async () => {
    renderInRouter('/settings/mediamanagement', DemoPage);
    const nav = await screen.findByRole('navigation', { name: 'Settings sections' });
    expect(nav.querySelectorAll('.al-settings-nav__item').length).toBe(SETTINGS_NAV_ITEMS.length);
    expect(nav.querySelectorAll('.al-label').length).toBe(5);
    const active = nav.querySelector('[aria-current="page"]');
    expect(active?.textContent).toBe('Media management');
  });

  it('shows the advanced toggle top right and the save bar only when dirty', async () => {
    renderInRouter('/settings/mediamanagement', DemoPage);
    expect(await screen.findByRole('heading', { name: 'Media management' })).toBeTruthy();
    expect(screen.queryByRole('region', { name: 'Unsaved changes' })).toBeNull();
    fireEvent.click(screen.getByRole('switch', { name: 'Show advanced' }));
    expect(screen.getByText('advanced on')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'flip' }));
    expect(screen.getByRole('region', { name: 'Unsaved changes' }).textContent).toContain('1 unsaved change');
    fireEvent.click(screen.getByRole('button', { name: 'Discard' }));
    expect(screen.queryByRole('region', { name: 'Unsaved changes' })).toBeNull();
  });

  it('drops the sub-nav and uses a page header outside /settings', async () => {
    renderInRouter('/indexers', DemoPage);
    expect(await screen.findByRole('heading', { level: 1, name: 'Indexers' })).toBeTruthy();
    expect(screen.queryByRole('navigation', { name: 'Settings sections' })).toBeNull();
  });
});
