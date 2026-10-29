import { describe, expect, it, vi } from 'vitest';
import { act, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState } from 'react';
import { Modal, Drawer } from './Modal.js';
import { Button } from './Button.js';
import { ToastStack, ToastViewport, toToastTone, visibleToasts, type ToastStoreLike } from './Toast.js';
import { Tooltip, Popover } from './Tooltip.js';
import { CommandPalette } from './CommandPalette.js';

function ModalHarness({ onClose }: { onClose?: () => void }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button type="button" onClick={() => setOpen(true)}>
        Open
      </button>
      <Modal
        open={open}
        onClose={() => {
          onClose?.();
          setOpen(false);
        }}
        title="Delete Foundation?"
        footer={
          <>
            <Button variant="ghost" onClick={() => setOpen(false)}>
              Cancel
            </Button>
            <Button variant="danger-solid">Delete series</Button>
          </>
        }
      >
        <input aria-label="Confirm name" />
      </Modal>
    </>
  );
}

describe('Modal', () => {
  it('opens as an aria-modal dialog labelled by its title and focuses the first control', async () => {
    render(<ModalHarness />);
    await userEvent.click(screen.getByRole('button', { name: 'Open' }));
    const dialog = screen.getByRole('dialog', { name: 'Delete Foundation?' });
    expect(dialog.getAttribute('aria-modal')).toBe('true');
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Close' }));
  });

  it('traps Tab and Shift+Tab inside the dialog', async () => {
    render(<ModalHarness />);
    await userEvent.click(screen.getByRole('button', { name: 'Open' }));
    const close = screen.getByRole('button', { name: 'Close' });
    const last = screen.getByRole('button', { name: 'Delete series' });
    last.focus();
    await userEvent.tab();
    expect(document.activeElement).toBe(close);
    await userEvent.tab({ shift: true });
    expect(document.activeElement).toBe(last);
    await userEvent.tab({ shift: true });
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Cancel' }));
  });

  it('closes on Escape and returns focus to the opener', async () => {
    const onClose = vi.fn();
    render(<ModalHarness onClose={onClose} />);
    const opener = screen.getByRole('button', { name: 'Open' });
    await userEvent.click(opener);
    await userEvent.keyboard('{Escape}');
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(document.activeElement).toBe(opener);
  });

  it('closes on scrim click', async () => {
    const onClose = vi.fn();
    render(<ModalHarness onClose={onClose} />);
    await userEvent.click(screen.getByRole('button', { name: 'Open' }));
    await userEvent.click(screen.getByTestId('al-scrim'));
    expect(onClose).toHaveBeenCalled();
  });

  it.each([
    [560, 'al-modal--560'],
    [640, 'al-modal--640'],
    [1100, 'al-modal--1100'],
    ['lg', 'al-modal--1100'],
  ] as const)('size %s → %s', (size, cls) => {
    render(
      <Modal open onClose={() => {}} title="T" size={size}>
        body
      </Modal>,
    );
    expect(screen.getByRole('dialog').className).toContain(cls);
  });

  it('confirm size (440) uses the base .al-modal width', () => {
    render(
      <Modal open onClose={() => {}} title="T">
        body
      </Modal>,
    );
    expect(screen.getByRole('dialog').className).toBe('al-modal');
  });
});

describe('Drawer', () => {
  it('closes on Escape', async () => {
    const onClose = vi.fn();
    render(
      <Drawer open onClose={onClose} title="S02E09">
        <button type="button">Mark failed</button>
      </Drawer>,
    );
    expect(screen.getByRole('dialog', { name: 'S02E09' }).className).toContain('al-drawer');
    await userEvent.keyboard('{Escape}');
    expect(onClose).toHaveBeenCalled();
  });
});

describe('Toasts', () => {
  const five = [1, 2, 3, 4, 5].map((i) => ({ id: i, title: `Toast ${i}` }));

  it('shows at most 3, newest kept', () => {
    render(<ToastStack toasts={five} />);
    expect(screen.queryByText('Toast 1')).toBeNull();
    expect(screen.queryByText('Toast 2')).toBeNull();
    expect(screen.getByText('Toast 3')).toBeTruthy();
    expect(screen.getByText('Toast 5')).toBeTruthy();
    expect(document.querySelectorAll('.al-toast')).toHaveLength(3);
    expect(visibleToasts([1, 2, 3, 4])).toEqual([2, 3, 4]);
  });

  it('maps app tones onto Arclight tones and danger toasts are alerts', () => {
    expect(toToastTone('error')).toBe('danger');
    expect(toToastTone('warning')).toBe('warn');
    expect(toToastTone('ok')).toBe('default');
    render(<ToastStack toasts={[{ id: 1, title: 'Import failed', tone: 'error' }]} />);
    const el = screen.getByRole('alert');
    expect(el.getAttribute('data-tone')).toBe('danger');
  });

  it('renders the existing toast store and dismisses through it', async () => {
    let list = [
      { id: 1, tone: 'info', title: 'Settings saved', message: 'Media management' },
      { id: 2, tone: 'warning', title: 'Indexer rate-limited' },
      { id: 3, tone: 'ok', title: 'Imported Silo S02E10' },
      { id: 4, tone: 'error', title: 'Import failed' },
    ];
    const listeners = new Set<() => void>();
    const store: ToastStoreLike = {
      list: () => list,
      dismiss: (id) => {
        list = list.filter((t) => t.id !== id);
        listeners.forEach((l) => l());
      },
      subscribe: (l) => {
        listeners.add(l);
        return () => listeners.delete(l);
      },
    };
    render(<ToastViewport store={store} />);
    expect(document.querySelectorAll('.al-toast')).toHaveLength(3);
    expect(screen.queryByText('Settings saved')).toBeNull();
    await userEvent.click(screen.getAllByRole('button', { name: 'Dismiss' })[0]!);
    expect(screen.getByText('Settings saved')).toBeTruthy();
    expect(screen.queryByText('Indexer rate-limited')).toBeNull();
  });
});

describe('Tooltip / Popover', () => {
  it('shows a tooltip on focus and links it with aria-describedby', async () => {
    render(
      <Tooltip content="Refresh series">
        <button type="button" aria-label="Refresh">
          R
        </button>
      </Tooltip>,
    );
    act(() => screen.getByRole('button').focus());
    const tip = screen.getByRole('tooltip');
    expect(tip.textContent).toBe('Refresh series');
    expect(screen.getByRole('button').getAttribute('aria-describedby')).toBe(tip.id);
  });

  it('renders the tooltip on the body so a clipping container cannot hide it', () => {
    render(
      <div data-testid="clip" style={{ overflow: 'hidden' }}>
        <Tooltip content="2 rejections">
          <button type="button">Rejected</button>
        </Tooltip>
      </div>,
    );
    act(() => screen.getByRole('button').focus());
    const tip = screen.getByRole('tooltip');
    expect(screen.getByTestId('clip').contains(tip)).toBe(false);
    expect(tip.parentElement).toBe(document.body);
  });

  it('popover toggles on click and closes on Escape', async () => {
    render(
      <Popover label="Episode" trigger={(p) => <button type="button" {...p}>Details</button>}>
        <span>Severance S03E02</span>
      </Popover>,
    );
    await userEvent.click(screen.getByRole('button', { name: 'Details' }));
    expect(screen.getByRole('dialog', { name: 'Episode' })).toBeTruthy();
    await userEvent.keyboard('{Escape}');
    expect(screen.queryByRole('dialog')).toBeNull();
  });
});

describe('CommandPalette', () => {
  it('moves with arrows, runs with Enter and closes', async () => {
    const a = vi.fn();
    const b = vi.fn();
    const onClose = vi.fn();
    render(
      <CommandPalette
        open
        onClose={onClose}
        query=""
        onQueryChange={() => {}}
        groups={[{ label: 'Series', items: [{ id: 'a', label: 'Severance', onSelect: a }, { id: 'b', label: 'Silo', onSelect: b }] }]}
      />,
    );
    const input = screen.getByRole('combobox', { name: 'Command' });
    expect(document.activeElement).toBe(input);
    await userEvent.keyboard('{ArrowDown}{Enter}');
    expect(b).toHaveBeenCalled();
    expect(a).not.toHaveBeenCalled();
    expect(onClose).toHaveBeenCalled();
  });
});
